# BL-080 — Four more closest-premium Widesl families: NIFTY ₹40 / ₹60 and SENSEX ₹120 / ₹200

| | |
|---|---|
| **Priority** | P2 — options research; widens the BL-075 universe |
| **Status** | Done — closest-premium additions harmful, Dir ITM1 useful, leave-one-out table recorded; pruning follow-up registered as block 4 |
| **Type** | research |
| **Area** | options |
| **Created** | 2026-10-10 |
| **Depends on** | BL-060 / BL-061 (the ₹80 / ₹100 and ₹250 / ₹320 families), BL-071 (2022–24 import), BL-075 (final map) |
| **TODO.md row** | — |

## Context

The 248-variant list carries closest-premium Widesl at NIFTY ₹80 / ₹100 and SENSEX ₹250 / ₹320 (the
owner's 3.2× rule). Those families took 46% of the core picks and removing them cost 30% (BL-065).
The owner (2026-10-10) asked to add the next two premiums further out on each index: NIFTY ₹40 and
₹60, SENSEX ₹120 and ₹200 (SENSEX ≈ 3× NIFTY), and to go through the findings after BL-075 stage 3.

## Plan

### Phase 0 — Pre-register
- **New variants (100):** `N_p40`, `N_p60`, `S_p120`, `S_p200` × the 25 start times 09:17 .. 15:17,
  each an exact sibling of the ₹80 / ₹100 / ₹250 / ₹320 file at the same start time with only the
  closest-premium value (and the id) changed: short strangle, SL 115% per leg trailed 15/10, overall
  ₹2,500 per lot, exit 15:28, partial square-off. Committed under `strategies/rotation_ext/`, not
  `strategies/rotation/` (the journal's frozen 248-variant universe is not touched by this item).
- **Runs:** NIFTY 2022-01-03 → 2026-10-09 (the imported days and the main results' days), SENSEX
  2024-10-09 → 2026-10-09; costs 0, lot sizing current, sizing date 2026-10-12, the research-only
  reference override of BL-071 for dates before the lot-size table. The runner loads each index's day
  once and simulates its 50 variants; before use it must reproduce three existing variants
  (N_p80_1117, N_p100_0932, S_p250_1117) over 30 days exactly.
- **Universe tested:** 348 variants = the 248 + the 100 new. Same DRB-6W3L2 rule (3 strategies × 2 lots,
  at least 2 Widesl strategies — the new families count as Widesl — Buy add-on when a Buy ranks in the
  top 10). `rotate.py --ext-closest`.
- **Experiments (fixed):** (E1) lists A, B, C, REF of BL-058 Phase 0b on P1 / P2 / P3 (BL-075's periods)
  with the 248 list and the 348 list; (E2) the share of core slots each new family takes per period
  and list; (E3) the BL-075 stage-1 map (100 weightings × 3 periods) on the 348 list: share of cells
  above chance in all three periods, against 19% on the 248 list.
- **Read-out (registered):** the new families are *useful* only if **all** of: (i) for at least 2 of the
  lists A, B, C the 348-list gross is ≥ the 248-list gross in at least 2 of the 3 periods, and no list is
  pushed below the random P90 in a period where it was above it; (ii) the new families take ≥ 10% of
  the core slots in P1 on at least 2 of the 3 lists; (iii) the stage-1 share above chance everywhere is
  ≥ 19%. Otherwise they are *inert* (fail ii) or *harmful* (fail i or iii). A "useful" verdict still
  changes nothing live: it would be a dated decision to extend the journal universe.
- **Will not run:** other premiums, other strategy shapes, other weightings.
- **Result (2026-10-10 16:10, gross; the 348-variant list vs the 248 list; 1 lot of each variant,
  lists A, B, C, REF of BL-058 Phase 0b on BL-075's periods): HARMFUL under the registered read-out.**

  | List | P1 2025-12→2026-10 | P2 Jan–Aug 2025 | P3 2022-04→2024-10 | new families' share of core slots |
  |---|---|---|---|---|
  | A | 3,41,951 vs 3,89,900 (−47,949) | 2,50,148 vs 3,18,652 (−68,504; **falls below chance**) | 11,91,835 vs 12,20,482 (−28,647) | 17% / 14% / 19% |
  | B | 3,26,306 vs 3,52,327 (−26,021) | 2,09,893 vs 3,51,201 (−1,41,308; **below chance**) | 12,42,059 vs 12,39,935 (+2,124) | 16% / 14% / 19% |
  | C | 3,73,870 vs 4,27,782 (−53,912) | 2,83,220 vs 2,98,124 (−14,904) | 11,11,152 vs 11,58,525 (−47,373) | 17% / 14% / 19% |
  | REF | 3,88,270 vs 4,30,868 (−42,598) | 86,871 vs 1,70,015 (−83,144) | 9,42,685 vs 10,13,627 (−70,942) | 18% / 15% / 22% |

  (i) fails: no list is ≥ its 248 gross in two periods, and A and B fall below chance on Jan–Aug 2025.
  (ii) passes (14–22% of core slots). (iii) fails: the 100-weighting map on the 348 list has **5 of
  100 cells above chance in all three periods (5%, against 19% on 248), none robust** (3 of the 25
  baseline-split cells, 2 of the dte-heavy). The extra premiums are picked often and make the rule
  worse and more fragile: the ranking has 100 more near-copies of Widesl to be fooled by.

### Block 2 — Dir at ITM1 (2026-10-10, registered before its runs)
- **Why:** the live directional strategy is `nifty_dir_924_itm1_sl21_recost` (ITM1), but the research
  family `dir` was run at ATM only (BL-054 / 056 / 059 / 062). The owner asked to run ITM as well.
- **New variants (50):** `N_ditm1` and `S_ditm1` × the 25 start times 09:17 .. 15:17, each the ATM sibling
  with both legs' strike set to ITM1 and nothing else changed (21% SL per leg, one re-entry at cost,
  overall ₹3,000 per lot, exit 15:28). Committed in `strategies/rotation_ext/`. ITM2 is not run.
- **Same method, windows and validation** as block 1; the new family counts as Dir (it is a candidate
  for the Dir slots and for the Widesl-minimum swap) and is pooled with ATM Dir in the family-band
  recent criterion (type × start band).
- **Universe tested:** 248 + 50 = 298 (ITM only) and 248 + 100 + 50 = 398 (everything). `rotate.py
  --ext-dir [--ext-closest]`.
- **Experiments (fixed):** (E4) the ITM1 family's own totals by calendar year beside Dir ATM and the
  closest-premium families (1 lot, per variant mean), NIFTY 2022-2026, SENSEX 2024-2026; (E5) lists A,
  B, C, REF on P1 / P2 / P3 with the 298 list and the 398 list beside the 248 list; (E6) the share of
  core slots taken by ITM1 per period and list.
- **Read-out (registered):** ITM1 is *useful* only if, on the 298 list, for at least 2 of A, B, C the
  gross is ≥ the 248-list gross in at least 2 of 3 periods with no list pushed below the random P90 in
  a period where it was above it, **and** the family takes ≥ 10% of the core slots in P1 on at least 2
  lists. Otherwise inert or harmful. Nothing goes live; it would be a dated decision to extend the
  journal universe.
- **Result (2026-10-10 16:10, gross; 298 list = 248 + Dir ITM1):** **USEFUL under the registered
  read-out.**

  | List | P1 2025-12→2026-10 | P2 Jan–Aug 2025 | P3 2022-04→2024-10 | ITM1 share of core slots | Max DD P1 |
  |---|---|---|---|---|---|
  | A | 4,76,560 vs 3,89,900 (**+86,660**) | 3,54,513 vs 3,18,652 (+35,861) | 12,23,256 vs 12,20,482 (+2,774) | 24% / 20% / 21% | −70,142 |
  | B | 4,38,310 vs 3,52,327 (+85,983) | 3,49,400 vs 3,51,201 (−1,801) | 13,67,159 vs 12,39,935 (**+1,27,224**) | 24% / 19% / 21% | −80,143 |
  | C | 4,94,715 vs 4,27,782 (+66,933) | 3,51,497 vs 2,98,124 (+53,373) | 11,56,788 vs 11,58,525 (−1,737) | 23% / 19% / 21% | **−55,779** |
  | REF | 4,08,368 vs 4,30,868 (−22,500) | 2,22,000 vs 1,70,015 (+51,985) | 10,80,967 vs 10,13,627 (+67,340) | 24% / 19% / 21% | −79,426 |

  Every one of A, B, C is ≥ its 248 gross in at least two periods, all three stay above the random
  P90 in every period (REF's Jan–Aug 2025 stays below, as before), and ITM1 takes 19–24% of the core
  slots. Family by year (E4, 1 lot, mean per variant): Dir ITM1 beats Dir ATM in every year on both
  indices (NIFTY +₹13k, +₹16k, +₹4k, +₹7k, +₹12k for 2022–2026; SENSEX +₹3k, +₹14k, +₹9k for 2024–2026)
  at the same ~60% win rate. The universe with everything (398) is mixed: the ITM gains in P1 survive,
  Jan–Aug 2025 is worse for A (−86k) and REF because of the closest-premium additions.

### Block 3 — leave one category out (2026-10-10, registered before its runs)
- **Why:** the owner wants each family dropped in turn (₹80 out, ₹100 out, ITM out, …) to see what it
  adds to the result, once all the families are in.
- **Universe:** the full 398 (248 + 100 closest-premium + 50 Dir ITM1), DRB-6W3L2, lists A, B, C and
  REF on P1 / P2 / P3 (BL-075's periods). `rotate.py --ext-closest --ext-dir --drop T`.
- **Drop sets (23, fixed):** the 16 index-families one at a time (N_wide, N_p40, N_p60, N_p80, N_p100,
  N_dir, N_ditm1, N_buy, S_wide, S_p120, S_p200, S_p250, S_p320, S_dir, S_ditm1, S_buy) and 7 groups
  (all closest-premium, all Dir ITM1, all Dir ATM, all Buy, all OTM Widesl, all NIFTY, all SENSEX; NIFTY
  and SENSEX are not run on the NIFTY-only P3 where they leave nothing / change nothing).
- **Read-out (registered):** per drop set, the change in gross against the full 398 list for each list
  and period, the list's drawdown and whether it is still above the random P90 of that run. A set is
  *carrying weight* if dropping it lowers gross by more than 5% in at least 2 of 3 periods for at least
  2 of the 4 lists; *dead weight* if dropping it changes gross by less than ±2% or raises it in at
  least 2 of 3 periods for at least 2 lists; *in between* otherwise. Also reported: each set's share of
  the core slots in the full run (E2 / E6).
- **Will not run:** pairs of dropped sets, other lists, other periods.
- **Result (2026-10-10 16:10; the 398 list; change in gross, ₹ thousand, when the set is switched off,
  lists A / B / C / REF; + means the list did better without it):**

  | Set switched off | P1 | P2 | P3 | Runs lowered / total | Mean change | Classification |
  |---|---|---|---|---|---|---|
  | N ₹40 | −20 / −8 / +17 / +14 | +31 / 0 / −3 / +43 | −18 / +19 / −57 / −16 | 6 / 12 | +0.3k | **dead weight** |
  | N ₹60 | −43 / −33 / −7 / +29 | +46 / +30 / +32 / +10 | +97 / +49 / +23 / −79 | 4 / 12 | +12.8k | **dead weight** |
  | S ₹120 | −9 / +17 / +21 / +14 | 0 / −11 / +7 / −19 | — | 3 / 8 | +2.6k | **dead weight** |
  | S ₹200 | +20 / +44 / +35 / +17 | +17 / +17 / +35 / 0 | — | **0 / 8** | **+23.0k** | **dead weight** (removal never hurts) |
  | N ₹80 | −63 / −29 / −9 / +40 | +45 / +9 / 0 / +17 | −72 / −163 / −96 / −66 | 8 / 12 | −32.1k | carrying weight |
  | N ₹100 | −55 / −9 / −12 / +22 | +37 / −9 / −33 / −35 | −62 / −41 / −45 / −81 | 10 / 12 | −26.9k | carrying weight |
  | S ₹250 | −23 / +18 / −1 / −6 | +35 / +33 / +41 / +53 | — | 3 / 8 | +18.8k | dead weight |
  | S ₹320 | +12 / +11 / +49 / +4 | +43 / +41 / −7 / −34 | — | 2 / 8 | +14.9k | dead weight |
  | all closest-premium (200) | −57 / −1 / −33 / −18 | **+204 / +125 / +92 / +107** | −118 / −202 / −178 / −60 | 8 / 12 | −11.7k | carrying weight (regime split: helps P1 and P3, hurts P2) |
  | N Dir ITM1 | −48 / −36 / −45 / +95 | −11 / −13 / −7 / −53 | +16 / −82 / −37 / −116 | 10 / 12 | −28.1k | **carrying weight** |
  | S Dir ITM1 | −120 / −151 / −53 / −24 | −10 / −19 / +24 / −33 | — | 7 / 8 | −48.2k | **carrying weight** |
  | all Dir ITM1 (50) | −126 / −123 / −64 / +25 | +18 / −68 / +8 / −76 | +16 / −82 / −37 / −116 | 8 / 12 | −52.0k | **carrying weight** |
  | all Dir ATM (50) | −42 / +20 / +10 / +29 | −6 / −28 / −16 / −87 | −47 / −129 / −136 / −107 | 9 / 12 | −44.8k | carrying weight |
  | N OTM Widesl | −67 / −62 / −38 / −36 | +24 / +11 / −54 / +34 | +41 / −14 / −35 / −44 | 8 / 12 | −19.9k | dead weight by the rule (mixed) |
  | S OTM Widesl | −24 / +11 / +49 / −12 | +14 / +9 / −32 / +43 | — | 3 / 8 | +7.2k | in between |
  | all Buy (48) | 0 / −5 / +4 / −42 | +5 / −20 / −3 / +28 | +9 / +18 / −33 / +22 | 5 / 12 | −1.4k | dead weight |

  - **Verified:** the 16 single families partition the 398 variants exactly (N_buy and S_buy 24 each
    because Buy has no 15:17), every drop-set count is as intended, and the full-list rows equal
    the comparison runs.
  - **Safe to remove on this evidence:** the four new closest-premium families (₹40, ₹60 NIFTY, ₹120, ₹200
    SENSEX): their removal improves or leaves results unchanged in most runs, and ₹200 never hurts.
    **Candidates to prune next:** SENSEX closest ₹250 and ₹320 (removal helps 5 of 8 and 6 of 8 runs),
    SENSEX OTM2 Widesl (mixed). **Keep:** NIFTY ₹80 and ₹100, both Dir ITM1 families and Dir ATM, NIFTY
    OTM1 Widesl.
  - **Caveats:** one universe (398), 12 correlated runs per set, rupee deltas of ±₹20k are inside
    the selection noise of this rule (BL-068's shuffle sd ≈ ₹1.08 lakh on 202 days). The ranking among
    the sets is more trustworthy than any single number.

### Block 4 — the 298 map and a pruned universe (2026-10-10 17:50, registered before its runs)
- **Why:** blocks 1–3 say Dir ITM1 helps, the four new closest-premium families hurt, and SENSEX
  ₹250 / ₹320 look redundant. Two questions remain before the journal's universe is touched: does
  ITM1 make the weighting less fragile, and does pruning SENSEX ₹250 / ₹320 help or only look good?
- **Runs:** (a) the 100-weighting map of BL-075 stage 1 on the 298 list (248 + Dir ITM1; 300 runs,
  `run_all.py --stage 1 --extdir`); (b) lists A, B, C, REF on P1 / P2 / P3 on the pruned list 298 minus
  SENSEX ₹250 and ₹320 (248 + ITM1 − 50 = 248 variants; `--ext-dir --drop S_p250,S_p320`; 12 runs).
- **Read-out (registered):** (a) the share of the 100 cells above the random P90 in all three periods
  and the number in a robust region, against 19% / 0 on the 248 list and 5% / 0 on the 348 list; ITM1
  is *fragility-reducing* if the share is ≥ 19%. (b) pruning is *adopted* only if at least 3 of the 4
  lists' gross is ≥ their 298-list gross in at least 2 of 3 periods **and** no list falls below chance
  in a period where it was above it on the 298 list.
- **Will not run:** other prunings (S_wide, the Buy families), pairs, other lists.
- **Result (b), pruned universe (2026-10-10 18:20, gross; pruned = 298 minus S_p250, S_p320):**
  **NOT ADOPTED.** Pruned vs the 298 list:

  | List | P1 2025-12→2026-10 | P2 Jan–Aug 2025 | P3 2022–24 | Above P90 (P1 / P2 / P3) |
  |---|---|---|---|---|
  | A | 4,50,415 vs 4,76,560 (−26,145) | 3,35,332 vs 3,54,513 (−19,181) | 12,23,256 (same) | yes / yes / yes |
  | B | 4,57,578 vs 4,38,310 (+19,268) | 3,45,885 vs 3,49,400 (−3,515) | 13,67,159 (same) | yes / yes / yes |
  | C | 5,12,655 vs 4,94,715 (+17,940) | 3,10,874 vs 3,51,497 (−40,623) | 11,56,788 (same) | yes / **no** / yes |
  | REF | 3,62,506 vs 4,08,368 (−45,862) | 3,20,206 vs 2,22,000 (+98,206) | 10,80,967 (same) | yes / no / yes |

  P3 is NIFTY-only, so removing SENSEX variants cannot change it: the two lists are identical there and
  that tie counts as "≥" under the registered rule without being evidence. Counting it, B, C and REF each
  reach 2 of 3 periods; on P1 and P2, the only periods that can differ, none of the four is ≥ in both
  (B and C gain in P1 and lose in P2, REF the reverse, A loses in both). **The second clause fails outright:** C's
  Jan–Aug 2025 drops below the random P90 (3,10,874 vs 3,40,651) where it was above on the 298 list.
  So the pruned list is not used; the journal universe question (248 vs 298) is unaffected by it.
- **Result (a), the 298 map (2026-10-10 19:10, gross; 100 weightings × 3 periods = 300 runs):**
  **ITM1 is fragility-reducing.** 58 of 100 cells are above the random P90 in all three periods (58%),
  against 19% on the 248 list and 5% on the 348 list; 39 cells are in the robust region (min relative
  score ≥ 0.85 band as in BL-075) against 0 on the 248 list. By split: baseline 19 of 25, equal 21 of 25,
  dteheavy 16 of 25, no-VIX 2 of 25 (the VIX criterion is still what the rest hangs on). Best worst-period
  cell is own 0 / family 10 (min_rel 0.861); the journal's A (own 5 / fam 5) is 0.849 and C (15 / 5) 0.846,
  both in the robust region. Best period grosses on the 298 list: P1 ₹5,61,480, P2 ₹3,93,740,
  P3 ₹13,67,159. Together with block 4(b) (pruning rejected) the universe stays at 298; nothing in the
  journal changes.

## Log

- 2026-10-10 — created and registered before any run.
- 2026-10-10 — blocks 1–3 ran after an alignment fix (first pass crashed; the 348 map had only P3). Results above.
