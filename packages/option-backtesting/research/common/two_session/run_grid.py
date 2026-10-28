"""BL-185 Stage A: simulate the base grid, one part (underlying, cohort, slot) at a time, with the
paths recorded. Workers claim parts with lock files, so any number can share the grid; a finished
part is never re-run. `--not-after HH:MM` stops a worker from claiming a new part after that time.

    uv run python research/common/two_session/run_grid.py [--workers-tag w1] [--not-after 07:00]
        [--only NIFTY,W] [--smoke]
"""

from __future__ import annotations

import os
import sys
import time
from datetime import date, datetime
from pathlib import Path

HERE = Path(__file__).parent
sys.path.insert(0, str(HERE.parent))
sys.path.insert(0, str(HERE))
import grid  # noqa: E402
from early_ref import early_reference  # noqa: E402
from paths import PATHS_ROOT, Recorder  # noqa: E402

from option_backtesting.data.reference.loader import MissingReferenceData  # noqa: E402
from option_backtesting.fyers.daily import data_dir  # noqa: E402
from option_backtesting.legwise.engine import simulate_day  # noqa: E402
from option_backtesting.legwise.market import backtest_days, load_day  # noqa: E402
from option_backtesting.legwise.schema import LegwiseStrategy  # noqa: E402
from option_backtesting.ruletest.charges import day_charges, trade_values  # noqa: E402

SIZING = date(2026, 10, 12)
START, END = date(2024, 10, 9), date(2026, 10, 27)


def part_dir(u: str, co: str, slot: str) -> Path:
    return PATHS_ROOT / f"{u}_{co}_{slot}"


def run_part(
    u: str, co: str, slot: str, days_cap: int | None = None, cells_cap: int | None = None
) -> None:
    root = data_dir()
    ref = early_reference()
    cs = grid.cells(co)[:cells_cap] if cells_cap else grid.cells(co)
    strategies = {c.name(u, slot): LegwiseStrategy.model_validate(c.strategy(u, slot)) for c in cs}
    days, _ = backtest_days(root, u, START, END)
    if days_cap:
        days = days[:days_cap]
    rec = {n: Recorder() for n in strategies}
    out = part_dir(u, co, slot)
    t0 = time.time()
    for i, d in enumerate(days):
        try:
            data = load_day(root, u, d)
        except FileNotFoundError:
            continue
        for name, strat in strategies.items():
            try:
                r = simulate_day(strat, data, ref, SIZING)
            except MissingReferenceData:
                continue
            orders, buy, sell = trade_values(r.trades)
            rec[name].add(d, r, day_charges(u, d.isoformat(), orders, buy, sell).total, orders)
        if (i + 1) % 50 == 0:
            print(
                f"  {u} {co} {slot}: {i + 1}/{len(days)} days, {time.time() - t0:.0f} s", flush=True
            )
    for name, r in rec.items():
        r.save(out / f"{name}.npz")
    (out / "DONE").write_text(
        f"{len(days)} days {len(strategies)} variants {time.time() - t0:.0f} s\n"
    )


def claim(u: str, co: str, slot: str) -> bool:
    d = part_dir(u, co, slot)
    if (d / "DONE").exists():
        return False
    d.mkdir(parents=True, exist_ok=True)
    try:
        fd = os.open(d / "LOCK", os.O_CREAT | os.O_EXCL | os.O_WRONLY)
    except FileExistsError:
        return False
    os.write(fd, f"{os.getpid()} {datetime.now():%F %T}\n".encode())
    os.close(fd)
    return True


def main() -> None:
    args = sys.argv[1:]
    not_after = args[args.index("--not-after") + 1] if "--not-after" in args else None
    only = args[args.index("--only") + 1].split(",") if "--only" in args else None
    if "--smoke" in args:
        run_part("NIFTY", "W", "0917", days_cap=4, cells_cap=3)
        run_part("SENSEX", "D", "1302", days_cap=4, cells_cap=3)
        print("smoke ok", sorted(p.name for p in PATHS_ROOT.iterdir()))
        return
    parts = grid.parts()
    if only:
        parts = [p for p in parts if all(o in p for o in only)]
    for u, co, slot in parts:
        if not_after and datetime.now().strftime("%H:%M") >= not_after and datetime.now().hour < 12:
            print(f"not claiming a new part after {not_after}; stopping", flush=True)
            return
        if not claim(u, co, slot):
            continue
        print(f"== part {u} {co} {slot} at {datetime.now():%H:%M}", flush=True)
        try:
            run_part(u, co, slot)
        except Exception:
            (part_dir(u, co, slot) / "LOCK").unlink(missing_ok=True)
            raise
    print("no parts left", flush=True)


if __name__ == "__main__":
    main()
