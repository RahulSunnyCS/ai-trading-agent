"""
Unit tests for analytics/sweep.py, against the golden fixture (15 sessions,
2026-08-17 .. 2026-09-04). Uses A_flat's caps.max_lots as the swept
parameter — a small, structurally-safe field to vary via deep_merge.
"""

from datetime import date
from pathlib import Path

import pytest

from option_backtesting.analytics.sweep import render_sweep, run_sweep
from option_backtesting.data.reference.loader import ReferenceData
from tests.golden.fixture_cache import FixtureCache

STRATEGIES_DIR = Path(__file__).parent.parent.parent / "strategies"
FROM, TO = date(2026, 8, 17), date(2026, 9, 4)


@pytest.fixture()
def cache() -> FixtureCache:
    return FixtureCache()


@pytest.fixture()
def reference() -> ReferenceData:
    return ReferenceData()


@pytest.fixture()
def base_yaml() -> str:
    return (STRATEGIES_DIR / "A_flat.yaml").read_text()


def test_empty_changes_list_rejected(base_yaml, cache, reference) -> None:
    with pytest.raises(ValueError, match="at least one change-dict"):
        run_sweep(base_yaml, [], cache, reference, FROM, TO)


def test_sweep_runs_every_config_and_varies_result(base_yaml, cache, reference) -> None:
    changes_list = [
        {"strategy": {"entry": {"lots": 4}, "caps": {"max_lots": 4}}},
        {"strategy": {"entry": {"lots": 2}, "caps": {"max_lots": 2}}},
    ]
    report = run_sweep(base_yaml, changes_list, cache, reference, FROM, TO)
    assert report.n_configs == 2
    assert len(report.successful) == 2
    # Halving lots should roughly halve gross/net magnitude (same fills,
    # same fees per lot, half the lots) — a real, checkable structural
    # relationship, not just "some numbers came back".
    net_4_lots = report.configs[0].result.net_inr
    net_2_lots = report.configs[1].result.net_inr
    assert net_2_lots == pytest.approx(net_4_lots / 2, rel=0.05)


def test_invalid_config_is_recorded_not_dropped(base_yaml, cache, reference) -> None:
    changes_list = [
        {"strategy": {"caps": {"max_lots": 4}}},  # valid, no-op vs base
        {"strategy": {"caps": {"max_lots": -1}}},  # invalid: caps.max_lots must be > 0
    ]
    report = run_sweep(base_yaml, changes_list, cache, reference, FROM, TO)
    assert report.n_configs == 2
    assert len(report.successful) == 1
    failed = [c for c in report.configs if c.result is None]
    assert len(failed) == 1
    assert failed[0].error is not None


def test_config_with_no_cached_data_is_recorded_not_dropped(base_yaml, cache, reference) -> None:
    changes_list = [{"strategy": {"caps": {"max_lots": 4}}}]
    report = run_sweep(
        base_yaml, changes_list, cache, reference, date(2020, 1, 1), date(2020, 1, 2)
    )
    assert report.n_configs == 1
    assert len(report.successful) == 0
    assert "No cached sessions" in report.configs[0].error


def test_render_sweep_ranks_successful_configs_by_net_descending(
    base_yaml, cache, reference
) -> None:
    changes_list = [
        {"strategy": {"entry": {"lots": 2}, "caps": {"max_lots": 2}}},
        {"strategy": {"entry": {"lots": 4}, "caps": {"max_lots": 4}}},
    ]
    report = run_sweep(base_yaml, changes_list, cache, reference, FROM, TO)
    text = render_sweep(report)
    # config_1 (4 lots) has the larger net magnitude than config_0 (2 lots)
    # for this strategy over this window — its line must appear first.
    assert text.index("config_1") < text.index("config_0")
