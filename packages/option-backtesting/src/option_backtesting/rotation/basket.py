"""A day's basket, correlated: the Correlation tab's "Today's basket" preset (BL-058 Phase 4,
widget 6). Read-only over the journal, the stored results and the fixed base's files.

One list's picks for one day (or the owner's fixed base) become a set of strategies, and the same
code that backs the Correlation tab (`analytics/correlation.py`, the maths behind
`obt rotation corr`) says how alike they are over a window, how often they lose together, and what
the basket draws down against its parts. Nothing is computed here that the tab does not already
compute; this module only resolves "the picks" and "the window".

* **Recorded or reconstructed, never mixed up.** A day with a journal entry uses the entry's
  picks. A day before the journal began is re-scored with `daylog.reconstruction` (the same
  `pick.score_history` the 09:16 job calls) and says so.
* **The fixed base** is 2 x `N_wide_0917` + 1 x the Dir ATM 09:24 leg. The Widesl appears twice,
  so the basket is 2 W + D exactly as it is traded; the pair correlates 1.00 by construction.
* **In-sample.** The figures describe the window's days. A window of recorded forward days is the
  only one that has not been looked at before.
* **Missing is never zero.** A pick with no stored results is listed and left out; a window with
  too few common days returns no figures and says how many days it has.

Nothing here writes a file.
"""

from __future__ import annotations

from datetime import date
from pathlib import Path

import numpy as np

from ..analytics import correlation as corr
from ..fyers.daily import data_dir
from . import base as base_mod
from . import daylog, journal, store
from .lists import LISTS, LOTS_PER
from .matrix import NAMED

#: the lists a basket can be taken from, then the owner's fixed base
KEYS = (*LISTS, "BASE")
WINDOWS = ("P1", "P2", "last63", "forward", "custom")
LAST_N = 63
#: fewer common days than this and a correlation is not worth computing at all
MIN_DAYS = 5
#: below this the figures are shown muted: a pair of 15 numbers is an anecdote
THIN_DAYS = 20
BASE_SECOND_WIDE = f"{base_mod.WIDE_NAME} (2nd)"


class BasketError(Exception):
    """A request that cannot be answered; `status` is the HTTP code the route returns."""

    def __init__(self, status: int, message: str) -> None:
        super().__init__(message)
        self.status = status


def _label(key: str) -> str:
    return "Fixed base" if key == "BASE" else f"List {key}"


def _forward_days(entries: list[dict]) -> list[date]:
    """The days of on-time entries: the only days that are forward (a late one is not)."""
    return sorted(date.fromisoformat(e["day"]) for e in entries if e.get("before_first_entry"))


def _pick_record(name: str, role: str, lots: int, composite: float | None) -> dict:
    return {
        **daylog.describe_pick(name),
        "role": role,
        "lots": lots,
        "composite": None if composite is None else round(float(composite), 4),
    }


def _list_picks(
    entries: list[dict], day: date, key: str, root: Path
) -> tuple[list[dict], str, bool, bool]:
    """(picks, source, late, overridden) for a list on a day: the entry's, else re-scored."""
    entry = next((e for e in entries if e["day"] == day.isoformat()), None)
    if entry is not None:
        picked = (entry.get("lists") or {}).get(key)
        if picked is None:
            raise BasketError(404, f"the {day} entry has no list {key}")
        lots = int(entry.get("lots_per_strategy") or LOTS_PER)
        late = not bool(entry.get("before_first_entry", False))
        source = "recorded"
    else:
        rec = daylog.reconstruction(root)
        if rec.error:
            raise BasketError(
                404, f"no entry for {day}, and the history cannot be re-scored: {rec.error}"
            )
        everything = rec.picks(day)
        if everything is None or key not in everything:
            raise BasketError(
                404,
                f"{day} has no journal entry and is not a day the research history can re-score "
                "(it needs 63 earlier days of stored results and its own day attributes)",
            )
        picked, lots, late, source = everything[key], LOTS_PER, False, "reconstructed"
    composite = picked.get("composite") or {}
    picks = [
        _pick_record(n, role, lots, composite.get(n))
        for role, names in (("core", picked.get("core") or []), ("buy", picked.get("buy") or []))
        for n in names
    ]
    return picks, source, late, bool(picked.get("overridden", False))


def _series(name: str, root: Path) -> dict[date, float]:
    if name == base_mod.DIR_NAME:
        return base_mod.read_column(base_mod.base_dir(root) / f"{name}.csv", "net")
    return store.read_net(name, root)


def _default_day(entries: list[dict], root: Path) -> date | None:
    forward = _forward_days(entries)
    if forward:
        return forward[-1]
    available = daylog.reconstruction(root).days_available()
    return available[-1] if available else None


def _windows(common: list[date], forward: list[date]) -> dict[str, dict]:
    """Each window's dates and how many of the basket's common days fall in it."""
    out: dict[str, dict] = {}
    for pid, (lo, hi, label) in NAMED.items():
        n = sum(1 for d in common if lo <= d <= hi)
        out[pid] = {
            "id": pid,
            "label": label,
            "from": lo.isoformat(),
            "to": hi.isoformat(),
            "n_days": n,
        }
    tail = common[-LAST_N:]
    out["last63"] = {
        "id": "last63",
        "label": f"Last {LAST_N} sessions",
        "from": tail[0].isoformat() if tail else None,
        "to": tail[-1].isoformat() if tail else None,
        "n_days": len(tail),
    }
    fwd_common = [d for d in common if d in set(forward)]
    out["forward"] = {
        "id": "forward",
        "label": "Forward · recorded days",
        "from": fwd_common[0].isoformat() if fwd_common else None,
        "to": fwd_common[-1].isoformat() if fwd_common else None,
        "n_days": len(fwd_common),
    }
    return out


def build(
    key: str,
    day: date | None = None,
    window: str = "P1",
    start: date | None = None,
    end: date | None = None,
    root: Path | None = None,
) -> dict:
    """The preset's whole answer: the picks, the windows, and the correlation over one window."""
    if key not in KEYS:
        raise BasketError(422, f"list must be one of {', '.join(KEYS)}")
    if window not in WINDOWS:
        raise BasketError(422, f"window must be one of {', '.join(WINDOWS)}")
    root = root or data_dir()
    try:
        entries = journal.read(store.journal_path(root))
    except journal.JournalCorrupt as error:
        raise BasketError(500, f"the journal cannot be read: {error}") from error
    forward = _forward_days(entries)

    source, late, overridden = "base", False, False
    if key == "BASE":
        picks = [
            _pick_record(base_mod.WIDE_NAME, "core", 2 * LOTS_PER, None),
            _pick_record(base_mod.DIR_NAME, "core", LOTS_PER, None),
        ]
        # the Dir ATM leg is not a rotation variant: name it for what it is
        picks[1].update({"index": "NIFTY", "family": "dir", "kind": "dir", "start": "09:24"})
        picks[1]["band"] = daylog.start_band("0924")
        series_names = [base_mod.WIDE_NAME, BASE_SECOND_WIDE, base_mod.DIR_NAME]
        day_used = day
    else:
        day_used = day or _default_day(entries, root)
        if day_used is None:
            raise BasketError(
                404,
                "no basket to show yet: there is no journal entry and the history is too short "
                "to re-score a day",
            )
        picks, source, late, overridden = _list_picks(entries, day_used, key, root)
        series_names = [p["name"] for p in picks]

    have: dict[str, dict[date, float]] = {}
    omitted: list[str] = []
    for n in dict.fromkeys(series_names):
        source_name = base_mod.WIDE_NAME if n == BASE_SECOND_WIDE else n
        values = _series(source_name, root)
        if values:
            have[n] = values
        else:
            omitted.append(n)
    for p in picks:
        v = have.get(p["name"])
        p["has_results"] = v is not None
        p["first"] = min(v).isoformat() if v else None
        p["last"] = max(v).isoformat() if v else None
        p["n_days"] = len(v) if v else 0

    usable = [n for n in series_names if n in have]
    if key == "BASE":
        have.setdefault(BASE_SECOND_WIDE, have.get(base_mod.WIDE_NAME, {}))
    common = (
        sorted(d for d in set.intersection(*(set(have[n]) for n in usable)) if d.weekday() < 5)
        if usable
        else []
    )
    windows = _windows(common, forward)

    if window == "custom":
        lo, hi, label = start, end, f"Custom · {start or 'start'} to {end or 'latest'}"
    elif window in NAMED:
        lo, hi, label = NAMED[window][0], NAMED[window][1], NAMED[window][2]
    elif window == "last63":
        w = windows["last63"]
        lo = date.fromisoformat(w["from"]) if w["from"] else None
        hi = date.fromisoformat(w["to"]) if w["to"] else None
        label = w["label"]
    else:
        w = windows["forward"]
        lo = date.fromisoformat(w["from"]) if w["from"] else None
        hi = date.fromisoformat(w["to"]) if w["to"] else None
        label = w["label"]

    out: dict = {
        "list": key,
        "label": _label(key),
        "day": day_used.isoformat() if day_used else None,
        "weekday": day_used.strftime("%a") if day_used else None,
        "source": source,
        "late": late,
        "overridden": overridden,
        "picks": picks,
        "omitted": omitted,
        # columns that repeat another one by construction (the base trades its Widesl twice)
        "duplicates": [BASE_SECOND_WIDE] if key == "BASE" else [],
        "lots": sum(p["lots"] for p in picks),
        "windows": windows,
        "window": {
            "id": window,
            "label": label,
            "from": lo.isoformat() if lo else None,
            "to": hi.isoformat() if hi else None,
        },
        "correlation": None,
        "reason": None,
        "n_days": 0,
        "enough": False,
        "thin_days": THIN_DAYS,
        "all_lose_days": None,
        "any_lose_days": None,
        "forward_days": len(forward),
        "basis": "gross",
        "in_sample": True,
        "notes": [],
    }
    if key == "BASE":
        out["notes"].append(
            f"{base_mod.WIDE_NAME} is traded twice, so it is listed twice: those two columns "
            "correlate 1.00 by construction. The basket is 2 Widesl + 1 Dir ATM, as traded."
        )
    if omitted:
        out["reason"] = "no stored results for " + ", ".join(omitted)
        return out
    if window == "forward" and not forward:
        out["reason"] = "No on-time entry has been recorded yet (the first is Mon 12 Oct, 09:16)."
        return out
    # a forward window is the on-time days themselves, not the date range they span: a late or
    # missing day between two on-time ones is not forward and must not be correlated
    only = set(forward) if window == "forward" else None
    series = [
        corr.Series(n, "variant", {d: v for d, v in have[n].items() if only is None or d in only})
        for n in usable
    ]
    try:
        report = corr.analyse(series, start=lo, end=hi, min_days=MIN_DAYS)
    except ValueError as error:
        in_window = [
            d
            for d in common
            if (lo is None or d >= lo) and (hi is None or d <= hi) and (only is None or d in only)
        ]
        out["n_days"] = len(in_window)
        out["reason"] = f"{len(in_window)} common days in this window; {error}"
        return out
    lose = report.values < 0
    out.update(
        correlation={
            **corr.to_json(report),
            "selectors": list(report.names),
            "from": report.days[0].isoformat(),
            "to": report.days[-1].isoformat(),
            "stale": [],
            "in_sample": True,
        },
        n_days=report.n_days,
        enough=report.n_days >= THIN_DAYS,
        all_lose_days=int(np.all(lose, axis=1).sum()),
        any_lose_days=int(np.any(lose, axis=1).sum()),
    )
    return out
