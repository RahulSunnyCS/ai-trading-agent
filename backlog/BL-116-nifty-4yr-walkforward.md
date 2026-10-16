# BL-116 — 4-year NIFTY walk-forward of the T1 selection method

| | |
|---|---|
| **Priority** | P1 — owner's call (2026-10-17); decides whether T1's way of choosing settings can be trusted beyond the one selection now tracked |
| **Status** | Planned |
| **Type** | research |
| **Area** | options |
| **Created** | 2026-10-17 |
| **Depends on** | BL-115 (the T1 method, Experiments 3 and 8), BL-104 (the grids and `daytype_lists`), BL-071 / BL-080 (Core NIFTY results 2022-04 → 2024-10), BL-113 (the forward track) |
| **TODO.md row** | — (filled in when started) |

## Context

BL-115's T1 (Core-298 plus 223 time-generic settings chosen on the first year) beat Core-298 by +₹223 per
lot-day gross over the test year, and the frozen sets won three of four quarters (+341, +241, +343, −10).
But Experiment 3 re-ran the same selection on a rolling 12-month window and the re-selected settings won
only two of four quarters (pooled +70, 90 % [−81, +215]): the method, as opposed to that one selection,
is not shown to work. Four quarters of about 60 days each cannot separate +70 from +200 (one quarter's
standard error is about ±170 per lot-day).

Owner (2026-10-17, chat): "if you have 4 years data, we can go through last 4 years."

What exists:

- **NIFTY 1-minute options 2022-01-03 → 2024-10-08** (682 vendor days, nearest expiry only, thinner
  chains) and Fyers data 2024-10-09 → today. **SENSEX has nothing usable before 2024-09**, so this item is
  NIFTY-only and tests the method on NIFTY's families, not T1 as a whole.
- Per-variant results for the 149 NIFTY Core variants over 2022-04-05 → 2024-10-08 (`research/bl071/
  results/`, the ITM1 files from `research/bl080/results/`), so Adaptive over NIFTY Core can be replayed
  there without new engine runs.
- BL-104's grids (Stage 1, premium coarse/refine, the 12 sampled slots) exist only for 2024-10-09 →
  2026-10-09; the selection needs them over the vendor days too.

## Goal

A walk-forward of the T1 selection method over about 14 quarters (2023-04 → 2026-10) on NIFTY: does
Adaptive over NIFTY Core plus each quarter's freshly selected settings beat Adaptive over NIFTY Core, often
enough and by enough to trust the method?

## Out of scope

- SENSEX (no history), Buy if the vendor chains cannot price its premium strikes (checked in Phase 1).
- Any change to the live lists or the T1 track (BL-113 keeps its frozen sets).
- New families or parameters beyond BL-104's grids.

## Plan

### Phase 0 — Pre-register
Filled in and committed before any selection or replay. Drafted defaults, to confirm with the owner:

- **Hypothesis:** quarter-ahead, NIFTY Core + re-selected settings beats NIFTY Core under Adaptive.
- **Universe:** the 149 NIFTY Core variants (point-in-time: the same files throughout) plus each fold's
  winners at all 25 entry times; NIFTY families N_wide, NIFTY Widesl premium, N_dir, N_ditm1 and (if Phase 1
  allows) NIFTY Buy premium.
- **Folds:** trade each calendar quarter from 2023-04 to 2026-10-09; select on the window before it
  (scheme from BL-115 Experiment 8: growing window if it passed or beat the fixed one, otherwise both
  schemes, each judged); never reads its quarter.
- **Look-ahead check:** selection uses only days before the quarter; Adaptive ranks on results before each
  day; lot sizing `current`; expiry days from the observed expiry list of the time (Thursday weeklies
  before 2025).
- **Pass / kill rule (draft):** pass if the method beats NIFTY Core in ≥ 60 % of quarters, the pooled
  90 % block-bootstrap interval (5-day blocks, 2,000 resamples) is above zero, and both eras (before and
  after 2024-10-09) are positive on their own. Net of charges as well as gross.
- **Hold-out:** none unseen; 2022-04 → 2024-10 has been read for other questions (BL-071, BL-075, BL-081,
  BL-083, BL-110) but never for this method. The forward track (BL-113) stays the real confirmation.
- **Will not run:** SENSEX; other selection rules or margins; per-quarter tuning.

### Phase 1 — Data and baseline
- **Tasks:** check vendor-day coverage for each family's strikes (premium strikes and OTM3 on thin chains;
  no-contract days counted); replay Adaptive over NIFTY Core 2022-04 → 2026-10 and check it against
  BL-071's totals; build the expiry-day list for the Thursday era.
- **Done when:** the baseline reproduces and every family's coverage is reported.

### Phase 2 — Grids over the vendor days
- **Tasks:** run BL-104's NIFTY grids (Stage 1, premium, the 12 sampled slots) over 2022-04 → 2024-10;
  resumable, overnight, 3 workers.
- **Done when:** every cohort has a series file for every vendor day.

### Phase 3 — Select, simulate, replay, decide
- **Tasks:** per fold, `daytype_lists` on its window; simulate the winners at 25 slots; replay; apply the
  rule once; record the table and update the findings pages.
- **Done when:** the rule is applied and the owner has the table.

## Risks

- **Different market before 2024:** Thursday expiries, four index weeklies until November 2024, lot sizes
  50 → 25 → 75 → 65. The owner's BL-104 view was that the market changed in early 2024; the era split in
  the rule guards against one era carrying the result.
- **Thin vendor chains:** far strikes and small premiums may be missing, which changes what a "closest
  premium ₹X" strike means. Phase 1 measures it before anything is selected.
- **Compute:** Phase 2 is roughly one to two nights on a free laptop (8 GB; at most 3 workers next to
  anything else, or it swaps).
- **Low power remains:** 14 quarters is better than 4, but a +₹100 edge is still hard to prove.

## Open questions

1. NIFTY-only acceptable as the test of the method (SENSEX cannot be tested before 2024-09)?
2. Pre-2024 quarters as equal evidence, or advisory (as BL-104 treated them)?
3. Include NIFTY Buy if Phase 1 shows its premium strikes are mostly priced?
4. Gross or net as the deciding unit (draft: both must pass)?

## Log

- 2026-10-17 — created at the owner's request after BL-115 Experiment 3 failed; P1 (owner).
