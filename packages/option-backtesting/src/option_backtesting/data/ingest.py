"""
Raw AlgoTest JSON -> quality-gated Parquet cache.

One Parquet file per (underlying, timeframe, data_kind, strike_rule, leg,
month) under `data/cache/`. Idempotent: re-ingesting a day/range merges with
whatever is already on disk, deduplicated by timestamp, so a partial re-run
never doubles rows.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date, datetime, time
from pathlib import Path
from typing import Any

import duckdb
import pyarrow as pa
import pyarrow.parquet as pq

from .providers.base import Bar, SessionFlag
from .quality import QualityFlag, bar_gaps, identical_series, zero_volume_regular_bars
from .raw import iter_raw_files, read_raw

DEFAULT_CACHE_DIR = Path(__file__).parent.parent.parent.parent / "data" / "cache"

MARKET_OPEN = time(9, 15)
MARKET_CLOSE = time(15, 30)


def session_flag_for(ts: datetime) -> SessionFlag:
    """PRE before 09:15, POST at/after 15:30 (the settlement-print candles
    the design handoff warns about), REGULAR in between."""
    t = ts.time()
    if t < MARKET_OPEN:
        return SessionFlag.PRE
    if t >= MARKET_CLOSE:
        return SessionFlag.POST
    return SessionFlag.REGULAR


def parse_ohlc_candles(candles: list[dict[str, Any]]) -> list[Bar]:
    bars = []
    for c in candles:
        ts = datetime.fromisoformat(c["datetime"])
        bars.append(
            Bar(
                ts=ts,
                open=float(c["open"]),
                high=float(c["high"]),
                low=float(c["low"]),
                close=float(c["close"]),
                volume=float(c["volume"]) if c.get("volume") is not None else None,
                session=session_flag_for(ts),
            )
        )
    return bars


@dataclass(frozen=True)
class GreeksRow:
    ts: datetime
    delta: float | None
    theta: float | None
    gamma: float | None
    vega: float | None
    rho: float | None
    implied_vol: float | None
    implied_fut: float | None
    session: SessionFlag


def parse_greeks_rows(rows: list[dict[str, Any]]) -> list[GreeksRow]:
    out = []
    for r in rows:
        ts = datetime.fromisoformat(r["datetime"])
        out.append(
            GreeksRow(
                ts=ts,
                delta=r.get("delta"),
                theta=r.get("theta"),
                gamma=r.get("gamma"),
                vega=r.get("vega"),
                rho=r.get("rho"),
                implied_vol=r.get("implied_vol"),
                implied_fut=r.get("implied_fut"),
                session=session_flag_for(ts),
            )
        )
    return out


def _bars_table(bars: list[Bar]) -> pa.Table:
    return pa.table(
        {
            "ts": [b.ts for b in bars],
            "open": [b.open for b in bars],
            "high": [b.high for b in bars],
            "low": [b.low for b in bars],
            "close": [b.close for b in bars],
            "volume": [b.volume for b in bars],
            "session": [b.session.value for b in bars],
        }
    )


def _greeks_table(rows: list[GreeksRow]) -> pa.Table:
    return pa.table(
        {
            "ts": [r.ts for r in rows],
            "delta": [r.delta for r in rows],
            "theta": [r.theta for r in rows],
            "gamma": [r.gamma for r in rows],
            "vega": [r.vega for r in rows],
            "rho": [r.rho for r in rows],
            "implied_vol": [r.implied_vol for r in rows],
            "implied_fut": [r.implied_fut for r in rows],
            "session": [r.session.value for r in rows],
        }
    )


def _merge_and_write(path: Path, new_table: pa.Table) -> int:
    """Write new_table to path, merged with any existing content there,
    deduplicated by ts (last write wins). Returns the row count written."""
    path.parent.mkdir(parents=True, exist_ok=True)
    con = duckdb.connect(":memory:")
    con.register("new_tbl", new_table)
    if path.exists():
        combined = con.execute(
            f"""
            SELECT * EXCLUDE (_rn, _source) FROM (
                SELECT *, row_number() OVER (PARTITION BY ts ORDER BY _source DESC) AS _rn
                FROM (
                    SELECT *, 0 AS _source FROM read_parquet('{path.as_posix()}')
                    UNION ALL BY NAME
                    SELECT *, 1 AS _source FROM new_tbl
                )
            )
            WHERE _rn = 1
            ORDER BY ts
            """
        ).to_arrow_table()
    else:
        combined = con.execute("SELECT * FROM new_tbl ORDER BY ts").to_arrow_table()
    pq.write_table(combined, path)
    con.close()
    return combined.num_rows


def _month_key(d: date) -> str:
    return f"{d.year:04d}-{d.month:02d}"


def _cache_path(
    cache_dir: Path,
    underlying: str,
    timeframe: str,
    data_kind: str,
    strike_rule: str | None,
    leg: str | None,
    month: str,
) -> Path:
    rule_part = strike_rule or "na"
    leg_part = leg or "na"
    return (
        cache_dir
        / underlying
        / timeframe
        / data_kind
        / f"{rule_part}_{leg_part}"
        / f"{month}.parquet"
    )


@dataclass
class IngestResult:
    files_written: list[Path] = field(default_factory=list)
    bars_written: int = 0
    flags: list[QualityFlag] = field(default_factory=list)


def ingest_raw_file(
    raw_path: Path,
    *,
    cache_dir: Path = DEFAULT_CACHE_DIR,
) -> IngestResult:
    """Ingest one raw manifest file (one request's full response) into
    Parquet, split by calendar month. Idempotent — safe to re-run."""
    manifest = read_raw(raw_path)
    request = manifest["request"]
    response = manifest["response"]
    rk_underlying = _underlying_from_path(raw_path, cache_dir_root_name="algotest")
    result = IngestResult()

    if "candles" in response:
        bars = parse_ohlc_candles(response["candles"])
        if not bars:
            return result
        by_month: dict[str, list[Bar]] = {}
        for b in bars:
            by_month.setdefault(_month_key(b.ts.date()), []).append(b)
        result.flags.extend(bar_gaps(bars, _expected_interval(request["timeframe"])))
        result.flags.extend(zero_volume_regular_bars(bars))
        for month, month_bars in by_month.items():
            path = _cache_path(
                cache_dir,
                rk_underlying["underlying"],
                request["timeframe"],
                rk_underlying["data_kind"],
                rk_underlying["strike_rule"],
                rk_underlying["leg"],
                month,
            )
            _merge_and_write(path, _bars_table(month_bars))
            result.files_written.append(path)
            result.bars_written += len(month_bars)
    elif "rows" in response:
        rows = parse_greeks_rows(response["rows"])
        if not rows:
            return result
        by_month: dict[str, list[GreeksRow]] = {}
        for r in rows:
            by_month.setdefault(_month_key(r.ts.date()), []).append(r)
        for month, month_rows in by_month.items():
            path = _cache_path(
                cache_dir,
                rk_underlying["underlying"],
                request["timeframe"],
                rk_underlying["data_kind"],
                rk_underlying["strike_rule"],
                rk_underlying["leg"],
                month,
            )
            _merge_and_write(path, _greeks_table(month_rows))
            result.files_written.append(path)
            result.bars_written += len(month_rows)
    else:
        raise ValueError(f"Unrecognised AlgoTest response shape in {raw_path}: {list(response)}")

    return result


def _expected_interval(timeframe: str):
    from datetime import timedelta

    unit = timeframe[-1]
    n = int(timeframe[:-1])
    if unit == "m":
        return timedelta(minutes=n)
    if unit == "h":
        return timedelta(hours=n)
    if unit == "d":
        return timedelta(days=n)
    raise ValueError(f"Unrecognised timeframe: {timeframe!r}")


def _underlying_from_path(raw_path: Path, *, cache_dir_root_name: str) -> dict[str, str | None]:
    """Recover (underlying, timeframe, data_kind, strike_rule, leg) from a raw
    file's path, since raw.py encodes them positionally rather than in the
    manifest body. Path shape:
    .../algotest/{underlying}/{timeframe}/{data_kind}/{rule}_{leg}__{range}.json
    """
    parts = raw_path.parts
    idx = parts.index(cache_dir_root_name)
    underlying, timeframe, data_kind = parts[idx + 1], parts[idx + 2], parts[idx + 3]
    stem = raw_path.stem  # "{rule}_{leg}__{start}_{end}"
    rule_leg = stem.split("__", 1)[0]
    rule, leg = rule_leg.rsplit("_", 1)
    return {
        "underlying": underlying,
        "timeframe": timeframe,
        "data_kind": data_kind,
        "strike_rule": None if rule == "na" else rule,
        "leg": None if leg == "na" else leg,
    }


def ingest_date(
    underlying: str,
    day: date,
    *,
    raw_dir: Path,
    cache_dir: Path = DEFAULT_CACHE_DIR,
) -> IngestResult:
    """Ingest every raw file for `underlying` whose range covers `day`.
    Convenience wrapper around ingest_raw_file for the CLI's `obt ingest
    --date D` entry point."""
    combined = IngestResult()
    for raw_path in iter_raw_files(raw_dir, underlying):
        manifest = read_raw(raw_path)
        start = date.fromisoformat(manifest["request"]["start_date"])
        end = date.fromisoformat(manifest["request"]["end_date"])
        if not (start <= day <= end):
            continue
        r = ingest_raw_file(raw_path, cache_dir=cache_dir)
        combined.files_written.extend(r.files_written)
        combined.bars_written += r.bars_written
        combined.flags.extend(r.flags)

    combined.flags.extend(_cross_series_flags(underlying, day, cache_dir=cache_dir))
    return combined


def _cross_series_flags(underlying: str, day: date, *, cache_dir: Path) -> list[QualityFlag]:
    """The identical-series gate needs two series at once — run it here,
    across every strike-rule pair actually present for this underlying/day,
    once both are on disk."""
    from .cache import Cache

    cache = Cache(cache_dir)
    flags: list[QualityFlag] = []
    for timeframe in ("5m", "15m"):
        series: dict[tuple[str, str], list[Bar]] = {}
        for rule in ("ITM2", "ITM1", "ATM", "OTM1", "OTM2"):
            for leg in ("CE", "PE"):
                bars = cache.get_opt_bars(underlying, timeframe, rule, leg, day, day)
                if bars:
                    series[(rule, leg)] = bars
        keys = list(series)
        for i, key_a in enumerate(keys):
            for key_b in keys[i + 1 :]:
                if key_a[1] != key_b[1]:  # only compare same-leg series
                    continue
                flags.extend(
                    identical_series(
                        f"{underlying} {key_a[0]} {key_a[1]} {timeframe}",
                        series[key_a],
                        f"{underlying} {key_b[0]} {key_b[1]} {timeframe}",
                        series[key_b],
                    )
                )
    return flags
