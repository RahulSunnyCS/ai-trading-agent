"""BL-072: the blend around the longer fit lookbacks (see backlog/BL-072-drb-blend-long-fit-lookbacks.md).

    uv run --with pandas --with numpy --with duckdb python research/bl072/run_all.py [parallel]

4 rows x (in-sample, 10 label shuffles, Jan-Aug 2025 slice). Writes out/summary.csv.
"""

from __future__ import annotations

import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import numpy as np
import pandas as pd

HERE = Path(__file__).parent
ROTATE = HERE.parent / "bl057" / "rotate.py"
sys.path.insert(0, str(HERE.parent / "common"))
from rotparse import parse_case_a  # noqa: E402

CUT = pd.Timestamp("2025-09-01")
WEIGHTS = {"vix20": "25,15,15,20,0,25", "vix10gap10": "25,15,15,10,10,25"}
LOOKBACKS = {"fit21-63": "21:50,63:50", "fit63-126": "63:50,126:50"}


def mdd(s) -> float:
    eq = np.cumsum(np.asarray(s, dtype=float))
    return float((eq - np.maximum.accumulate(np.maximum(eq, 0))).min())


def run(item) -> dict:
    name, args = item
    cache = HERE / "out" / f"run_{name}.txt"
    cache.parent.mkdir(exist_ok=True)
    if cache.exists() and "CASE A" in cache.read_text():
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
        return dict(name=name, error="no report")
    row = dict(name=name, **parse_case_a(out))
    line = [x for x in out.splitlines() if x.startswith("picks file: ")]
    if line and "--window-from" in args:
        d = pd.read_csv(line[0].split(": ", 1)[1], parse_dates=["day"]).set_index("day")
        s, rest = d[d.index < CUT].pnl_A, d[d.index >= CUT].pnl_A
        row.update(
            slice_gross=s.sum(), slice_dd=mdd(s), slice_days=len(s), main_gross=rest.sum(), main_dd=mdd(rest)
        )
    return row


def main() -> None:
    runs = []
    for wk, w in WEIGHTS.items():
        for lk, lb in LOOKBACKS.items():
            base = ["--weights", w, "--fit-lookbacks", lb]
            tag = f"{wk}_{lk}"
            runs.append((f"{tag}", base))
            runs.append((f"{tag}_slice", [*base, "--window-from", "2024-10-09"]))
            runs += [(f"{tag}_shuf{s}", [*base, "--shuffle-labels", str(s)]) for s in range(10)]
    workers = int(sys.argv[1]) if len(sys.argv) > 1 else 4
    with ThreadPoolExecutor(workers) as pool:
        rows = list(pool.map(run, runs))
    df = pd.DataFrame(rows)
    df.to_csv(HERE / "out" / "summary.csv", index=False)
    main_rows = df[~df.name.str.contains("shuf|slice")]
    print(main_rows[["name", "gross", "max_dd", "win_pct", "worst_week", "per_lot_day", "r_p90", "verdict"]].to_string(index=False, float_format=lambda x: f"{x:,.0f}"))
    for tag in main_rows.name:
        sh = df[df.name.str.startswith(tag + "_shuf")].gross
        g = float(main_rows[main_rows.name == tag].gross.iloc[0])
        print(f"{tag}: true {g:,.0f} vs 10 shuffles min {sh.min():,.0f} / mean {sh.mean():,.0f} / max {sh.max():,.0f} -> above all 10: {g > sh.max()}")
    print(df[df.name.str.contains("slice")][["name", "slice_days", "slice_gross", "slice_dd", "main_gross", "main_dd"]].to_string(index=False, float_format=lambda x: f"{x:,.0f}"))


if __name__ == "__main__":
    main()
