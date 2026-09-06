from option_backtesting.engine.ledger import Fill
from option_backtesting.engine.state import EngineState


class TestRunningLowAnchor:
    def test_seed_sets_initial_value(self) -> None:
        state = EngineState()
        state.seed_running_anchors("atm_straddle", 100.0)
        assert state.running_low["atm_straddle"] == 100.0
        assert state.running_high["atm_straddle"] == 100.0

    def test_seed_is_a_noop_if_already_seeded(self) -> None:
        # two ladders anchoring to the same feature both call seed at
        # session start — the second call must not clobber a value already
        # updated by an intervening bar.
        state = EngineState()
        state.seed_running_anchors("atm_straddle", 100.0)
        state.update_running_anchors("atm_straddle", 80.0)
        state.seed_running_anchors("atm_straddle", 100.0)
        assert state.running_low["atm_straddle"] == 80.0

    def test_update_only_lowers_never_raises(self) -> None:
        state = EngineState()
        state.seed_running_anchors("atm_straddle", 100.0)
        state.update_running_anchors("atm_straddle", 90.0)
        state.update_running_anchors("atm_straddle", 95.0)  # rises — should not undo the low
        assert state.running_low["atm_straddle"] == 90.0

    def test_update_ignores_features_no_ladder_anchors_to(self) -> None:
        state = EngineState()
        state.update_running_anchors("untracked_feature", 5.0)
        assert "untracked_feature" not in state.running_low

    def test_reset_shared_across_ladders_on_the_same_anchor(self) -> None:
        # matches Variant D: both t1 and t2 anchor to (atm_straddle,
        # running_low) and share one reset when EITHER fires.
        state = EngineState()
        state.seed_running_anchors("atm_straddle", 100.0)
        state.update_running_anchors("atm_straddle", 60.0)
        state.reset_running_low("atm_straddle", 130.0)  # t1 fires at bar value 130
        assert state.running_low["atm_straddle"] == 130.0
        state.update_running_anchors("atm_straddle", 125.0)
        assert state.running_low["atm_straddle"] == 125.0  # still tracks the post-reset low


class TestLastFill:
    def test_record_fill_sets_last_fill(self) -> None:
        state = EngineState()
        assert state.last_fill is None
        fill = Fill(price=50.0, bar=0, lots=2, tag="entry")
        state.record_fill(fill)
        assert state.last_fill is fill
