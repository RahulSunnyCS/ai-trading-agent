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
    #: Listed symbols `_contract` could not decode: skipped, never guessed.
    undecodable: tuple[str, ...] = ()

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
    undecodable: list[str] = []
    for expiry, days in sorted(wanted.items()):
        contracts = []
        for symbol in client.expired_contracts(spec.index_symbol, expiry):
            try:
                contracts.append(_contract(symbol, underlying, expiry, reference))
            except ValueError:  # one odd symbol must not stop the whole plan
                undecodable.append(symbol)
        plans.append(ExpiryPlan(expiry, tuple(sorted(days)), tuple(contracts)))
    return BackfillPlan(
        underlying, start, end, trading_days, tuple(plans), short, tuple(undecodable)
    )


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
    con = duckdb.connect()
    if not path.exists():
        try:  # one row per key here too: two listed symbols may resolve to one instrument
            con.register("fresh_rows", fresh)
            first = (
                con.execute(
                    "SELECT * FROM fresh_rows "
                    "QUALIFY row_number() OVER (PARTITION BY instrument_id, ts ORDER BY ts) = 1 "
                    "ORDER BY instrument_id, ts"
                )
                .arrow()
                .read_all()
                .cast(OPT_SCHEMA)
            )
        finally:
            con.close()
        lake.write_parquet(first, path)
        return first.num_rows, 0
    old = pq.read_table(path).cast(OPT_SCHEMA)
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
#: Consecutive refusals after which they are checked: the symbols come from Fyers' own
#: listing, so a run of refusals may be about the account, not the contracts.
REFUSAL_STREAK = 5
#: Days merged together: every day of a month needs its monthly, so they all become ready at
#: once; merging them a few at a time bounds the rows held in memory.
MERGE_CHUNK_DAYS = 5
#: States a cached response may hold; any other is asked again.
_FINAL = ("ok", "no_data", "permanent")


@dataclass(frozen=True)
class _Held:
    """A refusal not cached yet: held until something shows it was about its contract."""

    underlying: str
    expiry: date
    path: Path
    contract: Contract
    params: dict
    body: dict


@dataclass
class _Progress:
    fetched: int = 0
    cached: int = 0
    rows_added: int = 0
    retry_streak: int = 0
    stopped: str | None = None
    #: contracts Fyers refused (state `permanent`): cached, so a rerun asks again only with
    #: `retry_refused`
    failed: list[dict] = field(default_factory=list)
    #: retryable failures, and refusals left uncached: the next run asks again
    retryable: list[dict] = field(default_factory=list)
    #: days whose partition this run wrote, per underlying: judged and derived at the end
    touched: dict[str, set[date]] = field(default_factory=lambda: defaultdict(set))
    errors: list[str] = field(default_factory=list)
    #: a contract that answered `ok` (symbol, window), from this run or the cache: asked again
    #: to check that held refusals were about their contracts, not the account
    last_ok: tuple[str, date, date] | None = None
    #: refusals in a row (run-wide: none has had an answer after it yet)
    held: list[_Held] = field(default_factory=list)


def _window(item: ExpiryPlan) -> tuple[date, date]:
    return min(item.days), min(max(item.days), item.expiry)


def _failure(
    underlying: str, expiry: date, contract: Contract, body: dict, *, cached: bool = False
) -> dict:
    message = str(body.get("message") or body.get("s") or body)
    return {
        "underlying": underlying,
        "symbol": contract.symbol,
        "expiry": expiry.isoformat(),
        "message": message,
    } | ({"cached": True} if cached else {})


def _cached_answer(path: Path, lo: date, hi: date) -> tuple[dict, str] | None:
    """The cached response and its state, when it covers [lo, hi] and is final. A record an
    earlier version cached under looser rules (a 403, an unrecognised error) is not final
    now, so it is asked again rather than trusted."""
    body = _read_cache(path, lo, hi) if path.exists() else None
    if body is None:
        return None
    try:
        state = response_state(body)
    except FyersCredentialsError:
        return None
    return (body, state) if state in _FINAL else None


def _seed_last_ok(root: Path, plans: list[BackfillPlan]) -> tuple[str, date, date] | None:
    """Any cached `ok` contract in the plan, so a rerun can check refusals from its start."""
    for plan in plans:
        for item in plan.expiries:
            lo, hi = _window(item)
            for contract in item.contracts:
                path = _cache_path(root, plan.underlying, item.expiry, contract.symbol)
                cached = _cached_answer(path, lo, hi)
                if cached is not None and cached[1] == "ok":
                    return contract.symbol, lo, hi
    return None


@dataclass
class _Fetcher:
    """Asks Fyers for the plan's contracts and caches the answers. A refusal is cached only
    once something shows it was about its contract: a later answer, or, at REFUSAL_STREAK
    refusals in a row and at an expiry's end, a contract that answered before (or one from
    the middle of the listing, nearest the money, when none has) answering again."""

    client: FyersClient
    root: Path
    progress: _Progress
    max_requests: int | None
    log: Callable[[str], None]
    retry_refused: bool = False

    def stop(self, reason: str) -> bool:
        self.progress.stopped = reason
        self.release()
        return False

    def keep(self) -> None:
        """Cache the held refusals: they were about their contracts."""
        for h in self.progress.held:
            _write_cache(h.path, h.contract.symbol, h.params, h.body)
            self.progress.failed.append(_failure(h.underlying, h.expiry, h.contract, h.body))
        self.progress.held.clear()

    def release(self) -> None:
        """Leave the held refusals uncached: the next run asks again."""
        for h in self.progress.held:
            self.progress.retryable.append(_failure(h.underlying, h.expiry, h.contract, h.body))
        self.progress.held.clear()

    def ask(self, symbol: str, lo: date, hi: date) -> tuple[dict, dict, str] | None:
        """One request and its state; None when it stopped the run."""
        p = self.progress
        if self.max_requests is not None and p.fetched >= self.max_requests:
            return self.stop("max_requests") or None
        try:
            body, params = self.client.expired_history_response(symbol, lo, hi)
            state = response_state(body)
        except RateLimitedError as error:  # the client's own 429 count ran out
            p.errors.append(str(error))
            return self.stop("rate_limited") or None
        except FyersCredentialsError as error:  # e.g. the token died at 06:00: resume later
            p.errors.append(str(error))
            return self.stop("credentials") or None
        p.fetched += 1
        if state in ("rate_limited", "blocked"):  # every further request would fare the same
            p.errors.append(f"{symbol}: {body.get('message') or body}")
            return self.stop(state) or None
        if state == "retryable":
            p.retry_streak += 1
            if p.retry_streak >= RETRYABLE_STREAK:
                p.errors.append(f"{symbol}: {body.get('message') or body}")
                return self.stop("retryable") or None
        elif state != "permanent":
            p.retry_streak = 0
        return body, params, state

    def check(self, probe: tuple[str, date, date] | None, cache_to: Path | None = None) -> str:
        """Ask `probe` (a contract expected to answer) about the held refusals: `kept` (it
        answered, so they are cached), `released` (a transient error: left to the next run),
        `stopped` (refused too, so about the account; or the run stopped), `none` (nothing to
        ask yet: still held). `cache_to` caches the probe's own answer (a fresh contract)."""
        if probe is None:
            return "none"
        answer = self.ask(*probe)
        if answer is None:
            return "stopped"
        body, params, state = answer
        if state in ("ok", "no_data"):
            if cache_to is not None:
                _write_cache(cache_to, probe[0], params, body)
            if state == "ok":
                self.progress.last_ok = probe
            self.keep()
            return "kept"
        if state == "permanent":
            self.progress.errors.append(
                f"{probe[0]} was refused too: {body.get('message') or body}"
            )
            self.stop("refused_streak")
            return "stopped"
        self.release()
        return "released"

    def fetch_expiry(self, underlying: str, item: ExpiryPlan) -> bool:
        """Cache every contract of one expiry. True when all of them are cached, answers and
        refusals alike; False when the run stopped or a contract is left to ask again."""
        p = self.progress
        lo, hi = _window(item)
        complete = True
        for number, contract in enumerate(item.contracts, 1):
            path = _cache_path(self.root, underlying, item.expiry, contract.symbol)
            cached = _cached_answer(path, lo, hi)
            if cached is not None and not (self.retry_refused and cached[1] == "permanent"):
                p.cached += 1
                if cached[1] == "ok":
                    p.last_ok = (contract.symbol, lo, hi)
                if cached[1] == "permanent":
                    p.failed.append(
                        _failure(underlying, item.expiry, contract, cached[0], cached=True)
                    )
                continue
            answer = self.ask(contract.symbol, lo, hi)
            if answer is None:
                return False
            body, params, state = answer
            if state == "retryable":
                complete = False
                p.retryable.append(_failure(underlying, item.expiry, contract, body))
                continue
            if state == "permanent":
                p.held.append(_Held(underlying, item.expiry, path, contract, params, body))
                if len(p.held) >= REFUSAL_STREAK:
                    probe, cache_to = p.last_ok, None
                    rest = item.contracts[number:]
                    if probe is None and rest:  # nothing answered yet: one nearest the money
                        middle = rest[len(rest) // 2]
                        probe = (middle.symbol, lo, hi)
                        cache_to = _cache_path(self.root, underlying, item.expiry, middle.symbol)
                    outcome = self.check(probe, cache_to)
                    if outcome == "stopped":
                        return False
                    if outcome == "released":
                        complete = False
                continue
            self.keep()  # an answer: the refusals before it were about their contracts
            _write_cache(path, contract.symbol, params, body)
            if state == "ok":
                p.last_ok = (contract.symbol, lo, hi)
            if number % 100 == 0:
                self.log(
                    f"{underlying} {item.expiry}: {number}/{len(item.contracts)} "
                    f"contracts ({p.fetched} fetched, {p.cached} cached)"
                )
        mine = any(h.underlying == underlying and h.expiry == item.expiry for h in p.held)
        # nothing answered after them: check with a contract that answered before; with none
        # yet, they wait for the first answer later in the run (`none`)
        if mine and self.check(p.last_ok) != "kept":
            return False
        return complete

    def finish(self) -> None:
        """Refusals still held at the end of the run: one last check, else left uncached."""
        p = self.progress
        if p.held and not p.stopped:  # e.g. only cached expiries came after them
            self.check(p.last_ok)
        if p.held:
            p.errors.append(f"{len(p.held)} refusal(s) with no answer in the run to check them")
            self.release()
            p.stopped = p.stopped or "refused_unconfirmed"


def _expiry_cached(root: Path, underlying: str, item: ExpiryPlan) -> bool:
    """Every contract of an expiry this run does not fetch is in the raw cache for its window."""
    lo, hi = _window(item)
    return all(
        _cached_answer(_cache_path(root, underlying, item.expiry, c.symbol), lo, hi) is not None
        for c in item.contracts
    )


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
        # the symbol master first: a stop between the two leaves a day without a file, which
        # the next run plans again, never a file without its master
        write_symbol_master(root, day, listed[day])
        added, _ = merge_option_partition(
            lake.bars_1m_path(root, "option", plan.underlying, day), pa.concat_tables(parts[day])
        )
        progress.rows_added += added
        if added:  # a day that gained nothing keeps its verdict and derived files
            progress.touched[plan.underlying].add(day)
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
    fetcher: _Fetcher, plan: BackfillPlan, items: list[ExpiryPlan], *, allow_short: bool = False
) -> list[date]:
    """Fetch `items` in order, merging each day as soon as every expiry it needs is cached.
    A day that may need an expiry not expired yet (`plan.short_days`) waits, unless
    `allow_short`: once written it would be skipped by every default run after.
    Returns this run's days left unmerged (they wait for a later run)."""
    client, root, progress, log = fetcher.client, fetcher.root, fetcher.progress, fetcher.log
    needs = plan.needs()
    held = set() if allow_short else set(plan.short_days)
    by_expiry = {item.expiry: item for item in plan.expiries}
    fetching = {item.expiry for item in items}
    complete: set[date] = set()
    outside: dict[date, bool] = {}  # expiries this run does not fetch (--only-expiry)
    ids: dict[date, dict[str, int]] = {}
    done: set[date] = set()

    def ready(day: date) -> bool:
        if day in held:
            return False
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
        if fetcher.fetch_expiry(plan.underlying, item):
            complete.add(item.expiry)
        if progress.stopped:
            log(f"{plan.underlying} {item.expiry}: stopped ({progress.stopped}); cache kept")
            break
        days = [day for day in item.days if day not in done and ready(day)]
        for at in range(0, len(days), MERGE_CHUNK_DAYS):
            chunk = days[at : at + MERGE_CHUNK_DAYS]
            _merge_days(client, root, plan, chunk, needs, ids, progress)
            done.update(chunk)
        waiting = set(item.days) - done
        log(
            f"{plan.underlying} {item.expiry}: merged {len(days)} day(s); "
            f"{len(waiting - held)} wait for another expiry, "
            f"{len(waiting & held)} for an expiry not expired yet"
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
    retry_refused: bool = False,
    allow_short: bool = False,
    today: date | None = None,
    log: Callable[[str], None] = print,
) -> dict:
    """Plan, cache and merge an expired-options repair for the given index underlyings.

    A day is merged only once every expiry it needs is in the raw cache, and not while an
    expiry it may need has yet to expire (unless `allow_short`), so a run stopped anywhere
    (`max_requests`, a rate limit, a rejected token, a crash) never leaves a day with a file
    but missing an expiry, and the next run resumes from the cache. A contract refused for
    itself is recorded and skipped (`retry_refused` asks again); a run of refusals or no
    access to the API stops the run. Days already merged are judged even when a run fails.
    """
    reference = reference or default_reference_data()
    metadata_calls_at_start = client.calls
    plans = [
        build_plan(
            client,
            root,
            name,
            start,
            end,
            reference=reference,
            today=today,
            missing_only=missing_only,
        )
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
                "undecodable_symbols": list(p.undecodable),
            }
            for p in plans
        },
    }
    for p in plans:
        if p.short_days:
            log(
                f"{p.underlying}: {len(p.short_days)} day(s) may also need an expiry that has "
                f"not expired yet, which this API cannot serve; "
                f"{'merged without it' if allow_short else 'held until it expires'}: "
                f"{', '.join(d.isoformat() for d in p.short_days)}"
            )
        if p.undecodable:
            log(f"{p.underlying}: skipped {len(p.undecodable)} symbol(s) it could not decode")
    if plan_only:
        return summary

    with connect(root, views=()) as con:
        run_id = ingest.start_run(
            con, "fyers-expired", "expired_options_backfill", None, ",".join(underlyings)
        )
    calls_at_start = client.calls
    progress = _Progress(last_ok=_seed_last_ok(root, plans))
    fetcher = _Fetcher(client, root, progress, max_requests, log, retry_refused)
    pending: dict[str, list[str]] = {}
    errors = progress.errors
    failure: BaseException | None = None
    try:
        for plan in plans:
            if progress.stopped:  # not reached: every day it needs is still to do
                left = sorted({day for item in fetch[plan.underlying] for day in item.days})
            else:
                left = _run_underlying(
                    fetcher, plan, fetch[plan.underlying], allow_short=allow_short
                )
            if left:
                pending[plan.underlying] = [day.isoformat() for day in left]
    except (Exception, KeyboardInterrupt) as error:
        failure = error
        errors.append(str(error) or type(error).__name__)
    if failure is None:
        try:  # refusals still held: one last check, else left uncached
            fetcher.finish()
        except Exception as error:
            failure = error
            errors.append(str(error) or type(error).__name__)
    fetcher.release()  # after a failure: never cached unchecked
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
    if progress.touched:
        # stored backtest and rotation results for these days predate the repair
        summary["next"] = (
            "obt legwise rerun; obt rotation update --day D for each repaired day the "
            "rotation covers"
        )
        log(f"repaired days' stored results are stale: run {summary['next']}")
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
