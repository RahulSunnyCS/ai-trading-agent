"""BL-075 block 2: the combined A+B+C ranking on P1 / P2 / P3, beside A, B and C.

    uv run --with pandas --with numpy --with duckdb python research/bl075/ensemble.py [--ext]
"""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

import numpy as np
import pandas as pd

HERE = Path(__file__).parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent / "common"))
from rotparse import parse_case_a  # noqa: E402

import run_all as S  # noqa: E402

ENS = "5,34,33,23,0,5;0,36,35,24,0,5;15,30,30,20,0,5"
CELLS = {"A": "o5_f5_baseline", "B": "o0_f5_baseline", "C": "o15_f5_baseline"}


def run(period: str, extra: list[str]) -> dict:
    cmd = [sys.executable, str(S.ROTATE), "--basket", "DRB-6W3L2", "--weights", "5,34,33,23,0,5",
           *S.LB, "--family-key", "band", "--ensemble", ENS, *S.PERIODS[period], *extra]
    out = subprocess.run(cmd, capture_output=True, text=True, cwd=HERE.parent.parent).stdout
    r = parse_case_a(out)
    picks = Path([x for x in out.splitlines() if x.startswith("picks file: ")][0].split(": ", 1)[1])
    return dict(period=period, gross=r["gross"], max_dd=r["max_dd"], win=r["win_pct"], p90=r["r_p90"], picks=picks)


def main() -> None:
    extra = ["--ext-closest"] if "--ext" in sys.argv else []
    s1 = pd.read_csv(HERE / "out" / "stage1_runs.csv").dropna(subset=["gross"]).set_index(["key", "period"])
    rows = []
    for p in S.PERIODS:
        e = run(p, extra)
        row = {"period": p, "ABC gross": e["gross"], "ABC dd": e["max_dd"], "ABC win%": e["win"], "P90": e["p90"]}
        for k, cell in CELLS.items():
            row[f"{k} gross"] = s1.loc[(cell, p), "gross"]
            row[f"{k} dd"] = s1.loc[(cell, p), "max_dd"]
        row["mean ABC"] = np.mean([row[f"{k} gross"] for k in CELLS])
        d = pd.read_csv(e["picks"])
        row["days"] = len(d)
        rows.append(row)
    t = pd.DataFrame(rows).set_index("period")
    pd.set_option("display.width", 220)
    print(t.to_string(float_format=lambda x: f"{x:,.0f}"))
    print("\nworth a journal list (gross >= mean of A,B,C and above P90 in every period):",
          bool(((t["ABC gross"] >= t["mean ABC"]) & (t["ABC gross"] >= t["P90"])).all()))


if __name__ == "__main__":
    main()
