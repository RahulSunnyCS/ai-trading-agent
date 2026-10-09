# BL-065 — DRB with 2 lots per strategy (3 strategies × 2 lots) to cut charges

| | |
|---|---|
| **Priority** | P2 — options research; follows BL-064 |
| **Status** | Done (inconclusive; exploratory: same already-seen year, owner override) |
| **Type** | research |
| **Area** | options |
| **Created** | 2026-10-09 |
| **Depends on** | BL-064 (DRB), BL-063 (charge model) |
| **TODO.md row** | — |

## Context

DRB-6W2 and DRB-6W3 (BL-064) run 6 core lots as 6 separate 1-lot strategies, plus up to 2 Buy lots.
The owner (2026-10-09 chat) asked what happens if the same 6 lots are 3 strategies of 2 lots each, so
that charges fall. What that saves depends on how the broker charges: with brokerage per lot per order
(owner's assumption, ₹13) there is no saving on brokerage, STT or exchange fees (the turnover is the
same); the saving is AlgoTest's per-strategy fee (about ₹19 a strategy-day in the owner's sheet), and
brokerage only if the broker charges per order whatever the lots. Fewer, larger picks also mean less
diversification, which this tests.

## Plan

### Phase 0 — Pre-register
- **Rule:** DRB (BL-064) with a new setting **lots per strategy L = 2**: the core is the top **3**
  Widesl / Dir variants (6 core lots), each traded with 2 lots; the day's P&L from a pick is 2 × its
  1-lot P&L. The Widesl minimum is counted in whole strategies, rounding up: DRB-6W2L2 needs at least
  1 Widesl strategy (2 lots), DRB-6W3L2 needs at least 2 (4 lots). **Buy add-on:** the single best Buy
  variant when it is in the overall top 10 of the list, with 2 lots (up to 2 Buy lots, as before, as one
  strategy). Everything else (248 variants, criteria and weights, window, selection days) as BL-062.
  Names: **DRB-6W2L2**, **DRB-6W3L2**; `--basket DRB-6W2L2`.
- **Comparators:** as BL-064 (R random picks of 3 strategies × 2 lots under the same minimum, plus the
  Buy strategy on the days DRB bought; E equal weight scaled to the same lots; the live mix at 6 lots).
  DRB-6W2 and DRB-6W3 (1 lot each, 6 strategies) are shown beside them.
- **Pass / kill rule:** BL-057's three conditions, read from each case; reported, not the point.
- **Charges:** BL-063's model with quantity doubled for 2-lot strategies. Shown two ways: brokerage
  ₹13 **per lot** per order (owner's assumption: no brokerage saving) and ₹13 per **order** whatever
  the lots (half the brokerage); GST on brokerage follows. Plus AlgoTest's fee at ₹19 a **strategy**-day
  (so 3 strategies, not 6, are paid for) as a separate line.
- **Outputs:** total, drawdown, worst day and month, monthly return on ₹13 lakh before and after
  charges, beside DRB-6W2 / DRB-6W3 and the owner's real sheet.
- **Hold-out:** none (owner override). **Will not run:** other L values, other minimums, tuning.
- **Result:** **inconclusive** for both (condition 1 and 3 pass, condition 2 fails on drawdown against equal weight,
  as BL-057); exploratory (same already-seen year). Regression: `--basket DRB-5W2`, `DRB-6W3` and the
  default 66-variant run reproduce ₹3,36,113 / ₹3,77,386 / ₹3,31,842 exactly. 202 selection days; the Buy
  strategy (one, 2 lots) on 48 days; 6.48 lots and 3.24 strategies a day. **DRB-6W2L2** (at least 1 Widesl
  strategy = 2 lots): gross ₹4,42,628 (+34.0% of ₹13 lakh), max drawdown −₹79,086 (6.1%), worst day −₹19,757,
  ₹338 per lot-day, 10 of 11 months positive, worst month −2.1%; R (3 × 2 lots) P50 ₹1,86,134 / P90 ₹2,82,865,
  beats 100%; E ₹1,88,289 / −₹64,122; live mix at 6 lots ₹2,32,014 / −₹2,08,439. **DRB-6W3L2** (at least 2 Widesl
  strategies = 4 lots): gross ₹4,30,868 (+33.1%), drawdown −₹68,294 (5.3%), worst day −₹19,368, ₹329 per
  lot-day, 62.4% winning days, 9 of 11 months positive, worst month −1.1%; R P90 ₹2,70,198, beats 100%.
  Against the 6 × 1-lot baskets (BL-064): DRB-6W2 ₹3,53,009 / −₹55,784, DRB-6W3 ₹3,77,386 / −₹60,251 — the
  top-3 picks earned more per lot than picks 4–6 (₹338 vs ₹274 and ₹329 vs ₹293 a lot-day) at 20–40%
  deeper drawdown. **After charges** (BL-063 model, ₹13 per lot per order, doubled quantity): DRB-6W2L2 charges
  ₹1,34,091 (30% of gross), net ₹3,08,537 (+23.7%), drawdown −₹1,21,640 (9.4%), 9 of 11 months positive, worst
  month −3.20%; DRB-6W3L2 charges ₹1,23,781 (29%), net ₹3,07,087 (+23.6%), drawdown −₹92,323 (7.1%), 8 of 11,
  worst month −2.07%. For comparison DRB-6W2 net ₹2,20,934 (+17.0%, drawdown −₹82,980) and DRB-6W3 net
  ₹2,49,942 (+19.2%, −₹72,220). **Charge saving:** with brokerage per lot per order, 3 × 2 lots saves none
  (charges ₹1,34,091 vs ₹1,32,075 for 6W2; ₹1,23,781 vs ₹1,27,445 for 6W3: same quantity, same turnover). It
  saves AlgoTest's per-strategy fee (₹19 × 3.24 vs 6.38 strategies a day: ₹12,046 over 202 days) and, if the broker
  charges ₹13 per ORDER whatever the lots, half the brokerage: charges ₹88,041 / ₹80,461, net ₹3,54,588 (+27.3%,
  drawdown −₹1,03,232) / ₹3,50,407 (+27.0%, −₹84,469). With the platform fee ₹19 per strategy-day on top of the
  per-lot case: net ₹2,96,111 (+22.8%) / ₹2,94,661 (+22.7%). Scripts: `rotate.py --basket DRB-6W2L2`,
  `research/bl063/` (strategies per day, flat-brokerage column).

## Log

- 2026-10-09 — created from the owner's request to run 6 lots as 3 strategies of 2 lots.
- 2026-10-09 — DRB-6W2L2 and DRB-6W3L2 ran; charges applied (Result above).
