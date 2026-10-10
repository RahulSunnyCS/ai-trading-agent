# BL-080 — Four more closest-premium Widesl families: NIFTY ₹40 / ₹60 and SENSEX ₹120 / ₹200

| | |
|---|---|
| **Priority** | P2 — options research; widens the BL-075 universe |
| **Status** | In progress |
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
- **Result:** pending.

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
- **Result:** pending.

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
- **Result:** pending.

## Log

- 2026-10-10 — created and registered before any run.
