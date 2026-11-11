"""Audit of the MCX option history in the lake (BL-148, Phase 3).

Three things, none of which writes to the lake:

* `invariants` - checks over every stored row of one root: a repeated (instrument, minute), a
  minute out of order, an OHLC that cannot be a bar, a negative volume or open interest, a bar
  outside the MCX session or after the contract's expiry, and how many rows lack open interest.
* `sample_exact` - a seeded sample of contracts read again from the raw cache and compared with
  the lake, value by value.  This is the raw-to-lake proof; the lake is never the reference.
* `coverage` - one line per manifest contract (CSV), and a per-root summary: requested,
  with bars, empty, not yet imported, first and last day, rows and open-interest coverage.

An untraded minute is not missing data: nothing here asks for a bar on every minute.
"""

from __future__ import annotations

import csv
import random
from datetime import date, datetime
from pathlib import Path

import duckdb
import numpy as np

from .expired import _cache_path, _cached_answer, _window
from .mcx import plan_expiries
from .mcx_lake import candle_arrays
from .symbols import IST

#: Bars outside 09:00 up to 23:55 IST (bar start) are not MCX session bars.
_IST_TIME = "CAST(ts AT TIME ZONE 'Asia/Kolkata' AS TIME)"
_SESSION = f"({_IST_TIME} >= TIME '09:00' AND {_IST_TIME} < TIME '23:55')"


def _glob(root: Path, name: str) -> str:
    return str(
        root
        / "lake"
        / "bars_1m"
        / "asset=option"
        / f"underlying={name}"
        / "date=*"
        / "data.parquet"
    )


def _has_files(root: Path, name: str) -> bool:
    return any(
        (root / "lake" / "bars_1m" / "asset=option" / f"underlying={name}").glob(
            "date=*/data.parquet"
        )
    )


def invariants(root: Path, name: str) -> dict:
    """Counts of every kind of violation over all stored rows of one root (0 is the pass)."""
    if not _has_files(root, name):
        return {"rows": 0}
    con = duckdb.connect()
    try:
        con.execute("SET TimeZone='Asia/Kolkata'")
        src = f"read_parquet('{_glob(root, name)}', filename = true, file_row_number = true)"
        row = con.execute(
            f"""
            SELECT count(*) AS rows,
                   count(*) - count(DISTINCT (filename, instrument_id, ts)) AS duplicate_minutes,
                   count(*) FILTER (WHERE high < low OR high < open OR high < close
                                    OR low > open OR low > close) AS impossible_ohlc,
                   count(*) FILTER (WHERE open < 0 OR high < 0 OR low < 0 OR close < 0)
                       AS negative_price,
                   count(*) FILTER (WHERE volume < 0) AS negative_volume,
                   count(*) FILTER (WHERE oi < 0) AS negative_oi,
                   count(*) FILTER (WHERE oi IS NULL) AS null_oi,
                   count(*) FILTER (WHERE NOT {_SESSION}) AS outside_session,
                   count(*) FILTER (WHERE CAST(ts AT TIME ZONE 'Asia/Kolkata' AS DATE) > expiry)
                       AS after_expiry,
                   count(*) FILTER (WHERE dayofweek(ts AT TIME ZONE 'Asia/Kolkata') IN (0, 6))
                       AS weekend_rows
            FROM {src}
            """
        ).fetchone()
        keys = [
            "rows",
            "duplicate_minutes",
            "impossible_ohlc",
            "negative_price",
            "negative_volume",
            "negative_oi",
            "null_oi",
            "outside_session",
            "after_expiry",
            "weekend_rows",
        ]
        out = dict(zip(keys, row, strict=True))
        if out["impossible_ohlc"]:
            # the vendor's own bars, kept as delivered: listed for the owner, never repaired
            out["impossible_ohlc_examples"] = [
                f"{sym} {datetime.fromtimestamp(ep, IST):%Y-%m-%d %H:%M} "
                f"o={o} h={h} l={low} c={c} v={v}"
                for sym, ep, o, h, low, c, v in con.execute(
                    f"""
                    SELECT vendor_symbol, epoch(ts), open, high, low, close, volume
                    FROM {src}
                    WHERE high < low OR high < open OR high < close OR low > open OR low > close
                    ORDER BY ts LIMIT 20
                    """
                ).fetchall()
            ]
        out["out_of_order"] = con.execute(
            f"""
            SELECT count(*) FROM (
                SELECT ts, lag(ts) OVER (PARTITION BY filename, instrument_id
                                         ORDER BY file_row_number) AS prev
                FROM {src}
            ) WHERE prev IS NOT NULL AND ts <= prev
            """
        ).fetchone()[0]
    finally:
        con.close()
    return out


def sample_exact(root: Path, manifest: dict, name: str, k: int = 200, seed: int = 148) -> dict:
    """Compare k seeded contracts, raw cache against lake, on every field of every row."""
    plans = [i for _n, i in plan_expiries(manifest, (name,))]
    pool = []
    for item in plans:
        lo, hi = _window(item)
        for c in item.contracts:
            pool.append((item, c, lo, hi))
    random.Random(seed).shuffle(pool)
    con = duckdb.connect()
    con.execute("SET TimeZone='Asia/Kolkata'")
    checked = mismatched = empty_ok = skipped = 0
    problems: list[str] = []
    try:
        for item, c, lo, hi in pool:
            if checked >= k:
                break
            answer = _cached_answer(_cache_path(root, name, item.expiry, c.symbol), lo, hi)
            if answer is None or answer[1] != "ok":
                continue
            epoch, cols, _n = candle_arrays(answer[0])
            rows = con.execute(
                f"SELECT epoch(ts)::BIGINT, open, high, low, close, volume, oi "
                f"FROM read_parquet('{_glob(root, name)}') WHERE vendor_symbol = ? "
                "ORDER BY ts",
                [c.symbol],
            ).fetchall()
            if not len(epoch):
                empty_ok += 1
                continue
            if not rows:  # its days are not imported yet (a day waits for its other expiries)
                skipped += 1
                continue
            checked += 1
            expect = np.column_stack(
                [
                    epoch,
                    cols["open"],
                    cols["high"],
                    cols["low"],
                    cols["close"],
                    cols["volume"],
                    cols["oi"],
                ]
            )
            got = np.array([[np.nan if v is None else v for v in r] for r in rows], dtype=float)
            same = expect.shape == got.shape and np.array_equal(expect, got, equal_nan=True)
            if not same:
                mismatched += 1
                if len(problems) < 10:
                    problems.append(f"{c.symbol}: raw {expect.shape} vs lake {got.shape}")
    finally:
        con.close()
    return {
        "contracts_compared": checked,
        "mismatched": mismatched,
        "not_imported_yet": skipped,
        "empty_responses_seen": empty_ok,
        "problems": problems,
    }


def coverage(root: Path, manifest: dict, name: str, out_csv: Path | None = None) -> dict:
    """Per-contract coverage written as CSV, and the per-root summary."""
    plans = [i for _n, i in plan_expiries(manifest, (name,))]
    stored: dict[str, tuple] = {}
    if _has_files(root, name):
        con = duckdb.connect()
        try:
            con.execute("SET TimeZone='Asia/Kolkata'")
            for sym, rows, days, first, last, with_oi in con.execute(
                f"""
                SELECT vendor_symbol, count(*),
                       count(DISTINCT CAST(ts AT TIME ZONE 'Asia/Kolkata' AS DATE)),
                       epoch(min(ts)), epoch(max(ts)), count(oi)
                FROM read_parquet('{_glob(root, name)}') GROUP BY vendor_symbol
                """
            ).fetchall():
                stored[sym] = (
                    rows,
                    days,
                    datetime.fromtimestamp(first, IST),
                    datetime.fromtimestamp(last, IST),
                    with_oi,
                )
        finally:
            con.close()
    lines = []
    state_counts = {
        "with_bars": 0,
        "empty": 0,
        "not_cached": 0,
        "refused": 0,
        "cached_not_imported": 0,
    }
    for item in plans:
        lo, hi = _window(item)
        for c in item.contracts:
            if c.symbol in stored:
                state = "with_bars"
            else:
                answer = _cached_answer(_cache_path(root, name, item.expiry, c.symbol), lo, hi)
                if answer is None:
                    state = "not_cached"
                elif answer[1] == "no_data":
                    state = "empty"
                elif answer[1] == "permanent":
                    state = "refused"
                else:  # ok in the cache, nothing in the lake
                    state = "empty" if not answer[0].get("candles") else "cached_not_imported"
            state_counts[state] += 1
            rows, days, first, last, with_oi = stored.get(c.symbol, (0, 0, None, None, 0))
            lines.append(
                [
                    name,
                    item.expiry,
                    c.strike,
                    c.option_type,
                    c.symbol,
                    state,
                    rows,
                    days,
                    first.isoformat() if first else "",
                    last.isoformat() if last else "",
                    round(with_oi / rows, 4) if rows else "",
                ]  # fmt: skip
            )
    if out_csv is not None:
        out_csv.parent.mkdir(parents=True, exist_ok=True)
        with out_csv.open("w", newline="") as fh:
            w = csv.writer(fh)
            w.writerow(
                [
                    "root",
                    "expiry",
                    "strike",
                    "side",
                    "symbol",
                    "state",
                    "rows",
                    "trading_days",
                    "first",
                    "last",
                    "oi_share",
                ]
            )
            w.writerows(lines)
    total_rows = sum(v[0] for v in stored.values())
    return {
        "requested": sum(len(i.contracts) for i in plans),
        **state_counts,
        "rows": total_rows,
        "trading_days": len(
            list(
                (root / "lake" / "bars_1m" / "asset=option" / f"underlying={name}").glob(
                    "date=*/data.parquet"
                )
            )
        ),
        "csv": str(out_csv) if out_csv else None,
    }


def day_verdicts(root: Path, name: str) -> dict:
    """data_quality for one root: verdict counts and every reason, from the lock-free snapshot."""
    excluded = lake_excluded(root, name)
    return {"excluded_days": len(excluded), "reasons": sorted(set(excluded.values()))}


def lake_excluded(root: Path, name: str) -> dict[date, str]:
    from trading_data import quality

    return quality.excluded_days(root, "option", name) or {}


def audit(root: Path, manifest: dict, names: tuple[str, ...], *, sample: int = 200) -> dict:
    """Everything above for each root.  `passed` is true when no minute repeats or is out of
    order, no price, volume or open interest is negative, no bar follows its contract's
    expiry, and the sample matched the raw cache exactly.  A bar that cannot be a bar
    (`impossible_ohlc`), one outside the session, and a missing open interest are the
    vendor's: counted and listed, not repaired, and not a failure."""
    out: dict = {"roots": {}}
    ok = True
    must_be_zero = [
        "duplicate_minutes",
        "impossible_ohlc",
        "negative_price",
        "negative_volume",
        "negative_oi",
        "out_of_order",
        "after_expiry",
    ]
    for name in names:
        inv = invariants(root, name)
        exact = sample_exact(root, manifest, name, sample)
        cov = coverage(
            root, manifest, name, root / "raw" / "fyers-expired" / "mcx" / f"coverage-{name}.csv"
        )
        verdicts = day_verdicts(root, name)
        out["roots"][name] = {
            "invariants": inv,
            "sample": exact,
            "coverage": cov,
            "quality": verdicts,
        }
        ok = ok and all(inv.get(k, 0) == 0 for k in must_be_zero) and exact["mismatched"] == 0
    out["passed"] = ok
    return out
