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

The session's close is read from the data, not from a calendar: MCX's commodity session ends at
23:30 or at 23:55 IST (the lake shows the switch on 10 Mar and 3 Nov in 2025, but on 18 Mar and
30 Oct in 2026, so no rule from the US clock change holds).  `run` waits for 23:31, looks at the
last bar of the nearest future, and waits on to 23:56 only when that bar shows the session still
trading; no day is stored part-way, and a night that ran early is completed by the next night's
run, which starts from the last stored day, for any contract still listed.
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
from .daily import options_table, write_symbol_master
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
#: the two session closes MCX uses for commodities, IST (hour, minute)
EARLIEST_CLOSE, LATEST_CLOSE = (23, 30), (23, 55)


# ---------------------------------------------------------------------------
# Session and close
# ---------------------------------------------------------------------------


def session_start_of_close(day: date) -> datetime:
    """The earliest MCX close (23:30 IST) plus a minute: when the close is first looked at."""
    return datetime(day.year, day.month, day.day, *EARLIEST_CLOSE, tzinfo=IST) + SETTLE


def session_latest_end(day: date) -> datetime:
    """The latest MCX close (23:55 IST) plus a minute: every session has ended by then."""
    return datetime(day.year, day.month, day.day, *LATEST_CLOSE, tzinfo=IST) + SETTLE


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


def request_start(
    session: date,
    stored: date | None,
    *,
    inclusive: bool = True,
    lookback: int = MAX_REQUEST_DAYS,
) -> date:
    """Where a contract's request begins: its last stored day (kept, so a day stored part-way
    is completed), else as far back as `lookback` days (one request's reach), never before the
    history start.  `inclusive=False` starts the day after the last stored one: the fallback
    source never replaces a day another source stored."""
    floor = max(DEFAULT_START, session - timedelta(days=lookback - 1))
    if not stored:
        return floor
    return max(floor, stored if inclusive else stored + timedelta(days=1))


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
    skipped: int = 0  # already stored for the session by the other source
    expiring_errors: int = 0  # refused contracts that expire by the session: lost if not now
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
            "skipped_already_stored": self.skipped,
            "with_bars": self.with_bars,
            "rows_written": self.rows,
            "rows_kept": self.rows_kept,
            "days_written": len(self.days),
            "first_day": min(self.days).isoformat() if self.days else None,
            "last_day": max(self.days).isoformat() if self.days else None,
            "last_bar_ist": self.last_bar,
            "errors": len(self.errors),
            "errors_on_expiring": self.expiring_errors,
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
    *,
    source: str = "fyers",
    inclusive: bool = True,
    lookback: int = MAX_REQUEST_DAYS,
) -> RootResult:
    result = RootResult(name, contracts=len(contracts))
    if not contracts:
        return result
    ids = register_contracts(root, contracts)
    stored = last_stored(
        root, name, {c.symbol for c in contracts}, session - timedelta(days=MAX_REQUEST_DAYS)
    )
    with connect(root, views=()) as con:
        run_id = ingest.start_run(con, source, "mcx_options_daily", session, name)
    calls_before = client.calls
    failed = False
    last_epoch = 0
    try:
        for expiry in sorted({c.expiry for c in contracts}):
            current["name"] = f"mcx-{name}-{expiry}"
            batch: list[tuple[Contract, int, list[Candle]]] = []
            todo = [c for c in contracts if c.expiry == expiry]
            try:
                for contract in todo:
                    start = request_start(
                        session, stored.get(contract.symbol), inclusive=inclusive, lookback=lookback
                    )
                    if start > session:  # another source already stored the session
                        result.skipped += 1
                        continue
                    try:
                        candles = client.minute_candles_range(contract.symbol, start, session)
                    except FyersCredentialsError:
                        if batch:  # what was already fetched this expiry is kept
                            _flush(root, name, batch, result)
                            batch = []
                        raise
                    except RuntimeError as error:  # one refused symbol must not lose the night
                        result.errors.append(str(error)[:200])
                        if contract.expiry <= session:  # it cannot be fetched again tomorrow
                            result.expiring_errors += 1
                        continue
                    if candles:
                        result.with_bars += 1
                        last_epoch = max(last_epoch, candles[-1].epoch)
                        batch.append((contract, ids[contract.symbol], candles))
                    if len(batch) >= BATCH:
                        _flush(root, name, batch, result)
                        batch = []
                if batch:  # the rest, also when the last contracts had no bars or were refused
                    _flush(root, name, batch, result)
            finally:
                raw.flush(current["name"])  # the verbatim responses survive an aborted run
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
        write_symbol_master(
            root,
            day,
            [dataclasses.replace(c, lot_size=0) for c, _i, _cs in rows],  # no source states a lot
            vendor=MASTER_VENDOR,
        )


def _sleep_until(target: datetime, now: Callable[[], datetime], sleep: Callable[[float], None]):
    while (left := (target - now()).total_seconds()) > 0:
        sleep(min(left, 60.0))


def future_last_bar(
    client: FyersClient, master: list[Contract], roots: tuple[str, ...], session: date
) -> Callable[[], datetime | None]:
    """A probe for the session's last bar: the nearest future of each root (at most three asked)
    answers until one has bars; None when none has (a day the exchange is shut)."""
    nearest: dict[str, Contract] = {}
    for c in master:
        if (
            c.option_type == "FUT"
            and c.expiry >= session
            and c.underlying in roots
            and (c.underlying not in nearest or c.expiry < nearest[c.underlying].expiry)
        ):
            nearest[c.underlying] = c
    futures = [nearest[r] for r in roots if r in nearest][:3]

    def probe() -> datetime | None:
        for future in futures:
            candles = client.minute_candles_range(future.symbol, session, session)
            if candles:
                return datetime.fromtimestamp(candles[-1].epoch, IST)
        return None

    return probe


def wait_for_close(
    session: date,
    *,
    now: Callable[[], datetime],
    sleep: Callable[[float], None] = _time.sleep,
    last_bar: Callable[[], datetime | None] | None = None,
    log: Callable[[str], None] = print,
) -> float:
    """Wait until the session has ended; returns the seconds waited.

    A session already past waits for nothing.  Otherwise: until 23:31 (the earlier close plus a
    minute), then `last_bar()` (the last bar of the nearest future) decides: before 23:30 the
    session closed at 23:30 (or there was none), and the run goes on; later, it is still
    trading and the wait goes on to 23:56.  Without a probe (the Angel One fallback) the wait
    is to 23:56."""
    started = now()
    first, last = session_start_of_close(session), session_latest_end(session)
    if started >= last:
        return 0.0
    if started < first:
        log(f"waiting for {first:%H:%M} IST to look at the close")
        _sleep_until(first, now, sleep)
    if last_bar is not None:
        bar = last_bar()
        if bar is None or (bar.hour, bar.minute) < EARLIEST_CLOSE:
            log(
                f"the session has closed (last future bar {bar:%H:%M})" if bar else "no future bars"
            )
            return (now() - started).total_seconds()
        log(f"still trading (future bar {bar:%H:%M}); waiting for {last:%H:%M} IST")
    else:
        log(f"waiting for {last:%H:%M} IST, the latest close")
    _sleep_until(last, now, sleep)
    return (now() - started).total_seconds()


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
    source: str = "fyers",
    inclusive: bool = True,
    lookback: int = MAX_REQUEST_DAYS,
    log: Callable[[str], None] = print,
) -> dict:
    """Collect `session` for the chosen roots.  The result's `status` is `ok`, `partial` (some
    requests failed, none of them on a contract that expires by the session), `no_session` (every
    request answered, none with a bar, and the futures traded no bar either: the exchange was
    shut) or `failed`: an expiring contract was refused (it cannot be fetched tomorrow), more than
    5% of requests failed, most contracts found no match at Angel One, or the options answered
    nothing on a day the futures traded.  The Angel One fallback passes `source="angelone"`,
    `inclusive=False` (a day another source stored is never replaced) and a short `lookback`."""
    master = parse_master(master_loader(), set(roots))
    selected = select_contracts(master, roots, session, expiries)
    out: dict = {"session": session.isoformat(), "source": source, "dry_run": dry_run, "roots": {}}
    if dry_run:
        for name, contracts in selected.items():
            out["roots"][name] = {
                "contracts": len(contracts),
                "expiries": sorted({c.expiry.isoformat() for c in contracts}),
            }
        out["status"] = "dry_run"
        return out
    probe = future_last_bar(client, master, roots, session) if source == "fyers" else None
    if wait:
        out["waited_s"] = round(
            wait_for_close(session, now=now, sleep=sleep, last_bar=probe, log=log)
        )
    asked = sum(len(cs) for cs in selected.values())
    bind = getattr(client, "bind_mcx", None)  # the Angel One client maps Fyers contracts to its own
    unmatched = 0
    if bind is not None:
        matched = bind([c for cs in selected.values() for c in cs])
        unmatched = asked - matched
        out["matched_contracts"], out["unmatched_contracts"] = matched, unmatched
        log(f"matched {matched} of {asked} contracts to {source}")
    raw = lake.RawSink(root, source, session)
    current = {"name": "mcx"}
    client.on_response = lambda symbol, params, body: raw.add(current["name"], symbol, params, body)
    results = [
        collect_root(
            client, root, name, contracts, session, raw, current, log,
            source=source, inclusive=inclusive, lookback=lookback,
        )
        for name, contracts in selected.items()
    ]  # fmt: skip
    out["roots"] = {r.name: r.summary() for r in results}
    out["requests"] = sum(r.requests for r in results)
    out["rows_written"] = sum(r.rows for r in results)
    errors = sum(len(r.errors) for r in results)
    expiring = sum(r.expiring_errors for r in results)
    if expiring or (errors and errors > MAX_ERROR_SHARE * max(asked, 1)):
        out["status"] = "failed"
        out["reason"] = (
            f"{expiring} contract(s) expiring by the session were refused"
            if expiring
            else f"{errors} of {asked} requests failed"
        )
    elif bind is not None and unmatched > asked / 2:
        out["status"] = "failed"
        out["reason"] = f"{unmatched} of {asked} contracts have no match at Angel One"
    elif errors:
        out["status"] = "partial"
    elif not out["rows_written"] and not any(r.with_bars or r.skipped for r in results):
        if (
            probe is not None and probe() is not None
        ):  # the futures traded: the options did not answer
            out["status"] = "failed"
            out["reason"] = "the options answered no data on a day the futures traded"
        else:
            out["status"] = "no_session"
    else:
        out["status"] = "ok"
    return out
