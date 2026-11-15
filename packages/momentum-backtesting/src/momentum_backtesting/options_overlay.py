"""BL-227: hold a Momentum strategy's weekly picks as bought stock options, on NSE's daily F&O
bhavcopy (`lake/eod/fo_bhavcopy`, `lake/eod/fno_universe`, written by `obt nse ...`, BL-226).

The research books of BL-226 (calls on a favourite's F&O picks) and BL-228 (puts on the weakest
down-trending F&O stocks; the mirror pool of every stock's chart and its inverse) as one engine
with settings, for the dashboard's Options overlay page. Descriptive, not a finding: both items
killed their registered forms, and a run here is a look, not a test.

The rules (BL-226 Phase 0, BL-228 Phase 0 / 0b):
- each Momentum week's rebalance day is its last F&O session; the book buys on that day's close and
  sells on the next rebalance day's close (the settle price when the contract did not trade);
- the expiry is the nearest with at least `min_sessions_left` sessions after the entry day; ATM is
  the listed strike nearest the unadjusted cash close, OTMk k listed strikes further out (higher for
  a call, lower for a put); a strike with open interest under `min_oi_lots` lots is skipped;
- a contract re-struck by a corporate action between entry and exit is followed: the exit day's row
  of the same expiry and right whose strike x lot matches the entry's within 1 % (a split or bonus
  keeps it); booked at zero only when no such row exists (both counted);
- costs: Rs 20 an order, STT on the sell premium, NSE transaction charges, SEBI, stamp duty, GST;
  slippage a share of premium each way; tax: each financial year's net at 30 % + 4 % cess, a loss
  carried forward (or off).

Calls come from the strategy's weekly holdings (the caller re-runs it on the F&O universe). Puts
come from `weak_list` (the N weakest by rank-sum whose own trend is down), the mirror pool from
`mirror_list`; both read the previous week's close, as the holdings do (`signal_delay=1`).
"""

from __future__ import annotations

import math
import threading
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Literal

import numpy as np
import pandas as pd

Direction = Literal["calls", "puts", "mirror", "switch", "both"]
Sizing = Literal["one_lot", "premium", "capital_share"]
MarketFilter = Literal["nifty_200dma", "nifty_26w", "breadth"]

MONEYNESS = {"ATM": 0, "OTM1": 1, "OTM2": 2, "OTM3": 3}
DEFAULT_SLIPPAGE = {"ATM": 0.01, "OTM1": 0.02, "OTM2": 0.03, "OTM3": 0.04}
HORIZONS = (1, 4, 13, 26, 52)
TREND_WEEKS, AVERAGE_WEEKS, NIFTY_AVERAGE = 26, 40, 200
BREADTH_BELOW = 0.40
TAX_RATE = 0.30 * 1.04
RESTRIKE_TOLERANCE = 0.01
BOOT_DRAWS, BOOT_BLOCK, SEED = 2000, 4, 20261115
CHAIN_KEPT = 60_000  # (day, symbol) chains kept in memory between runs
OPTION_COLUMNS = [
    "date",
    "symbol",
    "expiry",
    "strike",
    "option_type",
    "close",
    "settle",
    "contracts",
    "oi",
]


@dataclass(frozen=True)
class Settings:
    direction: Direction = "calls"
    moneyness: str = "ATM"
    sizing: Sizing = "one_lot"
    #: premium: rupees of premium per stock (None = capital / sleeves / N); capital_share: the share
    #: of capital spent on premium each week, split over that week's picks.
    sizing_value: float | None = None
    capital: float = 1_000_000.0
    n: int = 5  # puts / mirror: how many names a week
    min_sessions_left: int = 10
    min_oi_lots: int = 10
    slippage: float | None = None  # a share of premium each way; None = by moneyness
    tax: bool = True
    market_filter: MarketFilter = "nifty_200dma"
    put_share: float = 0.5  # both sides: the puts' share of the budget
    start: str = "2020-01-01"
    end: str | None = None
    #: Profit booking: each time the trading account is this many rupees above where it last
    #: booked, `withdraw_share` of each step is taken out and the rest stays to trade; None = off
    #: (every week sized on `capital`, nothing taken out).
    profit_step: float | None = None
    withdraw_share: float = 0.75

    def validate(self) -> None:
        if self.moneyness not in MONEYNESS:
            raise ValueError(f"Moneyness must be one of {', '.join(MONEYNESS)}.")
        if not 1 <= self.n <= 30:
            raise ValueError("N must be between 1 and 30.")
        if not 0 < self.capital <= 1e9:
            raise ValueError("Capital must be above zero.")
        if self.sizing == "capital_share" and not (
            self.sizing_value is not None and 0 < self.sizing_value <= 1
        ):
            raise ValueError("A share of capital must be between 0 and 1 (e.g. 0.2 for 20 %).")
        if self.sizing == "premium" and self.sizing_value is not None and self.sizing_value <= 0:
            raise ValueError("Premium per stock must be above zero.")
        if not 0 <= self.put_share <= 1:
            raise ValueError("The puts' share must be between 0 and 1.")
        if self.slippage is not None and not 0 <= self.slippage < 0.5:
            raise ValueError("Slippage must be between 0 and 50 % of premium.")
        if not 1 <= self.min_sessions_left <= 60:
            raise ValueError("Sessions left must be between 1 and 60.")
        if self.profit_step is not None and self.profit_step <= 0:
            raise ValueError("The profit step must be above zero.")
        if not 0 <= self.withdraw_share <= 1:
            raise ValueError("The share taken out must be between 0 and 1.")

    @property
    def slip(self) -> float:
        return DEFAULT_SLIPPAGE[self.moneyness] if self.slippage is None else self.slippage


@dataclass
class Sleeve:
    """One sleeve of the strategy: {rebalance day: held symbols} and the strategy's N."""

    picks: dict[pd.Timestamp, list[str]]
    n: int


# ---------------------------------------------------------------------------------------------
# Data: the F&O lake, cached per process and dropped when the lake's newest day changes
# ---------------------------------------------------------------------------------------------


def data_root() -> Path:
    from trading_data.db import data_root as root

    return root()


def _fo_dir() -> Path:
    return data_root() / "lake" / "eod" / "fo_bhavcopy"


class Lake:
    """Read-only view of the F&O lake: sessions, lots, bans, chains, spots, NIFTY."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._key: str | None = None
        self._chains: dict[tuple[pd.Timestamp, str], pd.DataFrame] = {}
        self._spots: pd.DataFrame | None = None
        self._spot_days: set[pd.Timestamp] = set()
        self._cache: dict[str, Any] = {}
        self._key_locks: dict[str, threading.Lock] = {}
        self._groups: dict[str, list[str]] = {}

    def _check(self) -> None:
        days = sorted(p.name[5:] for p in _fo_dir().glob("date=*"))
        if not days:
            raise FileNotFoundError("No F&O bhavcopy days in the lake: run `obt nse fo-fetch`.")
        key = days[-1]
        if key != self._key:
            self._key = key
            self._chains.clear()
            self._cache.clear()
            self._groups.clear()
            self._spots, self._spot_days = None, set()
            self._cache["sessions"] = [pd.Timestamp(d) for d in days]

    @property
    def newest(self) -> str:
        with self._lock:
            self._check()
            return str(self._key)

    def sessions(self) -> list[pd.Timestamp]:
        with self._lock:
            self._check()
            return self._cache["sessions"]

    def lots(self) -> pd.Series:
        with self._lock:
            self._check()
            if "lots" not in self._cache:
                p = data_root() / "lake" / "eod" / "fno_universe" / "lots.parquet"
                df = pd.read_parquet(p, columns=["date", "symbol", "expiry", "lot_size"])
                for c in ("date", "expiry"):
                    df[c] = pd.to_datetime(df[c])
                self._cache["lots"] = df.set_index(["date", "symbol", "expiry"])["lot_size"]
            return self._cache["lots"]

    def bans(self) -> set[tuple[pd.Timestamp, str]]:
        with self._lock:
            self._check()
            if "bans" not in self._cache:
                p = data_root() / "lake" / "eod" / "fno_universe" / "bans.parquet"
                df = pd.read_parquet(p)
                self._cache["bans"] = {
                    (pd.Timestamp(d), s) for d, s in zip(df["date"], df["symbol"], strict=True)
                }
            return self._cache["bans"]

    def nifty(self) -> pd.Series:
        with self._lock:
            self._check()
            if "nifty" not in self._cache:
                import duckdb

                g = (
                    data_root()
                    / "lake"
                    / "bars_1m"
                    / "asset=index"
                    / "symbol=NIFTY"
                    / "date=*"
                    / "data.parquet"
                )
                df = (
                    duckdb.connect()
                    .execute(
                        f"SELECT CAST(date AS VARCHAR) AS d, arg_max(close, ts) AS close "
                        f"FROM read_parquet('{g}', hive_partitioning=1) GROUP BY 1 ORDER BY 1"
                    )
                    .df()
                )
                self._cache["nifty"] = pd.Series(
                    df["close"].to_numpy(), index=pd.to_datetime(df["d"])
                )
            return self._cache["nifty"]

    def chains(self, pairs: set[tuple[pd.Timestamp, str]]) -> dict:
        """{(day, symbol): that day's OPTSTK rows} for exactly the pairs a run trades (entry and
        exit days), loading only what is not cached; the cache is cleared past CHAIN_KEPT pairs."""
        import duckdb

        with self._lock:
            self._check()
            want = sorted(p for p in pairs if p not in self._chains)
            if want:
                if len(self._chains) + len(want) > CHAIN_KEPT:
                    self._chains.clear()
                    want = sorted(pairs)
                wanted = pd.DataFrame({"d": [d.date() for d, _ in want], "s": [s for _, s in want]})
                day_list = ",".join(f"DATE '{d}'" for d in sorted(set(wanted["d"])))
                glob = str(_fo_dir() / "date=*" / "data.parquet")
                con = duckdb.connect()
                con.register("wanted", wanted)
                cols = ", ".join(f"f.{c}" for c in OPTION_COLUMNS)
                df = con.execute(
                    f"SELECT {cols} FROM read_parquet('{glob}') f "
                    "JOIN wanted w ON f.date = w.d AND f.symbol = w.s "
                    f"WHERE f.instrument = 'OPTSTK' AND f.date IN ({day_list})"
                ).df()
                for c in ("date", "expiry"):
                    df[c] = pd.to_datetime(df[c])
                for key, g in df.groupby(["date", "symbol"]):
                    self._chains[(pd.Timestamp(key[0]), key[1])] = g
                empty = df.iloc[0:0]
                for key in want:
                    self._chains.setdefault(key, empty)
            return {p: self._chains[p] for p in pairs}

    def spots(self, days: list[pd.Timestamp]) -> pd.DataFrame:
        """date x symbol unadjusted cash closes (the EQ series first) on the given days."""
        from momentum_backtesting.db_read import stock_bars

        with self._lock:
            self._check()
            missing = [d for d in days if d not in self._spot_days]
            if missing:
                day_list = ",".join(f"DATE '{d.date()}'" for d in missing)
                with stock_bars() as con:
                    df = con.execute(
                        f"""SELECT b.date, i.symbol, b.close, b.series
                            FROM bars_1d_stock b JOIN instruments i USING (instrument_id)
                            WHERE b.date IN ({day_list})"""
                    ).df()
                df["rank"] = (df["series"] != "EQ").astype(int)
                df = df.sort_values("rank").drop_duplicates(["date", "symbol"])
                df["date"] = pd.to_datetime(df["date"])
                wide = df.pivot(index="date", columns="symbol", values="close")
                self._spots = wide if self._spots is None else pd.concat([self._spots, wide])
                self._spots = self._spots[~self._spots.index.duplicated()].sort_index()
                self._spot_days |= set(missing)
            return self._spots

    def remember(self, key: str, make, *, group: str | None = None, keep: int = 0):
        """A value cached until the lake changes (the stock frame, a weak list, a favourite's
        re-run). Computed once even when two runs ask at the same time (a lock per key); with
        `group`, only the newest `keep` keys of that group are kept."""
        with self._lock:
            self._check()
            if key in self._cache:
                return self._cache[key]
            key_lock = self._key_locks.setdefault(key, threading.Lock())
        with key_lock:
            with self._lock:
                if key in self._cache:
                    return self._cache[key]
            value = make()
            with self._lock:
                self._cache[key] = value
                if group is not None:
                    order = self._groups.setdefault(group, [])
                    order.append(key)
                    while len(order) > keep:
                        self._cache.pop(order.pop(0), None)
        return value


LAKE = Lake()


def rebalance_day(week: pd.Timestamp, sessions: np.ndarray, days: list) -> pd.Timestamp | None:
    """The last F&O session on or before the week's label (a Friday), within that week."""
    i = int(np.searchsorted(sessions, np.datetime64(week), side="right")) - 1
    if i < 0:
        return None
    d = days[i]
    return d if (week - d).days < 7 else None


# ---------------------------------------------------------------------------------------------
# Put and mirror lists (BL-228)
# ---------------------------------------------------------------------------------------------


def _returns(prices: pd.DataFrame, membership: pd.DataFrame, log: bool):
    prices = prices.sort_index()
    member = membership.reindex(index=prices.index, columns=prices.columns).fillna(False)
    base = np.log(prices) if log else prices
    rets = {h: (base - base.shift(h)) if log else (prices / prices.shift(h) - 1) for h in HORIZONS}
    eligible = member.astype(bool)
    for r in rets.values():
        eligible &= r.notna()
    return prices, rets, eligible


def _base(col: str, to_base: dict[str, str]) -> str:
    return to_base.get(col, col.split("#", 1)[0])


def weak_list(prices, membership, to_base, n) -> dict[pd.Timestamp, list[str]]:
    """{week: base symbols of the n weakest eligible columns by rank-sum of 1-52-week returns,
    kept where the 26-week return is below zero and the close below its 40-week average}."""
    prices, rets, eligible = _returns(prices, membership, log=False)
    score = sum(r.where(eligible).rank(axis=1, ascending=True) for r in rets.values())
    average = prices.rolling(AVERAGE_WEEKS, min_periods=AVERAGE_WEEKS).mean()
    down = (rets[TREND_WEEKS] < 0) & (prices < average)
    out = {}
    for week in prices.index:
        s = score.loc[week].dropna().sort_index().sort_values(kind="mergesort")
        names: list[str] = []
        for c in s.index[:n]:
            if bool(down.at[week, c]) and _base(c, to_base) not in names:
                names.append(_base(c, to_base))
        out[week] = names
    return out


def mirror_list(prices, membership, to_base, n) -> dict[pd.Timestamp, list[str]]:
    """{week: "SYMBOL|CE" / "SYMBOL|PE"}: every eligible column and its inverse (1 / price) ranked
    together on the rank-sum of their log returns; the n highest kept where the chart picked has
    its own trend up (26-week log return above zero, close above its own 40-week average)."""
    prices, rets, eligible = _returns(prices, membership, log=True)
    inv_cols = ["~" + c for c in prices.columns]
    score = None
    for r in rets.values():
        both = pd.concat(
            [r.where(eligible), (-r).where(eligible).set_axis(inv_cols, axis=1)], axis=1
        )
        ranked = both.rank(axis=1, ascending=True)
        score = ranked if score is None else score + ranked
    inverse = 1 / prices
    up = (rets[TREND_WEEKS] > 0) & (
        prices > prices.rolling(AVERAGE_WEEKS, min_periods=AVERAGE_WEEKS).mean()
    )
    up_inv = (rets[TREND_WEEKS] < 0) & (
        inverse > inverse.rolling(AVERAGE_WEEKS, min_periods=AVERAGE_WEEKS).mean()
    )
    out = {}
    for week in prices.index:
        s = score.loc[week].dropna().sort_index().sort_values(ascending=False, kind="mergesort")
        picked: list[str] = []
        for c in s.index[:n]:
            col, right = (c[1:], "PE") if c.startswith("~") else (c, "CE")
            if not bool((up_inv if right == "PE" else up).at[week, col]):
                continue
            item = f"{_base(col, to_base)}|{right}"
            if item not in picked:
                picked.append(item)
        out[week] = picked
    return out


def breadth(prices: pd.DataFrame, membership: pd.DataFrame) -> pd.Series:
    """Share of eligible F&O stocks above their own 40-week average, per week."""
    prices = prices.sort_index()
    member = membership.reindex(index=prices.index, columns=prices.columns).fillna(False)
    average = prices.rolling(AVERAGE_WEEKS, min_periods=AVERAGE_WEEKS).mean()
    have = member & average.notna()
    above = (prices > average) & have
    return above.sum(axis=1) / have.sum(axis=1).replace(0, np.nan)


def fno_frame():
    """Broad's `fno` universe frame (adjusted weekly closes, split segments apart, point-in-time
    F&O list and BL-226's tradability gate), cached until the lake changes."""

    def make():
        from momentum_backtesting.categories import broad
        from momentum_backtesting.categories.liquidity import LiquidityConfig
        from momentum_backtesting.config import DATA_DIR

        u = broad.load_stock_universe_frame(
            stocks_data_dir=DATA_DIR / "stocks",
            categories_data_dir=DATA_DIR / "categories",
            liquidity=LiquidityConfig(min_turnover_cr=2.0, floor_ratio=0.25, min_price=30.0),
            universe="fno",
        )
        return u.frame, u.stock_membership, u.column_to_base_symbol

    return LAKE.remember("fno_frame", make)


# ---------------------------------------------------------------------------------------------
# The book
# ---------------------------------------------------------------------------------------------


def costs(buy: float, sell: float, day: pd.Timestamp) -> float:
    after = day >= pd.Timestamp("2024-10-01")
    stt = sell * (0.001 if after else 0.000625)
    txn = (buy + sell) * (0.0003503 if after else 0.00053)
    sebi = (buy + sell) * 1e-6
    stamp = buy * 0.00003
    brokerage = 40.0
    return brokerage + stt + txn + sebi + stamp + 0.18 * (brokerage + txn + sebi)


@dataclass
class Leg:
    """One stream of entries: {day: ["SYM" or "SYM|CE"/"SYM|PE"]} with its default right and
    budget (rupees of premium per stock, or None = one lot; or a weekly total split over picks)."""

    picks: dict[pd.Timestamp, list[str]]
    right: str  # the right of a bare symbol
    per_stock: float | None = None
    weekly_total: float | None = None
    tag: str = ""


@dataclass
class BookCounts:
    entries: int = 0
    settle_entry: int = 0
    settle_exit: int = 0
    not_a_stock: int = 0  # a holding with no cash price at all (gold, an index, cash)
    no_spot: int = 0
    no_contract: int = 0
    thin: int = 0
    banned: int = 0
    too_dear: int = 0
    restruck: int = 0
    zero_booked: int = 0
    no_capital: int = 0  # profit booking: the trading account could not pay for it


def _expiry(rows: pd.DataFrame, day: pd.Timestamp, sessions: np.ndarray, min_left: int):
    exps = np.sort(rows["expiry"].unique())
    if not len(exps):
        return None
    left = np.searchsorted(sessions, exps.astype("datetime64[ns]"), side="right") - np.searchsorted(
        sessions, np.datetime64(day), side="right"
    )
    ok = exps[left >= min_left]
    return pd.Timestamp(ok[0]) if len(ok) else None


def run_leg(
    leg: Leg,
    s: Settings,
    days: list[pd.Timestamp],
    chains: dict,
    spots: pd.DataFrame,
    lots: pd.Series,
    bans: set,
    sessions: np.ndarray,
    counts: BookCounts,
) -> list[dict]:
    """Trades for one leg over consecutive rebalance days (each entry exits on the next day)."""
    trades = []
    for d0, d1 in zip(days[:-1], days[1:], strict=True):
        trades += trade_week(leg, s, d0, d1, chains, spots, lots, bans, sessions, counts)
    return trades


def trade_week(
    leg: Leg,
    s: Settings,
    d0: pd.Timestamp,
    d1: pd.Timestamp,
    chains: dict,
    spots: pd.DataFrame,
    lots: pd.Series,
    bans: set,
    sessions: np.ndarray,
    counts: BookCounts,
    *,
    scale: float = 1.0,
    afford: float | None = None,
) -> list[dict]:
    """One leg's entries on d0, sold on d1. `scale` multiplies the leg's budget (profit booking:
    the trading account against the starting capital); `afford` caps the premium a one-lot book
    may spend this week (picks in order until it runs out)."""
    trades: list[dict] = []
    offset = MONEYNESS[s.moneyness]
    slip = s.slip
    for _ in (0,):
        items = leg.picks.get(d0, [])
        if not items:
            continue
        ready = []  # the picks that can be bought, before sizing
        for item in items:
            sym, right = item.split("|", 1) if "|" in item else (item, leg.right)
            counts.entries += 1
            if (d0, sym) in bans:
                counts.banned += 1
                continue
            if sym not in spots.columns:
                counts.not_a_stock += 1
                continue
            spot = spots.at[d0, sym] if d0 in spots.index else np.nan
            if not spot > 0:
                counts.no_spot += 1
                continue
            rows = chains.get((d0, sym))
            if rows is None or rows.empty:
                counts.no_contract += 1
                continue
            expiry = _expiry(rows, d0, sessions, s.min_sessions_left)
            if expiry is None:
                counts.no_contract += 1
                continue
            side = rows[(rows["expiry"] == expiry) & (rows["option_type"] == right)]
            strikes = np.sort(side["strike"].unique())
            if not len(strikes):
                counts.no_contract += 1
                continue
            i = int(np.argmin(np.abs(strikes - spot))) + offset * (1 if right == "CE" else -1)
            if not 0 <= i < len(strikes):
                counts.no_contract += 1
                continue
            k = float(strikes[i])
            row = side[side["strike"] == k].iloc[0]
            lot = lots.get((d0, sym, expiry))
            if lot is None or not lot > 0:
                counts.no_contract += 1
                continue
            if not row["oi"] >= s.min_oi_lots * lot:
                counts.thin += 1
                continue
            traded = bool(row["contracts"] > 0)
            p0 = float(row["close"] if traded else row["settle"])
            if not p0 > 0:  # NaN or zero: no price to buy at
                counts.no_contract += 1
                continue
            ready.append((sym, right, expiry, k, lot, p0, traded, spot))
        per_stock = None if leg.per_stock is None else leg.per_stock * scale
        if leg.weekly_total is not None and ready:
            # the week's budget over the picks that can be bought, not the skipped ones
            per_stock = leg.weekly_total * scale / len(ready)
        for sym, right, expiry, k, lot, p0, traded, spot in ready:
            one_lot = p0 * lot
            if per_stock is None:
                if afford is not None:
                    if one_lot * (1 + slip) > afford:
                        counts.no_capital += 1
                        continue
                    afford -= one_lot * (1 + slip)
                n_lots = 1
            else:
                if per_stock <= 0:
                    counts.no_capital += 1
                    continue
                if one_lot > 2 * per_stock:
                    counts.too_dear += 1
                    continue
                n_lots = max(1, round(per_stock / one_lot))
            counts.settle_entry += 0 if traded else 1
            p1, exit_traded, qty_exit, how = _exit_price(
                chains.get((d1, sym)), expiry, right, k, lot, d1, sym, lots
            )
            if how == "restruck":
                counts.restruck += 1
            elif how == "zero":
                counts.zero_booked += 1
            elif not exit_traded:
                counts.settle_exit += 1
            buy = p0 * (1 + slip) * n_lots * lot
            sell = max(p1 * (1 - slip), 0.0) * n_lots * qty_exit
            cost = costs(buy, sell, d1)
            spot1 = spots.at[d1, sym] if (sym in spots.columns and d1 in spots.index) else np.nan
            trades.append(
                {
                    "entry": d0,
                    "exit": d1,
                    "symbol": sym,
                    "right": right,
                    "leg": leg.tag,
                    "expiry": expiry,
                    "strike": k,
                    "spot": float(spot),
                    "spot_exit": float(spot1) if spot1 == spot1 else None,
                    "lot": int(lot),
                    "lots": int(n_lots),
                    "p0": p0,
                    "p1": float(p1),
                    "entry_traded": traded,
                    "exit_how": how,
                    "buy": buy,
                    "sell": sell,
                    "costs": cost,
                    "pnl": sell - buy - cost,
                }
            )
    return trades


def _exit_price(rows, expiry, right, k, lot, d1, sym, lots):
    """(price, traded, exit lot, how): the same contract, or its re-struck successor, or zero."""
    if rows is None or rows.empty:
        return 0.0, False, lot, "zero"
    side = rows[(rows["expiry"] == expiry) & (rows["option_type"] == right)]
    same = side[side["strike"] == k]
    how = "same"
    if same.empty:
        lot1 = lots.get((d1, sym, expiry))
        if lot1 is None or not lot1 > 0 or lot1 == lot:
            return 0.0, False, lot, "zero"
        target = k * lot
        gap = (side["strike"] * lot1 - target).abs() / target
        same = side[gap <= RESTRIKE_TOLERANCE]
        if same.empty:
            return 0.0, False, lot, "zero"
        same = same.loc[[gap[same.index].idxmin()]]
        lot, how = lot1, "restruck"
    e = same.iloc[0]
    traded = bool(e["contracts"] > 0)
    p1 = e["close"] if traded else e["settle"]
    if not p1 >= 0:
        return 0.0, False, lot, "zero"
    return float(p1), traded, lot, how


def merge_positions(t: pd.DataFrame) -> pd.DataFrame:
    """One row per contract a week: sleeves (or both sides) that bought the same contract on the
    same day are one position, their lots, money and costs added up."""
    if not len(t):
        return t
    keys = ["entry", "exit", "symbol", "right", "expiry", "strike"]
    summed = ["lots", "buy", "sell", "costs", "pnl"]
    first = [c for c in t.columns if c not in keys + summed]
    agg = {**{c: "sum" for c in summed}, **{c: "first" for c in first}}
    return t.groupby(keys, as_index=False, sort=False).agg(agg)[list(t.columns)]


def fy(d: pd.Timestamp) -> int:
    return d.year if d.month >= 4 else d.year - 1


def weekly_pnl(trades: pd.DataFrame, weeks: list[pd.Timestamp], tax: bool) -> pd.DataFrame:
    """Per exit week: P&L before tax, the tax taken (at each financial year's last week, a loss
    carried forward), and after tax."""
    before = (
        trades.groupby("exit")["pnl"].sum().reindex(weeks, fill_value=0.0)
        if len(trades)
        else pd.Series(0.0, index=weeks)
    )
    taxed = pd.Series(0.0, index=weeks)
    if tax:
        carry = 0.0
        for y in sorted({fy(d) for d in weeks}):
            in_year = [d for d in weeks if fy(d) == y]
            net = float(before.loc[in_year].sum()) - carry
            if net > 0:
                taxed.loc[in_year[-1]] = TAX_RATE * net
                carry = 0.0
            else:
                carry = -net
    return pd.DataFrame({"before_tax": before, "tax": taxed, "after_tax": before - taxed})


def _max_dd(equity: np.ndarray) -> tuple[float, int, int]:
    """(deepest fall as a share of the running high, peak index, trough index)."""
    peaks = np.maximum.accumulate(equity)
    dd = np.where(peaks > 0, equity / peaks - 1, -1.0)
    trough = int(np.argmin(dd))
    peak = int(np.argmax(equity[: trough + 1])) if trough else 0
    return float(dd[trough]), peak, trough


def _bootstrap(x: np.ndarray) -> list[float] | None:
    n = len(x)
    if n < BOOT_BLOCK * 4:
        return None
    rng = np.random.default_rng(SEED)
    starts = rng.integers(0, n - BOOT_BLOCK + 1, size=(BOOT_DRAWS, math.ceil(n / BOOT_BLOCK)))
    idx = (starts[:, :, None] + np.arange(BOOT_BLOCK)).reshape(BOOT_DRAWS, -1)[:, :n]
    means = x[idx].mean(axis=1)
    return [float(np.quantile(means, 0.05)), float(np.quantile(means, 0.95))]


def cagr(start_value: float, end_value: float, years: float) -> float | None:
    if years <= 0 or start_value <= 0 or end_value <= 0:
        return None
    return (end_value / start_value) ** (1 / years) - 1


# ---------------------------------------------------------------------------------------------
# A run
# ---------------------------------------------------------------------------------------------


@dataclass
class Inputs:
    """What the caller supplies: the strategy's sleeves (calls) and its after-tax equity (the
    shares book), both from a re-run on the F&O universe; empty for puts / mirror alone."""

    sleeves: list[Sleeve] = field(default_factory=list)
    stock_equity: pd.Series | None = None
    strategy_name: str | None = None


def _picks_by_entry(weekly: dict, sessions: np.ndarray, days: list, start, end) -> dict:
    """Signal week -> the next week's rebalance day."""
    weeks = sorted(weekly)
    out = {}
    for w0, w1 in zip(weeks[:-1], weeks[1:], strict=True):
        d = rebalance_day(w1, sessions, days)
        if d is not None and start <= d <= end:
            out[d] = weekly[w0]
    return out


def market_down(s: Settings, entry_days: list[pd.Timestamp], frame=None) -> dict:
    """{entry day: the market was falling at the previous session's close} by the chosen test."""
    sessions = LAKE.sessions()
    arr = np.array(sessions, dtype="datetime64[ns]")
    out = {}
    if s.market_filter == "breadth":
        prices, membership, _ = frame if frame is not None else fno_frame()
        b = breadth(prices, membership)
        for d in entry_days:
            prev = b[b.index < d]
            out[d] = bool(len(prev) and prev.iloc[-1] < BREADTH_BELOW)
        return out
    nifty = LAKE.nifty()
    sma = nifty.rolling(NIFTY_AVERAGE, min_periods=NIFTY_AVERAGE).mean()
    for d in entry_days:
        i = int(np.searchsorted(arr, np.datetime64(d), side="left")) - 1
        prev = sessions[i] if i >= 0 else d
        c = nifty.asof(prev)
        if s.market_filter == "nifty_26w":
            back = nifty.asof(prev - pd.Timedelta(weeks=26))
            out[d] = bool(back == back and c < back)
        else:
            a = sma.asof(prev)
            out[d] = bool(a == a and c < a)
    return out


def run(s: Settings, inputs: Inputs) -> dict[str, Any]:
    s.validate()
    sessions_list = LAKE.sessions()
    sessions = np.array(sessions_list, dtype="datetime64[ns]")
    start = pd.Timestamp(s.start)
    end = pd.Timestamp(s.end) if s.end else sessions_list[-1]
    needs_calls = s.direction in ("calls", "switch", "both")
    needs_puts = s.direction in ("puts", "switch", "both")
    if needs_calls and not inputs.sleeves:
        raise ValueError("Pick a strategy: calls are bought on its holdings.")

    # every rebalance day in the window, so each entry has its exit
    all_weeks = pd.date_range(start - pd.Timedelta(days=7), end, freq="W-FRI")
    days = sorted(
        {
            d
            for w in all_weeks
            if (d := rebalance_day(w, sessions, sessions_list)) is not None and start <= d <= end
        }
    )
    if len(days) < 3:
        raise ValueError("The window holds fewer than three rebalance weeks of F&O data.")

    call_legs: list[Leg] = []
    for sl in inputs.sleeves:
        picks = {d: v for d, v in sl.picks.items() if start <= d <= end}
        call_legs.append(Leg(picks=picks, right="CE", tag="calls"))
    put_picks: dict = {}
    mirror_picks: dict = {}
    frame = None
    if needs_puts or s.direction == "mirror" or s.market_filter == "breadth":
        frame = fno_frame()
    if needs_puts:
        weekly = LAKE.remember(f"weak:{s.n}", lambda: weak_list(*frame, s.n))
        put_picks = _picks_by_entry(weekly, sessions, sessions_list, start, end)
    if s.direction == "mirror":
        weekly = LAKE.remember(f"mirror:{s.n}", lambda: mirror_list(*frame, s.n))
        mirror_picks = _picks_by_entry(weekly, sessions, sessions_list, start, end)

    down = market_down(s, days, frame) if s.direction == "switch" else {}
    k = max(len(call_legs), 1)
    n_call = [sl.n for sl in inputs.sleeves] or [s.n]
    call_share = 1 - s.put_share if s.direction == "both" else 1.0
    put_share = s.put_share if s.direction == "both" else 1.0

    def budget(share: float, n: int, sleeves: int) -> tuple[float | None, float | None]:
        """(premium per stock, weekly premium total) for one leg; share = its side's budget."""
        if s.sizing == "one_lot":
            return None, None
        if s.sizing == "premium":
            per = s.sizing_value if s.sizing_value is not None else s.capital / sleeves / n
            return per * share, None
        return None, s.capital * float(s.sizing_value) * share / sleeves

    legs: list[Leg] = []
    if s.direction == "mirror":
        per, total = budget(1.0, s.n, 1)
        legs.append(
            Leg(picks=mirror_picks, right="CE", per_stock=per, weekly_total=total, tag="mirror")
        )
    if needs_calls:
        for leg, n in zip(call_legs, n_call, strict=False):
            per, total = budget(call_share, n, k)
            picks = leg.picks
            if s.direction == "switch":
                picks = {d: (v if not down.get(d, False) else []) for d, v in picks.items()}
            legs.append(
                Leg(picks=picks, right="CE", per_stock=per, weekly_total=total, tag="calls")
            )
    if needs_puts:
        per, total = budget(put_share, s.n, 1)
        picks = put_picks
        if s.direction == "switch":
            picks = {d: (v if down.get(d, False) else []) for d, v in picks.items()}
        legs.append(Leg(picks=picks, right="PE", per_stock=per, weekly_total=total, tag="puts"))

    pairs: set[tuple[pd.Timestamp, str]] = set()
    for leg in legs:
        for d0, d1 in zip(days[:-1], days[1:], strict=True):
            for item in leg.picks.get(d0, []):
                sym = item.split("|", 1)[0]
                pairs |= {(d0, sym), (d1, sym)}
    chains = LAKE.chains(pairs) if pairs else {}
    spots = LAKE.spots(days)
    lots, bans = LAKE.lots(), LAKE.bans()
    counts = BookCounts()
    trades: list[dict] = []
    booking = None
    if s.profit_step is None:
        for leg in legs:
            trades += run_leg(leg, s, days, chains, spots, lots, bans, sessions, counts)
    else:
        trades, booking = run_booked(legs, s, days, chains, spots, lots, bans, sessions, counts)
    tdf = merge_positions(pd.DataFrame(trades))
    # one lot of everything, for the minimum-capital table (the same picks at one lot each)
    if s.sizing == "one_lot" and s.profit_step is None:
        one = tdf  # with booking the account skips picks it cannot pay for: run every pick
    else:
        c2 = BookCounts()
        one_legs = [Leg(picks=leg.picks, right=leg.right, tag=leg.tag) for leg in legs]
        one = merge_positions(
            pd.DataFrame(
                [
                    t
                    for leg in one_legs
                    for t in run_leg(leg, s, days, chains, spots, lots, bans, sessions, c2)
                ]
            )
        )
    return summarise(s, inputs, tdf, one, days, counts, down, booking)


def run_booked(legs, s: Settings, days, chains, spots, lots, bans, sessions, counts):
    """The book week by week with profit booking. The trading account starts at `capital`, takes
    each week's P&L (before tax) and sizes the next week on itself: the budgets scale by account /
    capital, and a one-lot book buys only the picks the account can pay for. Each time it stands a
    whole `profit_step` (or more) above where it last booked, `withdraw_share` of those steps is
    taken out and the rest stays to trade; a loss must be made back before the next booking."""
    trades: list[dict] = []
    account = base = s.capital
    taken = 0.0
    account_by_day = {days[0]: account}
    taken_by_day = {days[0]: 0.0}
    events = []
    for d0, d1 in zip(days[:-1], days[1:], strict=True):
        scale = max(account, 0.0) / s.capital
        afford = max(account, 0.0) if s.sizing == "one_lot" else None
        week: list[dict] = []
        for leg in legs:
            got = trade_week(leg, s, d0, d1, chains, spots, lots, bans, sessions, counts,
                             scale=scale, afford=afford)  # fmt: skip
            if afford is not None:
                afford -= sum(t["buy"] for t in got)
            week += got
        account += sum(t["pnl"] for t in week)
        steps = int((account - base) // s.profit_step) if account > base else 0
        if steps > 0:
            out = s.withdraw_share * steps * s.profit_step
            account -= out
            taken += out
            base += steps * s.profit_step * (1 - s.withdraw_share)
            events.append({"day": d1.date().isoformat(), "taken_rs": round(out),
                           "account_rs": round(account)})  # fmt: skip
        account_by_day[d1] = account
        taken_by_day[d1] = taken
        trades += week
    return trades, {
        "account": account_by_day,
        "taken": taken_by_day,
        "events": events,
    }


# ---------------------------------------------------------------------------------------------
# The response
# ---------------------------------------------------------------------------------------------


def _iso(d) -> str:
    return pd.Timestamp(d).date().isoformat()


def summarise(
    s: Settings,
    inputs: Inputs,
    t: pd.DataFrame,
    one: pd.DataFrame,
    days: list,
    counts: BookCounts,
    down: dict,
    booking: dict | None = None,
) -> dict[str, Any]:
    weeks = days[1:]
    w = weekly_pnl(t, weeks, s.tax)
    equity = s.capital + w["after_tax"].cumsum()
    eq_arr = np.concatenate([[s.capital], equity.to_numpy()])
    dd, peak_i, trough_i = _max_dd(eq_arr)
    eq_days = [days[0], *weeks]
    years = max((days[-1] - days[0]).days / 365.25, 1e-9)
    total = float(w["after_tax"].sum())
    book = {
        "total_rs": round(total),
        "total": total / s.capital,
        "cagr": cagr(s.capital, s.capital + total, years),
        "max_dd": dd,
        "dd_peak": _iso(eq_days[peak_i]),
        "dd_trough": _iso(eq_days[trough_i]),
        "before_tax_rs": round(float(w["before_tax"].sum())),
        "tax_rs": round(float(w["tax"].sum())),
        "costs_rs": round(float(t["costs"].sum())) if len(t) else 0,
        "weekly_90": _bootstrap((w["after_tax"] / s.capital).to_numpy()),
        "went_below_zero": bool((eq_arr <= 0).any()),
    }

    # the shares book (the strategy re-run on F&O stocks) and NIFTY, on the same days
    series = {"days": [_iso(d) for d in eq_days], "options": [round(float(x)) for x in eq_arr]}
    shares = None
    if inputs.stock_equity is not None and len(inputs.stock_equity):
        se = inputs.stock_equity.sort_index()
        vals = np.array([se.asof(d) for d in eq_days], dtype=float)
        if np.isfinite(vals[0]) and vals[0] > 0:
            vals = s.capital * vals / vals[0]
            vals = pd.Series(vals).ffill().to_numpy()
            sdd, sp, st = _max_dd(vals)
            shares = {
                "total": float(vals[-1] / s.capital - 1),
                "total_rs": round(float(vals[-1] - s.capital)),
                "cagr": cagr(s.capital, float(vals[-1]), years),
                "max_dd": sdd,
                "dd_peak": _iso(eq_days[sp]),
                "dd_trough": _iso(eq_days[st]),
            }
            series["shares"] = [round(float(x)) for x in vals]
    nifty = LAKE.nifty()
    nv = np.array([nifty.asof(d) for d in eq_days], dtype=float)
    nifty_book = None
    if np.isfinite(nv[0]) and nv[0] > 0:
        nv = s.capital * nv / nv[0]
        ndd, _, _ = _max_dd(nv)
        nifty_book = {
            "total": float(nv[-1] / s.capital - 1),
            "cagr": cagr(s.capital, float(nv[-1]), years),
            "max_dd": ndd,
        }
        series["nifty"] = [round(float(x)) for x in nv]
    series["drawdown"] = [
        round(float(x), 4)
        for x in np.where(
            np.maximum.accumulate(eq_arr) > 0, eq_arr / np.maximum.accumulate(eq_arr) - 1, -1.0
        )
    ]

    return {
        "settings": {**s.__dict__, "slippage": s.slip},
        "strategy": inputs.strategy_name,
        "data_through": LAKE.newest,
        "first_day": _iso(days[0]),
        "last_day": _iso(days[-1]),
        "weeks": len(weeks),
        "book": book,
        "shares": shares,
        "nifty": nifty_book,
        "series": series,
        "min_capital": min_capital(one, weeks, s),
        "stats": trade_stats(t),
        "by_stock": by_stock(t),
        "by_year": by_year(t, w, inputs, s),
        "sides": sides(t, down, days),
        "counts": counts.__dict__,
        "trades": trades_rows(t),
        "booking": booking_summary(booking, eq_days, s),
    }


def booking_summary(booking: dict | None, eq_days: list, s: Settings) -> dict[str, Any] | None:
    """Profit booking: the trading account and the money taken out on the chart's days, the
    bookings, and where it ended (before tax; the book's total is after tax)."""
    if booking is None:
        return None
    account = [round(float(booking["account"].get(d, np.nan))) for d in eq_days]
    taken = [round(float(booking["taken"].get(d, 0.0))) for d in eq_days]
    return {
        "profit_step": s.profit_step,
        "withdraw_share": s.withdraw_share,
        "account": account,
        "taken": taken,
        "taken_rs": taken[-1],
        "account_end_rs": account[-1],
        "bookings": booking["events"],
    }


def min_capital(one: pd.DataFrame, weeks: list, s: Settings) -> dict[str, Any]:
    """One lot of every pick a week: premium needed (median, 90th percentile, largest) and the
    worst fall of that one-lot book before tax; suggested = 90th percentile + worst fall."""
    if not len(one):
        return {"weekly_premium": None, "worst_fall_rs": None, "suggested_rs": None}
    prem = one.groupby("entry")["buy"].sum()
    per_trade = one["buy"]
    eq = np.concatenate(
        [[0.0], one.groupby("exit")["pnl"].sum().reindex(weeks, fill_value=0.0).cumsum().to_numpy()]
    )
    fall = float((eq - np.maximum.accumulate(eq)).min())
    p90 = float(prem.quantile(0.9))
    return {
        "weekly_premium": {
            "median": round(float(prem.median())),
            "p90": round(p90),
            "max": round(float(prem.max())),
        },
        "one_lot": {
            "median": round(float(per_trade.median())),
            "p90": round(float(per_trade.quantile(0.9))),
            "max": round(float(per_trade.max())),
        },
        "positions_per_week": {
            "median": float(one.groupby("entry").size().median()),
            "max": int(one.groupby("entry").size().max()),
        },
        "worst_fall_rs": round(fall),
        "suggested_rs": round(p90 - fall),
    }


def trade_stats(t: pd.DataFrame) -> dict[str, Any]:
    if not len(t):
        return {"trades": 0}
    wins, losses = t[t["pnl"] > 0]["pnl"], t[t["pnl"] <= 0]["pnl"]
    order = t["pnl"].sort_values(ascending=False)
    k = max(1, int(len(t) * 0.05))
    net = float(t["pnl"].sum())
    weekly = t.groupby("exit")["pnl"].sum()
    return {
        "trades": len(t),
        "win_rate": float((t["pnl"] > 0).mean()),
        "avg_win_rs": round(float(wins.mean())) if len(wins) else None,
        "avg_loss_rs": round(float(losses.mean())) if len(losses) else None,
        "payoff": float(wins.mean() / -losses.mean())
        if len(wins) and len(losses) and losses.mean() < 0
        else None,
        "weeks_won": float((weekly > 0).mean()) if len(weekly) else None,
        "net_before_tax_rs": round(net),
        "top5pct_share": float(order.iloc[:k].sum() / net) if net else None,
        "net_without_top5pct_rs": round(float(order.iloc[k:].sum())),
        "best": trades_rows(t.loc[order.index[:10]]),
        "worst": trades_rows(t.loc[order.index[::-1][:10]]),
    }


def by_stock(t: pd.DataFrame) -> list[dict[str, Any]]:
    if not len(t):
        return []
    g = t.groupby("symbol").agg(
        trades=("pnl", "size"),
        net=("pnl", "sum"),
        won=("pnl", lambda x: float((x > 0).mean())),
        best=("pnl", "max"),
        worst=("pnl", "min"),
        premium=("buy", "sum"),
    )
    g = g.sort_values("net", ascending=False)
    return [
        {
            "symbol": sym,
            "trades": int(r.trades),
            "net_rs": round(float(r.net)),
            "win_rate": float(r.won),
            "best_rs": round(float(r.best)),
            "worst_rs": round(float(r.worst)),
            "premium_rs": round(float(r.premium)),
        }
        for sym, r in g.iterrows()
    ]


def by_year(t: pd.DataFrame, w: pd.DataFrame, inputs: Inputs, s: Settings) -> list[dict]:
    out = []
    years = sorted({d.year for d in w.index})
    se = inputs.stock_equity.sort_index() if inputs.stock_equity is not None else None
    for y in years:
        wy = w[[d.year == y for d in w.index]]
        ty = t[t["exit"].dt.year == y] if len(t) else t
        row = {
            "year": y,
            "before_tax_rs": round(float(wy["before_tax"].sum())),
            "after_tax_rs": round(float(wy["after_tax"].sum())),
            "trades": len(ty),
            "win_rate": float((ty["pnl"] > 0).mean()) if len(ty) else None,
            "calls_rs": round(float(ty[ty["right"] == "CE"]["pnl"].sum())) if len(ty) else 0,
            "puts_rs": round(float(ty[ty["right"] == "PE"]["pnl"].sum())) if len(ty) else 0,
        }
        if se is not None and len(se):
            a, b = se.asof(wy.index[0] - pd.Timedelta(days=7)), se.asof(wy.index[-1])
            row["shares_return"] = float(b / a - 1) if a == a and a > 0 and b == b else None
        out.append(row)
    return out


def sides(t: pd.DataFrame, down: dict, days: list) -> dict[str, Any]:
    calls = t[t["right"] == "CE"] if len(t) else t
    puts = t[t["right"] == "PE"] if len(t) else t
    out = {
        "calls": {
            "trades": len(calls),
            "net_rs": round(float(calls["pnl"].sum())) if len(calls) else 0,
        },
        "puts": {
            "trades": len(puts),
            "net_rs": round(float(puts["pnl"].sum())) if len(puts) else 0,
        },
    }
    if down:
        out["weeks_down"] = int(sum(down.get(d, False) for d in days[:-1]))
        out["weeks_up"] = len(days) - 1 - out["weeks_down"]
    return out


def trades_rows(t: pd.DataFrame) -> list[dict[str, Any]]:
    if not len(t):
        return []
    cols = [
        "entry",
        "exit",
        "symbol",
        "right",
        "leg",
        "expiry",
        "strike",
        "spot",
        "spot_exit",
        "lot",
        "lots",
        "p0",
        "p1",
        "exit_how",
        "buy",
        "sell",
        "costs",
        "pnl",
    ]
    rows = []
    for r in t[cols].itertuples(index=False):
        d = {k: (v.item() if hasattr(v, "item") else v) for k, v in r._asdict().items()}
        for c in ("entry", "exit", "expiry"):
            d[c] = _iso(d[c])
        for c in ("buy", "sell", "costs", "pnl"):
            d[c] = round(float(d[c]))
        for c in ("strike", "spot", "p0", "p1"):
            d[c] = float(d[c])
        if d["spot_exit"] is not None and d["spot_exit"] != d["spot_exit"]:
            d["spot_exit"] = None
        rows.append(d)
    return rows
