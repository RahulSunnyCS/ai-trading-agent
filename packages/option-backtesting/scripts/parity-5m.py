#!/usr/bin/env python3
"""BL-034 Phase 3 check: run the same leg-wise strategies on 1-minute bars and on the 5-minute
chain snapshots over a window, and report how far the two agree and how long each took.

    uv run python scripts/parity-5m.py --underlying NIFTY --from 2025-06-02 --to 2025-06-30

Strategies (every time on a 5-minute mark): a time-based ATM straddle sell 09:20 -> 15:15; the
same with a 30% leg stop, one as-soon-as-possible re-entry and a combined stop of 4,000.
Needs `tdata derived rebuild` for the window first.
"""

from __future__ import annotations

import argparse
import time
from datetime import date

from option_backtesting.fyers.daily import data_dir
from option_backtesting.legwise.engine import run_legwise
from option_backtesting.legwise.schema import LegwiseStrategy


def straddle(underlying: str, sid: str, **extra) -> LegwiseStrategy:
    leg_extra = extra.pop("leg", {})
    legs = [
        {"id": k.lower(), "lots": 1, "position": "sell", "option_type": k,
         "strike": {"strike_type": "ATM"}, **leg_extra}
        for k in ("CE", "PE")
    ]  # fmt: skip
    return LegwiseStrategy.model_validate(
        {"id": sid, "underlying": underlying, "entry_time": "09:20", "exit_time": "15:15",
         "legs": legs, **extra}
    )  # fmt: skip


def key(t) -> tuple:
    return (t.leg_id, t.contract, t.qty, t.entry_min, t.exit_min, t.exit_reason)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--underlying", default="NIFTY")
    ap.add_argument("--from", dest="start", required=True)
    ap.add_argument("--to", dest="end", required=True)
    a = ap.parse_args()
    root, start, end = data_dir(), date.fromisoformat(a.start), date.fromisoformat(a.end)
    specs = [
        straddle(a.underlying, "time-based"),
        straddle(
            a.underlying,
            "stop+adjust",
            leg={"stop_loss": {"percent": 30}, "reentry_on_sl": {"mode": "asap", "count": 1}},
            overall={"stop_loss_inr": 4000},
        ),
    ]
    print(f"{a.underlying} {start} .. {end}")
    print("strategy       days  same-trades  exits-within-5m  |gross diff| sum  1m s   5m s")
    for spec in specs:
        t0 = time.monotonic()
        one = run_legwise(spec, root, start, end, bars="1m")
        t1 = time.monotonic()
        five = run_legwise(spec, root, start, end, bars="5m")
        t2 = time.monotonic()
        by_day = {r.day: r for r in five}
        same = same_exit = 0
        diff = 0.0
        common = [r for r in one if r.day in by_day]
        def full(trades) -> list[tuple]:
            return [key(t) + (round(t.entry_price, 2), round(t.exit_price or 0, 2)) for t in trades]

        for r in common:
            f = by_day[r.day]
            if full(r.trades) == full(f.trades):
                same += 1
            # same legs and contracts, each 5-minute exit within 5 minutes of the 1-minute one
            if [(t.leg_id, t.contract) for t in r.trades] == [
                (t.leg_id, t.contract) for t in f.trades
            ] and all(
                abs((a_.exit_min or 0) - (b_.exit_min or 0)) <= 5
                for a_, b_ in zip(r.trades, f.trades, strict=True)
            ):
                same_exit += 1
            diff += abs(r.gross - f.gross)
        print(
            f"{spec.id:<14} {len(common):>4}  {same:>11}  {same_exit:>17}  {diff:>16,.0f}"
            f"  {t1 - t0:>5.1f}  {t2 - t1:>5.1f}"
        )
        print(
            f"{'':<14} gross 1m {sum(r.gross for r in common):>12,.0f}"
            f"   5m {sum(by_day[r.day].gross for r in common):>12,.0f}"
        )


if __name__ == "__main__":
    main()
