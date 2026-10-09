# BL-072 — A blend built around the longer fit lookbacks: recent, family recent, weekday, days-to-expiry, VIX

| | |
|---|---|
| **Priority** | P2 — options research; follows BL-069 |
| **Status** | In progress |
| **Type** | research |
| **Area** | options |
| **Created** | 2026-10-10 |
| **Depends on** | BL-069 (B1 family-pooled recent, B3 longer fit lookbacks), BL-071 (slice, import) |
| **TODO.md row** | — |

## Context

BL-069's B3 (fit criteria without the 5-day window) was the largest in-sample gain (+₹56–66k) and the
only change that also improved the baseline on the Jan–Aug 2025 slice (₹1.70 lakh → ₹2.7 lakh). BL-069's
B1 (family-pooled recent) made recent-only nearly as good as the baseline in-sample (₹4.05 lakh, drawdown
−₹62k) but was the worst row on the slice. The owner (2026-10-10 chat) asked for a blend that gives
the recency signals and the longer-lookback fit signals fixed priorities, and "anything I am missing?".

## Plan

### Phase 0 — Pre-register
- **Rule:** DRB-6W3L2 as BL-065 (248 variants, 3 strategies × 2 lots, at least 2 Widesl, Buy add-on),
  with the composite = Σ weight × percentile rank of five criteria + the sixth listed:
  | Criterion | Meaning | Weight (row 1) |
  |---|---|---|
  | recent | the variant's own recent score (2/3 last 5 days + 1/3 the 5 before) | 25% |
  | recent-family | the mean of that recent score over the variant's family (same index + strike rule, all start times) | 25% |
  | weekday | average P&L on the same weekday, longer lookbacks | 15% |
  | days to expiry | average P&L on the same days-to-expiry label (0 = expiry day), longer lookbacks | 15% |
  | VIX band | average P&L on the same 09:15 VIX band, longer lookbacks | 20% |
  The owner named 80% (25 + 25 + 15 + 15); the remaining 20% is given to VIX band, the criterion left
  out, and the alternative in row 2 splits it 10% VIX / 10% overnight gap (BL-069 B2, placebo-real).
- **Rows (fixed here):** weights recent / recent-family / weekday / dte / VIX / gap =
  (1) 25/25/15/15/20/0, (2) 25/25/15/15/10/10; each with fit lookbacks 21:50,63:50 and with
  63:50,126:50 → **4 rows**. `rotate.py --basket DRB-6W3L2 --weights R,W,D,V,G,RF --fit-lookbacks …`.
- **Conditional overlay:** the BL-069 B7b ladder on paper equity (`--dd-ladder 20000,30000,10000,25000
  --dd-basis shadow`) on the best row by gross ÷ drawdown.
- **Comparators:** base A ₹4,30,868 / −₹68,294 (gross ÷ drawdown 6.31), base A with fit lookbacks
  21:50,63:50 ₹4,97,335 / −₹75,155 and 63:50,126:50 ₹4,86,867 / −₹61,058; the BL-068 shuffle sd
  ₹1,07,880.
- **Read-out:** a row is *a candidate* if gross ÷ max drawdown beats base A's 6.31 **and** its gross is
  within one yardstick of the better of the two B3-only rows; each row is also run with 10 label shuffles
  and counts as *real* only if it beats all 10 (the placebo applied to the fit criteria, and to the gap).
  Every row is also read on the Jan–Aug 2025 slice (`--window-from 2024-10-09`, cut at 2025-09-01) as a
  second look; that slice has been read before, so it can warn but not confirm.
- **Hold-out:** none in-sample. The clean test is the 2022–2024 import (BL-071 part B); no row is adopted
  before it.
- **Will not run:** other weights, other lookbacks, other family definitions.
- **Result:** pending.

### Block 2 — VIX weight on the taken set (2026-10-10, registered before its runs)
- **Why:** block 1's first rows show the owner's 25/25/15/15 blend below the baseline weights with the
  same long lookbacks (₹3.35–3.85 lakh vs ₹4.87–4.97 lakh). The owner asked to evaluate the taken set —
  recent, family recent, weekday, days to expiry, all fit criteria on 63:50,126:50 — with VIX at 0, 10
  and about 15–20, and with the recency split varied.
- **Rows (fixed; weights recent / family / weekday / dte / VIX / gap, lookbacks 63:50,126:50):**
  (a) 30/30/20/20/0/0 — no VIX; (b) 25/25/20/20/10/0 — VIX 10; (c) 25/25/15/15/20/0 — VIX 20 (block 1's
  row, reused); (d) 40/10/20/20/10/0 — recency mostly the variant's own; (e) 33/0/25/25/17/0 — the
  baseline weights, no family (BL-069 B3's 63/126 row, reused: ₹4,86,867 / −₹61,058).
  Each new row: in-sample, the Jan–Aug 2025 slice, and 10 label shuffles (queued after the main rows
  while the machine is loaded).
- **Read-out:** as block 1 (candidate = gross ÷ drawdown above 6.31 and gross within one yardstick of the
  better B3-only row; real = above all 10 shuffles). The 2022–2024 hold-out (BL-071 part B) decides;
  these rows join its list.
- **Will not run:** other weights.
- **Result:** pending.

## Log

- 2026-10-10 — created; rows registered before any BL-072 run.
