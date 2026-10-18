# BL-127 — NIFTY Widesl ₹80 / ₹100 / ₹120: choose a stop per premium, keep the best two in Adaptive

| | |
|---|---|
| **Priority** | P3 — owner's idea, follows BL-126 |
| **Status** | In progress |
| **Type** | research |
| **Area** | options |
| **Created** | 2026-10-18 |
| **Depends on** | BL-126 (its simulation and replay scripts), BL-058 (lists, results store) |
| **TODO.md row** | — (research only; a row is added if it goes further) |

## Context

Owner (2026-10-18), after BL-126: try NIFTY ₹80, ₹100 and ₹120 Widesl with many stop-losses (60 %, 70 %, 80 %,
90 % and so on), choose the best stop for each premium, put those in Adaptive, and keep the best two.

Core already has `N_p80` and `N_p100` (SL 115 %, trail 15 %/10 %, no re-entry, overall ₹2,500). BL-126 found
₹100 SL 75 % and ₹120 SL 60 % not positive (in-sample, every window). BL-098 Phase 2 and the BL-104 summaries already
looked at tighter stops on these files. So no window is unseen; the design below at least keeps the choosing apart
from the test.

## Goal

Choose, without looking at the test year, one stop per premium and then the best two premiums; then say whether
Adaptive with those two added beats Adaptive on Core-298 on the test year. Nothing live changes.

## Out of scope

SENSEX, other premiums, trail / re-entry / max-loss changes, the expiry rule, any change to Core-298, T1 or the live
lists. A forward track is a separate proposal, only after a positive Stage C.

## Plan

### Phase 0 — Pre-register (committed before any run)

- **Grid:** NIFTY Widesl closest premium ₹80, ₹100, ₹120 × leg SL 60, 70, 80, 90, 100, 115 % (both legs). Everything
  else as Core's `N_p100`: sell CE + PE, 1 lot each, weekly expiry, trail 15 %/10 %, no re-entry, overall ₹2,500,
  exit 15:28, partial square-off, current lot sizing. Each cell at the 25 rotation entry times. ₹80 / ₹100 at 115 %
  are Core's own files (not simulated again; their stored results are used).
- **Simulation:** BL-126's path (`load_day` + `simulate_day`, the code `obt rotation update` uses), its parity check
  repeated on Core `N_p80_0917` and `N_p100_0917`; results only under `research/bl127/results/`; the live store,
  journal and strategy folders are never written. Gross per lot-day (the files carry no per-order cost; every cell
  places the same four orders a day, so charges do not change the ranking).
- **Windows:** selection year 2024-10-09 → 2025-10-08 (Adaptive replay part 2025-01-10 → 2025-10-08, after the
  63-day warm-up); test year 2025-10-09 → latest scored day.
- **Stage A — stop per premium (selection year only):** for each premium, the SL with the highest mean gross per
  lot-day averaged over the 25 slots; a tie within ₹5 goes to the smaller max drawdown of the slot-averaged series.
  Reported for every cell (mean, drawdown, slots positive), selection year only.
- **Stage B — the best two (selection year only):** for each premium winner that is not already a Core file (₹80 or
  ₹100 at 115 % adds nothing), replay Adaptive list C (registered weights and lookbacks, no expiry rule) over
  Core-298 + that winner's 25 variants against Core-298 alone, 2025-01-10 → 2025-10-08, gross per lot-day as the
  read-out defines it. Keep the two with the largest difference above zero (fewer if fewer are above zero; none →
  stop, Stage C does not run).
- **Stage C — test (test year, read once):** Adaptive over Core-298 + the kept winners (all together) against
  Core-298, 2025-10-09 → latest; paired difference, two-sided 90 % circular block bootstrap (5-day blocks over
  ordered days, 2,000 resamples, seed 20261019), max drawdown, how often a new variant is picked. Also each kept
  winner alone (descriptive).
- **Reading:** "positive" = the Stage C interval above zero and the drawdown no deeper than Core-298's. Positive only
  allows proposing a pre-registered forward-only track; nothing is adopted from this item.
- **Look-ahead check:** strikes chosen at entry from that minute's chain (engine rule); the replay scores day d on
  results before d only; Stages A and B read no test-year day (asserted in code).
- **Known weaknesses:** the test year has been read by BL-098, BL-104, BL-115, BL-126 and others, and BL-126 already
  showed ₹100 SL 75 % and ₹120 SL 60 % over it; the 25 slots overlap; gross only.
- **Will not run:** other SL values, a per-slot or per-band choice, a re-run with a different selection rule after
  seeing Stage C.

### Phase 1 — Run

- **Tasks:** generate the 16 new cells × 25 slots (400 files) under `research/bl127/`; simulate; Stages A, B, C.
- **Done when:** the Log has the Stage A table, the Stage B ranking and the Stage C read-out under the rule above, and
  the findings pages for leg SL and strike/premium have a BL-127 row.

## Log

- 2026-10-18 — Created; Phase 0 registered before any run (owner chose the premiums, the SL range and "keep the best
  two"; the windows and selection rules are Claude's, so that the choosing never reads the test year).
