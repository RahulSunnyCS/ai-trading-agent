"""MCX raw cache -> lake (BL-148 Phase 2): staging, complete-days-only writes, duplicate and
null-OI handling, instrument identity, rerun idempotence. Synthetic cache, no network."""

from datetime import date, datetime, timedelta, timezone

import pyarrow as pa
import pyarrow.parquet as pq
import pytest
from trading_data import lake
from trading_data.db import connect

from option_backtesting.fyers import mcx, mcx_lake
from option_backtesting.fyers.expired import _cache_path, _window, _write_cache

IST = timezone(timedelta(hours=5, minutes=30))
START = date(2024, 10, 21)
E1 = date(2024, 11, 15)
E2 = date(2025, 1, 15)
SYMBOLS = {
    E1: ["MCX:CRUDEOIL24NOV6000CE", "MCX:CRUDEOIL24NOV6000PE"],
    E2: ["MCX:CRUDEOIL25JAN6500CE"],
}
DAY1, DAY2 = date(2024, 11, 4), date(2024, 11, 5)
COLS = ["timestamp", "open", "high", "low", "close", "volume", "open_interest"]


def _t(day: date, hour: int, minute: int) -> int:
    return int(datetime(day.year, day.month, day.day, hour, minute, tzinfo=IST).timestamp())


def _body(rows):
    return {"s": "ok", "columns": COLS, "candles": rows}


# (contract) -> candles; a repeated minute, a null OI and an after-midnight-free evening bar
CANDLES = {
    "MCX:CRUDEOIL24NOV6000CE": [
        [_t(DAY1, 9, 0), 10, 12, 9, 11, 5, 100],
        [_t(DAY1, 9, 1), 11, 13, 10, 12, 6, None],
        [_t(DAY1, 9, 1), 99, 99, 99, 99, 99, 99],  # a repeated minute: first wins
        [_t(DAY1, 23, 54), 12, 12, 12, 12, 1, 101],
        [_t(DAY2, 9, 0), 12, 14, 11, 13, 7, 102],
    ],
    "MCX:CRUDEOIL24NOV6000PE": [[_t(DAY1, 9, 0), 5, 6, 4, 5, 2, 50]],
    "MCX:CRUDEOIL25JAN6500CE": [[_t(DAY1, 9, 5), 3, 3, 3, 3, 1, 10]],
}


@pytest.fixture
def setup(tmp_path, monkeypatch):
    monkeypatch.setattr(
        mcx, "reference_futures", lambda roots, today: {r: "MCX:CRUDEOIL26DECFUT" for r in roots}
    )

    class Client:
        def expired_expiries(self, symbol, start, end):
            return [e for e in SYMBOLS if start <= e <= end]

        def expired_contracts(self, symbol, expiry):
            return list(SYMBOLS[expiry])

    manifest = mcx.discover(Client(), ("CRUDEOIL",), START, date(2025, 3, 31))
    with connect(tmp_path):
        pass
    return tmp_path, manifest


def _cache(root, manifest, expiry):
    item = next(i for _n, i in mcx.plan_expiries(manifest, ("CRUDEOIL",)) if i.expiry == expiry)
    lo, hi = _window(item)
    for c in item.contracts:
        params = {"symbol": c.symbol, "range_from": lo.isoformat(), "range_to": hi.isoformat()}
        _write_cache(
            _cache_path(root, "CRUDEOIL", expiry, c.symbol),
            c.symbol,
            params,
            _body(CANDLES[c.symbol]),
        )


def _lake_rows(root, day):
    path = lake.bars_1m_path(root, "option", "CRUDEOIL", day)
    return pq.read_table(path).to_pylist() if path.exists() else None


def test_a_day_waits_until_every_expiry_that_could_hold_it_is_cached(setup):
    root, manifest = setup
    _cache(root, manifest, E1)  # E2's window also covers 2024-11-04, and E2 is not cached
    first = mcx_lake.import_root(root, manifest, "CRUDEOIL", log=lambda _m: None)
    assert first.expiries_staged == 1 and first.expiries_waiting == {E2.isoformat(): 1}
    assert first.days_written == 0 and first.days_waiting == 2
    assert _lake_rows(root, DAY1) is None
    _cache(root, manifest, E2)
    second = mcx_lake.import_root(root, manifest, "CRUDEOIL", log=lambda _m: None)
    assert second.days_written == 2 and second.expiries_waiting == {}


def test_rows_are_deduplicated_sparse_and_keep_null_oi(setup):
    root, manifest = setup
    _cache(root, manifest, E1)
    _cache(root, manifest, E2)
    result = mcx_lake.import_root(root, manifest, "CRUDEOIL", log=lambda _m: None)
    rows = _lake_rows(root, DAY1)
    ce = [r for r in rows if r["vendor_symbol"] == "MCX:CRUDEOIL24NOV6000CE"]
    assert [r["ts"].astimezone(IST).strftime("%H:%M") for r in ce] == ["09:00", "09:01", "23:54"]
    assert ce[1]["close"] == 12 and ce[1]["oi"] is None  # the first repeat of 09:01 won
    assert {r["vendor_symbol"] for r in rows} == set(CANDLES)
    assert all(r["strike"] and r["option_type"] in ("CE", "PE") for r in rows)
    assert len(_lake_rows(root, DAY2)) == 1
    # 5 + 1 + 1 raw rows, one repeated minute dropped, nothing forward-filled
    assert (result.raw_rows, result.staged_rows, result.rows_added) == (7, 6, 6)


def test_instruments_are_registered_by_root_expiry_strike_and_side(setup):
    root, manifest = setup
    _cache(root, manifest, E1)
    _cache(root, manifest, E2)
    mcx_lake.import_root(root, manifest, "CRUDEOIL", log=lambda _m: None)
    with connect(root, read_only=True, views=()) as con:
        rows = con.execute(
            "SELECT i.exchange, i.asset_class, i.symbol, i.expiry, i.strike, i.option_type, "
            "a.vendor_symbol, u.instrument_key FROM instruments i "
            "JOIN instrument_aliases a USING (instrument_id) "
            "JOIN instruments u ON u.instrument_id = i.underlying_id ORDER BY a.vendor_symbol"
        ).fetchall()
    assert rows[0] == (
        "MCX", "option", "CRUDEOIL", E1, 6000.0, "CE", "MCX:CRUDEOIL24NOV6000CE", "MCX:CMD:CRUDEOIL",
    )  # fmt: skip
    assert len(rows) == 3


def test_a_rerun_changes_nothing_and_reuses_the_staging(setup):
    root, manifest = setup
    _cache(root, manifest, E1)
    _cache(root, manifest, E2)
    mcx_lake.import_root(root, manifest, "CRUDEOIL", keep_staging=True, log=lambda _m: None)
    before = pq.read_table(lake.bars_1m_path(root, "option", "CRUDEOIL", DAY1)).to_pylist()
    again = mcx_lake.import_root(root, manifest, "CRUDEOIL", keep_staging=True, log=lambda _m: None)
    assert again.rows_added == 0 and again.rows_preserved == 6
    assert pq.read_table(lake.bars_1m_path(root, "option", "CRUDEOIL", DAY1)).to_pylist() == before


def test_staging_is_removed_after_a_complete_import(setup):
    root, manifest = setup
    _cache(root, manifest, E1)
    _cache(root, manifest, E2)
    mcx_lake.import_root(root, manifest, "CRUDEOIL", log=lambda _m: None)
    assert not list(mcx_lake.staging_dir(root, "CRUDEOIL").glob("*"))


def test_quality_judges_the_import_with_the_mcx_session(setup):
    root, manifest = setup
    _cache(root, manifest, E1)
    _cache(root, manifest, E2)
    mcx_lake.import_root(root, manifest, "CRUDEOIL", log=lambda _m: None)
    with connect(root, read_only=True, views=()) as con:
        rows = con.execute(
            "SELECT trading_day, verdict, reason, source FROM data_quality "
            "WHERE name = 'CRUDEOIL' ORDER BY trading_day"
        ).fetchall()
    # three contracts and 3 bars on the busiest: a thin chain, named, never silently kept
    assert [r[0] for r in rows] == [DAY1, DAY2]
    assert all(r[1] == "excluded" and r[3] == "fyers" for r in rows)


def test_audit_passes_a_clean_import_and_names_what_it_found(setup):
    from option_backtesting.fyers import mcx_audit

    root, manifest = setup
    _cache(root, manifest, E1)
    _cache(root, manifest, E2)
    mcx_lake.import_root(root, manifest, "CRUDEOIL", log=lambda _m: None)
    result = mcx_audit.audit(root, manifest, ("CRUDEOIL",), sample=10)
    r = result["roots"]["CRUDEOIL"]
    assert result["passed"] is True
    inv = r["invariants"]
    assert inv["rows"] == 6 and inv["duplicate_minutes"] == 0 and inv["out_of_order"] == 0
    assert inv["null_oi"] == 1 and inv["outside_session"] == 0 and inv["after_expiry"] == 0
    assert r["sample"]["contracts_compared"] == 3 and r["sample"]["mismatched"] == 0
    assert r["coverage"]["requested"] == 3 and r["coverage"]["with_bars"] == 3
    csv_path = root / "raw" / "fyers-expired" / "mcx" / "coverage-CRUDEOIL.csv"
    assert len(csv_path.read_text().strip().splitlines()) == 4  # header + 3 contracts


def test_audit_catches_a_lake_row_that_differs_from_the_raw_cache(setup):
    from option_backtesting.fyers import mcx_audit

    root, manifest = setup
    _cache(root, manifest, E1)
    _cache(root, manifest, E2)
    mcx_lake.import_root(root, manifest, "CRUDEOIL", log=lambda _m: None)
    path = lake.bars_1m_path(root, "option", "CRUDEOIL", DAY1)
    table = pq.read_table(path)
    close = table.column("close").to_pylist()
    close[0] += 1.0
    table = table.set_column(table.schema.get_field_index("close"), "close", pa.array(close))
    lake.write_parquet(table.cast(lake.OPT_SCHEMA), path)
    result = mcx_audit.audit(root, manifest, ("CRUDEOIL",), sample=10)
    assert result["passed"] is False and result["roots"]["CRUDEOIL"]["sample"]["mismatched"] == 1
