import gzip
import threading
import time
from datetime import UTC, date, datetime

import pyarrow as pa
import pytest

from trading_data import lake, reference
from trading_data.backup import backup
from trading_data.db import FIXED_SCHEMA_VIEWS, LAKE_VIEWS, _migrations, catalog_path, connect
from trading_data.instruments import InstrumentSpec, instrument_key, register

DAY = date(2026, 9, 29)


@pytest.fixture
def root(tmp_path):
    return tmp_path / "data"


def test_fresh_catalog_migrates_once_and_loads_reference(root):
    with connect(root) as con:
        applied = con.execute("SELECT version FROM schema_migrations ORDER BY 1").fetchall()
        assert applied == [
            ("001_core",),
            ("002_momentum",),
            ("003_stock_weekly",),
            ("004_stock_weekly_series",),
            ("005_stock_action_candidates",),
            ("006_stock_action_scan_state",),
            ("007_momentum_forward_journal",),
            ("008_data_quality",),
            ("009_ref_expiries",),
            ("010_ref_rates",),
            ("011_momentum_result_changes",),
            ("012_momentum_orders",),
        ]
        assert con.execute("SELECT count(*) FROM ref_lot_sizes").fetchone()[0] > 0
    with connect(root) as con:  # second open: nothing re-applied, nothing duplicated
        assert con.execute("SELECT count(*) FROM schema_migrations").fetchone()[0] == 12


# The orders tables as the first draft of BL-051 Phase 3 created them, applied to the owner's live
# catalog under the ledger name `011_momentum_orders` (before the paper_capital_rs column existed).
_FIRST_DRAFT_ORDERS_DDL = """
CREATE TABLE momentum_holdings (
    owner TEXT NOT NULL, synced_at TEXT NOT NULL,
    source TEXT NOT NULL CHECK (source IN ('fyers', 'paste')),
    symbol TEXT NOT NULL, quantity DOUBLE NOT NULL, avg_price DOUBLE,
    PRIMARY KEY (owner, synced_at, symbol)
);
CREATE TABLE momentum_holding_rules (
    owner TEXT NOT NULL, symbol TEXT NOT NULL,
    treatment TEXT NOT NULL CHECK (treatment IN ('exclude', 'cash')),
    PRIMARY KEY (owner, symbol)
);
CREATE TABLE momentum_owner_settings (
    owner TEXT PRIMARY KEY,
    min_trade_rs DOUBLE NOT NULL DEFAULT 10000,
    extra_cash_rs DOUBLE NOT NULL DEFAULT 0,
    holdings_source TEXT NOT NULL DEFAULT 'paper' CHECK (holdings_source IN ('paper', 'fyers')),
    updated_at TEXT
);
CREATE TABLE momentum_orders (
    owner TEXT NOT NULL, week DATE NOT NULL, created_at TEXT NOT NULL,
    trigger TEXT NOT NULL CHECK (trigger IN ('scheduled', 'manual')),
    favourite_id TEXT NOT NULL, holdings_source TEXT NOT NULL, payload TEXT NOT NULL,
    PRIMARY KEY (owner, week, created_at)
);
"""


def test_012_applies_over_catalog_with_old_011_ledger(root):
    """The live catalog's ledger says `011_momentum_orders` (the file's name before it was
    renumbered to 012) and already holds those tables, one without paper_capital_rs. Opening it
    must not crash on 'Table ... already exists', must keep every row, and must add the column."""
    with connect(root, views=()) as con:  # a current catalog, then rewind its orders part
        for t in (
            "momentum_orders",
            "momentum_owner_settings",
            "momentum_holding_rules",
            "momentum_holdings",
        ):
            con.execute(f"DROP TABLE {t}")
        con.execute(_FIRST_DRAFT_ORDERS_DDL)
        con.execute("DELETE FROM schema_migrations WHERE version = '012_momentum_orders'")
        con.execute("INSERT INTO schema_migrations (version) VALUES ('011_momentum_orders')")
        con.execute(
            "INSERT INTO momentum_owner_settings (owner, min_trade_rs) VALUES ('rahul', 7000)"
        )
        con.execute("INSERT INTO momentum_holding_rules VALUES ('rahul', 'LIQUIDBEES', 'cash')")
        con.execute(
            "INSERT INTO momentum_holdings VALUES ('rahul', '2026-10-09T15:00:00+05:30', 'paste', "
            "'SBIN', 10, 800.5)"
        )
        con.execute(
            "INSERT INTO momentum_orders VALUES ('rahul', DATE '2026-10-09', "
            "'2026-10-09T14:15:00+05:30', 'scheduled', 'fav', 'paper', '{}')"
        )
    # the live ledger is 001..010, 011_momentum_orders, 011_momentum_result_changes; opening it
    # adds only 012_momentum_orders, so one row more than there are migration files
    ledger_rows = len(_migrations()) + 1
    with connect(root, views=()) as con:
        assert con.execute("SELECT count(*) FROM schema_migrations").fetchone()[0] == ledger_rows
        assert (
            con.execute(
                "SELECT count(*) FROM schema_migrations WHERE version = '011_momentum_orders'"
            ).fetchone()[0]
            == 1
        )
        assert (
            con.execute(
                "SELECT count(*) FROM schema_migrations WHERE version = '012_momentum_orders'"
            ).fetchone()[0]
            == 1
        )
        # the rows written under the old name survive, and the later column is there
        assert con.execute(
            "SELECT owner, min_trade_rs, holdings_source, paper_capital_rs "
            "FROM momentum_owner_settings"
        ).fetchall() == [("rahul", 7000.0, "paper", 100000.0)]
        assert con.execute("SELECT treatment FROM momentum_holding_rules").fetchall() == [("cash",)]
        assert con.execute("SELECT symbol, quantity FROM momentum_holdings").fetchall() == [
            ("SBIN", 10.0)
        ]
        assert con.execute("SELECT count(*) FROM momentum_orders").fetchone()[0] == 1
        con.execute("INSERT INTO momentum_owner_settings (owner) VALUES ('friend')")
        assert (
            con.execute(
                "SELECT paper_capital_rs FROM momentum_owner_settings WHERE owner = 'friend'"
            ).fetchone()[0]
            == 100000.0
        )
    with connect(root, views=()) as con:  # and the next open applies nothing
        assert con.execute("SELECT count(*) FROM schema_migrations").fetchone()[0] == ledger_rows


def test_004_moves_stock_benchmark_tris_out_of_momentum_prices(root):
    """A catalog written under 003 kept the stock dataset's TRIs in momentum_prices;
    004 moves them to stock_weekly_series and leaves everything else (incl. the
    ambiguous shared cash rows) where it was."""
    with connect(root) as con:  # simulate a pre-004 catalog
        con.execute("DROP TABLE stock_weekly_series")
        con.execute("DELETE FROM schema_migrations WHERE version = '004_stock_weekly_series'")
        con.execute(
            "INSERT INTO momentum_prices VALUES "
            "('Nifty 50 TRI', 'weekly', DATE '2020-01-03', NULL, 1000.0), "
            "('Cash (liquid fund)', 'weekly', DATE '2020-01-03', NULL, 10.0), "
            "('Nifty 50', 'weekly', DATE '2020-01-03', NULL, 12000.0)"
        )
    with connect(root) as con:
        assert con.execute("SELECT * FROM stock_weekly_series").fetchall() == [
            ("Nifty 50 TRI", date(2020, 1, 3), 1000.0)
        ]
        assert con.execute("SELECT instrument FROM momentum_prices ORDER BY 1").fetchall() == [
            ("Cash (liquid fund)",),
            ("Nifty 50",),
        ]


def test_a_concurrent_read_only_connect_does_not_fail_while_a_write_connection_is_open(root):
    """A write connection (e.g. saving a run) still open in one thread used to make a
    concurrent read_only=True connect() in another thread raise `ConnectionException:
    ... different configuration than existing connections` instead of just waiting —
    reproduced live 2026-09-30 via `mbt ui`'s FastAPI threadpool (a stock-dataset GET
    arriving while a saved-runs POST was still mid-write). `_open()` now retries this
    the same way it already retried a lock IOException."""
    with connect(root):
        pass  # create the catalog first, outside the timing-sensitive part below

    errors: list[Exception] = []

    def writer() -> None:
        with connect(root) as con:
            con.execute("SELECT 1")
            time.sleep(1)

    def reader() -> None:
        time.sleep(0.3)  # start while the writer's connection is still open
        try:
            with connect(root, read_only=True) as con:
                con.execute("SELECT 1")
        except Exception as error:  # noqa: BLE001 - the point is that nothing raises
            errors.append(error)

    writer_thread = threading.Thread(target=writer)
    reader_thread = threading.Thread(target=reader)
    writer_thread.start()
    reader_thread.start()
    writer_thread.join()
    reader_thread.join()
    assert errors == []


def test_views_exist_and_are_empty_on_a_fresh_lake(root):
    with connect(root) as con:
        for view in ("bars_1m_option", "bars_1m_index", "bars_1m_future", "symbol_master"):
            assert con.execute(f"SELECT count(*) FROM {view}").fetchone()[0] == 0


def test_views_limits_the_lake_views_a_connection_binds(root):
    """Binding the 1-minute views takes tens of seconds on the live lake with the catalog
    locked; a caller that never reads them must be able to skip them."""
    with connect(root, views=("bars_1d_stock",)) as con:
        assert con.execute("SELECT count(*) FROM bars_1d_stock").fetchone()[0] == 0
        bound = {
            name
            for (name,) in con.execute(
                "SELECT view_name FROM duckdb_views() WHERE temporary AND NOT internal"
            ).fetchall()
        }
        assert bound & LAKE_VIEWS.keys() == {"bars_1d_stock"}
    with pytest.raises(ValueError, match="bars_1m_nope"), connect(root, views=("bars_1m_nope",)):
        pass


def test_read_only_needs_an_existing_catalog(root):
    with pytest.raises(FileNotFoundError), connect(root, read_only=True):
        pass


def test_reference_export_reproduces_the_committed_csvs_byte_for_byte(root, tmp_path):
    out = tmp_path / "exported"
    out.mkdir()
    with connect(root) as con:
        reference.export_csvs(con, out)
        assert reference.check(con) == []  # the real committed files are in sync
    for t in reference.TABLES:
        assert (out / t.csv_name).read_text() == (reference.REFERENCE_DIR / t.csv_name).read_text()


def test_reference_check_reports_drift(root, tmp_path):
    folder = tmp_path / "ref"
    folder.mkdir()
    with connect(root) as con:
        reference.export_csvs(con, folder)
        con.execute("INSERT INTO ref_lot_sizes VALUES ('NIFTY', 75, DATE '2027-01-01')")
        assert reference.check(con, folder) == ["lot_sizes.csv"]
        assert "+NIFTY,75,2027-01-01" in reference.diff_preview(con, "lot_sizes.csv", folder)


def test_register_is_idempotent_and_links_derivatives_to_their_underlying(root):
    opt = InstrumentSpec(
        "option",
        "NSE",
        "RELIANCE",
        expiry=date(2026, 10, 27),
        strike=1400.0,
        option_type="PE",
        lot_size=500,
        underlying_key=instrument_key("NSE", "stock", "RELIANCE"),
        vendor="fyers",
        vendor_symbol="NSE:RELIANCE26OCT1400PE",
    )
    with connect(root) as con:
        first = register(con, [opt])
        second = register(con, [opt])
        assert first == second
        rows = con.execute(
            "SELECT o.instrument_key, u.instrument_key FROM instruments o "
            "JOIN instruments u ON o.underlying_id = u.instrument_id"
        ).fetchall()
        assert rows == [("NSE:OPT:RELIANCE:2026-10-27:1400:PE", "NSE:STK:RELIANCE")]
        assert con.execute("SELECT count(*) FROM instrument_aliases").fetchone()[0] == 1


def test_register_many_aliases_keeps_the_conflict_semantics(root):
    """Aliases go in with one bulk INSERT (executemany cost ~4 ms/row, so a daily fetch of
    thousands of contracts took a minute or more). It must keep `ON CONFLICT DO NOTHING`:
    re-registering is a no-op, and a vendor symbol repeated within ONE call is stored once,
    pointing at the first instrument - not an error."""

    def option(strike: float, vendor_symbol: str) -> InstrumentSpec:
        return InstrumentSpec(
            "option",
            "NSE",
            "NIFTY",
            expiry=date(2026, 10, 6),
            strike=strike,
            option_type="CE",
            lot_size=65,
            vendor="fyers",
            vendor_symbol=vendor_symbol,
        )

    specs = [option(22000.0 + 50 * i, f"NSE:NIFTY26O06{22000 + 50 * i}CE") for i in range(500)]
    with connect(root) as con:
        ids = register(con, specs)
        assert len(ids) == 500
        count = lambda: con.execute("SELECT count(*) FROM instrument_aliases").fetchone()[0]  # noqa: E731
        assert count() == 500

        assert register(con, specs) == ids  # again: nothing added, same ids
        assert count() == 500

        # two DIFFERENT instruments that claim the same vendor symbol, in one call
        clash = [option(30000.0, "NSE:CLASH"), option(30050.0, "NSE:CLASH")]
        got = register(con, clash)
        rows = con.execute(
            "SELECT instrument_id FROM instrument_aliases WHERE vendor_symbol = 'NSE:CLASH'"
        ).fetchall()
        assert rows == [(got[clash[0].key],)]  # one row, the first instrument's
        assert count() == 501


def test_raw_sink_replaces_rather_than_appends(root):
    for _ in range(2):
        sink = lake.RawSink(root, "fyers", DAY)
        sink.add("NIFTY", "NSE:X", {"a": 1}, {"s": "ok"})
        sink.flush("NIFTY")
    with gzip.open(lake.raw_path(root, "fyers", DAY, "NIFTY"), "rt") as fh:
        assert len(fh.read().splitlines()) == 1


def test_backup_copies_new_files_only_and_always_the_catalog(root, tmp_path):
    with connect(root):
        pass
    lake.write_parquet(_index_bars(1.0), lake.bars_1m_path(root, "index", "NIFTY", DAY))
    dest = tmp_path / "other_disk"
    first = backup(root, dest)
    second = backup(root, dest)
    assert (first.copied, second.copied, second.skipped) == (2, 1, 1)
    assert (dest / catalog_path(root).name).exists()
    with pytest.raises(ValueError):
        backup(root, root / "inside")


def test_bar_schemas_are_the_lake_contract():
    """Every bars_1m writer (Fyers collector, vendor importer) casts to these; legwise
    reads ts as an absolute instant, expiry as a date and option_type as CE/PE."""
    assert lake.BAR_SCHEMA.names == [
        "instrument_id",
        "ts",
        "open",
        "high",
        "low",
        "close",
        "volume",
        "oi",
        "vendor_symbol",
    ]
    assert lake.OPT_SCHEMA.names == [
        "instrument_id", "ts", "open", "high", "low", "close", "volume", "oi",
        "expiry", "strike", "option_type", "vendor_symbol",
    ]  # fmt: skip
    assert lake.OPT_SCHEMA.field("ts").type == pa.timestamp("s", tz="Asia/Kolkata")
    assert lake.OPT_SCHEMA.field("expiry").type == pa.date32()


def _index_bars(close: float) -> pa.Table:
    return pa.table(
        {
            "instrument_id": pa.array([1], pa.int64()),
            "ts": pa.array([datetime(2026, 9, 29, 9, 15, tzinfo=UTC)], lake.TS_TYPE),
            **{f.name: pa.array([close], pa.float64()) for f in lake.OHLC_FIELDS},
            "vendor_symbol": pa.array(["NSE:NIFTY50-INDEX"], pa.string()),
        }
    )


def test_a_bars_1m_file_must_have_the_lake_schema(root):
    """The 1-minute views bind without union_by_name (FIXED_SCHEMA_VIEWS): DuckDB takes the first
    file's columns and silently casts or drops a later file's, so no other shape may be written."""
    path = lake.bars_1m_path(root, "index", "NIFTY", DAY)
    wrong = _index_bars(1.0).set_column(0, "instrument_id", pa.array([1.0], pa.float64()))
    with pytest.raises(ValueError, match="BAR_SCHEMA"):
        lake.write_parquet(wrong, path)
    with pytest.raises(ValueError, match="OPT_SCHEMA"):
        lake.write_parquet(_index_bars(1.0), lake.bars_1m_path(root, "option", "NIFTY", DAY))
    assert not path.exists()
    lake.write_parquet(_index_bars(1.0), path)  # and the right one goes through
    lake.write_parquet(pa.table({"x": [1]}), root / "lake" / "elsewhere" / "data.parquet")


def test_fixed_schema_views_read_every_file(root):
    """Bound from the first file only, the 1-minute views must still read every day's rows."""
    for i, day in enumerate((DAY, date(2026, 9, 30), date(2026, 10, 1))):
        lake.write_parquet(_index_bars(100.0 + i), lake.bars_1m_path(root, "index", "NIFTY", day))
    with connect(root, views=("bars_1m_index",)) as con:
        assert con.execute(
            "SELECT count(*), count(DISTINCT date), sum(close) FROM bars_1m_index"
        ).fetchone() == (3, 3, 303.0)
    assert LAKE_VIEWS.keys() >= FIXED_SCHEMA_VIEWS
    assert "bars_1d_stock" not in FIXED_SCHEMA_VIEWS  # its files differ in column order


def test_partitions_lists_every_day_file_of_one_asset(root):
    for name, day in (("NIFTY", DAY), ("M&M", DAY), ("NIFTY", date(2026, 9, 30))):
        path = lake.bars_1m_path(root, "option", name, day)
        lake.write_parquet(lake.OPT_SCHEMA.empty_table(), path)
    lake.write_parquet(_index_bars(1.0), lake.bars_1m_path(root, "index", "NIFTY", DAY))
    got = [(name, day) for name, day, _ in lake.partitions(root, "option")]
    assert got == [("M&M", DAY), ("NIFTY", DAY), ("NIFTY", date(2026, 9, 30))]
    assert lake.partitions(root, "future") == []


def test_status_runs_in_this_packages_own_environment(root, monkeypatch):
    """`tdata status` once called DuckDB's `.df()`, which needs pandas/numpy — not
    dependencies of this package — so it crashed here as soon as a view had rows."""
    from typer.testing import CliRunner

    from trading_data.cli import app

    monkeypatch.setenv("TRADING_DATA_ROOT", str(root))
    with connect(root):
        pass
    lake.write_parquet(_index_bars(1.0), lake.bars_1m_path(root, "index", "NIFTY", DAY))
    result = CliRunner().invoke(app, ["status"])
    assert result.exit_code == 0, result.output
    assert "bars_1m_index" in result.output and "1 days" in result.output


def test_derive_expiries_reads_the_lake_and_keeps_added_rows(root):
    import pyarrow.parquet as pq

    def day_file(day: str, expiries: list[str]) -> None:
        path = root / "lake" / "bars_1m" / "asset=option" / "underlying=NIFTY" / f"date={day}"
        path.mkdir(parents=True)
        table = pa.table({"expiry": pa.array([date.fromisoformat(e) for e in expiries])})
        pq.write_table(table, path / "data.parquet")

    day_file("2024-09-20", ["2024-09-26"])  # before EXPIRIES_FROM: ignored
    day_file("2025-01-15", ["2025-01-16", "2025-01-30"])
    day_file("2025-01-16", ["2025-01-16", "2025-01-23"])
    with connect(root) as con:
        con.execute("DELETE FROM ref_expiries")
        con.execute(
            "INSERT INTO ref_expiries VALUES ('NIFTY', DATE '2025-01-23', 'added'),"
            " ('NIFTY', DATE '2025-02-06', 'added')"
        )
        assert reference.derive_expiries(con, root, ("NIFTY",)) == {"NIFTY": 3}
        rows = con.execute(
            "SELECT expiry::VARCHAR, source FROM ref_expiries ORDER BY expiry"
        ).fetchall()
    assert rows == [
        ("2025-01-16", "observed"),
        ("2025-01-23", "observed"),  # was added; the lake has it now
        ("2025-01-30", "observed"),
        ("2025-02-06", "added"),  # kept
    ]


def test_quality_snapshot_round_trip_without_the_catalog(root):
    from trading_data import quality

    assert quality.excluded_days(root, "option", "NIFTY") is None  # nothing exported yet
    with connect(root) as con:
        sql = (
            "INSERT INTO data_quality (asset, name, trading_day, source, verdict, reason,"
            " session_kind, n_rows, contracts, max_bars) VALUES (?, ?, ?, ?, ?, ?, ?, 1, 20, ?)"
        )
        rows = [
            ("option", "NIFTY", date(2025, 1, 1), "vendor", "usable", None, "regular", 375),
            ("option", "NIFTY", date(2025, 1, 2), "vendor", "excluded", "short_session:120",
             "regular", 120),
            ("option", "SENSEX", date(2025, 1, 2), "vendor", "excluded", "no_spot", "regular", 375),
        ]  # fmt: skip
        con.executemany(sql, rows)
    with connect(root, read_only=True) as con:  # a reader can refresh it too
        quality.export_snapshot(con, root)
    assert quality.excluded_days(root, "option", "NIFTY") == {date(2025, 1, 2): "short_session:120"}
    assert quality.excluded_days(root, "option", "BANKNIFTY") == {}


def test_no_catalog_connection_here_binds_lake_views():
    """Binding views runs with the catalog locked, and no code in this package reads a lake view
    through the catalog (heavy reads go to the Parquet directly; `tdata status` counts on an
    in-memory DuckDB). So every connect() here says which views it needs — `()` so far."""
    import ast
    from pathlib import Path

    src = Path(__file__).parents[1] / "src" / "trading_data"
    missing = []
    for path in sorted(src.rglob("*.py")):
        for node in ast.walk(ast.parse(path.read_text())):
            if (
                isinstance(node, ast.Call)
                and isinstance(node.func, ast.Name)
                and node.func.id in ("connect", "_connect_catalog")
                and not any(k.arg == "views" for k in node.keywords)
            ):
                missing.append(f"{path.name}:{node.lineno}")
    assert missing == []
