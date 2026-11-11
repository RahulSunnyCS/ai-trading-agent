"""MCX commodity-option history from Fyers' expired-F&O API (BL-148, Phase 1).

Discovery uses Fyers' own historical expiry and contract lists, never a reconstructed symbol:
`expiry_dates` for each root's reference future, then `history_underlying_symbols` for every
expiry.  The result is frozen in a manifest under `raw/fyers-expired/mcx/` whose name carries
the requested window and a hash of the symbol list.  `pull_raw` then caches one raw response per
contract (the NSE backfill's fetcher and cache, so resume, refusal handling and rate-limit
stops are the same code); nothing is written to the lake yet.  `report` measures what is cached.
"""

from __future__ import annotations

import gzip
import hashlib
import io
import json
import re
import shutil
import threading
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta
from pathlib import Path

import pyarrow as pa
import pyarrow.parquet as pq
from trading_data import lake
from trading_data.lake import OPT_SCHEMA

from .auth import FyersCredentialsError
from .client import Candle, FyersClient, RateLimitedError, response_state
from .expired import (
    RETRYABLE_STREAK,
    ExpiryPlan,
    _cache_path,
    _cached_answer,
    _Fetcher,
    _Progress,
    _window,
    _write_cache,
)
from .symbols import IST, Contract, download_master, parse_master

#: The non-agricultural MCX option roots (BL-148 open question 1, answered 2026-11-11):
#: standard and mini contracts alike, never collapsed into one root. Defined in `trading_data`
#: because its quality module judges these names against the MCX session.
MCX_ROOTS = lake.MCX_ROOTS
MASTER_SEGMENT = "MCX_COM"
#: Fyers: an intraday request spans at most 100 calendar days; `expiry_dates` at most 366.
MAX_REQUEST_DAYS = 100
EXPIRY_WINDOW_DAYS = 300
#: The first day of the history, answered 2026-11-11: any contract with rows on or after it.
DEFAULT_START = date(2024, 10, 21)
#: Prime ceilings are 10/s and 500/min; stay under both (the NSE repair's settings).
MIN_INTERVAL_S = 0.125
PER_MINUTE = 450
#: Requests in flight. One takes ~1.3 s, so a serial loop makes ~45 a minute against a ceiling
#: of 450; the shared client paces them all (8/s, 450 in any 60 s), this only keeps it fed.
WORKERS = 20

_SYMBOL = re.compile(
    r"^MCX:(?P<root>[A-Z]+)(?P<yy>\d{2})(?P<mon>[A-Z]{3})(?P<strike>\d+(?:\.\d+)?)(?P<kind>CE|PE)$"
)


def _folder(root: Path) -> Path:
    return root / "raw" / "fyers-expired" / "mcx"


def decode(symbol: str, root_name: str, expiry: date) -> Contract | None:
    """The contract a listed option symbol names, or None when it does not read as
    `MCX:<ROOT><YY><MON><STRIKE><CE|PE>` for this root (kept in the manifest, never guessed).
    The month in a symbol is the underlying future's, which need not be the option's expiry
    month, so only the root is checked against the listing."""
    m = _SYMBOL.match(symbol)
    if m is None or m["root"] != root_name:
        return None
    return Contract(
        symbol=symbol,
        underlying=root_name,
        expiry=expiry,
        strike=float(m["strike"]),
        option_type=m["kind"],
        lot_size=0,  # the expired API carries none; a lot comes from reference data, not here
    )


def reference_futures(roots: tuple[str, ...], today: date) -> dict[str, str]:
    """A currently listed future per root, from the live MCX symbol master: `expiry_dates` is
    asked about a future, and any unexpired one answers for the root's whole history."""
    futures: dict[str, tuple[date, str]] = {}
    for c in parse_master(download_master(MASTER_SEGMENT), set(roots)):
        if (
            c.option_type == "FUT"
            and c.expiry >= today
            and (c.underlying not in futures or c.expiry < futures[c.underlying][0])
        ):
            futures[c.underlying] = (c.expiry, c.symbol)
    missing = [r for r in roots if r not in futures]
    if missing:
        raise RuntimeError(f"no listed MCX future for {missing} in the symbol master")
    return {r: futures[r][1] for r in roots}


# ---------------------------------------------------------------------------
# Manifest
# ---------------------------------------------------------------------------


def _symbols_hash(roots: dict[str, dict]) -> str:
    h = hashlib.sha256()
    for name in sorted(roots):
        for expiry in sorted(roots[name]["expiries"]):
            h.update(f"{name}|{expiry}|".encode())
            h.update(",".join(sorted(roots[name]["expiries"][expiry])).encode())
    return h.hexdigest()


def discover(
    client: FyersClient,
    roots: tuple[str, ...],
    start: date,
    end: date,
    log: Callable[[str], None] = lambda _m: None,
) -> dict:
    """Ask Fyers for every expiry of every root in [start, end] and every option symbol of
    each: the manifest body (not yet written)."""
    futures = reference_futures(roots, end)
    out: dict[str, dict] = {}
    undecodable: list[str] = []
    for name in roots:
        expiries: set[date] = set()
        lo = start
        while lo <= end:
            hi = min(lo + timedelta(days=EXPIRY_WINDOW_DAYS), end)
            expiries.update(client.expired_expiries(futures[name], lo, hi))
            lo = hi + timedelta(days=1)
        listed: dict[str, list[str]] = {}
        for expiry in sorted(expiries):
            if expiry < start:
                continue
            symbols = client.expired_contracts(futures[name], expiry)
            kept = []
            for s in symbols:
                if decode(s, name, expiry) is None:
                    undecodable.append(s)
                else:
                    kept.append(s)
            listed[expiry.isoformat()] = sorted(set(kept))
        out[name] = {"reference_future": futures[name], "expiries": listed}
        log(f"{name}: {len(listed)} expiries, {sum(map(len, listed.values()))} option symbols")
    return {
        "from": start.isoformat(),
        "to": end.isoformat(),
        "roots": out,
        "undecodable": sorted(set(undecodable)),
        "symbols_sha256": _symbols_hash(out),
    }


def save_manifest(root: Path, manifest: dict) -> Path:
    """Write the frozen manifest (never overwritten: the name is the window and the symbol
    hash) and point `latest` at it."""
    folder = _folder(root)
    folder.mkdir(parents=True, exist_ok=True)
    name = f"manifest-{manifest['from']}_{manifest['to']}-{manifest['symbols_sha256'][:10]}.json.gz"
    path = folder / name
    if not path.exists():
        record = manifest | {"created_at": datetime.now(UTC).isoformat(timespec="seconds")}
        tmp = path.with_suffix(".tmp")
        with gzip.open(tmp, "wt", encoding="utf-8") as fh:
            json.dump(record, fh, separators=(",", ":"))
        tmp.replace(path)
    (folder / "latest").write_text(name + "\n")
    return path


def load_manifest(root: Path) -> dict:
    pointer = _folder(root) / "latest"
    if not pointer.exists():
        raise RuntimeError("no MCX manifest yet: run `obt fyers mcx-inventory` first")
    path = _folder(root) / pointer.read_text().strip()
    with gzip.open(path, "rt", encoding="utf-8") as fh:
        return json.load(fh) | {"path": str(path)}


# ---------------------------------------------------------------------------
# Plan and inventory
# ---------------------------------------------------------------------------


def plan_expiries(
    manifest: dict,
    roots: tuple[str, ...],
    *,
    only_expiry: date | None = None,
    first_n: int | None = None,
) -> list[tuple[str, ExpiryPlan]]:
    """(root, ExpiryPlan) per manifest expiry.  One request per contract spans the 99 days up
    to its expiry, or less from the history's first day; the plan's `days` are those bounds,
    which is all `_window` reads."""
    start = date.fromisoformat(manifest["from"])
    plans: list[tuple[str, ExpiryPlan]] = []
    for name in roots:
        done = 0
        for text, symbols in sorted(manifest["roots"][name]["expiries"].items()):
            expiry = date.fromisoformat(text)
            if only_expiry is not None and expiry != only_expiry:
                continue
            if first_n is not None and done >= first_n:
                break
            done += 1
            lo = max(start, expiry - timedelta(days=MAX_REQUEST_DAYS - 1))
            contracts = tuple(c for s in symbols if (c := decode(s, name, expiry)) is not None)
            plans.append((name, ExpiryPlan(expiry=expiry, days=(lo, expiry), contracts=contracts)))
    return plans


def inventory(manifest: dict, data_root: Path) -> dict:
    """Request counts, time at the polite rate and free space; nothing downloaded."""
    per_root = {}
    for name, body in manifest["roots"].items():
        counts = [len(v) for v in body["expiries"].values()]
        strikes = {float(_SYMBOL.match(s)["strike"]) for v in body["expiries"].values() for s in v}
        per_root[name] = {
            "expiries": len(counts),
            "option_symbols": sum(counts),
            "strike_min": min(strikes) if strikes else None,
            "strike_max": max(strikes) if strikes else None,
        }
    total = sum(r["option_symbols"] for r in per_root.values())
    free = shutil.disk_usage(data_root).free
    return {
        "window": f"{manifest['from']} -> {manifest['to']}",
        "symbols_sha256": manifest["symbols_sha256"][:16],
        "roots": per_root,
        "option_symbols": total,
        "candle_requests": total,
        "hours_at_450_per_minute": round(total / PER_MINUTE / 60, 1),
        "undecodable_symbols": len(manifest["undecodable"]),
        "free_gib": round(free / 2**30, 1),
    }


# ---------------------------------------------------------------------------
# Raw pull and report
# ---------------------------------------------------------------------------


def _prefetch(
    client: FyersClient,
    data_root: Path,
    name: str,
    item: ExpiryPlan,
    progress: _Progress,
    max_requests: int | None,
    workers: int,
) -> str | None:
    """Fetch an expiry's uncached contracts in parallel and cache the final answers (`ok`,
    `no_data`).  A refusal or a transient error is left uncached for the serial pass, which
    holds, checks and counts them as it always did.  Returns why the run must stop, if it must."""
    lo, hi = _window(item)
    todo = [
        c
        for c in item.contracts
        if _cached_answer(_cache_path(data_root, name, item.expiry, c.symbol), lo, hi) is None
    ]
    if not todo:
        return None
    lock = threading.Lock()
    stop: list[str] = []
    retry_streak = [0]

    def one(contract: Contract) -> None:
        if stop:
            return
        with lock:
            if max_requests is not None and progress.fetched >= max_requests:
                stop.append("max_requests")
                return
            progress.fetched += 1
        try:
            body, params = client.expired_history_response(contract.symbol, lo, hi)
            state = response_state(body)
        except RateLimitedError as error:
            progress.errors.append(str(error))
            stop.append("rate_limited")
            return
        except FyersCredentialsError as error:
            progress.errors.append(str(error))
            stop.append("credentials")
            return
        if state in ("ok", "no_data"):
            _write_cache(
                _cache_path(data_root, name, item.expiry, contract.symbol),
                contract.symbol,
                params,
                body,
            )
            retry_streak[0] = 0
        elif state in ("rate_limited", "blocked"):
            progress.errors.append(f"{contract.symbol}: {body.get('message') or body}")
            stop.append(state)
        elif state == "retryable":
            with lock:
                retry_streak[0] += 1
                if retry_streak[0] >= RETRYABLE_STREAK:
                    progress.errors.append(f"{contract.symbol}: {body.get('message') or body}")
                    stop.append("retryable")

    with ThreadPoolExecutor(max_workers=workers) as pool:
        list(pool.map(one, todo))
    return stop[0] if stop else None


def pull_raw(
    client: FyersClient,
    data_root: Path,
    manifest: dict,
    roots: tuple[str, ...],
    *,
    only_expiry: date | None = None,
    first_n: int | None = None,
    max_requests: int | None = None,
    retry_refused: bool = False,
    workers: int = WORKERS,
    log: Callable[[str], None] = print,
) -> dict:
    """Cache one raw response per planned contract; a rerun asks only for what is missing.
    Each expiry is fetched by `workers` threads sharing the client's pacing; then the serial
    fetcher takes whatever is left (refusals, transient errors) and settles the expiry."""
    plans = plan_expiries(manifest, roots, only_expiry=only_expiry, first_n=first_n)
    progress = _Progress()
    fetcher = _Fetcher(client, data_root, progress, max_requests, log, retry_refused)
    complete = 0
    for name, item in plans:
        reason = _prefetch(client, data_root, name, item, progress, max_requests, workers)
        if reason is not None:
            progress.stopped = reason
            log(f"{name} {item.expiry}: stopped ({reason}); cache kept")
            break
        if not fetcher.fetch_expiry(name, item):
            break
        complete += 1
        log(
            f"{name} {item.expiry}: {len(item.contracts)} contracts cached "
            f"({progress.fetched} requests)"
        )
    fetcher.finish()
    return {
        "expiries_planned": len(plans),
        "expiries_complete": complete,
        "requests": progress.fetched,
        "from_cache": progress.cached,
        "refused": progress.failed,
        "retryable": progress.retryable,
        "stopped": progress.stopped,
        "errors": progress.errors,
    }


@dataclass
class _Stat:
    state: str
    rows: int
    file_bytes: int
    first: date | None
    last: date | None
    truncated_left: bool


def _stat(path: Path, lo: date, start: date) -> tuple[_Stat, list[Candle]]:
    from .client import response_state

    with gzip.open(path, "rt", encoding="utf-8") as fh:
        body = json.load(fh)["response"]
    state = response_state(body)
    candles = FyersClient.candles_from_response(body) if state == "ok" else []
    days = [datetime.fromtimestamp(c.epoch, UTC).astimezone(IST).date() for c in candles]
    first = days[0] if days else None
    # rows reach the window's first day, and the window is not the history's first day: the
    # contract may have traded earlier than this request could see
    truncated = first is not None and first <= lo and lo > start
    return (
        _Stat(
            state, len(candles), path.stat().st_size, first, days[-1] if days else None, truncated
        ),
        candles,
    )


def _parquet_bytes(candles_by_symbol: dict[str, list[Candle]]) -> int:
    """Size of the rows as one zstd Parquet file in the lake's option schema (an estimate: the
    real files are per day and per underlying, with all contracts together)."""
    cols: dict[str, list] = {name: [] for name in OPT_SCHEMA.names}
    for symbol, candles in candles_by_symbol.items():
        m = _SYMBOL.match(symbol)
        n = len(candles)
        cols["instrument_id"].extend([abs(hash(symbol)) % 10**6] * n)
        cols["ts"].extend(c.epoch for c in candles)
        for key in ("open", "high", "low", "close", "volume"):
            cols[key].extend(getattr(c, key) for c in candles)
        cols["oi"].extend(c.oi for c in candles)
        cols["expiry"].extend([date(2024, 1, 1)] * n)
        cols["strike"].extend([float(m["strike"]) if m else 0.0] * n)
        cols["option_type"].extend([m["kind"] if m else "CE"] * n)
        cols["vendor_symbol"].extend([symbol] * n)
    sink = io.BytesIO()
    pq.write_table(pa.Table.from_pydict(cols, schema=OPT_SCHEMA), sink, compression="zstd")
    return sink.tell()


def report(
    data_root: Path, manifest: dict, roots: tuple[str, ...], *, estimate_parquet: bool = True
) -> dict:
    """What the raw cache holds for the manifest's contracts: per root and expiry, the
    contracts cached, their states, rows, bytes and any window that may have cut a contract
    off at its start; and, from them, a size projection for the whole manifest."""
    start = date.fromisoformat(manifest["from"])
    out: dict = {"roots": {}}
    totals = {"contracts": 0, "rows": 0, "file_bytes": 0}
    sample: dict[str, list[Candle]] = {}
    seen = 0
    for name, item in plan_expiries(manifest, roots):
        lo, _hi = _window(item)
        cached = [(c, _cache_path(data_root, name, item.expiry, c.symbol)) for c in item.contracts]
        stats = []
        for contract, path in cached:
            if path.exists():
                stat, candles = _stat(path, lo, start)
                stats.append(stat)
                seen += 1
                if estimate_parquet and candles and seen % 3 == 1 and len(sample) < 600:
                    sample[contract.symbol] = candles
        if not stats:
            continue
        r = out["roots"].setdefault(name, {"expiries": {}})
        r["expiries"][item.expiry.isoformat()] = {
            "listed": len(item.contracts),
            "cached": len(stats),
            "ok": sum(s.state == "ok" for s in stats),
            "no_data": sum(s.state == "no_data" for s in stats),
            "refused": sum(s.state == "permanent" for s in stats),
            "rows": sum(s.rows for s in stats),
            "file_mib": round(sum(s.file_bytes for s in stats) / 2**20, 2),
            "may_be_cut_at_window_start": sum(s.truncated_left for s in stats),
            "largest_contract_rows": max(s.rows for s in stats),
        }
        totals["contracts"] += len(stats)
        totals["rows"] += sum(s.rows for s in stats)
        totals["file_bytes"] += sum(s.file_bytes for s in stats)
    out["cached"] = totals
    if totals["contracts"]:
        listed = sum(len(v) for name in roots for v in manifest["roots"][name]["expiries"].values())
        per_contract = totals["file_bytes"] / totals["contracts"]
        out["projection"] = {
            "basis": "mean of the cached contracts; only as good as the cached sample is typical",
            "listed_contracts": listed,
            "raw_gz_gib": round(per_contract * listed / 2**30, 1),
            "mean_rows_per_contract": round(totals["rows"] / totals["contracts"]),
        }
        if estimate_parquet and sample:
            rows = sum(len(c) for c in sample.values())
            per_row = _parquet_bytes(sample) / rows
            out["projection"]["parquet_bytes_per_row"] = round(per_row, 1)
            out["projection"]["parquet_gib"] = round(
                per_row * (totals["rows"] / totals["contracts"]) * listed / 2**30, 1
            )
    return out
