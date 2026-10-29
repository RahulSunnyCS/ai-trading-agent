# Directional: stop-and-reverse (buy the stopped option)

**Status:** Tested · **Last updated:** 2026-10-29

## What it is

When a sold Dir leg hits its stop, buy the same contract at the stop price instead of only closing it: a
stopped CE turns into a long CE, so a real breakout keeps paying the book. The long has its own 30% stop on
its premium and an exit (a time stop, a peak trail, or held to 15:28); it counts in the overall MTM stop; a
leg that reversed is not re-sold by RE COST. Set by the leg-wise engine's `legs[].reverse_on_sl:
{lots_ratio, stop_loss_percent, time_stop_minutes, trail_peak}` (sold legs only, off by default; BL-186).
The AlgoTest and Quantiply exports refuse it: no platform form for a conditional buy on a stop fill has been
captured.

## Live value

Not used. Live and rotation Dir files close a stopped leg and re-sell it once at cost (`reentry_on_sl: { mode:
cost, count: 1 }`, [re-entry](re-entry.md)); T1's own Dir settings re-sell it twice (`count: 2`).

## Tested

| Item | Values tried | Data / period | Verdict | Evidence |
|---|---|---|---|---|
| BL-186 | Blanket reverse (B); filtered at the stop minute by the opening-range break (C1), the VWAP side (C2) or rising ATM IV (C3); half size (D); × a 20 / 30 / 45-minute time stop, a 150% / 80% peak trail, or hold; all at a ₹5,000 overall stop against the plain exit at ₹5,000 (A5) and at each file's own stop (A3) | T1's Adaptive picks (Dir picks changed, Widesl and Buy carried), 2025-01-10 → 2026-07-22 (375 days, 321 Dir pick-days), hold-out 2026-07-23 → 2026-10-22; 1 lot, after ₹20 + GST an order | **Killed.** Primary (C1 / C2 / C3 with a 30-minute stop − A5): +₹45 [−123, +226], −₹153 [−393, +88], −₹45 [−206, +118] a day, none significant under Holm, all with a deeper max drawdown (−₹41.2k / −₹46.0k / −₹32.8k against −₹26.2k). Hold-out: +₹85, +₹294, −₹297, none significant, all deeper | [BL-186][bl186] |

## What we know

- **The long itself earns, the book does not.** Its own net is +₹104 (C1), +₹135 (C2) and +₹116 (C3) a Dir
  pick in the main period (after its two orders), winning 43–46% of reversals. The rest of the Dir book loses
  more than that (−₹44, −₹268, −₹144 a day), because the reversed leg is no longer re-sold at cost, and a
  whipsawed long (its 30% stop) pushes the book into the overall stop and closes the surviving short leg early.
  Registered, after brokerage.
- **Blanket reversal loses** in every exit (−₹170 to −₹302 a day against A5), as expected before the run; half
  size (D) is worse than full size, not between it and the plain exit, since the RE COST loss stays whole while
  the long's gain halves. Secondary cells, descriptive.
- **The only lead is C1 held to the exit:** +₹231 [−28, +491] a day in the main period, +₹342 in the hold-out,
  but with a max drawdown of −₹50.0k (main) against −₹26.2k. C1's net and drawdown both grow with the holding
  time. Not registered; it needs its own pre-registration and an answer on drawdown before anything live.
- The lines move the same way: with BL-063 statutory charges +₹42 / −₹157 / −₹47; with 1% slippage on the buy
  +₹10 / −₹239 / −₹84; expiry days left out +₹43 / −₹236 / −₹23 (C1 / C2 / C3, main period). C2's VWAP uses
  the chain's option volume as weights (the index has none); a plain TWAP gives the same answer.

## Not yet tested

- C1 held to the exit as a registered rule (the descriptive lead above).
- A reversal that keeps RE COST for the short as well (the long and the re-sale side by side).
- Live: a conditional buy on the stop fill in Quantiply or AlgoTest. Not worth building on this result.

## Related

- [Leg stop](leg-sl.md), [re-entry](re-entry.md), [overall MTM stop](mtm-sl.md) (the ₹5,000 stop used here).
- Buy-side peak trail: [Buy breakout trail](../buy-breakout/trail.md) (`trail_peak`, BL-164).
- Scripts: `packages/option-backtesting/research/bl186/` (`run.py simulate`, `run.py report --period
  main|holdout`); outputs under its `out/` are not committed, regenerate with `run.py simulate` (about 70
  minutes, one worker).

[bl186]: ../../../../backlog/BL-186-dir-stop-and-reverse.md
