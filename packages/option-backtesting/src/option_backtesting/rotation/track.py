"""A parallel track's forward read-out: its list against the live list on the same forward days.

T1 (owner, 2026-10-16): Core-298 plus the BL-104 time-generic settings; Adaptive only, recorded in
its own journal (`rotation/track_t1/journal.jsonl`) before 09:17 like the live list, never traded.
The registered read-out (60 forward days, BL-058 style): the track's Adaptive minus the live
Adaptive, ₹ per lot-day (the mean of the picks' one-lot gross), a two-sided 90% interval from the
same circular 5-day block bootstrap as `readout`, and the pass rule: the interval's lower bound
above zero AND the track's max drawdown per lot no worse than the live list's. Read-only.
"""

from __future__ import annotations

from datetime import date
from pathlib import Path

import numpy as np

from ..fyers.daily import data_dir
from . import base as base_mod
from . import journal, store
from .readout import READOUT_DAYS, block_bootstrap_mean, max_drawdown

LIST_KEY = "C"  # Adaptive


def _per_lot_day(entry: dict, root: Path, cache: dict[str, dict[date, float]]) -> float | None:
    """Mean one-lot gross of the entry's Adaptive picks, or None while any pick is unscored."""
    picks = entry["lists"][LIST_KEY]["core"] + entry["lists"][LIST_KEY]["buy"]
    day = date.fromisoformat(entry["day"])
    values = []
    for name in picks:
        if name not in cache:
            cache[name] = base_mod.read_column(store.result_path(name, root), "gross")
        if day not in cache[name]:
            return None
        values.append(cache[name][day])
    return float(np.mean(values))


def build(track: str, root: Path | None = None) -> dict:
    """{days, track, live, diff, ...} over the forward days both journals hold (each recorded
    before 09:17) whose picks are all scored."""
    root = root or data_dir()
    live = {
        e["day"]: e for e in journal.read(store.journal_path(root)) if e.get("before_first_entry")
    }
    tracked = {
        e["day"]: e
        for e in journal.read(store.journal_path(root, track))
        if e.get("before_first_entry")
    }
    cache: dict[str, dict[date, float]] = {}
    days, s_vals, l_vals, pending = [], [], [], []
    for day in sorted(set(live) & set(tracked)):
        s = _per_lot_day(tracked[day], root, cache)
        lv = _per_lot_day(live[day], root, cache)
        if s is None or lv is None:
            pending.append(day)
            continue
        days.append(day)
        s_vals.append(s)
        l_vals.append(lv)
    s_arr, l_arr = np.array(s_vals), np.array(l_vals)
    out: dict = {
        "track": track,
        "days": days,
        "pending": pending,
        "track_only": sorted(set(tracked) - set(live)),
        "n": len(days),
        "judged_at": READOUT_DAYS,
    }
    if len(days):
        diff = s_arr - l_arr
        mean, lo, hi = (
            block_bootstrap_mean(diff)
            if len(days) > 1
            else (float(diff[0]), float("nan"), float("nan"))
        )
        out.update(
            track_per_lot_day=float(s_arr.mean()),
            live_per_lot_day=float(l_arr.mean()),
            track_max_dd=max_drawdown(s_arr),
            live_max_dd=max_drawdown(l_arr),
            diff=mean,
            lo90=lo,
            hi90=hi,
            passes=bool(
                len(days) >= READOUT_DAYS and lo > 0 and max_drawdown(s_arr) >= max_drawdown(l_arr)
            ),
        )
    return out


def render(r: dict) -> str:
    u = r["track"].upper()
    if not r["n"]:
        return (
            f"SHADOW {u}: no forward day with both entries scored yet (pending {len(r['pending'])})"
        )
    status = (
        f"judged at {r['judged_at']} days: {'PASS' if r['passes'] else 'no pass'}"
        if r["n"] >= r["judged_at"]
        else f"{r['n']} of {r['judged_at']} forward days (not judged yet)"
    )
    return "\n".join(
        [
            f"{u} TRACK vs live Adaptive, {r['days'][0]} -> {r['days'][-1]}: {status}",
            f"  {u} Adaptive   ₹{r['track_per_lot_day']:,.0f} per lot-day   "
            f"max drawdown ₹{r['track_max_dd']:,.0f}",
            f"  live Adaptive  ₹{r['live_per_lot_day']:,.0f} per lot-day   "
            f"max drawdown ₹{r['live_max_dd']:,.0f}",
            f"  {u} minus live  {r['diff']:+,.0f} per lot-day, "
            f"90% interval [{r['lo90']:+,.0f}, {r['hi90']:+,.0f}]",
        ]
        + ([f"  awaiting results: {', '.join(r['pending'])}"] if r["pending"] else [])
    )
