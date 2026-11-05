from datetime import date, time

import pytest

from option_backtesting.engine.conditions import PRE_BAR, eval_condition, eval_ref
from option_backtesting.engine.ledger import Fill
from option_backtesting.engine.state import EngineState, RefResolutionError
from option_backtesting.features.store import FeatureStore
from option_backtesting.strategy.schema import (
    AllCondition,
    AnyCondition,
    FeatureCondition,
    NotCondition,
    PlusFeatureRef,
    Ref,
    TimeCondition,
)

D = date(2026, 8, 17)
BAR_TIMES = [time(9, 30), time(9, 45), time(10, 0), time(10, 15)]


def _store_with_per_bar(name: str, open_: float, closes: list[float]) -> FeatureStore:
    store = FeatureStore()
    store.set_per_bar(name, D, open_, closes)
    return store


class TestEvalRefAnchors:
    def test_entry_and_session_open_resolve_to_pre_bar_open(self) -> None:
        store = _store_with_per_bar("atm_straddle", 100.0, [110.0, 120.0])
        state = EngineState()
        assert eval_ref(Ref(feature="atm_straddle", at="entry"), store, state, D) == 100.0
        assert eval_ref(Ref(feature="atm_straddle", at="session_open"), store, state, D) == 100.0

    def test_running_low_reads_current_state(self) -> None:
        store = FeatureStore()
        state = EngineState()
        state.seed_running_anchors("atm_straddle", 100.0)
        state.update_running_anchors("atm_straddle", 80.0)
        assert eval_ref(Ref(feature="atm_straddle", at="running_low"), store, state, D) == 80.0

    def test_running_low_unseeded_raises(self) -> None:
        store = FeatureStore()
        state = EngineState()
        with pytest.raises(RefResolutionError):
            eval_ref(Ref(feature="atm_straddle", at="running_low"), store, state, D)

    def test_last_fill_before_any_fill_raises(self) -> None:
        store = FeatureStore()
        state = EngineState()
        with pytest.raises(RefResolutionError):
            eval_ref(Ref(feature="atm_straddle", at="last_fill"), store, state, D)

    def test_last_fill_after_a_fill_resolves_to_its_price(self) -> None:
        store = FeatureStore()
        state = EngineState()
        state.record_fill(Fill(price=57.5, bar=3, lots=1, tag="t1"))
        assert eval_ref(Ref(feature="atm_straddle", at="last_fill"), store, state, D) == 57.5


class TestEvalRefPlusAndTimes:
    def test_plus_fixed_number(self) -> None:
        store = _store_with_per_bar("atm_straddle", 100.0, [])
        state = EngineState()
        assert eval_ref(Ref(feature="atm_straddle", at="entry", plus=10.0), store, state, D) == 110.0

    def test_plus_feature_ref_resolves_a_scalar(self) -> None:
        store = _store_with_per_bar("atm_straddle", 100.0, [])
        store.set_scalar("spike_thr_5d", D, 15.29)
        state = EngineState()
        ref = Ref(feature="atm_straddle", at="entry", plus=PlusFeatureRef(feature="spike_thr_5d"))
        assert eval_ref(ref, store, state, D) == pytest.approx(115.29)

    def test_times_applied_after_plus(self) -> None:
        store = _store_with_per_bar("atm_straddle", 100.0, [])
        state = EngineState()
        ref = Ref(feature="atm_straddle", at="entry", plus=10.0, times=2.0)
        assert eval_ref(ref, store, state, D) == 220.0


class TestEvalFeatureCondition:
    def test_simple_comparison_against_a_literal_value(self) -> None:
        store = _store_with_per_bar("dte", 0.0, [])
        store.set_scalar("dte", D, 1.0)
        state = EngineState()
        cond = FeatureCondition(feature="dte", op="==", value=1)
        assert eval_condition(cond, store, state, D, PRE_BAR, BAR_TIMES) is True

    def test_comparison_against_a_ref(self) -> None:
        store = _store_with_per_bar("atm_straddle", 100.0, [115.0])
        state = EngineState()
        cond = FeatureCondition(
            feature="atm_straddle", op=">=", ref=Ref(feature="atm_straddle", at="entry", plus=10)
        )
        # bar=0: atm_straddle=115 >= (entry=100)+10=110 -> True
        assert eval_condition(cond, store, state, D, 0, BAR_TIMES) is True

    def test_crosses_above_true_only_at_the_crossing_bar(self) -> None:
        store = _store_with_per_bar("atm_straddle", 100.0, [105.0, 112.0, 120.0])
        state = EngineState()
        cond = FeatureCondition(
            feature="atm_straddle", op="crosses_above", ref=Ref(feature="atm_straddle", at="entry", plus=10)
        )
        # threshold = 110. bar0=105 (no prior data, PRE_BAR->105, not > yet since prev(open)=100<=110 but 105<=110 too)
        assert eval_condition(cond, store, state, D, 0, BAR_TIMES) is False
        # bar1: prev(bar0)=105<=110, cur=112>110 -> crosses True
        assert eval_condition(cond, store, state, D, 1, BAR_TIMES) is True
        # bar2: prev(bar1)=112>110 already, so 112<=110 is False -> not a fresh cross
        assert eval_condition(cond, store, state, D, 2, BAR_TIMES) is False

    def test_crosses_above_at_pre_bar_is_always_false(self) -> None:
        store = _store_with_per_bar("atm_straddle", 100.0, [120.0])
        state = EngineState()
        cond = FeatureCondition(feature="atm_straddle", op="crosses_above", value=110)
        assert eval_condition(cond, store, state, D, PRE_BAR, BAR_TIMES) is False


class TestEvalConditionCombinators:
    def test_all_requires_every_subcondition(self) -> None:
        store = FeatureStore()
        store.set_scalar("a", D, 1.0)
        store.set_scalar("b", D, 2.0)
        state = EngineState()
        cond = AllCondition(
            all=[
                FeatureCondition(feature="a", op="==", value=1),
                FeatureCondition(feature="b", op="==", value=99),
            ]
        )
        assert eval_condition(cond, store, state, D, PRE_BAR, BAR_TIMES) is False

    def test_any_requires_one_subcondition(self) -> None:
        store = FeatureStore()
        store.set_scalar("a", D, 1.0)
        store.set_scalar("b", D, 2.0)
        state = EngineState()
        cond = AnyCondition(
            any=[
                FeatureCondition(feature="a", op="==", value=99),
                FeatureCondition(feature="b", op="==", value=2),
            ]
        )
        assert eval_condition(cond, store, state, D, PRE_BAR, BAR_TIMES) is True

    def test_not_inverts(self) -> None:
        store = FeatureStore()
        store.set_scalar("a", D, 1.0)
        state = EngineState()
        cond = NotCondition.model_validate({"not": {"feature": "a", "op": "==", "value": 1}})
        assert eval_condition(cond, store, state, D, PRE_BAR, BAR_TIMES) is False


class TestEvalTimeCondition:
    def test_time_condition_compares_current_bar_time(self) -> None:
        store = FeatureStore()
        state = EngineState()
        cond = TimeCondition(time="now", op=">=", value="10:00")
        assert eval_condition(cond, store, state, D, 2, BAR_TIMES) is True  # bar 2 == 10:00
        assert eval_condition(cond, store, state, D, 0, BAR_TIMES) is False  # bar 0 == 09:30
