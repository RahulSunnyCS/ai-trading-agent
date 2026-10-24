"""`mbt fetch` never drops a series it did not fetch, and the momentum_prices replace refuses a
data/ folder with less history than the database.

On 2026-10-18 `mbt fetch --no-fyers` rewrote weekly_closes.csv with the public series alone;
the 22 broker-sourced columns (every Nifty index, Gold, Gilt) then held only the weeks later
refreshes added, the replace carried that into momentum_prices, and on 2026-10-24 every
Broad favourite failed on an all-NaN Nifty 50 benchmark."""

from datetime import date
from types import SimpleNamespace

import numpy as np
import pandas as pd
import pytest
from trading_data.db import connect
from typer.testing import CliRunner

from momentum_backtesting import angelone, db_migrate, fetch, fyers, local_store
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
    logs: list[str] = []
    fetch.fetch_all(use_fyers=True, log=logs.append, etfs=False)
    assert list(_stored(data_dir).columns) == ["Nifty 50", "Cash"]
    said = [line for line in logs if "no longer in universe.csv" in line]
    assert said and "Nifty Bank" in said[0] and "--allow-price-shrink" in said[0]


def test_stored_days_past_the_fetched_end_are_kept(data_dir, monkeypatch):
    """E.g. ETF-implied closes a refresh stored for days the official source has not published."""
    _full_fetch(monkeypatch)
    path = data_dir / "daily" / "Nifty Bank.csv"
    daily = pd.read_csv(path, index_col=0, parse_dates=True)
    extra = pd.DataFrame(
        {"open": [None, None], "close": [9000.0, 9001.0]},
        index=pd.to_datetime(["2026-10-19", "2026-10-20"]),
    )
    pd.concat([daily, extra]).to_csv(path, index_label="date")
    fetch.fetch_all(use_fyers=True, log=lambda m: None, etfs=False)
    after = pd.read_csv(path, index_col=0, parse_dates=True)
    assert list(after.index[-2:]) == list(extra.index)
    assert after["close"].iloc[-1] == 9001.0


def test_a_shorter_silver_splice_keeps_the_stored_column(data_dir, monkeypatch):
    silver = Instrument("core", "Commodity", "Silver", "SILVERBEES", "gold", "SILVER", "", "")
    monkeypatch.setattr(fetch, "load_universe", lambda: [silver, CASH])
    weeks = pd.date_range("2016-01-01", "2026-10-16", freq="W-FRI")
    full = pd.Series(np.arange(len(weeks), dtype=float) + 50, index=weeks)
    splice = {"prices": full}
    monkeypatch.setattr(
        fetch,
        "silver_weekly",
        lambda start: (splice["prices"], pd.Series("yahoo", splice["prices"].index)),
    )
    monkeypatch.setattr(fetch, "silver_daily", lambda start: _daily(50.0)["close"])
    fetch.fetch_all(use_fyers=False, log=lambda m: None, etfs=False)
    before = _stored(data_dir)["Silver"]

    splice["prices"] = full[full.index >= "2020-01-01"]  # Yahoo returned less history
    _, coverage = fetch.fetch_all(use_fyers=False, log=lambda m: None, etfs=False)
    pd.testing.assert_series_equal(_stored(data_dir)["Silver"], before, check_freq=False)
    assert "kept the stored history" in coverage.loc["Silver", "error"]


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


@pytest.mark.parametrize(
    "count, allowed",
    [
        (14, 1),  # a short premium series: 5 rows would be 36% of it
        (40, 4),  # the flat 5 rows never exceeds 10% of a short series
        (100, 5),  # the flat allowance
        (250, 5),  # 2% is 5 rows
        (400, 8),  # 2% takes over: 400 -> 390 (the old 10% rule's pass) is refused
        (1000, 20),
    ],
)
def test_replace_allowance_is_the_larger_of_two_percent_and_a_capped_five_rows(
    tmp_path, count, allowed
):
    assert db_migrate.shrink_allowance(count) == pytest.approx(allowed, abs=0.5)
    _weekly(tmp_path, {"Nifty 50": [100.0 + i for i in range(count)]})
    with connect() as con:
        db_migrate.import_momentum_prices(con, tmp_path)
        _weekly(tmp_path, {"Nifty 50": [100.0 + i for i in range(count - allowed)]})
        assert db_migrate.import_momentum_prices(con, tmp_path) == count - allowed
        db_migrate.import_momentum_prices(con, tmp_path, allow_shrink=True)

    _weekly(tmp_path, {"Nifty 50": [100.0 + i for i in range(count)]})
    with connect() as con:
        db_migrate.import_momentum_prices(con, tmp_path)
        _weekly(tmp_path, {"Nifty 50": [100.0 + i for i in range(count - allowed - 1)]})
        with pytest.raises(db_migrate.PriceShrinkError, match=rf"{count} -> {count - allowed - 1}"):
            db_migrate.import_momentum_prices(con, tmp_path)
        assert con.execute("SELECT count(*) FROM momentum_prices").fetchone()[0] == count


def test_replace_refuses_a_series_that_starts_later_whatever_the_count(tmp_path):
    weeks = pd.date_range("2026-01-02", periods=40, freq="W-FRI")
    pd.DataFrame({"Nifty 50": 100.0}, index=weeks).to_csv(
        tmp_path / "weekly_closes.csv", index_label="week_ending"
    )
    with connect() as con:
        db_migrate.import_momentum_prices(con, tmp_path)
        later = pd.date_range("2026-02-06", periods=40, freq="W-FRI")  # same count, older lost
        pd.DataFrame({"Nifty 50": 100.0}, index=later).to_csv(
            tmp_path / "weekly_closes.csv", index_label="week_ending"
        )
        with pytest.raises(db_migrate.PriceShrinkError, match="starts 2026-02-06"):
            db_migrate.import_momentum_prices(con, tmp_path)


def test_push_dir_refuses_too(tmp_path):
    """The weekly job's push (refresh_weekly_snapshot) goes through the same check."""
    _weekly(tmp_path, {"Nifty 50": [100.0 + i for i in range(40)]})
    with connect() as con:
        local_store.push_dir(con, tmp_path)
        _weekly(tmp_path, {"Cash": [10.0]})
        with pytest.raises(db_migrate.PriceShrinkError):
            local_store.push_dir(con, tmp_path, pd.Timestamp("2026-09-01"))


def _stub_other_imports(monkeypatch, seen: list[str]) -> None:
    for name, value in (
        ("import_curated", (0, 0, 0)),
        ("import_category_membership", 0),
        ("import_total_market_membership", 0),
        ("import_corporate_actions", 0),
        ("migrate_stock_bars", (0, 0, 0)),
        ("import_stock_weekly", (0, 0, 0)),
    ):
        monkeypatch.setattr(
            db_migrate, name, lambda *a, _n=name, _v=value, **k: seen.append(_n) or _v
        )


def test_a_refused_price_replace_does_not_block_the_stock_imports(tmp_path, monkeypatch):
    """The 19:30 stock sync must not leave the stock tables a week behind because data/'s ETF
    series shrank: migrate keeps momentum_prices, copies the rest and reports the refusal."""
    _weekly(tmp_path, {"Nifty 50": [100.0 + i for i in range(40)]})
    seen: list[str] = []
    _stub_other_imports(monkeypatch, seen)
    with connect() as con:
        db_migrate.import_momentum_prices(con, tmp_path)
        _weekly(tmp_path, {"Cash": [10.0]})
        report = db_migrate.migrate(con, tmp_path, data_dir=tmp_path)
        assert con.execute("SELECT count(*) FROM momentum_prices").fetchone()[0] == 40
    assert "Nifty 50 (weekly) 40 -> 0" in report.momentum_prices_refused
    assert "import_stock_weekly" in seen and "migrate_stock_bars" in seen


@pytest.mark.parametrize("refused, code", [(None, 0), ("Nifty 50 (weekly) 40 -> 0 rows", 1)])
def test_local_migrate_exits_1_after_copying_the_rest_when_prices_are_refused(
    monkeypatch, refused, code
):
    from contextlib import nullcontext

    from momentum_backtesting import cli, db_read, stock_actions

    calls = {}

    def migrate(con, root, allow_price_shrink=False):
        calls["allow"] = allow_price_shrink
        return db_migrate.MigrationReport(momentum_prices_refused=refused)

    monkeypatch.setattr(db_migrate, "migrate", migrate)
    monkeypatch.setattr(db_read, "open_catalog", lambda *a, **k: nullcontext())
    scan = {"candidates": 0, "confirmed": 0, "review": 0}
    monkeypatch.setattr(stock_actions, "scan_and_store", lambda *a: calls.setdefault("scan", scan))

    result = CliRunner().invoke(cli.app, ["local", "migrate"])
    assert result.exit_code == code, result.output
    assert calls["allow"] is False and "scan" in calls  # the large-drop scan still ran
    if refused:
        assert "momentum_prices kept as stored" in result.output
        assert (
            "momentum_prices REFUSED" in result.output
            and "momentum_prices rows 0" not in result.output
        )
    else:
        assert "momentum_prices rows 0" in result.output

    CliRunner().invoke(cli.app, ["local", "migrate", "--allow-price-shrink"])
    assert calls["allow"] is True


# --- fetch_etfs keeps a longer stored ETF / premium history too ----------------------------------

GOLD = Instrument(
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


def _etf_fetch(data_dir, monkeypatch, etf_days, nav_days, log=None):
    monkeypatch.setattr(fetch, "load_universe", lambda: [GOLD])
    monkeypatch.setattr(
        fetch, "_etf_daily", lambda inst, start, end, creds: (_daily(50.0, etf_days), "test")
    )
    nav = _daily(50.0)["close"].loc[nav_days] / 1.01  # the same days' closes, 1% under
    monkeypatch.setattr(fetch, "amfi_nav", lambda code, start, adjust=True: nav)
    signal = {"Gold": _daily(50.0)}
    return fetch.fetch_etfs(
        date(2016, 1, 1), date(2026, 10, 16), None, signal, (log if log is not None else []).append
    )


def test_fetch_etfs_writes_the_full_history(data_dir, monkeypatch):
    premiums = _etf_fetch(data_dir, monkeypatch, DAYS, DAYS)
    assert len(premiums["Gold"]) == len(DAYS)
    assert len(pd.read_csv(data_dir / "daily_etf" / "Gold.csv")) == len(DAYS)


def test_a_shorter_etf_history_keeps_the_stored_etf_file_and_premium(data_dir, monkeypatch):
    _etf_fetch(data_dir, monkeypatch, DAYS, DAYS)
    stored = (data_dir / "daily_etf" / "Gold.csv").read_text()
    logs: list[str] = []
    premiums = _etf_fetch(data_dir, monkeypatch, DAYS[DAYS >= "2026-09-01"], DAYS, logs)
    assert (data_dir / "daily_etf" / "Gold.csv").read_text() == stored
    assert "Gold" not in premiums  # fetch_all then carries the stored premium column
    assert any("SHORTER" in line for line in logs)


def test_a_shorter_nav_history_keeps_the_stored_premium_column(data_dir, monkeypatch):
    pd.DataFrame({"Gold": 0.01}, index=DAYS).rename_axis("date").to_csv(
        data_dir / "etf_premium.csv"
    )
    logs: list[str] = []
    premiums = _etf_fetch(data_dir, monkeypatch, DAYS, DAYS[DAYS >= "2026-09-01"], logs)
    assert "Gold" not in premiums
    assert any("premium history SHORTER" in line for line in logs)
    assert len(pd.read_csv(data_dir / "daily_etf" / "Gold.csv")) == len(DAYS)  # the ETF was fine
