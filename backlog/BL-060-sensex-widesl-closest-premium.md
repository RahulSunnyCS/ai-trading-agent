# BL-060 — SENSEX Widesl by closest premium (₹250 and ₹320) across the whole day

| | |
|---|---|
| **Priority** | P2 — options research; completes the SENSEX side of BL-055 |
| **Status** | Done (descriptive; same already-seen window, owner override) |
| **Type** | research |
| **Area** | options |
| **Created** | 2026-10-09 |
| **Depends on** | BL-055 (NIFTY closest-premium Widesl), BL-056 and BL-059 (SENSEX OTM2 Widesl, the comparison) |
| **TODO.md row** | — |

## Context

BL-055 ran the NIFTY Widesl with the strike chosen by closest premium (₹80 and ₹100) instead of
OTM1; it earned 4–19% less and usually had the smaller drawdown. The SENSEX Widesl built for
BL-056 and BL-059 only used the live OTM2 strike. The owner (2026-10-09 chat) asked for the
SENSEX equivalent at about 3× NIFTY's premium. Measured: SENSEX's ATM straddle is 3.2–3.3× NIFTY's
at every time of day (09:15: 855 vs 258 points; 15:00: 660 vs 204; checked on the nearest weekly
since 2025-09-01), so NIFTY's ₹80 and ₹100 correspond to about ₹255–265 and ₹320–330.

## Goal

For the SENSEX Widesl: per start time, the P&L and drawdown of strike-by-premium (₹250, ₹320)
beside the live OTM2 strike, so the strike choice can be read at every start time from 09:17 to
15:02.

## Out of scope

Other premium levels, Dir and Buy, any rotation or stop-loss mix with the new variants (a later
block), NIFTY.

## Plan

### Phase 0 — Pre-register
- **Hypothesis:** none; descriptive. The question is whether choosing the SENSEX strikes by closest
  premium changes profit and drawdown relative to OTM2, as it did for NIFTY relative to OTM1.
- **Universe:** 48 new variants = {₹250, ₹320} × 24 start times (09:17, 09:32 … 11:47, then 12:02 …
  15:02) of SENSEX Widesl: `strategies/legwise/sensex_widesl_917_otm2.yaml` with both legs'
  `strike` replaced by `{ closest_premium: 250 }` or `{ closest_premium: 320 }`, and `entry_time`
  changed; everything else as the live file (SL 114 % call / 115 % put trailed 15/10 %, ₹2,500
  overall, exit 15:28, slippage 0). 1 lot, today's lot size, 1-minute bars, usable days,
  2024-10-09 → 2026-10-08 run; analysis window 2025-09-01 → 2026-10-08, weekend sessions dropped,
  before charges. Comparison: the existing 24 SENSEX OTM2 Widesl variants (BL-056, BL-059).
- **Premium levels:** ₹250 and ₹320 (owner's choice, from his 3× / 240–250 estimate and the
  measured 3.2–3.3× ratio).
- **Outputs:** (1) per start time and strike rule: days, total, average per day, win %, worst day,
  drawdown of the days chained, first-half and second-half averages; (2) window means (09:17–11:47,
  12:02–13:47, 14:02–15:02) for OTM2, ₹250 and ₹320, with the count of start times positive in both
  halves; (3) the BL-056 weekday / days-to-expiry / VIX-band tables as family means; (4) the average
  entry premium per leg for a sample of sessions per rule, to confirm the closest-premium choice
  lands near the target.
- **Pass / kill rule:** none. Reconciliation only: cell totals equal each variant's total; the
  OTM2 variants are read from the existing results unchanged.
- **Hold-out:** none (owner override, same window).
- **Will not run:** other premiums, Dir / Buy, NIFTY, any rotation or stop-loss mix, charges.
- **Result:** descriptive, no verdict. All 48 runs finished (489 days each, 3 skipped by the engine as for
  the OTM2 variants, no errors); window 2025-09-01 → 2026-10-08, 267 weekdays; the 09:17 OTM2 total
  reconciles with BL-056. Mean of the start-time averages in each window (₹/day | average max drawdown |
  start times positive in both halves), OTM2 / ₹250 / ₹320: 09:17–11:47 67 | −34,200 | 5 of 11 /
  58 | −39,764 | 6 of 11 / 31 | −48,709 | 2 of 11; 12:02–13:47 94 | −22,462 | 4 of 8 / 153 | −19,087 |
  6 of 8 / 108 | −25,574 | 3 of 8; 14:02–15:02 103 | −14,561 | 2 of 5 / 156 | −9,410 | 4 of 5 / 153 |
  −10,095 | 5 of 5. Over all 24 start times: ₹250 averages ₹110/day against OTM2's ₹84 (higher on 17 of 24
  start times, smaller drawdown on 14 of 24, average drawdown −₹26,548 vs −₹26,196); ₹320 averages
  ₹82 (higher on 13 of 24, smaller drawdown on only 7, average drawdown −₹32,953). Rank correlation of
  first-half and second-half averages across the 24 start times: OTM2 −0.01, ₹250 +0.25, ₹320 +0.09.
  By weekday, days to expiry and VIX band all three rules show the same shape as OTM2 (Thursday and
  expiry day best, Monday and Friday negative, 15–18 VIX worst at about −₹330 to −₹376); ₹250 is a
  little higher on Thursday (₹374 vs ₹317) and expiry day (₹390 vs ₹328). Average entry premium per leg
  at 09:17 over the last 15 sessions: OTM2 call ₹277 / put ₹228, closest 250 ₹249 / ₹252, closest 320
  ₹323 / ₹320 (the closest-premium rule lands on target and balances the two legs; OTM2 does not).
  Unlike NIFTY (BL-055: closest premium earned less but with a smaller drawdown), SENSEX ₹250 earned
  more at about the same drawdown and ₹320 was no better than OTM2. Scripts:
  `packages/option-backtesting/research/bl060/`.

### Phase 1 — Generate and run the 48 variants (8 in parallel)
- Done when: 48 result files covering the same days as the OTM2 variants.

### Phase 2 — Analysis and report
- Done when: the tables above are in `research/bl060/out/` and the summary is in Result.

## Risks

- A closest-premium rule picks different strikes each day, so ₹ P&L per lot is not comparable
  with OTM2 on exposure; read the comparison with the drawdown beside it.
- Same already-looked-at year: descriptive only.

## Log

- 2026-10-09 — created from the owner's request; premiums and coverage chosen by the owner.
- 2026-10-09 — all 48 runs finished 19:29 and the analysis ran (Result above).
