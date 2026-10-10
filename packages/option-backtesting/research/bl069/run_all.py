"""BL-069: run DRB-6W3L2 with each new ingredient (see backlog/BL-069-drb-new-ingredients.md).

    uv run --with pandas --with numpy --with duckdb python research/bl069/run_all.py [parallel]

Gross only. Writes out/summary.csv; for gated runs it adds the affected-day statistics from the
picks file (pnl_A vs raw_pnl)."""

from __future__ import annotations

import re
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pandas as pd

HERE = Path(__file__).parent
ROTATE = HERE.parent / "bl057" / "rotate.py"
sys.path.insert(0, str(HERE.parent / "common"))
from rotparse import parse_case_a  # noqa: E402

A = ["--weights", "33,25,25,17"]
R = ["--weights", "100,0,0,0"]
RUNS: list[tuple[str, list[str]]] = [
    ("A:base", A),
    ("R:base", R),
    ("A:recent-window-126-fixed", ["--recent-window", "126"]),
    # B1
    ("A:B1-family-0.5", [*A, "--recent-family", "0.5"]),
    ("A:B1-family-1.0", [*A, "--recent-family", "1.0"]),
    ("R:B1-family-0.5", [*R, "--recent-family", "0.5"]),
    # B2
    ("A:B2-gap-added", ["--weights", "30,20,20,15,15"]),
    ("A:B2-gap-replaces-vix", ["--weights", "33,25,25,0,17"]),
    # B3
    ("A:B3-fit-21-63", [*A, "--fit-lookbacks", "21:50,63:50"]),
    ("A:B3-fit-63-126", [*A, "--fit-lookbacks", "63:50,126:50"]),
    # B4
    ("A:B4-mingap-90", [*A, "--min-gap", "90"]),
    ("R:B4-mingap-90", [*R, "--min-gap", "90"]),
    # B6
    ("A:B6-tiers", [*A, "--recent-shape", "tiers"]),
    ("A:B6-ewm3", [*A, "--recent-shape", "ewm3"]),
    ("A:B6-accel", [*A, "--recent-shape", "accel"]),
    ("R:B6-tiers", [*R, "--recent-shape", "tiers"]),
    ("R:B6-ewm3", [*R, "--recent-shape", "ewm3"]),
    # B7
    ("A:B7-positive-recent", [*A, "--require-positive-recent"]),
    ("A:B7-streak-gate-5", [*A, "--streak-gate", "5"]),
    ("A:B7-both", [*A, "--require-positive-recent", "--streak-gate", "5"]),
    ("R:B7-positive-recent", [*R, "--require-positive-recent"]),
    ("R:B7-streak-gate-5", [*R, "--streak-gate", "5"]),
]
LADDER = ["--dd-ladder", "20000,30000,10000,25000"]
RUNS += [
    ("A:B7b-ladder-actual", [*A, *LADDER]),
    ("A:B7b-ladder-shadow", [*A, *LADDER, "--dd-basis", "shadow"]),
    ("R:B7b-ladder-actual", [*R, *LADDER]),
    ("R:B7b-ladder-shadow", [*R, *LADDER, "--dd-basis", "shadow"]),
]
RUNS += [(f"A:B2-placebo-{s}", ["--weights", "30,20,20,15,15", "--shuffle-labels", str(s)]) for s in range(10)]
RUNS += [(f"A:B3-placebo-{s}", [*A, "--fit-lookbacks", "21:50,63:50", "--shuffle-labels", str(s)]) for s in range(10)]


def run(item) -> dict:
    name, args = item
    (HERE / "out").mkdir(exist_ok=True)
    cache = HERE / "out" / f"run_{name.replace(':', '_')}.txt"
    if cache.exists() and "CASE A" in cache.read_text():  # resumable: a finished run is not redone
        out = cache.read_text()
    else:
        proc = subprocess.run(
            [sys.executable, str(ROTATE), "--basket", "DRB-6W3L2", *args],
            capture_output=True,
            text=True,
            cwd=HERE.parent.parent,
        )
        out = proc.stdout
        cache.write_text(out)
        if "CASE A" not in out:
            return dict(name=name, args=" ".join(args), error=proc.stderr.strip().splitlines()[-1:] or ["no report"])
    row = dict(name=name, args=" ".join(args), **parse_case_a(out))
    path = re.search(r"picks file: (.+)", out)
    if path:
        d = pd.read_csv(path.group(1))
        affected = (d.pnl_A - d.raw_pnl).abs() > 0.5
        row.update(
            lots_day=d.lots.mean(),
            sit_out_days=int((d.lots == 0).sum()),
            affected_days=int(affected.sum()),
            raw_on_affected=float(d.raw_pnl[affected].sum()),
            gated_on_affected=float(d.pnl_A[affected].sum()),
        )
        if "dd_level" in d:
            for lv in (1, 2):
                m = d.dd_level == lv
                row[f"days_level{lv}"] = int(m.sum())
                row[f"raw_on_level{lv}"] = float(d.raw_pnl[m].sum())
                row[f"gated_on_level{lv}"] = float(d.pnl_A[m].sum())
    return row


def main() -> None:
    workers = int(sys.argv[1]) if len(sys.argv) > 1 else 4
    with ThreadPoolExecutor(workers) as pool:
        rows = list(pool.map(run, RUNS))
    df = pd.DataFrame(rows)
    df.to_csv(HERE / "out" / "summary.csv", index=False)
    print(df.drop(columns=["args"]).to_string(float_format=lambda x: f"{x:,.0f}" if abs(x) >= 100 else f"{x:,.2f}"))


if __name__ == "__main__":
    main()
