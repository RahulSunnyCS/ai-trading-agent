"""The nightly step: run every variant's strategy file over one collected day and store the result.

Loads each index's day once and simulates every variant of that index (149 of the 298) on it. A
day is written only when BOTH indices can run it (the research dropped a day either index lacks,
so the history the ranking reads is the same here). A stored variant-day is never rewritten.
"""

from __future__ import annotations

from collections.abc import Callable
from datetime import date, timedelta
from pathlib import Path

from ..data.reference.loader import MissingReferenceData, default_reference_data
from ..fyers.daily import data_dir
from ..legwise.engine import simulate_day
from ..legwise.market import load_day
from ..legwise.schema import load_legwise
from . import store
from .attrs import UNDERLYINGS, day_attributes, excluded_map, is_collected
from .lists import SIZING_DATE
from .variants import strategy_path, underlying_of, variant_names


def default_day(
    root: Path | None = None, today: date | None = None, names: list[str] | None = None
) -> date | None:
    """The newest weekday in the last two weeks (today first) with both indices collected and not
    excluded whose variants are not all stored yet: what an unattended run should do. None when
    everything collected is stored."""
    root = root or data_dir()
    d = today or date.today()
    excluded = excluded_map(root)
    names = names or variant_names()
    for _ in range(14):
        if is_collected(root, d, excluded) and any(
            d not in store.result_days(n, root) for n in names
        ):
            return d
        d -= timedelta(days=1)
    return None


def backfill_days(names: list[str], root: Path | None = None) -> list[date]:
    """Every day Core-298 has stored where any of `names` has not: a parallel track's history is
    built over exactly the live history's days (so the two rank on the same rows)."""
    root = root or data_dir()
    core_days = store.load_matrix(variant_names(), root).days  # days every Core variant has
    have = [store.result_days(n, root) for n in names]
    return sorted(d for d in core_days if any(d not in h for h in have))


def update_day(
    day: date,
    root: Path | None = None,
    log: Callable[[str], None] = print,
    names: list[str] | None = None,
    write_days: bool = True,
) -> dict:
    """Returns {'written': n, 'already': n, 'skipped': reason|None, 'errors': [...]}."""
    root = root or data_dir()
    names = names or variant_names()
    out: dict = {"written": 0, "already": 0, "skipped": None, "errors": []}
    loaded = {}
    excluded = excluded_map(root)
    for u in UNDERLYINGS:
        if day in excluded[u]:
            out["skipped"] = f"{u} {day}: excluded by data_quality ({excluded[u][day]})"
            return out
        try:
            loaded[u] = load_day(root, u, day)
        except FileNotFoundError as error:
            out["skipped"] = f"{u} {day}: {error}"
            return out
    reference = default_reference_data()
    sizing = date.fromisoformat(SIZING_DATE)
    for name in names:
        if day in store.result_days(name, root):
            out["already"] += 1
            continue
        try:
            strategy = load_legwise(strategy_path(name))
            r = simulate_day(strategy, loaded[underlying_of(name)], reference, sizing)
        except MissingReferenceData as error:
            out["errors"].append(f"{name}: reference: {error}")
            continue
        store.append_result(
            name,
            {
                "day": day.isoformat(),
                "net": round(r.gross - r.costs, 2),
                "gross": round(r.gross, 2),
                "costs": round(r.costs, 2),
                "worst_mtm": round(r.worst_mtm, 2),
                "stopped_by": r.stopped_by or "",
                "n_trades": len(r.trades),
            },
            root,
        )
        out["written"] += 1
    if write_days and not out["errors"]:  # a parallel track never writes the live days.csv
        store.append_day(day_attributes(root, day), root)
    log(
        f"{day}: {out['written']} variants written, {out['already']} already there, "
        f"{len(out['errors'])} errors"
    )
    return out


def update_track(
    track: str,
    day: date | None = None,
    root: Path | None = None,
    log: Callable[[str], None] = print,
    err: Callable[[str], None] = print,
) -> tuple[int, int]:
    """Store a parallel track's extra variants (never the live results or days.csv): `day`, or
    every day Core-298 has stored that the track lacks, so a missed evening is filled the next
    time and never silently dropped. Returns (days tried, days that failed); (0, 0) when every
    Core-298 day is already stored. Shared by `obt rotation update --track` and the morning
    pick's catch-up."""
    from .variants import track_names

    names = track_names(track)
    days = [day] if day else backfill_days(names, root)
    failed = 0
    for d in days:
        r = update_day(d, root=root, names=names, log=log, write_days=False)
        if r["skipped"] or r["errors"]:
            failed += 1
            err(f"{track} {d}: {r['skipped'] or r['errors'][:3]}")
    return len(days), failed
