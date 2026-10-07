"""
Backfill the INDEX side of the lake — NIFTY (or any collected underlying) spot and
India VIX at 1 minute — as far back as Fyers serves it.

Why this is possible when option bars are not: an expired option contract vanishes
from Fyers, but an index never expires, so its history stays downloadable. This is
what lets the Options Lab's "day anatomy" study run over years while the option P&L
history is only as deep as the daily collector has been running.

Writes the same partitions `collect_day` writes (`bars_1m/asset=index/...`), so the
leg-wise engine and the anatomy loader read them unchanged. Resumable and idempotent:
a day whose file already exists is never rewritten (unless `force`), so re-running
only costs a couple of requests per 95-day chunk.
"""

from __future__ import annotations

from collections import defaultdict
from collections.abc import Callable
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

from trading_data import ingest, lake
from trading_data.db import connect
from trading_data.quality import MIN_BARS

from .client import Candle, FyersClient
from .daily import UNDERLYINGS, VIX_NAME, VIX_SYMBOL, bars_table, register_contracts

#: Fyers rejects 1-minute ranges over 100 calendar days; stay under it.
CHUNK_DAYS = 95
#: Stop after this many consecutive chunks with no spot data at all — we have walked
#: past the start of Fyers' history (or a very long outage).
EMPTY_CHUNKS_TO_STOP = 3
# A normal session has 375 bars (09:15-15:29). Fewer than MIN_BARS means a half day (the
# Diwali muhurat hour) or a partial download; the anatomy needs whole days, so skip them.
# The threshold is trading_data.quality.MIN_BARS: one definition, shared with data_quality.

_IST = timezone(timedelta(hours=5, minutes=30))


def chunk_ranges(start: date, end: date, size: int = CHUNK_DAYS) -> list[tuple[date, date]]:
    """[start, end] cut into <= `size`-day pieces, NEWEST FIRST (so an interrupted run
    keeps the most recent — most useful — history)."""
    out: list[tuple[date, date]] = []
    hi = end
    while hi >= start:
        lo = max(start, hi - timedelta(days=size - 1))
        out.append((lo, hi))
        hi = lo - timedelta(days=1)
    return out


def split_by_day(candles: list[Candle]) -> dict[date, list[Candle]]:
    by_day: dict[date, list[Candle]] = defaultdict(list)
    for c in candles:
        by_day[datetime.fromtimestamp(c.epoch, _IST).date()].append(c)
    return by_day


def backfill_index(
    client: FyersClient,
    root: Path,
    underlying: str,
    start: date | None = None,
    end: date | None = None,
    force: bool = False,
    log: Callable[[str], None] = print,
) -> dict:
    spec = UNDERLYINGS[underlying]
    end = end or date.today() - timedelta(days=1)  # today's session may still be open
    floor = start or date(2015, 1, 1)
    ids = register_contracts(root, [], [spec])
    series = [(spec.name, spec.index_symbol), (VIX_NAME, VIX_SYMBOL)]

    with connect(root, views=()) as con:
        run_id = ingest.start_run(con, "fyers", "bars_1m_index_history", None, underlying)
    calls_at_start = client.calls
    written = {name: 0 for name, _ in series}
    short_days: list[str] = []
    empty_streak = 0
    oldest: date | None = None
    try:
        for lo, hi in chunk_ranges(floor, end):
            got_spot = False
            for name, symbol in series:
                by_day = split_by_day(client.minute_candles_range(symbol, lo, hi))
                if name == spec.name and by_day:
                    got_spot = True
                for day, candles in sorted(by_day.items()):
                    path = lake.bars_1m_path(root, "index", name, day)
                    if path.exists() and not force:
                        continue
                    if len(candles) < MIN_BARS:
                        short_days.append(f"{name} {day} ({len(candles)} bars)")
                        continue
                    lake.write_parquet(bars_table(ids[symbol], symbol, candles), path)
                    written[name] += 1
                    if name == spec.name:
                        oldest = min(oldest, day) if oldest else day
            log(f"{lo} .. {hi}: spot days written so far {written[spec.name]}")
            empty_streak = 0 if got_spot else empty_streak + 1
            if empty_streak >= EMPTY_CHUNKS_TO_STOP:
                log(f"no data in {EMPTY_CHUNKS_TO_STOP} consecutive chunks — reached the start")
                break
    except Exception:
        with connect(root, views=()) as con:
            ingest.finish_run(
                con,
                run_id,
                requests=client.calls - calls_at_start,
                rows_written=sum(written.values()) * 375,
                errors=1,
                details={"written_days": written, "short_days": short_days},
                failed=True,
            )
        raise
    with connect(root, views=()) as con:
        ingest.finish_run(
            con,
            run_id,
            requests=client.calls - calls_at_start,
            rows_written=sum(written.values()) * 375,
            errors=len(short_days),
            details={
                "written_days": written,
                "short_days": short_days,
                "oldest_spot_day": str(oldest) if oldest else None,
            },
        )
    return {"written_days": written, "short_days": short_days, "oldest": oldest}
