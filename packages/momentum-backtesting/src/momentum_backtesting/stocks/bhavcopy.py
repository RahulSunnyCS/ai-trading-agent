"""Download and parse NSE EOD bhavcopy files.

Two on-the-wire formats exist (plan.md §1, verified facts):
  - old CM format: nsearchives.nseindia.com/content/historical/EQUITIES/{Y}/{MON}/
    cm{DD}{MON}{Y}bhav.csv.zip — used up to the Jul-2024 cutover;
  - UDiFF format: .../content/cm/BhavCopy_NSE_CM_0_0_0_{YYYYMMDD}_F_0000.csv.zip —
    used from the cutover onward.

PREVCLOSE is never adjusted for corporate actions in either format (plan.md §1) —
adjust.py, not this module, is where corporate-action factors get applied.
"""

from __future__ import annotations

import csv
import hashlib
import io
import time
from dataclasses import dataclass
from datetime import UTC, date, datetime
from pathlib import Path
from zoneinfo import ZoneInfo

import pandas as pd
import pyarrow as pa
import pyarrow.parquet as pq

from momentum_backtesting.stocks import schemas
from momentum_backtesting.stocks.nse import (
    NseClient,
    NseError,
    NseNotFoundError,
    atomic_write_bytes,
    extract_single_member,
)

#: The exact old-format/UDiFF cutover date, pinned by T1 against a live probe
#: (plan.md §1 says "stops after the Jul-2024 switch" but doesn't fix the day).
#: Verified: the last old-format file is 2024-07-05; UDiFF is used from
#: 2024-07-08 (the next session) onward.
UDIFF_CUTOVER = date(2024, 7, 8)

BASE_URL = "https://nsearchives.nseindia.com"
#: Referer NSE's site itself uses when linking to these files; sent on every
#: bhavcopy request (harmless if NSE doesn't check it, and it's what a real
#: browser session would send).
_REFERER = "https://www.nseindia.com/all-reports"

#: `bhavcopy_manifest.csv`'s `format` column values — kept identical to the
#: throwaway prototype script that produced the on-disk manifest this module
#: must stay compatible with (see the T1 task notes).
FORMAT_OLD = "old_url"
FORMAT_UDIFF = "udiff_url"

#: Resumable download-cache manifest columns (data/stocks/raw/bhavcopy_manifest.csv).
#: NOT the same file as the T0-plan's run-wide `raw_manifest.csv` that `download`
#: returns a DataFrame for below — this one is bhavcopy.py's own resume cache.
_MANIFEST_COLUMNS = ("date", "status", "format", "file", "bytes")

#: A fixed English month-abbreviation table. Never use `%b`/`strftime("%b")` to
#: parse or build these URLs/dates — both are locale-dependent (plan.md
#: "Freshness": "Dates are parsed with a fixed English month map, never %b").
_MONTH_ABBR = (
    "JAN",
    "FEB",
    "MAR",
    "APR",
    "MAY",
    "JUN",
    "JUL",
    "AUG",
    "SEP",
    "OCT",
    "NOV",
    "DEC",
)
_MONTH_NUM = {abbr: i + 1 for i, abbr in enumerate(_MONTH_ABBR)}

#: Series kept in daily.parquet, in preference order when a (date, symbol) has
#: more than one on the same day (plan.md §6, QA F09: EQ wins).
_SERIES_RANK = {"EQ": 0, "BE": 1, "BZ": 2}

IST = ZoneInfo("Asia/Kolkata")

#: A 404 is only trusted as a permanent "no file for this date" once the date
#: is this many days old (Asia/Kolkata) — NSE sometimes publishes a session's
#: bhavcopy a little late, and a same-day/near-term 404 should be retried on
#: the next run rather than permanently recorded as `missing` (plan.md
#: "Freshness").
_FRESHNESS_WINDOW_DAYS = 5


def _old_url(session: date) -> str:
    mon = _MONTH_ABBR[session.month - 1]
    return (
        f"{BASE_URL}/content/historical/EQUITIES/{session.year:04d}/{mon}/"
        f"cm{session.day:02d}{mon}{session.year:04d}bhav.csv.zip"
    )


def _udiff_url(session: date) -> str:
    return f"{BASE_URL}/content/cm/BhavCopy_NSE_CM_0_0_0_{session:%Y%m%d}_F_0000.csv.zip"


def bhavcopy_url(session: date) -> str:
    """Return the bhavcopy zip URL for one session: the old CM format if `session`
    is before UDIFF_CUTOVER, the UDiFF format otherwise.
    """
    return _udiff_url(session) if session >= UDIFF_CUTOVER else _old_url(session)


def _url_order(session: date) -> list[tuple[str, str]]:
    """(format_label, url) pairs in try-first order: `session`'s expected format
    first, the other format as a fallback (plan.md/T1 acceptance criteria).
    """
    old = (FORMAT_OLD, _old_url(session))
    udiff = (FORMAT_UDIFF, _udiff_url(session))
    return [udiff, old] if session >= UDIFF_CUTOVER else [old, udiff]


def _parse_ddmonyyyy(value: str) -> date:
    """Parse NSE's old-format TIMESTAMP field (usually `DD-MON-YYYY`) via the
    fixed month table above — never `strptime`'s locale-sensitive `%b`.

    One real archived file (2020-07-13) publishes a 2-digit year
    ("13-Jul-20" instead of "13-JUL-2020"); every bhavcopy in this archive is
    from 2000 onward, so a 2-digit year is unambiguously 2000 + yy rather than
    something needing a rollover-pivot guess.
    """
    dd, mon, yyyy = value.strip().split("-")
    year = int(yyyy) + 2000 if len(yyyy) == 2 else int(yyyy)
    return date(year, _MONTH_NUM[mon.upper()], int(dd))


def _within_freshness_window(session: date) -> bool:
    today_ist = datetime.now(IST).date()
    return 0 <= (today_ist - session).days <= _FRESHNESS_WINDOW_DAYS


# --------------------------------------------------------------------------
# bhavcopy_manifest.csv (the resumable download cache)
# --------------------------------------------------------------------------


def _load_manifest_rows(manifest_path: Path) -> dict[str, dict[str, str]]:
    if not manifest_path.exists():
        return {}
    with manifest_path.open(newline="") as f:
        return {row["date"]: row for row in csv.DictReader(f)}


def _write_manifest_rows(manifest_path: Path, rows: dict[str, dict[str, str]]) -> None:
    buf = io.StringIO()
    writer = csv.DictWriter(buf, fieldnames=list(_MANIFEST_COLUMNS))
    writer.writeheader()
    for d in sorted(rows):
        row = rows[d]
        writer.writerow({col: row.get(col, "") for col in _MANIFEST_COLUMNS})
    atomic_write_bytes(manifest_path, buf.getvalue().encode("utf-8"))


def _sha256_of(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _row_count(path: Path) -> int:
    """Best-effort data-row count for the run-wide manifest DataFrame. Never
    raises: a file that fails to parse here is still a successful *download*
    (it was fetched, safety-checked, and written) — genuine parse failures
    surface loudly from `parse_file`/`build_daily_parquet` instead.
    """
    try:
        return len(parse_file(path))
    except Exception:
        return 0


def _record_from_cache(session: date, cached: dict[str, str], raw_dir: Path) -> dict | None:
    """Build a `download()` return-row from an existing manifest entry without
    any network access. Returns None if the cache can't be trusted as-is (file
    missing or fails the zip safety check) so the caller re-fetches instead.
    """
    if cached.get("status") == "missing":
        return {
            "session": session,
            "path": "",
            "sha256": "",
            "fetched_at": "",
            "rows": 0,
            "error": "missing",
        }
    filename = cached.get("file") or ""
    path = raw_dir / filename
    if not filename or not path.exists():
        return None
    try:
        extract_single_member(path.read_bytes())
    except NseError:
        return None
    return {
        "session": session,
        "path": str(path),
        "sha256": _sha256_of(path),
        "fetched_at": datetime.fromtimestamp(path.stat().st_mtime, tz=UTC).isoformat(),
        "rows": _row_count(path),
        "error": None,
    }


def _fetch_one(
    session: date, raw_dir: Path, client: NseClient
) -> tuple[str, str, str, int, str | None]:
    """Try each format for `session` in order; returns
    (status, format_label, filename, size_bytes, error)."""
    last_error: str | None = None
    for fmt_label, url in _url_order(session):
        try:
            body = client.get_bytes(url, referer=_REFERER)
        except NseNotFoundError:
            last_error = "404"
            continue
        except NseError as e:
            # A non-404 failure (e.g. retries exhausted on repeated 403s) means
            # something is wrong with the connection/session, not the format —
            # trying the other format's URL wouldn't help, so stop here.
            return "error", "", "", 0, str(e)
        try:
            extract_single_member(body)  # validate before writing anything to disk
        except NseError as e:
            return "error", "", "", 0, f"invalid zip from {url}: {e}"
        filename = url.rsplit("/", 1)[-1]
        atomic_write_bytes(raw_dir / filename, body)
        return "ok", fmt_label, filename, len(body), None
    if last_error == "404":
        return "missing", "", "", 0, None
    return "error", "", "", 0, last_error


def download(sessions: list[date], raw_dir: Path, client: NseClient) -> pd.DataFrame:
    """Download each session's bhavcopy zip into `raw_dir` (skip a session whose zip
    is already present and content-hash-matches the pinned manifest, if one exists).

    Returns a manifest DataFrame with columns (session, path, sha256, fetched_at,
    rows) — one row per session attempted, including failures (rows=0, an error
    column set). The caller (T6) folds this into data/stocks/raw_manifest.csv.
    """
    raw_dir.mkdir(parents=True, exist_ok=True)
    manifest_path = raw_dir.parent / "bhavcopy_manifest.csv"
    manifest_rows = _load_manifest_rows(manifest_path)

    warmed_up = False
    records: list[dict] = []

    for session in sorted(set(sessions)):
        key = session.isoformat()
        cached = manifest_rows.get(key)
        if cached is not None and cached.get("status") in ("ok", "missing"):
            record = _record_from_cache(session, cached, raw_dir)
            if record is not None:
                records.append(record)
                continue
            # Manifest says 'ok' but the file is gone/corrupted on disk: fall
            # through and re-fetch it below, same as an unrecorded date.

        if not warmed_up:
            client.warm_up()
            warmed_up = True

        status, fmt_label, filename, size, error = _fetch_one(session, raw_dir, client)
        fetched_at = datetime.now(UTC).isoformat()

        if status == "missing" and _within_freshness_window(session):
            # Not trusted as a permanent "no file" yet — don't persist it, so
            # the next run retries instead of trusting a possibly-early 404
            # (plan.md "Freshness").
            pass
        else:
            manifest_rows[key] = {
                "date": key,
                "status": status,
                "format": fmt_label,
                "file": filename,
                "bytes": str(size),
            }

        path = raw_dir / filename if filename else None
        records.append(
            {
                "session": session,
                "path": str(path) if path else "",
                "sha256": _sha256_of(path) if status == "ok" and path else "",
                "fetched_at": fetched_at,
                "rows": _row_count(path) if status == "ok" and path else 0,
                "error": error,
            }
        )

    _write_manifest_rows(manifest_path, manifest_rows)
    return pd.DataFrame.from_records(
        records, columns=["session", "path", "sha256", "fetched_at", "rows", "error"]
    )


# --------------------------------------------------------------------------
# Parsing
# --------------------------------------------------------------------------


def _parse_old_format(text: str) -> pd.DataFrame:
    df = pd.read_csv(io.StringIO(text), skipinitialspace=True, dtype=str)
    df.columns = [c.strip() for c in df.columns]
    df = df[df["SYMBOL"].notna() & (df["SYMBOL"].astype(str).str.strip() != "")]
    has_isin = "ISIN" in df.columns
    isin = df["ISIN"].str.strip() if has_isin else pd.Series([None] * len(df), index=df.index)
    return pd.DataFrame(
        {
            "date": df["TIMESTAMP"].map(_parse_ddmonyyyy),
            "symbol": df["SYMBOL"].str.strip(),
            "series": df["SERIES"].str.strip(),
            "isin": isin,
            "open": pd.to_numeric(df["OPEN"], errors="coerce"),
            "high": pd.to_numeric(df["HIGH"], errors="coerce"),
            "low": pd.to_numeric(df["LOW"], errors="coerce"),
            "close": pd.to_numeric(df["CLOSE"], errors="coerce"),
            "prevclose": pd.to_numeric(df["PREVCLOSE"], errors="coerce"),
            "volume": pd.to_numeric(df["TOTTRDQTY"], errors="coerce").fillna(0).astype("int64"),
            "turnover": pd.to_numeric(df["TOTTRDVAL"], errors="coerce"),
        }
    ).reset_index(drop=True)


def _parse_udiff_format(text: str) -> pd.DataFrame:
    df = pd.read_csv(io.StringIO(text), skipinitialspace=True, dtype=str)
    df.columns = [c.strip() for c in df.columns]
    df = df[df["TckrSymb"].notna() & (df["TckrSymb"].astype(str).str.strip() != "")]
    return pd.DataFrame(
        {
            "date": df["TradDt"].str.strip().map(date.fromisoformat),
            "symbol": df["TckrSymb"].str.strip(),
            "series": df["SctySrs"].str.strip(),
            "isin": df["ISIN"].str.strip(),
            "open": pd.to_numeric(df["OpnPric"], errors="coerce"),
            "high": pd.to_numeric(df["HghPric"], errors="coerce"),
            "low": pd.to_numeric(df["LwPric"], errors="coerce"),
            "close": pd.to_numeric(df["ClsPric"], errors="coerce"),
            "prevclose": pd.to_numeric(df["PrvsClsgPric"], errors="coerce"),
            "volume": pd.to_numeric(df["TtlTradgVol"], errors="coerce").fillna(0).astype("int64"),
            "turnover": pd.to_numeric(df["TtlTrfVal"], errors="coerce"),
        }
    ).reset_index(drop=True)


def parse_file(path: Path) -> pd.DataFrame:
    """Parse one on-disk bhavcopy CSV (old or UDiFF format, auto-detected from the
    header row) into a DataFrame matching schemas.DAILY_SCHEMA minus the
    `synthetic_close` column (that flag is only meaningful once adjust.py has seen
    the full session calendar, so it is added downstream, not here).

    Handles the 2011-era header that has no ISIN column (isin comes back as None
    for those rows).
    """
    zip_bytes = path.read_bytes()
    csv_bytes = extract_single_member(zip_bytes)
    text = csv_bytes.decode("utf-8", errors="replace")
    header = text.splitlines()[0] if text else ""
    if header.startswith("SYMBOL,SERIES"):
        return _parse_old_format(text)
    if header.startswith("TradDt,"):
        return _parse_udiff_format(text)
    raise ValueError(f"unrecognised bhavcopy header in {path.name}: {header[:80]!r}")


def _prefer_eq(df: pd.DataFrame) -> pd.DataFrame:
    """Keep only EQ/BE/BZ rows; when a (date, symbol) pair has more than one of
    those series on the same day, keep EQ (plan.md §6, QA F09)."""
    if df.empty:
        return df
    filtered = df[df["series"].isin(_SERIES_RANK)].copy()
    filtered["_rank"] = filtered["series"].map(_SERIES_RANK)
    filtered = filtered.sort_values(["date", "symbol", "_rank"], kind="stable")
    filtered = filtered.drop_duplicates(subset=["date", "symbol"], keep="first")
    return filtered.drop(columns="_rank").reset_index(drop=True)


@dataclass
class DailyBuildStats:
    """Summary returned by `build_daily_parquet`. Not part of the frozen T0
    schema — just a convenience for the caller's report/log."""

    rows: int
    date_min: date | None
    date_max: date | None
    n_symbols: int
    elapsed_seconds: float


def build_daily_parquet(
    raw_dir: Path,
    out_path: Path,
    *,
    manifest_path: Path | None = None,
) -> DailyBuildStats:
    """Parse every session recorded as `status=ok` in the bhavcopy manifest
    (produced by `download`) and write the combined result to `out_path` as
    `schemas.DAILY_SCHEMA` parquet.

    Only EQ/BE/BZ rows are kept; when a (date, symbol) pair has more than one
    of those series on the same day, EQ wins (plan.md §6, QA F09).
    `synthetic_close` is set False for every row here: filling it in correctly
    for a genuine single-session archive gap needs the full TRI session
    calendar, which is adjust.py/T6's job — T6 rewrites this file once it has
    that. Written atomically (tmp file + rename).
    """
    start = time.monotonic()
    if manifest_path is None:
        manifest_path = raw_dir.parent / "bhavcopy_manifest.csv"
    manifest_rows = _load_manifest_rows(manifest_path)

    frames: list[pd.DataFrame] = []
    for row in manifest_rows.values():
        if row.get("status") != "ok" or not row.get("file"):
            continue
        path = raw_dir / row["file"]
        if not path.exists():
            continue
        frames.append(parse_file(path))

    columns = [f.name for f in schemas.DAILY_SCHEMA if f.name != "synthetic_close"]
    combined = pd.concat(frames, ignore_index=True) if frames else pd.DataFrame(columns=columns)
    combined = _prefer_eq(combined)
    combined["synthetic_close"] = False
    combined = combined[[f.name for f in schemas.DAILY_SCHEMA]].reset_index(drop=True)

    required = ["open", "high", "low", "close", "prevclose", "volume", "turnover"]
    if len(combined):
        bad = combined[required].isna().any(axis=1)
        if bad.any():
            first = combined.loc[bad, ["date", "symbol", "series"]].iloc[0].to_dict()
            raise ValueError(
                f"{int(bad.sum())} row(s) have unparsable OHLC/volume/turnover "
                f"values; first bad row: {first}"
            )

    table = pa.Table.from_pandas(combined, schema=schemas.DAILY_SCHEMA, preserve_index=False)
    sink = pa.BufferOutputStream()
    pq.write_table(table, sink)
    atomic_write_bytes(out_path, sink.getvalue().to_pybytes())

    dates = combined["date"]
    return DailyBuildStats(
        rows=len(combined),
        date_min=min(dates) if len(dates) else None,
        date_max=max(dates) if len(dates) else None,
        n_symbols=int(combined["symbol"].nunique()) if len(combined) else 0,
        elapsed_seconds=time.monotonic() - start,
    )
