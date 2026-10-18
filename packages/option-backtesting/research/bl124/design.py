"""BL-124: the whole comparator design from out/events.csv, one function used by run.py and read.py so the
simulations that are run are exactly the ones that are read. Comparator rules: research/common/event_design.py.

Cells are (arm, period): R1 and R2 in P2 and in P3. Per cell: the events (sorted by day), each event's causal
placebo days, the pool of the cell's own entry minutes, and a (N_DRAWS, n_events) matrix of random minutes.
"""

from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import pandas as pd
from periods import PERIODS
from rule import ARMS

sys.path.insert(0, str(Path(__file__).parent.parent / "common"))
from event_design import N_DRAWS, placebo_days, random_minutes  # noqa: E402

__all__ = ["N_DRAWS", "build"]


def build(events: pd.DataFrame) -> dict[tuple[str, str], dict]:
    ok = events[events.status == "ok"]
    out: dict[tuple[str, str], dict] = {}
    seed = 0
    for arm in ARMS:
        k = arm.lower()
        for period in PERIODS:
            g = ok[ok.period == period]
            ev = g[g[f"{k}_fire"].notna()].sort_values("day").reset_index(drop=True)
            days = sorted(g.day)
            fire_of = {
                r["day"]: (None if np.isnan(r[f"{k}_fire"]) else int(r[f"{k}_fire"]))
                for r in g.to_dict("records")
            }
            placebo = {
                r["day"]: placebo_days(r["day"], int(r[f"{k}_fire"]), days, fire_of)
                for r in ev.to_dict("records")
            }
            pool = sorted(int(m) for m in ev[f"{k}_entry"])
            draws = (
                random_minutes(pool, len(ev), seed)
                if len(ev)
                else np.zeros((N_DRAWS, 0), dtype=int)
            )
            out[(arm, period)] = {"events": ev, "placebo": placebo, "draws": draws, "pool": pool}
            seed += 1
    return out
