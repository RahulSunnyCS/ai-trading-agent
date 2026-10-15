"""BL-105 Phase 1: apply the management variants to one base on one loaded day.

A1 (profit target) is the engine's own `overall.target_inr`. A2 / A3 (lock, lock and trail) are a
replay on the base's per-minute MTM path with `rotation.portfolio._candidates` (BL-095's level
logic), cutting every open leg at that minute's close exactly as the engine's overall stop does.
C (restart) runs the engine again from the next minute with fresh legs. `check_replay.py` proves
the cut equals the engine's own target exit.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import replace
from datetime import date
from typing import Any

from option_backtesting.legwise.engine import DayResult, simulate_day
from option_backtesting.legwise.market import DayData, minute_index, minute_label
from option_backtesting.legwise.schema import LegwiseStrategy
from option_backtesting.rotation.portfolio import Trail, _candidates

Curve = list[tuple[int, float]]


def with_target(strategy: LegwiseStrategy, target: float) -> LegwiseStrategy:
    c = strategy.model_copy(deep=True)
    c.overall.target_inr = float(target)
    return LegwiseStrategy.model_validate(c.model_dump())


def with_entry(strategy: LegwiseStrategy, label: str) -> LegwiseStrategy:
    c = strategy.model_copy(deep=True)
    c.entry_time = label
    return LegwiseStrategy.model_validate(c.model_dump())


def lock_trail(kind: str, arm: float) -> Trail:
    if kind == "lock":
        return Trail("lock", a=arm, b=arm / 2)
    return Trail("locktrail", a=arm, b=arm / 2, x=arm / 2, y=arm / 4)


def lock_cut_minute(curve: Curve, trail: Trail) -> int | None:
    """First minute the day's MTM is at or below the lock level (BL-095's logic, no loss stop)."""
    best = 0.0
    for minute, value in curve:
        best = max(best, value)
        picked = _candidates(None, trail, best)
        if picked is not None and value <= picked[0]:
            return minute
    return None


def cut_at(res: DayResult, data: DayData, m: int, note: str) -> DayResult:
    """The day as if everything had been closed at minute m's close: legs entered after m are
    dropped, legs open at m close at that bar's close (the engine's `_close_all(m, "close")`)."""
    trades = []
    for t in res.trades:
        if t.entry_min > m:
            continue
        if t.exit_min is not None and t.exit_min <= m:
            trades.append(t)
            continue
        price = data.chain[t.contract].close[m]
        trades.append(
            replace(
                t,
                exit_min=m,
                exit_price=t.entry_price if price is None else price,
                exit_reason="CUT",
            )
        )
    return DayResult(
        day=res.day,
        trades=trades,
        gross=sum(t.pnl for t in trades),
        costs=0.0,
        worst_mtm=res.worst_mtm,
        best_mtm=res.best_mtm,
        stopped_by=f"cut at {minute_label(m)} ({note})",
        notes=[],
        mtm=[],
    )


def _combine(day: date, parts: list[DayResult]) -> DayResult:
    trades = [t for p in parts for t in p.trades]
    return DayResult(
        day=day,
        trades=trades,
        gross=sum(p.gross for p in parts),
        costs=0.0,
        worst_mtm=min(p.worst_mtm for p in parts),
        best_mtm=max(p.best_mtm for p in parts),
        stopped_by=parts[-1].stopped_by,
        notes=[],
        mtm=[],
    )


Runner = Callable[[LegwiseStrategy], tuple[DayResult, int | None]]


def restart_chain(
    strategy: LegwiseStrategy,
    first: tuple[DayResult, int | None],
    run: Runner,
    restarts: int,
    not_after: str,
) -> tuple[DayResult, int]:
    """Part 1 (`first`) then up to `restarts` fresh runs, each from the minute after the previous
    cut, while the cut is before `not_after`. Returns the combined day and the restart count."""
    parts = [first[0]]
    cut = first[1]
    done = 0
    limit = minute_index(not_after)
    while cut is not None and done < restarts and cut + 1 < limit:
        res, cut = run(with_entry(strategy, minute_label(cut + 1)))
        parts.append(res)
        done += 1
    return (parts[0] if len(parts) == 1 else _combine(parts[0].day, parts)), done


def target_cut_minute(res: DayResult) -> int | None:
    text = res.stopped_by or ""
    if text.startswith("overall target at "):
        return minute_index(text.rsplit(" ", 1)[1])
    return None


def day_variants(
    base: LegwiseStrategy,
    data: DayData,
    reference: Any,
    sizing_date: date,
    spec: list[Any],
) -> tuple[dict[str, DayResult], dict[str, int], float]:
    """{variant id: that day's result}, {variant id: restarts made}, and the base's best open
    profit that day (for the trigger-frequency table)."""
    sim = lambda s: simulate_day(s, data, reference, sizing_date)  # noqa: E731
    base_res = sim(base)
    reach = max((v for _, v in base_res.mtm), default=0.0)
    out: dict[str, DayResult] = {}
    restarts: dict[str, int] = {}
    target_cache: dict[int, DayResult] = {}

    def target_run(level: int) -> Runner:
        def run(s: LegwiseStrategy) -> tuple[DayResult, int | None]:
            r = sim(with_target(s, level))
            return r, target_cut_minute(r)

        return run

    def lock_run(level: int, kind: str = "lock") -> Runner:
        trail = lock_trail(kind, level)

        def run(s: LegwiseStrategy) -> tuple[DayResult, int | None]:
            r = sim(s)
            m = lock_cut_minute(r.mtm, trail)
            return (r, None) if m is None else (cut_at(r, data, m, f"lock {level}"), m)

        return run

    for v in spec:
        if v.kind == "base":
            out[v.id] = base_res
        elif v.kind == "target":
            if v.level not in target_cache:
                target_cache[v.level] = sim(with_target(base, v.level))
            out[v.id] = target_cache[v.level]
        elif v.kind in ("lock", "locktrail"):
            m = lock_cut_minute(base_res.mtm, lock_trail(v.kind, v.level))
            out[v.id] = base_res if m is None else cut_at(base_res, data, m, f"{v.kind} {v.level}")
        elif v.kind == "restart_target":
            if v.level not in target_cache:
                target_cache[v.level] = sim(with_target(base, v.level))
            first = (target_cache[v.level], target_cut_minute(target_cache[v.level]))
            out[v.id], restarts[v.id] = restart_chain(
                base, first, target_run(v.level), v.restarts, spec_not_after()
            )
        elif v.kind == "restart_lock":
            trail = lock_trail("lock", v.level)
            m = lock_cut_minute(base_res.mtm, trail)
            first = (
                (base_res, None) if m is None else (cut_at(base_res, data, m, f"lock {v.level}"), m)
            )
            out[v.id], restarts[v.id] = restart_chain(
                base, first, lock_run(v.level), v.restarts, spec_not_after()
            )
        else:
            raise ValueError(v.kind)
    return out, restarts, reach


def spec_not_after() -> str:
    from bl105_grid import (
        RESTART_NOT_AFTER,  # imported lazily: the scripts put this folder on the path
    )

    return RESTART_NOT_AFTER
