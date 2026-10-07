"""What every detector returns, and the shared forming / near pivot / broke out states.

A detector looks at each week's close in turn, using only bars up to that week's last day, and
returns a `Base` for each week its rules hold (else None). `states` then turns those into the
pre-registered states (bl041_criteria.json `states`):

- forming: the rules hold this week;
- near_pivot: forming, and the close is within `NEAR_PIVOT` below the pivot;
- broke_out: not forming this week, but a base formed at one of the previous `BREAKOUT_WEEKS`
  week closes, and after that close some day within the last `BREAKOUT_WEEKS` weeks (this one
  included) closed above its pivot on volume at least `BREAKOUT_VOLUME` x the 50-day average
  before it. "Base still valid on the breakout day" is read as: it held at a week close no more
  than `BREAKOUT_WEEKS` weeks before.
"""

from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np
import pandas as pd

from .bars import SymbolBars

NEAR_PIVOT = 0.05
BREAKOUT_WEEKS = 2
BREAKOUT_VOLUME = 1.5
VOLUME_AVERAGE_DAYS = 50
SCORES = {"none": 0.0, "forming": 0.5, "near_pivot": 0.75, "broke_out": 1.0}


@dataclass(frozen=True)
class Base:
    pivot: float  # adjusted price (bars.adjust's scale)
    start: int  # daily index of the base's first bar (the pole start for a flag)
    end: int  # daily index of the evaluated week's last bar
    geometry: dict = field(default_factory=dict)


def average_volume(volume: np.ndarray, days: int = VOLUME_AVERAGE_DAYS) -> np.ndarray:
    """Mean volume of the `days` bars BEFORE each bar (NaN until there are that many)."""
    rolled = pd.Series(volume).rolling(days, min_periods=days).mean().shift(1)
    return rolled.to_numpy()


def states(bars: SymbolBars, bases: list[Base | None], pattern: str) -> list[dict]:
    """One record per week that is forming, near the pivot or just broke out."""
    avg = average_volume(bars.volume)
    out: list[dict] = []
    last_formed: int | None = None  # week index of the latest base
    for k, base in enumerate(bases):
        end = int(bars.week_end[k])
        if base is not None:
            close = bars.close[end]
            state = "near_pivot" if close >= base.pivot * (1 - NEAR_PIVOT) else "forming"
            out.append(_record(bars, k, pattern, state, base, None))
            last_formed = k
            continue
        if last_formed is None or k - last_formed > BREAKOUT_WEEKS:
            continue
        prior = bases[last_formed]
        assert prior is not None
        first_day = int(bars.week_end[last_formed]) + 1
        window_start = int(bars.week_end[k - BREAKOUT_WEEKS]) + 1 if k >= BREAKOUT_WEEKS else 0
        days = np.arange(max(first_day, window_start), end + 1)
        hit = days[
            (bars.close[days] > prior.pivot)
            & (bars.volume[days] >= BREAKOUT_VOLUME * avg[days])
            & ~bars.bad[days]
        ]
        if len(hit):
            out.append(_record(bars, k, pattern, "broke_out", prior, int(hit[0])))
    return out


def _record(
    bars: SymbolBars, k: int, pattern: str, state: str, base: Base, breakout_day: int | None
) -> dict:
    end = int(bars.week_end[k])
    scale = bars.scale[end]
    return {
        "symbol": bars.symbol,
        "week": bars.fridays[k],
        "pattern": pattern,
        "state": state,
        "score": SCORES[state],
        # Prices as traded on the week's last day (not the adjusted scale).
        "pivot": base.pivot / scale,
        "close": bars.close[end] / scale,
        "pivot_vs_close": base.pivot / bars.close[end] - 1,
        "base_start": pd.Timestamp(bars.dates[base.start]),
        "base_end": pd.Timestamp(bars.dates[base.end]),
        "breakout_date": pd.Timestamp(bars.dates[breakout_day])
        if breakout_day is not None
        else pd.NaT,
        "geometry": base.geometry,
    }
