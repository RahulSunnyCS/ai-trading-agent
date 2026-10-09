"""BL-071 part A, extra block: BL-069's candidates on the 2025-01-10 -> 2025-08-29 slice (exploratory).

    uv run --with pandas --with numpy --with duckdb python research/bl071/extra.py
"""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

import numpy as np
import pandas as pd

HERE = Path(__file__).parent
BL57 = HERE.parent / "bl057"
import importlib.util  # noqa: E402

# rotate.py imports bl056's `analyse` by that name: load part A's script under another one
_spec = importlib.util.spec_from_file_location("bl071_part_a", HERE / "analyse.py")
P = importlib.util.module_from_spec(_spec)  # mdd, random_picks, CUT, the part-A files
_spec.loader.exec_module(P)

ROWS = {
    "R + family 0.5": ["--weights", "100,0,0,0", "--recent-family", "0.5"],
    "A + fit 21:50,63:50": ["--fit-lookbacks", "21:50,63:50"],
    "A + fit 63:50,126:50": ["--fit-lookbacks", "63:50,126:50"],
    "A + streak gate 5": ["--streak-gate", "5"],
}


def picks_for(args: list[str]) -> Path:
    out = subprocess.run(
        [sys.executable, str(BL57 / "rotate.py"), "--basket", "DRB-6W3L2", "--window-from", "2024-10-09", *args],
        capture_output=True,
        text=True,
        cwd=HERE.parent.parent,
    ).stdout
    line = [x for x in out.splitlines() if x.startswith("picks file: ")]
    assert line, out[-400:]
    return Path(line[0].split(": ", 1)[1])


def main() -> None:
    base = pd.read_csv(P.picks_file(P.ROWS["baseline"]), parse_dates=["day"]).set_index("day")
    base = base[base.index < P.CUT]
    tot = P.random_picks(base.index, base.n_buy.to_numpy())
    p50, p90 = np.percentile(tot, 50), np.percentile(tot, 90)
    print(f"slice {base.index[0].date()} -> {base.index[-1].date()}, {len(base)} days; random P50 {p50:,.0f} | P90 {p90:,.0f}\n")
    print(f"{'row':26s} {'gross':>10s} {'max DD':>10s} {'win%':>6s} {'per day':>8s} {'>=P90':>6s}")
    ref = {"baseline": P.ROWS["baseline"], "recent-only": P.ROWS["recent-only"], "no-recent": P.ROWS["no-recent"]}
    for k, w in ref.items():
        d = pd.read_csv(P.picks_file(w), parse_dates=["day"]).set_index("day")
        d = d[d.index < P.CUT].pnl_A
        print(f"{k + ' (part A)':26s} {d.sum():>10,.0f} {P.mdd(d):>10,.0f} {100 * (d > 0).mean():>6.1f} {d.mean():>8,.0f} {str(d.sum() >= p90):>6s}")
    for k, args in ROWS.items():
        d = pd.read_csv(picks_for(args), parse_dates=["day"]).set_index("day")
        s = d[d.index < P.CUT]
        p = s.pnl_A
        extra = ""
        if "--streak-gate" in args:
            aff = (s.pnl_A - s.raw_pnl).abs() > 0.5
            extra = f"  [{int(aff.sum())} days cut: ungated {s.raw_pnl[aff].sum():,.0f}, gated {s.pnl_A[aff].sum():,.0f}]"
        print(f"{k:26s} {p.sum():>10,.0f} {P.mdd(p):>10,.0f} {100 * (p > 0).mean():>6.1f} {p.mean():>8,.0f} {str(p.sum() >= p90):>6s}{extra}")


if __name__ == "__main__":
    main()
