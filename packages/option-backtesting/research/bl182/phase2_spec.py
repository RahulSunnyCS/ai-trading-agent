"""BL-182 Phase 2's configuration as a `split_replay.Spec`, for E2 (the morning stop sweep).

Same pools, exit and picks as research/bl182/phase2.py (which stays the record of Phase 2 and E1); the
whole-day pool is re-simulated once more under the shared module's folders so every level reads one
engine version (its parity with the stored rotation results is printed by each summary).
"""

from __future__ import annotations

import sys
from pathlib import Path

HERE = Path(__file__).parent
sys.path.insert(0, str(HERE.parent / "common"))
import split_replay as sr  # noqa: E402

SPEC = sr.Spec(
    here=HERE,
    families={
        "N_wide": "NIFTY",
        "N_p80": "NIFTY",
        "N_p100": "NIFTY",
        "S_wide": "SENSEX",
        "S_p250": "SENSEX",
        "S_p320": "SENSEX",
    },  # fmt: skip
    slots_am=sr.slots("0917", "1147"),
    slots_pm=sr.slots("1302", "1502"),
    am_exit="12:00",
    n_pick=2,
    margin_lots=2,
    title="BL-182 Phase 2 (shared module) — two morning + two afternoon Widesl vs top two whole-day",
)
