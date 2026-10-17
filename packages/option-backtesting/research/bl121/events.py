"""BL-121: list the holiday-shifted weekly expiries (dates only, no P&L) for NIFTY and SENSEX.

An expiry E of an index is *moved* when its weekday is earlier in the week than the index's regular
weekday (the most common weekday of the 8 expiries before and the 8 after) AND the regular date of
that week was not a full trading session (no 1-minute index bars, or only a short Muhurat session). The second test drops regime changes
(a new regular weekday), which look like a move but are not. A *normal expiry day* is an expiry
that falls on the regular weekday. Expiry dates come from the option files themselves (the nearest
weekly expiry of each day), so they cover 2022 onwards, not only the reference calendar.

    TRADING_DATA_ROOT=/Volumes/TradingData uv run python research/bl121/events.py
"""

from __future__ import annotations

import collections
import json
from datetime import date, timedelta
from pathlib import Path

import duckdb
from trading_data import lake

from option_backtesting.fyers.daily import data_dir

OUT = Path(__file__).parent
START, END = date(2022, 1, 3), date(2026, 10, 19)
NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri"]


def main() -> None:
    root = data_dir()
    con = duckdb.connect()

    def has_bars(index: str, d: date) -> bool:
        """A full trading session: a Muhurat session (about an hour) does not count as one."""
        path = lake.bars_1m_path(root, "index", index, d)
        if not path.exists():
            return False
        n = con.execute("SELECT count(*) FROM read_parquet(?)", [str(path)]).fetchone()[0]
        return n >= 300

    report: dict = {"defined": "see the module docstring", "indices": {}}
    for index in ("NIFTY", "SENSEX"):
        expiries: set[date] = set()
        d = START
        while d <= END:
            path = lake.bars_1m_path(root, "option", index, d)
            if d.weekday() < 5 and path.exists():
                row = con.execute(
                    "SELECT min(expiry)::VARCHAR FROM read_parquet(?) "
                    "WHERE expiry >= CAST(? AS DATE)",
                    [str(path), d.isoformat()],
                ).fetchone()
                if row and row[0]:
                    expiries.add(date.fromisoformat(row[0]))
            d += timedelta(days=1)
        ordered = sorted(expiries)
        moved, normal, artefacts = [], [], []
        for i, e in enumerate(ordered):
            neighbours = ordered[max(0, i - 8) : i] + ordered[i + 1 : i + 9]
            if len(neighbours) < 6:
                continue
            regular = collections.Counter(x.weekday() for x in neighbours).most_common(1)[0][0]
            if e.weekday() == regular:
                normal.append(e.isoformat())
            elif e.weekday() < regular:
                regular_date = e + timedelta(days=regular - e.weekday())
                if not has_bars(index, regular_date):
                    moved.append(
                        {
                            "expiry": e.isoformat(),
                            "weekday": NAMES[e.weekday()],
                            "regular_weekday": NAMES[regular],
                            "regular_date": regular_date.isoformat(),
                        }
                    )
                else:
                    artefacts.append(e.isoformat())  # a regime change, not a holiday move
        report["indices"][index] = {
            "expiries": len(ordered),
            "moved": moved,
            "normal_expiry_days": normal,
            "dropped_regime_changes": artefacts,
        }
    (OUT / "events_2026-10-18.json").write_text(json.dumps(report, indent=1) + "\n")
    for index, v in report["indices"].items():
        print(
            index,
            "expiries",
            v["expiries"],
            "| moved",
            len(v["moved"]),
            "| normal",
            len(v["normal_expiry_days"]),
            "| dropped",
            v["dropped_regime_changes"],
        )
        print("  moved:", ", ".join(m["expiry"] for m in v["moved"]))


if __name__ == "__main__":
    main()
