"""BL-073: recency weight x fit lookbacks, every row on every period, judged by the worst period.

    uv run --with pandas --with numpy --with duckdb python research/bl073/run_all.py [parallel]
"""

from __future__ import annotations

import re
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

WEIGHTS = {0: "0,37,37,26", 10: "10,34,33,23", 20: "20,30,30,20", 33: "33,25,25,17"}
LOOKBACKS = {"5/21/63": "5:40,21:30,63:30", "5/21/63/126": "5:30,21:25,63:25,126:20"}
PERIODS = {
    "P1 in-sample": ([], None, None),
    "P2 Jan-Aug 2025": (["--window-from", "2024-10-09"], None, pd.Timestamp("2024-10-09")),
    "P3 hold-out 2022-24": (["--nifty-only", "--early-results", str(HERE.parent / "bl071" / "results"), "--window-from", "2022-01-03"], None, None),
}
CUTS = {"P2 Jan-Aug 2025": ("lt", pd.Timestamp("2025-09-01")), "P3 hold-out 2022-24": ("lt", pd.Timestamp("2024-10-09"))}
RANDOM_P90 = {"P1 in-sample": 270_198, "P2 Jan-Aug 2025": 294_240, "P3 hold-out 2022-24": 865_554}


def mdd(s) -> float:
    eq = np.cumsum(np.asarray(s, dtype=float))
    return float((eq - np.maximum.accumulate(np.maximum(eq, 0))).min())


def run(item):
    (r, lk), (pname, (pargs, _, _)) = item
    tag = f"R{r}_{lk.replace('/', '-')}_{pname.split()[0]}"
    cache = HERE / "out" / f"run_{tag}.txt"
    cache.parent.mkdir(exist_ok=True)
    args = ["--weights", WEIGHTS[r], "--fit-lookbacks", LOOKBACKS[lk], *pargs]
    if cache.exists() and "picks file:" in cache.read_text():
        out = cache.read_text()
    else:
        out = subprocess.run([sys.executable, str(ROTATE), "--basket", "DRB-6W3L2", *args], capture_output=True, text=True, cwd=HERE.parent.parent).stdout
        cache.write_text(out)
    picks = Path([x for x in out.splitlines() if x.startswith("picks file: ")][0].split(": ", 1)[1])
    d = pd.read_csv(picks, parse_dates=["day"]).set_index("day")
    if pname in CUTS:
        d = d[d.index < CUTS[pname][1]]
    s = d.pnl_A
    row = dict(recent=r, lookbacks=lk, period=pname, days=len(s), gross=s.sum(), max_dd=mdd(s), win_pct=100 * (s > 0).mean())
    if pname == "P1 in-sample":
        row["r_p90"] = parse_case_a(out)["r_p90"]
    else:
        row["r_p90"] = RANDOM_P90[pname]
    row["beats_p90"] = row["gross"] >= row["r_p90"]
    return row


def main() -> None:
    items = [((r, lk), (p, v)) for r in WEIGHTS for lk in LOOKBACKS for p, v in PERIODS.items()]
    workers = int(sys.argv[1]) if len(sys.argv) > 1 else 4
    with ThreadPoolExecutor(workers) as pool:
        rows = list(pool.map(run, items))
    d = pd.DataFrame(rows)
    d["rel"] = d.gross / d.groupby("period").gross.transform("max")
    d.to_csv(HERE / "out" / "summary.csv", index=False)
    pd.set_option("display.width", 220)
    print(d.to_string(index=False, float_format=lambda x: f"{x:,.0f}" if abs(x) >= 10 else f"{x:.2f}"))
    g = d.groupby(["recent", "lookbacks"]).agg(min_rel=("rel", "min"), mean_rel=("rel", "mean"), all_beat_p90=("beats_p90", "all")).reset_index().sort_values("min_rel", ascending=False)
    print("\n=== robustness: minimum relative score across the three periods (adopt if >= 0.85 and beats P90 everywhere)")
    print(g.to_string(index=False, float_format=lambda x: f"{x:.3f}"))


if __name__ == "__main__":
    main()
