"""History API against the expired-F&O API for one contract, after it expires (BL-148 Phase 5).

While a contract is live the nightly collector stores what `/data/history` says; once it has
expired Fyers' expired-F&O API (Prime) states the same minutes again.  Before any rule decides
which wins, this measures how far apart they are:

* the lake's bars of the contract (the History side, as the nightly job stored them) against the
  expired API's raw answer from the cache, minute by minute;
* nothing is written to the lake, and the expired answers must NOT have been imported
  (`mcx-import` fills the lake's missing minutes, after which the two sides are no longer
  independent);
* a day the Angel One fallback stored is left out: it is another feed, measured on its own.

A contract is compared from the first day both sides could hold it (the expired request window and
the first night the collector ran) up to its expiry.  An untraded minute is not missing data:
only minutes one side has and the other lacks, and fields that differ on a minute both have, count.
"""

from __future__ import annotations

import csv
import json
from datetime import date, datetime, timedelta
from pathlib import Path

import duckdb
import numpy as np
import pyarrow as pa
from trading_data import lake
from trading_data.db import connect

from .expired import _cache_path, _cached_answer, _window
from .mcx import plan_expiries
from .mcx_lake import candle_arrays
from .symbols import IST

#: prices are quoted to the paisa; anything beyond float noise is a real difference
PRICE_TOLERANCE = 1e-6
FIELDS = ("open", "high", "low", "close", "volume", "oi")
EXAMPLES = 10


def _ist_midnight(day: date) -> int:
    return int(datetime(day.year, day.month, day.day, tzinfo=IST).timestamp())


def collection_start(root: Path, name: str) -> date | None:
    """The first day the nightly collector can have stored for this root: its first run's session
    less the 98 days one request reaches back (the first run fills a contract's whole life)."""
    with connect(root, read_only=True, views=()) as con:
        row = con.execute(
            "SELECT min(trading_day) FROM ingest_runs WHERE dataset = 'mcx_options_daily' "
            "AND scope = ? AND source IN ('fyers', 'angelone')",
            [name],
        ).fetchone()
    return row[0] - timedelta(days=98) if row and row[0] else None


def angel_days(root: Path, name: str) -> set[date]:
    """Days stored by the Angel One fallback for this root (from its runs' recorded day range)."""
    out: set[date] = set()
    with connect(root, read_only=True, views=()) as con:
        rows = con.execute(
            "SELECT details FROM ingest_runs WHERE dataset = 'mcx_options_daily' "
            "AND scope = ? AND source = 'angelone'",
            [name],
        ).fetchall()
    for (details,) in rows:
        info = json.loads(details) if details else {}
        if info.get("first_day") and info.get("last_day"):
            day, last = date.fromisoformat(info["first_day"]), date.fromisoformat(info["last_day"])
            while day <= last:
                out.add(day)
                day += timedelta(days=1)
    return out


def _lake_rows(
    root: Path, name: str, symbols: list[str], lo: date, hi: date
) -> dict[str, tuple[np.ndarray, dict[str, np.ndarray]]]:
    files = [
        str(lake.bars_1m_path(root, "option", name, d))
        for d in lake.available_days(root, "option", name)
        if lo <= d <= hi
    ]
    if not files:
        return {}
    con = duckdb.connect()
    try:
        con.register("wanted", pa.table({"s": symbols}))
        table = con.execute(
            "SELECT vendor_symbol, epoch(ts)::BIGINT AS t, open, high, low, close, volume, oi "
            "FROM read_parquet(?) WHERE vendor_symbol IN (SELECT s FROM wanted) "
            "ORDER BY vendor_symbol, t",
            [files],
        ).to_arrow_table()
    finally:
        con.close()
    out: dict[str, tuple[np.ndarray, dict[str, np.ndarray]]] = {}
    symbol_col = table.column("vendor_symbol").to_numpy(zero_copy_only=False)
    if not len(symbol_col):
        return out
    t = table.column("t").to_numpy()
    arrays = {
        f: np.asarray(table.column(f).to_numpy(zero_copy_only=False), dtype=np.float64)
        for f in FIELDS
    }
    # the query orders by symbol, so each contract is one slice: split at the changes, once
    edges = np.concatenate(([0], np.flatnonzero(symbol_col[1:] != symbol_col[:-1]) + 1, [len(t)]))
    for lo, hi in zip(edges[:-1], edges[1:], strict=True):
        out[str(symbol_col[lo])] = (t[lo:hi], {f: arrays[f][lo:hi] for f in FIELDS})
    return out


def _differs(a: np.ndarray, b: np.ndarray, field: str) -> np.ndarray:
    if field == "volume":
        return a != b
    both_nan = np.isnan(a) & np.isnan(b)
    if field == "oi":
        return ~both_nan & ((a != b) | np.isnan(a) | np.isnan(b))
    return np.abs(a - b) > PRICE_TOLERANCE


def compare_expiry(
    root: Path, manifest: dict, name: str, expiry: date, *, since: date | None = None
) -> dict:
    """Compare one expired expiry of one root; see the module docstring."""
    item = next(i for _n, i in plan_expiries(manifest, (name,), only_expiry=expiry))
    lo, hi = _window(item)
    start = max(filter(None, [lo, since, collection_start(root, name)]))
    skip = angel_days(root, name)
    symbols = [c.symbol for c in item.contracts]
    lake_rows = _lake_rows(root, name, symbols, start, hi)
    out: dict = {
        "root": name,
        "expiry": expiry.isoformat(),
        "compared_from": start.isoformat(),
        "contracts": len(symbols),
        "expired_not_cached": 0,
        "contracts_with_expired_rows": 0,
        "contracts_with_lake_rows": len(lake_rows),
        "contracts_compared": 0,
        "angel_days_left_out": sorted(d.isoformat() for d in skip if start <= d <= hi),
        "rows_both": 0,
        "rows_only_lake": 0,
        "rows_only_expired": 0,
        "rows_differing_any_field": 0,
        "differing_rows": {f: 0 for f in FIELDS},
        "max_abs_diff": {f: 0.0 for f in FIELDS},
        "examples": [],
        "per_contract": [],
    }
    first = _ist_midnight(start)
    left_out = np.array(sorted(_ist_midnight(d) for d in skip if start <= d <= hi), dtype=np.int64)
    for contract in item.contracts:
        answer = _cached_answer(_cache_path(root, name, expiry, contract.symbol), lo, hi)
        if answer is None:
            out["expired_not_cached"] += 1
            continue
        body, state = answer
        if state == "ok" and body.get("candles"):
            e_t, e_cols, _n = candle_arrays(body)
        else:
            e_t, e_cols = np.empty(0, np.int64), {f: np.empty(0) for f in FIELDS}
        l_t, l_cols = lake_rows.get(contract.symbol, (np.empty(0, np.int64), {}))

        def keep(t: np.ndarray) -> np.ndarray:
            ok = t >= first
            if len(left_out):
                ist_day = ((t + 19800) // 86400) * 86400 - 19800  # IST midnight of each minute
                ok &= ~np.isin(ist_day, left_out)
            return ok

        e_keep, l_keep = keep(e_t), keep(l_t)
        e_t, e_cols = e_t[e_keep], {f: v[e_keep] for f, v in e_cols.items()}
        l_t = l_t[l_keep]
        l_cols = {f: v[l_keep] for f, v in l_cols.items()}
        if len(e_t):
            out["contracts_with_expired_rows"] += 1
        if not len(e_t) and not len(l_t):
            continue
        out["contracts_compared"] += 1
        _both, e_at, l_at = np.intersect1d(e_t, l_t, return_indices=True)
        only_lake = len(l_t) - len(e_at)
        only_expired = len(e_t) - len(e_at)
        out["rows_both"] += len(e_at)
        out["rows_only_lake"] += only_lake
        out["rows_only_expired"] += only_expired
        row = {
            "symbol": contract.symbol,
            "rows_both": len(e_at),
            "only_lake": only_lake,
            "only_expired": only_expired,
        }
        any_bad = np.zeros(len(e_at), dtype=bool)
        for field in FIELDS:
            if not len(e_at):
                row[field] = 0
                continue
            a, b = l_cols[field][l_at], e_cols[field][e_at]
            bad = _differs(a, b, field)
            any_bad |= bad
            row[field] = int(bad.sum())
            out["differing_rows"][field] += row[field]
            if bad.any():
                gap = np.abs(np.where(np.isnan(a) | np.isnan(b), 0.0, a - b))
                out["max_abs_diff"][field] = max(out["max_abs_diff"][field], float(gap.max()))
                if field != "oi" and len(out["examples"]) < EXAMPLES:
                    i = int(np.argmax(np.where(bad, gap, -1.0)))
                    out["examples"].append(
                        {
                            "symbol": contract.symbol,
                            "minute_ist": datetime.fromtimestamp(int(e_t[e_at[i]]), IST).strftime(
                                "%Y-%m-%d %H:%M"
                            ),
                            "field": field,
                            "history": float(a[i]),
                            "expired": float(b[i]),
                        }
                    )
        row["any_field"] = int(any_bad.sum())
        out["rows_differing_any_field"] += row["any_field"]
        out["per_contract"].append(row)
    union = out["rows_both"] + out["rows_only_lake"] + out["rows_only_expired"]
    # of every minute either side holds: how many are on both sides and equal on every field
    out["share_identical_rows"] = (
        round((out["rows_both"] - out["rows_differing_any_field"]) / union, 6) if union else None
    )
    return out


def write_report(root: Path, result: dict) -> Path:
    """The summary as JSON and the per-contract table as CSV beside the manifest."""
    folder = root / "raw" / "fyers-expired" / "mcx"
    folder.mkdir(parents=True, exist_ok=True)
    stem = f"compare-{result['root']}-{result['expiry']}"
    per_contract = result.pop("per_contract")
    (folder / f"{stem}.json").write_text(json.dumps(result, indent=2, default=str))
    with (folder / f"{stem}.csv").open("w", newline="") as fh:
        writer = csv.DictWriter(
            fh,
            ["symbol", "rows_both", "only_lake", "only_expired", "any_field", *FIELDS],
        )
        writer.writeheader()
        writer.writerows(per_contract)
    result["per_contract"] = per_contract
    return folder / f"{stem}.json"
