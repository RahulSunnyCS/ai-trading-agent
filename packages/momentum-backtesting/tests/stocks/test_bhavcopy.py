"""T1 acceptance: bhavcopy download/manifest/parse. No network -- `download()`
is exercised against a `FakeNseClient` that serves bytes from an in-memory map."""

from __future__ import annotations

import csv
from datetime import date, datetime, timedelta
from pathlib import Path

import pandas as pd
import pyarrow.parquet as pq
import pytest

from momentum_backtesting.stocks import bhavcopy, schemas
from momentum_backtesting.stocks.nse import NseError, NseNotFoundError

FIXTURES = Path(__file__).parent / "fixtures" / "bhavcopy"
OLD_2011 = FIXTURES / "cm03JAN2011bhav_trimmed.csv.zip"
OLD_2018 = FIXTURES / "cm01JAN2018bhav_trimmed.csv.zip"
UDIFF_2024 = FIXTURES / "BhavCopy_NSE_CM_0_0_0_20241028_F_0000_trimmed.csv.zip"
OLD_2020_2DIGIT_YEAR = FIXTURES / "cm13JUL2020bhav_trimmed.csv.zip"


class FakeNseClient:
    """Duck-types the two `NseClient` methods `download()` calls. Serves fixed
    bytes (or raises) per URL from an in-memory map -- no network, no real
    `NseClient` instance involved."""

    def __init__(self, by_url: dict[str, bytes | Exception]):
        self.by_url = by_url
        self.warm_up_calls = 0
        self.requested_urls: list[str] = []

    def warm_up(self) -> None:
        self.warm_up_calls += 1

    def get_bytes(self, url: str, *, referer: str | None = None, timeout: float = 60.0) -> bytes:
        self.requested_urls.append(url)
        outcome = self.by_url.get(url, NseNotFoundError(f"no fixture for {url}"))
        if isinstance(outcome, Exception):
            raise outcome
        return outcome


# --------------------------------------------------------------------------
# bhavcopy_url / cutover
# --------------------------------------------------------------------------


def test_bhavcopy_url_old_format_before_cutover():
    url = bhavcopy.bhavcopy_url(date(2024, 7, 5))
    assert url == (
        "https://nsearchives.nseindia.com/content/historical/EQUITIES/2024/JUL/"
        "cm05JUL2024bhav.csv.zip"
    )


def test_bhavcopy_url_udiff_from_cutover():
    url = bhavcopy.bhavcopy_url(date(2024, 7, 8))
    assert url == (
        "https://nsearchives.nseindia.com/content/cm/BhavCopy_NSE_CM_0_0_0_20240708_F_0000.csv.zip"
    )


def test_bhavcopy_url_old_format_2011_no_isin_header_date():
    # Sanity check against the real, verified URL shape (plan.md §1).
    url = bhavcopy.bhavcopy_url(date(2011, 1, 3))
    assert url == (
        "https://nsearchives.nseindia.com/content/historical/EQUITIES/2011/JAN/"
        "cm03JAN2011bhav.csv.zip"
    )


# --------------------------------------------------------------------------
# C01 / C02: parse_file -- header-name mapping, both formats
# --------------------------------------------------------------------------


def test_parse_old_format_2011_no_isin_column():
    df = bhavcopy.parse_file(OLD_2011)
    assert list(df.columns) == [
        "date",
        "symbol",
        "series",
        "isin",
        "open",
        "high",
        "low",
        "close",
        "prevclose",
        "volume",
        "turnover",
    ]
    assert len(df) == 6
    assert df["isin"].isna().all()
    row = df.iloc[0]
    assert row["symbol"] == "20MICRONS"
    assert row["series"] == "EQ"
    assert row["date"] == date(2011, 1, 3)
    assert row["open"] == pytest.approx(45.5)
    assert row["prevclose"] == pytest.approx(45.15)
    assert row["volume"] == 26971


def test_parse_old_format_2018_has_isin_and_ignores_totaltrades():
    df = bhavcopy.parse_file(OLD_2018)
    assert len(df) == 6
    row = df.iloc[0]
    assert row["symbol"] == "20MICRONS"
    assert row["isin"] == "INE144J01027"
    assert row["date"] == date(2018, 1, 1)
    assert "totaltrades" not in [c.lower() for c in df.columns]


def test_parse_old_2011_and_2018_produce_identical_schema():
    df_2011 = bhavcopy.parse_file(OLD_2011)
    df_2018 = bhavcopy.parse_file(OLD_2018)
    assert list(df_2011.columns) == list(df_2018.columns)
    assert df_2011["isin"].isna().all()
    assert df_2018["isin"].notna().all()


def test_parse_old_format_handles_a_real_2_digit_year_timestamp():
    # Regression: the real archive has one file (2020-07-13) with TIMESTAMP
    # "13-Jul-20" instead of "13-JUL-2020" -- caught by actually running
    # build_daily_parquet against the full real cache (see the T1 report).
    df = bhavcopy.parse_file(OLD_2020_2DIGIT_YEAR)
    assert (df["date"] == date(2020, 7, 13)).all()


def test_parse_udiff_format_maps_ticker_close_prevclose():
    df = bhavcopy.parse_file(UDIFF_2024)
    assert len(df) == 10
    akums = df[df["symbol"] == "AKUMS"].iloc[0]
    assert akums["series"] == "EQ"
    assert akums["close"] == pytest.approx(865.90)
    assert akums["prevclose"] == pytest.approx(848.25)
    assert akums["isin"] == "INE09XN01023"
    assert akums["date"] == date(2024, 10, 28)
    assert set(df["series"]) >= {"EQ", "BE"}  # fixture carries both


# --------------------------------------------------------------------------
# C24: untrusted-input caps flow through parse_file too (it re-validates)
# --------------------------------------------------------------------------


def test_parse_file_rejects_non_pk_body(tmp_path):
    bogus = tmp_path / "not_a_zip.csv.zip"
    bogus.write_bytes(b"SYMBOL,SERIES\nnope")
    with pytest.raises(NseError):
        bhavcopy.parse_file(bogus)


# --------------------------------------------------------------------------
# F09 (T1 half): series preference -- EQ kept over BE on the same (date, symbol)
# --------------------------------------------------------------------------


def test_prefer_eq_keeps_eq_over_be_same_day_drops_other_series():
    df = pd.DataFrame(
        {
            "date": [date(2024, 1, 2), date(2024, 1, 2), date(2024, 1, 2)],
            "symbol": ["ACME", "ACME", "OTHERCO"],
            "series": ["BE", "EQ", "N5"],
            "isin": ["I1", "I1", "I2"],
            "open": [1.0, 1.0, 1.0],
            "high": [1.0, 1.0, 1.0],
            "low": [1.0, 1.0, 1.0],
            "close": [1.0, 1.1, 1.0],
            "prevclose": [1.0, 1.0, 1.0],
            "volume": [10, 20, 30],
            "turnover": [1.0, 2.0, 3.0],
        }
    )
    out = bhavcopy._prefer_eq(df)
    assert len(out) == 1  # OTHERCO's N5 row dropped, ACME deduped to one row
    assert out.iloc[0]["symbol"] == "ACME"
    assert out.iloc[0]["series"] == "EQ"
    assert out.iloc[0]["close"] == pytest.approx(1.1)


def test_prefer_eq_series_switch_keeps_both_days_continuity():
    df = pd.DataFrame(
        {
            "date": [date(2024, 1, 2), date(2024, 1, 3)],
            "symbol": ["ACME", "ACME"],
            "series": ["EQ", "BE"],
            "isin": ["I1", "I1"],
            "open": [1.0, 1.0],
            "high": [1.0, 1.0],
            "low": [1.0, 1.0],
            "close": [1.0, 1.2],
            "prevclose": [1.0, 1.0],
            "volume": [10, 20],
            "turnover": [1.0, 2.0],
        }
    )
    out = bhavcopy._prefer_eq(df)
    assert len(out) == 2
    assert list(out["series"]) == ["EQ", "BE"]


# --------------------------------------------------------------------------
# C03 / F01 / F02 / F03: download() -- weekend sessions, resume, freshness, atomicity
# --------------------------------------------------------------------------


def _udiff_body(session: date) -> bytes:
    return UDIFF_2024.read_bytes()  # any valid zip works; url encodes the date


def test_download_fetches_weekend_session_in_calendar(tmp_path):
    raw_dir = tmp_path / "raw" / "bhavcopy"
    saturday = date(2020, 2, 1)  # a real weekend trading session (plan.md verified facts)
    url = bhavcopy.bhavcopy_url(saturday)
    body = _udiff_body(saturday) if saturday >= bhavcopy.UDIFF_CUTOVER else OLD_2011.read_bytes()
    client = FakeNseClient({url: body})

    manifest_df = bhavcopy.download([saturday], raw_dir, client)

    assert url in client.requested_urls
    assert (manifest_df["session"] == saturday).any()
    row = manifest_df[manifest_df["session"] == saturday].iloc[0]
    assert row["error"] is None
    filename = url.rsplit("/", 1)[-1]
    assert (raw_dir / filename).exists()


def test_download_resumes_without_refetching_ok_dates(tmp_path):
    raw_dir = tmp_path / "raw" / "bhavcopy"
    session = date(2011, 1, 3)
    url = bhavcopy.bhavcopy_url(session)
    client = FakeNseClient({url: OLD_2011.read_bytes()})

    bhavcopy.download([session], raw_dir, client)
    assert client.requested_urls == [url]

    client2 = FakeNseClient({url: OLD_2011.read_bytes()})
    df2 = bhavcopy.download([session], raw_dir, client2)

    assert client2.requested_urls == []  # no network at all on resume
    assert client2.warm_up_calls == 0
    row = df2[df2["session"] == session].iloc[0]
    assert row["error"] is None
    assert row["rows"] == 6


def test_download_retries_error_dates_on_resume(tmp_path):
    raw_dir = tmp_path / "raw" / "bhavcopy"
    session = date(2015, 3, 2)  # far enough in the past to be outside the freshness window
    old_url, udiff_url = bhavcopy._old_url(session), bhavcopy._udiff_url(session)

    client = FakeNseClient(
        {old_url: NseError("simulated 403 storm"), udiff_url: NseError("simulated 403 storm")}
    )
    df1 = bhavcopy.download([session], raw_dir, client)
    assert df1.iloc[0]["error"] is not None

    manifest_path = raw_dir.parent / "bhavcopy_manifest.csv"
    with manifest_path.open() as f:
        rows = {r["date"]: r for r in csv.DictReader(f)}
    assert rows[session.isoformat()]["status"] == "error"

    client2 = FakeNseClient({old_url: OLD_2011.read_bytes()})
    df2 = bhavcopy.download([session], raw_dir, client2)
    assert old_url in client2.requested_urls  # retried, not skipped
    assert df2.iloc[0]["error"] is None


def test_download_does_not_persist_missing_within_freshness_window(tmp_path):
    raw_dir = tmp_path / "raw" / "bhavcopy"
    today_ist = datetime.now(bhavcopy.IST).date()
    session = today_ist - timedelta(days=1)  # within the 5-day window
    if session.weekday() >= 5:
        session = today_ist  # keep it simple; freshness logic doesn't care about weekends
    old_url, udiff_url = bhavcopy._old_url(session), bhavcopy._udiff_url(session)

    client = FakeNseClient({})  # both URLs 404 (no fixture registered)
    bhavcopy.download([session], raw_dir, client)

    manifest_path = raw_dir.parent / "bhavcopy_manifest.csv"
    with manifest_path.open() as f:
        rows = {r["date"]: r for r in csv.DictReader(f)}
    assert session.isoformat() not in rows  # not persisted

    # A second run retries it (not trusted as a stable 'missing' yet).
    client2 = FakeNseClient({})
    bhavcopy.download([session], raw_dir, client2)
    assert old_url in client2.requested_urls or udiff_url in client2.requested_urls


def test_download_persists_missing_outside_freshness_window(tmp_path):
    raw_dir = tmp_path / "raw" / "bhavcopy"
    session = date(2015, 1, 25)  # a real Sunday, long past, never a trading day
    client = FakeNseClient({})  # both formats 404

    df = bhavcopy.download([session], raw_dir, client)
    assert df.iloc[0]["error"] is None
    assert df.iloc[0]["path"] == ""

    manifest_path = raw_dir.parent / "bhavcopy_manifest.csv"
    with manifest_path.open() as f:
        rows = {r["date"]: r for r in csv.DictReader(f)}
    assert rows[session.isoformat()]["status"] == "missing"

    # Resumed: missing dates outside the freshness window are trusted, no re-request.
    client2 = FakeNseClient({})
    bhavcopy.download([session], raw_dir, client2)
    assert client2.requested_urls == []


def test_download_writes_zip_atomically_no_partial_file_survives_a_crash(tmp_path, monkeypatch):
    raw_dir = tmp_path / "raw" / "bhavcopy"
    session = date(2011, 1, 3)
    url = bhavcopy.bhavcopy_url(session)
    client = FakeNseClient({url: OLD_2011.read_bytes()})

    from momentum_backtesting.stocks import nse as nse_module

    def crash_before_rename(_src, _dst):
        raise OSError("simulated kill mid-write")

    monkeypatch.setattr(nse_module.os, "replace", crash_before_rename)

    with pytest.raises(OSError):
        bhavcopy.download([session], raw_dir, client)

    filename = url.rsplit("/", 1)[-1]
    assert not (raw_dir / filename).exists()
    # No stray tmp file left counted as present either.
    assert list((raw_dir).glob("*")) == [] if raw_dir.exists() else True


# --------------------------------------------------------------------------
# build_daily_parquet: whole-cache parse -> daily.parquet
# --------------------------------------------------------------------------


def _seed_manifest_and_cache(
    raw_dir: Path, sessions_and_fixtures: list[tuple[date, Path, str]]
) -> None:
    raw_dir.mkdir(parents=True, exist_ok=True)
    manifest_path = raw_dir.parent / "bhavcopy_manifest.csv"
    with manifest_path.open("w", newline="") as f:
        writer = csv.writer(f)
        writer.writerow(["date", "status", "format", "file", "bytes"])
        for session, fixture, fmt in sessions_and_fixtures:
            filename = fixture.name
            dest = raw_dir / filename
            dest.write_bytes(fixture.read_bytes())
            writer.writerow([session.isoformat(), "ok", fmt, filename, dest.stat().st_size])


def test_build_daily_parquet_combines_cache_and_reports_stats(tmp_path):
    raw_dir = tmp_path / "raw" / "bhavcopy"
    _seed_manifest_and_cache(
        raw_dir,
        [
            (date(2011, 1, 3), OLD_2011, bhavcopy.FORMAT_OLD),
            (date(2018, 1, 1), OLD_2018, bhavcopy.FORMAT_OLD),
            (date(2024, 10, 28), UDIFF_2024, bhavcopy.FORMAT_UDIFF),
        ],
    )
    out_path = tmp_path / "daily.parquet"

    stats = bhavcopy.build_daily_parquet(raw_dir, out_path)

    assert out_path.exists()
    assert stats.date_min == date(2011, 1, 3)
    assert stats.date_max == date(2024, 10, 28)
    assert stats.elapsed_seconds >= 0

    table = pq.read_table(out_path)
    assert table.schema.equals(schemas.DAILY_SCHEMA)
    df = table.to_pandas()
    assert stats.rows == len(df)
    assert (~df["synthetic_close"]).all()
    # Series filter applied: only EQ/BE/BZ survive.
    assert set(df["series"]) <= {"EQ", "BE", "BZ"}
    assert stats.n_symbols == df["symbol"].nunique()


def test_build_daily_parquet_skips_non_ok_manifest_rows(tmp_path):
    raw_dir = tmp_path / "raw" / "bhavcopy"
    raw_dir.mkdir(parents=True, exist_ok=True)
    manifest_path = raw_dir.parent / "bhavcopy_manifest.csv"
    with manifest_path.open("w", newline="") as f:
        writer = csv.writer(f)
        writer.writerow(["date", "status", "format", "file", "bytes"])
        writer.writerow(["2011-01-04", "missing", "", "", "0"])
        writer.writerow(["2011-01-05", "error", "", "", "0"])

    out_path = tmp_path / "daily.parquet"
    stats = bhavcopy.build_daily_parquet(raw_dir, out_path)

    assert stats.rows == 0
    assert stats.date_min is None
    table = pq.read_table(out_path)
    assert table.schema.equals(schemas.DAILY_SCHEMA)
