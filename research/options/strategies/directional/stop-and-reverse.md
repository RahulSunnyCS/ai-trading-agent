# Directional: stop-and-reverse (buy the stopped option)

**Status:** Tested · **Last updated:** 2026-10-29 (Amendment 1)

## What it is

When a sold Dir leg hits its stop, buy the same contract at the stop price instead of only closing it: a
stopped CE turns into a long CE, so a real breakout keeps paying the book. The long has its own 30% stop on
its premium and an exit (a time stop, a peak trail, or held to 15:28); it counts in the overall MTM stop; a
leg that reversed is not re-sold by RE COST. Set by the leg-wise engine's `legs[].reverse_on_sl:
{lots_ratio, stop_loss_percent, time_stop_minutes, trail_peak, strike_premium, resell_after_reverse}` (sold legs only, off by default; BL-186). `strike_premium` buys the strike priced closest to it instead of the same contract (filled at the close of the stop bar); `resell_after_reverse` lets RE COST re-sell the stopped leg once the long has closed.
The AlgoTest and Quantiply exports refuse it: no platform form for a conditional buy on a stop fill has been
captured.

## Live value

Not used. Live and rotation Dir files close a stopped leg and re-sell it once at cost (`reentry_on_sl: { mode:
cost, count: 1 }`, [re-entry](re-entry.md)); T1's own Dir settings re-sell it twice (`count: 2`).

## Tested

| Item | Values tried | Data / period | Verdict | Evidence |
|---|---|---|---|---|
| BL-186 | Blanket reverse (B); filtered at the stop minute by the opening-range break (C1), the VWAP side (C2) or rising ATM IV (C3); half size (D); × a 20 / 30 / 45-minute time stop, a 150% / 80% peak trail, or hold; all at a ₹5,000 overall stop against the plain exit at ₹5,000 (A5) and at each file's own stop (A3) | T1's Adaptive picks (Dir picks changed, Widesl and Buy carried), 2025-01-10 → 2026-07-22 (375 days, 321 Dir pick-days), hold-out 2026-07-23 → 2026-10-22; 1 lot, after ₹20 + GST an order | **Killed.** Primary (C1 / C2 / C3 with a 30-minute stop − A5): +₹45 [−123, +226], −₹153 [−393, +88], −₹45 [−206, +118] a day, none significant under Holm, all with a deeper max drawdown (−₹41.2k / −₹46.0k / −₹32.8k against −₹26.2k). Hold-out: +₹85, +₹294, −₹297, none significant, all deeper | [BL-186][bl186] |
| BL-186 Amendment 1 | A cheaper long: the strike priced closest to ₹50 (₹35–₹70) instead of the same contract; its stop 30% / 50%; a 30-minute stop or held to 15:28; all with the C1 filter; plus RE COST allowed to re-sell after the long closes (on the best cell and on the same-contract C1_T30) | The same T1 Dir picks, **full period** 2025-01-10 → 2026-10-22 (main to 2026-07-22 plus the hold-out; 431 days, 363 Dir pick-days; the hold-out had already been read, so it is exploratory and the full period judges) | **Killed, all six cells.** − A5 per day: +39 [−60, +135], +111 [−25, +249], +42, +133 [−24, +289], +112 (best + re-sale), +94 (same contract + re-sale); none significant under Holm over nine (smallest p 0.16); every max drawdown deeper than A5's −₹26.2k (−₹31.7k to −₹39.0k); `R-C1_T30` flips sign in the hold-out. 14 of 168 stops had no ₹50 strike | [BL-186][bl186] |

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
- **A cheaper long (₹50 strike) does not rescue it** (Amendment 1, full period). It earns less than the same contract
  (+₹41 to +₹163 a Dir pick against +₹93 to +₹309) and draws down less (−₹36k to −₹39k against −₹41k to −₹50k), yet its
  book is still ₹10k+ deeper than the plain exit's −₹26.2k, and the +₹39 to +₹133 a day is not significant. The long's own stop
  (30% or 50%) changes the book by ₹3 to ₹22 a day; holding to 15:28 beats the 30-minute exit by ₹72 to ₹91. Allowing
  RE COST to re-sell after the long closes helps the same-contract C1 cell most (+₹94 against +₹50 a day, drawdown −₹31.7k, the
  shallowest of any reversal cell) but its hold-out difference is −₹11. Nothing here is a lead.
- The lines move the same way: with BL-063 statutory charges +₹42 / −₹157 / −₹47; with 1% slippage on the buy
  +₹10 / −₹239 / −₹84; expiry days left out +₹43 / −₹236 / −₹23 (C1 / C2 / C3, main period). C2's VWAP uses
  the chain's option volume as weights (the index has none); a plain TWAP gives the same answer.

## Not yet tested

- C1 held to the exit as a registered rule (the descriptive lead above); its drawdown is the problem, and a cheaper long
  (Amendment 1) shrinks it only from −₹50.0k to −₹39.0k.
- Live: a conditional buy on the stop fill in Quantiply or AlgoTest. Not worth building on this result.

## Related

- [Leg stop](leg-sl.md), [re-entry](re-entry.md), [overall MTM stop](mtm-sl.md) (the ₹5,000 stop used here).
- Buy-side peak trail: [Buy breakout trail](../buy-breakout/trail.md) (`trail_peak`, BL-164).
- Scripts: `packages/option-backtesting/research/bl186/` (`run.py simulate`, `run.py report --period
  main|holdout`); outputs under its `out/` are not committed, regenerate with `run.py simulate` (about 30
  minutes, one worker); Amendment 1: `amend1.py simulate|best|report` (about 4 minutes after that).

[bl186]: ../../../../backlog/BL-186-dir-stop-and-reverse.md
