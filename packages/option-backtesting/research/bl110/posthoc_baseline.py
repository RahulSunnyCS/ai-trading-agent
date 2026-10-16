"""BL-110 post-hoc check (added after the review; NOT part of the registered rule).

A mean of next-day ratios to a median baseline sits above 1 for any skewed series, so "after a
quiet session the next range is about normal (0.97)" is not evidence it does not shrink. This
compares each state with the all-session average of the same ratio.

    TRADING_DATA_ROOT=/Volumes/TradingData uv run python research/bl110/posthoc_baseline.py
"""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
from persistence import (
    EXPANDED,
    LOOKBACK,
    RANGEBOUND,
    SPLIT,
    boot_idx,
    sessions,
    trailing_median,
)

from option_backtesting.fyers.daily import data_dir

OUT = Path(__file__).parent


def block_ci(values: np.ndarray, groups: np.ndarray, seed: int) -> list[float]:
    """90% interval of mean(values[groups]) - mean(values) over the same resampled rows."""
    idx = boot_idx(len(values), np.random.default_rng(seed))
    diffs = []
    for i in idx:
        g = groups[i]
        if g.any():
            diffs.append(values[i][g].mean() - values[i].mean())
    lo, hi = np.percentile(diffs, [5, 95])
    return [float(lo), float(hi)]


def main() -> None:
    rows = sessions(data_dir())
    day = np.array([r["day"] for r in rows])
    R = np.array([r["R"] for r in rows])
    B = trailing_median(R)
    E = R / B
    state = np.where(E >= EXPANDED, 1, np.where(E <= RANGEBOUND, -1, 0))
    out: dict = {"note": "post-hoc; reference = all sessions with a baseline"}
    for label, sel in (("first", day <= SPLIT), ("second", day > SPLIT)):
        t = np.array([i for i in range(LOOKBACK, len(R) - 5) if sel[i]])
        f = {k: R[t + k] / B[t] for k in range(1, 6)}
        block = {"sessions": int(len(t))}
        for k in (1, 5):
            v = np.mean([f[j] for j in range(1, k + 1)], axis=0) if k > 1 else f[1]
            ref = float(v.mean())
            entry = {"all_sessions_mean": ref, "all_sessions_median": float(np.median(v))}
            for name, code in (("expanded", 1), ("range_bound", -1)):
                g = state[t] == code
                entry[name] = {
                    "n": int(g.sum()),
                    "mean": float(v[g].mean()),
                    "median": float(np.median(v[g])),
                    "mean_minus_all": float(v[g].mean() - ref),
                    "ci90": block_ci(v, g, 20261015 + k + code),
                }
            block[f"next_{k}_day_mean_ratio" if k == 1 else "mean_of_next_5_days_ratio"] = entry
        out[label] = block
    (OUT / "posthoc_baseline_2026-10-15.json").write_text(json.dumps(out, indent=1) + "\n")
    print(json.dumps(out, indent=1))


if __name__ == "__main__":
    main()
