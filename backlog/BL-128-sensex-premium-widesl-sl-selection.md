# BL-128 — SENSEX Widesl ₹240 / ₹300 / ₹350: choose a stop per premium, keep the best two in Adaptive

| | |
|---|---|
| **Priority** | P3 — owner's idea, the SENSEX twin of BL-127 |
| **Status** | In progress |
| **Type** | research |
| **Area** | options |
| **Created** | 2026-10-18 |
| **Depends on** | BL-127 (its design and scripts), BL-058 (lists, results store) |
| **TODO.md row** | — (research only) |

## Context

Owner (2026-10-18), after BL-127: "Similarly do with sensex 240, 300, 350". BL-127 (NIFTY ₹80 / ₹100 / ₹120) found
tighter stops clearly better standalone on its first year, but the two kept winners did not improve Adaptive on the
test year (−₹10 per lot-day [−82, +63]). Core's SENSEX premium files are `S_p250` and `S_p320` (call SL 114 %, put
115 %, trail 15 %/10 %, no re-entry, overall ₹2,500); none of ₹240 / ₹300 / ₹350 is a Core premium. This item copies
BL-127's design unchanged except where SENSEX needs otherwise (below).

## Goal

Choose, without reading the test year, one stop per SENSEX premium and then the best two; then say whether Adaptive
with those two added beats Adaptive on Core-298 on the test year. Nothing live changes.

## Out of scope

NIFTY, other premiums, trail / re-entry / max-loss changes, the expiry rule, any change to Core-298, T1 or the live
lists. A forward track is a separate proposal, only after a positive Stage C.

## Plan

### Phase 0 — Pre-register (committed before any run)

- **Grid:** SENSEX Widesl closest premium ₹240, ₹300, ₹350 × leg SL 60, 70, 80, 90, 100, 115 % (the same value on
  both legs; Core's 114 / 115 split is not reproduced). Everything else as Core's `S_p250` (whose file equals
  `S_p320` apart from the premium): sell CE + PE, 1 lot each, weekly expiry, trail 15 %/10 %, no re-entry, overall
  ₹2,500, exit 15:28, partial square-off, current lot sizing. Each cell at the 25 rotation entry times: 18 cells,
  450 new files (no cell is a Core file).
- **Simulation:** BL-127's path, with its parity check repeated on Core `S_p250_0917` and `S_p320_0917`; results only
  under `research/bl128/results/`; the live store, journal and strategy folders are never written. Gross per
  lot-day (no per-order cost in the files; every cell places the same four orders a day).
- **Windows, stages, rules and reading:** exactly BL-127's — selection year 2024-10-09 → 2025-10-08 (Adaptive part
  2025-01-10 → 2025-10-08); Stage A: per premium, the SL with the highest mean gross per lot-day over the 25 slots,
  a tie within ₹5 to the smaller max drawdown; Stage B: Adaptive list C (registered weights and lookbacks, no expiry
  rule) over Core-298 + one winner's 25 variants against Core-298, keep the two with the largest difference above
  zero (fewer if fewer; none → stop); Stage C, read once: Adaptive over Core-298 + the kept winners against Core-298,
  2025-10-09 → latest, paired difference, two-sided 90 % circular block bootstrap (5-day blocks, 2,000 resamples,
  **seed 20261020**), max drawdown, pick counts; each kept winner alone, descriptive. "Positive" = the Stage C
  interval above zero and the drawdown no deeper than Core-298's; positive only allows proposing a pre-registered
  forward-only track.
- **Look-ahead check:** as BL-127 (Stages A and B read no day on or after 2025-10-09, asserted in code, for the new
  files and the Core history the replay reads).
- **Known weaknesses:** as BL-127, plus: the test year is the same one BL-127 just used; the owner chose these
  premiums after seeing BL-127's result; gross only.
- **Will not run:** other SL values, a per-slot choice, a re-run after seeing Stage C, NIFTY and SENSEX together.

### Phase 1 — Run

- **Tasks:** generate 450 files under `research/bl128/`; simulate; Stages A, B, C.
- **Done when:** the Log has the Stage A table, the Stage B ranking and the Stage C read-out, and the leg-SL and
  strike/premium findings pages have a BL-128 row.

## Log

- 2026-10-18 — Created; Phase 0 registered before any run (owner chose the premiums; the rest is BL-127's design).
