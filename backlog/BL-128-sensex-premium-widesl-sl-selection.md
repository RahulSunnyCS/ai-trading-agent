# BL-128 — SENSEX Widesl ₹240 / ₹300 / ₹350: choose a stop per premium, keep the best two in Adaptive

| | |
|---|---|
| **Priority** | P3 — owner's idea, the SENSEX twin of BL-127 |
| **Status** | Done — informative, not adopted: Stage C not positive (the two selected stops add nothing to Adaptive on the test year) |
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
- 2026-10-18 — **Run (Phase 0 followed exactly; no rule changed).** Code and a small JSON summary:
  `packages/option-backtesting/research/bl128/` (`bl128_selection_2026-10-18.json`; generated variants and results are
  git-ignored). The folder is BL-127's code copied (no import across item folders) with SENSEX in place of NIFTY. **All
  figures are gross per lot-day** (the strategy files carry no per-order cost, so the engine's net equals gross; they
  cannot be read beside after-charges figures such as BL-098's).

  **What was run.** `gen_variants.py` first confirmed that all 25 Core `S_p320_<HHMM>` files equal `S_p250_<HHMM>` apart
  from id and premium (parsed comparison; it does), then wrote 450 files (18 cells x 25 slots) from Core's
  `S_p250_<HHMM>` text: only the strategy id, both legs' closest premium and both legs' stop percent differ (Core's call
  114 % / put 115 % become one value on both legs), checked by a parsed comparison and a changed-line count (5 lines, 4
  at SL 115 % where the put already has 115). Ids are `S_p<premium><SL>_<HHMM>` (`S_p24060_0917`, `S_p300115_0917`);
  every one parses as a Widesl (`is_wide`) on SENSEX (`underlying_of`), is not a track, and clashes with no Core-298, T1
  or BL-127 name. Simulated with BL-126's path (`load_day` + `simulate_day`, the code `obt rotation update` uses) over the
  495 days Core's `S_p250` results exist (2024-10-09 to 2026-10-16), written only under `research/bl128/results/`.

  **Parity (before trusting the path).** Core `S_p250_0917` and `S_p320_0917` simulated through this path against the
  stored live results: gross and net equal on 495 of 495 days for each.

  **Stage A — a stop per premium** (selection year 2024-10-09 -> 2025-10-08, 248 days; mean over the 25 slots of gross per
  lot-day; drawdown is the largest fall of the cumulative slot-averaged series, per lot; the winner is the highest mean,
  a tie within ₹5 going to the shallower drawdown; no tie arose):

  | Premium | SL | Mean per lot-day | Max drawdown | Slots positive | |
  |---|---:|---:|---:|---:|---|
  | ₹240 | 60 % | +153 | -9,013 | 25 of 25 | **winner** |
  | ₹240 | 70 % | +142 | -9,616 | 24 of 25 | |
  | ₹240 | 80 % | +127 | -9,132 | 23 of 25 | |
  | ₹240 | 90 % | +102 | -10,535 | 25 of 25 | |
  | ₹240 | 100 % | +94 | -11,954 | 21 of 25 | |
  | ₹240 | 115 % | +86 | -13,350 | 21 of 25 | |
  | ₹300 | 60 % | +160 | -10,121 | 24 of 25 | **winner** |
  | ₹300 | 70 % | +143 | -10,678 | 22 of 25 | |
  | ₹300 | 80 % | +112 | -9,255 | 20 of 25 | |
  | ₹300 | 90 % | +90 | -13,888 | 22 of 25 | |
  | ₹300 | 100 % | +91 | -13,453 | 20 of 25 | |
  | ₹300 | 115 % | +103 | -13,095 | 20 of 25 | |
  | ₹350 | 60 % | +155 | -11,164 | 22 of 25 | **winner** |
  | ₹350 | 70 % | +115 | -10,370 | 21 of 25 | |
  | ₹350 | 80 % | +90 | -12,509 | 21 of 25 | |
  | ₹350 | 90 % | +76 | -14,919 | 18 of 25 | |
  | ₹350 | 100 % | +94 | -15,076 | 21 of 25 | |
  | ₹350 | 115 % | +92 | -14,250 | 21 of 25 | |

  All three winners are at SL 60 %, the lowest value on the grid, with no tie; the mean falls steadily as the stop widens at
  ₹240; at ₹300 it dips at 90-100 % and recovers at 115 %, and at ₹350 it bottoms at 90 % (+76) before +94 / +92. The 60 % cells have 68 % (₹240), 77 % (₹300)
  and 78 % (₹350) of the 115 % cell's drawdown. Unlike BL-127's NIFTY grid (peak at 70-80 %, every cell positive at all 25
  slots), the SENSEX cells are positive at 18 to 25 slots. Because the optimum sits on the edge of the grid, a still
  tighter stop might do better; it was not run (registered: no other SL values).

  **Stage B — the best two** (Adaptive list C, no expiry rule, over Core-298 + the winner's 25 variants against Core-298
  alone, 2025-01-10 -> 2025-10-08, 184 days; Core-298 alone +301 per lot-day, drawdown -11,819, the same figure as
  BL-127's Stage B; 90 % interval from the registered bootstrap, shown for information, the rule ranks the point
  difference):

  | Rank | Added | With additions | Difference | 90 % interval | Max drawdown (with) | Days a new variant was picked | New picks |
  |---:|---|---:|---:|---|---:|---:|---:|
  | 1 | ₹300, SL 60 % | +380 | **+79** | [+15, +149] | -11,416 | 50 of 184 | 68 |
  | 2 | ₹240, SL 60 % | +362 | **+62** | [-4, +131] | -11,457 | 41 of 184 | 57 |
  | 3 | ₹350, SL 60 % | +350 | +49 | [-21, +123] | -10,242 | 61 of 184 | 79 |

  Kept (largest differences above zero): **₹300 at SL 60 %** and **₹240 at SL 60 %**; ₹350 at SL 60 % was dropped as
  third. Stage B replays ran on a temporary root holding only rows on or before 2025-10-08 (asserted in code on the
  files, the days table and the reconstruction).

  **Stage C — test year, read once** (2025-10-09 -> 2026-10-16, 244 days: SENSEX has 247 scored days, but the replay skips Sunday 2026-02-01 and `days.csv` has no rows for 2026-09-16 and 2026-09-17, so both sides drop them equally; Adaptive list C over Core-298 + the 50 kept
  variants against Core-298; 5-day circular blocks, 2,000 resamples, seed 20261020, two-sided 90 %):

  | Added to the universe | Core-298 | With additions | Difference | 90 % interval | Max drawdown (Core / with) | Days a new variant was picked | New picks | Reading |
  |---|---:|---:|---:|---|---|---:|---:|---|
  | ₹300 SL 60 % + ₹240 SL 60 % (348) | +448 | +447 | -2 | [-88, +79] | -10,688 / -12,307 | 101 of 244 | 180 (₹300: 118, ₹240: 62) | **not positive** (interval includes zero; drawdown deeper) |
  | ₹300 SL 60 % alone (323) | +448 | +468 | +20 | [-56, +92] | -10,688 / -8,997 | 96 of 244 | 156 | not positive (interval includes zero; drawdown shallower) |
  | ₹240 SL 60 % alone (323) | +448 | +474 | +25 | [-42, +95] | -10,688 / -9,970 | 83 of 244 | 134 | not positive (interval includes zero; drawdown shallower) |

  With both added, the new variants were picked most at 1002 (37) and 0947 (27), then 1047 (13), 1317 (12), 1302 (11),
  1017 and 1102 (10 each), 0917 and 0932 (9 each); the picks changed on 124 days (more than the 101 on which a
  new variant was picked, because the family-band criterion pools every Widesl in a band). On the 101 days a new variant
  was picked, the day's gross was +313 with the additions against +268 without (+4,477 in all). Of the other 143 days, 120
  have identical picks (difference exactly 0); the whole −4,880 falls on 23 days where the picks changed but no new
  variant was picked (family-band pooling displaced Core picks), about −212 a day (corrected after review).

  **Read under the registered rule.** Not positive: the Stage C interval includes zero for all three arms, and with both
  kept winners the drawdown is deeper than Core-298's. The two single-addition arms (descriptive) have a shallower
  drawdown and a point difference of +20 and +25, intervals from -56 to +92 and -42 to +95. Nothing is adopted and no
  forward track is proposed; the item's Phase 1 "done when" is met.

  **What the result says, and its weaknesses.** As for NIFTY in BL-127, the selected stops are clearly better standalone in
  the selection year (+153 to +160 per lot-day against +86 to +103 at 115 %, 22–32 % less drawdown), and in
  Stage B the ₹300 gain even had an interval above zero (+79 [+15, +149]). None of that carried into the next year: the
  test-year difference is -2 with both added, +20 / +25 alone, all within noise. The Stage B ranking separated little
  (one of three intervals above zero, the order the point difference of one 184-day replay) and Stage B's lead for ₹300 did
  not repeat in Stage C (alone +20, below ₹240's +25). Weaknesses as registered and added: the test year is the same one
  BL-127, BL-126, BL-098, BL-104 and BL-115 read; the owner chose the premiums after seeing BL-127's result; the 25 slots
  overlap in time, so Stage A means are not independent; all three winners are at the grid's lowest stop, so the "best
  stop" is an edge value, not a peak; at ₹350 and ₹300 the winner is positive at 22 and 24 of 25 slots, not all; SENSEX
  has 18 to 25 positive slots per cell where NIFTY had 25; gross only, so charges (the same four orders a day for every
  cell) are in no figure. Stage C was read once; no other stop, premium or selection rule was run after it.

  **Live store unchanged.** The fingerprint was taken before any simulation (before `simulate.py`, including the parity
  run) and again after Stage C: equal. It covers the rotation store (journal md5, the 298 result files, file count, total
  bytes, newest file and its modification time) and the modification times of the top-level entries of
  `TRADING_DATA_ROOT` plus the catalog's size; it does not walk the Parquet lake. Code paths that touch the real root
  only read it (`load_day`, `excluded_map`, the stored Core results, `days.csv`); the replays use temporary roots under
  `research/bl128/results/` (filtered copies for Stages A and B, symlinks for Stage C).
- 2026-10-18 — Review notes (Opus, PR #248; no number changes, the reading stands). The test-year day count is now
  explained (SENSEX's missing `days.csv` dates differ from BL-127's NIFTY ones; the live `days.csv` lacks four weekdays
  in all, 2026-09-16, 09-17, 09-23 and 09-24, each with results for one index only: worth a separate look). The Stage C
  mechanism and the drawdown wording were corrected; the branch was brought up to date with BL-127's corrected
  findings page. The `other_ids()` clash check covers Core, T1 and BL-127 names only, not BL-126 (no BL-126 id starts
  with `S_`, so no clash was possible).
