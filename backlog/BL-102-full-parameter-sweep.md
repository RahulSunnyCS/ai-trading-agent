# BL-102 — Full-factorial parameter sweep: Widesl (incl. ATM), Dir and Buy

| | |
|---|---|
| **Priority** | P1 — the owner's "proper sweep over every parameter" before any of these families gets real money |
| **Status** | In progress — Phase 0 registered; Stage 1 running |
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
Every number reproducible from `packages/option-backtesting/research/bl102/`.

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
- **Grid** (`research/bl102/grid.py`, version `bl102-stage1-2026-10-14`, **SHA `6a1078bb4fe68786`**,
  held by `tests/unit/test_bl102_grid.py`):

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
  cohort's sessions; net after charges > 0; **Calmar ≥ 1.0** (annualised net per lot ÷ |max
  drawdown| per lot, annualised as net ÷ days × 252: the worst fall is earned back within a
  year); profit factor ≥ 1.05; MTM-stop days ≤ 30 %; Buy only: entry hit rate ≥ 40 %.
  **Ranking: Martin ratio** (annualised net ÷ Ulcer index), tie-break ₹/lot-day. **Plateau
  rule:** a cell's robust score is min(own Martin, median Martin of its ±1-step neighbours along
  each axis chain in `grid.CHAINS`); a cell with a gate-failing neighbour is not a candidate. The
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
