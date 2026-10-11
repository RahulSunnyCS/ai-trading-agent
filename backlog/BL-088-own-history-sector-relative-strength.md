# BL-088 — Sector scoring on its own relative strength (time-series RS, not the cross-section)

| | |
|---|---|
| **Priority** | P2 — owner's call (2026-10-10); a new signal family for the ETF rotation, research only, nothing live at risk |
| **Status** | Idea (plan below is a proposal; `Planned` once the owner confirms the post's exact rule, open question 1) |
| **Type** | research |
| **Area** | momentum |
| **Created** | 2026-10-10 |
| **Depends on** | BL-015 (pre-registration); BL-010 Phase 6 (the frozen ensemble is the Broad comparator); BL-024 (the journal carries any shadow arm); BL-001 (goldens prove the default output is unchanged) |
| **TODO.md row** | — (filled in when started) |

## Context

The owner (2026-10-10) shared an X post by Sahil Kapoor (DSP's macro strategist),
<https://x.com/SahilKapoor/status/2108423594837725368>, and summarised it as: **score a sector on
its own relative strength**, and asked whether it can be added to the Momentum sector rotation,
with changes to the time windows, and run to see whether it has an edge.

The post itself could not be fetched from the research session (x.com and its mirrors are
unreachable from the container), so the rule below is **reconstructed from the owner's summary**
and must be confirmed against the post's text before Phase 0 is committed (open question 1). The
author's adjacent posts that week (the DSP Netra October edition) describe defensive sectors
(private banks, IT, staples) at their weakest *relative* performance against cyclicals in two
decades, so the post may well read the signal the contrarian way (a sector at its own relative
low), not the continuation way. The plan tests both directions as separate pre-registered trials.

**What "its own relative strength" means here, and why it is new.** Every score the engine has
today is **cross-sectional**: a sector is placed against the other sectors *that week*
(`engine._compute_ranks_ranksum` ranks each lookback's return across names; `voladj` z-scores
across names; Broad's `score_categories` averages members' pool ranks). The BL-050 discussion
withdrew "relative strength vs a benchmark" because dividing every return by the same Nifty
return leaves that cross-sectional order unchanged. **Scoring a sector against its own history is
a different object:** the sector's relative-strength line (sector ÷ Nifty 50) placed within *that
sector's* trailing distribution. A sector can be top of the cross-section and still be at an
ordinary point of its own history, or bottom of the cross-section and at a two-decade relative
low. This changes the order, so it is not the withdrawn candidate.

**Prior evidence in the repo on own-history (time-series) signals**, which shapes the priors:

| Signal | Where | Result |
|---|---|---|
| Absolute momentum vs cash (`defensive="filter"`, 13-week return must beat cash) | ETF and Custom Index | Rejected twice (TODO 3.9.18, 3.9.23) |
| 52-week-high proximity, as gate and as blended rank (`levers.high52_*`) | ETF: +0.3 median, worse drawdowns; Broad: -1.3 | Marginal, not adopted (3.9.23 Step 1) |
| Grouped tilt: prefer the beaten-down on the long lookbacks (`levers.grouped_momentum_ranks`) | ETF tilt 0.3–0.5 wins most (68% / 96% of windows, +1.9 median), beats the live strategy outright; Broad loses at every setting | The strongest ETF finding of 3.9.23; owner decision still pending |
| Skip the most volatile 20% of names (`exclude_high_vol`) | ETF +2.1 median, 89 / 93 / 100%; Broad -16.1 | ETF-only win |
| R1 gate: 26-week return must beat Nifty 500 TRI (BL-050) | Broad | Screen passed (t 2.1), engine test failed (-0.1, 8% win share) |

So the ETF/sector track is where own-history and contrarian signals have shown life, and the
Broad stock funnel is where momentum leaders dominate. This item therefore starts on the **ETF
rotation** and only reaches Broad's category layer if the ETF test passes.

**What this item can reuse:**
- `data/weekly_closes.csv` / `momentum_prices`: weekly closes of the 21 core instruments from
  2016 (Defence from 2018-04, Capital Markets from 2019-04); `universe.csv`'s `backfill` column
  already pulls NSE index history for some rows (`NIFTYINDICES:…`).
- `engine.compute_ranks` and `levers.rerank` / `levers.blend_ranks` (rank tables), the
  `no_buy` mask path (`BacktestRequest.exclude_high_vol` is the precedent for an ETF-only mask),
  `run_broad_backtest(feature_tilt=…)` (BL-050) for a Broad tilt later.
- `sweep.rolling_windows` + `rerun_windows` + `compare_rolling` + `deflated_sharpe`, the
  3.9.23 yardstick for the ETF track; `tranches.py` to remove start-date luck.
- `scripts/bl085_levers.py` / `scripts/bl050_filters.py` as runner templates; the frozen
  ensemble and the 11 BL-084 strategies as Broad comparators, after tax at Rs 5 lakh.
- The forward journal (BL-024) for a shadow arm.

**What is missing:**
- Long sector-index history. An own-history percentile over 3–5 years needs 3–5 years of
  warm-up, so 2016 data gives a first signal in 2019–2021 and a short test. niftyindices.com
  carries most sector indices back to 2005–2011 (the TRIs in `reference_benchmarks.py` come from
  there already); Phase 1 extends the backfill to every core sector row.
- A category-level price series hook in Broad: `score_categories` works on member pool ranks, not
  on a category series. `categories/compose.py` builds equal-weight category price tables for
  Custom Index; a Broad category tilt would read those.

## Goal

A pre-registered, kill-early answer to: **does placing each sector's relative-strength line
within its own history (rather than, or in addition to, the cross-section) improve the ETF
rotation after costs, robustly across rolling windows, in either direction (continuation or
reversal)?** If it passes on the ETF track, the same question once for Broad's category layer.
Any survivor then runs as a shadow arm in the forward journal before adoption is put to BL-025.

## Out of scope

- Fundamentals or valuation multiples (the post's own lens may be valuation; this repo has no
  point-in-time fundamentals and will not fabricate a proxy, per BL-050).
- Changing `live_config.toml`, the frozen ensemble, saved favourites or goldens. Adoption is an
  owner decision under BL-025, never automatic.
- A new search over lookbacks or windows. One setting per knob is pre-registered; a second is a
  dated addendum and counts as a trial.
- The Custom Index tab (its category list is in-sample selected; see `categories/broad.py`'s
  docstring).

## Plan

### Phase 0 — Pre-register (`search_spaces/bl088_criteria.json`, committed before any run)

Proposed; fixed only after open questions 1–4 are answered.

- **Hypothesis:** a sector's relative-strength line placed within its own trailing history
  carries information the cross-sectional rank does not, in at least one direction, enough to
  raise the ETF rotation's after-cost CAGR robustly without a deeper worst fall.
- **The signal.** `RS_t = ln(Sector_t / Nifty50_t)` on weekly closes (the price index for both,
  so dividends cancel). Two scores, each read against the sector's **own** trailing window
  `W = 156` weeks (3 years):
  - **S1 RS level:** the percentile of `RS_t` within `RS_{t-W+1..t}` (100 = at its own 3-year
    relative high).
  - **S2 RS momentum:** `ΔRS = RS_t − RS_{t-26}`, z-scored against the sector's own trailing
    distribution of 26-week `ΔRS` over `W` weeks (how unusual this sector's current relative
    move is *by its own standards*; the cross-sectional cousin of this is what `voladj` already
    does across names).
- **Directions:** `continuation` (higher is better) and `reversal` (lower is better), each a
  separate trial. No sign is chosen after seeing results.
- **Shapes:** `replace` (rank the 21 instruments on the score alone, hysteresis unchanged) and
  `tilt` (`final = rerank(0.5 × live ranksum rank + 0.5 × score rank)`, via
  `levers.blend_ranks`). Gold, Silver, Nasdaq 100 and Hang Seng are scored the same way against
  Nifty 50 (the post is about sectors; whether the non-equity instruments should be exempt is
  open question 4).
- **Trial budget:** 2 scores × 2 directions × 2 shapes = **8 trials** plus the baseline, all
  counted in PBO. No gate variant (a gate here is `replace` with a cut-off; it would be a ninth
  trial, listed under "Will not run").
- **Universe:** the 21 core rows of `universe.csv`, each from its own first available week, as
  the live ETF strategy uses them; `track = "etf"`.
- **Comparator:** the live ETF config (`live_config.toml`: top 5 / exit 10, lookbacks
  1/4/13/26/52, buffer, wait, 35% cap, 0.10% cost) — 25.8% / 0.99 / -30.5% on 2017-01 → 2026-09
  (3.9.23). `tilt` and `replace` both re-run from the same start as the comparator.
- **Look-ahead check:** both scores use closes up to the decision Friday only; a
  prefix-invariance test (score on data cut at week t equals score on full data) per score;
  `signal_delay` as in the comparator; the backfilled NSE history is checked against the Fyers
  series on their overlap before use.
- **Windows:** development 2012-01 → 2023-12 if Phase 1's backfill reaches 2009 (3 years of
  warm-up), else 2019-01 → 2023-12 on the 2016 data; **hold-out 2024-01 → 2026-09**, sealed,
  read once for Phase 2 survivors only.
- **Pass / kill rule (development):** rolling 3-year windows stepped quarterly
  (`sweep.rolling_windows`), each variant re-run fresh per window (`rerun_windows`):
  median ΔCAGR ≥ +1.5 pts, CAGR win share ≥ 70% **and** Sharpe win share ≥ 70%, full-period
  worst fall no more than 3 pts deeper, deflated Sharpe ≥ 0.95, and PBO < 0.5 over the 8 trials
  plus the baseline (CSCV). Hold-out confirmation: ΔCAGR ≥ 0 and worst fall no more than 3 pts
  deeper. A trial fails the whole rule on one miss.
- **Will not run** (each needs `override: <reason>` in the Log): a second `W` (1 or 5 years),
  a second `ΔRS` horizon (13 or 52 weeks), a gate variant, a benchmark other than Nifty 50
  (Nifty 500 TRI changes little and the price series are longer), a cross-sectional re-ranking
  of the own-history score (that is today's engine), any Broad run before the ETF verdict,
  fundamentals.

### Phase 1 — Data and features (no change to any default output)

- **Tasks:**
  - Extend `universe.csv`'s `backfill` to every core sector/broad index that niftyindices.com
    carries before 2016; verify the overlap with the Fyers series; record each row's first week.
  - Implement `S1`/`S2` as pure functions next to `levers.py` (weekly frame in, score frame
    out), with prefix-invariance tests.
  - Thread a `rank_override` / `rank_tilt` hook for the ETF dataset (a rank table in, like
    `external_ranks`), off by default; a test that the live config reproduces its golden digest
    with the hook off.
- **Deliverables:** backfilled series, feature module, hook, tests.
- **Done when:** tests pass, `update-goldens.py` reports no change, and the first signal week
  per instrument is recorded in this file.

### Phase 2 — ETF engine test

- **Tasks:** run the 8 trials and the baseline over the development windows with
  `scripts/bl088_rs.py` (resumable, every cell logged); CSCV/PBO over the 9 curves; the one
  hold-out read for survivors only; a chip-level diagnostic per trial (which sectors it holds
  more or less than the baseline, as 3.9.23 did for the high-vol exclusion) so a win that leans
  on one sector is visible.
- **Deliverables:** `search_spaces/bl088_result.json`, a results table and verdict per trial in
  this file.
- **Done when:** every trial has a pass/kill on development, survivors have the hold-out read,
  and the hold-out run count is 1 (or 0).

### Phase 3 — Broad category layer (only if Phase 2 has a survivor)

- **Tasks:** a dated addendum (`bl088_criteria_addendum_1.json`) before any run; the surviving
  score computed on each category's equal-weight series (from `compose.py`'s category price
  tables, point in time); applied as a tilt on `score_categories`'s order before
  `apply_hysteresis`; judged after tax at Rs 5 lakh on the 11 BL-084 strategies and the frozen
  ensemble, FY2018-22 to choose and FY2023-26 to confirm (BL-085's rule).
- **Done when:** a pass/kill verdict per strategy set, or "not run: no ETF survivor" logged.

### Phase 4 — Forward shadow arm (the deciding test for any survivor)

- **Tasks:** save the survivor as a Watching favourite of the ETF dataset; record it weekly in
  the forward journal next to the live ETF strategy from the next Friday; after ≥ 26 weeks,
  compare (return ≥ live; worst fall no more than 3 pts deeper; no live-rule breach the live
  strategy did not also hit).
- **Done when:** 26 recorded weeks and a dated verdict. Adoption goes to BL-025.

## Risks

- **The post's rule is reconstructed, not read.** If the post's definition differs (a different
  benchmark, a daily rather than weekly line, a specific window), Phase 0 must follow the post,
  not this draft; the trial budget stays at 8.
- **Short history.** Without the backfill, a 3-year own-history window leaves ~5 development
  years and ~9 rolling windows: a pass there is weak. Phase 1's backfill is the fix; if
  niftyindices.com refuses (it is behind the same Akamai rules `nse.py` fights), the test still
  runs on the short window and says so.
- **Two directions double the chance of a false pass.** Both are counted in PBO and the
  deflated Sharpe, and a trial that passes only on the reversal side is read next to the grouped
  tilt (3.9.23), which may be the same effect under another name; if so, record that, do not
  adopt both.
- **Own-history percentiles are slow-moving.** A `replace` ranking may trade far less than the
  comparator and look smoother by holding fewer names or more cash; report average holdings,
  time in cash and `metrics.turnover` next to every result.
- **Backfilled index history is price-only and pre-dates the ETFs.** Fine for ranking (the
  live strategy ranks the index anyway); the P&L on `track="etf"` falls back to the index where
  the ETF does not exist, which flatters nothing but must be stated.

## Open questions

To put to the owner when this is started (step 3 of the workflow):

1. **The post's exact rule.** Please paste the post's text (and any chart description) into
   this file: which benchmark, which window, daily or weekly, and whether it reads a sector at
   its own relative *high* (continuation) or *low* (reversal) as the buy. If it is a valuation
   lens (multiples), say so: that part is out of scope here.
2. **Time windows ("change in the timelines").** The draft fixes `W = 156` weeks and a 26-week
   `ΔRS`. Should the owner fix different ones before Phase 0 (for example 5-year `W`, or a
   13-week `ΔRS`)? One of each; a second is a logged addendum and a trial.
3. **Trial budget.** 8 trials (2 scores × 2 directions × 2 shapes) plus the baseline, or drop
   `replace` and test tilts only (4 trials)?
4. **Non-equity instruments.** Score Gold, Silver, Nasdaq 100 and Hang Seng against Nifty 50 like
   the sectors, or exempt them (keep their cross-sectional rank)?
5. **Backfill.** OK to add niftyindices.com history before 2016 to the ETF dataset for every
   core index? It lengthens every ETF backtest's available `start`, so goldens and saved runs
   that start in 2017 do not move, but the dashboard's earliest selectable date will.
6. **Broad.** Should Phase 3 run even if the ETF test fails (the owner's original question was
   about "our momentum sector"), or stay conditional as drafted?

## Log

- 2026-10-10 — created from the owner's X-post idea (Sahil Kapoor,
  status 2108423594837725368). The post could not be fetched from the session, so the rule is
  reconstructed from the owner's summary and flagged as open question 1. Prior own-history
  evidence (cash hurdle, 52-week high, grouped tilt, high-vol exclusion, BL-050 R1) collected in
  Context; the item is distinguished from BL-050's withdrawn "RS vs benchmark" candidate (that one
  leaves the cross-sectional order unchanged; this one does not). Status `Idea`, P2 (owner).
