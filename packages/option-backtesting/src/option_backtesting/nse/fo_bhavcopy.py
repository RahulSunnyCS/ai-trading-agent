"""NSE's daily F&O bhavcopy and F&O ban list: fetched from NSE's public archive, the raw
file kept, and each day stored as one normalised Parquet file (BL-226 Phase 1; BL-107 will run
the same reader daily).

Two formats. Up to 2024-07-05 the old file (`fo<DD><MON><YYYY>bhav.csv.zip`: INSTRUMENT,
SYMBOL, ..., value in lakh, no lot size); from 2024-07-08 the UDiFF file
(`BhavCopy_NSE_FO_0_0_0_<YYYYMMDD>_F_0000.csv.zip`: value in rupees, lot size per contract).
Checked on 2024-07-05, which NSE publishes in both: contracts, OI (in shares), close and settle
agree row for row; old `CONTRACTS` = UDiFF `TtlTradgVol`; an option's value is its notional
((strike + premium) x quantity), not premium turnover.

Layout under TRADING_DATA_ROOT:
- `raw/nse/fo-bhavcopy/<YYYY>/<file>.csv.zip` and `raw/nse/fo-bhavcopy/manifest.csv` (one row
  per day tried: ok / missing / error), so a rerun asks only for days not settled;
- `raw/nse/fo-secban/<YYYY>/fo_secban_<DDMMYYYY>.csv` (the day's ban list; a day with no ban
  still has a file);
- `lake/eod/fo_bhavcopy/date=<D>/data.parquet` in FO_SCHEMA.

A 404 for a day older than FRESH_DAYS is a day with no session (holiday, weekend) and is
recorded as missing; a newer 404 is retried on the next run. Requests are paced (one a second)
with a browser User-Agent and NSE's Referer, as the cash-market reader does
(`momentum_backtesting.stocks.bhavcopy`).
"""

from __future__ import annotations

import csv
import io
import time
import urllib.error
import urllib.request
import zipfile
from collections.abc import Callable, Iterable
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta
from pathlib import Path

import pyarrow as pa
import pyarrow.parquet as pq

BASE_URL = "https://nsearchives.nseindia.com"
REFERER = "https://www.nseindia.com/all-reports"
USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0 Safari/537.36"
)
#: the first session NSE publishes the F&O bhavcopy only in UDiFF (same switch as the cash market)
UDIFF_CUTOVER = date(2024, 7, 8)
FRESH_DAYS = 5
_MONTHS = ("JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC")
_MONTH_NUM = {m: i + 1 for i, m in enumerate(_MONTHS)}
_MANIFEST_COLUMNS = ("date", "status", "format", "file", "bytes", "ban")

#: the instrument codes of the old file; UDiFF's FinInstrmTp mapped onto them
_UDIFF_INSTRUMENT = {"STO": "OPTSTK", "IDO": "OPTIDX", "STF": "FUTSTK", "IDF": "FUTIDX"}

FO_SCHEMA = pa.schema(
    [
        ("date", pa.date32()),
        ("instrument", pa.string()),  # FUTSTK / OPTSTK / FUTIDX / OPTIDX (others kept as given)
        ("symbol", pa.string()),
        ("expiry", pa.date32()),
        ("strike", pa.float64()),  # null for a future
        ("option_type", pa.string()),  # CE / PE, null for a future
        ("open", pa.float64()),
        ("high", pa.float64()),
        ("low", pa.float64()),
        ("close", pa.float64()),
        ("settle", pa.float64()),
        ("contracts", pa.int64()),
        ("value_rs", pa.float64()),  # notional traded value, rupees
        ("oi", pa.int64()),  # open interest, shares
        ("chg_oi", pa.int64()),
        ("underlying_price", pa.float64()),  # UDiFF only
        ("lot_size", pa.int64()),  # UDiFF only; derived for the old format in fno_universe
        ("source_format", pa.string()),  # "old" / "udiff"
    ]
)


class NseNotFound(Exception):
    pass


class NseFetchError(Exception):
    pass


# ---------------------------------------------------------------------------
# URLs and paths
# ---------------------------------------------------------------------------


def old_url(day: date) -> str:
    mon = _MONTHS[day.month - 1]
    return (
        f"{BASE_URL}/content/historical/DERIVATIVES/{day.year:04d}/{mon}/"
        f"fo{day.day:02d}{mon}{day.year:04d}bhav.csv.zip"
    )


def udiff_url(day: date) -> str:
    return f"{BASE_URL}/content/fo/BhavCopy_NSE_FO_0_0_0_{day:%Y%m%d}_F_0000.csv.zip"


def ban_url(day: date) -> str:
    return f"{BASE_URL}/archives/fo/sec_ban/fo_secban_{day:%d%m%Y}.csv"


def url_order(day: date) -> list[tuple[str, str]]:
    """(format, url) in the order to try: the day's expected format first, the other next."""
    old, udiff = ("old", old_url(day)), ("udiff", udiff_url(day))
    return [udiff, old] if day >= UDIFF_CUTOVER else [old, udiff]


def raw_dir(root: Path) -> Path:
    return root / "raw" / "nse" / "fo-bhavcopy"


def ban_path(root: Path, day: date) -> Path:
    return root / "raw" / "nse" / "fo-secban" / f"{day.year:04d}" / f"fo_secban_{day:%d%m%Y}.csv"


def lake_path(root: Path, day: date) -> Path:
    return root / "lake" / "eod" / "fo_bhavcopy" / f"date={day}" / "data.parquet"


def lake_days(root: Path) -> list[date]:
    folder = root / "lake" / "eod" / "fo_bhavcopy"
    if not folder.exists():
        return []
    return sorted(
        date.fromisoformat(p.name[5:])
        for p in folder.glob("date=*")
        if (p / "data.parquet").exists()
    )


# ---------------------------------------------------------------------------
# HTTP
# ---------------------------------------------------------------------------


@dataclass
class Http:
    """A paced GET with bounded retries. `opener` is the test seam (no network in tests)."""

    min_interval_s: float = 1.0
    retries: int = 3
    timeout_s: float = 30.0
    opener: Callable[[urllib.request.Request, float], bytes] | None = None
    calls: int = 0
    _last: float | None = field(default=None, repr=False)

    def _pace(self) -> None:
        if self._last is not None:
            wait = self.min_interval_s - (time.monotonic() - self._last)
            if wait > 0:
                time.sleep(wait)
        self._last = time.monotonic()

    def _open(self, req: urllib.request.Request) -> bytes:
        if self.opener is not None:
            return self.opener(req, self.timeout_s)
        with urllib.request.urlopen(req, timeout=self.timeout_s) as resp:  # noqa: S310 (fixed https host)
            return resp.read()

    def get(self, url: str) -> bytes:
        headers = {"User-Agent": USER_AGENT, "Referer": REFERER, "Accept": "*/*"}
        last: Exception | None = None
        for attempt in range(self.retries + 1):
            self._pace()
            self.calls += 1
            try:
                return self._open(urllib.request.Request(url, headers=headers))
            except urllib.error.HTTPError as e:
                if e.code == 404:
                    raise NseNotFound(url) from e
                last = e
            except (urllib.error.URLError, TimeoutError, ConnectionError) as e:
                last = e
            if attempt < self.retries:
                time.sleep(2 * (attempt + 1))
        raise NseFetchError(f"{url}: {last}")


# ---------------------------------------------------------------------------
# Parsing (pure)
# ---------------------------------------------------------------------------


def _single_member(body: bytes) -> str:
    with zipfile.ZipFile(io.BytesIO(body)) as z:
        names = [n for n in z.namelist() if not n.endswith("/")]
        if len(names) != 1:
            raise NseFetchError(f"expected one file in the zip, got {names}")
        return z.read(names[0]).decode("utf-8-sig")


def _f(v: str) -> float | None:
    v = (v or "").strip()
    return float(v) if v not in ("", "-") else None


def _i(v: str) -> int | None:
    x = _f(v)
    return None if x is None else int(round(x))


def _ddmonyyyy(v: str) -> date:
    d, mon, y = v.strip().split("-")
    return date(int(y), _MONTH_NUM[mon.upper()], int(d))


def parse_old(text: str, day: date) -> pa.Table:
    rows: dict[str, list] = {f.name: [] for f in FO_SCHEMA}
    for r in csv.DictReader(io.StringIO(text)):
        if not r.get("INSTRUMENT"):
            continue
        inst = r["INSTRUMENT"].strip()
        is_option = inst.startswith("OPT")
        value = _f(r["VAL_INLAKH"])
        vals = {
            "date": day,
            "instrument": inst,
            "symbol": r["SYMBOL"].strip(),
            "expiry": _ddmonyyyy(r["EXPIRY_DT"]),
            "strike": _f(r["STRIKE_PR"]) if is_option else None,
            "option_type": r["OPTION_TYP"].strip() if is_option else None,
            "open": _f(r["OPEN"]),
            "high": _f(r["HIGH"]),
            "low": _f(r["LOW"]),
            "close": _f(r["CLOSE"]),
            "settle": _f(r["SETTLE_PR"]),
            "contracts": _i(r["CONTRACTS"]),
            "value_rs": None if value is None else value * 1e5,
            "oi": _i(r["OPEN_INT"]),
            "chg_oi": _i(r["CHG_IN_OI"]),
            "underlying_price": None,
            "lot_size": None,
            "source_format": "old",
        }
        for k, v in vals.items():
            rows[k].append(v)
    return pa.table(rows, schema=FO_SCHEMA)


def parse_udiff(text: str, day: date) -> pa.Table:
    rows: dict[str, list] = {f.name: [] for f in FO_SCHEMA}
    for r in csv.DictReader(io.StringIO(text)):
        tp = (r.get("FinInstrmTp") or "").strip()
        if not tp:
            continue
        inst = _UDIFF_INSTRUMENT.get(tp, tp)
        is_option = inst.startswith("OPT")
        vals = {
            "date": day,
            "instrument": inst,
            "symbol": r["TckrSymb"].strip(),
            "expiry": date.fromisoformat(r["XpryDt"].strip()),
            "strike": _f(r["StrkPric"]) if is_option else None,
            "option_type": r["OptnTp"].strip() if is_option else None,
            "open": _f(r["OpnPric"]),
            "high": _f(r["HghPric"]),
            "low": _f(r["LwPric"]),
            "close": _f(r["ClsPric"]),
            "settle": _f(r["SttlmPric"]),
            "contracts": _i(r["TtlTradgVol"]),
            "value_rs": _f(r["TtlTrfVal"]),
            "oi": _i(r["OpnIntrst"]),
            "chg_oi": _i(r["ChngInOpnIntrst"]),
            "underlying_price": _f(r["UndrlygPric"]),
            "lot_size": _i(r["NewBrdLotQty"]),
            "source_format": "udiff",
        }
        for k, v in vals.items():
            rows[k].append(v)
    return pa.table(rows, schema=FO_SCHEMA)


def parse_zip(body: bytes, fmt: str, day: date) -> pa.Table:
    text = _single_member(body)
    return parse_udiff(text, day) if fmt == "udiff" else parse_old(text, day)


def parse_ban(text: str) -> list[str]:
    """`Securities in Ban For Trade Date 01-JAN-2019:`, then `1,ADANIPOWER` lines (or none)."""
    out = []
    for line in text.splitlines()[1:]:
        parts = [p.strip() for p in line.split(",")]
        if len(parts) >= 2 and parts[1]:
            out.append(parts[1])
    return out


# ---------------------------------------------------------------------------
# Fetch and build
# ---------------------------------------------------------------------------


def _read_manifest(path: Path) -> dict[str, dict[str, str]]:
    if not path.exists():
        return {}
    with path.open(newline="") as f:
        return {r["date"]: r for r in csv.DictReader(f)}


def _write_manifest(path: Path, rows: dict[str, dict[str, str]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".csv.tmp")
    with tmp.open("w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=_MANIFEST_COLUMNS)
        w.writeheader()
        for k in sorted(rows):
            w.writerow({c: rows[k].get(c, "") for c in _MANIFEST_COLUMNS})
    tmp.replace(path)


def _atomic_write(path: Path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.tmp")
    tmp.write_bytes(data)
    tmp.replace(path)


def write_day(root: Path, day: date, table: pa.Table) -> Path:
    path = lake_path(root, day)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".parquet.tmp")
    pq.write_table(table.cast(FO_SCHEMA), tmp, compression="zstd")
    tmp.replace(path)
    return path


def _days(start: date, end: date) -> Iterable[date]:
    d = start
    while d <= end:
        yield d
        d += timedelta(days=1)


def fetch(
    root: Path,
    start: date,
    end: date,
    *,
    http: Http | None = None,
    today: date | None = None,
    weekends: bool = False,
    bans: bool = True,
    log: Callable[[str], None] = print,
) -> dict:
    """Fetch every day in [start, end] not yet settled; store raw, the lake file and the ban list.

    Weekends are skipped unless `weekends` (NSE's rare weekend sessions: Budget days, Muhurat).
    Stops at the first non-404 failure (the connection, not the day, is the problem)."""
    http = http or Http()
    today = today or datetime.now().date()
    manifest_path = raw_dir(root) / "manifest.csv"
    manifest = _read_manifest(manifest_path)
    counts = {"ok": 0, "missing": 0, "cached": 0, "bans": 0, "no_ban_file": 0, "error": 0}
    stopped = None
    fetched = 0  # days asked of NSE this run (the progress line and manifest save every 50)
    for day in _days(start, end):
        if day.weekday() >= 5 and not weekends:
            continue
        key = day.isoformat()
        prior = manifest.get(key)
        settled = prior and (
            (prior["status"] == "ok" and lake_path(root, day).exists())
            or (prior["status"] == "missing" and (today - day).days > FRESH_DAYS)
        )
        if settled:
            counts["cached"] += 1
        else:
            try:
                status = _fetch_day(root, day, http, manifest)
            except NseFetchError as e:
                manifest[key] = {
                    "date": key,
                    "status": "error",
                    "format": "",
                    "file": "",
                    "bytes": "0",
                }
                counts["error"] += 1
                stopped = str(e)
                log(f"{day}: stopped: {e}")
                break
            counts[status] += 1
            fetched += 1
            if fetched % 50 == 0:
                _write_manifest(manifest_path, manifest)
                log(f"{day}: {counts}")
        row = manifest.get(key, {})
        # a ban list NSE does not have (404) is recorded once the day is old enough, not asked again
        ban_settled = row.get("ban") == "missing" and (today - day).days > FRESH_DAYS
        if (
            bans
            and row.get("status") == "ok"
            and not ban_path(root, day).exists()
            and not ban_settled
        ):
            try:
                _atomic_write(ban_path(root, day), http.get(ban_url(day)))
                counts["bans"] += 1
            except NseNotFound:
                row["ban"] = "missing"
                counts["no_ban_file"] += 1
                log(f"{day}: no ban-list file")
            except NseFetchError as e:
                stopped = str(e)
                log(f"{day}: stopped on the ban list: {e}")
                break
    _write_manifest(manifest_path, manifest)
    return {"counts": counts, "requests": http.calls, "stopped": stopped}


def _fetch_day(root: Path, day: date, http: Http, manifest: dict) -> str:
    key = day.isoformat()
    for fmt, url in url_order(day):
        try:
            body = http.get(url)
        except NseNotFound:
            continue
        table = parse_zip(body, fmt, day)  # validate before keeping anything
        name = url.rsplit("/", 1)[-1]
        _atomic_write(raw_dir(root) / f"{day.year:04d}" / name, body)
        write_day(root, day, table)
        manifest[key] = {
            "date": key,
            "status": "ok",
            "format": fmt,
            "file": name,
            "bytes": str(len(body)),
        }
        return "ok"
    manifest[key] = {"date": key, "status": "missing", "format": "", "file": "", "bytes": "0"}
    return "missing"


def read_bans(root: Path, day: date) -> list[str] | None:
    """The day's ban list, or None when no file was fetched for the day."""
    p = ban_path(root, day)
    return parse_ban(p.read_text()) if p.exists() else None
