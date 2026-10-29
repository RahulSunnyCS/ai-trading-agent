"""Adaptive's picks (list C) for Core or the T1 book, one list of strategy names per day (shared by
BL-156 and BL-186; moved here from `research/bl156/replay.py`).

From the book's first journal day the journal's recorded picks are used; before that, picks are
reconstructed day by day with `rotation.pick.score_history` from the stored results before each day,
without the BL-122 expiry rule (as reconstructed history always is). Each core pick plus any Buy
add-on is one name; every pick is traded at 1 lot in its own file.
"""

from __future__ import annotations

from datetime import date
from pathlib import Path

from option_backtesting.rotation import journal, store
from option_backtesting.rotation.lists import WARMUP
from option_backtesting.rotation.pick import History, score_history
from option_backtesting.rotation.variants import (
    STRATEGIES_DIR,
    TRACK_DIRS,
    track_names,
    track_of,
    variant_names,
)

JOURNAL_FROM = {"t1": date(2026, 10, 19), "core": date(2026, 10, 12)}


def strategy_path(name: str) -> Path:
    track = track_of(name)
    return (TRACK_DIRS[track] if track else STRATEGIES_DIR) / f"{name}.yaml"


def picks_for(
    book: str, root: Path, start: date, end: date, until: date | None = None
) -> dict[date, list[str]]:
    """{day: [names]} for every day in [start, end] (and <= until) after the 63-day warm-up."""
    names = variant_names() + (track_names("t1") if book == "t1" else [])
    m = store.load_matrix(names, root)
    attrs = store.read_days(root, "weekdays")
    keep = [i for i, d in enumerate(m.days) if d in attrs and (until is None or d <= until)]
    days = [m.days[i] for i in keep]
    values = m.values[keep]
    recorded = {
        date.fromisoformat(e["day"]): e["lists"]["C"]
        for e in journal.read(store.journal_path(root, "t1" if book == "t1" else None))
    }
    out = {}
    for i, d in enumerate(days):
        if not (start <= d <= end) or i < WARMUP:
            continue
        if d >= JOURNAL_FROM[book] and d in recorded:
            c = recorded[d]
        else:
            a = attrs[d]
            hist = History(
                days[:i],
                list(m.names),
                values[:i],
                [attrs[x]["weekday"] for x in days[:i]],
                [attrs[x]["vix_band"] for x in days[:i]],
                [attrs[x]["dte_n"] for x in days[:i]],
                [attrs[x]["dte_s"] for x in days[:i]],
                "",
            )
            vix = float(a["vix_open"]) if a.get("vix_open") not in (None, "") else None
            c = score_history(hist, d, vix, {"dte_n": a["dte_n"], "dte_s": a["dte_s"]})["C"]
        out[d] = list(c["core"]) + list(c.get("buy") or [])
    return out
