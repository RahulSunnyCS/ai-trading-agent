# BL-107 — Day-type variants vs Adaptive: Core-298 plus time-generic and band winners

| | |
|---|---|
| **Priority** | P1 — tells whether settings chosen for expiry and non-expiry days improve the live Adaptive list |
| **Status** | Planned — selection and replay scripts being built; runs after BL-104's day-type lists |
| **Type** | research |
| **Area** | options |
| **Created** | 2026-10-16 |
| **Depends on** | BL-104 (day-type lists, Stage 1 series), BL-106 (replay harness, the Core-298 / pool names), BL-058 (the registered lists) |
| **TODO.md row** | 3.10.29 |

## Names

| Name | What it is |
|---|---|
| **Core-298** | The live rotation's 298 variants (12 families, 25 entry times; Buy has 24) |
| **Core-144** | Core-298 restricted to the 12 sampled entry times (12 families × 12) |
| **T1** | Core plus time-generic day-type winners: per family, the setting that beats its template across all sampled times, one for expiry days and one for non-expiry days, created at every entry time |
| **T2** | Core plus band winners: the same per family and day type, chosen separately for 09:15–10:30, 10:30–13:00 and 13:00–15:30, created only at their band's entry times |

## Context

The owner (2026-10-16) asked whether Adaptive, with its registered weights and 5 / 21 / 63 / 126-day
lookbacks unchanged, does better over a universe that adds day-type settings (BL-104's lists) than
over Core-298. Adaptive scores every strategy daily and trades the top ones wherever they fall: no
quota per band. A day-type weight (below) is the only change to the picker. Owner choices: boost
only, no deduction; both variant types are available every day; compare against Core-298 and
against Core-144 (the sampled times only); gross is the unit, net beside it where simulated.

## Goal

Whether Adaptive over T1 or T2 earns more per lot-day than Adaptive over Core-298 (and Core-144) in a
test year neither the winners nor the lists were fitted on, without a deeper drawdown.

## Out of scope

Changing the registered lists or the live rotation; re-simulating Core-298; any adoption from this
item alone; the all-days winner (reported in BL-104, not in the universes); a deduction for the
mismatched day type; Steady and Calendar boosts (reported unboosted for information).

## Plan

### Phase 0 — Pre-register (committed before the winners are read)

- **Hypothesis:** Adaptive over T1 (or T2) earns more gross per lot-day than over Core, without a
  deeper drawdown, because the added variants are better matched to the day type.
- **Windows:** winners chosen on 2024-10-09 → 2025-10-08 only (BL-104 `daytype_lists.py --window
  first`: "both years positive" becomes "both halves of the first year positive"; the 12 sampled
  slots). Replay on 2025-10-09 → 2026-10-09 (weekdays). History for the lookbacks from 2025-04-01.
  The 13 slots that were not sampled in BL-104 are unseen at selection.
- **Winners:** per family (12) × day type (expiry, non-expiry) × scope (all times; each of the three
  bands), by the BL-104 rule (margin ₹25 expiry / ₹15 other; ≥ 9 of 12 slots, or 3 of 4 in a band;
  worst day ≤ 1.25 × the template's; ≥ 2 neighbours beating the template). A winner equal to the
  family's template adds nothing; N_wide's owner settings are always added. Premium families keep up
  to three premiums.
- **Universes at 25 entry times** (the rotation's 09:17 … 15:17 at 15-minute gaps): Core-298; T1 =
  Core + each all-times winner at all 25; T2 = Core + each band winner at its band's slots (09:17–
  10:17, 10:32–13:02, 13:17–15:17). **At the 12 sampled times:** Core-144, T1-12, T2-12.
- **Day-type weight (Adaptive only):** a variant tagged expiry on its index's weekly expiry day, or
  tagged non-expiry on any other day, has its composite score raised by 10 % of its absolute value.
  Composite scores are weighted percentile ranks and are never negative, so this is ×1.10. Reported
  with the weight off (0 %) as an ablation.
- **Pass rule:** over the common test days, Adaptive on T1 (T2) minus Adaptive on Core, mean gross
  per lot-day with the 5-day block bootstrap (2,000, seed 20261012) 90 % interval above zero, and max
  drawdown no worse. Kill: otherwise Core stands. Read once; no re-tuning after the read.
- **Known weaknesses, stated before the run:** the winners are the best of hundreds of settings per
  family, so even first-year-only selection carries a selection effect that the test year must
  overcome; the new variants are simulated after charges and gross (Core-298 results are gross
  only); re-entry types ASAP and COST ×2 are unverified against AlgoTest (BL-009).
- **Will not run:** per-slot winners; changing the list weights or lookbacks; pooling the all-days
  winner into the universe; any deduction.

## Log

- 2026-10-16 — created from the owner's request; Phase 0 registered before the first-year selection
  was run.
