"""
Margin model (M-5). `margin.csv` is a coarse, flat, effective-dated per-lot
figure — not a real SPAN+exposure calculator — so `strategy_type` here is a
coarse structural label too: "short-straddle" means "a defined 2-leg short
option combo (one CE + one PE, both SELL)", regardless of how far the legs
sit from ATM. Real exchange margin for an ATM straddle vs a similarly-sized
OTM strangle differs by only a few percent for index weeklies — immaterial
next to the coarseness already baked into a single flat monthly number — so
this module does not attempt a straddle/strangle strike-distance
distinction. A strategy shape outside this one classifiable case raises
rather than guessing a category (same convention as the rest of
`data/reference/loader.py`).

"Peak margin" for a run is the per-lot margin rate (looked up as of the date
of the session that reached the run's highest lot count) times that peak
lot count — the capital an operator would need to have earmarked to run this
strategy through its worst-case exposure day in the window, not a sum across
sessions (margin capital is reusable session to session, not consumed).
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date

from ..data.reference.loader import ReferenceData
from ..strategy.schema import StrategySpec
from .result import AggregateResult


def classify_strategy_type(strategy: StrategySpec) -> str:
    """Structural classification for the margin lookup only — not part of
    the DSL itself. Raises NotImplementedError for any shape this coarse
    model doesn't recognize, rather than silently mislabeling it."""
    legs = strategy.legs
    if (
        len(legs) == 2
        and all(leg.side == "SELL" for leg in legs)
        and {leg.option for leg in legs} == {"CE", "PE"}
    ):
        return "short-straddle"
    raise NotImplementedError(
        f"classify_strategy_type: no margin category for strategy {strategy.id!r} "
        f"({len(legs)} leg(s), sides={[leg.side for leg in legs]}, "
        f"options={[leg.option for leg in legs]}). Only the 2-leg, both-SELL, "
        f"one-CE-one-PE shape is classifiable today."
    )


@dataclass(frozen=True)
class MarginResult:
    strategy_type: str
    peak_lots: int
    peak_date: date
    margin_per_lot_inr: float
    peak_margin_inr: float
    return_on_peak_margin: float


def compute_return_on_peak_margin(
    strategy: StrategySpec,
    reference: ReferenceData,
    result: AggregateResult,
) -> MarginResult | None:
    """Returns None if the run has no sessions (nothing to be peak of) —
    callers treat a None margin result as "not computable for this run",
    the same optional pattern used elsewhere in the registry/API layer."""
    if not result.sessions:
        return None

    peak_session = max(result.sessions, key=lambda s: s.total_lots)
    strategy_type = classify_strategy_type(strategy)
    margin_per_lot = reference.margin_per_lot(
        strategy.universe.underlying, strategy_type, peak_session.date
    )
    peak_margin_inr = margin_per_lot * peak_session.total_lots
    return_on_peak_margin = result.net_inr / peak_margin_inr if peak_margin_inr else 0.0

    return MarginResult(
        strategy_type=strategy_type,
        peak_lots=peak_session.total_lots,
        peak_date=peak_session.date,
        margin_per_lot_inr=margin_per_lot,
        peak_margin_inr=peak_margin_inr,
        return_on_peak_margin=return_on_peak_margin,
    )


def render_margin(margin: MarginResult) -> str:
    return (
        f"strategy type: {margin.strategy_type}\n"
        f"peak lots: {margin.peak_lots} (on {margin.peak_date.isoformat()})\n"
        f"margin/lot: {margin.margin_per_lot_inr:.0f}\n"
        f"peak margin: {margin.peak_margin_inr:.0f}\n"
        f"return on peak margin: {margin.return_on_peak_margin:.2%}"
    )
