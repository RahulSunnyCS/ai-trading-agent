# BL-127 — NIFTY Widesl ₹80 / ₹100 / ₹120: choose a stop per premium, keep the best two in Adaptive

| | |
|---|---|
| **Priority** | P3 — owner's idea, follows BL-126 |
| **Status** | Done — informative, not adopted: Stage C not positive (selected stops add nothing to Adaptive on the test year) |
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
- 2026-10-18 — **Run (Phase 0 followed exactly; no rule changed).** Code and a small JSON summary:
  `packages/option-backtesting/research/bl127/` (`bl127_selection_2026-10-18.json`; generated variants and results are
  git-ignored). **All figures are gross per lot-day** (the strategy files carry no per-order cost, so the engine's net
  equals gross; they cannot be read beside after-charges figures such as BL-098's).

  **What was run.** `gen_variants.py` wrote 400 files (16 cells × 25 slots) from Core's `N_p100_<HHMM>` text: only both
  legs' closest premium and stop percent (and the strategy id) differ, checked by a parsed comparison and a changed-line
  count. First confirmed that all 25 Core `N_p80_<HHMM>` files equal `N_p100_<HHMM>` apart from id and premium, so the
  two 115 % cells are Core's own files and their stored results are used. Ids are `N_p<premium><SL>_<HHMM>`
  (`N_p8060_0917`, `N_p12070_0917`, `N_p120115_0917`); the family is `p` + digits, so `is_wide` is True, no `-`, so it is
  not a track, and none clashes with Core (p80, p100, p250, p320) or T1 (p150, p285, ...). `N_p12060` is the same
  strategy as BL-126's X2 (premium ₹120, SL 60 %); its 495-day mean here (+231) equals BL-126's. Simulated with BL-126's
  path (`load_day` + `simulate_day`, the code `obt rotation update` uses) over the 495 days Core's `N_p100` results exist
  (2024-10-09 to 2026-10-16), written only under `research/bl127/results/`.

  **Parity (before trusting the path).** Core `N_p80_0917` and `N_p100_0917` simulated through this path against the
  stored live results: gross and net equal on 495 of 495 days for each.

  **Stage A — a stop per premium** (selection year 2024-10-09 → 2025-10-08, 248 days; mean over the 25 slots of gross per
  lot-day; drawdown is the largest fall of the cumulative slot-averaged series, per lot; the winner is the highest mean,
  a tie within ₹5 going to the shallower drawdown). Every cell was positive at all 25 slots.

  | Premium | SL | Mean per lot-day | Max drawdown | Slots positive | |
  |---|---:|---:|---:|---:|---|
  | ₹80 | 60 % | +214 | -4,124 | 25 of 25 | |
  | ₹80 | 70 % | +233 | -4,075 | 25 of 25 | within ₹5 of the best, deeper drawdown than 80 % |
  | ₹80 | 80 % | +230 | -4,018 | 25 of 25 | **winner** (tie rule) |
  | ₹80 | 90 % | +223 | -5,730 | 25 of 25 | |
  | ₹80 | 100 % | +224 | -7,176 | 25 of 25 | |
  | ₹80 | 115 % (Core) | +207 | -9,155 | 25 of 25 | |
  | ₹100 | 60 % | +255 | -4,649 | 25 of 25 | |
  | ₹100 | 70 % | +281 | -4,461 | 25 of 25 | **winner** |
  | ₹100 | 80 % | +251 | -5,130 | 25 of 25 | |
  | ₹100 | 90 % | +250 | -6,983 | 25 of 25 | |
  | ₹100 | 100 % | +241 | -9,609 | 25 of 25 | |
  | ₹100 | 115 % (Core) | +230 | -10,839 | 25 of 25 | |
  | ₹120 | 60 % | +268 | -3,900 | 25 of 25 | |
  | ₹120 | 70 % | +295 | -4,061 | 25 of 25 | **winner** |
  | ₹120 | 80 % | +247 | -6,544 | 25 of 25 | |
  | ₹120 | 90 % | +235 | -8,734 | 25 of 25 | |
  | ₹120 | 100 % | +246 | -10,556 | 25 of 25 | |
  | ₹120 | 115 % | +247 | -11,478 | 25 of 25 | |

  The three winners are all new files (neither Core 115 % cell won), so all three went to Stage B. Stops of
  60–80 % have a drawdown of roughly 35 to 60 % of the 115 % cell's at every premium; the mean peaks at 70 % for ₹100 and
  ₹120, and for ₹80 SL 70 % and 80 % are within ₹3 of each other (the tie rule chose 80 %).

  **Stage B — the best two** (Adaptive list C, no expiry rule, over Core-298 + the winner's 25 variants against Core-298
  alone, 2025-01-10 → 2025-10-08, 184 days; Core-298 alone +301 per lot-day, drawdown -11,819; 90 % interval from the
  registered bootstrap, shown for information, the rule ranks the point difference):

  | Rank | Added | With additions | Difference | 90 % interval | Max drawdown (with) | Days a new variant was picked | New picks |
  |---:|---|---:|---:|---|---:|---:|---:|
  | 1 | ₹80, SL 80 % | +323 | **+22** | [-30, +77] | -10,409 | 48 of 184 | 62 |
  | 2 | ₹120, SL 70 % | +315 | **+15** | [-59, +90] | -13,024 | 70 of 184 | 100 |
  | 3 | ₹100, SL 70 % | +291 | -10 | [-83, +67] | -10,120 | 71 of 184 | 105 |

  Kept (largest differences above zero): **₹80 at SL 80 %** and **₹120 at SL 70 %**; ₹100 at SL 70 % was dropped
  (negative). Stage B replays ran on a temporary root holding only rows on or before 2025-10-08.

  **Stage C — test year, read once** (2025-10-09 → 2026-10-16, 244 weekdays; Adaptive list C over Core-298 + the 50 kept
  variants against Core-298; 5-day circular blocks, 2,000 resamples, seed 20261019, two-sided 90 %):

  | Added to the universe | Core-298 | With additions | Difference | 90 % interval | Max drawdown (Core / with) | Days a new variant was picked | New picks | Reading |
  |---|---:|---:|---:|---|---|---:|---:|---|
  | ₹80 SL 80 % + ₹120 SL 70 % (348) | +448 | +439 | -10 | [-82, +63] | -10,688 / -12,436 | 111 of 244 | 174 (₹120 SL 70 %: 135, ₹80 SL 80 %: 39) | **not positive** (interval includes zero; drawdown deeper) |
  | ₹80 SL 80 % alone (323) | +448 | +451 | +3 | [-46, +49] | -10,688 / -9,169 | 70 of 244 | 89 | not positive (interval includes zero; drawdown shallower) |
  | ₹120 SL 70 % alone (323) | +448 | +444 | -5 | [-71, +63] | -10,688 / -11,044 | 96 of 244 | 143 | not positive (interval includes zero; drawdown deeper) |

  With both added, the new variants were picked mostly at the morning entries (0917 31, 0932 24, 0947 27, 1002 11,
  1017 12, 1032 14; 1 to 8 at each other slot), and the picks changed on 123 days (more than the 111 on which a new
  variant was picked, because the family-band criterion pools every Widesl in a band). On the days a new variant was
  picked, the day's gross was +206 with the additions against +218 without.

  **Read under the registered rule.** Not positive: the Stage C interval includes zero for all three arms, and with both
  kept winners the drawdown is deeper than Core-298's. The ₹80 SL 80 % arm alone has the shallower drawdown but a
  difference of +3 with an interval from -46 to +49. Nothing is adopted and no forward track is proposed; the item's
  Phase 1 "done when" is met.

  **What the result says, and its weaknesses.** The selected stops are good standalone in the selection year (Stage A:
  +230 to +295 per lot-day at a third to half of Core's drawdown, positive at every slot), but Adaptive already has
  Core's 115 % Widesl variants to pick from and adding these moved its test-year result by -10 to +3, within noise. The
  Stage B ranking separated nothing either (all three intervals include zero, and the order is the point difference of
  one 184-day replay). Weaknesses as registered: the test year was read by BL-098, BL-104, BL-115 and BL-126 and BL-126
  already showed ₹120 SL 60 % (the same files as this grid's ₹120 SL 60 % cell) over it, so no window here is unseen; the
  25 slots overlap in time, so Stage A means are not independent; gross only, so charges (the same four orders a day for
  every cell) are not in any figure; Stage A's ₹80 winner was a ₹3 call between SL 70 % and 80 %; the stop grid was the
  owner's, not tuned on the test year. Stage C was read once; no other stop, premium or selection rule was run after it.

  **Live store unchanged.** The fingerprint was taken before any simulation (before `simulate.py`) and again after Stage C
  and the summary: equal. It covers the rotation store (journal md5, the 298 result files, 534 files in all, total bytes,
  newest file and its modification time) and the modification times of the top-level entries of `TRADING_DATA_ROOT` plus
  the catalog's size; it does not walk the Parquet lake. Code paths that touch the real root only read it
  (`load_day`, `excluded_map`, the stored Core results, `days.csv`); the replays use temporary roots under
  `research/bl127/results/` (filtered copies for Stages A and B, symlinks for Stage C).
- 2026-10-18 — Review notes (Opus, PR #247; no number changes). The test year has 244 days, not the 247 with
  results: `days.csv` has no rows for 2026-09-23 and 2026-09-24 and Sunday 2026-02-01 is not a weekday, so the replay
  drops them on both sides equally (no bias; the two missing `days.csv` rows are worth a separate look). The
  leg-SL findings page wording was corrected (not every 70–80 % cell beat 115 %; one replay does not show why Adaptive
  gains nothing) and the page is now "Tested".
