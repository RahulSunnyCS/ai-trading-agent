"""`days_to_expiry` — a scalar per session, from `ReferenceData.current_expiry`."""

from __future__ import annotations

from datetime import date

from ..data.reference.loader import ReferenceData
from ..features.registry import DaysToExpiryFeature
from ..strategy.schema import Universe


def evaluate_days_to_expiry(
    feature: DaysToExpiryFeature, universe: Universe, reference: ReferenceData, d: date
) -> float:
    # `feature.expiry` (weekly/monthly) is not yet cross-checked against
    # ReferenceData's own per-underlying cadence — every underlying today
    # has exactly one cadence in the reference CSVs, so no committed
    # strategy can exercise a mismatch; revisit if a second cadence per
    # underlying is ever added.
    expiry = reference.current_expiry(universe.underlying, d)
    return float((expiry - d).days)
