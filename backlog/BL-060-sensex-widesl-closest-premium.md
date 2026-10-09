# BL-060 — SENSEX Widesl by closest premium (₹250 and ₹320) across the whole day

| | |
|---|---|
| **Priority** | P2 — options research; completes the SENSEX side of BL-055 |
| **Status** | In progress (descriptive; same already-seen window, owner override) |
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
- **Result:** (after the run)

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
