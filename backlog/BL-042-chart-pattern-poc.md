# BL-042 — Chart-pattern POC for Momentum: tight range, flag, cup and handle

| | |
|---|---|
| **Priority** | P1 — the owner wants an early read on whether patterns add to the Momentum pick; research only, so nothing live is at risk |
| **Status** | In progress |
| **Type** | research |
| **Area** | momentum |
| **Created** | 2026-10-07 |
| **Depends on** | BL-015 (pre-registration). BL-035's prerequisite (BL-010 + BL-036) is overridden for this POC, see Log |
| **TODO.md row** | [§3.20](../TODO.md) |

## Context

The owner's idea (2026-10-07): among stocks the momentum ranking already likes, give extra rank to
one that is also forming a tight range, a flag or a cup and handle. A POC should answer four
questions:

1. Can the patterns be detected reliably?
2. Are the detections right, checked by eye?
3. Do they add anything beyond momentum?
4. How should the score be split between momentum and pattern (75/25, 50/50, …)?

This item runs the POC for those three patterns. BL-035 (tightness) and BL-031 (detectors) were
written on 2026-10-06 from the same idea; their first phases are done here for these three
patterns. BL-031 keeps head and shoulders and the rest of the catalogue. BL-033 wires a passed
pattern into the ranking.

**Data.** Broad Momentum has daily OHLCV in `bars_1d_stock` (mirror: `data/stocks/daily.parquet`):
~4,300 NSE symbols, 2011-01-03 → 2026-09-25, which covers the ~755-name Broad universe. Highs and
lows are **not** split-adjusted; only weekly closes are back-adjusted (`build_stock_weekly_prices`).
Index and ETF series have no highs, lows or volume, so this POC is stocks only.

**Owner decisions (2026-10-07):**
- Start now, as an override of BL-035's prerequisite. This is research only: the default
  ranking, saved favourites, goldens and the Friday signal stay untouched.
- The universe is Broad Momentum, on the point-in-time `turnover_rank` universe.
- Test all three integration shapes: blend, filter and bonus.
- Verify detections in a chart gallery where the owner marks each one right or wrong.
- Development data is 2011–2023. 2024-01-01 → 2026-09-25 is sealed for one final run; the
  2012–16 hold-out was used by BL-010 on 2026-10-07.

## Goal

For each of tight range, flag and cup and handle:
- a fixed detector the owner has checked by eye;
- a pre-registered answer to whether the pattern predicts returns beyond momentum;
- if it does, the integration shape and weight chosen by a rule, confirmed once on the sealed
  2024–26 data.

## Pattern catalogue

All rules read daily bars up to and including the Friday close. Figures in brackets are starting
values: Phase 3 tunes them on the owner's labels, never on returns. **Owner: mark each row right
or wrong, and correct the rules.**

| # | Pattern | How it is identified | Detectability | In this POC? |
|---|---|---|---|---|
| 1 | **Tight range / VCP** | Prior uptrend: close above the 30-week average and ≥ [25]% above the 52-week low. Over the last N weeks (3/5/8), (highest high − lowest low) / close ≤ [8/12/15]%. That range is ≤ [0.5]× the stock's own median N-week range over the past year, so it is a contraction, not just a quiet stock. Optional "3 weeks tight": three weekly closes within [1.5]%. Volume dry-up: 10-day average volume < [0.7]× the 50-day average | Easy; a numeric feature | **Yes** |
| 2 | **Bull flag / pennant** | Pole: a rise of [20]% or more within 3–25 trading days. Flag: 5–20 days, pulling back ≤ 1/3 of the pole and ≤ [15]% from the pole high, highs flat or falling, volume lower than in the pole. A pennant has converging highs and lows | Easy to medium | **Yes** |
| 3 | **High tight flag** | Pole: a rise of [90]% or more in ≤ 8 weeks. Then a 3–5 week flag pulling back ≤ [20–25]% | Easy, but rare | **Yes**, as a flag variant, reported separately |
| 4 | **Cup and handle** | Prior advance ≥ [30]% into the left lip. Cup: 7–65 weeks long, [12–35]% deep (≤ 50% in a weak market), U-shaped (≥ 3 weeks near the low, not a V), right lip within [5–10]% of the left. Handle: 1–4 weeks in the cup's upper half, ≤ [12–15]% deep, drifting down on lighter volume. Pivot = handle high | Medium to hard; fuzzy | **Yes** |
| 5 | Flat base | ≥ 5 weeks, ≤ 15% deep, after a ≥ 20% advance. Pivot = base high | Easy (close to #1) | Later |
| 6 | Ascending triangle | A flat ceiling touched ≥ 2 times (within 2%), plus ≥ 2 rising swing lows | Medium | Later |
| 7 | Double bottom (W) | Two swing lows within ~3% (the second may undercut), with a middle peak ≥ 10% above them. Pivot = middle peak | Medium | Later |
| 8 | Inverse head and shoulders (H&S top as an exit filter) | Three swing lows, the middle one deepest, shoulders within ~10% of each other, neckline through the two peaks. A top is the mirror image | Medium to hard | Later (BL-031) |
| 9 | 52-week-high breakout on volume | Closes at a 52-week high on ≥ 1.5× its 50-day average volume | Trivial | Later; close to the existing `high52_proximity` lever |
| 10 | Darvas box | A new high, then ≥ 3 days with no higher high (box top) and a box low; triggers on a close above the top | Easy | Later |

**States.** Each pattern is recorded in one of three states, so the test can tell which carries
information:
- *forming*;
- *near pivot*: within 5% below the pivot;
- *broke out*: a close above the pivot on ≥ 1.5× volume, within the last k weeks.

**Splits and bonuses.** Every measure is a ratio inside its own window. A window that contains a
corporate action (`data/stocks/events.parquet`, or the share factors behind
`build_stock_weekly_prices`) is dropped or rescaled. A ~20% one-day gap that starts a `SYMBOL#2`
series ends the window.

**On the 75/25 vs 50/50 question.** The split is not chosen by which one won. On the development
data, walk-forward picks one shape and weight per pattern by the Phase 0 rule; that one choice runs
once on the sealed data. A guess before seeing any data:
- Tightness is continuous, so it can blend (25–50%).
- Flags and cups are sparse yes/no events, so they probably work better as a filter or bonus on
  the top-N momentum names than as a 50% weight.

## Out of scope

- Any change to `BacktestRequest`, `api.py`, the dashboard, the default ranking or the weekly
  signal. That wiring is BL-033's job, and only for a pattern that passes.
- Patterns 5–10 (BL-031 keeps them), indices and ETFs (no highs, lows or volume), and intraday bars.
- Image-based or learned detectors.

## Plan

### Phase 0 — Pre-register (committed before any run)
- **Tasks:**
  - Owner reviews the catalogue above and the proposed numbers below.
  - Commit `packages/momentum-backtesting/search_spaces/bl042_criteria.json` (the shape of
    `bl010_criteria.json`: `written_before_running`, `rule`, `supersedes`).
  - Add the first `## Experiments` block (from `_EXPERIMENT.md`) to this file.
- **Proposed rules** (the owner confirms or changes them before commit):
  - **Hypothesis:** within the Broad pool, a pattern state predicts 4/13/26-week return above
    that of momentum-matched peers.
  - **Universe:** Broad on point-in-time `turnover_rank` membership (as known each January),
    with circuit-lock fills and the tradability filter on.
  - **Baselines:**
    - Primary: the plain default Broad ranking, untuned.
    - Secondary: the four configs in `bl010_phase6_frozen.json`, reported only. They were tuned
      on 2017–26, so they are not the gate.
  - **Trials, fixed up front:** blend w ∈ {0.25, 0.5, 0.75}; filter top-N ∈ {20, 40}, pattern
    names first; bonus B ∈ {5, 10} ranks. 7 shapes × 3 patterns = 21 trials.
  - **Pass / kill:**
    - **Event study:** 13-week excess over momentum-decile-matched controls with t ≥ 2,
      clustered by week, Holm-corrected across 3 patterns × 3 horizons.
    - **Development portfolio:** the walk-forward pick beats the baseline, and PBO ≤ 0.3 over
      the 21 trials.
    - **Hold-out:** CAGR after costs ≥ +2 points over the baseline, and max drawdown no more than
      3 points worse. One run.
  - **Hold-out:** 2024-01-01 → 2026-09-25.
  - **Will not run:** anything on the hold-out before Phase 6; any threshold tuned on forward
    returns.
- **Done when:** the criteria and the Experiments block are committed. This also closes TODO
  3.17.1.

### Phase 1 — Data and causal pivots
- **Tasks:** a new module `packages/momentum-backtesting/src/momentum_backtesting/patterns/`:
  - `bars.py` — daily OHLCV for the Broad symbols plus the corporate-action window flag. One
    DuckDB query in the style of `categories/liquidity.py::compute_weekly_features`
    (Friday-keyed), cached on `db_read.data_version()`.
  - `pivots.py` — a causal zigzag on percentage reversal. A swing point exists only from the bar
    that confirmed it.
- **Deliverables:** the module and a truncation test like `tests/golden/test_lookahead.py`:
  features for week t are identical with or without the bars after Friday t, at three cut dates.
- **Done when:** the truncation test passes.

### Phase 2 — Detectors
- **Tasks:**
  - Write `patterns/tight_range.py`, `patterns/flag.py` (flag, pennant, high tight flag) and
    `patterns/cup_handle.py`. Each returns a detections table (symbol, Friday, pattern, state,
    geometry, pivot) and a weekly score frame (week × symbol, 0–1, NaN without enough history).
  - Add the CLI command `mbt patterns detect --from --to`.
- **Deliverables:** unit tests on synthetic paths: a clean cup is found, a V-bottom is rejected, a
  flag that pulls back too deep is rejected, and so on. Detections for the development period
  (2011–2023) only.
- **Done when:** the detectors run over the whole development period and the tests pass.

### Phase 2b — Momentum rank while the pattern forms (owner, 2026-10-07; reported only)
- **Why:** a base takes 3 to 30+ weeks, and a stock moving sideways loses momentum rank, so the
  best patterns may sit outside the top momentum names that the filter and bonus shapes look at.
- **Tasks:** for every detection, record the stock's global and pool momentum rank at base start,
  midpoint and detection; report the share of detections inside pool top 10 / 20 / 40 / 200, per
  pattern and state. No returns are read.
- **Done when:** the table is in this file before Phase 4.
- **Result (2026-10-07, development window, ranks only):** an episode is one base, at its
  first detected week. The rank percentile is among every ranked name (0 = best).

  | Pattern | Episodes | Median base (wk) | Rank pct at start | at midpoint | at detection | Rank fell start→detection | In pool | Pool top 10 | top 20 | top 40 |
  |---|---|---|---|---|---|---|---|---|---|---|
  | Tight range | 12,947 | 4.6 | 0.29 | 0.35 | 0.37 | 62% | 32% | 0.4% | 1.1% | 3.7% |
  | Bull flag | 6,583 | 6.0 (from pole start) | 0.54 | 0.19 | 0.24 | 20% | 27% | 0.7% | 2.2% | 5.9% |
  | Cup and handle | 5,110 | 17.6 | 0.30 | 0.61 | 0.34 | 53% | 26% | 0.2% | 0.9% | 3.2% |
  | High tight flag (reported) | 2,640 | 11.6 | 0.50 | 0.11 | 0.28 | 27% | 11% | 0.7% | 2.0% | 3.4% |

  The owner's guess holds. While a base forms the stock drifts down the ranking (a cup is in
  the bottom half at its midpoint), and at detection only 1–2% of bases are in the pool's top
  20, the names Broad actually buys. Most pattern stocks sit in the upper third of the market
  but outside the pool's top 40. So `filter_20`/`filter_40` and the 5/10-rank bonus will
  rarely change a pick, and only a blend weight high enough to lift a name from rank ~50–150
  into the top 10 can act. That is a property of the shapes, recorded before any return is read.

### Phase 3 — Gallery check (owner; no returns shown)
- **Tasks:**
  - `mbt patterns gallery` samples ~40 detections per pattern, stratified by year, plus ~15 near
    misses, and publishes them as a private Artifact page. The page has:
    - candlestick charts **cut at the detection date**, so the outcome is hidden;
    - the base, pole or cup and the pivot outlined;
    - Correct / Wrong / Unsure buttons, with labels stored in the page's database.
  - Tune the geometry thresholds on those labels only.
- **Deliverables:** precision per pattern; the frozen detector parameters in an addendum with
  `detectors_frozen: true` (addendum 2, since addendum 1 holds the quality score and the shape
  swap), committed before Phase 4.
- **Done when:** precision is ≥ 75% per pattern. A pattern that cannot reach ~60% is dropped from
  the POC.

### Phase 4 — Event study (development data)
- **Tasks:** for each detection state, measure the forward 4/13/26-week return:
  - against the equal-weight pool;
  - against names in the same momentum-rank decile that week without the pattern.
  Also count detections per year, so one bull run cannot carry the result.
- **Done when:** pass or kill per pattern is recorded against Phase 0.

### Phase 5 — Ranking test (development data, walk-forward)
- **Tasks:**
  - `patterns/ranking.py` builds the blend, filter and bonus shapes, reusing `levers.rerank` and
    `levers.blend_ranks`.
  - The shapes feed `categories/broad.py::run_broad_backtest` through the existing
    `external_ranks` / `stock_tilt_ranks` hook, so the engine's selection logic is unchanged.
  - `scripts/pattern_poc.py` runs the 21 trials and the baseline: walk-forward with a 13-week
    gap, PBO with BL-010's CSCV code, data-stamped run ids.
- **Deliverables:** `bl042_dev_result.json`.
- **Done when:** one variant per surviving pattern has been chosen by the Phase 0 rule, or none
  survives.

### Phase 6 — Hold-out (one run)
- **Tasks:** run each chosen variant once on 2024-01-01 → 2026-09-25.
- **Deliverables:** `bl042_holdout_result.json`; the Result line of the Experiments block.
- **Done when:** recorded, and not tuned around.

### Phase 7 — Decision
- **Pass:** hand over to BL-033 (optional ranking input, off by default, goldens), and mark
  patterns on the Momentum stock charts (BL-031 Phase 3).
- **Fail:** close as "informative, not adopted". BL-031 keeps the remaining patterns.
- **Done when:** the owner's decision is logged.

## Risks

- **Detectors fitted to hindsight** — a detector tuned until it "finds the ones I see". Defences:
  charts are cut at the detection date, and thresholds are tuned on labels only, never on returns.
- **Tightness overlaps the known low-volatility effect.** The momentum-matched control shows
  whether it adds anything; a volatility-matched control can be added in Phase 0 if wanted.
- **Thin samples.** Cup and handle and high tight flags may have only tens to a few hundred
  cases, with clusters in bull runs.
- **Short hold-out.** 2024–26 is under three years, so a pass there is suggestive, not proof.
  Forward tracking (BL-024) follows before any real money (BL-025).
- **A baseline already tuned on the hold-out.** The four BL-010 frozen configs were chosen on
  2017–26, so they are reported but are not the gate.

## Open questions

1. Is the catalogue right? Owner to mark each row and correct any rule.
2. Are the proposed Phase 0 numbers right (t ≥ 2, PBO ≤ 0.3, +2 points CAGR, ≤ 3 points worse
   drawdown)?
3. Add a volatility-matched control next to the momentum-matched one?

## Experiments

### 2026-10-07 — Pattern POC: tight range, flag, cup and handle on Broad Momentum
- **Hypothesis:** within the Broad pool, a stock showing a detected tight range, flag or cup and
  handle earns more over the next 13 weeks than non-pattern stocks of the same momentum-rank
  decile, and re-ranking the pool with the pattern beats the plain Broad ranking after costs.
- **Universe:** Broad Momentum, `turnover_rank` membership as known each January, tradability
  gate (₹2 cr, ₹30, floor 0.25, circuit run 3), circuit locks on (point-in-time source:
  `turnover_rank_members_by_year`, `bars_1d_stock`).
- **Look-ahead check:** the pattern features for a week are identical with and without the bars
  after that Friday (truncation test at three cut dates); pivots exist only from the week that
  confirmed them; highs and lows are back-adjusted by NSE prevclose chaining, and every measure is
  a ratio inside its window.
- **Pass / kill rule:** `packages/momentum-backtesting/search_spaces/bl042_criteria.json`.
  - Gallery precision ≥ 0.75 (drop below 0.6).
  - Event study: the 13-week test survives Holm across 9 tests, mean positive, ≥ 100 events in
    ≥ 52 weeks.
  - Ranking: the joined walk-forward excess CAGR over the baseline is > 0, and PBO ≤ 0.3 over the
    21 trials.
  - Hold-out: ≥ +2 points CAGR over the baseline, drawdown no more than 3 points worse.
  - Comparator: the plain Broad ranking (category mode off, top 10 / exit 20, weekly,
    signal delay 1, itemised costs).
- **Hold-out:** data cut-off for development 2023-12-29; unseen period 2024-01-01 → 2026-09-25,
  one run.
- **Will not run:** anything reading 2024 or later before Phase 6; thresholds chosen on returns;
  a second hold-out run; shapes outside the 21 trials.
- **Result (2026-10-07): kill, all three patterns. Phase 6 not run; the 2024–26 hold-out stays
  sealed and unclaimed.**
  - **Phase 4, event study (2012–2023).** Excess return over non-pattern pool stocks in the same
    momentum decile; Newey-West t, Holm across 9 tests. Nothing survives.

    | Pattern | 4 wk | 13 wk (judged) | 26 wk | Events (13 wk) |
    |---|---|---|---|---|
    | Tight range | +0.13% (t 0.44) | +0.18% (t 0.29) | +0.27% (t 0.26) | 6,513 |
    | Flag | +0.44% (t 1.37) | +0.28% (t 0.38) | −0.52% (t −0.42) | 2,899 |
    | Cup and handle | −0.35% (t −1.10) | −0.84% (t −1.35) | −2.34% (t −1.68) | 1,973 |

    By quality third (reported only), better-formed bases do no better. Best case: flag middle
    third, +1.85% at 13 wk, t 1.52.
  - **Phase 5, ranking test.** Baseline: plain Broad, off mode, top 10, weekly, delay 1,
    itemised costs. 11.9% CAGR, max drawdown −73.2%, 2012-04 → 2023-12.
    - Full-window CAGR deltas over the baseline:
      - tight range −3.9 to +4.1 pts (best `filter_40`);
      - flag −1.5 to +3.2;
      - cup −0.7 to +1.3;
      - the learned score −3.8 / −0.7 / +0.6.
    - Joined walk-forward 2017–2023: tight range +4.7 pts/yr, flag −5.9, cup +1.2.
    - **PBO 0.57** over the 24 trials (kill above 0.3). The in-sample winner's out-of-sample rank
      is a coin flip or worse (slope −1.3; out-of-sample negative in 43% of splits).
  - **Verdicts:** event study kill × 3; ranking test kill × 3 (PBO). Files:
    `search_spaces/bl042_event_study_result.json`, `search_spaces/bl042_dev_result.json`;
    curves in `data/patterns/dev_curves.parquet`.

## Log

- 2026-10-07 — created from the owner's request for a pattern POC. Owner answers recorded above:
  - override BL-035's prerequisite, research only;
  - one new item;
  - Broad universe;
  - all three integration shapes;
  - gallery check;
  - 2024-01 → 2026-09 sealed.

  `override: owner wants an early POC; research only — default ranking, favourites, goldens and
  the weekly signal untouched; BL-010/BL-036 prerequisite of BL-035 waived for this item only.`
- 2026-10-07 — owner approved the catalogue and the proposed numbers ("Yes I am good"). Phase 0:
  `bl042_criteria.json` and the Experiments block committed before any detection or run. Owner
  added a check (Phase 2b): does the momentum rank fall while a 10–30 week base forms? Reported
  only, no returns read.
- 2026-10-07 — Phases 1–2 done: `mbt patterns detect` over 1,578 point-in-time Broad symbols,
  2011-01 → 2023-12-29 (55 s; 1,378 bad bars excluded). Phase 2b recorded above. Phase 3 gallery
  published (165 charts, 40 detected + 15 near misses per pattern, seed 41):
  https://claude.ai/artifact/AmbsNx8jkNsBij43qVVBnF. The manifest is
  `search_spaces/bl042_gallery_manifest.json`. Waiting on the owner's labels. Phases 4–5 are
  coded and refuse to run until `bl042_criteria_addendum_1.json` (the detector freeze) exists.
- 2026-10-07 — Phase 6 runner built (`mbt patterns holdout`). Only patterns that pass Phases 3,
  4 and 5 enter, each with the shape Phase 5 chose. It claims the run before reading, writes
  `search_spaces/bl042_holdout_result.json` once and refuses a second run. **Not built yet:** the
  reported-only line for the four BL-010 frozen configs with the shape applied to
  `combined_pool_ranks` (criteria `phase_6_holdout.reported`). Add it before Phase 6 runs.
  The owner kept the trial count at 21; no wider filter/bonus shape was added.
- 2026-10-07 — owner decisions, all before any return was computed; recorded in
  `search_spaces/bl042_criteria_addendum_1.json` (`returns_seen: false`):
  - **Labelling:** the owner keeps labelling the gallery. They had offered to hand it to Claude,
    and were reminded it is a shape check, not a trading call.
  - **Quality score:** each base gets a 0–1 grade from textbook shape rules, using its own
    geometry only:
    - tight range: contraction, tightness, volume dry-up;
    - flag: shallow, quiet, strong pole;
    - cup and handle: depth sweet spot, shallow handle, level lips, prior advance.
    The blend shapes use state score × quality. The event study adds a reported-only 13-week
    line per quality third.
  - **Shapes (option A):** `filter_20` → `filter_100` and `bonus_5` → `bonus_25`. Phase 2b
    showed the originals cannot move a pattern stock (pool rank ~50–150) into the top 10.
    Still 21 trials.
  - **Ranking on what came next:** the owner asked whether patterns could be ranked by their
    next-month result. That is answered by the walk-forward (Phase 5) and the hold-out
    (Phase 6), never by keeping whatever did best over the whole period.
  - The detector freeze moves to addendum 2.
- 2026-10-07 — renumbered BL-041 → BL-042 (TODO §3.19 → §3.20). A separate session merged
  "In-app Guide" to `main` as BL-041 while this item was still on its branch, and IDs are never
  reused. Files renamed `bl041_*` → `bl042_*`. Only the ID changed: no rule or value moved, and
  no return had been computed.
- 2026-10-07 — Phase 3 closed, recorded in `bl042_criteria_addendum_2.json` (`detectors_frozen:
  true`, `returns_seen: false`).
  - **Owner's labels:** 159 of 165.
    | Pattern | Correct / judged | Unsure |
    |---|---|---|
    | Tight range | 34/34 | 5 |
    | Flag | 26/30 | 8 |
    | Cup and handle | 19/23 | 16 |
  - **Owner's caveat:** don't take their judgement as final, and a setup that pays matters more
    than one that looks textbook.
  - **Claude's second review of 56 charts:** agrees on tight ranges and most flags; judges most
    cups doubtful (downtrend bounces, no real left-lip top, every one with a 1-week handle).
  - **Fixes where both reviews agree:**
    - cup handle at least 2 weeks;
    - the cup's left lip must be the highest high of the 26 weeks up to it;
    - every pattern must sit within 25% of its 52-week high;
    - flags must be in an uptrend, so crash rebounds no longer count;
    - bad-print wicks count as bad bars.
  - **No pattern dropped.** The gallery found bugs; whether a pattern pays is for Phases 4–6.
  - **Owner asked to rank setups two ways: textbook look and past payoff.** The textbook look
    is addendum 1's quality score. The past payoff is a causal **learned score**: the
    13-week decile-matched excess of earlier detections in the same pattern × state × quality
    cell, counted only once known, and neutral until 30 cases. It is added as one more blend
    shape, `learned_0.5` → 24 trials.
- 2026-10-07 — re-detected with the frozen detectors (ranks only; no returns): episodes are
  tight range 11,137, flag 4,691, cup and handle 1,417 (from 5,110), high tight flag 2,433.
  6,883 bad bars (the wick rule added ~5,500). Phase 2b on the frozen detectors: at detection
  0.4–0.9% of bases are in the pool's top 10 and 1.3–2.9% in its top 20. A visual check of 12
  new cups and 6 flags: cups are now mostly real cups after an uptrend.
- 2026-10-07 — Phases 4–5 run on the frozen detectors; all three patterns killed (Result above).
  Phase 6 is not run: no pattern entered. `mbt patterns holdout` was deliberately left unrun, so
  the 2024–26 hold-out stays unclaimed for later research. Caveats:
  - The weekly table (`api.DATA`) starts in 2016, so before 2016 every run lacks the cash and
    gold/silver/international columns. This affects the baseline and the variants alike.
  - The baseline is volatile (−73% max drawdown). The test asks whether patterns improve it,
    not whether it is a good strategy.
  - The secondary comparison against the four BL-010 frozen configs was never built; with
    nothing entering Phase 6 it is moot.
  Phase 7 (the owner's decision) is open.
