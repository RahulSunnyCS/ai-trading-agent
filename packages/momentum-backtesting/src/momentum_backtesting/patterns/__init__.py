"""BL-041: chart-pattern POC (tight range, flag, cup and handle) for the Broad Momentum pool.

Research only. Nothing here is wired into `api.py`, `BacktestRequest`, the default ranking or the
weekly signal; a pattern that passes its pre-registered test goes to BL-033 for that.

Every rule and threshold lives in `search_spaces/bl041_criteria.json` (and its addenda); code
reads them from there and never restates one. Nothing before Phase 6 may read a bar dated on or
after the sealed hold-out's first day: `guard` enforces it for every loader.
"""

from __future__ import annotations

import json
from functools import cache
from pathlib import Path

import pandas as pd

SEARCH_SPACES = Path(__file__).resolve().parents[3] / "search_spaces"
CRITERIA = SEARCH_SPACES / "bl041_criteria.json"
PATTERNS = ("tight_range", "flag", "cup_handle", "high_tight_flag")


@cache
def criteria() -> dict:
    """bl041_criteria.json with every addendum applied in order (an addendum's
    `detectors` block replaces the starting values for the patterns it names)."""
    spec = json.loads(CRITERIA.read_text())
    for path in sorted(SEARCH_SPACES.glob("bl041_criteria_addendum_*.json")):
        extra = json.loads(path.read_text())
        for name, values in extra.get("detectors", {}).items():
            spec["detectors_starting_values"][name] = values
    return spec


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
            f"{cut.date()} reaches the sealed BL-041 hold-out (from {holdout_start().date()}); "
            "only the one Phase 6 run may read it"
        )
    return cut
