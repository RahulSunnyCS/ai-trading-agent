import gzip
import threading
import time
from datetime import date

import pyarrow as pa
import pytest

from trading_data import lake, reference
from trading_data.backup import backup
from trading_data.db import catalog_path, connect
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
        ]
        assert con.execute("SELECT count(*) FROM ref_lot_sizes").fetchone()[0] > 0
    with connect(root) as con:  # second open: nothing re-applied, nothing duplicated
        assert con.execute("SELECT count(*) FROM schema_migrations").fetchone()[0] == 7


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
    table = pa.table({"x": [1, 2, 3]})
    lake.write_parquet(table, lake.bars_1m_path(root, "index", "NIFTY", DAY))
    dest = tmp_path / "other_disk"
    first = backup(root, dest)
    second = backup(root, dest)
    assert (first.copied, second.copied, second.skipped) == (2, 1, 1)
    assert (dest / catalog_path(root).name).exists()
    with pytest.raises(ValueError):
        backup(root, root / "inside")
