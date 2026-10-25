# Gap-and-go: ITM strike and premium stops

**Status:** Tested (one setting, killed) · **Last updated:** 2026-10-25

## What it is

Every trade buys the 150-point in-the-money weekly (`strike_type: ITM3` at NIFTY's 50-point step), one lot
at today's lot size, with a −30% stop, a peak trail (once above 105% of entry, out at 80% of the highest:
legwise `trail_peak: {activate_percent: 105, exit_percent: 80}`), all judged on the 1-minute close
(`stop_on: close`), out at 15:15. `trail_peak` and `stop_on` were added to the legwise engine for BL-164;
both are off by default and refused by the AlgoTest and Quantiply exporters.

## Live value

None.

## Tested

| Item | Values tried | Data / period | Verdict | Evidence |
|---|---|---|---|---|
| Strike and exits | the published values only | NIFTY, 2024-10-09 to 2026-10-08 | Killed with the rules they were tested in | [BL-164][bl164] Result |

## What we know

- Checked by hand in the pilot month: strikes were 139–173 points in the money at the entry spot; stops
  filled at the first close below 70% of entry; trail exits at 80% of the closing peak.
- No other strike, stop or trail was run, so this page says nothing about which setting would be better.
- Closes rather than ticks was the owner's choice (as published), although BL-156 found close-checked leg
  stops worse for the sellers' legs.

## Not yet tested

- ATM or premium-based strikes, other stops and trails (will-not-run in BL-164).

## Related

- [Buy breakout: strike / premium](../buy-breakout/strike-premium.md), [trail](../buy-breakout/trail.md).

[bl164]: ../../../../backlog/BL-164-gap-and-go-williams-chain.md
