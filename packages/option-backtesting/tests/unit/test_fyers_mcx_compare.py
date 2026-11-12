"""History API against the expired API after expiry (BL-148 Phase 5): identical bars, the three kinds
of difference (a field, a minute only one side has, a contract with nothing on one side), the
Angel One days left out, nothing written to the lake. Synthetic lake and cache, no network."""

from datetime import date, datetime, timedelta, timezone

import pytest
from trading_data import ingest, lake
from trading_data.db import connect

from option_backtesting.fyers import mcx, mcx_compare, mcx_daily
from option_backtesting.fyers.client import Candle
from option_backtesting.fyers.expired import _cache_path, _window, _write_cache
from option_backtesting.fyers.mcx_lake import register_contracts
from option_backtesting.fyers.symbols import Contract

IST = timezone(timedelta(hours=5, minutes=30))
START = date(2024, 10, 21)
EXPIRY = date(2026, 11, 17)
D1, D2 = date(2026, 11, 9), date(2026, 11, 10)
COLS = ["timestamp", "open", "high", "low", "close", "volume", "open_interest"]
CE = Contract("MCX:CRUDEOIL26NOV8100CE", "CRUDEOIL", EXPIRY, 8100.0, "CE", 1)
PE = Contract("MCX:CRUDEOIL26NOV8100PE", "CRUDEOIL", EXPIRY, 8100.0, "PE", 1)
GONE = Contract("MCX:CRUDEOIL26NOV9000CE", "CRUDEOIL", EXPIRY, 9000.0, "CE", 1)


def _t(day: date, hour: int, minute: int) -> int:
    return int(datetime(day.year, day.month, day.day, hour, minute, tzinfo=IST).timestamp())


def _bars(day, minutes, price=10.0, volume=5.0, oi=100.0):
    return [Candle(_t(day, 17, m), price, price + 1, price - 1, price, volume, oi) for m in minutes]


class _Client:
    def expired_expiries(self, symbol, start, end):
        return [EXPIRY] if start <= EXPIRY <= end else []

    def expired_contracts(self, symbol, expiry):
        return [CE.symbol, PE.symbol, GONE.symbol]


@pytest.fixture
def setup(tmp_path, monkeypatch):
    monkeypatch.setattr(
        mcx, "reference_futures", lambda roots, today: {r: "MCX:CRUDEOIL26NOVFUT" for r in roots}
    )
    manifest = mcx.discover(_Client(), ("CRUDEOIL",), START, date(2026, 11, 18))
    with connect(tmp_path):
        pass
    return tmp_path, manifest


def _store_lake(root, contract, candles_by_day):
    ids = register_contracts(root, [contract])
    for day, candles in candles_by_day.items():
        table = mcx_daily.options_table([(contract, ids[contract.symbol], candles)])
        mcx_daily.merge_day(lake.bars_1m_path(root, "option", "CRUDEOIL", day), table)


def _store_expired(root, manifest, contract, candles):
    item = next(i for _n, i in mcx.plan_expiries(manifest, ("CRUDEOIL",)))
    lo, hi = _window(item)
    rows = [[c.epoch, c.open, c.high, c.low, c.close, c.volume, c.oi] for c in candles]
    body = {"s": "ok", "columns": COLS, "candles": rows} if rows else {"s": "no_data"}
    params = {"symbol": contract.symbol, "range_from": lo.isoformat(), "range_to": hi.isoformat()}
    _write_cache(
        _cache_path(root, "CRUDEOIL", EXPIRY, contract.symbol), contract.symbol, params, body
    )


def _cache_all(root, manifest, **given):
    for c in (CE, PE, GONE):
        _store_expired(root, manifest, c, given.get(c.symbol, []))


def _record_run(root, source, day, first, last):
    with connect(root, views=()) as con:
        run_id = ingest.start_run(con, source, "mcx_options_daily", day, "CRUDEOIL")
        ingest.finish_run(
            con, run_id, requests=1, rows_written=1, errors=0,
            details={"first_day": first.isoformat(), "last_day": last.isoformat()},
        )  # fmt: skip


def test_identical_bars_on_both_sides_are_all_identical(setup):
    root, manifest = setup
    both = _bars(D1, range(5)) + _bars(D2, range(5))
    _store_lake(root, CE, {D1: _bars(D1, range(5)), D2: _bars(D2, range(5))})
    _cache_all(root, manifest, **{CE.symbol: both})
    out = mcx_compare.compare_expiry(root, manifest, "CRUDEOIL", EXPIRY, since=D1)
    assert out["rows_both"] == 10 and out["rows_only_lake"] == out["rows_only_expired"] == 0
    assert out["rows_differing_any_field"] == 0 and out["share_identical_rows"] == 1.0


def test_a_differing_field_is_counted_with_its_size_and_an_example(setup):
    root, manifest = setup
    lake_bars = _bars(D1, range(3))
    expired = _bars(D1, range(3))
    expired[1] = Candle(expired[1].epoch, 10.0, 11.0, 7.5, 10.0, 6.0, 100.0)  # low 9 -> 7.5, volume
    _store_lake(root, CE, {D1: lake_bars})
    _cache_all(root, manifest, **{CE.symbol: expired})
    out = mcx_compare.compare_expiry(root, manifest, "CRUDEOIL", EXPIRY, since=D1)
    assert out["differing_rows"]["low"] == 1 and out["differing_rows"]["volume"] == 1
    assert out["differing_rows"]["open"] == 0 and out["rows_differing_any_field"] == 1
    assert out["max_abs_diff"]["low"] == 1.5
    assert (
        out["examples"][0]["field"] in ("low", "volume")
        and out["examples"][0]["symbol"] == CE.symbol
    )
    assert out["share_identical_rows"] == round(2 / 3, 6)


def test_a_minute_only_one_side_holds_is_counted_apart_from_field_differences(setup):
    root, manifest = setup
    _store_lake(root, CE, {D1: _bars(D1, [0, 1, 2])})
    _cache_all(root, manifest, **{CE.symbol: _bars(D1, [1, 2, 3, 4])})
    out = mcx_compare.compare_expiry(root, manifest, "CRUDEOIL", EXPIRY, since=D1)
    assert (out["rows_both"], out["rows_only_lake"], out["rows_only_expired"]) == (2, 1, 2)
    assert out["rows_differing_any_field"] == 0
    row = next(r for r in out["per_contract"] if r["symbol"] == CE.symbol)
    assert (row["only_lake"], row["only_expired"]) == (1, 2)


def test_a_contract_with_bars_on_one_side_only_is_a_difference_not_a_skip(setup):
    root, manifest = setup
    _store_lake(root, PE, {D1: _bars(D1, range(3))})  # History has it, the expired API says no_data
    _cache_all(root, manifest, **{GONE.symbol: _bars(D1, range(2))})  # the reverse for GONE
    out = mcx_compare.compare_expiry(root, manifest, "CRUDEOIL", EXPIRY, since=D1)
    assert out["rows_both"] == 0 and out["rows_only_lake"] == 3 and out["rows_only_expired"] == 2
    assert out["contracts_compared"] == 2 and out["expired_not_cached"] == 0


def test_nan_oi_on_both_sides_is_equal_but_one_side_missing_is_a_difference(setup):
    root, manifest = setup
    no_oi = [Candle(_t(D1, 17, m), 10.0, 11.0, 9.0, 10.0, 5.0, None) for m in range(2)]
    _store_lake(root, CE, {D1: no_oi})
    _cache_all(root, manifest, **{CE.symbol: no_oi})
    assert (
        mcx_compare.compare_expiry(root, manifest, "CRUDEOIL", EXPIRY, since=D1)["differing_rows"][
            "oi"
        ]
        == 0
    )
    with_oi = [Candle(c.epoch, c.open, c.high, c.low, c.close, c.volume, 7.0) for c in no_oi]
    _cache_all(root, manifest, **{CE.symbol: with_oi})
    out = mcx_compare.compare_expiry(root, manifest, "CRUDEOIL", EXPIRY, since=D1)
    assert out["differing_rows"]["oi"] == 2


def test_days_stored_by_the_angel_one_fallback_are_left_out(setup):
    root, manifest = setup
    _store_lake(root, CE, {D1: _bars(D1, range(3)), D2: _bars(D2, range(3), price=50.0)})
    _cache_all(root, manifest, **{CE.symbol: _bars(D1, range(3)) + _bars(D2, range(3))})
    _record_run(root, "angelone", D2, D2, D2)  # D2 came from Angel One: another feed
    out = mcx_compare.compare_expiry(root, manifest, "CRUDEOIL", EXPIRY, since=D1)
    assert out["angel_days_left_out"] == [D2.isoformat()]
    assert out["rows_both"] == 3 and out["rows_differing_any_field"] == 0  # D2's 50.0 not counted


def test_the_comparison_starts_when_the_collector_first_ran(setup):
    root, manifest = setup
    _record_run(root, "fyers", D2, D2, D2)  # first night D2: it reaches back 98 days
    assert mcx_compare.collection_start(root, "CRUDEOIL") == D2 - timedelta(days=98)
    assert mcx_compare.collection_start(root, "ZINC") is None


def test_nothing_is_written_to_the_lake_and_the_report_lands_beside_the_manifest(setup):
    root, manifest = setup
    _store_lake(root, CE, {D1: _bars(D1, range(3))})
    _cache_all(root, manifest, **{CE.symbol: _bars(D1, range(3))})
    before = lake.bars_1m_path(root, "option", "CRUDEOIL", D1).read_bytes()
    out = mcx_compare.compare_expiry(root, manifest, "CRUDEOIL", EXPIRY, since=D1)
    path = mcx_compare.write_report(root, out)
    assert lake.bars_1m_path(root, "option", "CRUDEOIL", D1).read_bytes() == before
    assert path.exists() and path.with_suffix(".csv").exists()
    assert path.parent == root / "raw" / "fyers-expired" / "mcx"
