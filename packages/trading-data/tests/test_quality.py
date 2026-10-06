from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo

import pyarrow as pa
import pytest
from typer.testing import CliRunner

from trading_data import lake, quality
from trading_data.cli import app
from trading_data.db import connect
from trading_data.quality import DayStats, verdict

IST = ZoneInfo("Asia/Kolkata")
FRIDAY = date(2026, 9, 25)
SATURDAY = date(2026, 2, 7)  # a Saturday


def _stats(**kw):
    base = dict(
        asset="option", name="NIFTY", day=FRIDAY, n_rows=1, contracts=50, expiries=2,
        max_bars=375, off_session_rows=0, first_ts=None, last_ts=None,
    )  # fmt: skip
    return DayStats(**{**base, **kw})


def make_day(root, asset, name, day, *, contracts=12, bars=375, start=(9, 15), extra_after=0,
             seconds=0, vendor_symbol="NIFTY_{i}_CE_01_JAN_26"):  # fmt: skip
    """One lake file: `contracts` instruments with `bars` one-minute bars from `start`, plus
    `extra_after` more bars after them (closing bars or an evening session)."""
    first = datetime(day.year, day.month, day.day, *start, seconds, tzinfo=IST)
    rows = []
    for i in range(contracts):
        for m in range(bars + extra_after):
            rows.append((i + 1, first + timedelta(minutes=m), vendor_symbol.format(i=i)))
    cols = {
        "instrument_id": pa.array([r[0] for r in rows], pa.int64()),
        "ts": pa.array([r[1] for r in rows], lake.TS_TYPE),
        "vendor_symbol": pa.array([r[2] for r in rows], pa.string()),
    }
    for f in lake.OHLC_FIELDS:
        cols[f.name] = pa.array([100.0] * len(rows), pa.float64())
    if asset == "option":
        cols["expiry"] = pa.array([date(2026, 10, 27)] * len(rows), pa.date32())
        cols["strike"] = pa.array([22000.0] * len(rows), pa.float64())
        cols["option_type"] = pa.array(["CE"] * len(rows), pa.string())
        schema = lake.OPT_SCHEMA
    else:
        schema = lake.BAR_SCHEMA
    lake.write_parquet(pa.table(cols).select(schema.names).cast(schema), lake.bars_1m_path(
        root, asset, name, day))  # fmt: skip


@pytest.fixture
def root(tmp_path):
    return tmp_path / "data"


def test_verdict_rules():
    assert verdict(_stats()) == ("usable", None)
    assert verdict(_stats(max_bars=310)) == ("usable", None)
    assert verdict(_stats(max_bars=299)) == ("excluded", "short_session:299")
    assert verdict(_stats(max_bars=0)) == ("excluded", "off_session_only")
    assert verdict(_stats(contracts=5)) == ("excluded", "thin_chain:5")
    assert verdict(_stats(max_bars=390)) == ("excluded", "duplicate_bars:390")
    assert verdict(_stats(asset="index", contracts=1)) == ("usable", None)  # a chain needs >1


def test_session_kind_marks_weekend_and_holiday_sessions():
    holidays = {date(2026, 10, 2)}
    assert quality.session_kind(_stats(), holidays) == "regular"
    assert quality.session_kind(_stats(day=SATURDAY), holidays) == "special"
    assert quality.session_kind(_stats(day=date(2026, 10, 2)), holidays) == "special"
    assert quality.session_kind(_stats(max_bars=0), holidays) == "off_session"


def test_source_is_told_from_the_vendor_symbol():
    assert quality.infer_source("NSE:NIFTY26OCT22700CE") == "fyers"
    assert quality.infer_source("BSE:SENSEX-INDEX") == "fyers"
    assert quality.infer_source("NIFTY_22700_CE_06_OCT_26") == "vendor"
    assert quality.infer_source("nifty_spot") == "vendor"
    assert quality.infer_source(None) == "vendor"


def test_parse_days():
    assert quality.parse_days("2026-09-01..2026-09-30") == (date(2026, 9, 1), date(2026, 9, 30))
    assert quality.parse_days("2026-09-01..")[1] == date.max
    with pytest.raises(ValueError):
        quality.parse_days("2026-09-01")


def test_rebuild_judges_what_is_in_the_files(root):
    make_day(root, "option", "NIFTY", FRIDAY, vendor_symbol="NSE:NIFTY26OCT{i}CE", extra_after=10)
    make_day(root, "option", "NIFTY", SATURDAY)  # Budget Saturday: a full session
    make_day(root, "option", "NIFTY", date(2026, 3, 1), bars=50)  # a drill: 50 bars
    make_day(root, "option", "NIFTY", date(2026, 3, 2), start=(18, 15), bars=60)  # Muhurat
    make_day(root, "option", "NIFTY", date(2026, 3, 3), contracts=4)  # not a chain
    make_day(root, "index", "SENSEX", FRIDAY, contracts=1, vendor_symbol="BSE:SENSEX-INDEX")
    with connect(root):
        pass

    done = quality.rebuild(root, log=lambda _: None)
    assert done["option/NIFTY"] == 5 and done["index/SENSEX"] == 1

    with connect(root, read_only=True) as con:
        rows = {
            r[0]: r[1:]
            for r in con.execute(
                "SELECT trading_day, source, verdict, reason, session_kind, max_bars, "
                "off_session_rows, contracts FROM data_quality WHERE asset = 'option' "
                "ORDER BY trading_day"
            ).fetchall()
        }
    assert rows[FRIDAY] == ("fyers", "usable", None, "regular", 375, 12 * 10, 12)
    assert rows[SATURDAY] == ("vendor", "usable", None, "special", 375, 0, 12)
    assert rows[date(2026, 3, 1)][1:4] == ("excluded", "short_session:50", "special")
    assert rows[date(2026, 3, 2)][1:4] == ("excluded", "off_session_only", "off_session")
    assert rows[date(2026, 3, 3)][1:2] == ("excluded",)
    assert rows[date(2026, 3, 3)][2] == "thin_chain:4"


def test_rebuild_is_repeatable_and_can_be_narrowed(root):
    make_day(root, "option", "NIFTY", FRIDAY)
    make_day(root, "option", "SENSEX", FRIDAY)
    with connect(root):
        pass
    quality.rebuild(root, name="NIFTY", log=lambda _: None)
    quality.rebuild(root, name="NIFTY", log=lambda _: None)
    with connect(root, read_only=True) as con:
        assert con.execute("SELECT name FROM data_quality").fetchall() == [("NIFTY",)]
    quality.rebuild(root, days=(date(2026, 1, 1), date(2026, 1, 2)), log=lambda _: None)
    with connect(root, read_only=True) as con:
        assert con.execute("SELECT count(*) FROM data_quality").fetchone()[0] == 1  # untouched


def test_no_spot_is_set_and_cleared_whichever_arrives_first(root):
    make_day(root, "option", "NIFTY", FRIDAY)
    make_day(root, "option", "NIFTY", date(2026, 9, 28))
    make_day(root, "option", "RELIANCE", FRIDAY)  # no spot series exists for stocks
    make_day(root, "index", "NIFTY", FRIDAY, contracts=1)
    with connect(root):
        pass
    quality.rebuild(root, log=lambda _: None)

    def verdicts():
        with connect(root, read_only=True) as con:
            return dict(
                con.execute(
                    "SELECT name || ' ' || trading_day, verdict || ':' || coalesce(reason, '') "
                    "FROM data_quality WHERE asset = 'option'"
                ).fetchall()
            )

    got = verdicts()
    assert got["NIFTY 2026-09-25"] == "usable:"
    assert got["NIFTY 2026-09-28"] == "excluded:no_spot"  # NIFTY has spot, but not that day
    assert got["RELIANCE 2026-09-25"] == "usable:"  # never has spot: left alone

    make_day(root, "index", "NIFTY", date(2026, 9, 28), contracts=1)  # the spot day arrives
    quality.rebuild(root, asset="index", log=lambda _: None)
    assert verdicts()["NIFTY 2026-09-28"] == "usable:"


def test_a_rebuild_keeps_other_exclusion_reasons_when_spot_is_missing(root):
    make_day(root, "option", "NIFTY", FRIDAY, bars=50)
    make_day(root, "index", "NIFTY", date(2026, 9, 24), contracts=1)
    with connect(root):
        pass
    quality.rebuild(root, log=lambda _: None)
    with connect(root, read_only=True) as con:
        assert con.execute("SELECT reason FROM data_quality WHERE asset = 'option'").fetchall() == [
            ("short_session:50",)
        ]


def test_cli_rebuild_and_status(root, monkeypatch):
    monkeypatch.setenv("TRADING_DATA_ROOT", str(root))
    make_day(root, "option", "NIFTY", FRIDAY)
    make_day(root, "option", "NIFTY", date(2026, 3, 1), bars=50)
    with connect(root):
        pass
    runner = CliRunner()
    assert "no verdicts yet" in runner.invoke(app, ["quality", "status"]).output
    out = runner.invoke(app, ["quality", "rebuild"])
    assert out.exit_code == 0 and "rebuilt 2 day verdicts" in out.output
    status = runner.invoke(app, ["quality", "status"]).output
    assert "option  NIFTY" in status
    assert "usable 1  excluded 1  (short_session 1)" in status
    assert runner.invoke(app, ["quality", "rebuild", "--asset", "stock"]).exit_code != 0
    assert runner.invoke(app, ["quality", "rebuild", "--days", "nope"]).exit_code != 0


def test_a_bar_stamped_inside_the_last_minute_is_in_session(root):
    """Some 2015 vendor spot bars are stamped 15:29:01 or 09:15:30. The regular session is
    [09:15:00, 15:30:00), the same minute grid legwise floors to — not BETWEEN 09:15 AND 15:29,
    which counted a 15:29:30 bar as after hours."""
    make_day(root, "option", "NIFTY", FRIDAY, seconds=30)
    with connect(root):
        pass
    quality.rebuild(root, log=lambda _: None)
    with connect(root, read_only=True) as con:
        assert con.execute(
            "SELECT max_bars, off_session_rows, verdict FROM data_quality"
        ).fetchall() == [(375, 0, "usable")]


def test_rebuild_removes_verdicts_of_partitions_that_no_longer_exist(root):
    make_day(root, "option", "NIFTY", FRIDAY)
    make_day(root, "option", "NIFTY", date(2026, 9, 28))
    make_day(root, "option", "SENSEX", FRIDAY)
    with connect(root):
        pass
    quality.rebuild(root, log=lambda _: None)
    lake.bars_1m_path(root, "option", "NIFTY", date(2026, 9, 28)).unlink()
    done = quality.rebuild(root, log=lambda _: None)
    assert done["rows_pruned"] == 1
    lake.bars_1m_path(root, "option", "SENSEX", FRIDAY).unlink()  # a name with no files left
    done = quality.rebuild(root, log=lambda _: None)
    assert done["rows_pruned"] == 1
    with connect(root, read_only=True) as con:
        assert con.execute("SELECT name, trading_day FROM data_quality").fetchall() == [
            ("NIFTY", FRIDAY)
        ]


def test_a_narrowed_rebuild_only_prunes_inside_its_window(root):
    make_day(root, "option", "NIFTY", FRIDAY)
    make_day(root, "option", "NIFTY", date(2026, 9, 28))
    with connect(root):
        pass
    quality.rebuild(root, log=lambda _: None)
    lake.bars_1m_path(root, "option", "NIFTY", date(2026, 9, 28)).unlink()
    quality.rebuild(root, days=(FRIDAY, FRIDAY), log=lambda _: None)  # window excludes the 28th
    with connect(root, read_only=True) as con:
        assert con.execute("SELECT count(*) FROM data_quality").fetchone()[0] == 2
    quality.rebuild(root, days=(date(2026, 9, 28), date(2026, 9, 28)), log=lambda _: None)
    with connect(root, read_only=True) as con:
        assert con.execute("SELECT count(*) FROM data_quality").fetchone()[0] == 1


# no timestamp columns: fetching a TIMESTAMPTZ makes DuckDB import pytz (not a dependency)
ALL_ROWS_SQL = (
    "SELECT asset, name, trading_day, source, verdict, reason, session_kind, n_rows, "
    "contracts, max_bars FROM data_quality ORDER BY 1, 2, 3"
)


def test_rebuild_with_nothing_to_judge_leaves_the_table_alone(root):
    make_day(root, "option", "NIFTY", FRIDAY)
    make_day(root, "option", "NIFTY", date(2026, 9, 28))
    make_day(root, "index", "NIFTY", FRIDAY, contracts=1)
    with connect(root):
        pass
    quality.rebuild(root, log=lambda _: None)
    with connect(root) as con:
        before = con.execute(ALL_ROWS_SQL).fetchall()
        assert quality.cross_check(con, []) == 0
    done = quality.rebuild(root, name="NOPE", log=lambda _: None)
    assert done["no_spot_changes"] == 0 and done["rows_pruned"] == 0
    with connect(root, read_only=True) as con:
        assert con.execute(ALL_ROWS_SQL).fetchall() == before


def test_an_excluded_spot_day_does_not_count_as_spot_and_futures_need_no_chain(root):
    make_day(root, "option", "NIFTY", FRIDAY)
    make_day(root, "index", "NIFTY", FRIDAY, contracts=1, bars=50)  # spot exists but is unusable
    make_day(root, "future", "NIFTY", FRIDAY, contracts=1)  # one contract is a fine future day
    with connect(root):
        pass
    quality.rebuild(root, log=lambda _: None)
    with connect(root, read_only=True) as con:
        got = dict(
            con.execute(
                "SELECT asset, verdict || ':' || coalesce(reason, '') FROM data_quality"
            ).fetchall()
        )
    assert got["option"] == "excluded:no_spot"
    assert got["index"] == "excluded:short_session:50"
    assert got["future"] == "usable:"


def test_status_on_a_catalog_that_was_never_opened_read_write_since_008(root, monkeypatch):
    monkeypatch.setenv("TRADING_DATA_ROOT", str(root))
    with connect(root) as con:
        con.execute("DROP TABLE data_quality")
        con.execute("DELETE FROM schema_migrations WHERE version = '008_data_quality'")
    result = CliRunner().invoke(app, ["quality", "status"])
    assert result.exit_code == 0 and "no verdicts yet" in result.output
