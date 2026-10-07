"""BL-042: chart-pattern POC (tight range, flag, cup and handle) for the Broad Momentum pool.

Research only. Nothing here is wired into `api.py`, `BacktestRequest`, the default ranking or the
weekly signal; a pattern that passes its pre-registered test goes to BL-033 for that.

Every rule and threshold lives in `search_spaces/bl042_criteria.json` (and its addenda); code
reads them from there and never restates one. Nothing before Phase 6 may read a bar dated on or
after the sealed hold-out's first day: `guard` enforces it for every loader.
"""

from __future__ import annotations

import json
from functools import cache
from pathlib import Path

import pandas as pd

SEARCH_SPACES = Path(__file__).resolve().parents[3] / "search_spaces"
CRITERIA = SEARCH_SPACES / "bl042_criteria.json"
PATTERNS = ("tight_range", "flag", "cup_handle", "high_tight_flag")


def _addenda() -> list[dict]:
    paths = SEARCH_SPACES.glob("bl042_criteria_addendum_*.json")
    ordered = sorted(paths, key=lambda p: int(p.stem.rsplit("_", 1)[1]))
    return [json.loads(p.read_text()) for p in ordered]


@cache
def criteria() -> dict:
    """bl042_criteria.json with every addendum applied in order:
    - `detectors` replaces the starting values for the patterns it names;
    - `shapes` replaces the named fields of the Phase 5 shapes;
    - `quality`, `uses`, `learned_score`, `bad_bar_wick` and `gallery_check` are taken as
      they are (a later addendum's block replaces an earlier one's)."""
    spec = json.loads(CRITERIA.read_text())
    for extra in _addenda():
        for name, values in extra.get("detectors", {}).items():
            spec["detectors_starting_values"][name] = values
        for shape, fields in extra.get("shapes", {}).items():
            spec["phase_5_ranking_test"]["shapes"][shape].update(fields)
        for key in ("quality", "uses", "learned_score", "bad_bar_wick", "gallery_check"):
            if key in extra:
                spec[key] = extra[key]
    return spec


def frozen() -> dict | None:
    """The addendum that freezes the detectors after the gallery check (`detectors_frozen:
    true`), or None while Phase 3 is open. Phases 4-6 read no return without it."""
    hits = [a for a in _addenda() if a.get("detectors_frozen") is True]
    return hits[-1] if hits else None


def detector_params(pattern: str) -> dict:
    return criteria()["detectors_starting_values"][pattern]


def dev_end() -> pd.Timestamp:
    return pd.Timestamp(criteria()["windows"]["development"]["to"])


def holdout_start() -> pd.Timestamp:
    return pd.Timestamp(criteria()["windows"]["holdout"]["from"])


def guard(through: str | pd.Timestamp, *, allow_holdout: bool = False) -> pd.Timestamp:
    """The last date a caller may read. Raises if it reaches the sealed hold-out and the caller
    is not the one-shot Phase 6 run."""
    cut = pd.Timestamp(through)
    if cut >= holdout_start() and not allow_holdout:
        raise ValueError(
            f"{cut.date()} reaches the sealed BL-042 hold-out (from {holdout_start().date()}); "
            "only the one Phase 6 run may read it"
        )
    return cut
