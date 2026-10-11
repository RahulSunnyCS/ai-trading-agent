"""
Which source each collected day came from, and what it is missing (BL-079).

The evening run collects from Fyers when its token works and from Angel One otherwise. A day that
came from Angel One has known gaps (index minutes 15:15-15:28, no OI on SENSEX, minutes with no
trade carried forward); these helpers read that back from `ingest_runs` and turn it into the lines
the Telegram summary, the log and the dashboard banner show. A later Fyers login repairs such a
day (`evening.repair_from_fyers`).
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from datetime import date, timedelta
from pathlib import Path

from trading_data.db import connect

SOURCE_LABEL = {"fyers": "Fyers", "angelone": "Angel One"}


@dataclass(frozen=True)
class DaySource:
    day: date
    source: str
    flags: dict = field(default_factory=dict)
    kept_existing: int = 0  # contracts a repair could not refresh (they had expired)
    run_id: str = ""


def day_sources(root: Path, since: date, until: date) -> dict[date, DaySource]:
    """The source of each day's data in [since, until]: the latest run that wrote bars for it.
    Runs that wrote nothing (a retry that found everything collected) do not count."""
    with connect(root, read_only=True, views=()) as con:
        rows = con.execute(
            "SELECT trading_day, source, details, run_id FROM ingest_runs "
            "WHERE dataset = 'bars_1m' AND source IN ('fyers', 'angelone') "
            "AND status IN ('ok', 'partial') AND coalesce(rows_written, 0) > 0 "
            "AND trading_day BETWEEN ? AND ? ORDER BY started_at",
            [since, until],
        ).fetchall()
    out: dict[date, DaySource] = {}
    for trading_day, source, details, run_id in rows:
        parsed = json.loads(details) if isinstance(details, str) and details else (details or {})
        repair = parsed.get("repair") or {}
        out[trading_day] = DaySource(
            day=trading_day,
            source=source,
            flags=parsed.get("flags") or {},
            kept_existing=int(repair.get("kept_existing_contracts", 0) or 0),
            run_id=run_id,
        )
    return out


def recent_angel_days(root: Path, until: date, window_days: int = 7) -> list[date]:
    sources = day_sources(root, until - timedelta(days=window_days), until)
    return sorted(d for d, s in sources.items() if s.source == "angelone")


def describe(flags: dict) -> list[str]:
    """One line per underlying that has something missing, from a run's `details.flags`."""
    lines: list[str] = []
    for name, f in sorted(flags.items()):
        if name == "INDIAVIX" or not isinstance(f, dict):
            continue
        parts: list[str] = []
        if f.get("index_missing_minutes"):
            parts.append(f"index minutes 15:15-15:28 missing ({f['index_missing_minutes']})")
        if f.get("oi_unavailable"):
            parts.append("no open interest (Angel One does not serve it for these contracts)")
        if f.get("thin_contracts"):
            parts.append(
                f"{f['thin_contracts']} thin contract(s) carried forward through "
                f"{f.get('minutes_filled', 0):,} no-trade minutes"
            )
        if f.get("unmapped"):
            parts.append(f"{f['unmapped']} contract(s) not on Angel One")
        if f.get("oi_failed"):
            parts.append(f"OI failed for {f['oi_failed']} contract(s)")
        if parts:
            lines.append(f"{name}: " + "; ".join(parts))
    return lines


def banner_lines(day: DaySource) -> list[str]:
    """What the summary and the dashboard banner say about one day that came from Angel One."""
    return [
        f"{day.day:%a %d %b}: data came from Angel One (no Fyers login).",
        *(f"  {line}" for line in describe(day.flags)),
        "  Log in to Fyers: contracts still listed are re-collected from it on the next run.",
    ]
