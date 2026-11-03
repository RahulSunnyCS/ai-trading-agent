"""BL-185: Stage B's vectorised `evaluate` (all stops at an exit, charges from events) equals full
engine runs: gross to the rupee, charges within Rs 10.

    uv run python research/common/two_session/parity_stageb.py [--days 40]
"""

from __future__ import annotations

import sys
import tempfile
from datetime import date
from pathlib import Path

import numpy as np

HERE = Path(__file__).parent
sys.path.insert(0, str(HERE.parent))
sys.path.insert(0, str(HERE))
import grid  # noqa: E402
import stage_b as sb  # noqa: E402
from early_ref import early_reference  # noqa: E402
from paths import Recorder, load  # noqa: E402

from option_backtesting.fyers.daily import data_dir  # noqa: E402
from option_backtesting.legwise.engine import simulate_day  # noqa: E402
from option_backtesting.legwise.market import backtest_days, load_day  # noqa: E402
from option_backtesting.legwise.schema import LegwiseStrategy  # noqa: E402
from option_backtesting.ruletest.charges import day_charges, trade_values  # noqa: E402

SIZING = date(2026, 10, 12)
CASES = [("NIFTY", "W", 3 * 36 + 2 * 6 + 1 * 2 + 0, "0917"), ("NIFTY", "W", 4 * 36 + 4 * 6 + 1, "1017"),
         ("SENSEX", "D", 2 * 36 + 3 * 6 + 1 * 3 + 2, "0947"), ("SENSEX", "W", 8 * 36 + 1 * 6 + 2 * 2 + 1, "1302"),
         ("NIFTY", "D", 7 * 36 + 3, "1332")]  # fmt: skip


def main() -> None:
    n_days = int(sys.argv[sys.argv.index("--days") + 1]) if "--days" in sys.argv else 40
    root, ref = data_dir(), early_reference()
    checked = gbad = cbad = 0
    worst = 0.0
    for u, co, k, slot in CASES:
        cell = grid.cells(co)[k]
        entry = f"{slot[:2]}:{slot[2:]}"
        days, _ = backtest_days(root, u, date(2025, 4, 1), date(2026, 10, 27))
        days = days[:n_days]
        rec = Recorder()
        datas = {}
        base = LegwiseStrategy.model_validate(cell.strategy(u, slot))
        for d in days:
            datas[d] = load_day(root, u, d)
            r = simulate_day(base, datas[d], ref, SIZING)
            orders, buy, sell = trade_values(r.trades)
            rec.add(d, r, day_charges(u, d.isoformat(), orders, buy, sell).total, orders)
        with tempfile.TemporaryDirectory() as tmp:
            rec.save(Path(tmp) / "x.npz")
            z = load(Path(tmp) / "x.npz")
        stt = np.array([sb.ch.stt_rate(d) for d in z["days"]])
        for exit_, stop in (
            ("12:00", 1000),
            ("13:00", 2500),
            ("15:28", 1500),
            ("15:28", None),
            ("12:30", 750),
        ):
            if exit_ not in {e for e, _ in sb.configs(slot)}:
                continue
            g, n, s, o = sb.evaluate(z, entry, exit_, u, stt)
            si = sb.STOPS.index(stop)
            sd = cell.strategy(u, slot)
            sd["exit_time"] = exit_
            sd["overall"] = {"stop_loss_inr": float(stop)} if stop else {}
            strat = LegwiseStrategy.model_validate(sd)
            for i, d in enumerate(days):
                r = simulate_day(strat, datas[d], ref, SIZING)
                orders, buy, sell = trade_values(r.trades)
                ch = day_charges(u, d.isoformat(), orders, buy, sell).total
                checked += 1
                if abs(g[si, i] - r.gross) > 1.0:
                    gbad += 1
                    if gbad <= 4:
                        print(
                            f"  gross {u} {cell.cid} {slot} {exit_} {stop} {d}: {g[si, i]:.2f} vs {r.gross:.2f}"
                        )
                worst = max(worst, abs((g[si, i] - n[si, i]) - ch))
                if abs((g[si, i] - n[si, i]) - ch) > 10.0:
                    cbad += 1
                    if cbad <= 4:
                        print(
                            f"  charges {u} {cell.cid} {slot} {exit_} {stop} {d}: {g[si, i] - n[si, i]:.2f} vs {ch:.2f}"
                        )
        print(f"{u} {cell.cid} {slot}: done", flush=True)
    print(
        f"stage B parity: {checked} variant-days, {gbad} gross mismatches > Rs 1, {cbad} charge mismatches > Rs 10 (worst Rs {worst:.2f})"
    )
    ok = gbad == 0 and cbad == 0
    print("PARITY OK" if ok else "PARITY FAILED")
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
