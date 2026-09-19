"""
Unit tests for analytics/walkforward.py, against the golden fixture's 15
sessions (2026-08-17 .. 2026-09-04) split into a 9-session in-sample window
and a 6-session out-of-sample window.
"""

from datetime import date
from pathlib import Path

import pytest

from option_backtesting.analytics.walkforward import render_walkforward, run_walkforward
from option_backtesting.data.reference.loader import ReferenceData
from option_backtesting.engine.loop import run_backtest
from option_backtesting.engine.result import aggregate
from option_backtesting.strategy.loader import load_strategy
from tests.golden.fixture_cache import FixtureCache

STRATEGIES_DIR = Path(__file__).parent.parent.parent / "strategies"

IS_FROM, IS_TO = date(2026, 8, 17), date(2026, 8, 27)
OOS_FROM, OOS_TO = date(2026, 8, 28), date(2026, 9, 4)


@pytest.fixture()
def cache() -> FixtureCache:
    return FixtureCache()


@pytest.fixture()
def reference() -> ReferenceData:
    return ReferenceData()


def test_walkforward_splits_match_independent_direct_runs(cache, reference) -> None:
    loaded = load_strategy(STRATEGIES_DIR / "A_flat.yaml")
    result = run_walkforward(loaded, cache, reference, IS_FROM, IS_TO, OOS_FROM, OOS_TO)

    expected_is = aggregate(run_backtest(loaded, cache, reference, IS_FROM, IS_TO))
    expected_oos = aggregate(run_backtest(loaded, cache, reference, OOS_FROM, OOS_TO))

    assert result.in_sample.net_inr == expected_is.net_inr
    assert result.out_of_sample.net_inr == expected_oos.net_inr
    assert len(result.in_sample.sessions) == 9
    assert len(result.out_of_sample.sessions) == 6


def test_overlapping_windows_rejected(cache, reference) -> None:
    loaded = load_strategy(STRATEGIES_DIR / "A_flat.yaml")
    with pytest.raises(ValueError, match="must start strictly after"):
        run_walkforward(loaded, cache, reference, IS_FROM, IS_TO, IS_TO, OOS_TO)


def test_backwards_windows_rejected(cache, reference) -> None:
    loaded = load_strategy(STRATEGIES_DIR / "A_flat.yaml")
    with pytest.raises(ValueError, match="must start strictly after"):
        run_walkforward(loaded, cache, reference, OOS_FROM, OOS_TO, IS_FROM, IS_TO)


def test_empty_in_sample_window_raises(cache, reference) -> None:
    loaded = load_strategy(STRATEGIES_DIR / "A_flat.yaml")
    with pytest.raises(ValueError, match="No cached sessions for the in-sample"):
        run_walkforward(
            loaded, cache, reference, date(2020, 1, 1), date(2020, 1, 2), OOS_FROM, OOS_TO
        )


def test_empty_out_of_sample_window_raises(cache, reference) -> None:
    loaded = load_strategy(STRATEGIES_DIR / "A_flat.yaml")
    with pytest.raises(ValueError, match="No cached sessions for the out-of-sample"):
        run_walkforward(
            loaded, cache, reference, IS_FROM, IS_TO, date(2030, 1, 1), date(2030, 1, 2)
        )


def test_render_headlines_out_of_sample_first(cache, reference) -> None:
    loaded = load_strategy(STRATEGIES_DIR / "A_flat.yaml")
    result = run_walkforward(loaded, cache, reference, IS_FROM, IS_TO, OOS_FROM, OOS_TO)
    text = render_walkforward(result)
    oos_idx = text.index("OUT-OF-SAMPLE")
    is_idx = text.index("in-sample (reference only)")
    assert oos_idx < is_idx
