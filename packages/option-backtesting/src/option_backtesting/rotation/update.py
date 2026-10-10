"""The nightly step: run every variant's strategy file over one collected day and store the result.

Loads each index's day once and simulates the 124 variants of that index on it. A day is
written only when BOTH indices can run it (the research dropped a day either index lacks,
so the history the ranking reads is the same here). A stored variant-day is never rewritten.
"""

from __future__ import annotations

from collections.abc import Callable
from datetime import date
from pathlib import Path

from trading_data import quality

from ..data.reference.loader import MissingReferenceData, default_reference_data
from ..fyers.daily import data_dir
from ..legwise.engine import simulate_day
from ..legwise.market import load_day
from ..legwise.schema import load_legwise
from . import store
from .attrs import day_attributes
from .lists import SIZING_DATE
from .variants import strategy_path, underlying_of, variant_names

UNDERLYINGS = ("NIFTY", "SENSEX")


def update_day(
    day: date,
    root: Path | None = None,
    log: Callable[[str], None] = print,
    names: list[str] | None = None,
) -> dict:
    """Returns {'written': n, 'already': n, 'skipped': reason|None, 'errors': [...]}."""
    root = root or data_dir()
    names = names or variant_names()
    out: dict = {"written": 0, "already": 0, "skipped": None, "errors": []}
    loaded = {}
    for u in UNDERLYINGS:
        excluded = quality.excluded_days(root, "option", u) or {}
        if day in excluded:
            out["skipped"] = f"{u} {day}: excluded by data_quality ({excluded[day]})"
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
    if not out["errors"]:
        store.append_day(day_attributes(root, day), root)
    log(
        f"{day}: {out['written']} variants written, {out['already']} already there, "
        f"{len(out['errors'])} errors"
    )
    return out
