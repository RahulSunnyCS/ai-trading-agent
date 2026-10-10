"""BL-081 block 3, stage 2: the MTM at 10:30 / 11:30 / 12:30 / 13:30 of every strategy the lists picked.

    uv run --with pandas --with numpy --with duckdb python research/bl081/ck_mtm.py [workers]

Re-simulates each picked (variant, day) with its strategies/rotation YAML and reads the engine's per-minute
curve (DayResult.mtm). A value is empty before the strategy's first mark (not started). 1 lot, rupees.
Writes out/ck/mtm.csv (resumable).
"""

from __future__ import annotations

import csv
import sys
from concurrent.futures import ProcessPoolExecutor
from datetime import date
from pathlib import Path

import numpy as np

HERE = Path(__file__).parent
ROOT = HERE.parent.parent
OUT = HERE / "out" / "ck"
STAMPS = {"1030": 75, "1130": 135, "1230": 195, "1330": 255}  # minutes after 09:15


def work(task):
    und, day, names = task
    from option_backtesting.data.reference.loader import (
        MissingReferenceData,
        default_reference_data,
    )
    from option_backtesting.fyers.daily import data_dir
    from option_backtesting.legwise.engine import simulate_day
    from option_backtesting.legwise.market import load_day
    from option_backtesting.legwise.schema import load_legwise

    try:
        data = load_day(data_dir(), und, date.fromisoformat(day))
    except FileNotFoundError:
        return []
    base = default_reference_data()

    class _Early:
        def __init__(self, r):
            self._r = r

        def __getattr__(self, n):
            return getattr(self._r, n)

        def lot_size(self, u, e):
            try:
                return self._r.lot_size(u, e)
            except MissingReferenceData:
                return self._r.lot_size(u, date(2024, 10, 3))

        def strike_step(self, u, a):
            try:
                return self._r.strike_step(u, a)
            except MissingReferenceData:
                return self._r.strike_step(u, date(2024, 10, 3))

    ref = _Early(base)
    rows = []
    for name in names:
        try:
            r = simulate_day(load_legwise(ROOT / "strategies" / "rotation" / f"{name}.yaml"), data, ref, date(2026, 10, 12))
        except MissingReferenceData:
            continue
        curve = r.mtm
        vals = []
        for j in STAMPS.values():
            ok = [v for m, v in curve if m <= j]
            vals.append(round(ok[-1], 2) if ok and curve and curve[0][0] <= j else "")
        rows.append([und, day, name, *vals, round(r.gross - r.costs, 2)])
    return rows


def main() -> None:
    workers = int(sys.argv[1]) if len(sys.argv) > 1 else 4
    need: dict[tuple, set] = {}
    for p in sorted(OUT.glob("prep_*.npz")):
        z = np.load(p)
        names, days, sel = z["names"], z["days"], z["sel"]
        for k, i in enumerate(sel):
            for v in [*z["core"][k], z["buy"][k]]:
                if v >= 0:
                    n = str(names[v])
                    need.setdefault(("NIFTY" if n[0] == "N" else "SENSEX", str(days[i])), set()).add(n)
    res = OUT / "mtm.csv"
    done = set()
    if res.exists():
        with open(res) as f:
            for r in csv.reader(f):
                done.add((r[0], r[1], r[2]))
    tasks = [(u, d, sorted(n for n in ns if (u, d, n) not in done)) for (u, d), ns in need.items()]
    tasks = [t for t in tasks if t[2]]
    print(f"{sum(len(t[2]) for t in tasks)} picked strategy-days over {len(tasks)} index-days", flush=True)
    new = not res.exists()
    with open(res, "a", newline="") as f, ProcessPoolExecutor(workers) as pool:
        w = csv.writer(f)
        if new:
            w.writerow(["underlying", "day", "variant", *[f"mtm_{h}" for h in STAMPS], "net"])
        for k, rows in enumerate(pool.map(work, tasks, chunksize=4), 1):
            w.writerows(rows)
            if k % 200 == 0:
                f.flush()
                print(f"  {k}/{len(tasks)}", flush=True)
    print("done", flush=True)


if __name__ == "__main__":
    main()
