"""BL-070: the registered DRB-6W3L2 rows on the no-stop results (research/bl070/results).

    uv run --with pandas --with numpy --with duckdb python research/bl070/rotate_nostop.py
"""

from __future__ import annotations

import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pandas as pd

HERE = Path(__file__).parent
ROTATE = HERE.parent / "bl057" / "rotate.py"
sys.path.insert(0, str(HERE.parent / "common"))
from rotparse import parse_case_a  # noqa: E402

ROWS = {
    "baseline": ["--weights", "33,25,25,17"],
    "recent-only": ["--weights", "100,0,0,0"],
    "no-recent": ["--weights", "0,33,33,34"],
    "no-vix": ["--weights", "40,30,30,0"],
    "B3 63/126": ["--weights", "33,25,25,17", "--fit-lookbacks", "63:50,126:50"],
    "BL-072a 30/30/20/20/0 63/126": ["--weights", "30,20,20,0,0,30", "--fit-lookbacks", "63:50,126:50"],
}


def run(item):
    name, args = item
    for res, tag in ((None, "with stop"), (HERE / "results", "no stop")):
        extra = ["--results", str(res)] if res else []
        out = subprocess.run(
            [sys.executable, str(ROTATE), "--basket", "DRB-6W3L2", *args, *extra],
            capture_output=True, text=True, cwd=HERE.parent.parent,
        ).stdout
        (HERE / "out").mkdir(exist_ok=True)
        (HERE / "out" / f"rot_{name.replace('/', '-').replace(' ', '_')}_{tag.replace(' ', '')}.txt").write_text(out)
        yield dict(row=name, stops=tag, **parse_case_a(out))


def main() -> None:
    with ThreadPoolExecutor(3) as pool:
        rows = [r for rs in pool.map(lambda it: list(run(it)), ROWS.items()) for r in rs]
    d = pd.DataFrame(rows)
    d.to_csv(HERE / "out" / "rotation_with_vs_without.csv", index=False)
    print(d[["row", "stops", "gross", "max_dd", "win_pct", "worst_week", "per_lot_day", "r_p90", "verdict"]].to_string(index=False, float_format=lambda x: f"{x:,.0f}"))


if __name__ == "__main__":
    main()
