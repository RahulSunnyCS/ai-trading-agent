"""BL-107 step 3: simulate the added variants (gross and net) for the replay, one job per (index, slot).

Reuses BL-106's `pool_run.job` (each day loaded once for every variant of the job). Resumable: a job
whose file exists is skipped.  2025-04-01 -> 2026-10-09, weekday sessions.

    uv run python research/bl107/simulate.py --workers 4
"""

from __future__ import annotations

import argparse
import json
import sys
from concurrent.futures import ProcessPoolExecutor, as_completed
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "bl106"))
import pool_run  # noqa: E402

from option_backtesting.fyers.daily import data_dir  # noqa: E402

OUT = HERE / "results" / "sim"


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--workers", type=int, default=4)
    args = ap.parse_args()
    cells = json.loads((HERE / "results" / "cells.json").read_text())
    jobs: dict[tuple[str, str], list[dict]] = {}
    for c in cells:
        jobs.setdefault((c["index"], c["slot"]), []).append(c)
    OUT.mkdir(parents=True, exist_ok=True)
    pending = {
        k: v for k, v in jobs.items() if not (OUT / f"{k[0]}_{k[1].replace(':', '')}.npz").exists()
    }
    print(f"jobs {len(jobs)} pending {len(pending)} variants {len(cells)}", flush=True)
    failed = []
    with ProcessPoolExecutor(max_workers=args.workers) as pool:
        futs = {
            pool.submit(pool_run.job, i, s, cs, str(data_dir())): (i, s) for (i, s), cs in pending.items()
        }
        for f in as_completed(futs):
            i, s = futs[f]
            try:
                r = f.result()
            except Exception as e:
                failed.append(f"{i} {s}")
                print(f"FAILED {i} {s}: {type(e).__name__}: {str(e)[:200]}", flush=True)
                continue
            np.savez(
                OUT / f"{i}_{s.replace(':', '')}.npz",
                days=np.array(r["days"]), names=np.array(r["names"]), gross=r["gross"], net=r["net"],
            )
            print(f"done {i} {s}: {len(r['names'])} variants x {len(r['days'])} days in {r['seconds']:.0f}s", flush=True)
    if failed:
        raise SystemExit(f"{len(failed)} job(s) failed: {failed}")
    print("all jobs done", flush=True)


if __name__ == "__main__":
    main()
