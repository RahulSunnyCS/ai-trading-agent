"""
Structural checks on the golden fixture data artifact itself (not the engine
— the engine doesn't exist until M-3, whose exit criterion is reproducing
`golden_15_sessions.expected.txt` to the rupee using this exact fixture).
This just pins that the JSON conversion from the original `golden_15_sessions.py`
literals didn't silently drop or corrupt anything.
"""

import json
from pathlib import Path

FIXTURE_PATH = Path(__file__).parent / "fixture_15_sessions.json"

EXPECTED_DTE_BY_DATE = {
    "2026-08-17": 1, "2026-08-18": 0, "2026-08-19": 6, "2026-08-20": 5, "2026-08-21": 4,
    "2026-08-24": 1, "2026-08-25": 0, "2026-08-26": 6, "2026-08-27": 5, "2026-08-28": 4,
    "2026-08-31": 1, "2026-09-01": 0, "2026-09-02": 6, "2026-09-03": 5, "2026-09-04": 4,
}


def load_fixture() -> dict:
    with open(FIXTURE_PATH) as f:
        return json.load(f)


def test_fifteen_sessions_in_date_order() -> None:
    fx = load_fixture()
    dates = [s["date"] for s in fx["sessions"]]
    assert len(dates) == 15
    assert dates == sorted(dates)
    assert dates[0] == "2026-08-17"
    assert dates[-1] == "2026-09-04"


def test_dte_matches_known_values() -> None:
    fx = load_fixture()
    for s in fx["sessions"]:
        assert s["dte"] == EXPECTED_DTE_BY_DATE[s["date"]], s["date"]


def test_every_session_has_24_bars_across_all_four_series() -> None:
    fx = load_fixture()
    for s in fx["sessions"]:
        for series in ("atm_ce", "atm_pe", "otm1_ce", "otm1_pe"):
            assert len(s[series]["closes"]) == 24, f"{s['date']} {series}"


def test_meta_matches_lot_size_and_fix_time_used_by_the_reference_loader() -> None:
    fx = load_fixture()
    assert fx["meta"]["lot_size"] == 65
    assert fx["meta"]["fix_time"] == "09:17"
    assert fx["meta"]["underlying"] == "NIFTY"


def test_0904_matches_the_real_algotest_response_used_in_test_ingest_cache() -> None:
    """Cross-check against tests/unit/test_ingest_cache.py's real AlgoTest
    response — the fixture's 0904 row and the actual vendor pull must agree,
    since both are meant to be the same real session."""
    fx = load_fixture()
    s = next(s for s in fx["sessions"] if s["date"] == "2026-09-04")
    assert s["atm_ce"]["open"] == 101.7
    assert s["atm_ce"]["closes"][0] == 104.65
    assert s["atm_ce"]["closes"][1] == 105.65
    assert s["atm_ce"]["closes"][-1] == 102.9
