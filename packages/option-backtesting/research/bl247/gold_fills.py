"""BL-247 follow-up, descriptive: how live were the fills behind BL-218's gold pass?

The engine carries a contract's last price forward through minutes with no trade. This re-runs the
one passing cell (GOLDM Dir, expiry week, 18:00 ITM1 SL21 cost x1, to close; the BL-219 rule) and,
for each trade, asks how old the price was: at entry, the last trade before the entry minute; at
exit, the last trade before it (a stop: whether its bar traded). Both halves have been read by
BL-218; nothing here selects or changes a rule, and no BL-219 forward session is read.

    uv run python research/bl247/gold_fills.py
"""

from __future__ import annotations

import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent / "common"))

import grid  # noqa: E402
import mcx_charges  # noqa: E402
from mcx_sessions import schedule, season  # noqa: E402
from run import SIZING_DATE, _last_trades  # noqa: E402
from trading_data import quality  # noqa: E402

from option_backtesting.data.reference.loader import default_reference_data  # noqa: E402
from option_backtesting.fyers.daily import data_dir  # noqa: E402
from option_backtesting.legwise.engine import simulate_day  # noqa: E402
from option_backtesting.legwise.market import load_day  # noqa: E402

ROOT = "GOLDM"
CELL = {"strike": "ITM1", "sl": 21, "reentry": "cost1", "exit": "close"}
ENTRY = "18:00"
SESSION_START = 9 * 60


def age(minutes: list[int], at: int) -> int | None:
    """Minutes from the last trade before `at` to `at` (1 = the bar just before traded)."""
    before = [m for m in minutes if m < at]
    return at - max(before) if before else None


def main() -> None:
    root_dir = data_dir()
    ref = default_reference_data()
    excluded = quality.excluded_days(root_dir, "option", ROOT) or {}
    for half in ("fit", "test"):
        sessions = [
            s
            for s in schedule(root_dir, ROOT, grid.HALVES, grid.WEEKS)
            if s["half"] == half and s["week"] == "expiry" and s["day"] not in excluded
        ]
        trades, days = [], []
        for s in sessions:
            day = s["day"]
            try:
                data = load_day(root_dir, ROOT, day)
            except FileNotFoundError:
                continue
            strategy = grid.build("dir", CELL, ENTRY, ROOT, season(root_dir, ROOT, day))
            result = simulate_day(strategy, data, ref, sizing_date=SIZING_DATE)
            traded = _last_trades(root_dir, ROOT, day)
            rows = []
            for t in result.trades:
                minutes = traded.get(t.contract, [])
                entry_at = SESSION_START + t.entry_min
                exit_at = SESSION_START + t.exit_min
                stop = t.exit_reason == "SL"
                rows.append(
                    {
                        "net": t.pnl - mcx_charges.trade_charges(t),
                        "entry_age": age(minutes, entry_at),
                        # a stop reads its own bar; any other exit the bars before it
                        "exit_age": age(minutes, exit_at + 1 if stop else exit_at),
                        "reason": t.exit_reason,
                        "reentry": t.entry_min != result.trades[0].entry_min,
                        "day_lots": len(minutes),
                    }
                )
            total = result.gross - sum(mcx_charges.trade_charges(t) for t in result.trades)
            days.append((day, total, rows))
            trades += rows

        net = sum(d[1] for d in days)
        print(f"\n{half}: {len(days)} sessions, {len(trades)} trades, net Rs {net:,.0f}")

        def stale(r: dict, key: str, limit: int) -> bool:
            return r[key] is None or r[key] > limit

        for key, label in (("entry_age", "entry"), ("exit_age", "exit")):
            for limit in (5, 15, 60):
                share = sum(stale(r, key, limit) for r in trades) / len(trades)
                print(f"  {label} price older than {limit:>2} min: {share:5.1%} of trades")
        for limit in (5, 15):

            def live(r: dict, limit: int = limit) -> bool:
                return not stale(r, "entry_age", limit) and not stale(r, "exit_age", limit)

            good = [r for r in trades if live(r)]
            bad = [r for r in trades if not live(r)]
            print(
                f"  within {limit:>2} min at both ends: {len(good):3} trades, Rs"
                f" {sum(r['net'] for r in good):>9,.0f} | otherwise: {len(bad):3} trades, Rs"
                f" {sum(r['net'] for r in bad):>9,.0f}"
            )
            clean = [d for d in days if d[2] and all(live(r) for r in d[2])]
            print(
                f"    sessions with every trade live: {len(clean)} of {len(days)}, Rs"
                f" {sum(d[1] for d in clean):,.0f}"
            )
        ages = sorted(r["entry_age"] if r["entry_age"] is not None else 10_000 for r in trades)
        print(f"  median entry price age {ages[len(ages) // 2]} min")


if __name__ == "__main__":
    main()
