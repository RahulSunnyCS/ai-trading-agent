"""BL-091 Phase 1: episodes of the spliced rolling ATM straddle (pure, no I/O).

E.2 as registered, with the resolutions recorded in the item's Log:

- An episode opens at the first minute the spliced series is >= RISE above its running low (the
  start is the last minute at that low).
- While open it tracks its running high. A pause begins the first minute the series is >= DECAY
  below the high; a new high ends the pause (the episode resumed).
- It closes as `decayed` when, during a pause, a fresh >= RISE rise starts from the pause's low
  without first exceeding the old high (a new episode opens there), or when it is in a pause at the
  horizon (15:28). Otherwise at the horizon it is `resumed_open` (paused at least once, then a new
  high, not in a pause at the close) or `no_pause` (never gave back DECAY).
- Each minute is processed in this order: new high, pause start, new rise. A jump that makes a new
  high therefore resumes the episode rather than starting another.

Every field of an episode is decided by values at or before the minute it is set, so truncating the
day at T leaves every episode triggered by T with the same start, low, trigger and trigger rise.
"""

from __future__ import annotations

from dataclasses import dataclass

from periods import DECAY, M_0920, M_1528, RISE


@dataclass
class Episode:
    start_min: int
    low_x: float
    trigger_min: int
    rise_at_trigger: float
    high_x: float
    high_min: int
    n_pauses: int = 0
    first_pause_min: int | None = None
    paused_now: bool = False
    decay_min: int | None = None  # the minute the final pause began (None if not in one)
    trough_x: float | None = None  # the lowest value since the final high
    trough_min: int | None = None
    end_min: int = -1
    end_x: float = 0.0
    end_reason: str = ""  # "close" | "new_episode"
    outcome: str = ""  # "decayed" | "resumed_open" | "no_pause"


def scan_episodes(
    x: list[float],
    start: int = M_0920,
    end: int = M_1528,
    rise: float = RISE,
    decay: float = DECAY,
) -> list[Episode]:
    episodes: list[Episode] = []
    ep: Episode | None = None
    low, low_min = x[start], start
    dlow, dlow_min = 0.0, 0
    for m in range(start + 1, end + 1):
        v = x[m]
        if ep is None:
            if v <= low:
                low, low_min = v, m
            elif v - low >= rise:
                ep = Episode(low_min, low, m, v - low, v, m)
                dlow, dlow_min = v, m
            continue
        if v > ep.high_x:
            ep.high_x, ep.high_min = v, m
            ep.paused_now, ep.decay_min = False, None
            dlow, dlow_min = v, m
            continue
        if v < dlow:
            dlow, dlow_min = v, m
        if not ep.paused_now and ep.high_x - v >= decay:
            ep.paused_now = True
            ep.n_pauses += 1
            ep.decay_min = m
            if ep.first_pause_min is None:
                ep.first_pause_min = m
        if ep.paused_now and v - dlow >= rise:
            ep.trough_x, ep.trough_min = dlow, dlow_min
            ep.end_min, ep.end_x = m, v
            ep.end_reason, ep.outcome = "new_episode", "decayed"
            episodes.append(ep)
            ep = Episode(dlow_min, dlow, m, v - dlow, v, m)
            dlow, dlow_min = v, m
    if ep is not None:
        ep.trough_x, ep.trough_min = dlow, dlow_min
        ep.end_min, ep.end_x = end, x[end]
        ep.end_reason = "close"
        if ep.paused_now:
            ep.outcome = "decayed"
        else:
            ep.outcome = "resumed_open" if ep.n_pauses > 0 else "no_pause"
        episodes.append(ep)
    return episodes
