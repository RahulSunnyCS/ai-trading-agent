"""
Fill models. `trigger_level` (the default) and `bar_close` are verbatim ports
of the design handoff's reference `fill()` — read `golden_15_sessions.py` /
`pyramid_backtest.py`'s `_fill_price()` before touching this module, the
golden-fixture parity test depends on bit-for-bit fidelity.

`worst_of_bar` and `next_open` are NOT exercised by the golden fixture (no
committed strategy uses them) — they're a best-effort literal reading of the
fill-model name, not verified against any reference output.
"""

from __future__ import annotations

from collections.abc import Sequence
from typing import Literal


def trigger_level_fill(
    trigger_series: Sequence[float],
    traded_series: Sequence[float],
    trigger_open: float,
    traded_open: float,
    bar: int,
    level: float,
) -> float:
    """Interpolates the traded series' price at the instant the trigger
    series crossed `level` within this bar, assuming a linear move across
    the bar. "Start of bar" is the previous bar's close, or the session's
    pre-bar open snapshot when `bar == 0`.

    If the trigger series didn't rise over the bar (`span <= 0`), there's no
    proportional move to interpolate against — fall back to the traded
    series' own bar close (matches the reference's fallback branch exactly).

    For a dynamic-anchor ladder (`ref.at` in `running_low`/`running_high`),
    callers pass `level = trigger_series[bar]` (the trigger's own value at
    the firing bar, per the reference) — this makes `frac` evaluate to
    exactly 1.0 whenever `span > 0`, so the result degenerates to
    `traded_series[bar]` (a flat bar close) by construction, not as a
    special case handled here.
    """
    prev_trigger = trigger_series[bar - 1] if bar else trigger_open
    prev_traded = traded_series[bar - 1] if bar else traded_open
    span = trigger_series[bar] - prev_trigger
    if span <= 0:
        return traded_series[bar]
    frac = max(0.0, min(1.0, (level - prev_trigger) / span))
    return prev_traded + frac * (traded_series[bar] - prev_traded)


def bar_close_fill(traded_series: Sequence[float], bar: int) -> float:
    """Flat, unconditional bar-close fill — no interpolation. Also used
    verbatim for fallback fills, which bypass `trigger_level_fill` entirely
    in the reference (`tag == "fb"` reads `strang[b]` directly)."""
    return traded_series[bar]


def worst_of_bar_fill(bar_high: float, bar_low: float, side: Literal["BUY", "SELL"]) -> float:
    """Not golden-verified. A short (SELL) leg's worst fill within the bar's
    range is the bar's high (receiving the least premium); a long (BUY)
    leg's worst is the bar's low (paying the most)."""
    return bar_high if side == "SELL" else bar_low


def next_open_fill(next_bar_open: float | None, this_bar_close: float) -> float:
    """Not golden-verified. Fills at the next bar's open; falls back to this
    bar's own close if triggering on the session's last bar (no next bar
    exists) rather than raising — a same-day exit must always produce a
    price."""
    return next_bar_open if next_bar_open is not None else this_bar_close


def apply_slippage(price: float, slippage_bps: float, side: Literal["BUY", "SELL"]) -> float:
    """Slippage always moves the fill against the position. Not exercised by
    the golden fixture (every committed strategy uses `slippage_bps: 0`) —
    `slippage_bps` in the YAML is always a positive magnitude, never a
    signed adjustment; the sign here is derived from `side`, not the input."""
    if slippage_bps == 0:
        return price
    adj = price * (slippage_bps / 10_000.0)
    return price - adj if side == "SELL" else price + adj
