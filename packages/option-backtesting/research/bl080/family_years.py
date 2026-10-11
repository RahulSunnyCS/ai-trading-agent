"""BL-080 E4: each family's own total by calendar year, mean over its variants (1 lot, per variant),
NIFTY 2022-2026 and SENSEX 2024-2026.   uv run --with pandas python research/bl080/family_years.py"""

from __future__ import annotations

import glob
import sys
from pathlib import Path

import pandas as pd

HERE = Path(__file__).parent
sys.path.insert(0, str(HERE.parent / "common"))
import varlib  # noqa: E402

NEW = HERE / "results"


def series(name: str) -> pd.Series:
    fam = name.split("_")[1]
    if fam in ("p40", "p60", "p120", "p200", "ditm1"):
        return pd.read_csv(NEW / f"{name}.csv", parse_dates=["day"]).set_index("day").net
    parts = []
    if name.startswith("N_"):
        early = (
            HERE.parent / "bl071" / "results" / f"{varlib.variant_file(name, 'variants').stem}.csv"
        )
        # bl071's files are named by yaml stem, e.g. wide_0917 or N_wide_1302
        for cand in (early, HERE.parent / "bl071" / "results" / f"{name}.csv"):
            if cand.exists():
                parts.append(pd.read_csv(cand, parse_dates=["day"]).set_index("day").net)
                break
    main = (
        pd.read_csv(varlib.variant_file(name, "results"), parse_dates=["day"]).set_index("day").net
    )
    parts.append(main)
    s = pd.concat(parts)
    return s[~s.index.duplicated(keep="last")].sort_index()


def main() -> None:
    names = sorted(
        {
            Path(f).stem
            for f in glob.glob(str(HERE.parent.parent / "strategies" / "rotation" / "*.yaml"))
        }
        | {
            Path(f).stem
            for f in glob.glob(str(HERE.parent.parent / "strategies" / "rotation_ext" / "*.yaml"))
        }
    )
    rows = []
    for n in names:
        if n.split("_")[1] == "buy":
            continue
        try:
            s = series(n)
        except FileNotFoundError:
            continue
        for y, g in s.groupby(s.index.year):
            rows.append(
                dict(
                    index=n[0],
                    family=n.split("_")[1],
                    year=y,
                    total=g.sum(),
                    win=(g > 0).mean(),
                    days=len(g),
                )
            )
    d = pd.DataFrame(rows)
    t = (
        d.groupby(["index", "family", "year"])
        .agg(total=("total", "mean"), win=("win", "mean"), n=("days", "mean"))
        .reset_index()
    )
    pd.set_option("display.width", 200)
    print("mean total per variant by calendar year (1 lot, today's lot size):")
    print(t.pivot(index=["index", "family"], columns="year", values="total").round(0).to_string())
    print("\nwin rate:")
    print(t.pivot(index=["index", "family"], columns="year", values="win").round(2).to_string())
    t.to_csv(HERE / "out_family_years.csv", index=False)


if __name__ == "__main__":
    main()
