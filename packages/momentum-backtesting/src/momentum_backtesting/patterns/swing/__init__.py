"""BL-043: a daily pattern swing system (tight range and flag), separate from Momentum.

Research only: signals, never orders. Every rule lives in `search_spaces/bl043_criteria.json`
(and its addenda, merged in file order); code reads them from there. The sealed hold-out is the
same date BL-042 guarded (`patterns.guard`), handed over unread.
"""

from __future__ import annotations

import json
from functools import cache

from .. import SEARCH_SPACES

CRITERIA = SEARCH_SPACES / "bl043_criteria.json"


@cache
def criteria() -> dict:
    """bl043_criteria.json with every addendum's top-level blocks replacing the original's."""
    spec = json.loads(CRITERIA.read_text())
    paths = sorted(
        SEARCH_SPACES.glob("bl043_criteria_addendum_*.json"),
        key=lambda p: int(p.stem.rsplit("_", 1)[1]),
    )
    for path in paths:
        extra = json.loads(path.read_text())
        for key, value in extra.items():
            if key not in ("written_before_running", "name", "adds_to", "rule", "reason"):
                spec[key] = value
    return spec
