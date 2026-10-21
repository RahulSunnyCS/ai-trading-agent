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
from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta, timezone
from pathlib import Path

import duckdb
import pyarrow as pa
import pyarrow.parquet as pq
from trading_data import derived, ingest, lake, quality
from trading_data.db import connect
from trading_data.lake import OPT_SCHEMA

from ..data.reference.loader import ReferenceData, default_reference_data
from .client import Candle, FyersClient
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

    @property
    def history_requests(self) -> int:
        return sum(len(item.contracts) for item in self.expiries)


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

    reference = reference or default_reference_data()
    plans = []
    for expiry, days in sorted(wanted.items()):
        symbols = client.expired_contracts(spec.index_symbol, expiry)
        contracts = tuple(_contract(symbol, underlying, expiry, reference) for symbol in symbols)
        plans.append(ExpiryPlan(expiry, tuple(sorted(days)), contracts))
    return BackfillPlan(underlying, start, end, trading_days, tuple(plans))


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

    `max_requests` caps the candle requests of this run; the run stops cleanly at the cap
    (nothing half-merged: an expiry is merged only once all its contracts are cached) and the
    next run resumes from the raw cache.
    """
    reference = reference or default_reference_data()
    metadata_calls_at_start = client.calls
    plans = [
        build_plan(client, root, name, start, end, reference=reference, missing_only=missing_only)
        for name in underlyings
    ]
    if only_expiry is not None:
        plans = [
            BackfillPlan(
                p.underlying,
                p.start,
                p.end,
                p.trading_days,
                tuple(e for e in p.expiries if e.expiry == only_expiry),
            )
            for p in plans
        ]
    summary = {
        "metadata_requests": client.calls - metadata_calls_at_start,
        "history_requests": sum(p.history_requests for p in plans),
        "underlyings": {
            p.underlying: {
                "days": len(p.trading_days),
                "expiries": len(p.expiries),
                "contracts": p.history_requests,
            }
            for p in plans
        },
    }
    if plan_only:
        return summary

    with connect(root, views=()) as con:
        run_id = ingest.start_run(
            con, "fyers", "expired_options_backfill", None, ",".join(underlyings)
        )
    calls_at_start = client.calls
    rows_added = cached = fetched = 0
    stopped: str | None = None
    touched: dict[str, set[date]] = defaultdict(set)
    errors: list[str] = []
    try:
        for plan in plans:
            spec = UNDERLYINGS[plan.underlying]
            for item in plan.expiries:
                if stopped:
                    break
                ids = register_contracts(root, list(item.contracts), [spec])
                rows_by_day: dict[date, list[tuple[Contract, int, list[Candle]]]] = defaultdict(
                    list
                )
                wanted = set(item.days)
                lo, hi = min(wanted), min(max(wanted), item.expiry)
                for number, contract in enumerate(item.contracts, 1):
                    path = _cache_path(root, plan.underlying, item.expiry, contract.symbol)
                    body = _read_cache(path, lo, hi) if path.exists() else None
                    if body is not None:
                        cached += 1
                    else:
                        if max_requests is not None and fetched >= max_requests:
                            stopped = "max_requests"
                            break
                        body, params = client.expired_history_response(contract.symbol, lo, hi)
                        _write_cache(path, contract.symbol, params, body)
                        fetched += 1
                    for day, candles in _split_days(
                        client.candles_from_response(body), wanted
                    ).items():
                        if candles:
                            rows_by_day[day].append((contract, ids[contract.symbol], candles))
                    if number % 100 == 0:
                        log(
                            f"{plan.underlying} {item.expiry}: {number}/{len(item.contracts)} "
                            f"contracts ({fetched} fetched, {cached} cached)"
                        )

                if stopped:
                    log(f"{plan.underlying} {item.expiry}: stopped ({stopped}); cache kept")
                    break
                for day in item.days:
                    rows = rows_by_day.get(day, [])
                    if not rows:
                        continue
                    added, _ = merge_option_partition(
                        lake.bars_1m_path(root, "option", plan.underlying, day), options_table(rows)
                    )
                    rows_added += added
                    touched[plan.underlying].add(day)
                    write_symbol_master(root, day, [row[0] for row in rows])
                log(f"{plan.underlying} {item.expiry}: merged into {len(rows_by_day)} days")
    except (Exception, KeyboardInterrupt) as error:
        errors.append(str(error) or type(error).__name__)
        summary.update({"fetched": fetched, "cached": cached, "rows_added": rows_added})
        with connect(root, views=()) as con:
            ingest.finish_run(
                con,
                run_id,
                requests=client.calls - calls_at_start,
                rows_written=rows_added,
                errors=1,
                details={**summary, "errors": errors},
                failed=True,
            )
        raise

    for name, days in touched.items():
        quality.rebuild(
            root,
            asset="option",
            name=name,
            days=(min(days), max(days)),
            log=lambda _: None,
        )
        if name in derived.DEFAULT_UNDERLYINGS:  # straddle series and IV tables for the new days
            derived.rebuild(root, [name], days=(min(days), max(days)), log=lambda _: None)
    summary.update(
        {
            "fetched": fetched,
            "cached": cached,
            "rows_added": rows_added,
            "touched_days": {name: len(days) for name, days in touched.items()},
            "stopped": stopped,
        }
    )
    with connect(root, views=()) as con:
        ingest.finish_run(
            con,
            run_id,
            requests=client.calls - calls_at_start,
            rows_written=rows_added,
            errors=0,
            details=summary,
        )
    return summary
