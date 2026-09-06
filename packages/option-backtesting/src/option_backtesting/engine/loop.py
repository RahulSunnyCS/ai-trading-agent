"""
The bar-by-bar event engine. Read this docstring and
`golden_15_sessions.py`/`pyramid_backtest.py` (the design handoff's
reference implementation) before touching anything here — every formula and
ordering rule below is pinned to reproduce that reference to the rupee (see
tests/golden/test_engine_golden.py).

Session model: every declared `Leg` (always the TRADED instrument, e.g.
OTM1 CE+PE — a short strangle) is summed into one combined premium series
per session (`SessionContext.traded_closes`), exactly mirroring the
reference's `strang`. Named `features` (e.g. `atm_straddle`, a `leg_sum` of
ATM CE+PE) are a SEPARATE trigger series — never assume the traded and
triggering series are the same array.

Bar-index conventions:
- `PRE_BAR` (-1, from engine/conditions.py): "before the session's first
  bar" — used when a time (entry/fallback/exit) resolves to the pre-bar
  fix-time snapshot rather than an actual bar.
- A `Fill`'s `bar` field for lot-days/peak-loss math uses `0` for the entry
  fill even when its PRICE came from the pre-bar open snapshot (matches
  the reference's `Fill(day.entry_px, 0, "base")`).

Running-anchor updates (`running_low`/`running_high`) happen ONCE PER BAR,
for every feature any ladder anchors to, UNCONDITIONALLY — decoupled from
whether any particular ladder's `after` gate has opened yet. This matches
the reference's `running_lo = min(running_lo, v)`, which runs every bar
regardless of `len(fired) < 2`. Coupling the update to a ladder's own gate
would be a real bug: it would only be safe by accident (only correct
because some other, gate-free ladder happens to share the same anchor).

Ladder `after` means "not before, and only if": a ladder gated by `after`
is only even considered once its dependency has already fired (at or
before the current bar) — same-bar firing is allowed. Ladders are always
evaluated before the fallback within one bar, so a same-bar tie between a
ladder and the fallback resolves ladders-first automatically (matches the
reference's stable-sort-by-bar-with-ladders-appended-first behavior).

The lot CAP (`caps.max_lots`) is checked against `ledger.total_lots()`,
never against fill-event COUNT — the reference's own `len(ev)` count and
lot total happen to coincide because every event there is exactly 1 lot;
this engine generalizes correctly to multi-lot events (e.g. a 2-lot entry)
only because it compares lots, not events.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, time, timedelta

from ..bartime import time_to_bar_index
from ..data.cache import Cache
from ..data.reference.loader import ReferenceData, default_reference_data
from ..features.evaluator import evaluate_features
from ..features.store import FeatureStore
from ..strategy.loader import LoadedStrategy
from ..strategy.schema import (
    FeatureCondition,
    Ladder,
    Leg,
    ProfitTargetExit,
    StopLossExit,
    StrategySpec,
    TimeExit,
    TrailingExit,
)
from .conditions import PRE_BAR, eval_condition, eval_ref
from .fills import bar_close_fill, trigger_level_fill
from .ledger import Fill, SessionLedger
from .result import SessionResult, compute_session_result, position_mtm, position_profit_pct
from .state import EngineState

MIN_BARS_PER_SESSION = 4  # gap-skip threshold, matches the reference's `if n < 4: continue`


@dataclass
class SessionContext:
    date: date
    dte: int
    bar_times: list[time]
    traded_open: float
    traded_closes: list[float]


def _uniform_side(legs: list[Leg]) -> str:
    sides = {leg.side for leg in legs}
    if len(sides) != 1:
        raise NotImplementedError(
            "Mixed BUY/SELL legs within one strategy are not yet supported — "
            "the combined-premium model needs one uniform side to net "
            "gross/mtm correctly, and every committed strategy uses uniform "
            "SELL legs. Netting mixed sides needs its own design, not a "
            "silent guess."
        )
    return sides.pop()


def build_sessions(
    strategy: StrategySpec, cache: Cache, reference: ReferenceData, start: date, end: date
) -> list[SessionContext]:
    sessions: list[SessionContext] = []
    cursor = start
    while cursor <= end:
        if reference.is_trading_day(cursor):
            ctx = _build_one_session(strategy, cache, reference, cursor)
            if ctx is not None:
                sessions.append(ctx)
        cursor += timedelta(days=1)
    return sessions


def _build_one_session(
    strategy: StrategySpec, cache: Cache, reference: ReferenceData, d: date
) -> SessionContext | None:
    total_open = 0.0
    total_closes: list[float] | None = None
    bar_times: list[time] | None = None
    for leg in strategy.legs:
        bars = cache.get_opt_bars(
            strategy.universe.underlying, strategy.universe.timeframe, leg.strike, leg.option, d, d
        )
        if not bars:
            return None  # gap-skip — missing data for this date, not an error
        if bar_times is None:
            bar_times = [b.ts.time() for b in bars]
        total_open += bars[0].open
        closes = [b.close for b in bars]
        total_closes = (
            closes
            if total_closes is None
            else [a + b for a, b in zip(total_closes, closes, strict=True)]
        )
    assert total_closes is not None and bar_times is not None  # strategy.legs has min_length=1
    if len(total_closes) < MIN_BARS_PER_SESSION:
        return None
    expiry = reference.current_expiry(strategy.universe.underlying, d)
    dte = (expiry - d).days
    return SessionContext(
        date=d, dte=dte, bar_times=bar_times, traded_open=total_open, traded_closes=total_closes
    )


def run_backtest(
    loaded: LoadedStrategy, cache: Cache, reference: ReferenceData, start: date, end: date
) -> list[SessionResult]:
    strategy = loaded.strategy
    sessions = build_sessions(strategy, cache, reference, start, end)
    ordered_dates = [s.date for s in sessions]
    bar_times_by_date = {s.date: s.bar_times for s in sessions}
    feature_store = evaluate_features(
        loaded.features, strategy.universe, cache, reference, ordered_dates, bar_times_by_date
    )
    return [simulate_session(strategy, feature_store, ctx) for ctx in sessions]


def _running_anchor_features(ladders: list[Ladder]) -> set[str]:
    features: set[str] = set()
    for ladder in ladders:
        if (
            isinstance(ladder.when, FeatureCondition)
            and ladder.when.ref is not None
            and ladder.when.ref.at in ("running_low", "running_high")
        ):
            features.add(ladder.when.ref.feature)
    return features


def simulate_session(
    strategy: StrategySpec, feature_store: FeatureStore, ctx: SessionContext
) -> SessionResult:
    side = _uniform_side(strategy.legs)
    lot_size = default_reference_data().lot_size(strategy.universe.underlying, ctx.date)
    n = len(ctx.traded_closes)
    state = EngineState()
    ledger = SessionLedger()

    running_anchor_features = _running_anchor_features(strategy.ladders)
    for feature_name in running_anchor_features:
        entry_value = _feature_pre_bar_value(feature_store, feature_name, ctx)
        state.seed_running_anchors(feature_name, entry_value)

    entry_bar = time_to_bar_index(ctx.bar_times, strategy.entry.time)
    entry_eval_bar = entry_bar if entry_bar is not None else PRE_BAR
    filter_ok = all(
        eval_condition(c, feature_store, state, ctx.date, entry_eval_bar, ctx.bar_times)
        for c in strategy.entry.filter
    )
    if not filter_ok:
        return compute_session_result(
            ctx.date,
            ctx.dte,
            ctx.traded_closes,
            ledger,
            n - 1,
            lot_size,
            strategy.costs.per_leg_rt,
            side,
        )

    entry_price = (
        ctx.traded_open if entry_bar is None else bar_close_fill(ctx.traded_closes, entry_bar)
    )
    entry_fill = Fill(price=entry_price, bar=0, lots=strategy.entry.lots, tag="entry")
    ledger.add(entry_fill)
    state.record_fill(entry_fill)

    effective_start_bar = 0 if entry_bar is None else entry_bar
    fallback_bar = (
        time_to_bar_index(ctx.bar_times, strategy.fallback.time) if strategy.fallback else None
    )
    ladder_ids = frozenset(ladder.id for ladder in strategy.ladders)
    fallback_done = False
    exit_state: dict[int, dict] = {}
    exit_bar = n - 1  # default: session runs to its last bar if nothing else fires

    for bar in range(n):
        if bar < effective_start_bar:
            continue

        # Update EVERY tracked running anchor once, unconditionally, before
        # any ladder's fire-check this bar (see module docstring).
        for feature_name in running_anchor_features:
            value = feature_store.bar_value(feature_name, ctx.date, bar)
            state.update_running_anchors(feature_name, value)

        for ladder in strategy.ladders:
            if ledger.total_lots() >= strategy.caps.max_lots:
                break
            if ledger.has_fired(ladder.id):
                continue
            if ladder.after is not None and not ledger.has_fired(ladder.after):
                continue
            try:
                fires = eval_condition(
                    ladder.when, feature_store, state, ctx.date, bar, ctx.bar_times
                )
            except KeyError:
                # A rolling feature this ladder depends on (e.g. a lag-N
                # threshold) has no value yet for this session — the
                # calibration period at the start of any run, per
                # features/rolling.py's window semantics. Not an error: the
                # ladder simply cannot fire until its own history exists.
                fires = False
            if fires:
                trigger_series, level = _resolve_ladder_trigger(
                    ladder, feature_store, state, ctx, bar
                )
                price = trigger_level_fill(
                    trigger_series,
                    ctx.traded_closes,
                    _feature_pre_bar_value(feature_store, ladder.when.feature, ctx),
                    ctx.traded_open,
                    bar,
                    level,
                )
                fill = Fill(price=price, bar=bar, lots=ladder.lots, tag=ladder.id)
                ledger.add(fill)
                state.record_fill(fill)
                _reset_anchor_if_referenced(ladder, state, bar, feature_store, ctx)

        if (
            strategy.fallback is not None
            and fallback_bar is not None
            and bar == fallback_bar
            and not fallback_done
        ):
            fallback_done = True
            suppressed = False
            if strategy.fallback.unless_fired_before:
                earliest = ledger.earliest_bar_for_tags(ladder_ids)
                suppressed = earliest is not None and earliest < fallback_bar
            if not suppressed and ledger.total_lots() < strategy.caps.max_lots:
                price = bar_close_fill(ctx.traded_closes, bar)
                fill = Fill(price=price, bar=bar, lots=strategy.fallback.lots, tag="fallback")
                ledger.add(fill)
                state.record_fill(fill)

        if _check_exits(strategy, ctx, ledger, side, lot_size, bar, exit_state):
            exit_bar = bar
            break

    return compute_session_result(
        ctx.date,
        ctx.dte,
        ctx.traded_closes,
        ledger,
        exit_bar,
        lot_size,
        strategy.costs.per_leg_rt,
        side,
    )


def _feature_pre_bar_value(feature_store: FeatureStore, name: str, ctx: SessionContext) -> float:
    return feature_store.open_value(name, ctx.date)


def _reset_anchor_if_referenced(
    ladder: Ladder, state: EngineState, bar: int, feature_store: FeatureStore, ctx: SessionContext
) -> None:
    if not (isinstance(ladder.when, FeatureCondition) and ladder.when.ref is not None):
        return
    ref = ladder.when.ref
    if ref.at not in ("running_low", "running_high"):
        return
    value = feature_store.bar_value(ref.feature, ctx.date, bar)
    if ref.at == "running_low":
        state.reset_running_low(ref.feature, value)
    else:
        state.reset_running_high(ref.feature, value)


def _resolve_ladder_trigger(
    ladder: Ladder, feature_store: FeatureStore, state: EngineState, ctx: SessionContext, bar: int
) -> tuple[list[float], float]:
    """Returns (trigger_series, level) for `trigger_level_fill`. For a
    fixed-anchor ladder (`ref.at in (entry, session_open)`), `level` is the
    real precomputed static threshold — a genuine interpolation happens. For
    a dynamic-anchor ladder (`running_low`/`running_high`), `level` is the
    trigger feature's OWN value at the firing bar (matching the reference's
    `fill(..., strad[b])`), which makes the interpolation degenerate to a
    flat bar close by construction (see engine/fills.py)."""
    if not (isinstance(ladder.when, FeatureCondition) and ladder.when.ref is not None):
        raise NotImplementedError(
            f"Ladder {ladder.id!r}'s 'when' must be a plain feature condition "
            f"with a 'ref' to resolve a fill trigger level — composite "
            f"(all/any/not) ladder conditions are not yet supported."
        )
    trigger_name = ladder.when.feature
    trigger_series = feature_store.bar_series(trigger_name, ctx.date)
    ref = ladder.when.ref
    if ref.at in ("running_low", "running_high"):
        level = trigger_series[bar]
    else:
        level = eval_ref(ref, feature_store, state, ctx.date)
    return trigger_series, level


def _check_exits(
    strategy: StrategySpec,
    ctx: SessionContext,
    ledger: SessionLedger,
    side: str,
    lot_size: int,
    bar: int,
    exit_state: dict[int, dict],
) -> bool:
    for i, exit_spec in enumerate(strategy.exits):
        if isinstance(exit_spec, TimeExit):
            idx = time_to_bar_index(ctx.bar_times, exit_spec.at)
            if idx is not None and bar == idx:
                return True
        elif isinstance(exit_spec, StopLossExit):
            if exit_spec.basis == "mtm_inr":
                if position_mtm(ctx.traded_closes, ledger, side, lot_size, bar) <= -exit_spec.value:
                    return True
            else:
                if -position_profit_pct(ctx.traded_closes, ledger, side, bar) >= exit_spec.value:
                    return True
        elif isinstance(exit_spec, ProfitTargetExit):
            if exit_spec.basis == "mtm_inr":
                if position_mtm(ctx.traded_closes, ledger, side, lot_size, bar) >= exit_spec.value:
                    return True
            else:
                if position_profit_pct(ctx.traded_closes, ledger, side, bar) >= exit_spec.value:
                    return True
        elif isinstance(exit_spec, TrailingExit):
            tracker = exit_state.setdefault(i, {"peak": None})
            profit = (
                position_mtm(ctx.traded_closes, ledger, side, lot_size, bar)
                if exit_spec.basis == "mtm_inr"
                else position_profit_pct(ctx.traded_closes, ledger, side, bar)
            )
            if tracker["peak"] is None:
                if profit >= exit_spec.activate_at:
                    tracker["peak"] = profit
            else:
                tracker["peak"] = max(tracker["peak"], profit)
                if (tracker["peak"] - profit) >= exit_spec.trail:
                    return True
    return False
