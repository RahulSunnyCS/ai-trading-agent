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
from . import daylog, history
from . import portfolio as pf_mod
from .history import BAND_LABEL
from .lists import LISTS
from .matrix import NAMED
from .readout import max_drawdown

KEYS = tuple(LISTS)
WINDOWS = ("P1", "P2", "last63", "forward")
LAST_N = 63
#: the smallest fall that counts as an episode, in rupees per lot below the running peak
DEFAULT_MIN_DEPTH = 500.0
MAX_MIN_DEPTH = 100_000.0
#: the unit the series is in: per lot-day (a list holds 6 lots, 8 with the Buy add-on)
BASE_LOTS = 6

KIND_LABEL = {"wide": "Widesl", "dir": "Dir", "buy": "Buy"}


class DrawdownError(Exception):
    def __init__(self, status: int, message: str) -> None:
        super().__init__(message)
        self.status = status


@dataclass
class Day:
    day: date
    source: str  # recorded | reconstructed
    per_lot: float
    #: the list's basket gross for the day (its real lots), for the basket column
    gross: float
    lots: int
    picks: list[dict] = field(default_factory=list)
    stops: int = 0


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


def _usable(r: dict, key: str) -> dict | None:
    """The list's scored block of a row that counts as a session, else None."""
    if not history.is_session(r):
        return None
    block = (r.get("lists") or {}).get(key)
    if block is None or not block["scored"] or block["per_lot_day"] is None:
        return None
    return block


def _days_of(rows: list[dict], key: str) -> list[Day]:
    """The scored, on-time days of one list from daylog rows, in date order."""
    kept: list[Day] = []
    for r in rows:
        block = _usable(r, key)
        if block is None:
            continue
        kept.append(
            Day(
                day=date.fromisoformat(r["day"]),
                source=r["source"],
                per_lot=float(block["per_lot_day"]),
                gross=float(block["gross"]),
                lots=int(block["lots"]),
                picks=block["picks"],
                stops=int(block["stops"]),
            )
        )
    kept.sort(key=lambda d: d.day)
    return kept


def _left_out(rows: list[dict], key: str, lo: date | None, hi: date | None) -> dict:
    """What the log had inside [lo, hi] that is not in the series, and why."""
    left = {"late": 0, "waiting": 0, "no_entry": 0}
    for r in rows:
        d = date.fromisoformat(r["day"])
        if (lo is not None and d < lo) or (hi is not None and d > hi):
            continue
        if _usable(r, key) is not None:
            continue
        if r["source"] == "missing":
            left["no_entry"] += 1
        elif r["source"] == "recorded" and r.get("status") == "late":
            left["late"] += 1
        else:
            left["waiting"] += 1
    return left


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


def _with_stop(
    root: Path,
    window_days: list[Day],
    series: list[dict],
    min_depth: float,
    portfolio: tuple[float | None, pf_mod.Trail | None],
) -> dict:
    """Replay each day's basket under the portfolio stop and add `per_lot_with`, `cum_with`,
    `underwater_with` and `stopped` to the series rows (in place). A day that cannot be replayed
    keeps its registered figure and is counted in `replay_errors`, never dropped or zeroed."""
    stop, trail = portfolio
    per_lot: list[float] = []
    stopped: list[bool] = []
    errors = 0
    for d in window_days:
        names = [p["name"] for p in d.picks]
        if not names or d.lots <= 0:
            per_lot.append(d.per_lot)
            stopped.append(False)
            errors += 1
            continue
        lots_each = d.lots // len(names)
        try:
            book = pf_mod.book_day(root, d.day, [(n, lots_each) for n in names], stop, trail, {})
        except pf_mod.PortfolioStopError:
            per_lot.append(d.per_lot)
            stopped.append(False)
            errors += 1
            continue
        per_lot.append(book.gross_with / d.lots)
        stopped.append(book.stop_minute is not None)
    arr = np.array(per_lot, dtype=float)
    cum = np.cumsum(arr) if arr.size else np.array([])
    under = cum - np.maximum.accumulate(np.maximum(cum, 0.0)) if arr.size else np.array([])
    for i, row in enumerate(series):
        row["per_lot_with"] = round(float(arr[i]), 2)
        row["cum_with"] = round(float(cum[i]), 2)
        row["underwater_with"] = round(float(under[i]), 2)
        row["stopped"] = stopped[i]
    every = episodes_of(arr, 0.01)
    return {
        "setting": {
            "amount": pf_mod.normalise_stop(stop),
            "trail": None if trail is None else trail.text(),
        },
        "max_dd": round(max_drawdown(arr), 2),
        "total_per_lot": round(float(arr.sum()), 2) if arr.size else 0.0,
        "total_per_lot_without": round(float(sum(d.per_lot for d in window_days)), 2),
        "days_stopped": int(sum(stopped)),
        "replay_errors": errors,
        "episodes": len([e for e in every if -e["depth"] >= min_depth]),
        "all_episodes": len(every),
        "current": (
            {"underwater": round(float(under[-1]), 2)} if arr.size and under[-1] < 0 else None
        ),
    }


def build(
    key: str,
    window: str = "P1",
    min_depth: float = DEFAULT_MIN_DEPTH,
    root: Path | None = None,
    portfolio: tuple[float | None, pf_mod.Trail | None] | None = None,
) -> dict:
    """`portfolio` is (stop in rupees, trailing) for BL-095: the same series is also run through
    the portfolio stop and returned under `with_stop` and per-point `*_with` fields, beside the
    registered figures, which are never replaced."""
    if key not in KEYS:
        raise DrawdownError(422, f"list must be one of {', '.join(KEYS)}")
    if window not in WINDOWS:
        raise DrawdownError(422, f"window must be one of {', '.join(WINDOWS)}")
    if not (0 <= min_depth <= MAX_MIN_DEPTH):
        raise DrawdownError(422, f"min_depth must be between 0 and {int(MAX_MIN_DEPTH)}")
    root = root or data_dir()
    try:
        log = history.daily_log(root, "recent" if window in ("last63", "forward") else window)
    except ValueError as error:  # the journal cannot be read
        raise DrawdownError(500, str(error)) from error
    window_days, window_info = _window(window, _days_of(log["rows"], key))
    if window in NAMED:
        left = _left_out(log["rows"], key, NAMED[window][0], NAMED[window][1])
    elif window_days:
        left = _left_out(
            log["rows"],
            key,
            daylog.REGISTERED_FIRST_DAY if window == "forward" else window_days[0].day,
            None,
        )
    else:
        left = {"late": 0, "waiting": 0, "no_entry": 0}

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

    every = episodes_of(daily, 0.01)
    shown = [e for e in every if -e["depth"] >= min_depth]
    episodes = []
    for n, e in enumerate(shown, 1):
        lo, hi = e["peak"] + 1, e["trough"]
        seg_base = base_days[lo : hi + 1]
        missing = sum(1 for v in seg_base if v is None)
        base_change = (
            None
            if not have_base or missing == len(seg_base)
            else round(sum(v for v in seg_base if v is not None), 2)
        )
        # the rupees the list's lots lost over the same days (6 lots, or 8 on a Buy day)
        basket = sum(d.gross for d in window_days[lo : hi + 1])
        episodes.append(
            {
                "n": n,
                "peak_day": window_days[e["peak"]].day.isoformat() if e["peak"] >= 0 else None,
                "trough_day": window_days[e["trough"]].day.isoformat(),
                "end_day": None if e["end"] is None else window_days[e["end"]].day.isoformat(),
                "open": e["end"] is None,
                "depth": round(e["depth"], 2),
                "depth_basket": round(basket, 2),
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
    with_stop = None
    if portfolio is not None and (pf_mod.normalise_stop(portfolio[0]) or portfolio[1]):
        with_stop = _with_stop(root, window_days, series, min_depth, portfolio)
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
        "all_episodes": len(every),
        "max_dd": round(max_drawdown(daily), 2),
        "base_max_dd": round(max_drawdown(base_daily), 2) if have_base else None,
        "base_days": sum(1 for v in base_days if v is not None),
        "current": current,
        "basis": "gross",
        "unit": "per_lot",
        "in_sample": window != "forward",
        "with_stop": with_stop,
    }
