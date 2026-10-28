# Market structure: the structure and the swing break

**Status:** Tested (killed) · **Last updated:** 2026-10-25

## What it is

Swing highs and lows are 5-minute fractals with two bars on each side (`{swing: {kind: high | low, back: 0 |
1, minutes: 5, n: 2}}`), known from the close of the second bar after the swing. Structure is up when
`sh0 > sh1` and `sl0 > sl1`; the trade is the first 1-minute close beyond `sh0` (up) or `sl0` (down), and the
exit is a close back through the opposite latest swing (`exit_when`). The owner chose the bar size, the swing
rule, the entry and the exit; the ATM strike and the −30% backstop were fixed in [BL-166][bl166] Phase 0.

## Live value

None.

## Tested

| Item | Values tried | Data / period | Verdict | Evidence |
|---|---|---|---|---|
| S1 | one rule as registered | NIFTY, 2024-10-09 to 2026-10-08, BL-063 charges, 1 lot | Killed: +₹27 a trade, t 0.20 (399 trades) | [BL-166][bl166] Result |

## What we know

- 399 trades in 489 sessions; 30% winners; median −₹642; −₹132 a trade without the best three; −₹46 at
  0.5% slippage.
- Against the same trade at a random later minute the break wins on every draw (later minutes average
  −₹165; `research/bl166/after_event.py`). The tester's own figure (percentile 0.00, draws +₹287) mixed in
  minutes before the event, traded on the side the later break revealed, so it is not used (BL-166 Log,
  2026-10-26).
- Description only: up side +₹191, down −₹129; expiry days +₹518 (80 trades), other days −₹96; the
  half-years fade from +₹275 to −₹164.

## Not yet tested

- Other bar sizes, swing widths, entry at the higher low, other strikes or stops; SENSEX (will-not-run in
  BL-166).

## Related

- [Five-minute breakout](../breakout/README.md) (BL-152), [gap-and-go](../gap-and-go/README.md) (BL-164).

[bl166]: ../../../../backlog/BL-166-higher-high-higher-low-structure.md
