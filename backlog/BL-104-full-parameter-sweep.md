# BL-104 — Full-factorial parameter sweep: Widesl (incl. ATM), Dir and Buy

| | |
|---|---|
| **Priority** | P1 — the owner's "proper sweep over every parameter" before any of these families gets real money |
| **Status** | Done (2026-10-28) on the advisory result: Stages 1–3 and the 2022–24 advisory run done; no forward test of the finalists (T1 / BL-113 and the BL-106 pool carry the forward evidence); finalists' correlation, Buy ₹1-per-fill and the bootstrap vs BL-099 not run; the tail gate and the Buy 60 % day-stop cap never registered (descriptive only) |
| **Type** | research |
| **Area** | options |
| **Created** | 2026-10-14 |
| **Depends on** | BL-096 / BL-097 / BL-098 (their one-factor screens; this item absorbs their Phase 3), BL-009 (re-entry parity still open) |
| **TODO.md row** | 3.10.26 |

## Context

Three one-factor sweeps exist: BL-096 (Dir: SL × MTM × exit, 15,000 cells), BL-097 (Buy) and
BL-098 (Widesl), each changing one control at a time from the rotation files. Their Phase 3
(interactions) never ran, and BL-099 chose winners on the 2025-10-09 → 2026-10-09 "holdout", so
that window is spent. The owner (2026-10-14) asked for one proper sweep: every parameter of every
family, coarse steps first, a scorecard that trades return against drawdown rather than ranking
on net, strike as an axis (ATM through OTM3 and closest premium), targets for Buy, Buy's stop at
₹1,000 too, SENSEX premiums at three times NIFTY's, a read-out per entry band so "ATM in the
morning, ITM in the afternoon" is a question the tables answer, and **no curve fitting**.

What is reused: the legwise engine (`legwise/engine.simulate_day`), the BL-097 runner pattern,
the BL-096 charge model, `analytics/overfit.run_cscv` (through the BL-068 adapter),
`rotation/readout.block_bootstrap_mean`, `analytics/correlation.analyse`, `margin.csv`.

Not possible in the engine, so not swept: AlgoTest's "simple momentum" / symbol-momentum entries
(the schema rejects them), futures, positional. Not swept by choice: CE/PE-asymmetric rules
(BL-098's "will not run"), a second rotation universe.

## Goal

For each family × index × entry band, either a parameter set that beats the current rotation
template with evidence that survives the robustness checks, or a reasoned "keep the template".
Every number reproducible from `packages/option-backtesting/research/bl104/`.

## Out of scope

- Changing any file under `strategies/rotation/` or the journal's 298 universe.
- Per-slot parameter choices (one set per band, shared across its slots).
- Values between the coarse grid's steps (Stage 2 checks flatness; it does not promote them).
- Portfolio-level stops (BL-095), intraday triggers (BL-083), CE/PE asymmetry.

## Plan

### Phase 0 — Pre-register (committed 2026-10-14, before any run beyond a 3-cell smoke)

- **Hypothesis:** for each family, a region of the coarse parameter grid exists whose cells all
  beat the current template on net ₹ per lot-day after charges with no worse drawdown and Ulcer,
  consistently across the band's entry slots and across half-years; if no such region exists the
  template stands.
- **Universe:** NIFTY and SENSEX weekly options from the lake, the rotation files
  `strategies/rotation/<N|S>_<wide|dir|buy>_<HHMM>.yaml` as each cohort's template, at seven
  entry slots 09:17, 09:32, 09:47, 10:17, 11:32, 13:02, 14:32 (bands A, A, A, B, B, C, D). Both
  legs symmetric; weekly expiry; partial square-off; `lot_sizing: current` at `SIZING_DATE`
  2026-10-12; slippage 0; charges = the BL-096 model (₹20 per order, STT 0.10 % → 0.15 % from
  2026-04-01, exchange, SEBI/IPFT, stamp, 18 % GST), plus the same trades re-priced at today's STT.
- **Grid** (`research/bl104/grid.py`, version `bl102-stage1-2026-10-14`, **SHA `6a1078bb4fe68786`**,
  held by `tests/unit/test_bl104_grid.py`):

  | Family | Axes | Cells |
  |---|---|---|
  | W Widesl incl. ATM | strike {ATM, OTM1, OTM2, OTM3, P-low, P-high: NIFTY ₹60/₹100, SENSEX ₹200/₹320} × leg SL {40, 60, 80, 100, 120, 150 %} × trail {none, [15,10] %, [25,15] %} × MTM {none, 2,000, 3,000, 4,000} × exit {15:10, 15:28} × re-entry {none, RE COST ×1} | 24,192 |
  | D Dir | strike {ITM2, ITM1, ATM, OTM1} × leg SL {10, 15, 20, 25, 30, 40 %} × MTM {none, 2,000, 3,000, 4,000} × re-entry {none; RE COST ×1; RE COST ×2; RE ASAP ×1; each with cutoff none / 13:00} × trail {none, [10,5] %}; exit 15:28; cutoff cells at 13:02 and 14:32 excluded as duplicates of no re-entry | 16,512 |
  | B Buy | strike {ATM, OTM1, P-low/mid/high: NIFTY ₹30/₹50/₹75, SENSEX ₹90/₹150/₹225} × range {10, 15, 30 min} × source {instrument, underlying} × leg SL {20, 30, 40 %} × target {none, 50, 100 %} × trail points {none, [1,1], [3,1]; SENSEX ×3} × MTM {1,000, 2,000}; exit 15:14, gap 0, no valid-until | 22,680 |

  Plus one template cell per cohort (the rotation file as-is; SENSEX Widesl keeps CE 114 / PE 115)
  as the regression anchor: 63,384 grid cells + 42 templates.
- **Window:** 2024-10-09 → 2026-10-09, per-underlying day lists from `data_quality` (490 NIFTY,
  490 SENSEX on 2026-10-14), weekend sessions excluded. The whole window is the fit (owner:
  "the market changed in early 2024"; the two years are the evidence that matters).
- **Look-ahead check:** every cell is a fixed rule applied day by day from the day's own bars;
  the strike or closest-premium contract is chosen at the entry minute from that day's chain;
  nothing in a cell reads a later day. Selection happens only after the whole grid has run.
- **Hold-out:** none unseen — BL-099 already used 2025-10-09 → 2026-10-09 for selection, and
  this item is honest about that. Protection against snooping is procedural: the plateau rule,
  PBO per cohort, the block-bootstrap interval against the template, half-year consistency,
  slot breadth, and the forward paper test. NIFTY finalists get **one** advisory run on
  2022-01-03 → 2024-10-08 (BL-071's 682 vendor days; nearest-expiry chains, pre-reference
  tables, a price seam at 2024-10): a sign flip in one band is a caution flag, a flip in every band
  of a family returns that family to "research only". SENSEX has no older usable data.
- **Scorecard.** Gates (all must pass before a cell is ranked): results on ≥ 95 % of the
  cohort's sessions and, for W and D, an entry on ≥ 95 % of them (a premium strike with no
  contract that day is a ₹0 day, not a result; clarified 2026-10-15 after review); net after charges > 0; **Calmar ≥ 1.0** (annualised net per lot ÷ |max
  drawdown| per lot, annualised as net ÷ days × 252: the worst fall is earned back within a
  year); profit factor ≥ 1.05; MTM-stop days ≤ 30 %; Buy only: entry hit rate ≥ 40 %.
  **Ranking: Martin ratio** (annualised net ÷ Ulcer index), tie-break ₹/lot-day. **Plateau
  rule:** a cell's robust score is min(own Martin, median Martin of its ±1-step neighbours along
  each axis chain in `grid.CHAINS`); a cell with a gate-failing neighbour is not a candidate
  (**superseded 2026-10-15, before Stage 1 was scored:** a candidate passes its own gates and at
  least half of its neighbours pass; a failing neighbour still pulls the median down. Reason in
  the Log.) The
  band winner is the parameter set with the best robust score averaged over the band's slots.
  Reported per cell: net, ₹/lot-day, median day, day win rate, worst day, max DD and recovery
  days, Ulcer, CVaR95, longest losing streak, profit factor, payoff ratio, expectancy and win rate
  per trade, MTM-stop frequency, orders/day, charges per day and charge drag, net at today's
  rates, Calmar, Martin. Owner (2026-10-15): the unit is rupees per lot, no return-on-margin
  view (the `return_on_capital_pct` column stays in the CSVs where a margin row exists, and is
  not shown in the tables). Family secondaries (read, not scored): W tail ratio,
  both-legs-stopped days, premium-strike no-contract days; D re-entry contribution, CE/PE net,
  one- vs both-leg SL days; B hit rate, payoff and profit factor instead of win rate, hold
  minutes, target vs SL vs time exits.
- **Pass / kill rule.** Default: **keep the template.** A band's candidate replaces it only if
  ALL hold: (1) block-bootstrap 90 % interval (5-day circular blocks, 2,000 resamples, seed
  20261012) of (candidate − template) ₹/lot-day has a lower bound > 0 at the band's slots pooled;
  (2) max drawdown and Ulcer no worse than the template's by more than 10 %; (3) Stage 2
  neighbourhood median Martin ≥ 70 % of the winner's; (4) across all 25 rotation slots the
  candidate's sign of ₹/lot-day and Calmar ≥ 1 hold on ≥ 70 % of the band's slots; (5) ₹/lot-day
  positive in ≥ 3 of the 4 half-years and no half-year with Calmar < 0.5; (6) the cohort's
  CSCV PBO (8 and 16 blocks over the whole Stage-1 matrix) ≤ 0.5; (7) ≤ 60 % of the edge from one
  DTE bucket or one VIX band (else a "regime bet" flag); (8) not dependent on RE ASAP or RE COST
  ×2 while BL-009's parity is open (`parity_unverified`). At most one finalist per family ×
  index × band (≤ 24). Kill: a family whose Stage-1 best robust cell fails the gates in every
  band stays on its template with no Stage 2.
- **Will not run:** CE/PE-asymmetric stops/trails/re-entries; finer steps than Stage 2's
  neighbourhoods; per-slot parameter sets; a second pass on the grid after reading results;
  extending any axis past its registered range. Any of these needs `override: <reason>` here.

### Phase 1 — Stage 1: the coarse grid
- **Tasks:** `run_grid.py --family all --workers 3` (one job per cohort, resumable parts,
  series matrices); `score.py` gates, Martin, plateau, band tables; the rupee regression of the
  template cells against BL-096/097/098.
- **Deliverables:** `results/stage1/{W,D,B}_summary.csv`, `results/stage1/series/*.npy`,
  `results/stage1/*_ranked.csv`, `results/stage1/band_tables.md`; the regression numbers in this Log.
- **Done when:** every cohort has a part and a series; the template cells reproduce the earlier
  sweeps to the rupee (or the difference is explained); the band tables are read by the owner.

### Phase 2 — Stage 2: plateau flatness
- **Tasks:** `stage2.py` writes `results/stage2/cells.json` (the winners' neighbourhoods: W SL
  90/110/130, trails [10,5] [20,10] [20,15], MTM 1,500/2,500/3,500/5,000, exits 14:50/15:00/15:20,
  RE COST ×2 and RE ASAP ×1, `square_off: complete` without re-entry; D SL ±3, MTM
  2,500/3,500/5,000, exit 15:10, cutoffs 11:00/12:00 at earlier slots, trails [5,5] [15,5]; B gap
  0.5/1/2 %, valid-until +30/+60 clamped to the exit, MTM none/1,500/3,000, exits 15:00/15:28,
  range 5/20, target 30/150 %), committed dated before the run; `run_grid.py --cells`.
- **Done when:** each winner carries its neighbourhood median; fragile winners are demoted.

### Phase 3 — Stage 3: breadth and robustness
- **Tasks:** all 25 slots for each finalist (`--slots all25 --cells`), slippage 0 / 0.25 / 0.5 %
  and `lot_sizing: historical` once, half-years, numpy CSCV (16 blocks; pinned to `run_cscv` at
  8), bootstrap vs template and vs the BL-099 pick, DTE / VIX strata, correlation among finalists,
  Buy ₹1-per-fill sensitivity.
- **Done when:** every finalist has a pass/fail against the eight conditions above.

### Phase 4 — Advisory confirm and forward
- **Tasks:** NIFTY finalists once on 2022-01-03 → 2024-10-08; finalists as YAML under
  `strategies/sweep_finalists/`; owner decision on a nightly
  `obt legwise rerun --strategies-dir strategies/sweep_finalists` after `obt daily` (no
  evening-pipeline change); read-out after 60 forward days.

## Risks

- Nothing is unseen: a result here is in-sample by construction; the forward test is the only
  true out-of-sample evidence, and the write-up says so.
- Pre-2024-10 vendor days differ in chain depth and have a price seam; the advisory run is not
  a like-for-like comparison.
- Re-entry parity with AlgoTest (RE COST gap fills, RE ASAP) is open; cells that lean on it are
  flagged, never adopted.
- 8 GB laptop: one worker per cohort peaks ~0.4 GB; three workers as the owner asked.

## Open questions

- Whether the owner wants the Stage-2 neighbourhoods run at all for a family whose Stage-1 best
  robust cell is the template itself (default: no).

## Log

- 2026-10-14 — created from the owner's request and the planning session; Phase 0 registered
  with grid SHA `6a1078bb4fe68786` (63,384 cells + 42 templates). Smoke run: 3 cells × 8 days
  (results identical on rerun; parts skipped). BL-096/097/098 Phase 3 superseded by this item.
- 2026-10-15 — owner: judge in rupees per lot, no return-on-margin percentage. The nominal
  SENSEX margin row added on 2026-10-14 is to be removed from `margin.csv` once Stage 1's
  workers (which read it) have finished. Regression: the weekend-less 488-day templates differ
  from BL-097/098 only by the two weekend sessions (four trades); NIFTY Widesl max drawdown and
  worst day match to the paisa. Stage 1 started 23:45 IST on 2 workers.
- 2026-10-15 — **Regression to the rupee passed** (`check_regression.py --tag regression490`, the
  templates run with `--weekends`): all six Widesl / Buy template cells equal the BL-097/098
  `baseline` rows on every compared column over 490 days (net N_wide ₹1,13,165.91, S_wide
  ₹1,26,435.10, N_buy ₹19,427.16, S_buy -₹9,192.57); the Dir templates summed over BL-096's
  488-day NIFTY∩SENSEX set equal its charged fit+holdout nets (N ₹47,223.19, S ₹1,24,069.94).
  BL-096's set keeps the two weekend sessions (2025-02-01, 2026-02-01) and drops two unmatched
  days; Stage 1 uses the registered per-underlying lists without weekends (488 each).
- 2026-10-15 — owner asked whether parameters should vary by weekday (e.g. ₹50 premium on
  some days, ₹80 on others). Decision: no — five times the trials on a fifth of the days each is
  curve fitting, and day-type conditioning already lives in the rotation's picker (BL-058),
  which chooses among fixed strategies by weekday / DTE / VIX. Weekday is added to the Stage-3
  strata read-out as a reported stratum only (not a flag). A single mechanism-based split
  (expiry day vs not) may become its own pre-registered item after Stage 3 if the strata
  warrant it.
- 2026-10-15 — PR #218 review (Opus) found two places where the code was looser than the text
  and one gate that could not fail. **Plateau rule superseded** (above): the strict "any failing
  neighbour disqualifies" wording would let one unlucky neighbour at the loose edge of an axis
  (MTM none, SL 150) kill a genuine plateau, while a median over the neighbours already punishes
  a cliff; the implemented rule (own gates + at least half the neighbours pass, robust = min(own,
  median)) is what is registered from here. Disclosure: before this supersession two Widesl
  NIFTY cohorts (09:17, 09:32) had been scored and read with the implemented rule, not the
  strict one; nothing was selected. **Coverage gate** clarified as an entry on ≥ 95 % of
  sessions for W / D. **Stage 2** code brought to exactly the registered lists (D SL ±3 inside
  10–40, W SL 90/110/130, no value past a Stage-1 range, W-only square-off complete, every listed
  exit tried). Buy `valid_until` is clamped to the exit as registered. Parts now carry a run
  signature (grid SHA, window, weekends, cell count, slippage, lot sizing) and are reused only
  when it matches; the finalist verdict reads rules 3 (flatness), 4 (breadth over the 25 slots,
  new `robust.py breadth`) and 6 (PBO) and prints PENDING until they exist. W tail ratios
  (worst day and CVaR95 over the average day) and D re-entry net are now reported; the template
  appears in the band ranking so "the template is the best" is visible.
- 2026-10-15 — **Stage 1 done** (42 cohorts, 63,426 cells, 488 days each, 04:00 IST; two workers,
  ~4 h). Scored with `score.py` and `robust.py pbo` / `finalists` (rules 3 and 4 pending: they
  need Stage 2 and the 25-slot run). Gate passes: W 4,682 / 24,206, D 7,862 / 16,526, B 701 /
  22,694. Band winner vs template, ₹ per lot-day, after charges (in-sample):

  | Band | Template | Best set | Best | Rules failed so far |
  |---|---:|---|---:|---|
  | W NIFTY A | 175 | OTM1 SL150 trail[15,10] no MTM, RE cost×1 | 283 | 1, 5, 6, 7 |
  | W NIFTY B | 117 | ATM SL80 trail[25,15] no MTM | 268 | none |
  | W NIFTY C | 124 | ATM SL150 no trail no MTM, RE cost×1 | 308 | 7 |
  | W NIFTY D | 83 | ATM SL150 trail[25,15] MTM 4,000 | 196 | 7 |
  | W SENSEX A | 90 | ₹200 SL40 trail[15,10] MTM 4,000, RE cost×1 | 214 | 1 |
  | W SENSEX B | −115 | ₹320 SL40 no trail MTM 4,000, RE cost×1 | 253 | 5 |
  | W SENSEX C | 76 | ₹320 SL40 trail[25,15] MTM 4,000, RE cost×1 | 242 | 7 |
  | W SENSEX D | −15 | ₹200 SL40 trail[15,10] no MTM, RE cost×1 | 85 | none |
  | D NIFTY A | 127 | OTM1 SL40 MTM 3,000 RE asap×1@13:00 trail[10,5] | 195 | 1, 5, 6, 7, 8 |
  | D NIFTY B | 254 | ITM1 SL25 MTM 4,000 RE asap×1@13:00 trail[10,5] | 343 | 1, 2, 7, 8 |
  | D NIFTY C | 238 | ATM SL25 MTM 2,000 RE cost×1 trail[10,5] | 297 | 1, 6, 7 |
  | D NIFTY D | 51 | ITM2 SL25 MTM 3,000 RE asap×1 | 167 | 7, 8 |
  | D SENSEX A | 251 | ITM1 SL25 no MTM RE cost×2 trail[10,5] | 434 | 2, 8 |
  | D SENSEX B | 287 | ITM2 SL20 no MTM RE cost×2 trail[10,5] | 518 | 8 |
  | D SENSEX C | 127 | ITM2 SL30 no MTM RE cost×2 trail[10,5] | 246 | 1, 8 |
  | D SENSEX D | 16 | ITM2 SL40 no MTM RE cost×2 | 88 | 1, 5, 7, 8 |
  | B NIFTY A–D | 28 / −46 / −90 / −66 | no set passes the gates | — | gates |
  | B SENSEX A | −33 | ₹150, range 30, SL30, trail[3,3], MTM 2,000 | 158 | none |
  | B SENSEX B | −41 | ₹225, range 30, SL40, target 100 %, trail[3,3], MTM 2,000 | 154 | none |
  | B SENSEX C | −71 | ₹225, range 10, SL40, trail[9,3], MTM 2,000 | 226 | none |
  | B SENSEX D | −49 | OTM1, range 30, SL40, target 100 %, MTM 1,000 | 44 | 5 |

  Clean so far (rules 1, 2, 5, 6, 7, 8 pass): W NIFTY B, W SENSEX D, B SENSEX A, B, C. Rule 8
  (re-entry parity open) blocks every SENSEX Dir winner, which all lean on RE COST ×2. PBO ≤ 0.5
  in 37 of 42 cohorts; above it: W NIFTY 09:17 and 09:47, D NIFTY 09:17 / 09:32 / 13:02 (16
  blocks). NIFTY Buy: no cell clears the gates in any band; the template stays. Wide-stop NIFTY
  Widesl winners have worse worst days than the template (−₹16.6k vs −₹4.5k at 09:17) though
  smaller drawdowns. Nominal SENSEX margin row and its test reverted (owner chose rupees per lot).
- 2026-10-15 — **renumbered BL-102 → BL-104**: the Options Lab redesign took BL-102 first (committed
  23:01 on 14 Oct, this item 23:28) and IDs are never reused. Folder `research/bl104/`, tests
  `test_bl104_*`. The grid's internal label stays `bl102-stage1-2026-10-14`, since it is part of
  the registered SHA `6a1078bb4fe68786`; PR #218 and its commits carry the old number.
- 2026-10-15 — **Tail gate and a second selection (owner instruction, recorded for the research
  gate).** After reading the Stage 1 band tables the owner asked (chat, 2026-10-15) that winners
  be considered with worst-day behaviour ("I have doubt for worst day performance would be bad",
  then "Parallely run and add the winners considering these categories too") and to "do both and
  compare in a long view". Applied as a gate on top of the registered rules, tightening only:
  a cell's worst day and its five-worst-days sum may not exceed 1.5 × its cohort template's
  (magnitudes floored at ₹3,000 and ₹15,000). It was added after the Stage 1 results were read, so
  it is a post-hoc rule and is recorded as such. Consequences, all with their cell lists committed
  before the run: a second band-winner selection (`*_band_winners_tail.csv`; 5 of 20 winners
  change), its own Stage 2 (`stage2_tail`), and a NIFTY 2022-01 → 2024-10 advisory run for **both**
  selections (the Phase 4 advisory run, extended). The "will not run: a second pass on the grid
  after reading results" line needs the owner's `override:`; the owner's instruction above is the
  basis, and the formal `override:` line is theirs to confirm here.
- 2026-10-15 — runner fixes after a crash (a cell whose exit precedes its entry slot): a failing
  cohort is reported and the run exits non-zero, schema-invalid cells are named, pre-2024-10
  lookups use the earliest reference row (historical lot sizing before 2024-10-03 is refused),
  and `robust.py` refuses to mix the tail and return-only selections' Stage 2 results.
- 2026-10-15 — **Stored for later cuts.** `research/bl104/shortlist.py --build` writes
  `research/bl104/shortlists/stage1_set_checks.csv.gz`: all 35,232 Stage 1 parameter sets at band
  level with their figures and, for each of nine checks (Calmar, profit factor, day-stop rate with
  a 30 % cap for Widesl / Dir and 60 % for Buy, entry rate, worst day and worst five days against
  the template, plateau, real stops, verified re-entry), whether they pass and whether they pass
  strongly. Any later cut is a filter on that table (`--max-fails`, `--strong`, `--allow-fail`,
  `--min-gain`, `--family`). The owner's 2026-10-15 cut (higher ₹ per lot-day than the template,
  at most two failed checks, every other check passed strongly) is
  `shortlists/2026-10-15_owner_cut_max2fails_strong.csv`. **Corrected after the PR 230 review:**
  the first version averaged Calmar, profit factor and day-stop rate over a band's slots and its
  "plateau" re-counted the set's own gate failures, so it reported 165 sets with mislabelled
  failures. Every check is now applied per slot (the set takes its worst slot), the plateau test is
  the neighbour test only, and the registered Buy hit-rate gate is included. Corrected cut: **143
  sets** (21 fail nothing, 108 fail Calmar and plateau, 5 fail Calmar, 5 fail the day-stop rate and
  plateau, 2 fail the day-stop rate and verified re-entry, 1 fails the day-stop rate, 1 fails the
  real-stop rule). 113 of the 143 are Buy SENSEX 14:17–15:02. The morning Buy SENSEX sets first
  reported as "plateau only" fail Calmar below 1 at one of their slots. "Strong" is a post-hoc
  standard set for owner shortlists (equal to a plain pass on four of the ten checks), not a
  registered rule. The 60 % day-stop cap for Buy loosens the registered 30 % after the results
  were read (owner, 2026-10-15: "MTM stop rate less than 30 might not work for buy"); it is a
  post-hoc loosening and needs the owner's `override:`. A scratch re-score of Stage 1 Buy with that
  cap (`results/pool_probe/`, not committed) raised Buy candidates from 316 to 537. The raw results (summaries and day × cell series, 444 MB) are copied to
  `/Volumes/TradingData/research-archive/bl104/` (not covered by the monthly `tdata backup`,
  which copies only lake / raw / catalog).
- 2026-10-15 — **Stage 3 and Stage 4 results.** The 25-slot breadth run (124 cohorts; 745 cells
  listed, 738 run, 7 skipped as schema-invalid at their slot). Under the registered rule (all eight
  rules) **one band passes: Buy SENSEX 09:17–10:02.** Five more pass every rule except rule 7 (a
  one-bucket regime flag) or rule 8 (re-entry parity); the three Dir SENSEX rows exist only in the
  tail-gated selection, so they are **pending the owner's `override:`**. Band labels are the
  rotation's bands; the figures are means over the Stage 1 sampled slots of each band (₹ per
  lot-day, in-sample 2024-10 → 2026-10):

  | Band | Winner settings | Winner ₹ | Template ₹ | Remaining issue |
  |---|---|---:|---:|---|
  | Buy SENSEX 09:17–10:02 | ₹150 premium, range 30, SL 30 %, trail 1/1, MTM ₹2,000 | 158 | −33 | none (all eight rules) |
  | Widesl NIFTY 12:17–14:02 | ATM, SL 150 %, no trail, no MTM stop, RE cost ×1 | 308 | 124 | regime flag; **rejected by the owner (no real stop)** |
  | Widesl SENSEX 12:17–14:02 | ₹320 premium, SL 40 %, trail 25/15, MTM ₹4,000, RE cost ×1 | 242 | 76 | regime flag |
  | Dir SENSEX 09:17–10:02 (tail) | ATM, SL 20 %, trail 10/5, MTM ₹3,000, RE cost ×2 | 355 | 251 | re-entry parity (BL-009) |
  | Dir SENSEX 10:17–12:02 (tail) | ITM2, SL 15 %, trail 10/5, MTM ₹3,000, RE cost ×2 | 495 | 287 | re-entry parity |
  | Dir SENSEX 12:17–14:02 (tail) | ITM1, SL 30 %, trail 10/5, MTM none, RE cost ×2 | 258 | 127 | re-entry parity; no day stop (fails the owner's real-stop rule) |

  Breadth (rule 4) failed for Buy SENSEX 10:17–12:02, 12:17–14:02 and 14:17–15:02, Widesl NIFTY
  10:17–12:02 and 14:17–15:02, Widesl SENSEX 14:17–15:02, and Dir NIFTY 12:17–14:02, 14:17–15:02 and
  Dir SENSEX 14:17–15:02 (several of these had already failed other rules). **Slippage** (Phase 3; winner minus template at its band slots): at 0.25 % per fill
  +176 / +143 / +160 / +39 / +203 / +127 for the six rows above; at 0.5 % +163 / +124 / +157 / +5 /
  +107 / +95, so Dir SENSEX 09:17–10:02's edge shrinks to ₹5 per lot-day at 0.5 %. **Historical lot sizing** was
  dropped by the owner (2026-10-15: "not significant; calculate with current lot"). **NIFTY
  2022-01 → 2024-10 advisory** (Phase 4 advisory only; 681 days; winner vs template): Widesl NIFTY keeps its sign
  in all four bands for the return-only selection (+46, +26, +34, +28); the tail-gated Widesl NIFTY
  09:17–10:02 holds (233 vs 157) but 10:17–11:32 flips (25 vs 50); Dir NIFTY flips in three of four
  bands (−100, −48, −8; +4 late), which agrees with its failing the bootstrap in-sample. SENSEX has no
  usable data before 2024-09. Not done: the bootstrap against the BL-099 picks.

  Owner direction after the read (2026-10-15): judge in rupees per lot; require real stops (a day MTM
  stop, Widesl leg stop ≤ 100 %); a 60 % day-stop cap for Buy (30 % for Widesl and Dir). The
  follow-up is a candidate pool for the picker (about 440 variants, up to four different sets per
  band) tested out-of-sample: pool re-selected on 2024-10 → 2025-10 only, Steady / Calendar / Adaptive
  replayed on 2025-10 → 2026-10 against the same lists over the 298 universe. To be registered as its
  own item before any run.
- 2026-10-28 — **Closed on the advisory result** (owner, asked in chat, 2026-10-28). Delivered: Phase 0's
  registered grid (SHA `6a1078bb4fe68786`), Stage 1 (63,426 cells), Stage 2 (plateaus), Stage 3 (25-slot
  breadth, slippage, CSCV) and the NIFTY 2022-01 → 2024-10 advisory run. Under the registered rules one band
  passes all eight (Buy SENSEX 09:17–10:02, in-sample). **No forward test:** Phase 4's
  `strategies/sweep_finalists/` nightly rerun and 60-day read-out are not started; the forward evidence comes
  from the T1 track (BL-113) and the BL-106 pool instead. **Not run** (no Log entry shows them): the
  correlation among finalists, the Buy ₹1-per-fill sensitivity and the bootstrap against the BL-099 picks.
  **Never registered:** the post-hoc tail gate (worst day and worst five days against 1.5 × the template,
  2026-10-15) and the Buy 60 % day-stop cap (loosening the registered 30 %). The owner did not write an
  `override:` for either, and none is written here on the owner's behalf; the tail-gated selection, its
  Stage 2 and advisory figures, the three Dir SENSEX tail rows and the 60 % cut (`shortlists/`, the
  `results/pool_probe/` re-score) are descriptive only. Status `Done`.
