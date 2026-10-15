"""BL-105: prove the replay equals the engine.

For a sample of days, the engine run with `overall.target_inr = T` (exact) is compared with the
base run cut at the first minute its MTM reaches T (`cut_at`, the replay used for lock / trail).
Gross, trade count and charged net must agree to the paisa. Also checks that a restart chain's
first part is the engine's target run and that its second part starts at the next minute.

    python research/bl105/check_replay.py --index N --slot 09:17 --days 30
"""

from __future__ import annotations

import argparse
import sys
from datetime import date
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent / "bl104"))
import bl105_grid as g  # noqa: E402
import screen_lib as lib  # noqa: E402
from run_grid import trade_charges  # noqa: E402

from option_backtesting.data.reference.loader import default_reference_data  # noqa: E402
from option_backtesting.fyers.daily import data_dir  # noqa: E402
from option_backtesting.legwise.engine import simulate_day  # noqa: E402
from option_backtesting.legwise.market import backtest_days, load_day  # noqa: E402
from option_backtesting.rotation.lists import SIZING_DATE  # noqa: E402


def net(result, underlying: str) -> float:
    return result.gross - sum(trade_charges(underlying, result.day, t)[0] for t in result.trades)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--index", default="N")
    ap.add_argument("--slot", default="09:17")
    ap.add_argument("--strike", default="ITM1")
    ap.add_argument("--days", type=int, default=40)
    ap.add_argument("--from", dest="start", default="2025-06-01")
    args = ap.parse_args()
    underlying = g.INDICES[args.index]
    ref = default_reference_data()
    sizing = date.fromisoformat(SIZING_DATE)
    base = g.build_base(args.index, args.slot, args.strike, (10, 5))
    days, _ = backtest_days(data_dir(), underlying, date.fromisoformat(args.start), None)
    days = [d for d in days if d.weekday() < 5][: args.days]
    checked = mismatched = fired = restarted = 0
    for day in days:
        data = load_day(data_dir(), underlying, day)
        base_res = simulate_day(base, data, ref, sizing)
        for level in g.LEVELS:
            eng = simulate_day(lib.with_target(base, level), data, ref, sizing)
            minute = next((m for m, v in base_res.mtm if v >= level), None)
            replay = base_res if minute is None else lib.cut_at(base_res, data, minute, "t")
            checked += 1
            fired += eng.stopped_by is not None and eng.stopped_by.startswith("overall target")
            same = (
                abs(eng.gross - replay.gross) < 0.005
                and len(eng.trades) == len(replay.trades)
                and abs(net(eng, underlying) - net(replay, underlying)) < 0.005
            )
            if not same:
                mismatched += 1
                print(
                    f"MISMATCH {day} T={level}: engine {eng.gross:.2f}/{len(eng.trades)} "
                    f"{eng.stopped_by}  replay {replay.gross:.2f}/{len(replay.trades)} {replay.stopped_by}"
                )
        # restart: part 1 is the engine's target run, part 2 starts the minute after the cut
        t1 = lib.with_target(base, 3000)
        first_res = simulate_day(t1, data, ref, sizing)
        cut = lib.target_cut_minute(first_res)
        if cut is not None and cut + 1 < 14 * 60 - 9 * 60 - 15:
            second = simulate_day(
                lib.with_target(lib.with_entry(base, lib.minute_label(cut + 1)), 3000),
                data,
                ref,
                sizing,
            )
            restarted += 1
            starts = min((t.entry_min for t in second.trades), default=None)
            if starts is not None and starts < cut + 1:
                mismatched += 1
                print(f"RESTART ENTERS EARLY {day}: cut {cut}, first entry {starts}")
    print(
        f"{args.index} {args.slot} {args.strike}: {len(days)} days, {checked} target checks "
        f"({fired} fired), {restarted} restarts tested, {mismatched} mismatches"
    )
    sys.exit(1 if mismatched else 0)


if __name__ == "__main__":
    main()
