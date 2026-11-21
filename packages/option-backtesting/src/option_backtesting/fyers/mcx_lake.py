"""MCX raw cache -> the canonical 1-minute lake (BL-148, Phase 2).

The raw cache holds one response per contract; the lake holds one file per underlying and day
with every contract that traded.  A day's rows come from every expiry whose 99-day window
contains it, so the import goes through a staging layer: each fully cached expiry becomes one
Parquet file sorted by time (`TRADING_DATA_ROOT/staging/mcx/<root>/`, outside the backed-up
trees), and a day is then read from the few staged expiries that overlap it and written once.
A day is written only when every expiry that could hold rows of it is staged; `merge_option_
partition` never overwrites an existing row, so rerunning, or importing over Fyers' live
history for the same contract, adds only missing contract-minutes.

Raw bars stay sparse: a minute with no trade is not filled.  Duplicated minutes inside one
response are dropped (first wins) and counted.
"""

from __future__ import annotations

import json
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import date, timedelta
from pathlib import Path

import duckdb
import numpy as np
import pyarrow as pa
from trading_data import ingest, lake, quality
from trading_data.db import connect
from trading_data.instruments import InstrumentSpec, instrument_key, register
from trading_data.lake import OPT_SCHEMA, TS_TYPE

from .daily import symbols_table
from .expired import _cache_path, _cached_answer, _window, merge_option_partition
from .mcx import plan_expiries
from .symbols import Contract

EXCHANGE = "MCX"
MASTER_VENDOR = "fyers-mcx"
_IST_OFFSET_S = 19800


def staging_dir(root: Path, name: str) -> Path:
    return root / "staging" / "mcx" / name


def register_contracts(root: Path, contracts: list[Contract]) -> dict[str, int]:
    """Register the options (and their commodity underlying) with their Fyers symbol as the
    vendor alias; {vendor_symbol: instrument_id}.  The root, not the symbol, names the
    underlying, so CRUDEOIL and CRUDEOILM stay separate instruments.  Lot sizes are left
    empty: the expired API carries none, and they come from reference data, not a guess."""
    specs = []
    for c in contracts:
        specs.append(
            InstrumentSpec(
                "option",
                EXCHANGE,
                c.underlying,
                expiry=c.expiry,
                strike=c.strike,
                option_type=c.option_type,
                lot_size=None,
                underlying_key=instrument_key(EXCHANGE, "commodity", c.underlying),
                vendor="fyers",
                vendor_symbol=c.symbol,
            )
        )
    with connect(root, views=()) as con:
        ids = register(con, specs)
    return {s.vendor_symbol: ids[s.key] for s in specs}


def candle_arrays(body: dict) -> tuple[np.ndarray, dict[str, np.ndarray], int]:
    """(epoch, {open..oi}, raw row count) from one response, read by column name, sorted by
    time with a repeated minute dropped (first wins)."""
    names = body.get("columns") or []
    index = {n: i for i, n in enumerate(names)}
    missing = {"timestamp", "open", "high", "low", "close", "volume"} - set(index)
    if missing:
        raise RuntimeError(f"candle columns lack {sorted(missing)}: {names}")
    rows = body.get("candles") or []
    raw = np.asarray(rows, dtype=np.float64).reshape(len(rows), len(names))
    _, first = np.unique(raw[:, index["timestamp"]], return_index=True)
    raw = raw[first]
    out = {k: raw[:, index[k]] for k in ("open", "high", "low", "close", "volume")}
    out["oi"] = (
        raw[:, index["open_interest"]] if "open_interest" in index else np.full(len(raw), np.nan)
    )
    return raw[:, index["timestamp"]].astype(np.int64), out, len(rows)


@dataclass
class Staged:
    expiry: date
    path: Path
    rows: int
    raw_rows: int
    contracts: int
    with_rows: int
    days: list[date]
    reused: bool = False


def _sidecar(path: Path) -> Path:
    return path.with_suffix(".json")


def stage_expiry(
    root: Path, name: str, item, ids: dict[str, int]
) -> tuple[Staged | None, list[str]]:
    """Stage one expiry.  (None, [symbols not cached]) when any contract is missing: such an
    expiry is not imported until the pull has finished it."""
    lo, hi = _window(item)
    paths = {c.symbol: _cache_path(root, name, item.expiry, c.symbol) for c in item.contracts}
    answers = {s: _cached_answer(p, lo, hi) for s, p in paths.items()}
    absent = [s for s, a in answers.items() if a is None]
    if absent:
        return None, absent
    out = staging_dir(root, name) / f"expiry={item.expiry}.parquet"
    newest = max((p.stat().st_mtime for p in paths.values()), default=0.0)
    side = _sidecar(out)
    if out.exists() and side.exists() and out.stat().st_mtime >= newest:
        meta = json.loads(side.read_text())
        return Staged(
            item.expiry,
            out,
            meta["rows"],
            meta["raw_rows"],
            meta["contracts"],
            meta["with_rows"],
            [date.fromisoformat(d) for d in meta["days"]],
            reused=True,
        ), []

    parts: dict[str, list[np.ndarray]] = {
        k: [] for k in ("id", "ts", "open", "high", "low", "close", "volume", "oi")
    }
    raw_total = with_rows = 0
    for c in item.contracts:
        body, state = answers[c.symbol]
        if state != "ok":
            continue
        epoch, cols, raw_n = candle_arrays(body)
        raw_total += raw_n
        if not len(epoch):
            continue
        with_rows += 1
        parts["id"].append(np.full(len(epoch), ids[c.symbol], dtype=np.int64))
        parts["ts"].append(epoch)
        for k, v in cols.items():
            parts[k].append(v)
    cat = {k: (np.concatenate(v) if v else np.empty(0)) for k, v in parts.items()}
    oi = cat["oi"].astype(np.float64)
    table = pa.table(
        {
            "instrument_id": pa.array(cat["id"].astype(np.int64)),
            "ts": pa.array(cat["ts"].astype(np.int64)).cast(TS_TYPE),
            **{
                k: pa.array(cat[k].astype(np.float64))
                for k in ("open", "high", "low", "close", "volume")
            },
            "oi": pa.array(oi, mask=np.isnan(oi)),
        }
    )
    out.parent.mkdir(parents=True, exist_ok=True)
    tmp = out.with_suffix(".tmp")
    con = duckdb.connect()
    try:
        con.register("t", table)
        con.execute(
            f"COPY (SELECT * FROM t ORDER BY ts, instrument_id) TO '{tmp}' "
            "(FORMAT PARQUET, COMPRESSION ZSTD, ROW_GROUP_SIZE 200000)"
        )
    finally:
        con.close()
    tmp.replace(out)
    days = sorted(
        {
            date.fromordinal(int(d) + date(1970, 1, 1).toordinal())
            for d in np.unique((cat["ts"] + _IST_OFFSET_S) // 86400)
        }
    )
    side.write_text(
        json.dumps(
            {
                "rows": int(table.num_rows),
                "raw_rows": int(raw_total),
                "contracts": len(item.contracts),
                "with_rows": with_rows,
                "days": [d.isoformat() for d in days],
            }
        )
    )
    return Staged(
        item.expiry, out, table.num_rows, raw_total, len(item.contracts), with_rows, days
    ), []


def _day_bounds(day: date) -> tuple[str, str]:
    nxt = day + timedelta(days=1)
    return f"{day} 00:00:00+05:30", f"{nxt} 00:00:00+05:30"


def read_day(
    staged: list[Staged], meta: pa.Table, day: date, con: duckdb.DuckDBPyConnection
) -> pa.Table:
    """Every staged row of `day` joined with its contract's fields, in the lake's option schema."""
    lo, hi = _day_bounds(day)
    files = [str(s.path) for s in staged if day in s.days]
    if not files:
        return OPT_SCHEMA.empty_table()
    con.register("meta", meta)
    try:
        table = (
            con.execute(
                "SELECT s.instrument_id, s.ts, s.open, s.high, s.low, s.close, s.volume, s.oi, "
                "m.expiry, m.strike, m.option_type, m.vendor_symbol "
                "FROM read_parquet(?) s JOIN meta m USING (instrument_id) "
                f"WHERE s.ts >= TIMESTAMPTZ '{lo}' AND s.ts < TIMESTAMPTZ '{hi}' "
                "ORDER BY s.instrument_id, s.ts",
                [files],
            )
            .arrow()
            .read_all()
        )
        staged_rows = con.execute(
            f"SELECT count(*) FROM read_parquet(?) WHERE ts >= TIMESTAMPTZ '{lo}' "
            f"AND ts < TIMESTAMPTZ '{hi}'",
            [files],
        ).fetchone()[0]
    finally:
        con.unregister("meta")
    if table.num_rows != staged_rows:  # a row whose instrument is not in the manifest
        raise RuntimeError(
            f"{day}: {staged_rows - table.num_rows} staged row(s) match no manifest contract"
        )
    return table.cast(OPT_SCHEMA)


@dataclass
class ImportResult:
    name: str
    expiries_staged: int = 0
    expiries_waiting: dict[str, int] = field(default_factory=dict)
    raw_rows: int = 0
    staged_rows: int = 0
    days_written: int = 0
    days_waiting: int = 0
    rows_added: int = 0
    rows_preserved: int = 0
    written: list[date] = field(default_factory=list)

    def summary(self) -> dict:
        d = dict(self.__dict__)
        d["written"] = (
            [self.written[0].isoformat(), self.written[-1].isoformat()] if self.written else []
        )
        d["duplicate_rows_dropped"] = self.raw_rows - self.staged_rows
        return d


def import_root(
    root: Path,
    manifest: dict,
    name: str,
    *,
    only_expiry: date | None = None,
    first_n: int | None = None,
    keep_staging: bool = False,
    log: Callable[[str], None] = print,
) -> ImportResult:
    """Stage every fully cached expiry of one root and write the days that are complete."""
    result = ImportResult(name)
    plans = [
        it for _n, it in plan_expiries(manifest, (name,), only_expiry=only_expiry, first_n=first_n)
    ]
    everything = [it for _n, it in plan_expiries(manifest, (name,))]
    contracts = [c for it in everything for c in it.contracts]
    ids = register_contracts(root, contracts)
    meta = pa.table(
        {
            "instrument_id": pa.array([ids[c.symbol] for c in contracts], pa.int64()),
            "expiry": pa.array([c.expiry for c in contracts], pa.date32()),
            "strike": pa.array([c.strike for c in contracts], pa.float64()),
            "option_type": pa.array([c.option_type for c in contracts], pa.string()),
            "vendor_symbol": pa.array([c.symbol for c in contracts], pa.string()),
        }
    )
    by_id = {ids[c.symbol]: c for c in contracts}
    staged: dict[date, Staged] = {}
    for item in plans:
        done, absent = stage_expiry(root, name, item, ids)
        if done is None:
            result.expiries_waiting[item.expiry.isoformat()] = len(absent)
            log(f"{name} {item.expiry}: {len(absent)} contract(s) not cached, left for the pull")
            continue
        staged[item.expiry] = done
        result.expiries_staged += 1
        result.raw_rows += done.raw_rows
        result.staged_rows += done.rows
        log(
            f"{name} {item.expiry}: {done.rows} rows from {done.with_rows}/{done.contracts} "
            f"contracts{' (staging reused)' if done.reused else ''}"
        )
    # staged expiries outside this run's filter still serve the days they overlap
    for item in everything:
        if item.expiry in staged:
            continue
        out = staging_dir(root, name) / f"expiry={item.expiry}.parquet"
        if out.exists() and _sidecar(out).exists():
            meta_ = json.loads(_sidecar(out).read_text())
            staged[item.expiry] = Staged(
                item.expiry, out, meta_["rows"], meta_["raw_rows"], meta_["contracts"],
                meta_["with_rows"], [date.fromisoformat(d) for d in meta_["days"]], reused=True,
            )  # fmt: skip

    windows = {it.expiry: _window(it) for it in everything}
    candidate = sorted({d for s in staged.values() for d in s.days})
    with connect(root, views=()) as con:
        run_id = ingest.start_run(con, "fyers-expired", "mcx_options_import", None, name)
    con = duckdb.connect()
    try:
        con.execute("SET TimeZone='Asia/Kolkata'")
        for day in candidate:
            need = [e for e, (lo, hi) in windows.items() if lo <= day <= hi]
            if any(e not in staged for e in need):
                result.days_waiting += 1
                continue
            table = read_day(list(staged.values()), meta, day, con)
            if not table.num_rows:
                continue
            added, kept = merge_option_partition(
                lake.bars_1m_path(root, "option", name, day), table
            )
            result.rows_added += added
            result.rows_preserved += kept
            result.days_written += 1
            result.written.append(day)
            present = {i for i in table.column("instrument_id").unique().to_pylist()}
            lake.write_parquet(
                symbols_table([by_id[i] for i in sorted(present)]),
                lake.symbol_master_path(root, MASTER_VENDOR, day),
            )
            if result.days_written % 25 == 0:
                log(f"{name}: {result.days_written} day(s) written, last {day}")
    finally:
        con.close()
    with connect(root, views=()) as c2:
        ingest.finish_run(
            c2,
            run_id,
            requests=0,
            rows_written=result.rows_added,
            errors=len(result.expiries_waiting),
            details=result.summary(),
        )
    if result.written:
        quality.rebuild(
            root, asset="option", name=name, days=(result.written[0], result.written[-1]),
            log=lambda _m: None,
        )  # fmt: skip
    if not keep_staging and not result.days_waiting and not result.expiries_waiting:
        for s in staged.values():
            s.path.unlink(missing_ok=True)
            _sidecar(s.path).unlink(missing_ok=True)
    return result
