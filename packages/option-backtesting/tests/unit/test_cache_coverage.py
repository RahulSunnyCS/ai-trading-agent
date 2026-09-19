from datetime import date
from pathlib import Path

from option_backtesting.data.cache import Cache
from option_backtesting.data.ingest import ingest_date
from option_backtesting.data.providers.algotest import plan_requests
from option_backtesting.data.raw import write_raw

_ATM_CE_CANDLES = {
    "candles": [
        {"datetime": "2026-09-04T09:30:00", "open": 101.7, "high": 110.6, "low": 101.7, "close": 104.65, "volume": 1.0},
        {"datetime": "2026-09-04T09:45:00", "open": 104.55, "high": 107.55, "low": 100.0, "close": 105.65, "volume": 1.0},
        {"datetime": "2026-09-04T10:00:00", "open": 105.55, "high": 124.2, "low": 105.5, "close": 120.35, "volume": 1.0},
        {"datetime": "2026-09-04T10:15:00", "open": 120.9, "high": 128.4, "low": 110.9, "close": 113.5, "volume": 1.0},
    ]
}


def _request_for(underlying: str, d: date) -> dict:
    reqs = plan_requests(underlying, d, d)
    return next(
        r
        for r in reqs
        if r["kind"] == "ohlc"
        and r["timeframe"] == "15m"
        and r["raw_key"]["strike_rule"] == "ATM"
        and r["raw_key"]["leg"] == "CE"
    )


def test_coverage_reports_start_and_end_per_timeframe(tmp_path: Path) -> None:
    raw_dir = tmp_path / "raw" / "algotest"
    cache_dir = tmp_path / "cache"
    d = date(2026, 9, 4)
    req = _request_for("NIFTY", d)
    write_raw(raw_dir, req, _ATM_CE_CANDLES)
    ingest_date("NIFTY", d, raw_dir=raw_dir, cache_dir=cache_dir)

    coverage = Cache(cache_dir).coverage("NIFTY")
    assert coverage == {"15m": {"start": "2026-09-04", "end": "2026-09-04"}}


def test_coverage_empty_for_unknown_underlying(tmp_path: Path) -> None:
    coverage = Cache(tmp_path / "cache").coverage("SENSEX")
    assert coverage == {}
