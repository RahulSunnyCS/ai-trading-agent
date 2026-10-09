# BL-061 — Daily rotation with closest-premium Widesl in the candidate list

| | |
|---|---|
| **Priority** | P2 — options research; extends BL-057 |
| **Status** | Done (descriptive; same already-seen window, owner override) |
| **Type** | research |
| **Area** | options |
| **Created** | 2026-10-09 |
| **Depends on** | BL-057 (the rule), BL-055 (NIFTY closest-premium Widesl), BL-060 (SENSEX closest-premium Widesl) |
| **TODO.md row** | — |

## Context

The BL-057 daily rotation chooses 5 core lots a day from 66 variants, with only the OTM-strike
Widesl (NIFTY OTM1, SENSEX OTM2). The owner (2026-10-09 chat) asked what happens when the
closest-premium Widesl (BL-055, BL-060) joins the candidate list: on average how many of the 5
daily lots go to a closest-premium Widesl instead of an OTM one (one a day is 20%), and whether
they are picked more on particular days — expiry day, a weekday, a VIX band.

## Goal

The share of core lots taken by closest-premium Widesl, overall and by weekday, days to expiry and
VIX band, plus the rotation's P&L and drawdown beside BL-057's.

## Out of scope

Late start times (after 11:47), other premiums, the 3-lot version, other Widesl minimums, any
change to the frozen BL-058 forward rule.

## Plan

### Phase 0 — Pre-register
- **Hypothesis:** none; descriptive. The questions are the share and where it concentrates.
- **Universe:** the 66 BL-057 variants plus **44 closest-premium Widesl**: NIFTY ₹80 and ₹100
  (BL-055's levels) and SENSEX ₹250 and ₹320 (BL-060's), each at the 11 start times 09:17–11:47,
  built from the live Widesl files with both legs' strike set by closest premium and nothing else
  changed. 110 variants: 66 Widesl (22 OTM + 44 closest premium), 22 Dir ATM, 22 Buy. 1 lot,
  today's lot size, 1-minute bars, 2024-10-09 → 2026-10-08 run; rotation window 2025-09-01 →
  2026-10-08, selection from the 64th day, same common-days rule as BL-057; before charges.
- **Rule:** BL-057's first block unchanged except the universe: four criteria and weights
  (33 / 25 / 25 / 17), same lookbacks, percentile ranks across the 110; core = top 5 of the 88
  Widesl and Dir variants; "Widesl" for the at-least-2 minimum means any Widesl, OTM or closest
  premium; Buy add-on = up to 2 Buy variants that are in the overall top 10 of 110.
- **Look-ahead check:** as BL-057 (rows before the day, plus the day's own weekday, days to expiry
  and 09:15 VIX open).
- **Comparators:** as BL-057, drawn from the larger lists (R random picks 1,000 runs under the same
  constraint; E equal weight over the 88; B2 the live 3 Widesl + 2 Dir mix); the first-block rotation
  (₹3,31,842, max drawdown −₹57,153) is shown beside them.
- **Outputs:** (1) closest-premium share of core lots: overall, by index, and per day (average
  lots and days with at least one); (2) the same share by weekday, by the pick's own index days to
  expiry (0, 1, 2 …), and by VIX band, with day counts; (3) average P&L per lot when a
  closest-premium Widesl was picked vs an OTM Widesl; (4) the rotation's total, drawdown, worst day
  and percentile among random picks, beside BL-057's.
- **Pass / kill rule:** BL-057's, read from this run, reported but not the point of the item.
- **Hold-out:** none (owner override, same window).
- **Will not run:** 24-slot or late-start universe, other premiums, other minimums, 3-lot version.
- **Result:** descriptive. 110 variants (all 22 NIFTY and 48 SENSEX closest-premium runs finished,
  no errors), 265 common weekdays, selection 2025-12-03 → 2026-10-08, 202 days; Buy add-on fired on 59
  days (BL-057: 89), 5.47 lots a day. **Share of core lots (case A):** closest-premium Widesl took
  **35%** of the 5 daily lots (average 1.76 lots a day; at least one on 167 of 202 days = 83%; lots per
  day 0 / 1 / 2 / 3 / 4 / 5 on 35 / 54 / 62 / 31 / 15 / 5 days) and 61% of the Widesl lots (584 Widesl
  lots, 426 Dir). A blind pick would give 50% of core lots and 67% of Widesl lots, so the rotation
  took them slightly less than chance. By index: NIFTY 38%, SENSEX 32%. **By weekday** (share of core
  lots | of Widesl lots): Mon 28 | 54, Tue 44 | 66, Wed 32 | 59, Thu 43 | 71, Fri 30 | 53. **By the pick's
  own index days to expiry** (0 = expiry day): 0 → 47 | 72 (84 days), 1 → 37 | 64, 2 → 17 | 50, 3 → 20 | 60,
  4 → 36 | 51, 5 → 29 | 53, 6 → 23 | 46. **By VIX band:** <10.5 35, 10.5–11.5 40, 11.5–13 41, 13–15 33,
  15–18 27, 18+ 33. Average P&L per lot when picked: OTM Widesl ₹285 (228 lots), Dir ATM ₹256 (426),
  closest-premium Widesl ₹200 (356; win 58% vs 61% / 60%). **Performance, case A:** ₹2,56,510, max
  drawdown −₹1,01,871, worst day −₹15,989, ₹232 per lot-day; R (110 variants) P50 ₹1,37,304 / P90
  ₹2,06,183, beats 98% → (1) passes; E ₹1,37,261 / DD −₹79,162 → (2) fails on drawdown; B2 ₹1,85,540 /
  DD −₹1,67,246 → (3) passes; INCONCLUSIVE, as BL-057. Against BL-057's 66-variant rotation (₹3,31,842,
  DD −₹57,153, ₹288 per lot-day) adding the closest-premium Widesl lowered the total by ₹75,332 and
  nearly doubled the drawdown; core members changed per day 3.67 of 5 (BL-057: 3.25). Per-criterion
  signal: recent +0.046, weekday +0.019, dte +0.001, VIX +0.015, composite +0.032. Reading: the
  rotation prefers closest-premium Widesl on expiry days and the expiry weekdays (Tue NIFTY, Thu
  SENSEX) and rarely on days 2–3 before expiry; a plausible reason is that near expiry a fixed-premium
  rule sells strikes much closer to the money than OTM1 / OTM2 do, which is a different position
  there (not tested here). Scripts: `rotate.py --closest`, `research/bl061/`.

### Phase 1 — Missing runs
- NIFTY ₹80 and ₹100 at the 11 morning start times (22 runs; the 3 BL-055 start times are re-run
  for consistent per-day files). SENSEX ₹250 / ₹320 come from BL-060.

### Phase 2 — Rotation run and report
- Extend `research/bl057/rotate.py` with an opt-in `--closest` universe (default unchanged) and the
  share report. Done when the default still reproduces ₹3,31,842 and the report is in Result.

## Risks

- A bigger list dilutes the percentile ranks and the "top 10 of the universe" Buy trigger; reported
  as is, not tuned.
- Closest-premium variants are close relatives of the OTM ones (same entry time, similar legs), so
  a high share may mean substitution, not new information.

## Log

- 2026-10-09 — created from the owner's request to put the closest-premium versions in the daily
  list and measure their share.
- 2026-10-09 — NIFTY runs finished 19:53; `rotate.py --closest` ran (Result above).
