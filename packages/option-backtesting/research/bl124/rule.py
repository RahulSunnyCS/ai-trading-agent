"""BL-124: the rule, as registered in the item's Phase 0 (one definition each; nothing here is tuned).

On the rolling ATM straddle series x (minute index, 09:15 = 0):
  S0 = x[2]                      the value noted at 09:17
  H  = max x[2..15]              the opening high (bars stamped 09:17 .. 09:30)
  watch bars j = 16 .. 285       09:31 .. 14:00; entry = j + 1 (the engine prices an entry at T with the
                                 close of the bar ending at T), so the last entry is 14:01
  R1 fires on the first j with   x[j] > H  and  x[j] - S0 >= 10
  R2 fires on the first j with   x[j] >= H + 10
One event per arm per day. H >= S0, so R2 fires on the same bar as R1 or later.

The detector reads x[<= j] only: `upto=j` must give the same event, and `upto=j-1` none.
"""

from __future__ import annotations

from dataclasses import dataclass

M_0917 = 2
M_0930 = 15
FIRST_WATCH = 16  # the bar stamped 09:31
LAST_WATCH = 285  # the bar stamped 14:00
MOVE = 10.0
ARMS = ("R1", "R2")


@dataclass(frozen=True)
class Event:
    arm: str
    fire: int  # the completed bar that met the condition
    entry: int  # fire + 1
    s0: float
    high: float
    x_fire: float


def opening(x: list[float]) -> tuple[float, float]:
    """(S0, H) from bars up to 09:30 only."""
    return x[M_0917], max(x[M_0917 : M_0930 + 1])


def detect(x: list[float], arm: str, *, upto: int = LAST_WATCH) -> Event | None:
    if arm not in ARMS:
        raise ValueError(arm)
    s0, high = opening(x)
    for j in range(FIRST_WATCH, min(upto, LAST_WATCH) + 1):
        v = x[j]
        hit = (v > high and v - s0 >= MOVE) if arm == "R1" else (v >= high + MOVE)
        if hit:
            return Event(arm, j, j + 1, s0, high, v)
    return None
