# Market structure: higher highs and higher lows (NIFTY, ATM buys)

**Last updated:** 2026-10-25 · **Status:** Tested (killed) · Item: [BL-166][bl166]

## Definition

The owner's idea of 2026-10-25, one registered rule (`packages/option-backtesting/research/bl166/specs.py`):
swings on 5-minute NIFTY bars (a bar whose high, or low, is beyond the two bars on each side, known two bars
later); when the last two swing highs and the last two swing lows are both rising, buy the weekly ATM call on
the first 1-minute close above the latest swing high (mirrored for puts), 09:40 to 14:00. Exit on a close back
through the latest swing low (high), a −30% premium stop, or 15:15.

## What we know in one paragraph

It does not pay. Over 2024-10-09 to 2026-10-08, after charges, 399 trades made +₹27 a trade (t 0.20), 30% of
them winners, and it loses at 0.5% slippage. It fires on most days, so the structure filter selects little.
Entering at the break beats the same trade at a random later minute (every draw, mean −₹165), as in the other
breakout studies, but that is not enough to make money. The locked 2022 to 2024 period was not opened.

## Variables

| Variable | Status | One-line takeaway |
|---|---|---|
| [Structure and the swing break](structure-break.md) | Tested (killed) | 5-minute fractal swings, break of the last swing: +₹27 a trade, t 0.20 |

## Reproduce

Git-ignored outputs. `packages/option-backtesting/research/bl166/`: `specs.py`, `pilot.py` (one month by hand,
0 mismatches), `run.py`. Grammar operator `{swing: {kind, back, minutes, n}}` (`ruletest/expr.py`).

[bl166]: ../../../../backlog/BL-166-higher-high-higher-low-structure.md
