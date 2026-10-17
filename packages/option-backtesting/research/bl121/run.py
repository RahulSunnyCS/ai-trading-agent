"""BL-121: simulate every long straddle the read-out needs (events, placebo days, random minutes).

    uv run --with pandas python research/bl121/run.py [--workers 6]

Reads out/events.csv, builds the design, and runs one long ATM straddle (buy CE + PE, 25 % leg stop, trail
[3, 2] points, exit 15:14, Rs 20 an order) for each unique (day, entry minute) it needs. Writes
out/sims.csv. Opens only the registered cells (periods.assert_day).
"""

from __future__ import annotations

import argparse
import csv
import sys
from collections import defaultdict
from concurrent.futures import ProcessPoolExecutor
from datetime import date
from pathlib import Path

import pandas as pd
from design import build
from periods import UNDERLYING, assert_day

HERE = Path(__file__).parent
sys.path.insert(0, str(HERE.parent / "common"))
from early_ref import early_reference  # noqa: E402
from long_straddle_trade import run_long  # noqa: E402

from option_backtesting.fyers.daily import data_dir  # noqa: E402
from option_backtesting.legwise.market import load_day  # noqa: E402

COLUMNS = [
    "day", "minute", "outcome", "reasons", "gross", "net0", "n_orders", "net20", "worst_mtm",
    "legs", "exit_min", "err",
]  # fmt: skip


def sim_day(task: tuple[str, list[int]]) -> list[dict]:
    day_s, minutes = task
    day = date.fromisoformat(day_s)
    assert_day(UNDERLYING, day)
    ref = early_reference()
    try:
        data = load_day(data_dir(), UNDERLYING, day)
    except Exception as e:  # noqa: BLE001 -- recorded; a missing sim is left out and counted, never zero
        return [
            {"day": day_s, "minute": m, "err": f"{type(e).__name__}: {e}"[:200]} for m in minutes
        ]
    out = []
    for m in minutes:
        try:
            r = run_long(data, m, ref)
            out.append(
                {"day": day_s, "minute": m, "err": "", **{k: r[k] for k in COLUMNS if k in r}}
            )
        except Exception as e:  # noqa: BLE001
            out.append({"day": day_s, "minute": m, "err": f"{type(e).__name__}: {e}"[:200]})
    return out


def requests(design: dict) -> dict[str, set[int]]:
    need: dict[str, set[int]] = defaultdict(set)
    for (arm, _period), d in design.items():
        k = arm.lower()
        for i, r in enumerate(d["events"].to_dict("records")):
            entry = int(r[f"{k}_entry"])
            need[r["day"]].add(entry)
            for p in d["placebo"][r["day"]]:
                need[p].add(entry)
            for q in range(d["draws"].shape[0]):
                need[r["day"]].add(int(d["draws"][q, i]))
    return need


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--workers", type=int, default=6)
    a = ap.parse_args()
    design = build(pd.read_csv(HERE / "out" / "events.csv"))
    need = requests(design)
    tasks = [(day, sorted(ms)) for day, ms in sorted(need.items())]
    print("events:", {f"{a_}/{p}": len(d["events"]) for (a_, p), d in design.items()})
    print(f"{len(tasks)} days, {sum(len(t[1]) for t in tasks)} simulations")
    with ProcessPoolExecutor(a.workers) as ex:
        rows = [r for part in ex.map(sim_day, tasks, chunksize=2) for r in part]
    path = HERE / "out" / "sims.csv"
    with path.open("w", newline="") as f:
        w = csv.DictWriter(f, COLUMNS)
        w.writeheader()
        w.writerows(rows)
    errs = sum(1 for r in rows if r.get("err"))
    no_entry = sum(1 for r in rows if r.get("outcome") == "NO_ENTRY")
    print(f"wrote {len(rows)} rows to {path.name}; errors {errs}; no entry {no_entry}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
