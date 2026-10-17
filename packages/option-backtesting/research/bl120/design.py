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
