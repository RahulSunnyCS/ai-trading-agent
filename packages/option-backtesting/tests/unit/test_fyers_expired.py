"""The expired-option repair against a fake Fyers client: planning only the missing days,
resumable raw cache, clean stop at a request budget, merge that never overwrites, and the
by-name candle parser. No network."""

import gzip
import json
from datetime import date, datetime, timedelta, timezone

import pyarrow as pa
import pyarrow.parquet as pq
import pytest
from trading_data import lake

from option_backtesting.data.reference.loader import default_reference_data
from option_backtesting.fyers import expired
from option_backtesting.fyers.client import FyersClient
from option_backtesting.fyers.daily import options_table
from option_backtesting.fyers.symbols import Contract

IST = timezone(timedelta(hours=5, minutes=30))
HEALTHY = date(2026, 9, 15)
GAP = [date(2026, 9, 16), date(2026, 9, 17), date(2026, 9, 18)]
WEEKLY = date(2026, 9, 22)
MONTHLY = date(2026, 9, 29)
SYMBOLS = {
    WEEKLY: [f"NSE:NIFTY2692222{k}{t}" for k in ("000", "050") for t in ("CE", "PE")],
    MONTHLY: [f"NSE:NIFTY26SEP22{k}{t}" for k in ("000", "050") for t in ("CE", "PE")],
}


def _epoch(day: date, minute: int) -> int:
    return int(datetime(day.year, day.month, day.day, 9, 15 + minute, tzinfo=IST).timestamp())


class FakeClient:
    columns = ["timestamp", "open", "high", "low", "close", "volume", "open_interest"]

    def __init__(self):
        self.calls = 0
        self.history_calls = 0

    def expired_expiries(self, symbol, start, end):
        self.calls += 1
        return [WEEKLY, MONTHLY]

    def expired_contracts(self, symbol, expiry):
        self.calls += 1
        return list(SYMBOLS[expiry])

    def expired_history_response(self, symbol, start, end):
        self.calls += 1
        self.history_calls += 1
        rows, d = [], start
        while d <= end:
            if d.weekday() < 5:
                rows += [[_epoch(d, m), 10, 12, 9, 11, 5, 100] for m in range(3)]
            d += timedelta(days=1)
        params = {"symbol": symbol, "range_from": start.isoformat(), "range_to": end.isoformat()}
        return {"s": "ok", "columns": self.columns, "candles": rows}, params

    candles_from_response = staticmethod(FyersClient.candles_from_response)


def _index_partition(root, day):
    t = pa.table(
        {
            "instrument_id": [1],
            "ts": pa.array([_epoch(day, 0)], pa.int64()).cast(pa.timestamp("s")),
            "open": [1.0], "high": [1.0], "low": [1.0], "close": [1.0],
            "volume": [0.0], "oi": [0.0], "vendor_symbol": ["NSE:NIFTY50-INDEX"],
        }
    )  # fmt: skip
    t = t.set_column(1, "ts", t["ts"].cast(lake.TS_TYPE))
    lake.write_parquet(t.cast(lake.BAR_SCHEMA), lake.bars_1m_path(root, "index", "NIFTY", day))


def _contract(symbol="NSE:NIFTY2692222000CE", expiry=WEEKLY):
    return Contract(symbol, "NIFTY", expiry, 22000.0, "CE", 65)


@pytest.fixture
def root(tmp_path, monkeypatch):
    root = tmp_path / "data"
    monkeypatch.setenv("TRADING_DATA_ROOT", str(root))
    for day in [HEALTHY, *GAP]:
        _index_partition(root, day)
    # a healthy day: the repair must not request it
    lake.write_parquet(
        options_table([(_contract(), 7, [_candle(HEALTHY)])]),
        lake.bars_1m_path(root, "option", "NIFTY", HEALTHY),
    )
    monkeypatch.setattr(expired.quality, "rebuild", lambda *a, **k: None)
    monkeypatch.setattr(expired.derived, "rebuild", lambda *a, **k: None)
    return root


def _candle(day, minute=0, close=11.0):
    from option_backtesting.fyers.client import Candle

    return Candle(_epoch(day, minute), 10, 12, 9, close, 5, 100)


def test_decodes_weekly_and_monthly_symbols_and_refuses_the_rest():
    ref = default_reference_data()
    w = expired._contract("NSE:NIFTY2692222050PE", "NIFTY", WEEKLY, ref)
    assert (w.strike, w.option_type, w.expiry) == (22050.0, "PE", WEEKLY)
    m = expired._contract("NSE:NIFTY26SEP22000CE", "NIFTY", MONTHLY, ref)
    assert (m.strike, m.option_type) == (22000.0, "CE")
    with pytest.raises(ValueError):
        expired._contract("NSE:NIFTY26SEPFUT", "NIFTY", MONTHLY, ref)
    with pytest.raises(ValueError):
        expired._contract("NSE:BANKNIFTY26SEP50000CE", "NIFTY", MONTHLY, ref)


def test_candles_are_read_by_column_name_and_extra_columns_are_ignored():
    body = {
        "columns": ["timestamp", "volume", "close", "open", "low", "high", "iv", "open_interest"],
        "candles": [
            [100, 7, 4.0, 1.0, 0.5, 5.0, 17.8, 90],
            [160, 8, 4.5, 4.0, 3.5, 5.0, None, None],
        ],
    }
    a, b = FyersClient.candles_from_response(body)
    assert (a.open, a.high, a.low, a.close, a.volume, a.oi) == (1.0, 5.0, 0.5, 4.0, 7.0, 90.0)
    assert b.oi is None
    with pytest.raises(RuntimeError):
        FyersClient.candles_from_response({"columns": ["timestamp", "open"], "candles": []})
    # the live History API names no columns: positional, oi optional
    [c] = FyersClient.candles_from_response({"candles": [[100, 1, 2, 0.5, 1.5, 9]]})
    assert (c.close, c.volume, c.oi) == (1.5, 9.0, None)


def test_plan_covers_only_days_without_an_option_file_and_downloads_nothing(root):
    client = FakeClient()
    out = expired.run_backfill(
        client, root, ["NIFTY"], HEALTHY, GAP[-1], plan_only=True, log=lambda _: None
    )
    assert out["underlyings"]["NIFTY"]["days"] == 3  # not the healthy 15 Sep
    assert out["history_requests"] == 8 and client.history_calls == 0
    every = expired.run_backfill(
        client, root, ["NIFTY"], HEALTHY, GAP[-1], plan_only=True, missing_only=False,
        log=lambda _: None,
    )  # fmt: skip
    assert every["underlyings"]["NIFTY"]["days"] == 4


def test_backfill_fills_gap_days_and_a_rerun_costs_nothing(root):
    client = FakeClient()
    out = expired.run_backfill(client, root, ["NIFTY"], GAP[0], GAP[-1], log=lambda _: None)
    assert out["fetched"] == 8 and out["stopped"] is None
    for day in GAP:
        table = pq.read_table(lake.bars_1m_path(root, "option", "NIFTY", day))
        assert table.num_rows > 0 and set(table["oi"].to_pylist()) == {100.0}
        assert len(set(table["instrument_id"].to_pylist())) == 8  # 4 weekly + 4 monthly
    # day with data now exists, so nothing is planned: zero requests, zero rows
    again = FakeClient()
    out2 = expired.run_backfill(again, root, ["NIFTY"], GAP[0], GAP[-1], log=lambda _: None)
    assert out2["fetched"] == 0 and out2["rows_added"] == 0 and again.history_calls == 0


def test_request_budget_stops_cleanly_and_the_next_run_resumes_from_the_cache(root):
    first = FakeClient()
    out = expired.run_backfill(
        first, root, ["NIFTY"], GAP[0], GAP[-1], max_requests=3, log=lambda _: None
    )
    assert out["stopped"] == "max_requests" and out["fetched"] == 3
    for day in GAP:  # an unfinished expiry is never half-merged
        assert not lake.bars_1m_path(root, "option", "NIFTY", day).exists()
    second = FakeClient()
    out2 = expired.run_backfill(second, root, ["NIFTY"], GAP[0], GAP[-1], log=lambda _: None)
    assert out2["cached"] == 3 and out2["fetched"] == 5  # 8 contracts in all, 3 not repeated
    assert lake.bars_1m_path(root, "option", "NIFTY", GAP[0]).exists()


def test_a_cached_response_for_a_narrower_window_is_not_reused(root, tmp_path):
    path = expired._cache_path(root, "NIFTY", WEEKLY, "NSE:NIFTY2692222000CE")
    expired._write_cache(
        path, "x", {"range_from": "2026-09-17", "range_to": "2026-09-18"}, {"s": "no_data"}
    )
    assert expired._read_cache(path, date(2026, 9, 17), date(2026, 9, 18)) == {"s": "no_data"}
    assert expired._read_cache(path, date(2026, 9, 16), date(2026, 9, 18)) is None
    with gzip.open(path, "wt") as fh:  # a record from before params were stored
        json.dump({"response": {"s": "ok"}}, fh)
    assert expired._read_cache(path, date(2026, 9, 17), date(2026, 9, 18)) is None


def test_merge_keeps_existing_rows_and_adds_only_missing_minutes(root):
    path = lake.bars_1m_path(root, "option", "NIFTY", GAP[0])
    old = options_table([(_contract(), 7, [_candle(GAP[0], 0, close=11.0)])])
    lake.write_parquet(old, path)
    fresh = options_table(
        [(_contract(), 7, [_candle(GAP[0], 0, close=99.0), _candle(GAP[0], 1, close=12.0)])]
    )
    added, preserved = expired.merge_option_partition(path, fresh)
    assert (added, preserved) == (1, 1)
    merged = pq.read_table(path).sort_by("ts")
    assert merged["close"].to_pylist() == [11.0, 12.0]  # the existing price won
    again, _ = expired.merge_option_partition(path, fresh)
    assert again == 0
