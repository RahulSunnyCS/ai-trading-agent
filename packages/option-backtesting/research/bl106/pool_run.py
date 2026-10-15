"""BL-106 step 3: simulate the pool, one job per (index, slot), each day loaded once for every family.

Writes `results/sim/<index>_<HHMM>.npz` with the day x variant gross and net (BL-096 charges) arrays.
Resumable: a job whose file exists is skipped.

    python research/bl106/pool_run.py --workers 4
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from concurrent.futures import ProcessPoolExecutor, as_completed
from datetime import date
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "bl104"))
import grid  # noqa: E402
from run_grid import trade_charges  # noqa: E402

from option_backtesting.data.reference.loader import (  # noqa: E402
    MissingReferenceData,
    default_reference_data,
)
from option_backtesting.fyers.daily import data_dir  # noqa: E402
from option_backtesting.legwise.engine import simulate_day  # noqa: E402
from option_backtesting.legwise.market import backtest_days, load_day  # noqa: E402
from option_backtesting.rotation.lists import SIZING_DATE  # noqa: E402

OUT = HERE / "results" / "sim"
FROM, TO = date(2025, 4, 1), date(2026, 10, 9)


def job(index: str, slot: str, cells: list[dict], root: str) -> dict:
    t0 = time.monotonic()
    ref = default_reference_data()
    sizing = date.fromisoformat(SIZING_DATE)
    underlying = grid.INDICES[index]
    strategies = []
    for c in cells:
        params = {k: tuple(v) if isinstance(v, list) else v for k, v in c["params"].items()}
        strategies.append(grid.build(grid.Cell(c["family"], index, slot, params)))
    days, _ = backtest_days(Path(root), underlying, FROM, TO)
    days = [d for d in days if d.weekday() < 5]
    used, gross, net = [], [], []
    for d in days:
        try:
            data = load_day(Path(root), underlying, d)
        except (FileNotFoundError, MissingReferenceData):
            continue
        used.append(d.isoformat())
        g_row, n_row = [], []
        for s in strategies:
            r = simulate_day(s, data, ref, sizing)
            ch = sum(trade_charges(underlying, d, t)[0] for t in r.trades)
            g_row.append(r.gross)
            n_row.append(r.gross - ch)
        gross.append(g_row)
        net.append(n_row)
    return {
        "days": used,
        "names": [c["name"] for c in cells],
        "gross": np.array(gross, dtype=np.float32),
        "net": np.array(net, dtype=np.float32),
        "seconds": time.monotonic() - t0,
    }


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--workers", type=int, default=4)
    args = ap.parse_args()
    cells = json.loads((HERE / "results" / "pool_cells.json").read_text())
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
            pool.submit(job, i, s, cs, str(data_dir())): (i, s) for (i, s), cs in pending.items()
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
                days=np.array(r["days"]),
                names=np.array(r["names"]),
                gross=r["gross"],
                net=r["net"],
            )
            print(
                f"done {i} {s}: {len(r['names'])} variants x {len(r['days'])} days in {r['seconds']:.0f}s",
                flush=True,
            )
    if failed:
        raise SystemExit(f"{len(failed)} job(s) failed: {failed}")
    print("all jobs done", flush=True)


if __name__ == "__main__":
    main()
