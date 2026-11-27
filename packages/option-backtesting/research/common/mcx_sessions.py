"""The sessions an MCX expiry-week study runs, and each day's close (as BL-218 defines them)."""

from __future__ import annotations

from datetime import date
from pathlib import Path

import pyarrow.parquet as pq
from trading_data import lake

from option_backtesting.fyers.mcx import load_manifest

_IST_OFFSET_S = 5 * 3600 + 1800


def schedule(
    root_dir: Path, root: str, halves: dict[str, tuple[date, date]], weeks: dict[str, range]
) -> list[dict]:
    """The last 10 sessions up to each option expiry inside `halves` (expiry day included), with
    its expiry, k (sessions before expiry), week and half. A session is a day the lake holds an
    option file for the root, quality exclusions included, so that they are counted."""
    sessions = lake.available_days(root_dir, "option", root)
    manifest = load_manifest(root_dir)
    out = []
    for e in sorted(date.fromisoformat(x) for x in manifest["roots"][root]["expiries"]):
        half = next((name for name, (a, b) in halves.items() if a <= e <= b), None)
        if half is None:
            continue
        upto = [d for d in sessions if d <= e]
        if len(upto) < 10:
            continue  # the history starts inside this expiry's two weeks
        for k, d in enumerate(reversed(upto[-10:])):
            week = next(w for w, ks in weeks.items() if k in ks)
            out.append({"day": d, "expiry": e, "k": k, "week": week, "half": half})
    return out


def season(root_dir: Path, root: str, day: date) -> str:
    """winter when the day's futures trade past 23:30 (the 23:55 close), else summer. The close
    is published in advance (it follows US daylight saving), so this is no look-ahead."""
    path = lake.bars_1m_path(root_dir, "future", root, day)
    if not path.exists():
        return "summer"
    ts = pq.read_table(path, columns=["ts"]).column("ts").cast("int64").to_numpy()
    if not len(ts):
        return "summer"
    unit = 10 ** (len(str(int(ts.max()))) - 10)  # the file's ticks per second
    last = int((ts.max() // unit + _IST_OFFSET_S) % 86400 // 60)
    return "winter" if last >= 23 * 60 + 30 else "summer"
