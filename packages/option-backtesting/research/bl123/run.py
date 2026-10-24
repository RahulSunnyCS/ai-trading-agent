"""BL-123 block 2: simulate every Widesl the read-out needs (events, placebo days, random minutes).

    uv run --with pandas python research/bl123/run.py [--workers 6]

Reads out/events_b.csv, builds the design (design.build), and runs one Widesl (live shape, ₹1,000 overall
stop, ₹20 an order) for each unique (index, day, entry minute) it needs: the events' own entries, the
causal placebo days at each event's entry minute, and the random-minute draws on the event days. Writes
out/sims_b.csv. Opens only the registered cells (periods.assert_day).
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
from design import STOP_INR, build
from periods import assert_day

HERE = Path(__file__).parent
sys.path.insert(0, str(HERE.parent / "common"))
from early_ref import early_reference  # noqa: E402
from widesl_trade import run_wide  # noqa: E402

from option_backtesting.fyers.daily import data_dir  # noqa: E402
from option_backtesting.legwise.market import load_day  # noqa: E402

COLUMNS = [
    "underlying", "day", "minute", "outcome", "gross", "net0", "n_orders", "net20",
    "worst_mtm", "legs", "exit_min", "err",
]  # fmt: skip


def sim_day(task: tuple[str, str, list[int]]) -> list[dict]:
    und, day_s, minutes = task
    day = date.fromisoformat(day_s)
    assert_day(und, day)
    ref = early_reference()
    out = []
    try:
        data = load_day(data_dir(), und, day)
    except Exception as e:  # noqa: BLE001 -- recorded; a missing sim is excluded and counted, never zero
        return [
            {"underlying": und, "day": day_s, "minute": m, "err": f"{type(e).__name__}: {e}"[:200]}
            for m in minutes
        ]
    for m in minutes:
        try:
            r = run_wide(data, und, m, STOP_INR, ref)
            out.append({"underlying": und, "day": day_s, "minute": m, "err": "", **{
                k: r[k] for k in ("outcome", "gross", "net0", "n_orders", "net20", "worst_mtm", "legs", "exit_min")
            }})  # fmt: skip
        except Exception as e:  # noqa: BLE001
            out.append(
                {
                    "underlying": und,
                    "day": day_s,
                    "minute": m,
                    "err": f"{type(e).__name__}: {e}"[:200],
                }
            )
    return out


def requests(design: dict) -> dict[tuple[str, str], set[int]]:
    need: dict[tuple[str, str], set[int]] = defaultdict(set)
    for und, d in design.items():
        ev = d["events"]
        for i, r in enumerate(ev.itertuples()):
            need[(und, r.day)].add(int(r.entry))
            for pday in d["placebo"][(r.period, r.day)]:
                need[(und, pday)].add(int(r.entry))
            for k in range(d["draws"].shape[0]):
                need[(und, r.day)].add(int(d["draws"][k, i]))
    return need


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--workers", type=int, default=6)
    a = ap.parse_args()
    design = build(pd.read_csv(HERE / "out" / "events_b.csv"))
    need = requests(design)
    tasks = [(und, day, sorted(ms)) for (und, day), ms in sorted(need.items())]
    n_sims = sum(len(t[2]) for t in tasks)
    print("events: " + ", ".join(f"{u} {len(d['events'])}" for u, d in design.items()))
    print(f"{len(tasks)} index-days, {n_sims} simulations")
    with ProcessPoolExecutor(a.workers) as ex:
        rows = [r for part in ex.map(sim_day, tasks, chunksize=4) for r in part]
    path = HERE / "out" / "sims_b.csv"
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
