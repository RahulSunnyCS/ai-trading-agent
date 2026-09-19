"""
Targeted unit tests for engine/loop.py's `simulate_session` — the specific
ordering/cap/suppression semantics that the golden-fixture parity test
(tests/golden/test_engine_golden.py) exercises only incidentally through
real strategies. These construct a `SessionContext`/`FeatureStore` directly,
bypassing `Cache`/`build_sessions` entirely, for full control over the
scenario.
"""

from datetime import date, time

from option_backtesting.engine.loop import SessionContext, simulate_session
from option_backtesting.features.store import FeatureStore
from option_backtesting.strategy.schema import (
    Caps,
    Costs,
    Entry,
    Fallback,
    FeatureCondition,
    Fills,
    Ladder,
    Leg,
    Ref,
    StrategySpec,
    TimeExit,
    Universe,
)

D = date(2026, 8, 17)
BAR_TIMES = [time(9, 30), time(9, 45), time(10, 0), time(10, 15)]


def _legs() -> list[Leg]:
    return [
        Leg(id="ce", strike="OTM1", option="CE", side="SELL"),
        Leg(id="pe", strike="OTM1", option="PE", side="SELL"),
    ]


def _base_strategy(**overrides) -> StrategySpec:
    kwargs = {
        "id": "test",
        "universe": Universe(underlying="NIFTY"),
        "legs": _legs(),
        "entry": Entry(time="09:17", lots=1),
        "ladders": [],
        "fallback": None,
        "caps": Caps(max_lots=1),
        "exits": [TimeExit(type="time", at="10:15")],
        "fills": Fills(model="trigger_level", slippage_bps=0),
        "costs": Costs(per_leg_rt=0),
    }
    kwargs.update(overrides)
    return StrategySpec(**kwargs)


def _ctx(traded_closes: list[float]) -> SessionContext:
    return SessionContext(
        date=D, dte=1, bar_times=BAR_TIMES, traded_open=50.0, traded_closes=traded_closes
    )


def _store_with_straddle(open_: float, closes: list[float]) -> FeatureStore:
    store = FeatureStore()
    store.set_per_bar("atm_straddle", D, open_, closes)
    return store


def _ladder(ladder_id: str, threshold: float, after: str | None = None) -> Ladder:
    return Ladder(
        id=ladder_id,
        when=FeatureCondition(
            feature="atm_straddle", op=">=", ref=Ref(feature="atm_straddle", at="entry", plus=threshold)
        ),
        lots=1,
        after=after,
    )


class TestLadderAfterSemantics:
    def test_t2_can_fire_on_the_same_bar_as_t1(self) -> None:
        # threshold(atm_straddle) = open(100)+10=110 for t1, +15=115 for t2.
        # Both cross at bar 1 (straddle jumps to 120) — t2 must fire on the
        # SAME bar as t1, not be delayed to a later bar.
        store = _store_with_straddle(100.0, [100.0, 120.0, 120.0, 120.0])
        strategy = _base_strategy(
            ladders=[_ladder("t1", 10), _ladder("t2", 15, after="t1")],
            caps=Caps(max_lots=3),
        )
        result = simulate_session(strategy, store, _ctx([50.0, 55.0, 60.0, 65.0]))
        fired_bars = {f.tag: f.bar for f in result.fills}
        assert fired_bars["t1"] == 1
        assert fired_bars["t2"] == 1
        assert result.total_lots == 3

    def test_t2_never_fires_if_t1_never_fires(self) -> None:
        # t1's threshold (open+1000) is never reached, so t2 (after: t1)
        # must never fire even though t2's OWN threshold (open+1) is trivially
        # satisfied from bar 0 onward.
        store = _store_with_straddle(100.0, [120.0, 120.0, 120.0, 120.0])
        strategy = _base_strategy(
            ladders=[_ladder("t1", 1000), _ladder("t2", 1, after="t1")],
            caps=Caps(max_lots=3),
        )
        result = simulate_session(strategy, store, _ctx([50.0, 55.0, 60.0, 65.0]))
        assert not result_has_tag(result, "t1")
        assert not result_has_tag(result, "t2")
        assert result.total_lots == 1  # entry only


class TestCapEnforcement:
    def test_cap_stops_a_ladder_that_would_exceed_lots_not_events(self) -> None:
        # entry=1 lot, t1=1 lot -> total 2 == cap. t2 must NOT fire even
        # though its condition is true on the same bar as t1.
        store = _store_with_straddle(100.0, [100.0, 120.0, 120.0, 120.0])
        strategy = _base_strategy(
            ladders=[_ladder("t1", 10), _ladder("t2", 15, after="t1")],
            caps=Caps(max_lots=2),
        )
        result = simulate_session(strategy, store, _ctx([50.0, 55.0, 60.0, 65.0]))
        assert result_has_tag(result, "t1")
        assert not result_has_tag(result, "t2")
        assert result.total_lots == 2


class TestFallbackSuppression:
    def test_fallback_suppressed_when_a_ladder_fired_strictly_before(self) -> None:
        store = _store_with_straddle(100.0, [120.0, 120.0, 120.0, 120.0])  # t1 fires at bar 0
        strategy = _base_strategy(
            ladders=[_ladder("t1", 10)],
            fallback=Fallback(time="10:00", lots=1, unless_fired_before=True),  # bar index 2
            caps=Caps(max_lots=3),
        )
        result = simulate_session(strategy, store, _ctx([50.0, 55.0, 60.0, 65.0]))
        assert result_has_tag(result, "t1")
        assert not result_has_tag(result, "fallback")

    def test_fallback_fires_when_no_ladder_fired(self) -> None:
        store = _store_with_straddle(100.0, [50.0, 50.0, 50.0, 50.0])  # t1 never fires
        strategy = _base_strategy(
            ladders=[_ladder("t1", 10)],
            fallback=Fallback(time="10:00", lots=1, unless_fired_before=True),
            caps=Caps(max_lots=3),
        )
        result = simulate_session(strategy, store, _ctx([50.0, 55.0, 60.0, 65.0]))
        assert not result_has_tag(result, "t1")
        assert result_has_tag(result, "fallback")

    def test_fallback_not_suppressed_by_a_ladder_firing_on_the_same_bar(self) -> None:
        # `unless_fired_before` is strict: a ladder firing at the SAME bar
        # as the fallback (not strictly before) does not suppress it.
        store = _store_with_straddle(100.0, [100.0, 100.0, 120.0, 120.0])  # t1 fires at bar 2
        strategy = _base_strategy(
            ladders=[_ladder("t1", 10)],
            fallback=Fallback(time="10:00", lots=1, unless_fired_before=True),  # bar index 2
            caps=Caps(max_lots=3),
        )
        result = simulate_session(strategy, store, _ctx([50.0, 55.0, 60.0, 65.0]))
        assert result_has_tag(result, "t1")
        assert result_has_tag(result, "fallback")


class TestEntryFilter:
    def test_false_filter_skips_entry_entirely(self) -> None:
        store = _store_with_straddle(100.0, [100.0, 100.0, 100.0, 100.0])
        strategy = _base_strategy(
            entry=Entry(
                time="09:17",
                lots=1,
                filter=[FeatureCondition(feature="atm_straddle", op=">", value=999)],
            )
        )
        result = simulate_session(strategy, store, _ctx([50.0, 55.0, 60.0, 65.0]))
        assert result.total_lots == 0
        assert result.net == 0.0
        assert result.fills == []


def result_has_tag(result, tag: str) -> bool:
    return any(f.tag == tag for f in result.fills)
