"""
Unit tests for export/personality.py, against all five committed example
strategies plus a couple of synthetic edge cases (a single ladder with an
adaptive, non-flat threshold) constructed via model_copy.
"""

from pathlib import Path

from option_backtesting.export.personality import export_personality
from option_backtesting.strategy.loader import load_strategy

STRATEGIES_DIR = Path(__file__).parent.parent.parent / "strategies"


def _load(name: str):
    return load_strategy(STRATEGIES_DIR / f"{name}.yaml").strategy


class TestEntryType:
    def test_always_fixed_time(self) -> None:
        for name in ["A_flat", "B_pyramid", "C_pyramid_fallback", "D_adaptive_trailing"]:
            export = export_personality(_load(name))
            assert export.entry_type == "fixed_time"


class TestManagementStyle:
    def test_no_ladders_no_fallback_is_hold(self) -> None:
        export = export_personality(_load("A_flat"))
        assert export.management_style == "hold"

    def test_ladders_present_is_roll(self) -> None:
        export = export_personality(_load("B_pyramid"))
        assert export.management_style == "roll"

    def test_fallback_alone_is_roll(self) -> None:
        strategy = _load("A_flat")
        fallback = _load("C_pyramid_fallback").fallback
        with_fallback = strategy.model_copy(update={"fallback": fallback})
        export = export_personality(with_fallback)
        assert export.management_style == "roll"

    def test_or_breakout_has_no_ladders_or_fallback_is_hold(self) -> None:
        export = export_personality(_load("or_breakout"))
        assert export.management_style == "hold"


class TestParams:
    def test_carries_entry_and_cap_lots(self) -> None:
        export = export_personality(_load("A_flat"))
        assert export.params["dsl_entry_lots"] == 4
        assert export.params["dsl_max_lots"] == 4

    def test_single_flat_ladder_derives_roll_trigger_points(self) -> None:
        strategy = _load("B_pyramid")
        single_ladder = strategy.model_copy(update={"ladders": strategy.ladders[:1]})
        export = export_personality(single_ladder)
        assert export.params["roll_trigger_points"] == 10

    def test_multi_ladder_does_not_set_roll_trigger_points_and_flags_review(self) -> None:
        export = export_personality(_load("B_pyramid"))
        assert "roll_trigger_points" not in export.params
        assert any("2 ladder rungs" in note for note in export.manual_review)

    def test_adaptive_non_flat_single_ladder_flags_review_instead_of_guessing(self) -> None:
        strategy = _load("D_adaptive_trailing")
        single_ladder = strategy.model_copy(update={"ladders": strategy.ladders[:1]})
        export = export_personality(single_ladder)
        assert "roll_trigger_points" not in export.params
        assert any("isn't a flat points threshold" in note for note in export.manual_review)


class TestManualReview:
    def test_fallback_is_flagged(self) -> None:
        export = export_personality(_load("C_pyramid_fallback"))
        assert any("fallback add" in note for note in export.manual_review)

    def test_entry_filter_is_flagged(self) -> None:
        export = export_personality(_load("or_breakout"))
        assert any("entry.filter" in note for note in export.manual_review)

    def test_non_time_exits_are_flagged(self) -> None:
        export = export_personality(_load("or_breakout"))
        note = next(n for n in export.manual_review if "exit type" in n)
        assert "stop_loss" in note
        assert "trailing" in note

    def test_flat_strategy_has_no_ladder_or_fallback_or_filter_notes(self) -> None:
        export = export_personality(_load("A_flat"))
        assert not any("ladder" in n for n in export.manual_review)
        assert not any("fallback" in n for n in export.manual_review)
        assert not any("entry.filter" in n for n in export.manual_review)

    def test_risk_cap_note_always_present(self) -> None:
        for name in ["A_flat", "B_pyramid", "C_pyramid_fallback", "D_adaptive_trailing"]:
            export = export_personality(_load(name))
            assert any("max_daily_trades" in note for note in export.manual_review)
