# BL-065 — DRB with 2 lots per strategy (3 strategies × 2 lots) to cut charges

| | |
|---|---|
| **Priority** | P2 — options research; follows BL-064 |
| **Status** | In progress (descriptive; same already-seen window, owner override) |
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
- **Result:** (after the run)

## Log

- 2026-10-09 — created from the owner's request to run 6 lots as 3 strategies of 2 lots.
