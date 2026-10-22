"""BL-022 spot check: one day's 20 nearest earlier days, listed and overlaid (path to T, then the rest
of the day), so a person can see whether the matches look sensible.

    uv run --with pandas --with pyarrow --with matplotlib python research/bl022/spotcheck.py \
        [--index NIFTY] [--day 2026-10-21] [--check 1200] [--variant euclid]
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).parent))
import analog as A  # noqa: E402

OUT = Path(__file__).parent / "out"


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--index", default="NIFTY")
    ap.add_argument("--day", default="2026-10-21")
    ap.add_argument("--check", default="1200")
    ap.add_argument("--variant", default="euclid")
    a = ap.parse_args()
    import matplotlib

    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    df = pd.read_parquet(OUT / "features.parquet")
    names = A.feature_names(a.check)
    g = (
        df[(df["index"] == a.index) & (df.check == a.check)]
        .sort_values("day")
        .reset_index(drop=True)
    )
    g = g[g[names].notna().all(axis=1)].reset_index(drop=True)
    i = int(np.flatnonzero(g.day == a.day)[0])
    n_path = len(A.path_cols(A.CHECKS[a.check]))
    nn = A.nearest(g[names].to_numpy()[:i], g[names].to_numpy()[i], n_path, a.variant)
    near = g.iloc[nn]
    print(f"{a.index} {a.day} at {a.check} ({a.variant}): rest-of-day range {g.rod[i]:.4f}")
    print(f"20 nearest: mean {near.rod.mean():.4f}, median {near.rod.median():.4f}")
    print(near[["day", *names, "rod"]].round(3).to_string(index=False))

    grid = A.load_grid(A.con(), a.index, start=str(min(near.day.min(), a.day)))
    ix = {d: k for k, d in enumerate(grid.days)}
    j = A.CHECKS[a.check] - A.OPEN_MIN
    t = np.arange(A.LAST_OUTCOME_COL + 1)
    fig, ax = plt.subplots(figsize=(10, 5))
    for d in near.day:
        c = grid.C[ix[d], : A.LAST_OUTCOME_COL + 1]
        ax.plot(t, 100 * np.log(c / grid.O[ix[d], 0]), color="grey", alpha=0.35, lw=0.8)
    c = grid.C[ix[a.day], : A.LAST_OUTCOME_COL + 1]
    ax.plot(t, 100 * np.log(c / grid.O[ix[a.day], 0]), color="black", lw=2, label=a.day)
    ax.axvline(j, color="tab:red", ls="--", lw=1, label=f"check {a.check}")
    ticks = list(range(0, A.LAST_OUTCOME_COL + 1, 60))
    ax.set_xticks(
        ticks, [f"{(A.OPEN_MIN + k) // 60:02d}:{(A.OPEN_MIN + k) % 60:02d}" for k in ticks]
    )
    ax.set_ylabel("% from 09:15 open")
    ax.set_title(f"{a.index} {a.day}: 20 nearest earlier days at {a.check} ({a.variant})")
    ax.legend()
    path = OUT / f"spotcheck_{a.index}_{a.day}_{a.check}_{a.variant}.png"
    fig.tight_layout()
    fig.savefig(path, dpi=110)
    print(path)


if __name__ == "__main__":
    main()
