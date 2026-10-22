"""BL-022 Phase 2 (H1, the gate): does the mean rest-of-day range of the 20 nearest earlier days rank
today's rest-of-day range better than the VIX-implied move, BL-110's opening-range rule, plain
persistence and random neighbours? Rules: backlog/BL-022-analog-day-search.md, Phase 0.

    uv run --with pandas --with pyarrow python research/bl022/forecast.py

Reads out/features.parquet (features.py); writes out/h1_forecasts.parquet and out/h1_result.json.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).parent))
import analog as A  # noqa: E402

OUT = Path(__file__).parent / "out"
DECIDE = ("NIFTY", "2025-01-01", "2026-10-21")
REPORT = [("NIFTY", "2022-01-01", "2024-12-31"), ("SENSEX", "2025-01-01", "2026-10-21")]
VARIANTS = ("euclid", "dtw")
MIN_POOL = 250
LOOKBACK = 20
BLOCK, RESAMPLES, DRAWS, ALPHA = 5, 2000, 200, 0.05
SEED = 20261022


def spearman(a: np.ndarray, b: np.ndarray) -> float:
    ra = pd.Series(a).rank().to_numpy()
    rb = pd.Series(b).rank().to_numpy()
    return float(np.corrcoef(ra, rb)[0, 1])


def block_indexes(n: int, rng: np.random.Generator) -> np.ndarray:
    starts = rng.integers(0, n - BLOCK + 1, size=int(np.ceil(n / BLOCK)))
    return (starts[:, None] + np.arange(BLOCK)).reshape(-1)[:n]


def forecasts(df: pd.DataFrame, und: str, check: str, start: str, end: str, rng) -> pd.DataFrame:
    """One row per test day: realised rest-of-day range and every forecast of it."""
    names = A.feature_names(check)
    n_path = len(A.path_cols(A.CHECKS[check]))
    g = df[(df["index"] == und) & (df.check == check)].sort_values("day").reset_index(drop=True)
    valid = g[names].notna().all(axis=1).to_numpy()
    X = g[names].to_numpy()
    y = g.rod.to_numpy()
    rows = []
    for i in np.flatnonzero((g.day >= start).to_numpy() & (g.day <= end).to_numpy() & valid):
        pool = np.flatnonzero(valid[:i])  # earlier sessions only
        if len(pool) < MIN_POOL or i < LOOKBACK:
            continue
        r = {"day": g.day[i], "rod": y[i]}
        for v in VARIANTS:
            nn = pool[A.nearest(X[pool], X[i], n_path, v)]
            r[f"analog_{v}"] = y[nn].mean()
        prev = slice(i - LOOKBACK, i)
        r["vix_implied"] = g.vix[i] / 100 * np.sqrt(g.minutes_left[i] / (375 * 252))
        r["opening_range"] = g.rsf_raw[i] / g.rsf_raw[prev].mean() * y[prev].mean()
        r["persistence"] = y[prev].mean()
        r["random"] = np.array(
            [y[rng.choice(pool, A.K, replace=False)].mean() for _ in range(DRAWS)]
        )
        rows.append(r)
    return pd.DataFrame(rows)


def judge(f: pd.DataFrame, variant: str, rng) -> dict:
    y = f.rod.to_numpy()
    a = f[f"analog_{variant}"].to_numpy()
    out = {"n_days": len(f), "rho_analog": spearman(a, y)}
    p = {}
    idx = [block_indexes(len(f), rng) for _ in range(RESAMPLES)]
    for base in ("vix_implied", "opening_range", "persistence"):
        b = f[base].to_numpy()
        out[f"rho_{base}"] = spearman(b, y)
        diffs = np.array([spearman(a[ix], y[ix]) - spearman(b[ix], y[ix]) for ix in idx])
        out[f"diff_{base}"] = out["rho_analog"] - out[f"rho_{base}"]
        out[f"diff_{base}_lb90"] = float(np.quantile(diffs, 0.05))
        p[base] = float((diffs <= 0).mean())
    R = np.vstack(f.random.to_numpy())  # days x draws
    rho_rand = np.array([spearman(R[:, k], y) for k in range(R.shape[1])])
    out["rho_random_p95"] = float(np.quantile(rho_rand, 0.95))
    p["random"] = float((rho_rand >= out["rho_analog"]).mean())
    out["p_parts"] = p
    out["p"] = max(p.values())  # every condition must hold (intersection-union)
    return out


def holm(ps: dict[str, float]) -> dict[str, bool]:
    order = sorted(ps, key=ps.get)
    passed, m = {}, len(ps)
    stop = False
    for k, key in enumerate(order):
        ok = not stop and ps[key] <= ALPHA / (m - k)
        stop = stop or not ok
        passed[key] = ok
    return passed


def main() -> None:
    df = pd.read_parquet(OUT / "features.parquet")
    rng = np.random.default_rng(SEED)
    result: dict = {"decide": {}, "report": {}}
    frames = []
    for label, (und, start, end) in [("decide", DECIDE)] + [("report", r) for r in REPORT]:
        for check in A.CHECKS:
            f = forecasts(df, und, check, start, end, rng)
            if f.empty:
                continue
            f["index"], f["check"], f["period"] = und, check, label
            frames.append(f.drop(columns="random").assign(random_mean=f.random.map(np.mean)))
            for v in VARIANTS:
                key = f"{und} {start[:4]}-{end[:4]} {check} {v}"
                result[label][key] = judge(f, v, rng)
                print(
                    f"{label:6s} {key}: {json.dumps({k: v for k, v in result[label][key].items() if k != 'p_parts'}, default=float)}"
                )
    passed = holm({k: r["p"] for k, r in result["decide"].items()})
    for k, ok in passed.items():
        result["decide"][k]["holm_pass"] = ok
    result["gate"] = "pass" if any(passed.values()) else "fail"
    pd.concat(frames).to_parquet(OUT / "h1_forecasts.parquet", index=False)
    (OUT / "h1_result.json").write_text(json.dumps(result, indent=2, default=float))
    print(
        f"\nGATE: {result['gate']}  "
        + ", ".join(f"{k}={'pass' if ok else 'fail'}" for k, ok in passed.items())
    )


if __name__ == "__main__":
    main()
