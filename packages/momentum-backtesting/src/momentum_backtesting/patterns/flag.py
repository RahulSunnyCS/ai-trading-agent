"""Bull flag / pennant (daily bars) and the high tight flag (weekly bars).

Bull flag, at each week's last day i:

- the pole top h is the highest high in the `flag.min_days`..`flag.max_days` bars before i, and
  no bar after h has a higher high (else the flag already broke out or is still the pole);
- the pole starts at the lowest low s in the `pole.max_days`..`pole.min_days` bars before h,
  and rises at least `pole.min_rise`;
- the flag (h, i] gives back at most `flag.max_retrace_of_pole` of the pole and at most
  `flag.max_drop_from_pole_high` from its high, its highs do not rise (the second half's highest
  high is not above the first half's), and its average volume is below the pole's;
- no bad bar from s to i.

The pivot is the flag's highest high. A pennant (converging highs and lows) passes the same
rules and is not told apart.

High tight flag (weekly): a rise of at least `pole.min_rise` within `pole.max_weeks` weeks to a
top week h, then `flag.min_weeks`..`flag.max_weeks` weeks with no higher high, falling at most
`flag.max_drop_from_pole_high` from the top. Reported separately, never judged.
"""

from __future__ import annotations

import numpy as np

from . import detector_params
from .bars import SymbolBars
from .common import Base, context

PATTERN = "flag"
HIGH_TIGHT = "high_tight_flag"


def scan(bars: SymbolBars, params: dict | None = None) -> list[Base | None]:
    p = params or detector_params(PATTERN)
    out: list[Base | None] = [None] * len(bars.week_end)
    setting = context(bars.weekly(), p)
    for k, i in enumerate(bars.week_end):
        if setting[k]:
            found = flag_at(bars, int(i), p)
            out[k] = found[0] if found else None
    return out


def flag_at(bars: SymbolBars, i: int, p: dict) -> tuple[Base, float] | None:
    """The flag ending on daily bar `i` (bars up to `i` only), and the flag's lowest low, or
    None. The stock's setting (`common.context`) is the caller's to check: weekly in `scan`,
    daily in BL-043's daily scan."""
    pole, flag = p["pole"], p["flag"]
    high, low, vol, bad = bars.high, bars.low, bars.volume, bars.bad
    lo_h, hi_h = i - flag["max_days"], i - flag["min_days"]
    if lo_h - pole["max_days"] < 0:
        return None
    h = lo_h + int(np.argmax(high[lo_h : hi_h + 1]))
    top = high[h]
    if high[h + 1 : i + 1].max() > top:
        return None
    lo_s, hi_s = h - pole["max_days"], h - pole["min_days"]
    s = lo_s + int(np.argmin(low[lo_s : hi_s + 1]))
    base_low = low[s]
    if top < base_low * (1 + pole["min_rise"]) or bad[s : i + 1].any():
        return None
    flag_low = low[h + 1 : i + 1].min()
    drop = 1 - flag_low / top
    retrace = (top - flag_low) / (top - base_low)
    if drop > flag["max_drop_from_pole_high"] or retrace > flag["max_retrace_of_pole"]:
        return None
    flag_high = high[h + 1 : i + 1]
    half = len(flag_high) // 2
    if flag["highs_not_rising"] and flag_high[half:].max() > flag_high[:half].max():
        return None
    pole_volume, flag_volume = vol[s : h + 1].mean(), vol[h + 1 : i + 1].mean()
    if flag["volume_below_pole"] and not flag_volume < pole_volume:
        return None
    base = Base(
        pivot=float(flag_high.max()),
        start=s,
        end=i,
        geometry={
            "pole_rise": round(float(top / base_low - 1), 4),
            "pole_days": h - s,
            "flag_days": i - h,
            "drop_from_pole_high": round(float(drop), 4),
            "retrace_of_pole": round(float(retrace), 3),
            "flag_vs_pole_volume": round(float(flag_volume / pole_volume), 3),
            "pole_top": str(np.datetime_as_string(bars.dates[h], unit="D")),
        },
    )
    return base, float(flag_low)


def scan_high_tight(bars: SymbolBars, params: dict | None = None) -> list[Base | None]:
    p = params or detector_params(HIGH_TIGHT)
    pole, flag = p["pole"], p["flag"]
    w = bars.weekly()
    out: list[Base | None] = [None] * len(w.close)
    for k in range(len(w.close)):
        for length in range(flag["min_weeks"], flag["max_weeks"] + 1):
            h = k - length
            if h - pole["max_weeks"] < 0:
                break
            top = w.high[h]
            if w.high[h + 1 : k + 1].max() > top:
                continue
            start = h - pole["max_weeks"]
            base_low = w.low[start : h + 1].min()
            drop = 1 - w.low[h + 1 : k + 1].min() / top
            if (
                top >= base_low * (1 + pole["min_rise"])
                and drop <= flag["max_drop_from_pole_high"]
                and not w.bad[start : k + 1].any()
            ):
                out[k] = Base(
                    pivot=float(w.high[h + 1 : k + 1].max()),
                    start=int(w.start[start]),
                    end=int(bars.week_end[k]),
                    geometry={
                        "pole_rise": round(float(top / base_low - 1), 4),
                        "flag_weeks": length,
                        "drop_from_pole_high": round(float(drop), 4),
                    },
                )
                break
    return out
