"""
Unit tests for engine/margin.py: strategy_type classification and the
peak-margin / return-on-peak-margin computation. Uses hand-constructed
SessionResult objects (not the golden fixture) so the peak-lots/peak-date
tie-break and the margin arithmetic are verified independently of any
particular strategy's real trigger behaviour.
"""

from datetime import date
from pathlib import Path

import pytest

from option_backtesting.data.reference.loader import ReferenceData
from option_backtesting.engine.margin import classify_strategy_type, compute_return_on_peak_margin
from option_backtesting.engine.result import AggregateResult, SessionResult
from option_backtesting.strategy.loader import load_strategy

STRATEGIES_DIR = Path(__file__).parent.parent.parent / "strategies"


def _session(d: date, net: float, total_lots: int) -> SessionResult:
    return SessionResult(
        date=d,
        dte=1,
        net=net,
        gross=net,
        cost=0.0,
        lot_days=float(total_lots),
        peak_loss=0.0,
        total_lots=total_lots,
        exit_bar=0,
        fills=[],
    )


def _aggregate(sessions: list[SessionResult]) -> AggregateResult:
    net_inr = sum(s.net for s in sessions)
    return AggregateResult(
        net_inr=net_inr,
        gross_inr=net_inr,
        win_days=sum(1 for s in sessions if s.net > 0),
        worst_day=min([0.0, *(s.net for s in sessions)]),
        sum_peak_loss=0.0,
        worst_intraday_mtm=0.0,
        lot_days=sum(s.lot_days for s in sessions),
        inr_per_lot_day=0.0,
        dte_buckets={},
        sessions=sessions,
    )


class TestClassifyStrategyType:
    def test_short_straddle_shape_from_committed_strategies(self) -> None:
        for name in ["A_flat", "B_pyramid", "C_pyramid_fallback", "D_adaptive_trailing"]:
            strategy = load_strategy(STRATEGIES_DIR / f"{name}.yaml").strategy
            assert classify_strategy_type(strategy) == "short-straddle"

    def test_or_breakout_is_also_short_straddle_shape(self) -> None:
        # ATM CE/PE, both SELL — same 2-leg shape as the OTM1 strangle
        # variants; this module deliberately doesn't distinguish strike
        # distance (see engine/margin.py's module docstring).
        strategy = load_strategy(STRATEGIES_DIR / "or_breakout.yaml").strategy
        assert classify_strategy_type(strategy) == "short-straddle"

    def test_unclassifiable_shape_raises(self) -> None:
        strategy = load_strategy(STRATEGIES_DIR / "A_flat.yaml").strategy
        # Mutate to a single-leg shape (bypassing the DSL's own validators,
        # which don't forbid a single leg) to exercise the "no category"
        # branch without needing a second committed YAML fixture.
        single_leg = strategy.model_copy(update={"legs": strategy.legs[:1]})
        with pytest.raises(NotImplementedError, match="no margin category"):
            classify_strategy_type(single_leg)


class TestComputeReturnOnPeakMargin:
    @pytest.fixture()
    def strategy(self):
        return load_strategy(STRATEGIES_DIR / "A_flat.yaml").strategy

    @pytest.fixture()
    def reference(self) -> ReferenceData:
        return ReferenceData()

    def test_empty_sessions_returns_none(self, strategy, reference) -> None:
        assert compute_return_on_peak_margin(strategy, reference, _aggregate([])) is None

    def test_peak_margin_uses_highest_lot_session(self, strategy, reference) -> None:
        sessions = [
            _session(date(2026, 8, 17), net=1000.0, total_lots=2),
            _session(date(2026, 8, 18), net=2000.0, total_lots=4),
            _session(date(2026, 8, 19), net=-500.0, total_lots=3),
        ]
        result = _aggregate(sessions)
        margin = compute_return_on_peak_margin(strategy, reference, result)
        assert margin is not None
        assert margin.strategy_type == "short-straddle"
        assert margin.peak_lots == 4
        assert margin.peak_date == date(2026, 8, 18)
        assert margin.margin_per_lot_inr == 140000
        assert margin.peak_margin_inr == 140000 * 4
        assert margin.return_on_peak_margin == pytest.approx(result.net_inr / (140000 * 4))

    def test_tie_in_peak_lots_uses_earliest_date(self, strategy, reference) -> None:
        sessions = [
            _session(date(2026, 8, 17), net=100.0, total_lots=4),
            _session(date(2026, 8, 18), net=200.0, total_lots=4),
        ]
        margin = compute_return_on_peak_margin(strategy, reference, _aggregate(sessions))
        assert margin is not None
        assert margin.peak_date == date(2026, 8, 17)

    def test_zero_peak_margin_does_not_raise(self, strategy, reference) -> None:
        # total_lots=0 would only arise from a degenerate/never-firing
        # strategy, but the division-by-zero guard must hold regardless.
        sessions = [_session(date(2026, 8, 17), net=0.0, total_lots=0)]
        margin = compute_return_on_peak_margin(strategy, reference, _aggregate(sessions))
        assert margin is not None
        assert margin.peak_margin_inr == 0.0
        assert margin.return_on_peak_margin == 0.0

    def test_margin_lookup_uses_peak_sessions_own_date_for_effective_dating(
        self, strategy, reference
    ) -> None:
        # A session before margin.csv's earliest effective month (2026-08)
        # must raise, proving the lookup is keyed off the peak session's
        # actual date rather than e.g. today's date.
        sessions = [_session(date(2026, 1, 15), net=100.0, total_lots=4)]
        with pytest.raises(ValueError, match="No margin row"):
            compute_return_on_peak_margin(strategy, reference, _aggregate(sessions))
