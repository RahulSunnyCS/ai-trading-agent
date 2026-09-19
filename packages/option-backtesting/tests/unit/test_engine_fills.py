"""
Unit tests for engine/fills.py — pinned against hand-computed values so a
regression here is caught before it ever reaches the golden-fixture parity
test (tests/golden/test_engine_golden.py), which is much harder to debug
from a failing rupee-level assertion alone.
"""

from option_backtesting.engine.fills import (
    apply_slippage,
    bar_close_fill,
    next_open_fill,
    trigger_level_fill,
    worst_of_bar_fill,
)


class TestTriggerLevelFill:
    def test_bar_zero_uses_session_open_as_start_of_bar(self) -> None:
        # trigger opens at 100, closes bar-0 at 110 (span=10); traded opens
        # at 50, closes bar-0 at 60. Crossing level=105 is 50% of the way
        # through the trigger's move -> traded should be 50% of the way
        # through its own move: 50 + 0.5*(60-50) = 55.
        trigger = [110.0, 120.0]
        traded = [60.0, 70.0]
        assert trigger_level_fill(trigger, traded, 100.0, 50.0, bar=0, level=105.0) == 55.0

    def test_later_bar_uses_previous_bar_close_as_start_of_bar(self) -> None:
        trigger = [100.0, 110.0, 130.0]
        traded = [40.0, 50.0, 70.0]
        # bar=2: prev_trigger=110, span=20, level=120 -> frac=0.5
        # prev_traded=50, traded[2]=70 -> 50 + 0.5*20 = 60
        assert trigger_level_fill(trigger, traded, 100.0, 40.0, bar=2, level=120.0) == 60.0

    def test_nonpositive_span_falls_back_to_bar_close(self) -> None:
        # trigger fell over the bar (span <= 0) -> no proportional move to
        # interpolate against, use the traded series' own bar close.
        trigger = [90.0]  # fell from open 100
        traded = [42.0]
        assert trigger_level_fill(trigger, traded, 100.0, 50.0, bar=0, level=95.0) == 42.0

    def test_level_equal_to_trigger_bar_value_degenerates_to_bar_close(self) -> None:
        # Variant D's dynamic-anchor ladders pass level = trigger[bar] itself
        # -> frac = (trigger[bar]-prev)/(trigger[bar]-prev) = 1.0 whenever
        # span > 0, so the result must equal the traded series' bar close.
        trigger = [100.0, 115.0]
        traded = [40.0, 61.0]
        assert trigger_level_fill(trigger, traded, 100.0, 40.0, bar=1, level=115.0) == 61.0

    def test_frac_clamped_to_unit_interval(self) -> None:
        trigger = [110.0]
        traded = [60.0]
        # level far below the bar's start -> frac would be negative, clamp to 0
        assert trigger_level_fill(trigger, traded, 100.0, 50.0, bar=0, level=50.0) == 50.0
        # level far above the bar's close -> frac would exceed 1, clamp to 1
        assert trigger_level_fill(trigger, traded, 100.0, 50.0, bar=0, level=500.0) == 60.0


class TestBarCloseFill:
    def test_returns_bar_close_unconditionally(self) -> None:
        assert bar_close_fill([10.0, 20.0, 30.0], bar=1) == 20.0


class TestWorstOfBarFill:
    def test_sell_worst_is_bar_high(self) -> None:
        assert worst_of_bar_fill(bar_high=120.0, bar_low=80.0, side="SELL") == 120.0

    def test_buy_worst_is_bar_low(self) -> None:
        assert worst_of_bar_fill(bar_high=120.0, bar_low=80.0, side="BUY") == 80.0


class TestNextOpenFill:
    def test_uses_next_bar_open_when_available(self) -> None:
        assert next_open_fill(next_bar_open=55.0, this_bar_close=50.0) == 55.0

    def test_falls_back_to_this_bar_close_on_last_bar(self) -> None:
        assert next_open_fill(next_bar_open=None, this_bar_close=50.0) == 50.0


class TestApplySlippage:
    def test_zero_bps_is_a_no_op(self) -> None:
        assert apply_slippage(100.0, 0.0, "SELL") == 100.0

    def test_sell_slippage_reduces_price(self) -> None:
        # 25 bps of 100 = 0.25
        assert apply_slippage(100.0, 25.0, "SELL") == 99.75

    def test_buy_slippage_increases_price(self) -> None:
        assert apply_slippage(100.0, 25.0, "BUY") == 100.25
