"""
Personality export (M-5, R3). Translates a validated `StrategySpec` into
the shape apps/server's `PersonalityConfigM2` expects
(`{entryType, managementStyle, params}`, see
apps/server/src/db/schema.ts:451) for a human to review and manually
create as a new `personality_configs` row. This module NEVER writes to any
database — its output is a plain dict/JSON a human reads and acts on.

Every committed DSL strategy uses a literal `entry.time` (never a
signal-triggered entry), so `entry_type` is always `"fixed_time"` —
`momentum_exhaustion`/`any_signal`/`sr_anchored` describe live-engine
signal-detection modes the backtester doesn't model at all.
`management_style` is `"roll"` when the strategy adds to its position after
entry (ladders and/or a fallback add), else `"hold"`. `"cut_reenter"` never
applies — no DSL archetype exits a losing position and re-enters, the
defining behaviour of that management style.

Anything the DSL expresses that `PersonalityConfigM2` has no field for is
listed under `manual_review`, never silently dropped or guessed at:
multiple ladder rungs (the live model's `roll_trigger_points` supports only
one threshold), a fallback add, an event-gated entry filter, non-time exits
(stop_loss/profit_target/trailing — the live model's per-day risk cap is
`max_daily_loss`, a different mechanism), and the live engine's own
`max_daily_trades`/`max_daily_loss` risk caps, which have no DSL equivalent
at all.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from ..strategy.schema import FeatureCondition, StrategySpec


@dataclass(frozen=True)
class PersonalityExport:
    entry_type: str
    management_style: str
    params: dict[str, Any]
    manual_review: list[str] = field(default_factory=list)


def _flat_threshold_points(condition: Any) -> float | None:
    """Extracts a flat point threshold from a ladder's `when` condition, IF
    it is the one common shape every committed ladder uses: a
    FeatureCondition whose `ref.plus` is a plain number (not an adaptive,
    feature-valued threshold like D_adaptive_trailing's). Returns None for
    anything else — never a best-guess."""
    if not isinstance(condition, FeatureCondition) or condition.ref is None:
        return None
    if not isinstance(condition.ref.plus, int | float):
        return None
    return condition.ref.plus


def export_personality(strategy: StrategySpec) -> PersonalityExport:
    manual_review: list[str] = []

    if strategy.entry.filter:
        manual_review.append(
            "entry.filter makes this an event-gated fixed-time entry (e.g. an "
            "opening-range breakout) — live fixed_time personalities always enter "
            "unconditionally at their configured time; there is no equivalent gate."
        )

    has_ladders = len(strategy.ladders) > 0
    has_fallback = strategy.fallback is not None
    management_style = "roll" if (has_ladders or has_fallback) else "hold"

    params: dict[str, Any] = {
        "dsl_entry_lots": strategy.entry.lots,
        "dsl_max_lots": strategy.caps.max_lots,
    }

    if len(strategy.ladders) == 1:
        threshold = _flat_threshold_points(strategy.ladders[0].when)
        if threshold is not None:
            params["roll_trigger_points"] = threshold
        else:
            manual_review.append(
                f"ladder {strategy.ladders[0].id!r}'s trigger condition isn't a flat "
                f"points threshold — roll_trigger_points could not be derived "
                f"automatically."
            )
    elif len(strategy.ladders) > 1:
        manual_review.append(
            f"{len(strategy.ladders)} ladder rungs declared — the live engine's "
            f"roll_trigger_points supports only a single threshold; a human must "
            f"choose which rung (or combine them) maps to roll_trigger_points."
        )

    if has_fallback:
        assert strategy.fallback is not None
        manual_review.append(
            f"fallback add (+{strategy.fallback.lots} lot(s) at {strategy.fallback.time} "
            f"if nothing fired before) has no live-engine equivalent."
        )

    non_time_exits = sorted({e.type for e in strategy.exits if e.type != "time"})
    if non_time_exits:
        manual_review.append(
            f"exit type(s) {', '.join(non_time_exits)} have no live-engine equivalent "
            f"— the live model's per-day risk cap is max_daily_loss, a different "
            f"mechanism from a same-day price-based exit rule; a human must set "
            f"max_daily_loss manually."
        )

    manual_review.append(
        "max_daily_trades and max_daily_loss are live-engine risk caps with no DSL "
        "equivalent — a human must set both manually before activating this "
        "personality."
    )

    return PersonalityExport(
        entry_type="fixed_time",
        management_style=management_style,
        params=params,
        manual_review=manual_review,
    )
