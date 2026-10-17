"""BL-120: the rule, as registered in the item's Phase 0 (one definition each; nothing here is tuned).

From 14:30 (minute index 315, 09:15 = 0) on the rolling ATM straddle series x:
  low(t)  = min x[315..t],  high(t) = max x[315..t],  rise(t) = x[t] - low(t)
  held    = rise >= RISE[index] for HOLD consecutive minutes; the hold completes at minute h
  fire    = the first completed bar j >= h with high(j) - x[j] >= GIVEBACK
  entry   = j + 1 (the engine prices an entry at T with the close of the bar ending at T)
An event whose entry would be 15:13 (index 358) or later is not tradable. One event per day: the first.

The detector reads x[<= j] only: `upto=j` must give the same event, and `upto=j-1` none.
"""

from __future__ import annotations

from dataclasses import dataclass

M_1430 = 315
M_1512 = 357  # the last tradable entry minute (15:12); 15:13 or later is dropped
M_1528 = 373
RISE = {"NIFTY": 20.0, "SENSEX": 50.0}
HOLD = 5
GIVEBACK = 15.0


@dataclass(frozen=True)
class Event:
    held: int  # minute the 5-minute hold completed
    fire: int  # the completed bar that gave back GIVEBACK from the high
    entry: int  # fire + 1
    low: float
    high: float
    x_fire: float
    tradable: bool  # entry <= 15:12


def detect(
    x: list[float],
    rise: float,
    *,
    start: int = M_1430,
    hold: int = HOLD,
    give: float = GIVEBACK,
    upto: int = M_1528,
) -> Event | None:
    """The first event on series x, reading minutes start..upto only."""
    low = float("inf")
    high = float("-inf")
    run = 0
    held: int | None = None
    for m in range(start, upto + 1):
        v = x[m]
        low = min(low, v)
        high = max(high, v)
        run = run + 1 if v - low >= rise else 0
        if held is None and run >= hold:
            held = m
        if held is not None and high - v >= give:
            return Event(held, m, m + 1, low, high, v, m + 1 <= M_1512)
    return None
