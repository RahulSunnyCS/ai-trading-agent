"""Resumable Fyers expired-option backfill into the canonical 1-minute lake.

The expired API serves one contract per request but up to 100 calendar days in that
request.  Raw responses are cached per contract before any Parquet is changed, so an
interrupted Prime download resumes without spending the quota again.  Importing then
merges by (instrument_id, ts): an existing vendor/Fyers row always wins and only missing
contract-minutes are added.
"""

from __future__ import annotations

import gzip
import json
from collections import defaultdict
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import UTC, date, datetime, timedelta, timezone
from pathlib import Path

import duckdb
import pyarrow as pa
import pyarrow.parquet as pq
from trading_data import derived, ingest, lake, quality
from trading_data.db import connect
from trading_data.lake import OPT_SCHEMA

from ..data.reference.loader import ReferenceData, default_reference_data
from .auth import FyersCredentialsError
from .client import Candle, FyersClient, RateLimitedError, response_state
from .daily import (
    UNDERLYINGS,
    options_table,
    register_contracts,
    select_expiries,
    write_symbol_master,
)
from .symbols import Contract

IST = timezone(timedelta(hours=5, minutes=30))


@dataclass(frozen=True)
class ExpiryPlan:
    expiry: date
    days: tuple[date, ...]
    contracts: tuple[Contract, ...]


@dataclass(frozen=True)
class BackfillPlan:
    underlying: str
    start: date
    end: date
    trading_days: tuple[date, ...]
    expiries: tuple[ExpiryPlan, ...]
    #: Days whose expiry set may be short: the expired-expiry listing ends yesterday, so a
    #: contract the collector would have kept that day but that has not expired yet cannot
    #: come from this API. The day is still repaired with the expiries that can.
    short_days: tuple[date, ...] = ()

    @property
    def history_requests(self) -> int:
        return sum(len(item.contracts) for item in self.expiries)

    def needs(self) -> dict[date, set[date]]:
        """Every planned expiry each trading day needs, so a day is merged only once all of
        them are in the raw cache (a day's file is what makes a later run skip it)."""
        out: dict[date, set[date]] = {day: set() for day in self.trading_days}
        for item in self.expiries:
            for day in item.days:
                out[day].add(item.expiry)
        return out


def _contract(symbol: str, underlying: str, expiry: date, reference: ReferenceData) -> Contract:
    """Decode strike/right while taking the expiry from Fyers' metadata response.

    Weekly symbols use YYMDD (M=1..9/O/N/D); monthly symbols use YYMON.  Checking
    those exact prefixes avoids guessing where the trailing strike begins.
    """
    exchange, encoded = symbol.split(":", 1)
    right = encoded[-2:]
    if right not in ("CE", "PE"):
        raise ValueError(f"not an option symbol: {symbol}")
    month_code = (
        str(expiry.month) if expiry.month < 10 else {10: "O", 11: "N", 12: "D"}[expiry.month]
    )
    weekly = f"{underlying}{expiry:%y}{month_code}{expiry:%d}"
    monthly = f"{underlying}{expiry:%y%b}".upper()
    prefix = next((p for p in (weekly, monthly) if encoded.startswith(p)), None)
    if prefix is None:
        raise ValueError(f"cannot decode {symbol} for expiry {expiry}")
    strike_text = encoded[len(prefix) : -2]
    if not strike_text.isdigit():
        raise ValueError(f"cannot decode strike in {symbol}")
    return Contract(
        symbol=f"{exchange}:{encoded}",
        underlying=underlying,
        expiry=expiry,
        strike=float(strike_text),
        option_type=right,
        lot_size=reference.lot_size(underlying, expiry),
    )


def _may_be_short(listed: list[date], day: date, cadence: str, last_expired: date) -> bool:
    """True when `select_expiries` on a listing that stops at `last_expired` may miss an
    expiry the collector kept on `day`: too few later expiries, or the nearest month's
    monthly (the next month's too, on a monthly expiry day) not provably known from it."""
    upcoming = sorted(e for e in listed if e >= day)
    if cadence != "weekly":
        return not upcoming or (upcoming[0] == day and len(upcoming) < 2)
    if len(upcoming) < 2:
        return True
    months = sorted({(e.year, e.month) for e in upcoming})
    first_monthly = max(e for e in upcoming if (e.year, e.month) == months[0])
    if first_monthly == day:  # the next month's monthly is wanted too
        if len(months) < 2:
            return True
        last_needed = months[1]
    else:
        last_needed = months[0]
    # a month's monthly is known once the listing reaches past that month
    reach = max(months[-1], (last_expired.year, last_expired.month))
    return reach <= last_needed


def build_plan(
    client: FyersClient,
    root: Path,
    underlying: str,
    start: date,
    end: date,
    *,
    reference: ReferenceData | None = None,
    today: date | None = None,
    missing_only: bool = True,
) -> BackfillPlan:
    """Plan only the expiries the normal collector would retain on each lake day.

    With `missing_only` (the default) a day that already has an option partition is left
    alone: the repair is for holes, and re-requesting a healthy day would spend Prime quota to
    learn nothing.  Pass False to top up thin days too (existing rows still win on merge).
    """
    if underlying not in UNDERLYINGS:
        raise ValueError(f"unknown underlying {underlying}; known: {sorted(UNDERLYINGS)}")
    if start > end:
        raise ValueError("start must be on or before end")
    today = today or date.today()
    last_expired = today - timedelta(days=1)
    if start > last_expired:
        raise ValueError("expired-option backfill cannot start today or in the future")
    spec = UNDERLYINGS[underlying]
    sessions = tuple(d for d in lake.available_days(root, "index", underlying) if start <= d <= end)
    if not sessions:
        raise ValueError(f"no {underlying} index sessions in {start}..{end}")
    have = set(lake.available_days(root, "option", underlying)) if missing_only else set()
    trading_days = tuple(d for d in sessions if d not in have)
    if not trading_days:
        return BackfillPlan(underlying, start, end, (), ())

    # Looking beyond the requested trading window is necessary: the daily collector keeps
    # the next weekly/monthly contracts too.  Fyers rejects a future range_to.
    metadata_end = min(last_expired, end + timedelta(days=45))
    listed = sorted(set(client.expired_expiries(spec.index_symbol, start, metadata_end)))
    wanted: dict[date, set[date]] = defaultdict(set)
    for day in trading_days:
        for expiry in select_expiries(listed, day, spec.cadence):
            wanted[expiry].add(day)
    # Only a listing cut at yesterday (not at the 45-day horizon) can lack a live expiry.
    cut_at_yesterday = end + timedelta(days=45) > last_expired
    short = tuple(
        d
        for d in trading_days
        if cut_at_yesterday and _may_be_short(listed, d, spec.cadence, last_expired)
    )

    reference = reference or default_reference_data()
    plans = []
    for expiry, days in sorted(wanted.items()):
        symbols = client.expired_contracts(spec.index_symbol, expiry)
        contracts = tuple(_contract(symbol, underlying, expiry, reference) for symbol in symbols)
        plans.append(ExpiryPlan(expiry, tuple(sorted(days)), contracts))
    return BackfillPlan(underlying, start, end, trading_days, tuple(plans), short)


def _cache_path(root: Path, underlying: str, expiry: date, symbol: str) -> Path:
    safe = symbol.replace(":", "_")
    return (
        root
        / "raw"
        / "fyers-expired"
        / f"underlying={underlying}"
        / f"expiry={expiry}"
        / f"{safe}.json.gz"
    )


def _write_cache(path: Path, symbol: str, params: dict, body: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    record = {
        "symbol": symbol,
        "params": params,
        "fetched_at": datetime.now(UTC).isoformat(timespec="seconds"),
        "response": body,
    }
    with gzip.open(tmp, "wt", encoding="utf-8") as fh:
        json.dump(record, fh, separators=(",", ":"))
    tmp.replace(path)


def _read_cache(path: Path, lo: date, hi: date) -> dict | None:
    """The cached response, only when it was fetched for a window covering [lo, hi]."""
    with gzip.open(path, "rt", encoding="utf-8") as fh:
        record = json.load(fh)
    params = record.get("params", {})
    try:
        cached_lo = date.fromisoformat(str(params["range_from"]))
        cached_hi = date.fromisoformat(str(params["range_to"]))
    except (KeyError, ValueError):
        return None
    return record["response"] if cached_lo <= lo and hi <= cached_hi else None


def _split_days(candles: list[Candle], wanted: set[date]) -> dict[date, list[Candle]]:
    out: dict[date, list[Candle]] = defaultdict(list)
    for candle in candles:
        day = datetime.fromtimestamp(candle.epoch, IST).date()
        if day in wanted:
            out[day].append(candle)
    return out


def merge_option_partition(path: Path, fresh: pa.Table) -> tuple[int, int]:
    """Add missing keys, preserving every existing row. Returns (added, preserved)."""
    fresh = fresh.cast(OPT_SCHEMA)
    if not path.exists():
        lake.write_parquet(
            fresh.sort_by([("instrument_id", "ascending"), ("ts", "ascending")]), path
        )
        return fresh.num_rows, 0
    old = pq.read_table(path).cast(OPT_SCHEMA)
    con = duckdb.connect()
    try:
        con.register("old_rows", old)
        con.register("fresh_rows", fresh)
        merged = (
            con.execute(
                "SELECT * FROM old_rows UNION ALL BY NAME "
                "SELECT f.* FROM fresh_rows f ANTI JOIN old_rows o "
                "ON f.instrument_id = o.instrument_id AND f.ts = o.ts "
                "QUALIFY row_number() OVER (PARTITION BY f.instrument_id, f.ts ORDER BY f.ts) = 1 "
                "ORDER BY instrument_id, ts"
            )
            .arrow()
            .read_all()
            .cast(OPT_SCHEMA)
        )
    finally:
        con.close()
    added = merged.num_rows - old.num_rows
    lake.write_parquet(merged, path)
    return added, old.num_rows


#: Consecutive retryable failures (network, 5xx) after which a run stops. One is noise, left
#: uncached so the next run asks again; several in a row mean Fyers or the network is down.
RETRYABLE_STREAK = 3


@dataclass
class _Progress:
    fetched: int = 0
    cached: int = 0
    rows_added: int = 0
    retry_streak: int = 0
    stopped: str | None = None
    #: contracts Fyers refused (state `permanent`): cached, so a rerun never asks again
    failed: list[dict] = field(default_factory=list)
    #: retryable failures: not cached, so the next run asks again
    retryable: list[dict] = field(default_factory=list)
    #: days whose partition this run wrote, per underlying: judged and derived at the end
    touched: dict[str, set[date]] = field(default_factory=lambda: defaultdict(set))
    errors: list[str] = field(default_factory=list)


def _window(item: ExpiryPlan) -> tuple[date, date]:
    return min(item.days), min(max(item.days), item.expiry)


def _failure(expiry: date, contract: Contract, body: dict, *, cached: bool = False) -> dict:
    message = str(body.get("message") or body.get("s") or body)
    return {"symbol": contract.symbol, "expiry": expiry.isoformat(), "message": message} | (
        {"cached": True} if cached else {}
    )


def _fetch_expiry(
    client: FyersClient,
    root: Path,
    underlying: str,
    item: ExpiryPlan,
    progress: _Progress,
    max_requests: int | None,
    log: Callable[[str], None],
) -> bool:
    """Cache every contract of one expiry. True when all of them are cached, answers and
    refusals alike; False when the run stopped or a retryable failure left one out."""
    lo, hi = _window(item)
    complete = True
    for number, contract in enumerate(item.contracts, 1):
        path = _cache_path(root, underlying, item.expiry, contract.symbol)
        body = _read_cache(path, lo, hi) if path.exists() else None
        if body is not None:
            progress.cached += 1
            if response_state(body) == "permanent":
                progress.failed.append(_failure(item.expiry, contract, body, cached=True))
            continue
        if max_requests is not None and progress.fetched >= max_requests:
            progress.stopped = "max_requests"
            return False
        try:
            body, params = client.expired_history_response(contract.symbol, lo, hi)
            state = response_state(body)
        except RateLimitedError as error:  # the client's own 429 count ran out
            progress.stopped = "rate_limited"
            progress.errors.append(str(error))
            return False
        except FyersCredentialsError as error:  # e.g. the token died at 06:00: resume later
            progress.stopped = "credentials"
            progress.errors.append(str(error))
            return False
        progress.fetched += 1
        if state == "rate_limited":
            progress.stopped = "rate_limited"
            return False
        if state == "retryable":
            complete = False
            progress.retryable.append(_failure(item.expiry, contract, body))
            progress.retry_streak += 1
            if progress.retry_streak >= RETRYABLE_STREAK:
                progress.stopped = "retryable"
                return False
            continue
        progress.retry_streak = 0
        _write_cache(path, contract.symbol, params, body)
        if state == "permanent":
            progress.failed.append(_failure(item.expiry, contract, body))
        if number % 100 == 0:
            log(
                f"{underlying} {item.expiry}: {number}/{len(item.contracts)} "
                f"contracts ({progress.fetched} fetched, {progress.cached} cached)"
            )
    return complete


def _expiry_cached(root: Path, underlying: str, item: ExpiryPlan) -> bool:
    """Every contract of an expiry this run does not fetch is in the raw cache for its window."""
    lo, hi = _window(item)
    for contract in item.contracts:
        path = _cache_path(root, underlying, item.expiry, contract.symbol)
        if not path.exists() or _read_cache(path, lo, hi) is None:
            return False
    return True


def _merge_days(
    client: FyersClient,
    root: Path,
    plan: BackfillPlan,
    days: list[date],
    needs: dict[date, set[date]],
    ids: dict[date, dict[str, int]],
    progress: _Progress,
) -> None:
    """Merge `days`, every expiry of which is cached, with one partition write per day: a
    day's file appears only with all its expiries in it. Rows are held as Arrow, for the
    ready days only."""
    spec = UNDERLYINGS[plan.underlying]
    by_expiry = {item.expiry: item for item in plan.expiries}
    parts: dict[date, list[pa.Table]] = defaultdict(list)
    listed: dict[date, list[Contract]] = defaultdict(list)
    for expiry in sorted(set().union(*(needs[day] for day in days))):
        item = by_expiry[expiry]
        if expiry not in ids:  # the catalog learns a contract only once its data is in hand
            ids[expiry] = register_contracts(root, list(item.contracts), [spec])
        wanted = {day for day in days if expiry in needs[day]}
        lo, hi = _window(item)
        for contract in item.contracts:
            path = _cache_path(root, plan.underlying, expiry, contract.symbol)
            body = _read_cache(path, lo, hi)
            if body is None:
                raise RuntimeError(f"{contract.symbol}: no cached response for {lo}..{hi}")
            for day, candles in _split_days(client.candles_from_response(body), wanted).items():
                parts[day].append(
                    options_table([(contract, ids[expiry][contract.symbol], candles)])
                )
                listed[day].append(contract)
    for day in sorted(days):
        if not parts[day]:
            continue
        added, _ = merge_option_partition(
            lake.bars_1m_path(root, "option", plan.underlying, day), pa.concat_tables(parts[day])
        )
        progress.rows_added += added
        if added:  # a day that gained nothing keeps its verdict and derived files
            progress.touched[plan.underlying].add(day)
        write_symbol_master(root, day, listed[day])
        del parts[day]


def _judge(root: Path, touched: dict[str, set[date]]) -> None:
    """Verdicts and derived tables for the days this run wrote."""
    for name, days in touched.items():
        if not days:
            continue
        span = (min(days), max(days))
        quality.rebuild(root, asset="option", name=name, days=span, log=lambda _: None)
        if name in derived.DEFAULT_UNDERLYINGS:  # straddle series and IV tables
            # a topped-up day (--all-days) may already have current derived files
            derived.rebuild(root, [name], days=span, force_days=days, log=lambda _: None)


def _run_underlying(
    client: FyersClient,
    root: Path,
    plan: BackfillPlan,
    items: list[ExpiryPlan],
    progress: _Progress,
    max_requests: int | None,
    log: Callable[[str], None],
) -> list[date]:
    """Fetch `items` in order, merging each day as soon as every expiry it needs is cached.
    Returns this run's days left unmerged (they wait for a later run)."""
    needs = plan.needs()
    by_expiry = {item.expiry: item for item in plan.expiries}
    fetching = {item.expiry for item in items}
    complete: set[date] = set()
    outside: dict[date, bool] = {}  # expiries this run does not fetch (--only-expiry)
    ids: dict[date, dict[str, int]] = {}
    done: set[date] = set()

    def ready(day: date) -> bool:
        for expiry in needs[day]:
            if expiry in fetching:
                if expiry not in complete:
                    return False
                continue
            if expiry not in outside:
                outside[expiry] = _expiry_cached(root, plan.underlying, by_expiry[expiry])
            if not outside[expiry]:
                return False
        return True

    for item in items:
        if _fetch_expiry(client, root, plan.underlying, item, progress, max_requests, log):
            complete.add(item.expiry)
        if progress.stopped:
            log(f"{plan.underlying} {item.expiry}: stopped ({progress.stopped}); cache kept")
            break
        days = [day for day in item.days if day not in done and ready(day)]
        if days:
            _merge_days(client, root, plan, days, needs, ids, progress)
            done.update(days)
        log(
            f"{plan.underlying} {item.expiry}: merged {len(days)} day(s); "
            f"{len(set(item.days) - done)} wait for another expiry"
        )
    return sorted({day for item in items for day in item.days} - done)


def run_backfill(
    client: FyersClient,
    root: Path,
    underlyings: list[str],
    start: date,
    end: date,
    *,
    reference: ReferenceData | None = None,
    plan_only: bool = False,
    missing_only: bool = True,
    max_requests: int | None = None,
    only_expiry: date | None = None,
    log: Callable[[str], None] = print,
) -> dict:
    """Plan, cache and merge an expired-options repair for the given index underlyings.

    A day is merged only once every expiry it needs is in the raw cache, so a run stopped
    anywhere (`max_requests`, a rate limit, a rejected token, a crash) never leaves a day
    with a file but missing an expiry, and the next run resumes from the cache. A refused
    contract is recorded and skipped; days already merged are judged even when a run fails.
    """
    reference = reference or default_reference_data()
    metadata_calls_at_start = client.calls
    plans = [
        build_plan(client, root, name, start, end, reference=reference, missing_only=missing_only)
        for name in underlyings
    ]
    fetch = {
        p.underlying: [e for e in p.expiries if only_expiry is None or e.expiry == only_expiry]
        for p in plans
    }
    summary: dict = {
        "metadata_requests": client.calls - metadata_calls_at_start,
        "history_requests": sum(len(e.contracts) for items in fetch.values() for e in items),
        "underlyings": {
            p.underlying: {
                "days": len(p.trading_days),
                "expiries": len(fetch[p.underlying]),
                "contracts": sum(len(e.contracts) for e in fetch[p.underlying]),
                "days_short_of_unexpired_expiries": [d.isoformat() for d in p.short_days],
            }
            for p in plans
        },
    }
    for p in plans:
        if p.short_days:
            log(
                f"{p.underlying}: {len(p.short_days)} day(s) may also need an expiry that has "
                f"not expired yet, which this API cannot serve: "
                f"{', '.join(d.isoformat() for d in p.short_days)}"
            )
    if plan_only:
        return summary

    with connect(root, views=()) as con:
        run_id = ingest.start_run(
            con, "fyers-expired", "expired_options_backfill", None, ",".join(underlyings)
        )
    calls_at_start = client.calls
    progress = _Progress()
    pending: dict[str, list[str]] = {}
    errors = progress.errors
    failure: BaseException | None = None
    try:
        for plan in plans:
            if progress.stopped:  # not reached: every day it needs is still to do
                left = sorted({day for item in fetch[plan.underlying] for day in item.days})
            else:
                left = _run_underlying(
                    client, root, plan, fetch[plan.underlying], progress, max_requests, log
                )
            if left:
                pending[plan.underlying] = [day.isoformat() for day in left]
    except (Exception, KeyboardInterrupt) as error:
        failure = error
        errors.append(str(error) or type(error).__name__)
    try:  # the days already merged get their verdicts whatever stopped the run
        _judge(root, progress.touched)
    except Exception as error:
        errors.append(f"judging the merged days: {error}")
        failure = failure or error

    summary.update(
        {
            "fetched": progress.fetched,
            "cached": progress.cached,
            "rows_added": progress.rows_added,
            "touched_days": {name: len(days) for name, days in progress.touched.items()},
            "stopped": progress.stopped,
            "pending_days": pending,
            "failed_contracts": progress.failed,
            "retryable_failures": progress.retryable,
        }
    )
    new_failures = sum(1 for f in progress.failed if not f.get("cached"))
    with connect(root, views=()) as con:
        ingest.finish_run(
            con,
            run_id,
            requests=client.calls - calls_at_start,
            rows_written=progress.rows_added,
            errors=new_failures + len(progress.retryable) + len(errors),
            details={**summary, "errors": errors},
            failed=failure is not None,
        )
    if failure is not None:
        raise failure
    return summary
