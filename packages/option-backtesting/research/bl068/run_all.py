"""BL-068: controls on DRB-6W3L2's "recent" criterion (lookback ladder, lag, reverse) and a label
placebo (20 shuffles of the weekday / VIX band / days-to-expiry labels). Gross only: BL-067 showed
charges within ₹80.2–82.7k on every row, so net ≈ gross − ₹81k.

    uv run --with pandas --with numpy --with duckdb python research/bl068/run_all.py [parallel]
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

RUNS = [("baseline", [])]
RUNS += [(f"recent-window-{n}", ["--recent-window", str(n)]) for n in (5, 10, 21, 42, 63, 126)]
RUNS += [("recent-lag-5", ["--recent-lag", "5"]), ("recent-lag-10", ["--recent-lag", "10"])]
RUNS += [("reverse", ["--reverse"]), ("recent-only-reverse", ["--weights", "100,0,0,0", "--reverse"])]
RUNS += [(f"shuffle-{s}", ["--shuffle-labels", str(s)]) for s in range(20)]


def run(item) -> dict:
    name, args = item
    out = subprocess.run(
        [sys.executable, str(ROTATE), "--basket", "DRB-6W3L2", *args],
        capture_output=True,
        text=True,
        cwd=HERE.parent.parent,
    ).stdout
    (HERE / "out").mkdir(exist_ok=True)
    (HERE / "out" / f"run_{name}.txt").write_text(out)
    return dict(name=name, args=" ".join(args), **parse_case_a(out))


def main() -> None:
    workers = int(sys.argv[1]) if len(sys.argv) > 1 else 4
    with ThreadPoolExecutor(workers) as pool:
        rows = list(pool.map(run, RUNS))
    df = pd.DataFrame(rows)
    df.to_csv(HERE / "out" / "summary.csv", index=False)
    print(df.to_string(float_format=lambda x: f"{x:,.0f}" if abs(x) >= 100 else f"{x:,.2f}"))


if __name__ == "__main__":
    main()
