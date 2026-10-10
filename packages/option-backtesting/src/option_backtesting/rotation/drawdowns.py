"""Drawdown episodes: each time a list fell, how deep, for how long, how fast it came back, and
what it was holding (BL-058 Phase 4, widget 8). Read-only over the journal, the stored results and
the fixed base's files.

The series is the list's gross per lot-day (a list holds 2 lots in each of 3 strategies, 4 with
the Buy add-on, so totals would reward holding more; per lot is the unit the read-out compares
lists and the base in). Days come from `daylog.build_log`: the journal's recorded entries, and for
days before the journal began the same re-scoring the 09:16 job uses, each labelled.

* **Underwater** is the cumulative series minus its running peak, the peak starting at zero (the
  research's drawdown, `readout.max_drawdown`).
* **An episode** runs from the day after a peak to the day the series is back at it, or to the
  last day if it never got back ("open"). Only episodes at least `min_depth` per lot deep are
  listed (default 500; the owner can read the whole list with a smaller value).
* **Drivers** split an episode's peak-to-trough loss by family x start band: each pick's one-lot
  gross on those days, divided by the number of picks that day (which is exactly what per lot-day
  means), summed. A description of what was held, not a cause: the same picks also made money
  elsewhere.
* **The base over the same days** is the fixed base's per-lot P&L on the same peak-to-trough days;
  a day the base has no result for is counted and said, never zero.
* **Missing is never zero.** A day whose picks are not all scored, a late entry and a day with no
  entry are left out of the series (and counted), so they neither extend nor end an episode.

Nothing here writes a file.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date
from pathlib import Path

import numpy as np

from ..fyers.daily import data_dir
from . import base as base_mod
from . import daylog
from .lists import LISTS
from .matrix import NAMED

KEYS = tuple(LISTS)
WINDOWS = ("P1", "P2", "last63", "forward")
LAST_N = 63
#: the smallest fall that counts as an episode, in rupees per lot below the running peak
DEFAULT_MIN_DEPTH = 500.0
MAX_MIN_DEPTH = 100_000.0
#: the unit the series is in: per lot-day (a list holds 6 lots, 8 with the Buy add-on)
BASE_LOTS = 6

KIND_LABEL = {"wide": "Widesl", "dir": "Dir", "buy": "Buy"}
BAND_LABEL = {
    "A": "09:17–10:02",
    "B": "10:17–12:02",
    "C": "12:17–14:02",
    "D": "14:17–15:17",
}


class DrawdownError(Exception):
    def __init__(self, status: int, message: str) -> None:
        super().__init__(message)
        self.status = status


@dataclass
class Day:
    day: date
    source: str  # recorded | reconstructed
    per_lot: float
    lots: int
    picks: list[dict] = field(default_factory=list)
    stops: int = 0


def max_drawdown(daily: np.ndarray) -> float:
    """Largest fall of the cumulative series from its running peak, the peak starting at zero."""
    if daily.size == 0:
        return 0.0
    cum = np.cumsum(daily)
    peak = np.maximum.accumulate(np.maximum(cum, 0.0))
    return float(np.min(cum - peak).clip(max=0.0))


def episodes_of(daily: np.ndarray, min_depth: float) -> list[dict]:
    """Drawdown episodes of a per-day series, in order. Indexes refer to `daily`:

    peak    the index of the last day at the running peak before the fall (-1 = the series start)
    trough  the index of the deepest underwater day
    end     the first index back at the peak, or None while the episode is still open
    """
    cum = np.cumsum(daily)
    peak_value = np.maximum.accumulate(np.maximum(cum, 0.0))
    under = cum - peak_value
    out: list[dict] = []
    n = len(daily)
    i = 0
    while i < n:
        if under[i] >= 0:
            i += 1
            continue
        start = i
        while i < n and under[i] < 0:
            i += 1
        end = i if i < n else None  # i is the first day back at the peak
        seg = under[start:i]
        trough = start + int(np.argmin(seg))
        depth = float(under[trough])
        if -depth >= min_depth:
            out.append(
                {
                    "peak": start - 1,
                    "trough": trough,
                    "end": end,
                    "depth": depth,
                    "sessions_down": trough - (start - 1),
                    "sessions_back": None if end is None else end - trough,
                }
            )
    return out


def _days_of(rows: list[dict], key: str) -> tuple[list[Day], dict]:
    """The scored, on-time days of one list from daylog rows, and a count of what was left out."""
    kept: list[Day] = []
    left = {"late": 0, "waiting": 0, "no_entry": 0}
    for r in rows:
        if r["source"] == "missing":
            left["no_entry"] += 1
            continue
        if r["source"] == "recorded" and r.get("status") == "late":
            left["late"] += 1
            continue
        block = (r.get("lists") or {}).get(key)
        if block is None or not block["scored"] or block["per_lot_day"] is None:
            left["waiting"] += 1
            continue
        kept.append(
            Day(
                day=date.fromisoformat(r["day"]),
                source=r["source"],
                per_lot=float(block["per_lot_day"]),
                lots=int(block["lots"]),
                picks=block["picks"],
                stops=int(block["stops"]),
            )
        )
    kept.sort(key=lambda d: d.day)
    return kept, left


def _window(window: str, days: list[Day]) -> tuple[list[Day], dict]:
    if window in NAMED:
        lo, hi, label = NAMED[window]
        return [d for d in days if lo <= d.day <= hi], {"id": window, "label": label}
    if window == "last63":
        return days[-LAST_N:], {"id": "last63", "label": f"Last {LAST_N} scored sessions"}
    return [d for d in days if d.source == "recorded"], {
        "id": "forward",
        "label": "Forward · recorded days",
    }


def _drivers(window_days: list[Day], lo: int, hi: int) -> list[dict]:
    """Loss by family x start band over days[lo..hi], per lot, worst first."""
    totals: dict[tuple[str, str], list] = {}
    for d in window_days[lo : hi + 1]:
        n = len(d.picks)
        if n == 0:
            continue
        for p in d.picks:
            res = p.get("result")
            if not res or p.get("kind") is None or p.get("band") is None:
                continue
            slot = totals.setdefault((p["kind"], p["band"]), [0.0, 0])
            slot[0] += float(res["gross"]) / n
            slot[1] += 1
    rows = [
        {
            "kind": k,
            "band": b,
            "label": f"{KIND_LABEL.get(k, k)} · {BAND_LABEL.get(b, b)}",
            "total": round(t, 2),
            "pick_days": c,
        }
        for (k, b), (t, c) in totals.items()
    ]
    rows.sort(key=lambda r: (r["total"], r["label"]))
    return rows


def build(
    key: str,
    window: str = "P1",
    min_depth: float = DEFAULT_MIN_DEPTH,
    root: Path | None = None,
) -> dict:
    if key not in KEYS:
        raise DrawdownError(422, f"list must be one of {', '.join(KEYS)}")
    if window not in WINDOWS:
        raise DrawdownError(422, f"window must be one of {', '.join(WINDOWS)}")
    if not (0 <= min_depth <= MAX_MIN_DEPTH):
        raise DrawdownError(422, f"min_depth must be between 0 and {int(MAX_MIN_DEPTH)}")
    root = root or data_dir()
    start = NAMED["P1"][0] if window in ("last63", "forward") else NAMED[window][0]
    end = NAMED[window][1] if window in NAMED else None
    try:
        log = daylog.build_log(root, start=start, end=end, source="all")
    except ValueError as error:  # the journal cannot be read
        raise DrawdownError(500, str(error)) from error
    days, left = _days_of(log["rows"], key)
    window_days, window_info = _window(window, days)

    daily = np.array([d.per_lot for d in window_days], dtype=float)
    base_per_lot = base_mod.base_per_lot(root)
    base_days = [base_per_lot.get(d.day) for d in window_days]
    base_daily = np.array([0.0 if v is None else v for v in base_days], dtype=float)
    have_base = any(v is not None for v in base_days)

    cum = np.cumsum(daily) if daily.size else np.array([])
    under = cum - np.maximum.accumulate(np.maximum(cum, 0.0)) if daily.size else np.array([])
    base_cum = np.cumsum(base_daily) if have_base else None
    base_under = (
        base_cum - np.maximum.accumulate(np.maximum(base_cum, 0.0))
        if base_cum is not None
        else None
    )

    episodes = []
    for n, e in enumerate(episodes_of(daily, min_depth), 1):
        lo, hi = e["peak"] + 1, e["trough"]
        seg_base = base_days[lo : hi + 1]
        missing = sum(1 for v in seg_base if v is None)
        base_change = (
            None
            if not have_base or missing == len(seg_base)
            else round(sum(v for v in seg_base if v is not None), 2)
        )
        lots = max((d.lots for d in window_days[lo : hi + 1]), default=0)
        episodes.append(
            {
                "n": n,
                "peak_day": window_days[e["peak"]].day.isoformat() if e["peak"] >= 0 else None,
                "trough_day": window_days[e["trough"]].day.isoformat(),
                "end_day": None if e["end"] is None else window_days[e["end"]].day.isoformat(),
                "open": e["end"] is None,
                "depth": round(e["depth"], 2),
                "depth_basket": round(e["depth"] * lots, 2) if lots else None,
                "sessions_down": e["sessions_down"],
                "sessions_back": e["sessions_back"],
                "base_change": base_change,
                "base_missing": missing,
                "stops": sum(d.stops for d in window_days[lo : hi + 1]),
                "drivers": _drivers(window_days, lo, hi),
            }
        )

    series = [
        {
            "day": d.day.isoformat(),
            "source": d.source,
            "per_lot": round(d.per_lot, 2),
            "cum": round(float(cum[i]), 2),
            "underwater": round(float(under[i]), 2),
            "base_per_lot": None if base_days[i] is None else round(base_days[i], 2),
            "base_underwater": (
                None
                if base_days[i] is None or base_under is None
                else round(float(base_under[i]), 2)
            ),
        }
        for i, d in enumerate(window_days)
    ]
    current = None
    if series and under[-1] < 0:
        peak_i = int(np.max(np.nonzero(under >= 0)[0])) if np.any(under >= 0) else -1
        current = {
            "underwater": round(float(under[-1]), 2),
            "since": window_days[peak_i].day.isoformat() if peak_i >= 0 else None,
            "sessions": len(window_days) - 1 - peak_i,
        }
    lot_counts = sorted({d.lots for d in window_days})
    return {
        "list": key,
        "window": {
            **window_info,
            "from": window_days[0].day.isoformat() if window_days else None,
            "to": window_days[-1].day.isoformat() if window_days else None,
        },
        "min_depth": min_depth,
        "n_days": len(window_days),
        "recorded_days": sum(1 for d in window_days if d.source == "recorded"),
        "reconstructed_days": sum(1 for d in window_days if d.source == "reconstructed"),
        "left_out": left,
        "lots": lot_counts,
        "base_lots": BASE_LOTS,
        "series": series,
        "episodes": episodes,
        "all_episodes": len(episodes_of(daily, 0.01)),
        "max_dd": round(max_drawdown(daily), 2),
        "base_max_dd": round(max_drawdown(base_daily), 2) if have_base else None,
        "base_days": sum(1 for v in base_days if v is not None),
        "current": current,
        "basis": "gross",
        "unit": "per_lot",
        "in_sample": window != "forward",
    }
