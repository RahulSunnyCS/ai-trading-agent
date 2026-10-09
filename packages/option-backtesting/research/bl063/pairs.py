"""BL-063: the (variant, day) pairs picked by the rotations, split into chunk files for parallel runs.

uv run --no-project --with pandas python research/bl063/pairs.py [chunks]"""

import sys
from pathlib import Path

import pandas as pd

HERE = Path(__file__).parent
PICKS = {  # rotation -> daily picks file written by research/bl057/rotate.py
    "whole_day": "daily_picks_min2_core5_buy2_whole_day.csv",
    "morning66": "daily_picks.csv",
}


def main() -> None:
    chunks = int(sys.argv[1]) if len(sys.argv) > 1 else 8
    pairs = set()
    for file in PICKS.values():
        picks = pd.read_csv(HERE.parent / "bl057" / file, parse_dates=["day"])
        for row in picks.itertuples():
            names = row.core_A.split(",") + (row.buy.split(",") if isinstance(row.buy, str) else [])
            pairs.update((name, row.day.date().isoformat()) for name in names)
    ordered = sorted(pairs)
    for i in range(chunks):
        lines = [f"{name} {day}" for name, day in ordered[i::chunks]]
        (HERE / f"pairs_{i}.txt").write_text("\n".join(lines) + "\n")
    print(len(ordered), "distinct (variant, day) pairs in", chunks, "chunk files")


if __name__ == "__main__":
    main()
