"""
Unit tests for engine/result.py's aggregate()/bootstrap_ci()/render_report(),
plus an end-to-end aggregate() check against the golden fixture's real A/B/C
15-day aggregate figures — the second half of the golden parity test's
assertions (per-session net/lots is covered in test_engine_loop.py /
tests/golden/test_engine_golden.py), isolated here so an aggregate-formula
regression is caught without needing the full golden test to fail first.
"""

from datetime import date
from pathlib import Path

import pytest

from option_backtesting.data.reference.loader import ReferenceData
from option_backtesting.engine.loop import run_backtest
from option_backtesting.engine.result import aggregate, bootstrap_ci
from option_backtesting.strategy.loader import load_strategy
from tests.golden.fixture_cache import FixtureCache

STRATEGIES_DIR = Path(__file__).parent.parent.parent / "strategies"


def _make_session_result(d: date, net: float, peak_loss: float, lot_days: float, dte: int):
    from option_backtesting.engine.result import SessionResult

    return SessionResult(
        date=d,
        dte=dte,
        net=net,
        gross=net,
        cost=0.0,
        lot_days=lot_days,
        peak_loss=peak_loss,
        total_lots=2,
        exit_bar=0,
        fills=[],
    )


class TestAggregateFormulas:
    def test_win_days_counts_strictly_positive_nets(self) -> None:
        sessions = [
            _make_session_result(date(2026, 1, 1), 100.0, 0.0, 1.0, 0),
            _make_session_result(date(2026, 1, 2), -50.0, -50.0, 1.0, 1),
            _make_session_result(date(2026, 1, 3), 0.0, 0.0, 1.0, 2),
        ]
        result = aggregate(sessions)
        assert result.win_days == 1

    def test_worst_day_floors_at_zero_when_never_negative(self) -> None:
        sessions = [_make_session_result(date(2026, 1, 1), 100.0, 0.0, 1.0, 0)]
        assert aggregate(sessions).worst_day == 0.0

    def test_sum_peak_loss_sums_not_mins(self) -> None:
        sessions = [
            _make_session_result(date(2026, 1, 1), 0.0, -100.0, 1.0, 0),
            _make_session_result(date(2026, 1, 2), 0.0, -50.0, 1.0, 1),
        ]
        result = aggregate(sessions)
        assert result.sum_peak_loss == -150.0
        assert result.worst_intraday_mtm == -100.0  # min(), distinct field

    def test_inr_per_lot_day_divides_net_by_lot_days(self) -> None:
        sessions = [_make_session_result(date(2026, 1, 1), 200.0, 0.0, 4.0, 0)]
        assert aggregate(sessions).inr_per_lot_day == 50.0

    def test_zero_lot_days_does_not_divide_by_zero(self) -> None:
        sessions = [_make_session_result(date(2026, 1, 1), 0.0, 0.0, 0.0, 0)]
        assert aggregate(sessions).inr_per_lot_day == 0.0

    def test_dte_buckets_group_and_sum_net(self) -> None:
        sessions = [
            _make_session_result(date(2026, 1, 1), 100.0, 0.0, 1.0, 5),
            _make_session_result(date(2026, 1, 2), 50.0, 0.0, 1.0, 5),
            _make_session_result(date(2026, 1, 3), -20.0, 0.0, 1.0, 1),
        ]
        result = aggregate(sessions)
        assert result.dte_buckets == {5: 150.0, 1: -20.0}

    def test_empty_sessions_do_not_crash(self) -> None:
        result = aggregate([])
        assert result.net_inr == 0.0
        assert result.worst_intraday_mtm == 0.0
        assert result.inr_per_lot_day == 0.0


class TestBootstrapCI:
    def test_deterministic_given_a_fixed_seed(self) -> None:
        nets = [100.0, -50.0, 200.0, -10.0, 30.0]
        lot_days = [4.0, 4.0, 2.0, 2.0, 4.0]
        a = bootstrap_ci(nets, lot_days, n_resamples=500, seed=42)
        b = bootstrap_ci(nets, lot_days, n_resamples=500, seed=42)
        assert a == b

    def test_different_seeds_can_differ(self) -> None:
        nets = [100.0, -50.0, 200.0, -10.0, 30.0]
        lot_days = [4.0, 4.0, 2.0, 2.0, 4.0]
        a = bootstrap_ci(nets, lot_days, n_resamples=500, seed=1)
        b = bootstrap_ci(nets, lot_days, n_resamples=500, seed=2)
        assert a != b

    def test_empty_input_does_not_crash(self) -> None:
        ci = bootstrap_ci([], [], n_resamples=100, seed=0)
        assert ci.net_lo == 0.0
        assert ci.net_hi == 0.0


class TestAggregateAgainstGoldenFixture:
    @pytest.mark.parametrize(
        ("strategy_file", "expected"),
        [
            (
                "A_flat.yaml",
                {"net_inr": 7568, "win_days": 7, "worst_day": -6577, "sum_peak_loss": -58136, "lot_days": 60, "inr_per_lot_day": 126},
            ),
            (
                "B_pyramid.yaml",
                {"net_inr": 6517, "win_days": 10, "worst_day": -5314, "sum_peak_loss": -41913, "lot_days": 39, "inr_per_lot_day": 169},
            ),
            (
                "C_pyramid_fallback.yaml",
                {"net_inr": 6003, "win_days": 9, "worst_day": -6740, "sum_peak_loss": -46390, "lot_days": 44, "inr_per_lot_day": 138},
            ),
        ],
    )
    def test_15_day_aggregate_matches_golden_expected_txt(self, strategy_file: str, expected: dict) -> None:
        loaded = load_strategy(STRATEGIES_DIR / strategy_file)
        cache = FixtureCache()
        reference = ReferenceData()
        sessions = run_backtest(
            loaded, cache, reference, cache.ordered_dates[0], cache.ordered_dates[-1]
        )
        result = aggregate(sessions)
        assert round(result.net_inr) == expected["net_inr"]
        assert result.win_days == expected["win_days"]
        assert round(result.worst_day) == expected["worst_day"]
        assert round(result.sum_peak_loss) == expected["sum_peak_loss"]
        assert round(result.lot_days) == expected["lot_days"]
        assert round(result.inr_per_lot_day) == expected["inr_per_lot_day"]

    def test_dte_bucket_table_matches_golden_expected_txt_for_variant_a(self) -> None:
        loaded = load_strategy(STRATEGIES_DIR / "A_flat.yaml")
        cache = FixtureCache()
        reference = ReferenceData()
        sessions = run_backtest(
            loaded, cache, reference, cache.ordered_dates[0], cache.ordered_dates[-1]
        )
        result = aggregate(sessions)
        expected = {0: 1407, 1: -10956, 4: 8492, 5: -3897, 6: 12522}
        rounded = {dte: round(net) for dte, net in result.dte_buckets.items()}
        assert rounded == expected
