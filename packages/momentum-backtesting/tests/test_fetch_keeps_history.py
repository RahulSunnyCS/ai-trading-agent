"""`mbt fetch` never drops a series it did not fetch, and the momentum_prices replace refuses a
data/ folder with less history than the database.

On 2026-10-18 `mbt fetch --no-fyers` rewrote weekly_closes.csv with the public series alone;
the 22 broker-sourced columns (every Nifty index, Gold, Gilt) then held only the weeks later
refreshes added, the replace carried that into momentum_prices, and on 2026-10-24 every
Broad favourite failed on an all-NaN Nifty 50 benchmark."""

from types import SimpleNamespace

import numpy as np
import pandas as pd
import pytest
from trading_data.db import connect

from momentum_backtesting import angelone, db_migrate, fetch, fyers
from momentum_backtesting.fetch import Instrument

NIFTY = Instrument("core", "Broad", "Nifty 50", "NIFTYBEES", "equity", "NSE:NIFTY50-INDEX", "", "")
BANK = Instrument(
    "core", "Sector", "Nifty Bank", "BANKBEES", "equity", "NSE:NIFTYBANK-INDEX", "", ""
)
CASH = Instrument("defensive", "Debt", "Cash", "LIQUIDBEES", "debt", "AMFI:120304", "", "")
DAYS = pd.bdate_range("2016-01-04", "2026-10-16")
FYERS = SimpleNamespace(source="test")  # Fyers credentials (no substitute source)


def _daily(level: float, days=DAYS) -> pd.DataFrame:
    close = level + np.arange(len(days), dtype=float)
    return pd.DataFrame({"open": close, "close": close}, index=days)


@pytest.fixture
def data_dir(tmp_path, monkeypatch):
    monkeypatch.setattr(fetch, "DATA_DIR", tmp_path)
    monkeypatch.setattr(fetch, "load_universe", lambda: [NIFTY, BANK, CASH])
    monkeypatch.setattr(fetch, "amfi_nav", lambda code, start, adjust=True: _daily(10.0)["close"])
    return tmp_path


def _full_fetch(monkeypatch) -> pd.DataFrame:
    """A first fetch where every source answers: the stored state a later fetch starts from."""
    levels = {NIFTY.price_source: 100.0, BANK.price_source: 300.0}
    monkeypatch.setattr(angelone, "resolve_prices", lambda **_: FYERS)
    monkeypatch.setattr(
        fyers, "daily_candles", lambda symbol, start, end, creds: _daily(levels[symbol])
    )
    table, _ = fetch.fetch_all(use_fyers=True, log=lambda m: None, etfs=False)
    assert list(table.columns) == ["Nifty 50", "Nifty Bank", "Cash"]
    return table


def _stored(data_dir, name="weekly_closes.csv") -> pd.DataFrame:
    return pd.read_csv(data_dir / name, index_col=0, parse_dates=True)


def test_a_failed_instrument_keeps_its_weekly_and_daily_history(data_dir, monkeypatch):
    before = _full_fetch(monkeypatch)
    daily_before = (data_dir / "daily" / "Nifty Bank.csv").read_text()

    def candles(symbol, start, end, creds):
        if symbol == BANK.price_source:
            raise RuntimeError("symbol not found")
        return _daily(200.0)  # Nifty 50 moves: it really was re-fetched

    monkeypatch.setattr(fyers, "daily_candles", candles)
    logs: list[str] = []
    table, coverage = fetch.fetch_all(use_fyers=True, log=logs.append, etfs=False)

    stored = _stored(data_dir)
    assert list(stored.columns) == ["Nifty 50", "Nifty Bank", "Cash"]
    pd.testing.assert_series_equal(stored["Nifty Bank"], before["Nifty Bank"], check_freq=False)
    assert stored["Nifty 50"].iloc[0] != before["Nifty 50"].iloc[0]
    assert (data_dir / "daily" / "Nifty Bank.csv").read_text() == daily_before
    assert coverage.loc["Nifty Bank", "error"] == "symbol not found"
    assert coverage.loc["Nifty Bank", "kept"].startswith("stored history")
    assert any("stored weekly history kept: Nifty Bank" in line for line in logs)


def test_no_fyers_keeps_every_broker_sourced_column(data_dir, monkeypatch):
    """The 2026-10-18 run: public sources only. Before the fix this left ['Cash']."""
    before = _full_fetch(monkeypatch)
    monkeypatch.setattr(
        angelone, "resolve_prices", lambda **_: pytest.fail("--no-fyers must not look for a broker")
    )
    table, _ = fetch.fetch_all(use_fyers=False, log=lambda m: None, etfs=False)

    stored = _stored(data_dir)
    assert list(stored.columns) == ["Nifty 50", "Nifty Bank", "Cash"]
    pd.testing.assert_frame_equal(stored, before, check_freq=False)
    assert stored["Nifty 50"].notna().sum() == before["Nifty 50"].notna().sum() > 500


def test_a_fetch_that_lost_older_history_keeps_the_stored_series(data_dir, monkeypatch):
    before = _full_fetch(monkeypatch)
    short = DAYS[DAYS >= "2026-09-01"]  # e.g. the NSE backfill failed
    monkeypatch.setattr(
        fyers,
        "daily_candles",
        lambda symbol, start, end, creds: _daily(
            100.0, short if symbol == BANK.price_source else DAYS
        ),
    )
    _, coverage = fetch.fetch_all(use_fyers=True, log=lambda m: None, etfs=False)

    daily = pd.read_csv(data_dir / "daily" / "Nifty Bank.csv", index_col=0, parse_dates=True)
    assert daily.index[0] == DAYS[0]
    pd.testing.assert_series_equal(
        _stored(data_dir)["Nifty Bank"], before["Nifty Bank"], check_freq=False
    )
    assert "kept the stored history" in coverage.loc["Nifty Bank", "error"]


def test_a_series_removed_from_the_universe_leaves_the_table(data_dir, monkeypatch):
    _full_fetch(monkeypatch)
    monkeypatch.setattr(fetch, "load_universe", lambda: [NIFTY, CASH])
    fetch.fetch_all(use_fyers=True, log=lambda m: None, etfs=False)
    assert list(_stored(data_dir).columns) == ["Nifty 50", "Cash"]


def test_premium_columns_of_etfs_not_fetched_are_kept(data_dir, monkeypatch):
    with_nav = Instrument(
        "core",
        "Gold",
        "Gold",
        "GOLDBEES",
        "gold",
        "NSE:GOLDBEES-EQ",
        "",
        "",
        "NSE:GOLDBEES-EQ",
        "140088",
    )
    monkeypatch.setattr(fetch, "load_universe", lambda: [NIFTY, with_nav, CASH])
    premium = pd.DataFrame(
        {"Gold": [0.01, 0.02]}, index=pd.to_datetime(["2026-10-15", "2026-10-16"])
    )
    premium.index.name = "date"
    premium.to_csv(data_dir / "etf_premium.csv")
    monkeypatch.setattr(
        angelone, "resolve_prices", lambda **_: pytest.fail("--no-fyers must not look for a broker")
    )
    fetch.fetch_all(use_fyers=False, log=lambda m: None, etfs=True)
    pd.testing.assert_frame_equal(_stored(data_dir, "etf_premium.csv"), premium, check_freq=False)


# --- the momentum_prices replace -----------------------------------------------------------------


def _weekly(tmp_path, columns: dict[str, list[float]]) -> None:
    weeks = pd.date_range("2026-01-02", periods=max(len(v) for v in columns.values()), freq="W-FRI")
    pd.DataFrame(
        {k: v + [None] * (len(weeks) - len(v)) for k, v in columns.items()}, index=weeks
    ).to_csv(tmp_path / "weekly_closes.csv", index_label="week_ending")


def test_replace_refuses_data_with_less_history_and_changes_nothing(tmp_path):
    _weekly(tmp_path, {"Nifty 50": [100.0 + i for i in range(40)], "Cash": [10.0] * 40})
    with connect() as con:
        assert db_migrate.import_momentum_prices(con, tmp_path) == 80
        _weekly(tmp_path, {"Nifty 50": [140.0, 141.0], "Cash": [10.0] * 41})  # gutted
        with pytest.raises(db_migrate.PriceShrinkError, match=r"Nifty 50 \(weekly\) 40 -> 2"):
            db_migrate.import_momentum_prices(con, tmp_path)
        _weekly(tmp_path, {"Cash": [10.0] * 41})  # vanished
        with pytest.raises(db_migrate.PriceShrinkError, match=r"Nifty 50 \(weekly\) 40 -> 0"):
            db_migrate.import_momentum_prices(con, tmp_path)
        assert con.execute("SELECT count(*) FROM momentum_prices").fetchone()[0] == 80

        assert db_migrate.import_momentum_prices(con, tmp_path, allow_shrink=True) == 41


def test_replace_allows_a_small_trim(tmp_path):
    """An unfinished week trimmed or a premium day dropped is not a loss worth refusing."""
    _weekly(tmp_path, {"Nifty 50": [100.0 + i for i in range(40)]})
    with connect() as con:
        db_migrate.import_momentum_prices(con, tmp_path)
        _weekly(tmp_path, {"Nifty 50": [100.0 + i for i in range(39)]})
        assert db_migrate.import_momentum_prices(con, tmp_path) == 39


def test_migrate_checks_prices_before_touching_any_table(tmp_path, monkeypatch):
    _weekly(tmp_path, {"Nifty 50": [100.0 + i for i in range(40)]})
    monkeypatch.setattr(
        db_migrate, "import_curated", lambda *a: pytest.fail("ran before the check")
    )
    with connect() as con:
        db_migrate.import_momentum_prices(con, tmp_path)
        _weekly(tmp_path, {"Cash": [10.0]})
        with pytest.raises(db_migrate.PriceShrinkError):
            db_migrate.migrate(con, tmp_path, data_dir=tmp_path)
