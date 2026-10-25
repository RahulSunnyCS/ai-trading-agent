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
| Strike: closest premium ₹80 / ₹100 / ₹120, all days and expiry days; next-week expiry on expiry days | 10 variants, exploratory (owner override) | NIFTY, both periods (next week: 2024–26 only) | No lead: no variant t ≥ 2.0 in both periods; every premium variant flips sign between them | [BL-165][bl165] Log |

## What we know

- Checked by hand in the pilot month: strikes were 139–173 points in the money at the entry spot; stops
  filled at the first close below 70% of entry; trail exits at 80% of the closing peak.
- The premium strikes (BL-165's exploratory screen) lost on 2024–26 (−₹154 to −₹245 a trade, 31–34% winners)
  and made money on 2022–24 (+₹356 to +₹394, 37–42%): the period, not the strike, sets the sign. ₹80 on
  2022–24 reached t 2.24, but it is −1.14 on 2024–26.
- Next week's options on expiry day (2024–26 only; the 2022–24 vendor files have no next-week chain):
  ITM3 won 52% of 23 trades, +₹761 a trade, t 0.71, −₹847 without its best three. Thin.
- No other stop or trail was run.
- Closes rather than ticks was the owner's choice (as published), although BL-156 found close-checked leg
  stops worse for the sellers' legs.

## Not yet tested

- ATM or premium-based strikes, other stops and trails (will-not-run in BL-164).

## Related

- [Buy breakout: strike / premium](../buy-breakout/strike-premium.md), [trail](../buy-breakout/trail.md).

[bl164]: ../../../../backlog/BL-164-gap-and-go-williams-chain.md
[bl165]: ../../../../backlog/BL-165-gap-and-go-leads-gap-down-and-expiry.md
