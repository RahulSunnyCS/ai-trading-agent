"""Nightly MCX option collection from Fyers' `/data/history` (BL-148, Phase 4).

The expired-F&O API (Prime) rebuilds history after a contract has expired.  This keeps the
history growing while contracts are live, and works on any plan: it asks `/data/history` for the
nearest and next expiry of every MCX root, from the last day the lake holds for each contract
to the session, one request a contract (up to 99 days).  A missed night therefore costs no
extra requests, and the first run fills each live contract's whole life.

What it writes, and what it never touches:

* a day file keeps every row of the instruments this run did not fetch, and replaces the rows of
  the ones it did (a re-run, or a later run with a longer day, changes nothing else);
* expired contracts are never fetched, so the backfill's rows are never rewritten;
* nothing is filled forward or repaired: a bar is stored as Fyers delivered it.

`session_close` follows MCX's commodity hours: 23:30 IST while the US is on summer time, 23:55
otherwise, the change taking effect on the Monday after the US one.  `run` waits until a minute
after the close so no day is stored part-way; a wrong season only shortens a day, and the next
night's run (which starts from the last stored day) completes it for contracts still listed.
"""

from __future__ import annotations

import dataclasses
import re
import time as _time
from collections import defaultdict
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta
from pathlib import Path

import duckdb
import pyarrow as pa
import pyarrow.parquet as pq
from trading_data import ingest, lake, quality
from trading_data.db import connect

from .auth import FyersCredentialsError
from .client import Candle, FyersClient
from .daily import options_table, symbols_table
from .mcx import DEFAULT_START, MASTER_SEGMENT, MAX_REQUEST_DAYS, MCX_ROOTS
from .mcx_lake import MASTER_VENDOR, register_contracts
from .symbols import IST, Contract, download_master, parse_master

#: nearest and next expiry: the next one is where trading moves in expiry week
EXPIRIES_KEPT = 2
#: contracts fetched between two writes to the lake: bounds memory on a first (whole-life) run
BATCH = 100
#: more failed requests than this share of a root's contracts fails the run
MAX_ERROR_SHARE = 0.05
#: a minute past the close, so the last bar has formed
SETTLE = timedelta(minutes=1)


# ---------------------------------------------------------------------------
# Session and close
# ---------------------------------------------------------------------------


def _nth_sunday(year: int, month: int, n: int) -> date:
    first = date(year, month, 1)
    return first + timedelta(days=(6 - first.weekday()) % 7 + 7 * (n - 1))


def summer_hours(day: date) -> bool:
    """MCX's commodity session ends 23:30 while US daylight saving applies and 23:55 otherwise;
    the exchange switches on the Monday after the US clocks change."""
    start = _nth_sunday(day.year, 3, 2) + timedelta(days=1)
    end = _nth_sunday(day.year, 11, 1) + timedelta(days=1)
    return start <= day < end


def session_close(day: date) -> datetime:
    """The IST instant the session of `day` closes."""
    return datetime(day.year, day.month, day.day, 23, 30 if summer_hours(day) else 55, tzinfo=IST)


def default_session(now: datetime) -> date:
    """The session in progress or last held: after midnight the evening's session is still
    yesterday's, whose bars (to 23:54) were dated yesterday."""
    local = now.astimezone(IST)
    return (local - timedelta(days=1)).date() if local.hour < 9 else local.date()


# ---------------------------------------------------------------------------
# Which contracts
# ---------------------------------------------------------------------------


def select_contracts(
    contracts: list[Contract],
    roots: tuple[str, ...],
    session: date,
    expiries: int = EXPIRIES_KEPT,
) -> dict[str, list[Contract]]:
    """Every strike, CE and PE, of each root's nearest `expiries` expiries still listed on
    `session` (a contract expiring that day counts), the nearest first: if the run is cut short
    it is the contracts about to vanish that were fetched."""
    out: dict[str, list[Contract]] = {}
    for name in roots:
        options = [
            c
            for c in contracts
            if c.underlying == name and c.option_type in ("CE", "PE") and c.expiry >= session
        ]
        keep = sorted({c.expiry for c in options})[:expiries]
        out[name] = sorted(
            (c for c in options if c.expiry in keep),
            key=lambda c: (c.expiry, c.strike or 0.0, c.option_type),
        )
    return out


_DAY_IN_PATH = re.compile(r"date=(\d{4}-\d{2}-\d{2})")


def last_stored(root: Path, name: str, symbols: set[str], since: date) -> dict[str, date]:
    """The last day with a stored bar of each of `symbols`, looking at day files from `since`."""
    files = [
        str(lake.bars_1m_path(root, "option", name, d))
        for d in lake.available_days(root, "option", name)
        if d >= since
    ]
    if not files or not symbols:
        return {}
    con = duckdb.connect()
    try:
        con.register("wanted", pa.table({"s": sorted(symbols)}))
        rows = con.execute(
            "SELECT vendor_symbol, filename FROM read_parquet(?, filename = true) "
            "WHERE vendor_symbol IN (SELECT s FROM wanted) GROUP BY vendor_symbol, filename",
            [files],
        ).fetchall()
    finally:
        con.close()
    out: dict[str, date] = {}
    for symbol, filename in rows:
        match = _DAY_IN_PATH.search(filename)
        if match:
            day = date.fromisoformat(match.group(1))
            if symbol not in out or day > out[symbol]:
                out[symbol] = day
    return out


def request_start(session: date, stored: date | None) -> date:
    """Where a contract's request begins: its last stored day (kept, so a day stored part-way
    is completed), else as far back as one request reaches, never before the history start."""
    floor = max(DEFAULT_START, session - timedelta(days=MAX_REQUEST_DAYS - 1))
    return max(floor, stored) if stored else floor


# ---------------------------------------------------------------------------
# Writing
# ---------------------------------------------------------------------------


def merge_day(path: Path, fresh: pa.Table) -> tuple[int, int]:
    """Write `fresh` into a day file: its instruments' rows replace the file's, the others stay.
    Returns (rows written, rows kept from the old file)."""
    kept_rows = 0
    table = fresh
    if path.exists():
        old = pq.read_table(path).cast(lake.OPT_SCHEMA)
        fresh_ids = set(fresh.column("instrument_id").unique().to_pylist())
        keep = old.filter(
            pa.array([i not in fresh_ids for i in old.column("instrument_id").to_pylist()])
        )
        kept_rows = keep.num_rows
        table = pa.concat_tables([keep, fresh]) if kept_rows else fresh
    table = table.sort_by([("instrument_id", "ascending"), ("ts", "ascending")])
    lake.write_parquet(table, path)
    return fresh.num_rows, kept_rows


def _write_master(root: Path, day: date, contracts: list[Contract]) -> None:
    """Merge the day's contracts into its symbol master (lot size 0: no source states one)."""
    path = lake.symbol_master_path(root, MASTER_VENDOR, day)
    table = symbols_table([dataclasses.replace(c, lot_size=0) for c in contracts])
    if path.exists():
        new = set(table.column("vendor_symbol").to_pylist())
        old = pq.read_table(path).cast(table.schema)
        keep = old.filter(pa.array([s not in new for s in old.column("vendor_symbol").to_pylist()]))
        table = pa.concat_tables([keep, table]) if keep.num_rows else table
    lake.write_parquet(table, path)


def _by_day(
    batch: list[tuple[Contract, int, list[Candle]]],
) -> dict[date, list[tuple[Contract, int, list[Candle]]]]:
    days: dict[date, dict[str, list[Candle]]] = defaultdict(lambda: defaultdict(list))
    meta: dict[str, tuple[Contract, int]] = {}
    for contract, instrument_id, candles in batch:
        meta[contract.symbol] = (contract, instrument_id)
        for candle in candles:
            days[datetime.fromtimestamp(candle.epoch, IST).date()][contract.symbol].append(candle)
    return {
        day: [(*meta[symbol], candles) for symbol, candles in sorted(by_symbol.items())]
        for day, by_symbol in sorted(days.items())
    }


# ---------------------------------------------------------------------------
# The run
# ---------------------------------------------------------------------------


@dataclass
class RootResult:
    name: str
    contracts: int = 0
    requests: int = 0
    with_bars: int = 0
    rows: int = 0
    rows_kept: int = 0
    days: list[date] = field(default_factory=list)
    last_bar: str | None = None
    errors: list[str] = field(default_factory=list)

    def summary(self) -> dict:
        return {
            "contracts": self.contracts,
            "requests": self.requests,
            "with_bars": self.with_bars,
            "rows_written": self.rows,
            "rows_kept": self.rows_kept,
            "days_written": len(self.days),
            "first_day": min(self.days).isoformat() if self.days else None,
            "last_day": max(self.days).isoformat() if self.days else None,
            "last_bar_ist": self.last_bar,
            "errors": len(self.errors),
            "error_examples": self.errors[:5],
        }


def collect_root(
    client: FyersClient,
    root: Path,
    name: str,
    contracts: list[Contract],
    session: date,
    raw: lake.RawSink,
    current: dict,
    log: Callable[[str], None],
) -> RootResult:
    result = RootResult(name, contracts=len(contracts))
    if not contracts:
        return result
    ids = register_contracts(root, contracts)
    stored = last_stored(
        root, name, {c.symbol for c in contracts}, session - timedelta(days=MAX_REQUEST_DAYS)
    )
    with connect(root, views=()) as con:
        run_id = ingest.start_run(con, "fyers", "mcx_options_daily", session, name)
    calls_before = client.calls
    failed = False
    last_epoch = 0
    try:
        for expiry in sorted({c.expiry for c in contracts}):
            current["name"] = f"mcx-{name}-{expiry}"
            batch: list[tuple[Contract, int, list[Candle]]] = []
            todo = [c for c in contracts if c.expiry == expiry]
            for n, contract in enumerate(todo, 1):
                start = request_start(session, stored.get(contract.symbol))
                try:
                    candles = client.minute_candles_range(contract.symbol, start, session)
                except FyersCredentialsError:
                    raise
                except RuntimeError as error:  # one refused symbol must not lose the night
                    result.errors.append(str(error)[:200])
                    continue
                if candles:
                    result.with_bars += 1
                    last_epoch = max(last_epoch, candles[-1].epoch)
                    batch.append((contract, ids[contract.symbol], candles))
                if len(batch) >= BATCH or (n == len(todo) and batch):
                    _flush(root, name, batch, result)
                    batch = []
            raw.flush(current["name"])
            log(
                f"{name} {expiry}: {len(todo)} contracts, {result.with_bars} with bars so far, "
                f"{result.rows} rows written"
            )
    except BaseException:
        failed = True
        raise
    finally:
        result.requests = client.calls - calls_before
        if last_epoch:
            result.last_bar = datetime.fromtimestamp(last_epoch, IST).strftime("%Y-%m-%d %H:%M")
        with connect(root, views=()) as con:
            ingest.finish_run(
                con,
                run_id,
                requests=result.requests,
                rows_written=result.rows,
                errors=len(result.errors),
                details=result.summary(),
                failed=failed,
            )
    if result.days:
        quality.rebuild(
            root,
            asset="option",
            name=name,
            days=(min(result.days), max(result.days)),
            log=lambda _m: None,
        )
    return result


def _flush(
    root: Path,
    name: str,
    batch: list[tuple[Contract, int, list[Candle]]],
    result: RootResult,
) -> None:
    for day, rows in _by_day(batch).items():
        added, kept = merge_day(lake.bars_1m_path(root, "option", name, day), options_table(rows))
        result.rows += added
        result.rows_kept += kept
        if day not in result.days:
            result.days.append(day)
        _write_master(root, day, [c for c, _i, _cs in rows])


def wait_for_close(
    session: date,
    *,
    now: Callable[[], datetime],
    sleep: Callable[[float], None] = _time.sleep,
    log: Callable[[str], None] = print,
) -> float:
    """Sleep until a minute after the session closes; returns the seconds waited."""
    target = session_close(session) + SETTLE
    wait = (target - now()).total_seconds()
    if wait <= 0:
        return 0.0
    log(f"waiting {int(wait // 60)} min for the {session_close(session):%H:%M} IST close")
    while (left := (target - now()).total_seconds()) > 0:
        sleep(min(left, 60.0))
    return wait


def run(
    client: FyersClient,
    root: Path,
    *,
    session: date,
    roots: tuple[str, ...] = MCX_ROOTS,
    expiries: int = EXPIRIES_KEPT,
    wait: bool = True,
    now: Callable[[], datetime] = lambda: datetime.now(IST),
    sleep: Callable[[float], None] = _time.sleep,
    master_loader: Callable[[], str] = lambda: download_master(MASTER_SEGMENT),
    dry_run: bool = False,
    log: Callable[[str], None] = print,
) -> dict:
    """Collect `session` for the chosen roots.  The result's `status` is `ok`, `partial` (some
    requests failed, within the allowed share) or `no_session` (every request answered, none
    with a bar: the exchange did not trade)."""
    selected = select_contracts(parse_master(master_loader(), set(roots)), roots, session, expiries)
    out: dict = {
        "session": session.isoformat(),
        "close_ist": f"{session_close(session):%H:%M}",
        "dry_run": dry_run,
        "roots": {},
    }
    if dry_run:
        for name, contracts in selected.items():
            out["roots"][name] = {
                "contracts": len(contracts),
                "expiries": sorted({c.expiry.isoformat() for c in contracts}),
            }
        out["status"] = "dry_run"
        return out
    if wait:
        out["waited_s"] = round(wait_for_close(session, now=now, sleep=sleep, log=log))
    raw = lake.RawSink(root, "fyers", session)
    current = {"name": "mcx"}
    client.on_response = lambda symbol, params, body: raw.add(current["name"], symbol, params, body)
    results = [
        collect_root(client, root, name, contracts, session, raw, current, log)
        for name, contracts in selected.items()
    ]
    out["roots"] = {r.name: r.summary() for r in results}
    out["requests"] = sum(r.requests for r in results)
    out["rows_written"] = sum(r.rows for r in results)
    errors = sum(len(r.errors) for r in results)
    asked = sum(r.contracts for r in results)
    if errors and errors > MAX_ERROR_SHARE * max(asked, 1):
        out["status"] = "failed"
    elif errors:
        out["status"] = "partial"
    elif not out["rows_written"] and not any(r.with_bars for r in results):
        out["status"] = "no_session"
    else:
        out["status"] = "ok"
    return out
