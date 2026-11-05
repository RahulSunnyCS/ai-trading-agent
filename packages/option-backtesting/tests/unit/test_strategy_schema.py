"""
Strategy DSL schema tests — the pydantic AST in strategy/schema.py.
"""

from __future__ import annotations

import pydantic
import pytest
from pydantic import TypeAdapter

from option_backtesting.strategy.schema import Condition, StrategySpec

VARIANT_B = {
    "id": "nifty_pyramid_B",
    "version": 1,
    "universe": {"underlying": "NIFTY", "expiry": "weekly", "session": "REGULAR"},
    "legs": [
        {"id": "ce", "kind": "OPT", "strike": "OTM1", "option": "CE", "side": "SELL"},
        {"id": "pe", "kind": "OPT", "strike": "OTM1", "option": "PE", "side": "SELL"},
    ],
    "entry": {
        "time": "09:17",
        "lots": 2,
        "filter": [{"feature": "dte", "op": "not_in", "value": [1]}],
    },
    "ladders": [
        {
            "id": "t1",
            "when": {
                "feature": "atm_straddle",
                "op": ">=",
                "ref": {"feature": "atm_straddle", "at": "entry", "plus": 10},
            },
            "lots": 1,
        },
        {
            "id": "t2",
            "when": {
                "feature": "atm_straddle",
                "op": ">=",
                "ref": {"feature": "atm_straddle", "at": "entry", "plus": 20},
            },
            "after": "t1",
            "lots": 1,
        },
    ],
    "caps": {"max_lots": 4},
    "exits": [
        {"type": "time", "at": "15:15"},
        {"type": "stop_loss", "basis": "premium_pct", "value": 40},
        {"type": "trailing", "basis": "mtm_inr", "trail": 1500, "activate_at": 2500},
    ],
    "fills": {"model": "trigger_level", "slippage_bps": 25},
    "costs": {"per_leg_rt": 60},
    "sizing": {"mode": "fixed_lots"},
}


def _strategy(**overrides: object) -> dict:
    import copy

    spec = copy.deepcopy(VARIANT_B)
    spec.update(overrides)
    return spec


class TestValidStrategy:
    def test_design_handoff_variant_b_validates(self) -> None:
        s = StrategySpec.model_validate(VARIANT_B)
        assert s.id == "nifty_pyramid_B"
        assert len(s.legs) == 2
        assert len(s.ladders) == 2
        assert s.ladders[1].after == "t1"

    def test_fill_model_accepts_yaml_key_alias(self) -> None:
        s = StrategySpec.model_validate(VARIANT_B)
        assert s.fills.fill_model == "trigger_level"

    def test_bar_close_is_flagged_research_only(self) -> None:
        s = StrategySpec.model_validate(_strategy(fills={"model": "bar_close"}))
        assert s.fills.is_research_only is True
        assert StrategySpec.model_validate(VARIANT_B).fills.is_research_only is False


class TestCondition:
    def test_all_any_not_recurse(self) -> None:
        ta: TypeAdapter[Condition] = TypeAdapter(Condition)
        cond = ta.validate_python(
            {
                "all": [
                    {"feature": "dte", "op": "not_in", "value": [1]},
                    {
                        "any": [
                            {"time": "now", "op": ">=", "value": "09:17"},
                            {"not": {"feature": "x", "op": "==", "value": 1}},
                        ]
                    },
                ]
            }
        )
        assert type(cond).__name__ == "AllCondition"

    def test_adaptive_plus_feature_ref(self) -> None:
        ta: TypeAdapter[Condition] = TypeAdapter(Condition)
        cond = ta.validate_python(
            {
                "feature": "atm_straddle",
                "op": ">=",
                "ref": {
                    "feature": "atm_straddle",
                    "at": "running_low",
                    "plus": {"feature": "spike_thr_5d"},
                },
            }
        )
        assert cond.ref.plus.feature == "spike_thr_5d"

    def test_value_and_ref_both_set_is_rejected(self) -> None:
        ta: TypeAdapter[Condition] = TypeAdapter(Condition)
        with pytest.raises(pydantic.ValidationError):
            ta.validate_python(
                {"feature": "x", "op": "==", "value": 1, "ref": {"feature": "y"}}
            )

    def test_neither_value_nor_ref_is_rejected(self) -> None:
        ta: TypeAdapter[Condition] = TypeAdapter(Condition)
        with pytest.raises(pydantic.ValidationError):
            ta.validate_python({"feature": "x", "op": "=="})


class TestStructuralValidation:
    def test_duplicate_leg_ids_rejected(self) -> None:
        bad = _strategy(
            legs=[
                {"id": "ce", "kind": "OPT", "strike": "OTM1", "option": "CE", "side": "SELL"},
                {"id": "ce", "kind": "OPT", "strike": "OTM1", "option": "PE", "side": "SELL"},
            ]
        )
        with pytest.raises(pydantic.ValidationError, match="unique"):
            StrategySpec.model_validate(bad)

    def test_ladder_after_unknown_id_rejected(self) -> None:
        bad = _strategy(
            ladders=[
                {"id": "t1", "when": {"feature": "x", "op": ">=", "value": 1}, "lots": 1, "after": "nope"}
            ]
        )
        with pytest.raises(pydantic.ValidationError, match="not a declared ladder id"):
            StrategySpec.model_validate(bad)

    def test_unreachable_max_lots_rejected(self) -> None:
        # entry lots=2, one ladder lots=1 -> max possible 3, but caps says 10
        bad = _strategy(
            ladders=[{"id": "t1", "when": {"feature": "x", "op": ">=", "value": 1}, "lots": 1}],
            caps={"max_lots": 10},
        )
        with pytest.raises(pydantic.ValidationError, match="can never be reached"):
            StrategySpec.model_validate(bad)

    def test_unknown_strike_rule_rejected(self) -> None:
        bad = _strategy(
            legs=[{"id": "ce", "kind": "OPT", "strike": "OTM99", "option": "CE", "side": "SELL"}]
        )
        with pytest.raises(pydantic.ValidationError, match="Unknown strike rule"):
            StrategySpec.model_validate(bad)

    def test_extra_top_level_field_rejected(self) -> None:
        bad = _strategy(bogus_field="oops")
        with pytest.raises(pydantic.ValidationError):
            StrategySpec.model_validate(bad)

    def test_fallback_is_optional(self) -> None:
        s = StrategySpec.model_validate(VARIANT_B)
        assert s.fallback is None

    def test_fallback_variant_c(self) -> None:
        c = _strategy(fallback={"time": "12:00", "lots": 1, "unless_fired_before": True})
        s = StrategySpec.model_validate(c)
        assert s.fallback is not None
        assert s.fallback.time == "12:00"
