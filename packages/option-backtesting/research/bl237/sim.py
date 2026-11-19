"""BL-237: the expiry-eve straddle pair, simulated over two sessions.

Pre-registered in backlog/BL-237-expiry-eve-straddle-pair.md (Phase 0). On the last session D before an index's weekly
expiry E: sell that index's ATM straddle at 15:30 and buy the other index's ATM straddle, both closed at 09:17 on E
(amendment 1: the owner moved the exit from 09:20 to 09:17 before any run).
1 lot per leg at today's lot, 8 orders at 20 x 1.18, 0.5% adverse slippage on every fill.

The price at T follows the engine's convention (`Series.price_at`): the close of the bar that ends at T, carried
forward from the last real bar of the day; at 09:15 with no earlier bar the open. Everything read here is one day's
own file; nothing is written outside `results/` beside this file (git-ignored).

    uv run python research/bl237/sim.py check     # three hand-checked trades, raw bars printed
    uv run python research/bl237/sim.py run       # every eve and the non-eve placebo -> results/
"""

from __future__ import annotations

import csv
import sys
from datetime import date, timedelta
from pathlib import Path

import pyarrow as pa
import pyarrow.compute as pc
import pyarrow.parquet as pq
from option_backtesting.data.providers.base import Right
from option_backtesting.data.reference.loader import ReferenceData
from option_backtesting.data.resolver import resolve_strike
from option_backtesting.legwise import market
from trading_data import db, lake, quality

HERE = Path(__file__).resolve().parent
RESULTS = HERE / "results"

INDEXES = ("NIFTY", "SENSEX")
START = date(2024, 10, 9)
FIT_END = date(2025, 10, 8)
SIZING = date(2026, 10, 12)
SLIP = 0.005
COST_PER_ORDER = 20.0 * 1.18
ENTRY_MIN = market.minute_index("15:30")  # 375: price_at reads the close of the 15:29 bar
EXIT_MIN = market.minute_index("09:17")  # 2: price_at reads the close of the 09:16 bar (amendment 1)
STALE_ENTRY_MIN = market.minute_index("15:20")  # a last real bar before 15:20 is counted as stale


class Day:
    """One index's day: spot series, the symbol master's expiries, and the option rows on demand."""

    def __init__(self, root: Path, underlying: str, day: date):
        self.underlying, self.day = underlying, day
        self.spot = market._load_bars(lake.bars_1m_path(root, "index", underlying, day))
        path = lake.bars_1m_path(root, "option", underlying, day)
        self.table = (
            pq.read_table(path, columns=["ts", "expiry", "strike", "option_type", "open", "close"])
            if path.exists()
            else None
        )
        self.listed = market.listed_expiries(root, underlying, day) or []
        self._bars: dict[tuple, dict[int, tuple[float, float]]] = {}

    def nearest_expiry(self) -> date | None:
        upcoming = [e for e in self.listed if e >= self.day]
        return upcoming[0] if upcoming else None

    def bars(self, key: tuple[date, float, str]) -> dict[int, tuple[float, float]]:
        """minute index -> (open, close) of the contract's real bars that day."""
        if key not in self._bars:
            out: dict[int, tuple[float, float]] = {}
            if self.table is not None:
                expiry, strike, side = key
                mask = pc.and_(
                    pc.and_(
                        pc.equal(self.table["expiry"], pa.scalar(expiry, pa.date32())),
                        pc.equal(self.table["strike"], pa.scalar(float(strike))),
                    ),
                    pc.equal(self.table["option_type"], pa.scalar(side)),
                )
                sub = self.table.filter(mask)
                if sub.num_rows:
                    minutes = market._minutes(sub)
                    opens, closes = sub["open"].to_pylist(), sub["close"].to_pylist()
                    for m, o, c in zip(minutes, opens, closes, strict=True):
                        out[m] = (o, c)
            self._bars[key] = out
        return self._bars[key]

    def price_at(self, key: tuple[date, float, str], minute: int) -> tuple[float | None, int | None]:
        """(price, minute of the real bar it came from) by `Series.price_at`'s rule."""
        bars = self.bars(key)
        before = [m for m in bars if m <= minute - 1]
        if minute > 0 and before:
            m = max(before)
            return bars[m][1], m
        if minute in bars:
            return bars[minute][0], minute
        return None, None


class Days:
    """A small cache of loaded days (the sweep walks forward, so the next D is this E)."""

    def __init__(self, root: Path, size: int = 6):
        self.root, self.size, self._d, self._order = root, size, {}, []

    def get(self, underlying: str, day: date) -> Day:
        k = (underlying, day)
        if k not in self._d:
            self._d[k] = Day(self.root, underlying, day)
            self._order.append(k)
            if len(self._order) > self.size:
                self._d.pop(self._order.pop(0), None)
        return self._d[k]


def straddle_keys(d: Day, expiry: date, ref: ReferenceData) -> tuple[float, dict[str, tuple]] | str:
    spot = d.spot.price_at(ENTRY_MIN) if d.spot is not None else None
    if spot is None:
        return "no index price at 15:30"
    strike = resolve_strike(
        d.underlying, "ATM", Right.CE, spot, as_of=d.day, reference=ref
    ).strike
    return spot, {"CE": (expiry, float(strike), "CE"), "PE": (expiry, float(strike), "PE")}


def trade(
    days: Days, ref: ReferenceData, eve: date, exp: date, sold: str, bought: str
) -> dict | str:
    """One pair; a string is the reason it could not be built."""
    ds, db_ = days.get(sold, eve), days.get(bought, eve)
    xs, xb = days.get(sold, exp), days.get(bought, exp)
    es, eb = ds.nearest_expiry(), db_.nearest_expiry()
    if es is None or eb is None:
        return "no listed expiry"
    out: dict = {"eve": eve, "expiry_day": exp, "sold": sold, "bought": bought,
                 "sold_expiry": es, "bought_expiry": eb}
    legs = []
    for role, d_in, d_out, e in (("sold", ds, xs, es), ("bought", db_, xb, eb)):
        sk = straddle_keys(d_in, e, ref)
        if isinstance(sk, str):
            return f"{role}: {sk}"
        spot, keys = sk
        out[f"{role}_spot"] = spot
        out[f"{role}_strike"] = keys["CE"][1]
        lot = ref.lot_size(d_in.underlying, SIZING)
        out[f"{role}_lot"] = lot
        for side, key in keys.items():
            p_in, m_in = d_in.price_at(key, ENTRY_MIN)
            p_out, m_out = d_out.price_at(key, EXIT_MIN)
            if p_in is None:
                return f"{role} {side}: contract not in the eve's file"
            if p_out is None:
                return f"{role} {side}: no price at 09:17 on the expiry day"
            out[f"{role}_{side}_in"], out[f"{role}_{side}_out"] = p_in, p_out
            out[f"{role}_{side}_stale"] = int(m_in is not None and m_in < STALE_ENTRY_MIN)
            legs.append((role, lot, p_in, p_out))
    spot_out = xs.spot.price_at(EXIT_MIN) if xs.spot is not None else None
    out["sold_gap_pct"] = (
        (spot_out - out["sold_spot"]) / out["sold_spot"] * 100 if spot_out else None
    )
    for slip_tag, slip in (("g", 0.0), ("s", SLIP)):
        parts = {"sold": 0.0, "bought": 0.0}
        for role, lot, p_in, p_out in legs:
            if role == "sold":  # sell at the entry, buy back at the exit
                parts[role] += ((p_in * (1 - slip)) - (p_out * (1 + slip))) * lot
            else:  # buy at the entry, sell at the exit
                parts[role] += ((p_out * (1 - slip)) - (p_in * (1 + slip))) * lot
        out[f"sold_{slip_tag}"], out[f"bought_{slip_tag}"] = parts["sold"], parts["bought"]
        out[f"pair_{slip_tag}"] = parts["sold"] + parts["bought"]
    out["charges"] = 8 * COST_PER_ORDER
    out["pair_net"] = out["pair_s"] - out["charges"]
    out["pair_net_noslip"] = out["pair_g"] - out["charges"]
    out["sold_net"] = out["sold_s"] - 4 * COST_PER_ORDER
    out["bought_net"] = out["bought_s"] - 4 * COST_PER_ORDER
    out["stale_legs"] = sum(out[f"{r}_{s}_stale"] for r in ("sold", "bought") for s in ("CE", "PE"))
    return out


def next_trading_day(ref: ReferenceData, d: date) -> date:
    d += timedelta(days=1)
    while not ref.is_trading_day(d):
        d += timedelta(days=1)
    return d


def run_all(root: Path, ref: ReferenceData, last: date | None = None):
    avail = {u: set(market.available_days(root, u)) for u in INDEXES}
    excluded = {u: (quality.excluded_days(root, "option", u) or {}) for u in INDEXES}
    common = sorted(d for d in avail["NIFTY"] & avail["SENSEX"] if d >= START)
    if last:
        common = [d for d in common if d <= last]
    days = Days(root)
    trades, skipped = [], []
    for i, eve in enumerate(common):
        exp_day = next_trading_day(ref, eve)
        if exp_day not in avail["NIFTY"] or exp_day not in avail["SENSEX"]:
            if i + 1 < len(common) or exp_day <= (last or date.max):
                if exp_day <= common[-1]:
                    skipped.append((eve, "", "next session has no bars for both indexes"))
            continue
        bad = [
            f"{u} {d} {excluded[u][d]}"
            for u in INDEXES for d in (eve, exp_day) if d in excluded[u]
        ]
        if bad:
            skipped.append((eve, "", "data_quality: " + "; ".join(bad)))
            continue
        for sold, bought in (("NIFTY", "SENSEX"), ("SENSEX", "NIFTY")):
            nxt = days.get(sold, eve).nearest_expiry()
            kind = "eve" if nxt == exp_day else ("placebo" if nxt and nxt > exp_day else None)
            if kind is None:  # the sold index expires today: neither
                continue
            res = trade(days, ref, eve, exp_day, sold, bought)
            if isinstance(res, str):
                skipped.append((eve, f"{sold}/{kind}", res))
            else:
                res["kind"] = kind
                res["window"] = "fit" if eve <= FIT_END else "test"
                trades.append(res)
    return trades, skipped


def write(trades, skipped):
    RESULTS.mkdir(exist_ok=True)
    if trades:
        cols = list(trades[0])
        with open(RESULTS / "trades.csv", "w", newline="") as f:
            w = csv.DictWriter(f, fieldnames=cols)
            w.writeheader()
            w.writerows(trades)
    with open(RESULTS / "skipped.csv", "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["eve", "stream", "reason"])
        w.writerows(skipped)


def check(root: Path, ref: ReferenceData):
    """Three hand-checked trades: raw bars printed, then the arithmetic done again longhand. Not scored."""
    trades, skipped = run_all(root, ref)
    write(trades, skipped)  # the one pass: the check prints three trades only, nothing is aggregated here
    eves = [t for t in trades if t["kind"] == "eve"]
    picks = [eves[0], eves[len(eves) // 2], eves[-1]]
    days = Days(root)
    for t in picks:
        print(f"\n=== {t['sold']} eve {t['eve']} -> expiry day {t['expiry_day']}")
        for role, u in (("sold", t["sold"]), ("bought", t["bought"])):
            din, dout = days.get(u, t["eve"]), days.get(u, t["expiry_day"])
            e, k = t[f"{role}_expiry"], t[f"{role}_strike"]
            print(f"  {role} {u}: spot at 15:30 {t[f'{role}_spot']}, ATM {k:g}, expiry {e}, lot {t[f'{role}_lot']}")
            for side in ("CE", "PE"):
                key = (e, k, side)
                bi, bo = din.bars(key), dout.bars(key)
                last_in = sorted(m for m in bi if m <= 374)[-3:]
                first_out = sorted(m for m in bo if m <= 3)[:4]
                print(f"    {side} eve bars (min idx: open/close) "
                      + ", ".join(f"{market.minute_label(m)}:{bi[m][0]}/{bi[m][1]}" for m in last_in))
                print(f"    {side} expiry-day bars "
                      + ", ".join(f"{market.minute_label(m)}:{bo[m][0]}/{bo[m][1]}" for m in first_out))
                print(f"    {side} used: in {t[f'{role}_{side}_in']}  out {t[f'{role}_{side}_out']}")
        s_pnl = sum((t[f"sold_{s}_in"] - t[f"sold_{s}_out"]) * t["sold_lot"] for s in ("CE", "PE"))
        b_pnl = sum((t[f"bought_{s}_out"] - t[f"bought_{s}_in"]) * t["bought_lot"] for s in ("CE", "PE"))
        print(f"  longhand gross: sold {s_pnl:.2f}, bought {b_pnl:.2f}, pair {s_pnl + b_pnl:.2f}; "
              f"code gross {t['pair_g']:.2f}; net after slippage and 8 orders {t['pair_net']:.2f}")
        assert abs(s_pnl + b_pnl - t["pair_g"]) < 1e-6


if __name__ == "__main__":
    root = db.data_root()
    ref = ReferenceData()
    mode = sys.argv[1] if len(sys.argv) > 1 else "check"
    if mode == "check":
        check(root, ref)
    else:
        trades, skipped = run_all(root, ref)
        write(trades, skipped)
        print(f"{len(trades)} trades, {len(skipped)} skipped -> {RESULTS}")
