"""BL-063: the (variant, day) pairs picked by the rotations, split into chunk files for parallel runs.

uv run --no-project --with pandas python research/bl063/pairs.py [chunks]"""

import json
import sys
from pathlib import Path

import pandas as pd

HERE = Path(__file__).parent
PICKS = {  # rotation -> daily picks file written by research/bl057/rotate.py
    "whole_day": "daily_picks_min2_core5_buy2_whole_day.csv",
    "morning66": "daily_picks.csv",
    "DRB-6W2": "daily_picks_min2_core6_buy2_whole_day.csv",  # BL-064
    "DRB-6W3": "daily_picks_min3_core6_buy2_whole_day.csv",
    "DRB-6W2L2": "daily_picks_min2_core6_buy2L2_whole_day.csv",  # BL-065: 3 strategies of 2 lots
    "DRB-6W3L2": "daily_picks_min3_core6_buy2L2_whole_day.csv",
    # BL-065 second block: the same basket on the list without the closest-premium Widesl
    "DRB-6W3L2/OTM": "daily_picks_min3_core6_buy2L2_whole_day_otm_only.csv",
    # BL-065 third block: the top 25% of each family on the warm-up days only
    "DRB-6W3L2/T25": "daily_picks_min3_core6_buy2L2_whole_day_top25.csv",
    # BL-065 fourth block: the top 25% re-chosen every day on the trailing 2 months (42 sessions)
    "DRB-6W3L2/T25R42": "daily_picks_min3_core6_buy2L2_whole_day_top25r42.csv",
    # BL-065 fifth block: the 30-minute start-time grid from 09:17 (128 variants)
    "DRB-6W3L2/G30": "daily_picks_min3_core6_buy2L2_whole_day_grid30.csv",
}

# BL-067: every weight combination's picks file (rotate.py --weights R,W,D,V), exactly the
# `_wR_W_D_V.csv` names; BL-075's cells carry more suffixes and are listed explicitly below
import re as _re  # noqa: E402

for _f in sorted((HERE.parent / "bl057").glob("daily_picks_min3_core6_buy2L2_whole_day_w*.csv")):
    if _re.search(r"_w\d+_\d+_\d+_\d+\.csv$", _f.name):
        PICKS["BL067/" + _f.stem.rsplit("_w", 1)[1].replace("_", "-")] = _f.name

# BL-075: journal lists A, B, C on the main year (stage-1 cells)
_LB = "fitlb5x30_21x25_63x25_126x20_fband"
for _k, _w in (("A", "5_34_33_23_0_5"), ("B", "0_36_35_24_0_5"), ("C", "15_30_30_20_0_5")):
    PICKS["BL075/" + _k] = f"daily_picks_min3_core6_buy2L2_whole_day_w{_w}_{_LB}.csv"


def main() -> None:
    chunks = int(sys.argv[1]) if len(sys.argv) > 1 else 8
    pairs = set()
    for file in PICKS.values():
        picks = pd.read_csv(HERE.parent / "bl057" / file, parse_dates=["day"])
        for row in picks.itertuples():
            names = row.core_A.split(",") + (row.buy.split(",") if isinstance(row.buy, str) else [])
            pairs.update((name, row.day.date().isoformat()) for name in names)
    done = set()  # pairs whose trades are already recorded are not run again
    for file in HERE.glob("trades_*.jsonl"):
        done.update((r["v"], r["day"]) for r in map(json.loads, file.read_text().splitlines()))
    ordered = sorted(pairs - done)
    print(len(pairs), "pairs picked,", len(pairs & done), "already recorded")
    for i in range(chunks):
        lines = [f"{name} {day}" for name, day in ordered[i::chunks]]
        (HERE / f"pairs_{i}.txt").write_text("\n".join(lines) + "\n")
    print(len(ordered), "distinct (variant, day) pairs in", chunks, "chunk files")


if __name__ == "__main__":
    main()
