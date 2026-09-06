"""
Integration checkpoint for features/evaluator.py's two-pass orchestration,
using the real golden fixture (via FixtureCache) rather than synthetic data —
reproduces Variant D's full `spike_thr_5d` chain (`atm_straddle` -> leg_sum,
`straddle_runup` -> max_runup, `spike_thr_5d` -> rolling_mean(lag=1)) end to
end and checks it against `golden_15_sessions.expected.txt`'s `thr(avg5)`
column. This is the strongest available regression gate before engine/loop.py
exists to run the golden parity test itself.
"""

from datetime import date
from pathlib import Path

import pytest

from option_backtesting.data.reference.loader import ReferenceData
from option_backtesting.features.evaluator import evaluate_features
from option_backtesting.strategy.loader import load_strategy
from tests.golden.fixture_cache import FixtureCache

_STRATEGIES_DIR = Path(__file__).parent.parent.parent / "strategies"

EXPECTED_THR_AVG5 = {
    "2026-08-24": 15.29,
    "2026-08-25": 18.69,
    "2026-08-26": 29.47,
    "2026-08-27": 30.74,
    "2026-08-28": 30.97,
    "2026-08-31": 36.00,
    "2026-09-01": 34.35,
    "2026-09-02": 28.43,
    "2026-09-03": 28.10,
    "2026-09-04": 25.30,
}


def _build_store():
    loaded = load_strategy(_STRATEGIES_DIR / "D_adaptive_trailing.yaml")
    cache = FixtureCache()
    bar_times_by_date = {d: cache.bar_times for d in cache.ordered_dates}
    store = evaluate_features(
        loaded.features,
        loaded.strategy.universe,
        cache,
        reference=ReferenceData(),  # this strategy declares no days_to_expiry/gap features
        ordered_dates=cache.ordered_dates,
        bar_times_by_date=bar_times_by_date,
    )
    return store, cache


def test_spike_thr_5d_matches_golden_fixture_for_every_tradeable_day() -> None:
    store, _cache = _build_store()
    for d_str, expected in EXPECTED_THR_AVG5.items():
        d = date.fromisoformat(d_str)
        got = store.scalar_value("spike_thr_5d", d)
        assert got == pytest.approx(expected, abs=0.01), d_str


def test_first_five_calibration_days_have_no_threshold_yet() -> None:
    store, cache = _build_store()
    for d in cache.ordered_dates[:5]:
        with pytest.raises(KeyError):
            store.scalar_value("spike_thr_5d", d)
