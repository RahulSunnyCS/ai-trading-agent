"""run_fyers_topup/run_fyers_topup_total_market: the Fyers plain-price stopgaps for a
stale Stock/Broad Momentum dataset when NSE is unreachable (TODO.md 3.11.16). No real
network — `fyers.daily_closes`/`daily_ohlcv` are monkeypatched."""

from __future__ import annotations

from datetime import date

import pandas as pd
import pytest
from trading_data import lake
from trading_data.db import connect, data_root

from momentum_backtesting import fyers
from momentum_backtesting.stocks import fyers_topup


@pytest.fixture
def seeded_db(monkeypatch):
    """Two currently-listed companies, one of them with an existing prior week of data."""
    monkeypatch.setattr(
        fyers_topup,
        "_current_aliases",
        lambda: {"C0001": "RELIANCE", "C0002": "TCS"},  # C0003 deliberately has no alias
    )
    with connect() as con:
        con.execute(
            "INSERT INTO stock_membership_weekly (company_id, week, is_member) VALUES "
            "('C0001', '2026-09-25', true), ('C0002', '2026-09-25', true), "
            "('C0003', '2026-09-25', true)"
        )
        con.execute(
            "INSERT INTO stock_weekly_prices (company_id, kind, week, close) VALUES "
            "('C0001', 'tr', '2026-09-25', 1000.0), ('C0001', 'price', '2026-09-25', 1000.0), "
            "('C0002', 'tr', '2026-09-25', 2000.0), ('C0002', 'price', '2026-09-25', 2000.0)"
        )
    yield


def _fake_creds() -> fyers.Credentials:
    return fyers.Credentials("app", "token", "test")


def test_fills_the_missing_week_for_every_current_member(seeded_db, monkeypatch):
    seen_symbols = []

    def fake_daily_closes(symbol, start, end, creds):  # noqa: ARG001
        seen_symbols.append(symbol)
        return pd.Series([111.0, 123.45], index=pd.to_datetime(["2026-10-01", "2026-10-02"]))

    monkeypatch.setattr(fyers, "daily_closes", fake_daily_closes)
    monkeypatch.setattr(fyers_topup.time, "sleep", lambda _s: None)

    result = fyers_topup.run_fyers_topup(_fake_creds(), now=date(2026, 10, 2))

    assert result is not None
    assert result.week == pd.Timestamp("2026-10-02")
    assert sorted(seen_symbols) == ["NSE:RELIANCE-EQ", "NSE:TCS-EQ"]
    assert result.companies_updated == 2
    assert result.companies_skipped == ["C0003"]  # no alias -> no symbol

    with connect() as con:
        rows = con.execute(
            "SELECT company_id, kind, close FROM stock_weekly_prices WHERE week = '2026-10-02' "
            "ORDER BY company_id, kind"
        ).fetchall()
    assert rows == [
        ("C0001", "price", 123.45),
        ("C0001", "tr", 123.45),
        ("C0002", "price", 123.45),
        ("C0002", "tr", 123.45),
    ]
    with connect() as con:
        membership = con.execute(
            "SELECT company_id FROM stock_membership_weekly WHERE week = '2026-10-02' "
            "AND is_member ORDER BY company_id"
        ).fetchall()
    # Membership carries forward for every current member regardless of whether a price
    # was fetchable this week (C0003 has no symbol, but is still a Nifty 50 constituent).
    assert [r[0] for r in membership] == ["C0001", "C0002", "C0003"]
    # The prior week's rows must survive — this is a targeted top-up, never a wholesale
    # replace of the table (that's `mbt local migrate`'s job, not this one's).
    with connect() as con:
        prior = con.execute(
            "SELECT count(*) FROM stock_weekly_prices WHERE week = '2026-09-25'"
        ).fetchone()[0]
    assert prior == 4


def test_returns_none_when_already_current(seeded_db, monkeypatch):
    calls = []
    monkeypatch.setattr(fyers, "daily_closes", lambda *a, **k: calls.append(1))

    # The seeded week (2026-09-25) IS the target Friday for 2026-09-25 itself.
    result = fyers_topup.run_fyers_topup(_fake_creds(), now=date(2026, 9, 25))

    assert result is None
    assert calls == []  # no network call made once the gate says "already current"


def test_one_bad_symbol_does_not_fail_the_whole_topup(seeded_db, monkeypatch):
    def flaky(symbol, start, end, creds):  # noqa: ARG001
        if symbol == "NSE:RELIANCE-EQ":
            raise RuntimeError("fyers rejected the token")
        return pd.Series([55.0], index=pd.to_datetime(["2026-10-02"]))

    monkeypatch.setattr(fyers, "daily_closes", flaky)
    monkeypatch.setattr(fyers_topup.time, "sleep", lambda _s: None)

    result = fyers_topup.run_fyers_topup(_fake_creds(), now=date(2026, 10, 2))

    assert result.companies_updated == 1
    assert sorted(result.companies_skipped) == ["C0001", "C0003"]


def test_an_empty_catalog_starts_the_fetch_window_a_week_back(monkeypatch):
    """No prior stock_weekly_prices rows at all (a fresh catalog, NSE never having
    succeeded) — the fetch window must still be well-formed, not crash on `None`."""
    monkeypatch.setattr(fyers_topup, "_current_aliases", lambda: {"C0001": "RELIANCE"})
    with connect() as con:
        con.execute(
            "INSERT INTO stock_membership_weekly (company_id, week, is_member) "
            "VALUES ('C0001', '2026-09-18', true)"
        )
    seen = {}

    def fake_daily_closes(symbol, start, end, creds):  # noqa: ARG001
        seen["start"] = start
        seen["end"] = end
        return pd.Series([100.0], index=pd.to_datetime(["2026-10-02"]))

    monkeypatch.setattr(fyers, "daily_closes", fake_daily_closes)
    monkeypatch.setattr(fyers_topup.time, "sleep", lambda _s: None)

    result = fyers_topup.run_fyers_topup(_fake_creds(), now=date(2026, 10, 2))

    assert result.companies_updated == 1
    assert seen["start"] < seen["end"]


# --------------------------------------------------------------------------
# run_fyers_topup_total_market: the Broad Momentum/Custom Index equivalent, writing
# directly into the `bars_1d_stock` lake parquet (not a plain table) with
# synthetic_close=True.
# --------------------------------------------------------------------------


@pytest.fixture
def total_market_csv(tmp_path):
    path = tmp_path / "total_market_membership.csv"
    path.write_text("year,symbol\n2026,RELIANCE\n2026,TCS\n2026,NOSYMBOL\n")
    return tmp_path


def _fake_ohlcv(rows: dict[str, float]) -> pd.DataFrame:
    """One day's bar per entry, keyed by ISO date -> close (open/high/low/volume
    derived trivially — only shape matters for these tests)."""
    index = pd.to_datetime(list(rows.keys()))
    closes = list(rows.values())
    return pd.DataFrame(
        {
            "open": closes,
            "high": closes,
            "low": closes,
            "close": closes,
            "volume": [1000] * len(closes),
        },
        index=index,
    ).sort_index()


def test_total_market_topup_writes_real_bars_tagged_synthetic(total_market_csv, monkeypatch):
    seen_symbols = []

    def fake_daily_ohlcv(symbol, start, end, creds):  # noqa: ARG001
        seen_symbols.append(symbol)
        if symbol == "NSE:NOSYMBOL-EQ":
            return pd.DataFrame(columns=["open", "high", "low", "close", "volume"])
        return _fake_ohlcv({"2026-10-02": 100.0 if "RELIANCE" in symbol else 200.0})

    monkeypatch.setattr(fyers, "daily_ohlcv", fake_daily_ohlcv)
    monkeypatch.setattr(fyers_topup.time, "sleep", lambda _s: None)

    result = fyers_topup.run_fyers_topup_total_market(
        _fake_creds(), total_market_csv, now=date(2026, 10, 2)
    )

    assert sorted(seen_symbols) == ["NSE:NOSYMBOL-EQ", "NSE:RELIANCE-EQ", "NSE:TCS-EQ"]
    assert result.symbols_updated == 2
    assert result.rows_written == 2
    assert result.symbols_skipped == ["NOSYMBOL"]

    path = lake.bars_1d_stock_path(data_root(), 2026)
    assert path.exists()
    with connect() as con:
        rows = con.execute(
            "SELECT i.symbol, b.date, b.close, b.synthetic_close FROM bars_1d_stock b "
            "JOIN instruments i USING (instrument_id) ORDER BY i.symbol"
        ).fetchall()
    assert rows == [
        ("RELIANCE", date(2026, 10, 2), 100.0, True),
        ("TCS", date(2026, 10, 2), 200.0, True),
    ]


def test_total_market_topup_returns_none_when_already_current(total_market_csv, monkeypatch):
    def seed(symbol, start, end, creds):  # noqa: ARG001
        if "NOSYMBOL" in symbol:
            return pd.DataFrame(columns=["open", "high", "low", "close", "volume"])
        return _fake_ohlcv({"2026-10-02": 50.0})

    monkeypatch.setattr(fyers, "daily_ohlcv", seed)
    monkeypatch.setattr(fyers_topup.time, "sleep", lambda _s: None)

    # Seed bars_1d_stock with today's date already present.
    first = fyers_topup.run_fyers_topup_total_market(
        _fake_creds(), total_market_csv, now=date(2026, 10, 2)
    )
    assert first is not None

    calls = []
    monkeypatch.setattr(fyers, "daily_ohlcv", lambda *a, **k: calls.append(1))

    second = fyers_topup.run_fyers_topup_total_market(
        _fake_creds(), total_market_csv, now=date(2026, 10, 2)
    )

    assert second is None
    assert calls == []  # the gate returned before any fetch was attempted
    assert calls == []


def test_total_market_topup_merges_into_existing_year_partition(total_market_csv, monkeypatch):
    """The year's lake file must be merged, not wholesale-overwritten — a prior
    (instrument, date) row from before this top-up ever ran has to survive."""
    import pyarrow as pa

    root = data_root()
    path = lake.bars_1d_stock_path(root, 2026)
    with connect() as con:
        existing_id = fyers_topup.db_migrate.register_stock_instruments(con, ["INFY"])["INFY"]
    prior_row = {
        "instrument_id": existing_id,
        "date": date(2026, 9, 25),
        "series": "EQ",
        "isin": None,
        "open": 10.0,
        "high": 10.0,
        "low": 10.0,
        "close": 10.0,
        "prevclose": 10.0,
        "volume": 1,
        "turnover": 10.0,
        "synthetic_close": False,
    }
    lake.write_parquet(
        pa.Table.from_pylist([prior_row], schema=fyers_topup._BARS_1D_STOCK_SCHEMA), path
    )

    def fake_daily_ohlcv(symbol, start, end, creds):  # noqa: ARG001
        if "NOSYMBOL" in symbol:
            return pd.DataFrame(columns=["open", "high", "low", "close", "volume"])
        return _fake_ohlcv({"2026-10-02": 50.0})

    monkeypatch.setattr(fyers, "daily_ohlcv", fake_daily_ohlcv)
    monkeypatch.setattr(fyers_topup.time, "sleep", lambda _s: None)

    fyers_topup.run_fyers_topup_total_market(_fake_creds(), total_market_csv, now=date(2026, 10, 2))

    with connect() as con:
        rows = con.execute(
            "SELECT i.symbol, b.date, b.synthetic_close FROM bars_1d_stock b "
            "JOIN instruments i USING (instrument_id) ORDER BY b.date"
        ).fetchall()
    assert rows == [
        ("INFY", date(2026, 9, 25), False),  # the pre-existing row, untouched
        ("RELIANCE", date(2026, 10, 2), True),
        ("TCS", date(2026, 10, 2), True),
    ]
