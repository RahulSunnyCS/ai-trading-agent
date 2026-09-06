"""
Cost model — flat, matching the reference implementation and the golden
fixture exactly: `cost = total_lots × 2 legs × per_leg_rt`.

The original design doc (§6) mentions an itemized STT/exchange/SEBI/stamp/GST
model "as f(premium, lot, date)", but that was only ever an aspiration —
neither `pyramid_backtest.py` nor `golden_15_sessions.py` implements it, and
`Costs.per_leg_rt` (already committed in M-2's schema) is the only cost field
that exists today. Reproducing the golden fixture to the rupee requires this
flat model exactly; an itemized breakdown is a fast-follow via additive
optional fields on `Costs` (all defaulting to `None`, preserving today's
behavior), not part of M-3.
"""

from __future__ import annotations


def flat_cost(total_lots: int, per_leg_rt: float, legs_per_lot: int = 2) -> float:
    return total_lots * legs_per_lot * per_leg_rt
