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
- **Per-strategy stops:** each variant keeps its own overall MTM stop per 1 lot (Widesl ₹2,500, Dir ₹3,000, Buy ₹2,000); a 2-lot
  strategy is modelled as twice the 1-lot result, i.e. stops of ₹5,000 / ₹6,000 / ₹4,000 when set up in AlgoTest.
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

### 2026-10-09 — DRB-6W3L2 without the closest-premium Widesl (`DRB-6W3L2/OTM`)
- **Question (owner):** do the closest-premium Widesl (NIFTY ₹80 / ₹100, SENSEX ₹250 / ₹320, BL-060/061)
  earn their place in the list, or does DRB-6W3L2 do as well picking from the OTM-strike variants only?
- **Rule:** DRB-6W3L2 exactly as above, on the 248-variant list **less the 100 closest-premium Widesl**
  (4 families × 25 start times) = 148 variants: NIFTY OTM1 / SENSEX OTM2 Widesl, Dir ATM and Buy at
  every start time. Criteria, weights, window, selection days, Widesl minimum (2 strategies), Buy add-on
  and the per-strategy stops unchanged. `rotate.py --basket DRB-6W3L2 --no-closest`.
- **Comparators:** the 248-list DRB-6W3L2 (gross ₹4,30,868, drawdown −₹68,294; net ₹3,50,407, drawdown
  −₹84,469 at flat ₹13 an order), plus R / E / live mix recomputed on the 148-list. BL-057's three
  conditions reported.
- **Read-out:** the smaller list is "as good" if its net after charges is within 5% of the 248-list's
  with a drawdown no deeper; "better" if above it on both. Either way this is a comparison of two
  already-seen runs on the same year, not a validation.
- **Hold-out:** none (owner override, as above). **Will not run:** dropping one index's closest-premium
  only, dropping one premium only, other baskets on the 148-list, re-tuning the weights.
- **Result:** **worse** on the read-out: the 148-list earns 30% less gross and 37% less net, for a shallower
  drawdown. 148 variants, 202 selection days, Buy on 63 days, 6.62 lots a day. Gross ₹3,02,889 (+23.3%)
  vs ₹4,30,868; max drawdown −₹49,428 vs −₹68,294; worst day −₹21,048 vs −₹19,368; 61.4% winning days;
  ₹226 per lot-day vs ₹329. INCONCLUSIVE on the three conditions (R P90 ₹2,92,140, beats 93% of random;
  E ₹2,53,471 / −₹47,546 fails on drawdown; live mix ₹2,32,014 / −₹2,08,439). After charges (flat ₹13
  an order): charges ₹80,965 (27% of gross), net ₹2,21,925 (+17.1%) vs ₹3,50,407 (+27.0%); drawdown
  −₹56,448 (4.3%) vs −₹84,469 (6.5%); 9 of 11 months positive, worst month −3.00% (Jan 2026). With
  AlgoTest's fee: ₹2,09,214. Why: on the full list the closest-premium Widesl took 277 of the 606 core
  picks (46%); without them the slots went to OTM Widesl (420 picks vs 170), not Dir (186 vs 159). The
  2-Widesl minimum's override fired on 166 of 202 days (125 before): OTM Widesl seldom rank top-3 on their
  own, and on the 148-list case B (no minimum) makes ₹3,93,721, so the minimum costs ₹91k here vs ₹12k on
  the full list. Monthly gross gap: Jan −₹31.7k, Feb −₹25.6k, Mar −₹36.6k, Jul −₹66.1k; May +₹27.7k the one
  clear gain. Same core on only 26 of 202 days. Picks file
  `research/bl057/daily_picks_min3_core6_buy2L2_whole_day_otm_only.csv`; charges rotation `DRB-6W3L2/OTM`.

### 2026-10-09 — DRB-6W3L2 on the top 25% of each family (`DRB-6W3L2/T25`)
- **Question (owner):** does a smaller pool of the better variants do better than the full 248?
- **Rule:** before any selection day, rank the 248 variants **within each family** — Widesl (OTM and
  closest-premium together, 150), Dir ATM (50), Buy (48) — on the **63 warm-up days only** (1 Sep →
  2 Dec 2025, the days before the first selection day) by the mean of three within-family percentile
  ranks: total P&L, winning-day %, max drawdown (shallower is better). Keep the top 25% of each
  (38 Widesl, 13 Dir, 12 Buy, rounded up) = 63 variants, fixed for the whole run. Then DRB-6W3L2
  exactly as above on that pool (criteria, weights, selection days, Widesl minimum, Buy add-on, stops
  unchanged). `rotate.py --basket DRB-6W3L2 --prefilter 25`.
- **Look-ahead:** the pool is chosen on days before the first trade and never updated (owner's choice:
  point in time, first three months only); the per-day scores already use only prior days. The full-year
  "top 25%" (look-ahead) version is **not** run.
- **Comparators:** the 248-list DRB-6W3L2 (gross ₹4,30,868 / −₹68,294; net ₹3,50,407 / −₹84,469 at flat
  ₹13 an order); R / E / live mix recomputed on the 63-variant pool; BL-057's three conditions reported.
- **Read-out:** as the second block — "as good" within 5% of net with a drawdown no deeper, "better" above
  on both. Same already-seen year; no hold-out (owner override).
- **Will not run:** other percentages, other ranking criteria or weights, a rolling re-ranking, the
  look-ahead whole-year filter.
- **Result:** **less gross, far less drawdown; the first DRB run to PASS all three conditions.** Pool: 38
  Widesl (28 of them closest-premium; no 09:17 Widesl survived), 13 Dir (SENSEX 09:32–10:32 among them),
  12 Buy (mostly SENSEX 12:32–14:47). 202 selection days, Buy on 62, 6.61 lots a day. Gross ₹3,45,955
  (+26.6%) vs ₹4,30,868; max drawdown −₹36,454 vs −₹68,294; worst day −₹19,052, worst week −₹22,336
  (vs −₹29,865); 60.9% winning days; ₹259 per lot-day vs ₹329. PASS: R P90 ₹2,22,414 (beats 100%); E
  ₹1,65,423 / −₹52,028; live mix ₹2,32,014 / −₹2,08,439. After charges (flat ₹13 an order): charges
  ₹80,978 (23%), net ₹2,64,977 (+20.4%) vs ₹3,50,407 (+27.0%); drawdown −₹42,824 (3.3%) vs −₹84,469
  (6.5%); **10 of 11 months positive**, worst month −1.49% (Apr 2026); with AlgoTest's fee ₹2,52,285. On the
  read-out it is not "as good" (net 24% lower) — it trades ₹85k of net for ₹42k less drawdown and a
  steadier month profile. Picks start later: 27% of core picks before 11:00 (56% on the full list), 50%
  11:00–13:59, 22% from 14:00. Family mix unchanged (434 Widesl picks of which 260 closest-premium, 172
  Dir); the gain comes from which variants, not fewer Widesl. It misses the full list's two big months,
  Feb (₹29k vs ₹93k; 3 Feb alone −₹51k of the gap) and Jul (₹13k vs ₹1.0 lakh), and wins May (+₹28k vs
  −₹14k), Jun and Aug. Same core on 2 of 202 days. The pool was fixed before the first trade, so the
  pool's survival through Oct 2026 is out-of-time; the daily criteria and the year are not. Picks file
  `research/bl057/daily_picks_min3_core6_buy2L2_whole_day_top25.csv`; charges rotation `DRB-6W3L2/T25`.

### 2026-10-10 — DRB-6W3L2 on a rolling top 25% of each family, trailing 2 months (`DRB-6W3L2/T25R42`)
- **Question (owner):** instead of fixing the pool on the warm-up days, re-choose the best performers
  every day on the last 2 months.
- **Rule:** on each selection day, rank the 248 variants within each family (Widesl incl.
  closest-premium 150, Dir 50, Buy 48) on the **42 trading sessions before that day** (rows i−42 … i−1,
  never the day itself) by the mean of the three within-family percentile ranks (total P&L, winning-day %,
  max drawdown); keep the top 25% (38 / 13 / 12). DRB-6W3L2's daily composite is then percentile-ranked
  **within that day's pool** and the picks are made as above (Widesl minimum, Buy add-on from the pool's
  top 10, stops unchanged). "2 months" is read as 42 trading sessions (21 a month); the owner first said 30 days, then 2 months, before the run.
  `rotate.py --basket DRB-6W3L2 --prefilter 25 --prefilter-window 42`.
- **Look-ahead:** none; the pool and the scores on a day use only earlier rows.
- **Comparators:** the full-list DRB-6W3L2 and the fixed-pool `DRB-6W3L2/T25` (gross ₹3,45,955 /
  −₹36,454; net ₹2,64,977 / −₹42,824); R and E drawn from each day's pool; BL-057's three conditions.
- **Read-out:** against the fixed pool, same 5% / drawdown rule. Same year, no hold-out (owner override).
- **Will not run:** other windows (21, 30, 63), other percentages, other criteria or weights. One try.
- **Result:** **between the two** — more gross than the fixed pool, more drawdown too; INCONCLUSIVE. 202
  selection days, Buy on 68, 6.67 lots a day. Gross ₹4,00,807 (+30.8%) vs full list ₹4,30,868 and fixed
  pool ₹3,45,955; max drawdown −₹62,656 vs −₹68,294 / −₹36,454; worst day −₹20,324 (2 Mar), worst week
  −₹43,500 (2–8 Mar, the worst of the three lists); 63.9% winning days; ₹297 per lot-day. Conditions: R
  P90 ₹2,73,137 (beats 100%) ✓; E ₹2,13,429 / −₹33,372 — fails on drawdown (E is a good basket here since
  the pool is already filtered); live mix ✓. After charges (flat ₹13 an order): charges ₹81,508 (20%),
  net ₹3,19,299 (+24.6%) vs ₹3,50,407 / ₹2,64,977; drawdown −₹68,345 (5.3%) vs −₹84,469 / −₹42,824; 8 of
  11 months positive, worst month −1.36% (Apr); with AlgoTest's fee ₹3,06,493. Against the fixed pool on
  the read-out: net +20% but drawdown 60% deeper — "better" on return, not on both. Where it differs:
  it recovers July (₹96,690 vs the fixed pool's ₹13,309) and September (₹46,140) but gives back March
  (₹33,074 vs ₹70,366 / ₹81,600): a pool ranked on Jan–Feb was wrong for the first week of March. Picks
  start between the other two (34% before 11:00, 49% 11:00–13:59, 16% from 14:00); family mix unchanged
  (436 Widesl incl. 276 closest-premium, 170 Dir); the Buy add-on lost ₹1,504 over its 68 days. Same core
  as the full list on 9 days, as the fixed pool on 1. The within-pool composite's Spearman diagnostic is
  not comparable with the other runs (excluded variants sit at −inf). Picks file
  `research/bl057/daily_picks_min3_core6_buy2L2_whole_day_top25r42.csv`; charges rotation `DRB-6W3L2/T25R42`.
  Regression: the full-list run still reproduces ₹4,30,868 after the select_picks change.

### 2026-10-10 — DRB-6W3L2 on the 30-minute start-time grid (`DRB-6W3L2/G30`)
- **Question (owner):** 248 variants is too many to keep in front of you. Does the basket do as well on
  half the list — every second start time?
- **Rule:** keep only the start times on a 30-minute grid from 09:17 (09:17, 09:47, 10:17, 10:47, 11:17,
  11:47, 12:17, 12:47, 13:17, 13:47, 14:17, 14:47, 15:17; Buy has no 15:17): per index 13 Widesl OTM,
  26 closest-premium Widesl, 13 Dir, 12 Buy = 64, so **128 variants**. DRB-6W3L2 otherwise unchanged
  (criteria, weights, selection days, Widesl minimum, Buy add-on, stops). `rotate.py --basket DRB-6W3L2
  --grid 30`. No prefilter.
- **Comparators:** the full-list DRB-6W3L2 (gross ₹4,30,868 / −₹68,294; net ₹3,50,407 / −₹84,469); R and E
  on the 128-list; BL-057's three conditions.
- **Read-out:** "as good" within 5% of net with a drawdown no deeper. Same year, no hold-out (owner override).
- **Will not run:** the other 30-minute phase (09:32, 10:02, …), a 45- or 60-minute grid, the grid
  combined with a prefilter.
- **Result:** **nearly as good — 12% less net, same drawdown; INCONCLUSIVE** (the full list's own verdict).
  128 variants, 202 selection days, Buy on 56, 6.55 lots a day. Gross ₹3,91,051 (+30.1%) vs ₹4,30,868;
  max drawdown −₹64,600 vs −₹68,294; worst day −₹22,161, worst week −₹32,465 (vs −₹37,562); 63.9%
  winning days; ₹295 per lot-day vs ₹329. Conditions: R P90 ₹2,72,171 (beats 100%) ✓; E ₹1,97,532 /
  −₹59,354 fails on drawdown; live mix ✓. Case B (no Widesl minimum) ₹4,47,419 / −₹65,268. After charges
  (flat ₹13 an order): charges ₹81,326 (21%), net ₹3,09,725 (+23.8%) vs ₹3,50,407 (+27.0%); drawdown
  −₹82,310 (6.3%) vs −₹84,469 (6.5%); 8 of 11 months positive, worst month −3.18% (Apr 2026, vs −1.74%);
  with AlgoTest's fee ₹2,97,147. Not "as good" on the 5% read-out (net 12% lower) but the same shape: same
  family mix (449 Widesl incl. 266 closest-premium, 157 Dir), same start-time profile (54% before 11:00,
  34% 11:00–13:59, 12% from 14:00), same most-picked variants (NIFTY ₹100 / ₹80 / OTM1 Widesl 09:17). The
  full list took an off-grid start time (09:32, 10:02, …) for 42% of its core picks; the grid takes the
  neighbour 15 minutes away, same core on 32 of 202 days. The gap is month noise, not a trend: Mar −₹35k,
  Apr −₹26k, Jun −₹24k against May +₹36k, Aug +₹16k. Picks file
  `research/bl057/daily_picks_min3_core6_buy2L2_whole_day_grid30.csv`; charges rotation `DRB-6W3L2/G30`.

## Log

- 2026-10-09 — created from the owner's request to run 6 lots as 3 strategies of 2 lots.
- 2026-10-09 — DRB-6W2L2 and DRB-6W3L2 ran; charges applied (Result above).
- 2026-10-09 — owner confirmed brokerage is **flat per order, not per lot**, so the flat-per-order figures in the Result are
  the ones that apply: DRB-6W2L2 charges ₹88,041 (20% of gross), net ₹3,54,588 (+27.3%), drawdown −₹1,03,232 (7.9%), 9 of
  11 months positive, worst month −2.85%; DRB-6W3L2 charges ₹80,461 (19%), net ₹3,50,407 (+27.0%), drawdown −₹84,469
  (6.5%), 8 of 11, worst month −1.74%. Net at ₹7 / ₹13 / ₹20 per order: 6W2L2 ₹3,75,842 / ₹3,54,588 / ₹3,29,791; 6W3L2
  ₹3,70,401 / ₹3,50,407 / ₹3,27,080. After AlgoTest's fee at ₹19 a strategy-day: ₹3,42,162 (+26.3%) / ₹3,37,981 (+26.0%).
  DRB-6W3 (6 × 1 lot) unchanged: net ₹2,49,942 (+19.2%), drawdown −₹72,220.
- 2026-10-09 — owner asked for DRB-6W3L2 without the closest-premium Widesl; block above, ran: 30% less gross,
  37% less net, shallower drawdown. The closest-premium variants stay in the list.
- 2026-10-10 — owner asked for the top 25% of each family (point in time, warm-up days only; criteria total
  P&L, win %, max drawdown); block above, ran: gross −20%, net −24%, drawdown −47%; PASS.
- 2026-10-10 — owner asked for the pool re-chosen daily on the last 30 days, then changed it to the last 2 months
  (42 sessions) before the run; block above, ran: gross −7% vs the full list, drawdown −8%; vs the fixed pool
  gross +16%, drawdown +72%. INCONCLUSIVE.
- 2026-10-10 — owner asked for the 30-minute start-time grid (half the list, to have fewer strategies to watch);
  block above, ran: gross −9%, net −12%, drawdown about the same. INCONCLUSIVE, same as the full list.
