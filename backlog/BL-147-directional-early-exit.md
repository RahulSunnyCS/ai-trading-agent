# BL-147 — Close the directional strategies at 14:55 instead of 15:28: what would it have changed?

| | |
|---|---|
| **Priority** | P1 — the owner trades T1's and Core's directional picks with real money and suspects a late-session recovery |
| **Status** | Done: the 14:55 exit hurts (-122 per trade-day [-168, -76]); helps only on late-recovery days (about 9%) |
| **Type** | research |
| **Area** | options |
| **Created** | 2026-10-21 |
| **Depends on** | BL-144 (the re-scored T1 / Core picks), BL-113, BL-058 |
| **TODO.md row** | §3.40 |

## Context

Owner idea, 2026-10-21: after about 15:00 the market often turns around a little (a recovery after a
fall), which can eat into a directional position; would closing the directional strategies at 14:55 help?
"Directional" here is the repo's Dir family: Dir ATM (`N_dir`, `S_dir`, T1's `N_dir-t1s29`) and Dir ITM1
(`N_ditm1`, `S_ditm1`, T1's `N_ditm1-t1s36`, `S_ditm1-t1s44`): short ATM or ITM1 CE and PE, 21% stop per
leg, one re-entry at cost, a ₹3,000 overall stop, exit 15:28 today.

## Goal

A verdict on the 14:55 exit for the picked directional trades and for every directional variant, with the
breakdown the owner described (the day's trend and what happens in the last 33 minutes).

## Out of scope

Other exit times (14:30, 15:10 and so on: a sweep is not asked for), any other family (Widesl, Buy), changing a
pick, a strategy file or a list, charges, a basket stop.

## Plan

### Phase 0 — Pre-register (committed before any figure of this item is computed)

- **Hypothesis:** exiting directional strategies at 14:55 instead of 15:28 raises their result and lowers
  their drawdown.
- **Method:** rerun each directional variant over every stored day with only `exit_time` changed to 14:55 (the
  legwise engine, the sizing date and reference data the nightly update uses; nothing is written to the
  store). A control run at 15:28 on a sample of days must reproduce the stored gross exactly before any
  14:55 figure is read. Per trade-day: delta = gross(14:55 exit) - gross(15:28, stored), per lot, gross, no
  charges. A variant that enters at or after 14:55 is left out.
- **Populations:**
  - **A, the picks:** every Dir-family pick of T1 and, separately, of Core, on the days they were picked
    (the journal's entry where there is one, else re-scored as in BL-144), 2025-01-10 to 2026-10-19. T1's
    figures before 2025-10-09 are in-sample for its settings and are shown apart.
  - **B, breadth:** all Dir-family variants (Core-298's `N_dir`, `N_ditm1`, `S_dir`, `S_ditm1`, 25 start
    slots each, plus T1's `N_dir-t1s29`, `N_ditm1-t1s36`, `S_ditm1-t1s44`), every stored weekday session
    from 2024-10-09 to 2026-10-19.
- **Verdict rule ("closing at 14:55 helps"):** all of
  1. population A (T1 and Core pooled): the mean delta per trade-day is above zero and its 90% circular
     5-day block bootstrap interval (2,000 resamples, seed 20261021, resampling days) is above zero;
  2. the max drawdown of A's daily directional stream (the sum of the day's directional picks' gross) with the
     14:55 exit is no deeper than with the 15:28 exit;
  3. in B, at least 60% of the variants have a positive mean delta.
  **"Hurts"** if A's interval is entirely below zero. Anything else: **inconclusive**, with which condition
  failed.
- **The owner's pattern (descriptive, thresholds fixed here):** the day's trend = NIFTY's move from the 09:15
  open to the 14:55 price: **down** at -0.3% or lower, **up** at +0.3% or higher, else flat. The late move =
  the 14:55 price to the close. A **recovery** = a down day with a late move of +0.1% or more; a **fade** = an
  up day with a late move of -0.1% or less; the rest is continuation or flat. Reported: how often each
  occurs, and the mean delta of A and of B on those days. No pass/kill rule on this part.
- **Also reported:** the share of trade-days with delta above zero; the best and worst delta; delta split
  by whether the trade was in profit at 14:55.
- **Look-ahead:** the exit is a fixed clock time; the trend and late-move classes use prices up to 14:55 and
  the close only to label outcomes, never to choose a trade.
- **Will not run:** other exit times, other trend or late-move thresholds, other families, conditioning an
  exit on the trend.

### Phase 1 — Run and write up

- **Deliverables:** `research/bl147/run.py` (writes only under its own `out/`), findings page
  `research/options/common/directional-early-exit.md` and its index row.
- **Done when:** the verdict and the breakdown are written against the rules above.

## Risks

Re-running 175 variants over two years takes a while; a re-scored T1 is not forward; T1's directional
settings were chosen on the first year; the pattern the owner describes may occur on few days.

## Open questions

None.

## Log

- 2026-10-21 — created and pre-registered before any run. Owner left the choice of picks and method to me.
- 2026-10-21 — ran (`research/bl147/run.py`). Control: 4,025 unchanged reruns match the stored 15:28 results
  exactly. A pooled (710 pick-days): mean delta -121.8 per trade-day [-168.3, -76.4], total +436,602 -> +350,112,
  max drawdown -33,379 -> -41,322. B: all 161 variants have a negative mean delta (-103 on average), 0%
  positive. Verdict: **hurts** (the interval is below zero). The owner's pattern: down day then recovery
  (8.9% of days) +219 per pick-day, up day then fade (7.3%) +217, every other day type -148 to -228; all down
  days together -127. Findings page `research/options/common/directional-early-exit.md`.
- 2026-10-21 — **addendum, registered before it was computed** (owner: "if Nifty or Sensex fall more than 0.6
  percent at 14:55, would that be better"). A conditional exit on the 14:55 reruns already stored in
  `out/deltas.csv`. **Rule:** a Dir-family strategy exits at 14:55 only when its own index (NIFTY for the N
  variants, SENSEX for the S variants) is down 0.6% or more from the 09:15 open to the 14:55 price; on every
  other day it holds to 15:28 as today. The change on a day is the 14:55 delta on triggered days and zero
  otherwise. A second reading, fixed now and reported beside it: the same threshold measured from the previous
  close. **Better** if all of: (1) the mean delta over triggered pick-days of population A (T1 and Core pooled)
  is above zero and its 90% circular 5-day block bootstrap interval (2,000 resamples, seed 20261021, resampling
  days) is above zero; (2) A's daily directional stream has a max drawdown no deeper than with the 15:28 exit;
  (3) at least 60% of the Dir variants that have triggered days have a positive mean delta on them. With fewer
  than 15 triggered days in A the verdict is "too few days" and the numbers are shown only. Reported too: the
  share of days that trigger, the best and worst triggered delta, the mean delta by family. No other threshold
  is run (a different threshold needs a dated line here first); the mirror (up 0.6% or more) was not asked for.
- 2026-10-21 — addendum ran (`research/bl147/conditional.py`, `out/conditional.json`): exit at 14:55 only if the
  index is down 0.6% or more. From the open: 15.4% of variant-days trigger; picks' mean change per triggered
  pick-day -153 [-336, +15] (101 pick-days, 54 days), drawdown -33,379 -> -45,260, 4 of 161 variants positive:
  **not better**. From the previous close: -222 [-341, -108], 0 of 161 positive. Added to the findings page.

