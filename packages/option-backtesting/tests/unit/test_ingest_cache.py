"""
Raw JSON -> Parquet -> DuckDB round-trip. The OHLC candles used here are the
REAL response AlgoTest's MCP tool returned for NIFTY ATM CE, 4 Sep 2026, 15m,
FIXED fix_time 09:17 (fetched and hand-verified against the golden fixture's
0904 row during the planning phase of this epic) — so this test both proves
the ingest/cache pipeline and pins that the real vendor data matches the
golden fixture to the rupee for at least one full session.
"""

from datetime import date
from pathlib import Path

import pytest

from option_backtesting.data.cache import Cache
from option_backtesting.data.ingest import ingest_date
from option_backtesting.data.providers.algotest import plan_requests
from option_backtesting.data.providers.base import SessionFlag
from option_backtesting.data.raw import raw_path, write_raw

# Verbatim AlgoTest response: NIFTY OPT ATM CE, 15m, FIXED 09:17, 2026-09-04.
REAL_NIFTY_ATM_CE_0904 = {
    "candles": [
        {"datetime": "2026-09-04T09:30:00", "open": 101.7, "high": 110.6, "low": 101.7, "close": 104.65, "volume": 19432010.0},
        {"datetime": "2026-09-04T09:45:00", "open": 104.55, "high": 107.55, "low": 100.0, "close": 105.65, "volume": 12308140.0},
        {"datetime": "2026-09-04T10:00:00", "open": 105.55, "high": 124.2, "low": 105.5, "close": 120.35, "volume": 24662430.0},
        {"datetime": "2026-09-04T10:15:00", "open": 120.9, "high": 128.4, "low": 110.9, "close": 113.5, "volume": 15360085.0},
        {"datetime": "2026-09-04T10:30:00", "open": 113.5, "high": 127.95, "low": 110.05, "close": 127.95, "volume": 14937390.0},
        {"datetime": "2026-09-04T10:45:00", "open": 127.8, "high": 132.9, "low": 121.3, "close": 124.9, "volume": 12814620.0},
        {"datetime": "2026-09-04T11:00:00", "open": 125.0, "high": 130.0, "low": 124.05, "close": 128.75, "volume": 6228105.0},
        {"datetime": "2026-09-04T11:15:00", "open": 128.75, "high": 131.35, "low": 122.0, "close": 122.0, "volume": 8324225.0},
        {"datetime": "2026-09-04T11:30:00", "open": 122.75, "high": 132.3, "low": 119.8, "close": 129.45, "volume": 10589800.0},
        {"datetime": "2026-09-04T11:45:00", "open": 129.2, "high": 146.0, "low": 129.15, "close": 133.9, "volume": 12193545.0},
        {"datetime": "2026-09-04T12:00:00", "open": 134.55, "high": 141.2, "low": 133.4, "close": 134.35, "volume": 4820010.0},
        {"datetime": "2026-09-04T12:15:00", "open": 134.0, "high": 134.0, "low": 115.2, "close": 117.25, "volume": 9467900.0},
        {"datetime": "2026-09-04T12:30:00", "open": 116.65, "high": 117.65, "low": 103.95, "close": 109.5, "volume": 11619400.0},
        {"datetime": "2026-09-04T12:45:00", "open": 109.75, "high": 110.35, "low": 103.3, "close": 104.3, "volume": 6312410.0},
        {"datetime": "2026-09-04T13:00:00", "open": 104.05, "high": 109.8, "low": 96.85, "close": 103.3, "volume": 11120850.0},
        {"datetime": "2026-09-04T13:15:00", "open": 102.95, "high": 113.85, "low": 102.1, "close": 110.0, "volume": 9818900.0},
        {"datetime": "2026-09-04T13:30:00", "open": 110.35, "high": 118.3, "low": 104.5, "close": 106.2, "volume": 13436475.0},
        {"datetime": "2026-09-04T13:45:00", "open": 106.15, "high": 108.05, "low": 101.15, "close": 104.65, "volume": 8806980.0},
        {"datetime": "2026-09-04T14:00:00", "open": 105.25, "high": 111.45, "low": 101.1, "close": 103.95, "volume": 8991645.0},
        {"datetime": "2026-09-04T14:15:00", "open": 103.9, "high": 111.0, "low": 103.7, "close": 109.5, "volume": 5652075.0},
        {"datetime": "2026-09-04T14:30:00", "open": 109.75, "high": 118.1, "low": 105.25, "close": 116.2, "volume": 10556000.0},
        {"datetime": "2026-09-04T14:45:00", "open": 115.9, "high": 120.0, "low": 99.0, "close": 99.4, "volume": 17424745.0},
        {"datetime": "2026-09-04T15:00:00", "open": 100.85, "high": 104.25, "low": 96.55, "close": 102.3, "volume": 10480665.0},
        {"datetime": "2026-09-04T15:15:00", "open": 102.0, "high": 106.0, "low": 97.65, "close": 102.9, "volume": 10624965.0},
        {"datetime": "2026-09-04T15:30:00", "open": 102.25, "high": 106.0, "low": 84.15, "close": 87.0, "volume": 17514185.0},
        {"datetime": "2026-09-04T15:40:00", "open": 87.5, "high": 90.65, "low": 87.15, "close": 89.9, "volume": 4803175.0},
    ]
}

# From golden_15_sessions.py's AC["0904"]: (open, [24 closes]).
GOLDEN_0904_ATM_CE_OPEN = 101.7
GOLDEN_0904_ATM_CE_CLOSES = [
    104.65, 105.65, 120.35, 113.5, 127.95, 124.9, 128.75, 122.0, 129.45, 133.9,
    134.35, 117.25, 109.5, 104.3, 103.3, 110.0, 106.2, 104.65, 103.95, 109.5,
    116.2, 99.4, 102.3, 102.9,
]


@pytest.fixture()
def request_for_0904() -> dict:
    reqs = plan_requests("NIFTY", date(2026, 9, 4), date(2026, 9, 4))
    return next(
        r
        for r in reqs
        if r["kind"] == "ohlc"
        and r["timeframe"] == "15m"
        and r["raw_key"]["strike_rule"] == "ATM"
        and r["raw_key"]["leg"] == "CE"
    )


def test_ingest_writes_parquet_matching_golden_fixture(
    tmp_path: Path, request_for_0904: dict
) -> None:
    raw_dir = tmp_path / "raw"
    cache_dir = tmp_path / "cache"

    written = write_raw(raw_dir / "algotest", request_for_0904, REAL_NIFTY_ATM_CE_0904)
    assert written == raw_path(raw_dir / "algotest", request_for_0904)

    result = ingest_date("NIFTY", date(2026, 9, 4), raw_dir=raw_dir / "algotest", cache_dir=cache_dir)
    assert result.bars_written == 26

    cache = Cache(cache_dir)
    bars = cache.get_opt_bars("NIFTY", "15m", "ATM", "CE", date(2026, 9, 4), date(2026, 9, 4))
    assert len(bars) == 26

    # 24 REGULAR bars whose closes match the golden fixture to the rupee.
    regular = [b for b in bars if b.session == SessionFlag.REGULAR]
    assert len(regular) == 24
    assert [b.close for b in regular] == GOLDEN_0904_ATM_CE_CLOSES
    assert regular[0].open == GOLDEN_0904_ATM_CE_OPEN

    # The 15:30 and 15:40 candles are tagged POST, never dropped.
    post = [b for b in bars if b.session == SessionFlag.POST]
    assert len(post) == 2
    assert {b.ts.strftime("%H:%M") for b in post} == {"15:30", "15:40"}


def test_ingest_is_idempotent_across_three_merges(tmp_path: Path, request_for_0904: dict) -> None:
    """A real regression: merging the same file a THIRD time used to crash
    with 'duplicate column _source', because the second merge's output
    accidentally leaked its internal tie-break column into the written
    Parquet file, so the next merge's read-back collided with it. Two
    merges alone don't exercise this — it needs a merge onto an
    already-once-merged file."""
    raw_dir = tmp_path / "raw"
    cache_dir = tmp_path / "cache"
    write_raw(raw_dir / "algotest", request_for_0904, REAL_NIFTY_ATM_CE_0904)

    for _ in range(3):
        ingest_date("NIFTY", date(2026, 9, 4), raw_dir=raw_dir / "algotest", cache_dir=cache_dir)

    cache = Cache(cache_dir)
    bars = cache.get_opt_bars("NIFTY", "15m", "ATM", "CE", date(2026, 9, 4), date(2026, 9, 4))
    assert len(bars) == 26  # not doubled/tripled by the repeated ingests


def test_identical_series_gate_fires_on_the_3_sep_style_collision(tmp_path: Path) -> None:
    """Reproduces the actual failure mode: if ATM PE and OTM1 PE raw files
    ever contain byte-identical candles, ingest_date must flag it."""
    raw_dir = tmp_path / "raw"
    cache_dir = tmp_path / "cache"
    day = date(2026, 9, 3)

    reqs = plan_requests("NIFTY", day, day)
    atm_pe_req = next(
        r for r in reqs if r["raw_key"]["strike_rule"] == "ATM" and r["raw_key"]["leg"] == "PE"
        and r["timeframe"] == "15m"
    )
    otm1_pe_req = next(
        r for r in reqs if r["raw_key"]["strike_rule"] == "OTM1" and r["raw_key"]["leg"] == "PE"
        and r["timeframe"] == "15m"
    )
    identical_response = {
        "candles": [
            {"datetime": "2026-09-03T09:30:00", "open": 92.0, "high": 98.05, "low": 82.5, "close": 98.05, "volume": 100.0},
            {"datetime": "2026-09-03T09:45:00", "open": 98.05, "high": 85.15, "low": 82.5, "close": 82.5, "volume": 100.0},
        ]
    }
    write_raw(raw_dir / "algotest", atm_pe_req, identical_response)
    write_raw(raw_dir / "algotest", otm1_pe_req, identical_response)

    result = ingest_date("NIFTY", day, raw_dir=raw_dir / "algotest", cache_dir=cache_dir)

    collision_flags = [f for f in result.flags if f.gate == "identical_series"]
    assert len(collision_flags) >= 1
    assert collision_flags[0].severity == "error"
