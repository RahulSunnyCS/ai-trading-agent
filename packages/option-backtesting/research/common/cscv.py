"""CSCV / probability of backtest overfitting on a days x configs matrix, in numpy.

Moved here from research/bl104/robust.py (BL-152) so that items needing it import it from
`common/` instead of from another item's folder. `cscv_pbo` is `analytics.overfit.run_cscv`
restated over a matrix (tests/unit/test_bl104_robust.py holds the two equal).
"""

from __future__ import annotations

import itertools

import numpy as np


def _block_bounds(n: int, n_blocks: int) -> list[tuple[int, int]]:
    base, extra = divmod(n, n_blocks)
    bounds, start = [], 0
    for i in range(n_blocks):
        size = base + (1 if i < extra else 0)
        bounds.append((start, start + size))
        start += size
    return bounds


def _sharpe_from_moments(n: np.ndarray, s: np.ndarray, q: np.ndarray) -> np.ndarray:
    """Sample mean / sample stdev (ddof=1) from (count, sum, sum of squares) per config; 0 for
    fewer than 2 values or zero variance — overfit._sharpe's conventions."""
    with np.errstate(invalid="ignore", divide="ignore"):
        mean = s / n
        var = (q - n * mean**2) / (n - 1)
        var = np.where(var < 1e-12, 0.0, var)  # rounding noise is zero variance
        std = np.sqrt(var)
        out = np.where((n >= 2) & (std > 0), mean / np.where(std > 0, std, 1.0), 0.0)
    return out


def cscv_pbo(matrix: np.ndarray, n_blocks: int) -> tuple[float, int]:
    """(PBO, number of IS/OOS splits) of a days x configs matrix — overfit.run_cscv restated:
    contiguous blocks, every half-and-half split, the in-sample best (first argmax) counted when
    its out-of-sample rank among all configs is at or below the median."""
    n_days, n_configs = matrix.shape
    if n_configs < 2 or n_blocks < 2 or n_blocks % 2 or n_days < 2 * n_blocks:
        raise ValueError("CSCV needs >= 2 configs, an even n_blocks and >= 2 * n_blocks days")
    bounds = _block_bounds(n_days, n_blocks)
    counts = np.array([b - a for a, b in bounds], dtype=float)
    sums = np.stack([matrix[a:b].sum(axis=0) for a, b in bounds])  # blocks x configs
    squares = np.stack([(matrix[a:b] ** 2).sum(axis=0) for a, b in bounds])
    below = 0
    combos = list(itertools.combinations(range(n_blocks), n_blocks // 2))
    for combo in combos:
        is_mask = np.zeros(n_blocks, dtype=bool)
        is_mask[list(combo)] = True
        is_perf = _sharpe_from_moments(
            counts[is_mask].sum(), sums[is_mask].sum(axis=0), squares[is_mask].sum(axis=0)
        )
        oos_perf = _sharpe_from_moments(
            counts[~is_mask].sum(), sums[~is_mask].sum(axis=0), squares[~is_mask].sum(axis=0)
        )
        best = int(np.argmax(is_perf))
        rank = (oos_perf <= oos_perf[best]).sum() / (n_configs + 1)
        below += rank <= 0.5
    return below / len(combos), len(combos)
