"""BL-080: the registered experiments E1 and E2 (E3 is `research/bl075/run_all.py --stage 1 --ext`).

    uv run --with pandas --with numpy --with duckdb python research/bl080/compare.py

E1: lists A, B, C, REF on P1 / P2 / P3 with the 348-variant list (rotate.py --ext-closest) beside the
248-variant list (BL-075 stage 1 cells; REF from BL-065 / BL-071 / BL-071 part A).
E2: the share of core slots taken by the new families (p40, p60, p120, p200), per period and list.
"""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

import pandas as pd

HERE = Path(__file__).parent
BL75 = HERE.parent / "bl075"
sys.path.insert(0, str(BL75))
sys.path.insert(0, str(HERE.parent / "common"))
import run_all as S  # noqa: E402
from rotparse import parse_case_a  # noqa: E402

LISTS = {
    "A": (["--weights", "5,34,33,23,0,5", *S.LB, "--family-key", "band"], "o5_f5_baseline"),
    "B": (["--weights", "0,36,35,24,0,5", *S.LB, "--family-key", "band"], "o0_f5_baseline"),
    "C": (["--weights", "15,30,30,20,0,5", *S.LB, "--family-key", "band"], "o15_f5_baseline"),
    "REF": (["--weights", "33,25,25,17"], None),
}
REF_248 = {"P1": 430_868, "P2": 170_015, "P3": 1_013_627}
NEW = ("p40", "p60", "p120", "p200", "ditm1")


def main() -> None:
    flags = [f for f in sys.argv[1:] if f in ("--ext-closest", "--ext-dir")] or ["--ext-closest"]
    tag = (
        "".join(f[6:] if f.startswith("--ext-") else f for f in flags)
        .replace("closest", "c")
        .replace("dir", "d")
    )
    s1 = (
        pd.read_csv(BL75 / "out" / "stage1_runs.csv")
        .dropna(subset=["gross"])
        .set_index(["key", "period"])
    )
    rows = []
    for name, (args, cell) in LISTS.items():
        for period in S.PERIODS:
            cmd = [
                sys.executable,
                str(S.ROTATE),
                "--basket",
                "DRB-6W3L2",
                *args,
                *S.PERIODS[period],
                *flags,
            ]
            out = subprocess.run(cmd, capture_output=True, text=True, cwd=HERE.parent.parent).stdout
            r = parse_case_a(out)
            picks = pd.read_csv(
                Path(
                    [x for x in out.splitlines() if x.startswith("picks file: ")][0].split(": ", 1)[
                        1
                    ]
                )
            )
            slots = [n for c in picks.core_A for n in c.split(",")]
            share = sum(n.split("_")[1] in NEW for n in slots) / len(slots)
            g248 = REF_248[period] if cell is None else float(s1.loc[(cell, period), "gross"])
            rows.append(
                dict(
                    list=name,
                    period=period,
                    gross_348=r["gross"],
                    gross_248=g248,
                    dd_348=r["max_dd"],
                    p90_348=r["r_p90"],
                    above_348=r["gross"] >= r["r_p90"],
                    new_share=share,
                )
            )
    d = pd.DataFrame(rows)
    d["delta"] = d.gross_348 - d.gross_248
    d.to_csv(HERE / f"out_compare_{tag}.csv", index=False)
    pd.set_option("display.width", 200)
    print(
        d.to_string(index=False, float_format=lambda x: f"{x:,.2f}" if abs(x) < 5 else f"{x:,.0f}")
    )


if __name__ == "__main__":
    main()
