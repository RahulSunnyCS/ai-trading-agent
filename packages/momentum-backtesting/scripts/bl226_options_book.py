"""BL-226 Phases 3-4: buy the options of the stocks a Phase 2 candidate holds, swapped every week,
on NSE's daily F&O bhavcopy (`lake/eod/fo_bhavcopy`, `lake/eod/fno_universe`, `obt nse ...`).

Registered in backlog/BL-226-fno-momentum-stock-options.md (Phase 0). Per candidate and moneyness:
- every rebalance day (the last F&O session of each Momentum week), for each stock the candidate
  holds that week: the call (Phase 3) at ATM / OTM1 / OTM2 on the stock's listed strikes (ATM =
  the strike nearest the stock's cash close; OTM1 / OTM2 = one / two strikes further out);
- expiry: the nearest one with at least 10 sessions left after the entry day, else the next
  (the session count reads the stored session list: an exchange calendar known in advance);
- tradable when the strike's open interest is at least 10 lots; filled at the close when it traded
  that day, else the settle price (counted);
- sized at Rs 10 lakh / N of premium per stock, whole lots (at least one); a stock whose one lot
  costs over twice that is skipped (counted); sold at the next rebalance day's close / settle;
- costs: Rs 20 a order, STT on the sell premium (0.0625 % to 2024-09-30, 0.1 % after), NSE
  transaction charges (0.053 %, 0.03503 % from 2024-10-01), SEBI Rs 10 a crore, stamp duty
  0.003 % on buys, GST 18 % on brokerage and charges; slippage 1 / 2 / 3 % of premium each way
  (ATM / OTM1 / OTM2), with a double-slippage sensitivity;
- tax: each financial year's net at 30 % + 4 % cess, a loss carried forward and set off.
The stock comparator is the candidate's own after-tax equity (Phase 2, Rs 10 lakh). Verdict on
the confirmation weeks: options total return > stock's, options max drawdown <= 1.5 x stock's,
and the 90 % block-bootstrap interval of the weekly return difference above zero.

    MOMENTUM_DATA_DIR=<copy> uv run python scripts/bl226_options_book.py calls \\
        --sweep <phase 2 out dir> --pick <id> [--pick ...] --out <dir>
"""

from __future__ import annotations

import argparse
import json
import math
from dataclasses import dataclass
from pathlib import Path

import duckdb
import numpy as np
import pandas as pd

CAPITAL = 1_000_000.0
EMPTY = pd.DataFrame(
    columns=[
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
)
LEARN_END = pd.Timestamp("2024-06-28")
CONFIRM_START = pd.Timestamp("2024-07-01")
MIN_SESSIONS_LEFT = 10
MIN_OI_LOTS = 10
SLIPPAGE = {"ATM": 0.01, "OTM1": 0.02, "OTM2": 0.03}
OFFSET = {"ATM": 0, "OTM1": 1, "OTM2": 2}
RATE = 0.065  # for the IV / delta read only
TAX = 0.30 * 1.04
BOOT_DRAWS, BOOT_BLOCK, SEED = 5000, 4, 20261115


def root() -> Path:
    from trading_data.db import data_root

    return data_root()


def fo_glob() -> str:
    return str(root() / "lake" / "eod" / "fo_bhavcopy" / "date=*" / "data.parquet")


# ---------------------------------------------------------------------------------------------
# Inputs
# ---------------------------------------------------------------------------------------------


def sessions() -> list[pd.Timestamp]:
    days = sorted(p.name[5:] for p in (root() / "lake" / "eod" / "fo_bhavcopy").glob("date=*"))
    return [pd.Timestamp(d) for d in days]


def rebalance_day(week: pd.Timestamp, all_sessions: list[pd.Timestamp]) -> pd.Timestamp | None:
    """The last F&O session on or before the week's label (a Friday), within that week."""
    i = np.searchsorted(np.array(all_sessions, dtype="datetime64[ns]"), week.to_datetime64(),
                        side="right") - 1  # fmt: skip
    if i < 0:
        return None
    d = all_sessions[i]
    return d if (week - d).days < 7 else None


def holdings(sweep: Path, pick: str) -> list[pd.DataFrame]:
    """One week x name weight frame per sleeve of the candidate."""
    out = []
    for path in sorted(sweep.glob(f"weights-{pick}-m*.csv")):
        w = pd.read_csv(path, index_col=0, parse_dates=True)
        out.append(w)
    if not out:
        raise FileNotFoundError(f"no weights for {pick} in {sweep}: run the sweep's confirm first")
    return out


def stock_equity(sweep: Path, pick: str) -> pd.Series:
    s = pd.read_csv(sweep / f"equity-full-{pick}.csv", index_col=0, parse_dates=True)["equity"]
    return s


def spot_closes(days: list[pd.Timestamp]) -> pd.DataFrame:
    """date x symbol unadjusted cash closes (EQ series first) on the given days."""
    from momentum_backtesting.db_read import stock_bars

    day_list = ",".join(f"DATE '{d.date()}'" for d in days)
    with stock_bars() as con:
        df = con.execute(
            f"""SELECT b.date, i.symbol, b.close, b.series
                FROM bars_1d_stock b JOIN instruments i USING (instrument_id)
                WHERE b.date IN ({day_list})"""
        ).df()
    df["rank"] = (df["series"] != "EQ").astype(int)
    df = df.sort_values("rank").drop_duplicates(["date", "symbol"])
    df["date"] = pd.to_datetime(df["date"])
    return df.pivot(index="date", columns="symbol", values="close")


def option_rows(days: list[pd.Timestamp], symbols: set[str] | None) -> pd.DataFrame:
    day_list = ",".join(f"DATE '{d.date()}'" for d in days)
    sym = ""
    if symbols is not None:
        sym = " AND symbol IN (" + ",".join("'" + s.replace("'", "''") + "'" for s in symbols) + ")"
    con = duckdb.connect()
    df = con.execute(
        f"""SELECT date, symbol, expiry, strike, option_type, close, settle, contracts, oi
            FROM read_parquet('{fo_glob()}')
            WHERE instrument = 'OPTSTK' AND date IN ({day_list}){sym}"""
    ).df()
    for c in ("date", "expiry"):
        df[c] = pd.to_datetime(df[c])
    return df


def lot_sizes() -> pd.DataFrame:
    p = root() / "lake" / "eod" / "fno_universe" / "lots.parquet"
    df = pd.read_parquet(p, columns=["date", "symbol", "expiry", "lot_size"])
    for c in ("date", "expiry"):
        df[c] = pd.to_datetime(df[c])
    return df.set_index(["date", "symbol", "expiry"])["lot_size"]


# ---------------------------------------------------------------------------------------------
# Pricing helpers
# ---------------------------------------------------------------------------------------------


def _norm_cdf(x):
    return 0.5 * (1 + np.vectorize(math.erf)(x / math.sqrt(2)))


def bs_price(s, k, t, vol, call=True):
    s, k, t, vol = map(np.asarray, (s, k, t, vol))
    d1 = (np.log(s / k) + (RATE + 0.5 * vol**2) * t) / (vol * np.sqrt(t))
    d2 = d1 - vol * np.sqrt(t)
    if call:
        return s * _norm_cdf(d1) - k * np.exp(-RATE * t) * _norm_cdf(d2)
    return k * np.exp(-RATE * t) * _norm_cdf(-d2) - s * _norm_cdf(-d1)


def implied_vol(price, s, k, t, call=True):
    lo, hi = np.full(np.shape(price), 0.01), np.full(np.shape(price), 3.0)
    for _ in range(40):
        mid = (lo + hi) / 2
        too_high = bs_price(s, k, t, mid, call) > price
        hi = np.where(too_high, mid, hi)
        lo = np.where(too_high, lo, mid)
    return (lo + hi) / 2


def delta(s, k, t, vol, call=True):
    d1 = (np.log(s / k) + (RATE + 0.5 * vol**2) * t) / (vol * np.sqrt(t))
    return _norm_cdf(d1) if call else _norm_cdf(d1) - 1


# ---------------------------------------------------------------------------------------------
# The book
# ---------------------------------------------------------------------------------------------


def costs(premium_value_buy: float, premium_value_sell: float, day: pd.Timestamp) -> float:
    after = day >= pd.Timestamp("2024-10-01")
    stt = premium_value_sell * (0.001 if after else 0.000625)
    txn = (premium_value_buy + premium_value_sell) * (0.0003503 if after else 0.00053)
    sebi = (premium_value_buy + premium_value_sell) * 1e-6
    stamp = premium_value_buy * 0.00003
    brokerage = 40.0
    return brokerage + stt + txn + sebi + stamp + 0.18 * (brokerage + txn + sebi)


@dataclass
class Chain:
    rows: pd.DataFrame  # one day's option rows for the symbols needed
    lots: pd.Series

    def pick_expiry(self, symbol: str, day: pd.Timestamp, all_sessions) -> pd.Timestamp | None:
        exps = sorted(self.rows.loc[self.rows["symbol"] == symbol, "expiry"].unique())
        arr = np.array(all_sessions, dtype="datetime64[ns]")
        for e in exps:
            left = np.searchsorted(arr, np.datetime64(e), side="right") - np.searchsorted(
                arr, np.datetime64(day), side="right"
            )
            if left >= MIN_SESSIONS_LEFT:
                return pd.Timestamp(e)
        return None


def run_book(
    picks_by_day: dict[pd.Timestamp, list[str]],
    budget_per_stock: float,
    moneyness: str,
    right: str,
    all_sessions: list[pd.Timestamp],
    chains: dict[pd.Timestamp, pd.DataFrame],
    spots: pd.DataFrame,
    lots: pd.Series,
    slip_mult: float = 1.0,
    iv_cap: dict | None = None,
) -> tuple[pd.DataFrame, dict]:
    """One row per trade (entry day, symbol, contract, prices, lots, P&L before tax)."""
    days = sorted(picks_by_day)
    trades = []
    counts = dict.fromkeys(("settle_entry", "settle_exit", "no_contract", "thin", "too_dear",
                            "no_spot", "no_exit_row", "iv_skipped"), 0)  # fmt: skip
    slip = SLIPPAGE[moneyness] * slip_mult
    for d0, d1 in zip(days[:-1], days[1:], strict=True):
        rows0, rows1 = chains[d0], chains[d1]  # {symbol: that day's option rows}
        for sym in picks_by_day[d0]:
            spot = spots.at[d0, sym] if (sym in spots.columns and d0 in spots.index) else np.nan
            if spot != spot:
                counts["no_spot"] += 1
                continue
            chain = Chain(rows0.get(sym, EMPTY), lots)
            expiry = chain.pick_expiry(sym, d0, all_sessions)
            if expiry is None:
                counts["no_contract"] += 1
                continue
            side = chain.rows[
                (chain.rows["expiry"] == expiry) & (chain.rows["option_type"] == right)
            ]
            strikes = np.sort(side["strike"].unique())
            if len(strikes) == 0:
                counts["no_contract"] += 1
                continue
            atm_i = int(np.argmin(np.abs(strikes - spot)))
            i = atm_i + OFFSET[moneyness] * (1 if right == "CE" else -1)
            if not 0 <= i < len(strikes):
                counts["no_contract"] += 1
                continue
            k = strikes[i]
            row = side[side["strike"] == k].iloc[0]
            lot = lots.get((d0, sym, expiry))
            if lot is None or lot != lot or lot <= 0:
                counts["no_contract"] += 1
                continue
            if row["oi"] < MIN_OI_LOTS * lot:
                counts["thin"] += 1
                continue
            traded = row["contracts"] > 0
            p0 = row["close"] if traded else row["settle"]
            counts["settle_entry"] += 0 if traded else 1
            if not p0 or p0 <= 0:
                counts["no_contract"] += 1
                continue
            if iv_cap is not None:
                cap = iv_cap.get((d0, sym))
                if cap is not None and cap:
                    counts["iv_skipped"] += 1
                    continue
            one_lot = p0 * lot
            if one_lot > 2 * budget_per_stock:
                counts["too_dear"] += 1
                continue
            n_lots = max(1, round(budget_per_stock / one_lot))
            r1 = rows1.get(sym, EMPTY)
            ex = r1[(r1["expiry"] == expiry) & (r1["option_type"] == right) & (r1["strike"] == k)]
            if ex.empty:
                counts["no_exit_row"] += 1
                p1, exit_traded = 0.0, False  # treated as worthless: the harshest reading
            else:
                e = ex.iloc[0]
                exit_traded = e["contracts"] > 0
                p1 = e["close"] if exit_traded else e["settle"]
                counts["settle_exit"] += 0 if exit_traded else 1
            qty = n_lots * lot
            buy = p0 * (1 + slip) * qty
            sell = max(p1 * (1 - slip), 0.0) * qty
            cost = costs(buy, sell, d1)
            t = max((expiry - d0).days, 1) / 365
            vol = float(implied_vol(np.array(p0), spot, k, t, right == "CE"))
            dlt = float(delta(spot, k, t, vol, right == "CE"))
            spot1 = spots.at[d1, sym] if (sym in spots.columns and d1 in spots.index) else np.nan
            trades.append({
                "entry": d0, "exit": d1, "symbol": sym, "expiry": expiry, "strike": k,
                "right": right, "spot": spot, "spot_exit": spot1, "lot": lot, "lots": n_lots,
                "p0": p0, "p1": p1, "entry_traded": traded, "exit_traded": exit_traded,
                "buy": buy, "sell": sell, "costs": cost, "pnl": sell - buy - cost,
                "iv": vol, "delta": dlt,
                "delta_stock_pnl": dlt * qty * (spot1 - spot) if spot1 == spot1 else 0.0,
            })  # fmt: skip
    return pd.DataFrame(trades), counts


def fy(d: pd.Timestamp) -> int:
    return d.year if d.month >= 4 else d.year - 1


def weekly_after_tax(trades: pd.DataFrame, weeks: list[pd.Timestamp]) -> pd.Series:
    """Rupee P&L per exit week after costs, with each financial year's tax taken at its last week
    (a loss carried forward)."""
    pnl = trades.groupby("exit")["pnl"].sum().reindex(weeks, fill_value=0.0)
    out = pnl.copy()
    carry = 0.0
    years = sorted({fy(d) for d in weeks})
    for y in years:
        in_year = [d for d in weeks if fy(d) == y]
        net = pnl.loc[in_year].sum() - carry
        if net > 0:
            out.loc[in_year[-1]] -= TAX * net
            carry = 0.0
        else:
            carry = -net
    return out


def max_dd(equity: pd.Series) -> float:
    return float((equity / equity.cummax() - 1).min())


def block_bootstrap_lb(diff: np.ndarray) -> tuple[float, float]:
    rng = np.random.default_rng(SEED)
    n = len(diff)
    if n < BOOT_BLOCK * 2:
        return math.nan, math.nan
    means = np.empty(BOOT_DRAWS)
    for i in range(BOOT_DRAWS):
        starts = rng.integers(0, n - BOOT_BLOCK + 1, size=math.ceil(n / BOOT_BLOCK))
        idx = (starts[:, None] + np.arange(BOOT_BLOCK)).ravel()[:n]
        means[i] = diff[idx].mean()
    return float(np.quantile(means, 0.05)), float(np.quantile(means, 0.95))


def score(
    trades: pd.DataFrame,
    base: pd.Series,
    weeks: list[pd.Timestamp],
    *,
    base_is_rupees: bool = False,
) -> dict:
    """The options book against a comparator on `weeks`: the stock book's equity (fraction) or,
    for Phase 4, another options book's weekly rupee P&L after tax (`base_is_rupees`)."""
    if not weeks:
        return {}
    opt_week = weekly_after_tax(trades, weeks) if len(trades) else pd.Series(0.0, index=weeks)
    opt_eq = pd.concat([pd.Series([CAPITAL]), CAPITAL + opt_week.cumsum()]).reset_index(drop=True)
    opt_ret = (opt_week / CAPITAL).to_numpy()
    if base_is_rupees:
        b = base.reindex(weeks, fill_value=0.0)
        base_ret = (b / CAPITAL).to_numpy()
        base_total = float(b.sum() / CAPITAL)
        base_dd = max_dd(
            pd.concat([pd.Series([CAPITAL]), CAPITAL + b.cumsum()]).reset_index(drop=True)
        )
    else:
        stock = base.reindex(pd.DatetimeIndex(weeks)).ffill()
        base_ret = stock.pct_change().fillna(0.0).to_numpy()
        base_total = float(stock.iloc[-1] / stock.iloc[0] - 1)
        base_dd = max_dd(stock)
    lo, hi = block_bootstrap_lb(opt_ret - base_ret)
    opt_total = float(opt_week.sum() / CAPITAL)
    opt_dd = max_dd(opt_eq)
    t = trades
    return {
        "weeks": len(weeks),
        "trades": len(t),
        "options_total_after_tax": round(opt_total, 4),
        "options_pnl_rs": round(float(opt_week.sum())),
        "options_mdd": round(opt_dd, 4),
        "base_total_after_tax": round(base_total, 4),
        "base_mdd": round(base_dd, 4),
        "weekly_diff_90": [round(lo, 5), round(hi, 5)],
        "win_rate": round(float((t["pnl"] > 0).mean()), 3) if len(t) else math.nan,
        "premium_per_week_rs": round(float(t.groupby("entry")["buy"].sum().mean()))
        if len(t)
        else 0,
        "costs_rs": round(float(t["costs"].sum())) if len(t) else 0,
        "pnl_before_tax_rs": round(float(t["pnl"].sum())) if len(t) else 0,
        "delta_stock_pnl_rs": round(float(t["delta_stock_pnl"].sum())) if len(t) else 0,
        "passes": bool(opt_total > base_total and opt_dd >= 1.5 * base_dd and lo > 0),
    }


def picks_from(sweep: Path, pick: str, all_sessions) -> tuple[list[dict], int]:
    """Per sleeve: {rebalance day: [symbols held]}; and the candidate's N."""
    held_n = json.loads((sweep / f"meta-{pick}.json").read_text())["held_n"]
    sleeves = []
    for w in holdings(sweep, pick):
        by_day = {}
        for week, row in w.iterrows():
            d = rebalance_day(pd.Timestamp(week), all_sessions)
            if d is None or d < pd.Timestamp("2020-01-01"):
                continue
            by_day[d] = [c.split("#", 1)[0] for c, v in row.items() if v > 0]
        sleeves.append(by_day)
    return sleeves, held_n


def bottom_from(sweep: Path, pick: str, n: int, all_sessions) -> dict:
    """{rebalance day: the n worst-ranked eligible stocks} from the candidate's ranks (sleeve 0;
    every sleeve shares the ranking). NaN = not eligible that week (outside the F&O list)."""
    r = pd.read_csv(sweep / f"ranks-{pick}-m0.csv", index_col=0, parse_dates=True)
    out = {}
    for week, row in r.iterrows():
        d = rebalance_day(pd.Timestamp(week), all_sessions)
        if d is None or d < pd.Timestamp("2020-01-01"):
            continue
        ranked = row.dropna()
        ranked = ranked[[("#" not in c or True) for c in ranked.index]]
        out[d] = [c.split("#", 1)[0] for c in ranked.sort_values().index[-n:]]
    return out


def stock_on_days(stock_eq: pd.Series, all_sessions) -> pd.Series:
    idx = [rebalance_day(pd.Timestamp(w), all_sessions) for w in stock_eq.index]
    s = pd.Series(stock_eq.to_numpy(), index=idx)
    return s[[i is not None for i in s.index]]


def nifty_closes() -> pd.Series:
    con = duckdb.connect()
    g = str(
        root() / "lake" / "bars_1m" / "asset=index" / "symbol=NIFTY" / "date=*" / "data.parquet"
    )
    df = con.execute(
        f"SELECT CAST(date AS VARCHAR) AS d, arg_max(close, ts) AS close "
        f"FROM read_parquet('{g}', hive_partitioning=1) GROUP BY 1 ORDER BY 1"
    ).df()
    return pd.Series(df["close"].to_numpy(), index=pd.to_datetime(df["d"]))


def iv_flags(rows: pd.DataFrame, spots: pd.DataFrame, all_sessions) -> dict:
    """(day, symbol) -> True when the stock's ATM call IV (the expiry the book would buy) is at or
    above the 80th percentile of its own previous 52 rebalance-day readings (26 needed)."""
    recs = []
    for (d, sym), g in rows[rows["option_type"] == "CE"].groupby(["date", "symbol"]):
        if sym not in spots.columns or d not in spots.index:
            continue
        spot = spots.at[d, sym]
        if spot != spot:
            continue
        e = Chain(g, pd.Series(dtype=float)).pick_expiry(sym, d, all_sessions)
        if e is None:
            continue
        side = g[g["expiry"] == e]
        k_i = int(np.argmin(np.abs(side["strike"].to_numpy() - spot)))
        row = side.iloc[k_i]
        p = row["close"] if row["contracts"] > 0 else row["settle"]
        if p and p > 0:
            recs.append((d, sym, p, spot, row["strike"], max((e - d).days, 1) / 365))
    if not recs:
        return {}
    df = pd.DataFrame(recs, columns=["d", "sym", "p", "s", "k", "t"])
    df["iv"] = implied_vol(df["p"].to_numpy(), df["s"].to_numpy(), df["k"].to_numpy(),
                           df["t"].to_numpy(), True)  # fmt: skip
    flags = {}
    for sym, g in df.sort_values("d").groupby("sym"):
        ivs = g["iv"].to_numpy()
        for j, d in enumerate(g["d"]):
            prior = ivs[max(0, j - 52) : j]
            flags[(d, sym)] = bool(len(prior) >= 26 and ivs[j] >= np.quantile(prior, 0.8))
    return flags


def load_inputs(sweep: Path, pick: str, all_sessions, extra_days=None, with_bottom=False):
    sleeves, n = picks_from(sweep, pick, all_sessions)
    bottom = bottom_from(sweep, pick, n[0], all_sessions) if with_bottom else {}
    days = sorted(set().union(*[s.keys() for s in sleeves]))
    symbols = set().union(*[set(x) for s in sleeves for x in s.values()])
    symbols |= set().union(*[set(v) for v in bottom.values()]) if bottom else set()
    rows = option_rows(days, symbols)
    chains: dict = {d: {} for d in days}
    for (d, sym), g in rows.groupby(["date", "symbol"]):
        chains.setdefault(d, {})[sym] = g
    spots = spot_closes(days)
    return sleeves, n, bottom, days, rows, chains, spots


def _book(sleeves, n, money, right, all_sessions, chains, spots, lots, slip=1.0, iv=None,
          share=1.0):  # fmt: skip
    k = len(sleeves)
    ns = n if isinstance(n, list) else [n] * k
    books = [run_book(s, CAPITAL * share / k / ni, money, right, all_sessions, chains, spots, lots,
                      slip, iv) for s, ni in zip(sleeves, ns, strict=True)]  # fmt: skip
    trades = pd.concat([b[0] for b in books], ignore_index=True)
    counts = {key: sum(b[1][key] for b in books) for key in books[0][1]}
    return trades, counts


def _split(trades, days, stock, confirm, *, base_is_rupees=False):
    learn_w = [d for d in days if d <= LEARN_END]
    conf_w = [d for d in days if d >= CONFIRM_START]
    tl = trades[trades["exit"] <= LEARN_END] if len(trades) else trades
    tc = trades[trades["entry"] >= CONFIRM_START] if len(trades) else trades
    return {
        "learning": score(tl, stock, learn_w, base_is_rupees=base_is_rupees),
        "confirmation": score(tc, stock, conf_w, base_is_rupees=base_is_rupees)
        if confirm
        else "locked",
    }


def calls(args: argparse.Namespace) -> None:
    sweep, out = Path(args.sweep), Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    all_sessions = sessions()
    lots = lot_sizes()
    results = {}
    for pick in args.pick:
        sleeves, n, _, days, rows, chains, spots = load_inputs(sweep, pick, all_sessions)
        stock = stock_on_days(stock_equity(sweep, pick), all_sessions)
        iv = iv_flags(rows, spots, all_sessions)
        for money in ("ATM", "OTM1", "OTM2"):
            for variant, slip, ivf in (("base", 1.0, None), ("slip2x", 2.0, None),
                                       ("ivcap", 1.0, iv)):  # fmt: skip
                trades, counts = _book(sleeves, n, money, "CE", all_sessions, chains, spots, lots,
                                       slip, ivf)  # fmt: skip
                tag = f"{pick}|{money}|{variant}"
                trades.to_csv(out / f"trades-{pick}-{money}-{variant}.csv", index=False)
                results[tag] = {"counts": counts, **_split(trades, days, stock, args.confirm)}
                print(tag, json.dumps(results[tag]["learning"]), flush=True)
    name = "calls_confirm.json" if args.confirm else "calls_learning.json"
    (out / name).write_text(json.dumps(results, indent=1, default=str))


def puts(args: argparse.Namespace) -> None:
    """Phase 4, for (candidate, moneyness) pairs that passed Phase 3: (a) the market gate and
    (b) long-short, each against that Phase 3 call book."""
    sweep, out = Path(args.sweep), Path(args.out)
    all_sessions = sessions()
    lots = lot_sizes()
    nifty = nifty_closes()
    sma = nifty.rolling(200).mean()
    results = {}
    for spec in args.pair:
        pick, money = spec.split("|")
        sleeves, n, bottom, days, rows, chains, spots = load_inputs(
            sweep, pick, all_sessions, with_bottom=True
        )
        base_trades, _ = _book(sleeves, n, money, "CE", all_sessions, chains, spots, lots)
        base_week = weekly_after_tax(base_trades, days)
        down = {d: bool(nifty.asof(d) < sma.asof(d)) for d in days}
        # (a) the gate: in a down week, the bottom N's puts instead of the holdings' calls
        put_days = {d: bottom.get(d, []) for d in days if down[d]}
        # every week's entry needs the next week's exit: keep all days in each book's calendar
        up_only = [{d: (v if not down[d] else []) for d, v in s.items()} for s in sleeves]
        calls_part, _ = _book(up_only, n, money, "CE", all_sessions, chains, spots, lots)
        put_part, _ = _book([{d: (put_days.get(d, [])) for d in days}], n, money, "PE",
                            all_sessions, chains, spots, lots)  # fmt: skip
        gate = pd.concat([calls_part, put_part], ignore_index=True)
        # (b) long-short: half budget each side, every week
        ls_calls, _ = _book(sleeves, n, money, "CE", all_sessions, chains, spots, lots, share=0.5)
        ls_puts, _ = _book([{d: bottom.get(d, []) for d in days}], n, money, "PE", all_sessions,
                           chains, spots, lots, share=0.5)  # fmt: skip
        longshort = pd.concat([ls_calls, ls_puts], ignore_index=True)
        for name, trades in (("gate", gate), ("longshort", longshort)):
            trades.to_csv(out / f"trades-{pick}-{money}-{name}.csv", index=False)
            results[f"{spec}|{name}"] = {
                "down_weeks": int(sum(down.values())),
                **_split(trades, days, base_week, args.confirm, base_is_rupees=True),
            }
            print(spec, name, json.dumps(results[f"{spec}|{name}"]["learning"]), flush=True)
    name = "puts_confirm.json" if args.confirm else "puts_learning.json"
    (out / name).write_text(json.dumps(results, indent=1, default=str))


def main() -> None:
    p = argparse.ArgumentParser()
    sub = p.add_subparsers(dest="cmd", required=True)
    for cmd in ("calls", "puts"):
        a = sub.add_parser(cmd)
        a.add_argument("--sweep", required=True)
        a.add_argument("--out", required=True)
        a.add_argument("--confirm", action="store_true", help="Also score the confirmation weeks.")
        if cmd == "calls":
            a.add_argument("--pick", action="append", required=True)
        else:
            a.add_argument("--pair", action="append", required=True, help="<pick>|<ATM|OTM1|OTM2>")
    args = p.parse_args()
    {"calls": calls, "puts": puts}[args.cmd](args)


if __name__ == "__main__":
    main()
