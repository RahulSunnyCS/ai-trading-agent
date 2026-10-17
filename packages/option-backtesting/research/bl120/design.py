"""BL-120: how comparators are chosen. One definition, used by run.py (to know what to simulate) and
read.py (to read it), so the two cannot drift.

Causal placebo (Phase 0, comparator 1): for an event on day d with fire minute j, the 10 nearest days
(5 before, 5 after) of the same index and cell on which the rule had NOT fired at or before j: a day with
no fire at all, or a fire at a later minute. A day's fire minute is known from its own bars up to j, so no
information from after the entry minute chooses the placebo. Weekday sessions only.

Random minute (comparator 2): for each event day, an entry minute drawn at random from the pool of the
cell's own event entry minutes, 200 draws, seed 20261018.
"""

from __future__ import annotations

import numpy as np

PLACEBO_EACH_SIDE = 5
N_DRAWS = 200
SEED = 20261018
STOP_INR = 1000.0


def placebo_days(
    day: str, fire: int, cell_days: list[str], fire_of: dict[str, int | None]
) -> list[str]:
    """`cell_days` sorted ISO dates with usable data; `fire_of[d]` is that day's fire minute or None."""
    quiet = [d for d in cell_days if d != day and (fire_of[d] is None or fire_of[d] > fire)]
    i = sum(1 for d in quiet if d < day)
    return quiet[max(0, i - PLACEBO_EACH_SIDE) : i] + quiet[i : i + PLACEBO_EACH_SIDE]


def random_minutes(pool: list[int], n_events: int, cell_seed: int) -> np.ndarray:
    """An (N_DRAWS, n_events) array of entry minutes drawn from `pool`."""
    rng = np.random.default_rng(SEED + cell_seed)
    return np.asarray(pool)[rng.integers(0, len(pool), size=(N_DRAWS, n_events))]


def build(events) -> dict:
    """Block 2's whole design from out/events_b.csv (a DataFrame of every cell-day).

    Returns {und: {"events": DataFrame (tradable events sorted by period, day), "placebo": {(period,
    day): [placebo days]}, "draws": (N_DRAWS, n_events) minutes, "pool": [...]}} for NIFTY (P2 and P3
    pooled; the pool is the pooled events' entry minutes) and SENSEX (P2). Deterministic: run.py and
    read.py both call this, so the simulations run are exactly the ones read.
    """
    ok = events[events.status == "ok"]
    out = {}
    for seed, und in enumerate(("NIFTY", "SENSEX")):
        g = ok[ok.underlying == und]
        ev = (
            g[g.fire.notna() & (g.tradable == 1)]
            .sort_values(["period", "day"])
            .reset_index(drop=True)
        )
        days_of = {p: sorted(g[g.period == p].day) for p in g.period.unique()}
        fire_of = {
            p: {
                r.day: (None if np.isnan(r.fire) else int(r.fire))
                for r in g[g.period == p].itertuples()
            }
            for p in g.period.unique()
        }
        placebo = {}
        for r in ev.itertuples():
            placebo[(r.period, r.day)] = placebo_days(
                r.day, int(r.fire), days_of[r.period], fire_of[r.period]
            )
        pool = sorted(int(m) for m in ev.entry)
        draws = (
            random_minutes(pool, len(ev), seed) if len(ev) else np.zeros((N_DRAWS, 0), dtype=int)
        )
        out[und] = {"events": ev, "placebo": placebo, "draws": draws, "pool": pool}
    return out
