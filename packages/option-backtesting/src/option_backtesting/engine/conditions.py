"""
Condition/Ref evaluation — the runtime half of strategy/schema.py's
Condition grammar (`all`/`any`/`not`/`feature`/`time`) and `Ref` anchors
(`entry`/`session_open`/`running_low`/`running_high`/`last_fill`).

`PRE_BAR` is the sentinel bar index used throughout the engine for
"before the session's first bar" (e.g. `entry.filter` evaluated at a
fix-time entry like "09:17" that precedes the first 15m bar). It is
distinct from `bar == 0` (the actual first bar) — never conflate them, and
never index a list with `PRE_BAR` directly (Python would silently wrap to
the LAST element).

`TimeCondition`, `crosses_above`/`crosses_below`, `in`/`not_in`, and
`Ref.times` are NOT exercised by any committed strategy (A/B/C/D/
or_breakout) — implemented per the schema's literal grammar, best-effort,
not golden-verified.
"""

from __future__ import annotations

from datetime import date, time
from typing import Any

from ..bartime import time_to_bar_index
from ..features.store import FeatureStore
from ..strategy.schema import (
    AllCondition,
    AnyCondition,
    Condition,
    FeatureCondition,
    NotCondition,
    Ref,
    TimeCondition,
)
from .state import EngineState, RefResolutionError

PRE_BAR = -1


def _feature_value_at_bar(feature_store: FeatureStore, name: str, d: date, bar: int) -> float:
    if feature_store.is_scalar(name):
        return feature_store.scalar_value(name, d)
    if bar == PRE_BAR:
        return feature_store.open_value(name, d)
    return feature_store.bar_value(name, d, bar)


def eval_ref(ref: Ref, feature_store: FeatureStore, state: EngineState, d: date) -> float:
    if ref.at in ("entry", "session_open"):
        # Treated identically for M-3 — both resolve to the feature's
        # pre-bar snapshot. They would diverge only for an event-triggered
        # entry time (the entry firing at a different moment than the
        # strategy's nominal "session open"), which no committed strategy
        # needs yet (see or_breakout.yaml's header comment).
        base = feature_store.open_value(ref.feature, d)
    elif ref.at == "running_low":
        if ref.feature not in state.running_low:
            raise RefResolutionError(
                f"'running_low' anchor for feature {ref.feature!r} was never seeded this session"
            )
        base = state.running_low[ref.feature]
    elif ref.at == "running_high":
        if ref.feature not in state.running_high:
            raise RefResolutionError(
                f"'running_high' anchor for feature {ref.feature!r} was never seeded this session"
            )
        base = state.running_high[ref.feature]
    elif ref.at == "last_fill":
        if state.last_fill is None:
            raise RefResolutionError(
                "'last_fill' referenced before any fill has occurred in this session"
            )
        base = state.last_fill.price
    else:  # pragma: no cover — exhaustive over the schema's _ANCHOR literal
        raise AssertionError(f"Unhandled Ref.at: {ref.at!r}")

    if ref.plus is not None:
        addend = (
            ref.plus
            if isinstance(ref.plus, int | float)
            else feature_store.scalar_value(ref.plus.feature, d)
        )
        base = base + addend
    if ref.times is not None:
        base = base * ref.times
    return base


def _compare(lhs: Any, op: str, rhs: Any) -> bool:
    if op == ">":
        return lhs > rhs
    if op == ">=":
        return lhs >= rhs
    if op == "<":
        return lhs < rhs
    if op == "<=":
        return lhs <= rhs
    if op == "==":
        return lhs == rhs
    if op == "in":
        return lhs in rhs
    if op == "not_in":
        return lhs not in rhs
    raise ValueError(f"Op {op!r} is a crossing op — handled separately, not via _compare")


def _eval_feature_condition(
    cond: FeatureCondition, feature_store: FeatureStore, state: EngineState, d: date, bar: int
) -> bool:
    lhs = _feature_value_at_bar(feature_store, cond.feature, d, bar)
    rhs = cond.value if cond.ref is None else eval_ref(cond.ref, feature_store, state, d)

    if cond.op in ("crosses_above", "crosses_below"):
        if bar == PRE_BAR:
            return False  # no prior bar to have crossed from
        prev_lhs = _feature_value_at_bar(feature_store, cond.feature, d, bar - 1)
        if cond.op == "crosses_above":
            return prev_lhs <= rhs and lhs > rhs
        return prev_lhs >= rhs and lhs < rhs

    return _compare(lhs, cond.op, rhs)


def _eval_time_condition(cond: TimeCondition, bar_times: list[time], bar: int) -> bool:
    current = time.fromisoformat("00:00") if bar == PRE_BAR else bar_times[bar]
    target_bar = time_to_bar_index(bar_times, cond.value)
    target = time.fromisoformat("00:00") if target_bar is None else bar_times[target_bar]
    return _compare(current, cond.op, target)


def eval_condition(
    cond: Condition,
    feature_store: FeatureStore,
    state: EngineState,
    d: date,
    bar: int,
    bar_times: list[time],
) -> bool:
    if isinstance(cond, AllCondition):
        return all(eval_condition(c, feature_store, state, d, bar, bar_times) for c in cond.all)
    if isinstance(cond, AnyCondition):
        return any(eval_condition(c, feature_store, state, d, bar, bar_times) for c in cond.any)
    if isinstance(cond, NotCondition):
        return not eval_condition(cond.not_, feature_store, state, d, bar, bar_times)
    if isinstance(cond, TimeCondition):
        return _eval_time_condition(cond, bar_times, bar)
    if isinstance(cond, FeatureCondition):
        return _eval_feature_condition(cond, feature_store, state, d, bar)
    raise AssertionError(f"Unhandled Condition type: {type(cond)}")  # pragma: no cover
