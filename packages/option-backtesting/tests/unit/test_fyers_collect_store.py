"""collect_day end to end against a fake Fyers client: what lands in the lake, the
catalog (instruments, ingest_runs) and raw/ — no network."""

import gzip
import json
from datetime import date

import pyarrow.parquet as pq
import pytest
from trading_data import lake
from trading_data.db import connect

from option_backtesting.fyers import daily
from option_backtesting.fyers.client import Candle
from option_backtesting.fyers.symbols import Contract

DAY = date(2026, 9, 29)
EXP = date(2026, 10, 6)


class FakeClient:
    """Index at 22000; CE premium falls with distance above, PE below."""

    def __init__(self):
        self.calls = 0
        self.on_response = None

    def minute_candles(self, symbol, day):
        self.calls += 1
        if symbol.endswith("-INDEX"):
            px = 15.0 if "VIX" in symbol else 22000.0
        elif symbol.endswith("FUT"):
            px = 22020.0
        else:
            strike = float(symbol[-7:-2])
            dist = strike - 22000 if symbol.endswith("CE") else 22000 - strike
            px = max(0.5, 100 - dist / 5)
        candles = [Candle(1790653500 + 60 * i, px, px, px, px, 1.0, 5.0) for i in range(3)]
        if self.on_response:
            self.on_response(symbol, {"symbol": symbol}, {"s": "ok", "n": len(candles)})
        return candles


def _contracts():
    out = [Contract("NSE:NIFTY26OCTFUT", "NIFTY", date(2026, 10, 27), None, "FUT", 65)]
    for k in range(21400, 22650, 50):
        for t in ("CE", "PE"):
            out.append(Contract(f"NSE:NIFTY26O06{k}{t}", "NIFTY", EXP, float(k), t, 65))
    return out


@pytest.fixture
def root(tmp_path, monkeypatch):
    monkeypatch.setattr(daily, "download_master", lambda segment: "")
    monkeypatch.setattr(daily, "parse_master", lambda text, names: _contracts())
    return tmp_path / "data"


def test_collect_day_writes_lake_catalog_and_raw(root):
    daily.collect_day(FakeClient(), DAY, ["NIFTY"], root, premium_floor=30, log=lambda _: None)

    opt = pq.read_table(lake.bars_1m_path(root, "option", "NIFTY", DAY))
    assert opt.num_rows > 0 and None not in opt.column("instrument_id").to_pylist()
    assert lake.bars_1m_path(root, "index", "INDIAVIX", DAY).exists()
    assert lake.bars_1m_path(root, "future", "NIFTY", DAY).exists()

    with connect(root, read_only=True) as con:
        run = con.execute("SELECT status, errors, rows_written FROM ingest_runs").fetchall()
        [(status, errors, rows)] = run
        assert (status, errors) == ("ok", 0) and rows == opt.num_rows + 3 * 3
        # every bar's instrument_id resolves, and options point at the NIFTY index
        orphan = con.execute(
            "SELECT count(*) FROM bars_1m_option b LEFT JOIN instruments i USING (instrument_id) "
            "WHERE i.instrument_id IS NULL"
        ).fetchone()[0]
        assert orphan == 0
        parent = con.execute(
            "SELECT DISTINCT u.instrument_key FROM instruments o JOIN instruments u "
            "ON o.underlying_id = u.instrument_id WHERE o.asset_class = 'option'"
        ).fetchall()
        assert parent == [("NSE:IDX:NIFTY",)]
        alias = con.execute(
            "SELECT i.instrument_key FROM instrument_aliases a JOIN instruments i USING "
            "(instrument_id) WHERE a.vendor_symbol = 'NSE:NIFTY26O0622000CE'"
        ).fetchone()[0]
        assert alias == "NSE:OPT:NIFTY:2026-10-06:22000:CE"

    with gzip.open(lake.raw_path(root, "fyers", DAY, "NIFTY"), "rt") as fh:
        lines = [json.loads(line) for line in fh]
    assert len(lines) == len(opt.column("vendor_symbol").unique()) + 2  # + index + future


def test_rerun_skips_collected_day_and_registers_nothing_twice(root):
    daily.collect_day(FakeClient(), DAY, ["NIFTY"], root, log=lambda _: None)
    client = FakeClient()
    daily.collect_day(client, DAY, ["NIFTY"], root, log=lambda _: None)
    assert client.calls == 0  # VIX and NIFTY already there
    with connect(root, read_only=True) as con:
        dupes = con.execute(
            "SELECT count(*) - count(DISTINCT instrument_key) FROM instruments"
        ).fetchone()[0]
        assert dupes == 0


def test_symbol_master_merges_instead_of_overwriting(root):
    nifty = _contracts()
    sensex = [Contract("BSE:SENSEX26O0173000CE", "SENSEX", date(2026, 10, 1), 73000.0, "CE", 20)]
    daily.write_symbol_master(root, DAY, nifty)
    daily.write_symbol_master(root, DAY, sensex)
    saved = pq.read_table(lake.symbol_master_path(root, "fyers", DAY))
    assert saved.num_rows == len(nifty) + 1
