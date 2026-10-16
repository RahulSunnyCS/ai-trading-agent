"""BL-107: simulate the added variants (T1, T2 from results/cells.json; New-556 from BL-106's pool
cells) for 2024-10-09 -> 2025-03-31, so Adaptive can be replayed over the first year with full
history. Writes results/sim_early/<set>/<index>_<HHMM>.npz. Resumable.

    uv run python research/bl107/sim_early.py --workers 4
"""

from __future__ import annotations

import argparse
import json
import sys
from concurrent.futures import ProcessPoolExecutor, as_completed
from datetime import date
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "bl106"))
import pool_run  # noqa: E402

from option_backtesting.fyers.daily import data_dir  # noqa: E402

FROM, TO = date(2024, 10, 9), date(2025, 3, 31)
OUT = HERE / "results" / "sim_early"


def run(index: str, slot: str, cells: list[dict], root: str) -> dict:
    pool_run.FROM, pool_run.TO = FROM, TO
    return pool_run.job(index, slot, cells, root)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--workers", type=int, default=4)
    args = ap.parse_args()
    groups = {
        "t1t2": json.loads((HERE / "results" / "cells.json").read_text()),
        "pool": json.loads((HERE.parent / "bl106" / "results" / "pool_cells.json").read_text())
        + json.loads((HERE.parent / "bl106" / "pool_cells_ext_2026-10-15.json").read_text()),
    }
    work = []
    for g, cells in groups.items():
        jobs: dict[tuple[str, str], list[dict]] = {}
        for c in cells:
            jobs.setdefault((c["index"], c["slot"]), []).append(c)
        (OUT / g).mkdir(parents=True, exist_ok=True)
        work += [(g, i, s, cs) for (i, s), cs in jobs.items() if not (OUT / g / f"{i}_{s.replace(':', '')}.npz").exists()]
    print(f"pending jobs {len(work)}", flush=True)
    with ProcessPoolExecutor(max_workers=args.workers) as pool:
        futs = {pool.submit(run, i, s, cs, str(data_dir())): (g, i, s) for g, i, s, cs in work}
        for f in as_completed(futs):
            g, i, s = futs[f]
            r = f.result()
            np.savez(OUT / g / f"{i}_{s.replace(':', '')}.npz", days=np.array(r["days"]), names=np.array(r["names"]),
                     gross=r["gross"], net=r["net"])
            print(f"done {g} {i} {s}: {len(r['names'])} x {len(r['days'])} days in {r['seconds']:.0f}s", flush=True)
    print("all jobs done", flush=True)


if __name__ == "__main__":
    main()
