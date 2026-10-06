from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo

import pyarrow as pa
import pyarrow.parquet as pq
import pytest
from typer.testing import CliRunner

from trading_data import lake, vendor
from trading_data.cli import app
from trading_data.db import connect

IST = ZoneInfo("Asia/Kolkata")
EXPIRY = date(2026, 3, 26)
TUE, WED = date(2026, 3, 10), date(2026, 3, 11)
SAT = date(2026, 2, 7)  # a Saturday
DRILL = date(2026, 3, 15)  # a Sunday, 50 bars
MUHURAT = date(2026, 3, 16)  # evening only
STRIKES = [22000.0 + 50 * i for i in range(12)]

STAGING_SCHEMA = pa.schema(
    [
        ("underlying", pa.string()),
        ("contract", pa.string()),
        ("strike", pa.float64()),
        ("option_type", pa.string()),
        ("expiry", pa.date32()),
        ("ts", pa.timestamp("us", tz="Asia/Kolkata")),
        ("open", pa.float64()),
        ("high", pa.float64()),
        ("low", pa.float64()),
        ("close", pa.float64()),
        ("volume", pa.int64()),
        ("oi", pa.float64()),
    ]
)


def _rows(symbol, day, *, bars=375, start=(9, 15), strikes=STRIKES, expiry=EXPIRY, price=100.0):
    first = datetime(day.year, day.month, day.day, *start, tzinfo=IST)
    out = []
    for strike in strikes:
        contract = f"{symbol}_{strike:g}_CE_26_MAR_26"
        for m in range(bars):
            out.append(
                (symbol, contract, strike, "CE", expiry, first + timedelta(minutes=m),
                 price, price + 1, price - 1, price, 10, 5.0)
            )  # fmt: skip
    return out


def _write(path, rows):
    path.parent.mkdir(parents=True, exist_ok=True)
    cols = list(zip(*rows, strict=True)) if rows else [()] * len(STAGING_SCHEMA)
    table = pa.table(
        {f.name: pa.array(c, f.type) for f, c in zip(STAGING_SCHEMA, cols, strict=True)}
    )
    pq.write_table(table, path)


@pytest.fixture
def root(tmp_path):
    return tmp_path / "data"


@pytest.fixture
def staging(tmp_path):
    s = tmp_path / "staging"
    nifty = (
        _rows("NIFTY", TUE, bars=385)  # 375 + the 15:30-15:39 closing bars
        + _rows("NIFTY", WED)
        + _rows("NIFTY", SAT)  # a Budget Saturday: a real full session
        + _rows("NIFTY", DRILL, bars=50)  # a drill: 50 bars
        + _rows("NIFTY", MUHURAT, bars=60, start=(18, 15))  # Muhurat: evening only
    )
    nifty.append(
        ("", "WEIRD", None, "", None, datetime(2026, 3, 10, 10, tzinfo=IST), 1, 1, 1, 1, 1, 1.0)
    )
    _write(s / "index" / "nifty" / "2026-03-26.parquet", nifty)
    _write(s / "index" / "nifty" / "2026-03-05.parquet", [])  # an expiry the vendor shipped empty
    (s / "index" / "nifty" / "._2026-03-26.parquet").write_bytes(b"\0\5\x16\7 AppleDouble")
    _write(s / "stocks" / "M&M" / "2026-03-26.parquet", _rows("M&M", TUE, strikes=STRIKES))
    _write(s / "index" / "sensex" / "2026-03-26.parquet", _rows("SENSEX", TUE))
    return s


def _import(root, staging, **kw):
    out = []
    for u in vendor.list_units(staging, units=kw.pop("units", None)):
        out.append(vendor.import_unit(root, u, log=lambda _: None, **kw))
    return out


def _fetch(root, sql, *args):
    with connect(root, read_only=True) as con:
        return con.execute(sql, list(args)).fetchall()


def test_list_units_skips_junk_and_empty_files_and_orders_index_first(staging):
    units = vendor.list_units(staging)
    assert [(u.section, u.folder) for u in units] == [
        ("index", "nifty"),
        ("index", "sensex"),
        ("stocks", "M&M"),
    ]
    assert [f.name for f in units[0].files] == ["2026-03-26.parquet"]  # no ._ file, no empty one
    assert [u.folder for u in vendor.list_units(staging, units=["SENSEX"])] == ["sensex"]
    assert [u.folder for u in vendor.list_units(staging, section="stocks")] == ["M&M"]


def test_plan_chunks_groups_months_and_clips_to_the_window():
    months = [(date(2026, m, 1), 5) for m in (1, 2, 3, 4)]
    assert vendor.plan_chunks(months, (date.min, date.max), target=10) == [
        (date(2026, 1, 1), date(2026, 3, 1)),
        (date(2026, 3, 1), date(2026, 5, 1)),
    ]
    assert vendor.plan_chunks(months, (date.min, date.max), target=1000) == [
        (date(2026, 1, 1), date(2026, 5, 1))
    ]
    assert vendor.plan_chunks(months, (date(2026, 2, 10), date(2026, 3, 5)), target=1000) == [
        (date(2026, 2, 10), date(2026, 3, 6))
    ]


def test_import_writes_one_sorted_file_per_day_in_the_fyers_shape(root, staging):
    _import(root, staging, units=["nifty"])
    days = lake.available_days(root, "option", "NIFTY")
    assert days == [SAT, TUE, WED, DRILL, MUHURAT]  # every day kept, weekend ones included
    table = pq.read_table(lake.bars_1m_path(root, "option", "NIFTY", TUE))
    assert table.schema.names == lake.OPT_SCHEMA.names
    for field in lake.OPT_SCHEMA:
        if field.name != "ts":
            assert table.schema.field(field.name).type == field.type, field.name
    assert table.schema.field("ts").type.tz == "Asia/Kolkata"
    assert "underlying" not in table.schema.names and "date" not in table.schema.names
    ids, ts = table["instrument_id"].to_pylist(), table["ts"].to_pylist()
    assert list(zip(ids, ts, strict=True)) == sorted(zip(ids, ts, strict=True))
    assert set(table["option_type"].to_pylist()) == {"CE"}
    in_file = set(
        zip(table["instrument_id"].to_pylist(), table["vendor_symbol"].to_pylist(), strict=True)
    )
    in_catalog = set(
        _fetch(
            root,
            "SELECT instrument_id, vendor_symbol FROM instrument_aliases WHERE vendor = ?",
            vendor.VENDOR,
        )
    )
    assert in_file == in_catalog and len(in_file) == 12  # id <-> contract name agree everywhere


def test_every_row_is_kept_including_closing_and_evening_bars(root, staging):
    _import(root, staging, units=["nifty"])
    assert pq.read_metadata(lake.bars_1m_path(root, "option", "NIFTY", TUE)).num_rows == 12 * 385
    assert pq.read_metadata(lake.bars_1m_path(root, "option", "NIFTY", MUHURAT)).num_rows == 12 * 60
    row = _fetch(
        root, "SELECT n_rows, max_bars, off_session_rows FROM data_quality "
        "WHERE asset = 'option' AND trading_day = ?", TUE,
    )[0]  # fmt: skip
    assert row == (12 * 385, 375, 12 * 10)


def test_every_day_gets_a_verdict_and_a_session_kind(root, staging):
    _import(root, staging, units=["nifty"])
    got = {
        r[0]: r[1:]
        for r in _fetch(
            root, "SELECT trading_day, source, verdict, reason, session_kind FROM data_quality "
            "WHERE asset = 'option' ORDER BY 1",
        )
    }  # fmt: skip
    # NIFTY has no index series in this lake, so a missing spot is not held against it
    assert got[TUE] == ("vendor", "usable", None, "regular")
    assert got[SAT] == ("vendor", "usable", None, "special")  # a Budget Saturday: a real session
    assert got[DRILL] == ("vendor", "excluded", "short_session:50", "special")
    assert got[MUHURAT] == ("vendor", "excluded", "off_session_only", "off_session")


def test_instruments_aliases_and_ids_match_the_files(root, staging):
    _import(root, staging, units=["nifty", "M&M", "sensex"])
    keys = {
        r[0]
        for r in _fetch(root, "SELECT instrument_key FROM instruments WHERE asset_class = 'option'")
    }
    assert "NSE:OPT:NIFTY:2026-03-26:22000:CE" in keys
    assert "BSE:OPT:SENSEX:2026-03-26:22000:CE" in keys  # SENSEX is a BSE instrument
    assert "NSE:OPT:M&M:2026-03-26:22000:CE" in keys
    assert _fetch(
        root,
        "SELECT u.instrument_key FROM instruments o JOIN instruments u "
        "ON o.underlying_id = u.instrument_id WHERE o.instrument_key = "
        "'NSE:OPT:M&M:2026-03-26:22000:CE'",
    ) == [("NSE:STK:M&M",)]
    assert _fetch(
        root,
        "SELECT i.instrument_key FROM instrument_aliases a "
        "JOIN instruments i USING (instrument_id) "
        "WHERE a.vendor = ? AND a.vendor_symbol = 'NIFTY_22000_CE_26_MAR_26'",
        vendor.VENDOR,
    ) == [("NSE:OPT:NIFTY:2026-03-26:22000:CE",)]
    in_file = set(
        pq.read_table(lake.bars_1m_path(root, "option", "NIFTY", TUE))["instrument_id"].to_pylist()
    )
    in_catalog = {
        r[0]
        for r in _fetch(
            root,
            "SELECT instrument_id FROM instruments WHERE instrument_key LIKE 'NSE:OPT:NIFTY:%'",
        )
    }
    assert in_file == in_catalog and len(in_file) == 12


def test_an_existing_instrument_keeps_its_id_when_the_vendor_sees_it_too(root, staging):
    from trading_data.instruments import InstrumentSpec, register

    with connect(root) as con:
        before = register(
            con,
            [
                InstrumentSpec(
                    "option",
                    "NSE",
                    "NIFTY",
                    expiry=EXPIRY,
                    strike=22000.0,
                    option_type="CE",
                    underlying_key="NSE:IDX:NIFTY",
                    vendor="fyers",
                    vendor_symbol="NSE:NIFTY26MAR22000CE",
                )  # fmt: skip
            ],
        )
    _import(root, staging, units=["nifty"])
    key = "NSE:OPT:NIFTY:2026-03-26:22000:CE"
    assert _fetch(root, "SELECT instrument_id FROM instruments WHERE instrument_key = ?", key) == [
        (before[key],)
    ]
    assert (
        len(_fetch(root, "SELECT * FROM instrument_aliases WHERE instrument_id = ?", before[key]))
        == 2
    )


def test_unparsed_contract_rows_are_counted_not_written(root, staging):
    (report,) = _import(root, staging, units=["nifty"])
    assert report.rows_unparsed == 1  # the WEIRD row
    assert _fetch(root, "SELECT count(*) FROM ingest_runs WHERE source = 'vendor'")[0][0] == 1
    details = _fetch(root, "SELECT details FROM ingest_runs WHERE source = 'vendor'")[0][0]
    assert '"rows_unparsed": 1' in details
    assert _fetch(root, "SELECT check_name FROM quality_issues") == [("unparsed_contract",)]
    assert _fetch(root, "SELECT status FROM ingest_runs WHERE source = 'vendor'") == [("partial",)]


def test_rerun_is_idempotent_and_resumes_by_chunk(root, staging):
    _import(root, staging, units=["nifty"])
    paths = [lake.bars_1m_path(root, "option", "NIFTY", d) for d in (TUE, SAT)]
    mtimes = [p.stat().st_mtime_ns for p in paths]
    (second,) = _import(root, staging, units=["nifty"])
    assert second.chunks_run == 0 and second.chunks_skipped == 1
    assert [p.stat().st_mtime_ns for p in paths] == mtimes
    # the unparsed row makes the run `partial`; a finished run still counts as done
    assert _fetch(root, "SELECT status FROM ingest_runs") == [("partial",)]
    (third,) = _import(root, staging, units=["nifty"], force=True)
    assert third.days_written == 5  # force rewrites vendor days


def test_the_collector_always_wins(root, staging):
    fyers_day = lake.bars_1m_path(root, "option", "NIFTY", TUE)
    rows = _rows("NIFTY", TUE)[:1]
    table = pa.table(
        {
            "instrument_id": pa.array([1], pa.int64()),
            "ts": pa.array([rows[0][5]], lake.TS_TYPE),
            **{f.name: pa.array([1.0], pa.float64()) for f in lake.OHLC_FIELDS},
            "expiry": pa.array([EXPIRY], pa.date32()),
            "strike": pa.array([22000.0], pa.float64()),
            "option_type": pa.array(["CE"], pa.string()),
            "vendor_symbol": pa.array(["NSE:NIFTY26MAR22000CE"], pa.string()),
        }
    ).select(lake.OPT_SCHEMA.names)
    lake.write_parquet(table.cast(lake.OPT_SCHEMA), fyers_day)
    before = fyers_day.read_bytes()
    for force in (False, True):
        (report,) = _import(root, staging, units=["nifty"], force=force)
        assert fyers_day.read_bytes() == before
        assert report.days_skipped_existing >= 1
    assert lake.bars_1m_path(root, "option", "NIFTY", WED).exists()


def test_a_chunk_window_limits_the_days(root, staging):
    _import(root, staging, units=["nifty"], days=(TUE, TUE))
    assert lake.available_days(root, "option", "NIFTY") == [TUE]


def test_special_characters_in_a_stock_name_read_back_through_the_view(root, staging):
    _import(root, staging, units=["M&M"])
    assert _fetch(root, "SELECT count(DISTINCT instrument_id) FROM bars_1m_option "
                  "WHERE underlying = 'M&M'") == [(12,)]  # fmt: skip
    assert _fetch(root, "SELECT underlying FROM bars_1m_option GROUP BY 1") == [("M&M",)]


def test_a_key_collision_aborts_before_writing(root, tmp_path):
    s = tmp_path / "staging"
    a = _rows("NIFTY", TUE, strikes=[1234567.1])
    b = _rows("NIFTY", TUE, strikes=[1234567.2])  # '{:g}' formats both as 1.23457e+06
    _write(s / "index" / "nifty" / "2026-03-26.parquet", a + b)
    with pytest.raises(vendor.VendorError, match="collide"):
        _import(root, s)
    assert lake.available_days(root, "option", "NIFTY") == []


def _spot_csv(path, days, *, bars=375, start=(9, 15), tz="+0530"):
    lines = ["Date,Open,High,Low,Close,Volume"]
    for day in days:
        first = datetime(day.year, day.month, day.day, *start)
        for m in range(bars):
            t = first + timedelta(minutes=m)
            lines.append(f"{t:%Y-%m-%dT%H:%M:%S}{tz},100.5,101,100,100.75,0")
    path.write_text("\n".join(lines) + "\n")


def test_import_index_csv_writes_bar_schema_and_judges_days(root, tmp_path):
    csv = tmp_path / "nifty_spot.csv"
    _spot_csv(csv, [TUE, WED])
    report = vendor.import_index_csv(root, csv, "nifty", log=lambda _: None)
    assert report.days_written == 2
    table = pq.read_table(lake.bars_1m_path(root, "index", "NIFTY", TUE))
    assert table.schema.names == lake.BAR_SCHEMA.names
    assert (
        table["oi"].null_count == len(table) and table["vendor_symbol"][0].as_py() == "nifty_spot"
    )
    assert table["ts"][0].as_py().astimezone(IST).strftime("%H:%M") == "09:15"
    assert _fetch(root, "SELECT instrument_key FROM instruments WHERE symbol = 'NIFTY'") == [
        ("NSE:IDX:NIFTY",)
    ]
    assert _fetch(
        root,
        "SELECT verdict, contracts, expiries FROM data_quality "
        "WHERE asset = 'index' AND trading_day = ?",
        TUE,
    ) == [("usable", 1, None)]


def test_import_index_csv_exchanges_and_short_days(root, tmp_path):
    sensex = tmp_path / "sensex_spot.csv"
    _spot_csv(sensex, [TUE])
    vendor.import_index_csv(root, sensex, "SENSEX", log=lambda _: None)
    vix = tmp_path / "2567_INDIAVIX.csv"
    _spot_csv(vix, [TUE])
    short = tmp_path / "x.csv"
    _spot_csv(short, [WED], bars=40)
    vendor.import_index_csv(root, vix, "INDIAVIX", log=lambda _: None)
    vendor.import_index_csv(root, short, "NIFTY", log=lambda _: None)
    keys = {r[0] for r in _fetch(root, "SELECT instrument_key FROM instruments")}
    assert {"BSE:IDX:SENSEX", "NSE:IDX:INDIAVIX", "NSE:IDX:NIFTY"} <= keys
    assert _fetch(root, "SELECT verdict, reason FROM data_quality WHERE name = 'NIFTY'") == [
        ("excluded", "short_session:40")
    ]


def test_no_spot_clears_when_the_index_arrives_after_the_options(root, staging, tmp_path):
    _import(root, staging, units=["nifty"])
    csv = tmp_path / "nifty_spot.csv"
    _spot_csv(csv, [TUE, WED, SAT])
    vendor.import_index_csv(root, csv, "NIFTY", log=lambda _: None)
    got = dict(
        _fetch(
            root,
            "SELECT trading_day, coalesce(reason, 'ok') FROM data_quality WHERE asset = 'option'",
        )
    )
    assert got[TUE] == "ok" and got[WED] == "ok" and got[SAT] == "ok"
    assert got[DRILL] == "short_session:50"  # no spot that day, but the stronger reason stays


def test_cli_dry_run_import_and_status(root, staging, monkeypatch):
    monkeypatch.setenv("TRADING_DATA_ROOT", str(root))
    runner = CliRunner()
    dry = runner.invoke(app, ["vendor", "import", "--from", str(staging), "--dry-run"])
    assert dry.exit_code == 0 and "index/nifty: 1 files" in dry.output
    assert lake.available_days(root, "option", "NIFTY") == []
    done = runner.invoke(app, ["vendor", "import", "--from", str(staging), "--unit", "nifty"])
    assert done.exit_code == 0, done.output
    assert "== NIFTY: 5 days written" in done.output
    status = runner.invoke(app, ["quality", "status"]).output
    assert "option  NIFTY" in status
    missing = runner.invoke(app, ["vendor", "import", "--from", str(staging), "--unit", "nope"])
    assert missing.exit_code == 1
    bad = runner.invoke(app, ["vendor", "import", "--from", str(staging), "--days", "oops"])
    assert bad.exit_code != 0
