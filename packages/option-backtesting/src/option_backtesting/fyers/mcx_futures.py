"""MCX futures history for the option roots (BL-218 Phase 1).

MCX options settle on a future that expires on or after the option (CRUDEOILM's 16 Oct option
on the 20 Oct future; GOLDM's 26 Nov option on the 5 Dec future; SILVERM's futures are
two-monthly, so its Jul and Aug options share one).  The legwise engine picks ATM / ITMn /
OTMn strikes and reads a range on "the underlying", so for MCX that price is the future the
option settles on.

For each option expiry in the frozen MCX manifest this asks Fyers' expired-F&O API (Prime) for
that future over the 100 days that end 10 days after the option expires (one request),
caches the raw answer, and writes the bars to
`lake/bars_1m/asset=future/underlying=<ROOT>/date=<D>`, one row per future per minute
(`vendor_symbol` tells the near and the next month apart, as for the NSE futures).  A rerun
asks nothing already cached and rewrites only its own futures' rows.
"""

from __future__ import annotations

import gzip
import json
from collections import Counter
from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta
from pathlib import Path

import numpy as np
import pyarrow as pa
import pyarrow.parquet as pq
from trading_data import lake
from trading_data.db import connect
from trading_data.instruments import InstrumentSpec, instrument_key, register
from trading_data.lake import BAR_SCHEMA, TS_TYPE

from .client import FyersClient, response_state
from .mcx import DEFAULT_START, EXPIRY_WINDOW_DAYS, MASTER_SEGMENT
from .mcx_lake import EXCHANGE, candle_arrays
from .symbols import download_master, parse_master

#: Days after the option's expiry the request runs to (the future is still trading).
AFTER_EXPIRY_DAYS = 10
#: Fyers' longest 1-minute request, inclusive of both ends.
REQUEST_DAYS = 100
_IST_OFFSET_S = 5 * 3600 + 1800


@dataclass(frozen=True)
class FuturePlan:
    root: str
    option_expiry: date
    symbol: str  # MCX:<ROOT><YY><MON>FUT
    start: date
    end: date
    future_expiry: date


def settling_future(option_expiry: date, futures: list[date]) -> date | None:
    """The future an option settles on: the first futures expiry on or after the option's.
    Not always the option symbol's month: GOLDM's 26 Nov option is on the future that expires
    on 5 Dec, and SILVERM lists a future only every other month."""
    return next((f for f in sorted(futures) if f >= option_expiry), None)


def future_symbol(root: str, future_expiry: date) -> str:
    return f"MCX:{root}{future_expiry:%y}{future_expiry:%b}".upper() + "FUT"


def plan(
    manifest: dict, roots: tuple[str, ...], futures: dict[str, list[date]]
) -> list[FuturePlan]:
    """One future per option expiry of each root (`settling_future`), asked from 89 days
    before the option expires to 10 days after it, or to the future's expiry if sooner."""
    start_floor = date.fromisoformat(manifest["from"])
    out: list[FuturePlan] = []
    for root in roots:
        body = manifest["roots"].get(root)
        if body is None:
            raise KeyError(f"{root} is not in the MCX manifest")
        for expiry_s, symbols in sorted(body["expiries"].items()):
            if not symbols:
                continue
            expiry = date.fromisoformat(expiry_s)
            fut = settling_future(expiry, futures.get(root, []))
            if fut is None:
                continue
            end = min(fut, expiry + timedelta(days=AFTER_EXPIRY_DAYS))
            start = max(start_floor, end - timedelta(days=REQUEST_DAYS - 1))
            out.append(FuturePlan(root, expiry, future_symbol(root, fut), start, end, fut))
    return out


def cache_path(root: Path, p: FuturePlan) -> Path:
    return (
        root
        / "raw"
        / "fyers-expired"
        / "mcx-futures"
        / f"underlying={p.root}"
        # one future can settle two option expiries (SILVERM's Jul and Aug options are both on
        # the Aug future), each with its own window: one file per option expiry
        / f"{p.symbol.replace(':', '_')}_opt{p.option_expiry}.json.gz"
    )


def _read(path: Path) -> dict | None:
    if not path.exists():
        return None
    with gzip.open(path, "rt", encoding="utf-8") as fh:
        return json.load(fh)


def listed_futures(roots: tuple[str, ...], today: date) -> dict[str, list[date]]:
    """Expiries of the futures still listed today, from the live MCX symbol master: an expired
    option can settle on a future that has not expired yet (SILVERM's Sep and Oct 2026 options
    on its Nov future), which the expired API does not serve."""
    out: dict[str, list[date]] = {r: [] for r in roots}
    for c in parse_master(download_master(MASTER_SEGMENT), set(roots)):
        if c.option_type == "FUT" and c.expiry >= today:
            out[c.underlying].append(c.expiry)
    return {r: sorted(v) for r, v in out.items()}


def _live_answer(client: FyersClient, p: FuturePlan) -> tuple[dict, dict]:
    """A still-listed future through the ordinary history endpoint, shaped like an expired-API
    answer so the cache and the lake writer treat it alike."""
    candles = client.minute_candles_range(p.symbol, p.start, p.end)
    body = {
        "s": "ok" if candles else "no_data",
        "columns": ["timestamp", "open", "high", "low", "close", "volume", "open_interest"],
        "candles": [[c.epoch, c.open, c.high, c.low, c.close, c.volume, c.oi] for c in candles],
        "source": "history",
    }
    return body, {"symbol": p.symbol, "range_from": str(p.start), "range_to": str(p.end)}


def pull(
    client: FyersClient, root: Path, plans: list[FuturePlan], log=print, today: date | None = None
) -> dict:
    """Ask each planned future once; cache every final answer (data or none). Stops at the
    first non-final answer (rate limit, refusal of the account, network) so a rerun resumes.
    A future not expired yet is read from the history endpoint, and only for a window that
    has ended (a window still running would cache a partial answer)."""
    today = today or date.today()
    asked = cached = 0
    states: Counter[str] = Counter()
    for p in plans:
        path = cache_path(root, p)
        record = _read(path)
        if record is not None:
            cached += 1
            states[response_state(record["response"])] += 1
            continue
        if p.future_expiry >= today:
            if p.end >= today:
                log(f"{p.symbol}: its window runs to {p.end}; not asked until it has ended")
                continue
            body, params = _live_answer(client, p)
        else:
            body, params = client.expired_history_response(p.symbol, p.start, p.end)
        asked += 1
        state = response_state(body)
        if state not in ("ok", "no_data"):
            log(f"{p.symbol}: {state} ({body.get('message')}); stopping, rerun to resume")
            return {"asked": asked, "cached": cached, "states": dict(states), "stopped": state}
        states[state] += 1
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(".tmp")
        with gzip.open(tmp, "wt", encoding="utf-8") as fh:
            json.dump(
                {
                    "symbol": p.symbol,
                    "params": params,
                    "fetched_at": datetime.now(UTC).isoformat(timespec="seconds"),
                    "response": body,
                },
                fh,
                separators=(",", ":"),
            )
        tmp.replace(path)
        log(f"{p.symbol} {p.start}..{p.end}: {state}, {len(body.get('candles') or [])} bars")
    return {"asked": asked, "cached": cached, "states": dict(states), "stopped": None}


def register_futures(root: Path, plans: list[FuturePlan]) -> dict[str, int]:
    specs = []
    for p in {p.symbol: p for p in plans}.values():
        specs.append(
            InstrumentSpec(
                "future",
                EXCHANGE,
                p.root,
                expiry=p.future_expiry,
                lot_size=None,
                underlying_key=instrument_key(EXCHANGE, "commodity", p.root),
                vendor="fyers",
                vendor_symbol=p.symbol,
            )
        )
    with connect(root, views=()) as con:
        ids = register(con, specs)
    return {s.vendor_symbol: ids[s.key] for s in specs}


def write_lake(root: Path, plans: list[FuturePlan], ids: dict[str, int]) -> dict:
    """Write every cached future's bars into its days' future files.  Rows of the futures
    written here replace the same futures' rows in an existing file; any other row stays."""
    by_day: dict[date, list[pa.Table]] = {}
    mine = {p.symbol for p in plans}
    # a future asked for two option expiries arrives twice over the overlap: one row a minute
    per_symbol: dict[str, list[tuple[np.ndarray, dict]]] = {}
    for p in plans:
        record = _read(cache_path(root, p))
        if record is None or response_state(record["response"]) != "ok":
            continue
        epoch, cols, _n = candle_arrays(record["response"])
        if len(epoch):
            per_symbol.setdefault(p.symbol, []).append((epoch, cols))
    rows = 0
    for symbol, parts in per_symbol.items():
        epoch = np.concatenate([e for e, _c in parts])
        cols = {k: np.concatenate([c[k] for _e, c in parts]) for k in parts[0][1]}
        _, first = np.unique(epoch, return_index=True)
        epoch = epoch[first]
        cols = {k: v[first] for k, v in cols.items()}
        p = next(q for q in plans if q.symbol == symbol)
        days = (epoch.astype(np.int64) + _IST_OFFSET_S) // 86400
        for d in np.unique(days):
            m = days == d
            oi = cols["oi"][m].astype(np.float64)
            table = pa.table(
                {
                    "instrument_id": pa.array(np.full(int(m.sum()), ids[p.symbol], np.int64)),
                    "ts": pa.array(epoch[m].astype(np.int64)).cast(TS_TYPE),
                    **{
                        k: pa.array(cols[k][m].astype(np.float64))
                        for k in ("open", "high", "low", "close", "volume")
                    },
                    "oi": pa.array(oi, mask=np.isnan(oi)),
                    "vendor_symbol": pa.array([p.symbol] * int(m.sum()), pa.string()),
                },
                schema=BAR_SCHEMA,
            )
            by_day.setdefault(date.fromordinal(int(d) + date(1970, 1, 1).toordinal()), []).append(
                table
            )
            rows += table.num_rows
    written = 0
    for day, tables in sorted(by_day.items()):
        path = lake.bars_1m_path(root, "future", plans[0].root, day)
        new = pa.concat_tables(tables)
        if path.exists():
            old = pq.read_table(path).cast(BAR_SCHEMA)
            keep = [s not in mine for s in old.column("vendor_symbol").to_pylist()]
            new = pa.concat_tables([old.filter(pa.array(keep)), new])
        order = np.lexsort(
            (
                np.asarray(new.column("instrument_id").to_numpy()),
                new.column("ts").cast(pa.int64()).to_numpy(),
            )
        )
        lake.write_parquet(new.take(pa.array(order)), path)
        written += 1
    return {"rows": rows, "days_written": written}


def futures_expiries(client: FyersClient, reference: dict[str, str], lo: date, hi: date) -> dict:
    """{root: [futures expiry dates]} from `expiry_dates`' futures list, in short windows."""
    out: dict[str, list[date]] = {}
    for root, ref in reference.items():
        found: set[date] = set()
        a = lo
        while a <= hi:
            b = min(a + timedelta(days=EXPIRY_WINDOW_DAYS), hi)
            found.update(client.expired_futures_expiries(ref, a, b))
            a = b + timedelta(days=1)
        out[root] = sorted(found)
    return out


__all__ = [
    "DEFAULT_START",
    "FuturePlan",
    "futures_expiries",
    "future_symbol",
    "listed_futures",
    "settling_future",
    "plan",
    "pull",
    "register_futures",
    "write_lake",
]
