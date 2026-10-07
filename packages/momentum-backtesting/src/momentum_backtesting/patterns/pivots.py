"""Causal swing points (a zigzag on percentage reversals).

A swing high at bar i is only known once price has fallen `reversal` from it; that bar is its
`confirmed` index. A detector evaluating bar t may use a swing point only if `confirmed <= t`,
so no pivot is ever seen before the market could have shown it.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np


@dataclass(frozen=True)
class Pivot:
    index: int  # the bar of the extreme
    value: float
    kind: str  # "high" | "low"
    confirmed: int  # the first bar on which the reversal from it had happened


def zigzag(values: np.ndarray, reversal: float) -> list[Pivot]:
    """Alternating swing highs and lows of `values` with at least `reversal` (a fraction)
    between consecutive ones. NaNs are skipped. The last, still-unconfirmed extreme is not
    returned."""
    out: list[Pivot] = []
    direction = 0  # 1: looking for a high (rising leg), -1: looking for a low
    ext_i, ext_v = -1, np.nan
    lo_i, lo_v, hi_i, hi_v = -1, np.inf, -1, -np.inf
    for i, v in enumerate(values):
        if not np.isfinite(v):
            continue
        if direction == 0:
            if v > hi_v:
                hi_i, hi_v = i, v
            if v < lo_v:
                lo_i, lo_v = i, v
            if hi_v >= lo_v * (1 + reversal) and lo_i < hi_i:
                out.append(Pivot(lo_i, lo_v, "low", i))
                direction, ext_i, ext_v = 1, hi_i, hi_v
            elif lo_v <= hi_v * (1 - reversal) and hi_i < lo_i:
                out.append(Pivot(hi_i, hi_v, "high", i))
                direction, ext_i, ext_v = -1, lo_i, lo_v
            continue
        if direction == 1:
            if v > ext_v:
                ext_i, ext_v = i, v
            elif v <= ext_v * (1 - reversal):
                out.append(Pivot(ext_i, ext_v, "high", i))
                direction, ext_i, ext_v = -1, i, v
        else:
            if v < ext_v:
                ext_i, ext_v = i, v
            elif v >= ext_v * (1 + reversal):
                out.append(Pivot(ext_i, ext_v, "low", i))
                direction, ext_i, ext_v = 1, i, v
    return out


def known_highs(pivots: list[Pivot], at: int) -> list[Pivot]:
    """Swing highs confirmed on or before bar `at`, most recent first."""
    return [p for p in reversed(pivots) if p.kind == "high" and p.confirmed <= at]
