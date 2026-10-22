"""BL-156 statistics: Welch t, a label-shuffle p and a Holm adjustment. Small and plain on purpose."""

from __future__ import annotations

import numpy as np

SEED = 20261023
SHUFFLES = 10_000


def welch_t(a: np.ndarray, b: np.ndarray) -> float:
    a, b = np.asarray(a, float), np.asarray(b, float)
    if len(a) < 2 or len(b) < 2:
        return float("nan")
    se = np.sqrt(a.var(ddof=1) / len(a) + b.var(ddof=1) / len(b))
    return float((a.mean() - b.mean()) / se) if se > 0 else float("nan")


def shuffle_p(a: np.ndarray, b: np.ndarray, seed: int = SEED, n: int = SHUFFLES) -> float:
    """Two-sided: the share of label shuffles whose |mean(a) - mean(b)| is at least the observed."""
    a, b = np.asarray(a, float), np.asarray(b, float)
    if len(a) == 0 or len(b) == 0:
        return float("nan")
    pool = np.concatenate([a, b])
    observed = abs(a.mean() - b.mean())
    rng = np.random.default_rng(seed)
    k = len(a)
    count = 0
    for _ in range(n):
        rng.shuffle(pool)
        if abs(pool[:k].mean() - pool[k:].mean()) >= observed - 1e-12:
            count += 1
    return (count + 1) / (n + 1)


def one_sample_t(x: np.ndarray) -> float:
    x = np.asarray(x, float)
    if len(x) < 2 or x.std(ddof=1) == 0:
        return float("nan")
    return float(x.mean() / (x.std(ddof=1) / np.sqrt(len(x))))


def holm(ps: list[float]) -> list[float]:
    """Holm-adjusted p-values in the input order (NaN stays NaN)."""
    idx = [i for i, p in enumerate(ps) if not np.isnan(p)]
    m = len(idx)
    order = sorted(idx, key=lambda i: ps[i])
    out = [float("nan")] * len(ps)
    running = 0.0
    for rank, i in enumerate(order):
        adj = min(1.0, (m - rank) * ps[i])
        running = max(running, adj)
        out[i] = running
    return out


def max_drawdown(daily: np.ndarray) -> float:
    curve = np.cumsum(np.asarray(daily, float))
    peak = np.maximum.accumulate(np.concatenate([[0.0], curve]))[1:]
    return float((curve - peak).min()) if len(curve) else 0.0
