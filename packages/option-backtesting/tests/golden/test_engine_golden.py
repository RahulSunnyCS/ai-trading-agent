"""
The M-3 exit criterion: the engine reproduces
`golden_15_sessions.expected.txt` to the rupee for variants A/B/C/D, each
figure checked at the precision its own section of that file uses (see
engine/loop.py's module docstring and DECISIONS.md for why the precision
varies by section — net/win-days/worst-day/sum-pkLoss/lot-days/INR-per-
lot-day are `.0f` in the 15-day aggregate, but lot-days is `.2f` in D's
10-day totals and `.1f` in the recomputed 10-day A/B/C/D sub-window).

Every number asserted here was transcribed verbatim from the original
design handoff's `golden_15_sessions.expected.txt` (now committed alongside
this file) — do not "fix" a failing assertion by changing the expected
value; a failure here means the engine has regressed, not the fixture.
"""

from pathlib import Path

import pytest

from option_backtesting.data.reference.loader import ReferenceData
from option_backtesting.engine.loop import run_backtest
from option_backtesting.engine.result import aggregate
from option_backtesting.features.evaluator import evaluate_features
from option_backtesting.strategy.loader import load_strategy
from tests.golden.fixture_cache import FixtureCache

STRATEGIES_DIR = Path(__file__).parent.parent.parent / "strategies"

# date -> (A_net, A_lots, B_net, B_lots, C_net, C_lots)
PER_SESSION_ABC = {
    "2026-08-17": (-168, 4, -84, 2, -1017, 3),
    "2026-08-18": (5552, 4, 2776, 2, 3247, 3),
    "2026-08-19": (6826, 4, 3413, 2, 3976, 3),
    "2026-08-20": (-805, 4, 1045, 4, -379, 4),
    "2026-08-21": (3017, 4, 1509, 2, 1574, 3),
    "2026-08-24": (-6265, 4, -4387, 4, -4387, 4),
    "2026-08-25": (-6577, 4, -5314, 4, -6740, 4),
    "2026-08-26": (3563, 4, 1781, 2, 2324, 3),
    "2026-08-27": (-2924, 4, -825, 4, -825, 4),
    "2026-08-28": (-1416, 4, 204, 4, 204, 4),
    "2026-08-31": (-4523, 4, -2452, 4, -2659, 4),
    "2026-09-01": (2432, 4, 3842, 4, 3842, 4),
    "2026-09-02": (2133, 4, 1067, 2, 1330, 3),
    "2026-09-03": (-168, 4, 496, 3, 496, 3),
    "2026-09-04": (6891, 4, 3445, 2, 5015, 3),
}

AGGREGATE_15D = {
    "A": {"net": 7568, "win": 7, "worst": -6577, "pk": -58136, "lots": 60, "rate": 126},
    "B": {"net": 6517, "win": 10, "worst": -5314, "pk": -41913, "lots": 39, "rate": 169},
    "C": {"net": 6003, "win": 9, "worst": -6740, "pk": -46390, "lots": 44, "rate": 138},
}

DTE_BUCKETS = {
    "A": {0: 1407, 1: -10956, 4: 8492, 5: -3897, 6: 12522},
    "B": {0: 1304, 1: -6922, 4: 5158, 5: 717, 6: 6261},
    "C": {0: 350, 1: -8062, 4: 6793, 5: -708, 6: 7630},
}

MAX_RUNUP = {
    "2026-08-17": 26.30,
    "2026-08-18": 18.15,
    "2026-08-19": 1.40,
    "2026-08-20": 28.10,
    "2026-08-21": 2.50,
    "2026-08-24": 43.30,
    "2026-08-25": 72.05,
    "2026-08-26": 7.75,
    "2026-08-27": 29.25,
    "2026-08-28": 27.65,
    "2026-08-31": 35.05,
    "2026-09-01": 42.45,
    "2026-09-02": 6.10,
    "2026-09-03": 15.25,
    "2026-09-04": 7.40,
}

D_TRADEABLE = {
    "2026-08-24": {"thr": 15.29, "net": -3675, "lots": 4, "fires": ["11:15", "11:45"]},
    "2026-08-25": {"thr": 18.69, "net": -4572, "lots": 4, "fires": ["14:45", "15:00"]},
    "2026-08-26": {"thr": 29.47, "net": 1781, "lots": 2, "fires": []},
    "2026-08-27": {"thr": 30.74, "net": -1462, "lots": 2, "fires": []},
    "2026-08-28": {"thr": 30.97, "net": -708, "lots": 2, "fires": []},
    "2026-08-31": {"thr": 36.00, "net": -2261, "lots": 2, "fires": []},
    "2026-09-01": {"thr": 34.35, "net": 4405, "lots": 4, "fires": ["11:30", "14:15"]},
    "2026-09-02": {"thr": 28.43, "net": 1067, "lots": 2, "fires": []},
    "2026-09-03": {"thr": 28.10, "net": -84, "lots": 2, "fires": []},
    "2026-09-04": {"thr": 25.30, "net": 3445, "lots": 2, "fires": []},
}

D_TOTALS_10D = {"net": -2064, "lot_days": 22.42, "rate": -92, "win_days": 4, "sum_pk": -28743}

SUBWINDOW_10D = {
    "A": {"net": -6854, "win": 4, "pk": -50817, "lots": 40.0, "rate": -171},
    "B": {"net": -2142, "win": 6, "pk": -37503, "lots": 27.8, "rate": -77},
    "C": {"net": -1398, "win": 6, "pk": -39136, "lots": 30.3, "rate": -46},
    "D": {"net": -2064, "win": 4, "pk": -28743, "lots": 22.4, "rate": -92},
}

STRATEGY_FILES = {"A": "A_flat.yaml", "B": "B_pyramid.yaml", "C": "C_pyramid_fallback.yaml"}


@pytest.fixture(scope="module")
def cache() -> FixtureCache:
    return FixtureCache()


@pytest.fixture(scope="module")
def reference() -> ReferenceData:
    return ReferenceData()


def _run(name: str, cache: FixtureCache, reference: ReferenceData):
    loaded = load_strategy(STRATEGIES_DIR / name)
    sessions = run_backtest(loaded, cache, reference, cache.ordered_dates[0], cache.ordered_dates[-1])
    return loaded, sessions


class TestPerSessionABC:
    def test_every_session_net_and_lots(self, cache: FixtureCache, reference: ReferenceData) -> None:
        for key, filename in STRATEGY_FILES.items():
            idx_net, idx_lots = {"A": (0, 1), "B": (2, 3), "C": (4, 5)}[key]
            _, sessions = _run(filename, cache, reference)
            by_date = {s.date.isoformat(): s for s in sessions}
            for d_str, values in PER_SESSION_ABC.items():
                s = by_date[d_str]
                assert round(s.net) == values[idx_net], f"{key} {d_str} net"
                assert s.total_lots == values[idx_lots], f"{key} {d_str} lots"


class TestAggregate15Day:
    @pytest.mark.parametrize("key", ["A", "B", "C"])
    def test_aggregate_matches(self, cache: FixtureCache, reference: ReferenceData, key: str) -> None:
        _, sessions = _run(STRATEGY_FILES[key], cache, reference)
        result = aggregate(sessions)
        expected = AGGREGATE_15D[key]
        assert round(result.net_inr) == expected["net"]
        assert result.win_days == expected["win"]
        assert round(result.worst_day) == expected["worst"]
        assert round(result.sum_peak_loss) == expected["pk"]
        assert round(result.lot_days) == expected["lots"]
        assert round(result.inr_per_lot_day) == expected["rate"]

    @pytest.mark.parametrize("key", ["A", "B", "C"])
    def test_dte_buckets_match(self, cache: FixtureCache, reference: ReferenceData, key: str) -> None:
        _, sessions = _run(STRATEGY_FILES[key], cache, reference)
        result = aggregate(sessions)
        rounded = {dte: round(net) for dte, net in result.dte_buckets.items()}
        assert rounded == DTE_BUCKETS[key]


class TestVariantD:
    def _feature_store_and_sessions(self, cache: FixtureCache, reference: ReferenceData):
        loaded = load_strategy(STRATEGIES_DIR / "D_adaptive_trailing.yaml")
        _, sessions = _run("D_adaptive_trailing.yaml", cache, reference)
        bar_times_by_date = {d: cache.bar_times for d in cache.ordered_dates}
        store = evaluate_features(
            loaded.features,
            loaded.strategy.universe,
            cache,
            reference,
            cache.ordered_dates,
            bar_times_by_date,
        )
        return sessions, store

    def test_max_runup_for_every_session(self, cache: FixtureCache, reference: ReferenceData) -> None:
        _, store = self._feature_store_and_sessions(cache, reference)
        for d in cache.ordered_dates:
            got = store.scalar_value("straddle_runup", d)
            assert got == pytest.approx(MAX_RUNUP[d.isoformat()], abs=0.01), d.isoformat()

    def test_threshold_net_lots_and_fires_for_every_tradeable_day(
        self, cache: FixtureCache, reference: ReferenceData
    ) -> None:
        sessions, store = self._feature_store_and_sessions(cache, reference)
        by_date = {s.date.isoformat(): s for s in sessions}
        for d_str, expected in D_TRADEABLE.items():
            thr = store.scalar_value("spike_thr_5d", by_date[d_str].date)
            assert thr == pytest.approx(expected["thr"], abs=0.01), f"{d_str} thr"

            s = by_date[d_str]
            assert round(s.net) == expected["net"], f"{d_str} net"
            assert s.total_lots == expected["lots"], f"{d_str} lots"

            fires = sorted(f.bar for f in s.fills if f.tag in ("t1", "t2"))
            fire_times = [cache.bar_times[b].strftime("%H:%M") for b in fires]
            assert fire_times == expected["fires"], f"{d_str} fires"

    def test_10_day_totals(self, cache: FixtureCache, reference: ReferenceData) -> None:
        sessions, _store = self._feature_store_and_sessions(cache, reference)
        tradeable = sessions[-10:]
        result = aggregate(tradeable)
        assert round(result.net_inr) == D_TOTALS_10D["net"]
        assert round(result.lot_days, 2) == D_TOTALS_10D["lot_days"]
        assert round(result.inr_per_lot_day) == D_TOTALS_10D["rate"]
        assert result.win_days == D_TOTALS_10D["win_days"]
        assert round(result.sum_peak_loss) == D_TOTALS_10D["sum_pk"]


class TestRecomputed10DaySubwindow:
    @pytest.mark.parametrize("key", ["A", "B", "C"])
    def test_abc_over_the_10_tradeable_days(
        self, cache: FixtureCache, reference: ReferenceData, key: str
    ) -> None:
        _, sessions = _run(STRATEGY_FILES[key], cache, reference)
        result = aggregate(sessions[-10:])
        expected = SUBWINDOW_10D[key]
        assert round(result.net_inr) == expected["net"]
        assert result.win_days == expected["win"]
        assert round(result.sum_peak_loss) == expected["pk"]
        assert round(result.lot_days, 1) == expected["lots"]
        assert round(result.inr_per_lot_day) == expected["rate"]

    def test_d_over_the_10_tradeable_days(self, cache: FixtureCache, reference: ReferenceData) -> None:
        _, sessions = _run("D_adaptive_trailing.yaml", cache, reference)
        result = aggregate(sessions[-10:])
        expected = SUBWINDOW_10D["D"]
        assert round(result.net_inr) == expected["net"]
        assert result.win_days == expected["win"]
        assert round(result.sum_peak_loss) == expected["pk"]
        assert round(result.lot_days, 1) == expected["lots"]
        assert round(result.inr_per_lot_day) == expected["rate"]
