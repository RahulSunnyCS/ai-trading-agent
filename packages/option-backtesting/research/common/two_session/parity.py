"""BL-185 Phase 1 parity gates: overlays on a recorded path equal full engine runs with the same
settings (gross to the rupee), and charges reconstructed from the recorded trades equal the full
run's (within Rs 10: a trade still open at the overlay exit is valued at its entry, which moves the exchange fee and stamp by a few rupees). Locks have no engine field; they are defined by portfolio.apply_book, which
the overlay reproduces (checked here against apply_book directly).

    uv run python research/common/two_session/parity.py [--days 100]
"""

from __future__ import annotations

import sys
from datetime import date
from pathlib import Path

HERE = Path(__file__).parent
sys.path.insert(0, str(HERE.parent))
sys.path.insert(0, str(HERE))
import grid  # noqa: E402
import overlay  # noqa: E402
from early_ref import early_reference  # noqa: E402
from paths import events_of, path_of  # noqa: E402

from option_backtesting.fyers.daily import data_dir  # noqa: E402
from option_backtesting.legwise.engine import simulate_day  # noqa: E402
from option_backtesting.legwise.market import backtest_days, load_day, minute_index  # noqa: E402
from option_backtesting.legwise.schema import LegwiseStrategy  # noqa: E402
from option_backtesting.rotation.portfolio import (  # noqa: E402
    apply_book,
    member_from_curve,
    parse_trail,
)
from option_backtesting.ruletest.charges import day_charges, trade_values  # noqa: E402

SIZING = date(2026, 10, 12)
CASES = [  # (cohort, cell index, slot)
    ("W", 3 * 36 + 2 * 6 + 1 * 2 + 0, "0917"),  # ATM, SL 80, trail 15/10, no RE
    ("W", 4 * 36 + 4 * 6 + 0 * 2 + 1, "1017"),  # OTM1, SL 120, no trail, RE cost x1
    ("W", 8 * 36 + 1 * 6 + 2 * 2 + 1, "1302"),  # PMID, SL 60, trail 25/15, RE
    ("D", 3 * 36 + 2 * 6 + 0 * 3 + 1, "0917"),  # ATM, SL 20, no trail, RE cost x1
    ("D", 2 * 36 + 3 * 6 + 1 * 3 + 2, "0947"),  # ITM1, SL 25, trail 10/5, RE cost x2
    ("D", 7 * 36 + 0 * 6 + 0 * 3 + 0, "1332"),  # PLOW, SL 10, none, none
]
SETTINGS = [  # overlays to check against the engine: (exit, stop, target)
    ("12:00", None, None), ("13:00", None, None), ("15:28", 1000.0, None), ("15:28", 2500.0, None),
    ("12:00", 2000.0, None), ("15:28", None, 1500.0), ("13:00", 3000.0, 2000.0),
]  # fmt: skip


def main() -> None:
    n_days = int(sys.argv[sys.argv.index("--days") + 1]) if "--days" in sys.argv else 100
    root = data_dir()
    ref = early_reference()
    checked = gross_bad = charge_bad = lock_checked = lock_bad = 0
    worst_charge = 0.0
    for u in ("NIFTY", "SENSEX"):
        days, _ = backtest_days(root, u, date(2025, 3, 1), date(2026, 10, 27))
        days = days[:n_days]
        for co, k, slot in CASES:
            cell = grid.cells(co)[k]
            entry = f"{slot[:2]}:{slot[2:]}"
            base = LegwiseStrategy.model_validate(cell.strategy(u, slot))
            variants = {}
            for exit_, stop, target in SETTINGS:
                if minute_index(exit_) <= minute_index(entry):
                    continue
                s = cell.strategy(u, slot)
                s["exit_time"] = exit_
                s["overall"] = {
                    k2: v for k2, v in (("stop_loss_inr", stop), ("target_inr", target)) if v
                }
                variants[(exit_, stop, target)] = LegwiseStrategy.model_validate(s)
            for d in days:
                try:
                    data = load_day(root, u, d)
                except FileNotFoundError:
                    continue
                r0 = simulate_day(base, data, ref, SIZING)
                path, ev = path_of(r0), events_of(r0)
                for key, strat in variants.items():
                    exit_, stop, target = key
                    r = simulate_day(strat, data, ref, SIZING)
                    g, end, _ = overlay.apply(path, entry, exit_, stop=stop, target=target)
                    orders, buy, sell = trade_values(r.trades)
                    ch_engine = day_charges(u, d.isoformat(), orders, buy, sell).total
                    ch_overlay, _ = overlay.charges_at(ev, end, u, d.isoformat())
                    checked += 1
                    if abs(g - r.gross) > 1.0:
                        gross_bad += 1
                        if gross_bad <= 5:
                            print(
                                f"  gross mismatch {u} {cell.cid} {slot} {d} {key}: overlay {g:.2f} engine {r.gross:.2f} ({r.stopped_by})"
                            )
                    worst_charge = max(worst_charge, abs(ch_overlay - ch_engine))
                    if abs(ch_overlay - ch_engine) > 10.0:
                        charge_bad += 1
                        if charge_bad <= 5:
                            print(
                                f"  charge mismatch {u} {cell.cid} {slot} {d} {key}: overlay {ch_overlay:.2f} engine {ch_engine:.2f}"
                            )
                # locks: the overlay against apply_book itself (its definition)
                for arm, lvl, tr in ((3000.0, 1500.0, None), (4000.0, 1.0, 100.0)):
                    m = member_from_curve(
                        "x", 1, [(i, float(v)) for i, v in enumerate(path)], float(r0.gross)
                    )
                    trail = parse_trail(
                        f"lock:{arm:g},{lvl:g}"
                        if tr is None
                        else f"locktrail:{arm:g},{lvl:g},{tr:g},{tr:g}"
                    )
                    bd = apply_book([m], None, trail)
                    rules = {"lock": (arm, lvl)} if tr is None else {"locktrail": (arm, lvl, tr)}
                    g, _, _ = overlay.apply(path, entry, "15:28", **rules)
                    lock_checked += 1
                    if abs(g - bd.gross_with) > 1.0:
                        lock_bad += 1
        print(f"{u}: done", flush=True)
    print(
        f"engine parity: {checked} variant-days, {gross_bad} gross mismatches > Rs 1, {charge_bad} charge mismatches > Rs 10 (worst Rs {worst_charge:.2f})"
    )
    print(f"lock parity vs apply_book: {lock_checked} checks, {lock_bad} mismatches")
    ok = gross_bad == 0 and charge_bad == 0 and lock_bad == 0
    print("PARITY OK" if ok else "PARITY FAILED")
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
