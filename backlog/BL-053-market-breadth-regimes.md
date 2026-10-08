# BL-053 — Market breadth regimes: which momentum variant works when few or most stocks are above their 50/200-day average

| | |
|---|---|
| **Priority** | P2 — this month's goal is Momentum with real money (BL-010, BL-024, BL-025) and BL-050 is the P1 research line; a breadth gate was already rejected once (below). The study itself is cheap (one rank table per variant, no full backtests until Phase 5) |
| **Status** | Planned |
| **Type** | research |
| **Area** | momentum (Phase 7 touches options) |
| **Created** | 2026-10-08 |
| **Depends on** | BL-015 (pre-registration); the point-in-time `turnover_rank` universe (`liquidity.turnover_rank_members_by_year`, delisted names included); BL-024 (the journal carries any shadow arm) |
| **TODO.md row** | — (filled in when started) |

## Context

**The owner's idea (2026-10-08, two messages):** measure market breadth as the share of stocks
closing above their 50-day (or 200-day) moving average, and ask whether the right momentum
settings depend on it.

- Stay with momentum in every band. Change the **variant** instead: for example, when most stocks
  are below their averages, the 1- and 2-week lookbacks may matter more than the 26/52-week ones.
- **Tag every week by its band:** below 20%, 20–40%, 40–60%, 60–80%, above 80%.
- **Run every variant from every week,** read the result 13 weeks later, and repeat for every week
  in the history. Then see whether some variants beat others in some bands.
- **Use a correlation map** so the variants that compete are genuinely different (low
  correlation). Two variants that hold the same stocks cannot tell anything apart.

**What already exists:**

| Piece | Where | State |
|---|---|---|
| Breadth **gate**: block every fresh buy while fewer than 40% of the universe close above their 40-week average (≈ 200-DMA) | `levers.breadth_gate_mask` (TODO 3.9.23, experiment 5b) | **Rejected.** Broad median rolling ΔCAGR −14.1 (every week simulated), ETF −1.7 |
| Share above the 40-week average now, a week ago and four weeks ago | `categories/momentum_scores._breadth` (BL-049), Momentum Scores market strip | Display only, weekly, point-in-time members |
| Configurable lookbacks and weights, including negative weights; ranksum / voladj / blend scores | `engine.Config.lookbacks`, `weights`, `score` | Every variant below is a setting, not new code |
| Skip-month and 52-week-high rank tables | `levers.py` | Available as variants if wanted |
| Correlation clustering of strategy curves | `choose.clusters` (BL-010 Phase 5; leader clustering at ρ ≥ 0.9, medoid per cluster) | Reusable. Its seed order is a performance rank, so pass a neutral order here (see Phase 2) |
| Fresh-start runs from many start dates | `sweep.rerun_windows`, `tranches.py` | The pattern Phase 3 copies, at 13 weeks instead of 3 years |

**How this differs from the rejected gate.** The gate switched momentum off when breadth was low
and lost heavily: weak-breadth weeks are often where the rebound starts. This item never leaves
momentum. It asks whether a **different ranking** (for example shorter lookbacks) catches that
rebound better, which is the opposite of sitting it out.

**A prior to test, not a mined pattern.** The momentum-crash literature (Daniel and Moskowitz,
2016) finds momentum's worst losses come in sharp rebounds after a bear market: long-lookback
rankings still favour the defensive names that held up, while the beaten-down names bounce
hardest. A short lookback (1–2 weeks) re-sorts fast enough to see the new leaders. Short-term
reversal (a stock's 1-week to 1-month return tends to reverse) points the other way, so the sign
of the effect is an open empirical question. That is exactly the owner's lookback hunch, and it
is written down below as H1 before any data is seen.

## Goal

1. A point-in-time daily breadth series (share above the 50-DMA and the 200-DMA), 2011 to today,
   in the shared catalog.
2. A **correlation map** of a fixed list of momentum variants, and a short list of
   representatives that are actually different.
3. A **weekly fresh-start study**: every representative started at every Friday, read after 13
   weeks (and 4), compared **paired** against the default variant on the same week, grouped by
   breadth band.
4. A pass/kill verdict on whether the best variant **depends on the band** (an interaction), not
   just whether one variant is better overall.
5. Only on a pass: the band → variant rule inside the real Broad funnel with costs and tax, then a
   forward shadow arm in the journal.

## Out of scope

- Non-momentum strategies (value, quality, low volatility). Owner, 2026-10-08.
- Sweeping band edges or moving-average lengths to find the best fit (fixed in Phase 0).
- Portfolio-rule variants (top N, exit rank, cadence, caps). This item varies the **ranking**
  only; the portfolio rules stay at the default so the comparison is about which stocks are picked.
- A variant that wins in **every** band. That is a better variant overall, which is BL-050 /
  BL-010 territory, and choosing it on this full history would be snooping. It is recorded and
  passed on, not adopted here.
- Trading on any of it before the shadow has run.

## Plan

### Phase 0 — Pre-register (draft; finalised and committed before any run)
A rule is never edited after a run: a new, dated rule supersedes it with a logged reason, and
both stay here. The numbers below are proposals; the open questions settle them.

- **Breadth definition:** on each trading day *d*, among point-in-time universe members with at
  least *N* daily closes, the share whose close on *d* is above the simple average of their last
  *N* closes (including *d*); *N* = 50 and 200. Prices forward-adjusted by the confirmed share
  factors (as `patterns/` does), so a split never shows as a crash and every value depends only on
  events up to *d*. A week is tagged by Friday's value.
- **Bands:** the owner's five, on the share above the 200-DMA: 0–20, 20–40, 40–60, 60–80,
  80–100. The 50-DMA bands are reported alongside as a second view, not as a second test. A band
  with fewer than 3 distinct episodes in the fit period is merged into its neighbour towards 50%
  (fixed now, so the merge cannot be chosen after seeing results).
- **Variants (fixed list, all `ranksum`, equal weights unless stated):**

  | ID | Lookbacks (weeks) | Idea |
  |---|---|---|
  | V0 | 1, 4, 13, 26, 52 | The engine default; the paired baseline |
  | V1 | 1 | Very short |
  | V2 | 2 | Very short |
  | V3 | 1, 2 | Short pair |
  | V4 | 1, 2, 4 | Short |
  | V5 | 4, 13 | Medium |
  | V6 | 13 | Medium, single |
  | V7 | 26, 52 | Long |
  | V8 | 52 with the last 4 skipped (12-1) | Classic academic momentum |
  | V9 | 1, 4, 13, 26, 52, `voladj` | Volatility-adjusted default |
  | V10 | 1, 4 positive; 26, 52 negative (grouped tilt, 0.3) | Rebound hunter |

- **Correlation map and representatives (Phase 2):** computed on the fit period only and before
  any band is looked at. Two measures: correlation of each variant's weekly-rebalanced top-N
  excess return over the equal-weight universe, and the average overlap of their top-N picks
  (Jaccard). Clusters by `choose.clusters` at ρ ≥ 0.8 with a **neutral seed order** (the table
  order above, never a performance rank). One representative per cluster: the medoid, with V0
  always kept as the baseline.
- **Measurement (Phase 3):** for every Friday *t* and representative *v*: the equal-weight top N
  (proposed 20) of *v*'s ranking at *t* among the universe, bought at the Monday open, held
  without rebalancing for 13 weeks (4 as a secondary horizon). The return is R(*v*, *t*); the
  **paired difference** is D(*v*, *t*) = R(*v*, *t*) − R(V0, *t*). The pairing removes the market
  move both share, which is most of the noise. One round-trip cost on each.
- **H1 (lookback, theory-led):** in the 0–20 and 20–40 bands, the short variants (V1–V4) have a
  mean D above zero; in the 60–80 and 80–100 bands they do not.
- **H2 (the owner's, general):** the best variant depends on the band. Statistic: the spread
  between bands of each representative's mean D. Null: the breadth series circularly shifted
  against the returns (shifts of at least 52 weeks), which keeps both series' own
  autocorrelation and breaks only their alignment.
- **Universe:** point-in-time top 500 by trailing turnover (`turnover_rank`, delisted names
  included), after the liquidity gate. The ranking runs directly over it (a clean signal test);
  the Broad category funnel enters only in Phase 5.
- **Look-ahead check:** a test rebuilds breadth and rankings on data cut at a date and requires
  every value before the cut to be identical (the `test_lookahead.py` pattern); returns start at
  the Monday open after the Friday read.
- **Overlap:** the 13-week windows of consecutive weeks share 12 weeks, so a band's weeks are not
  independent samples. Intervals by block bootstrap (blocks of 13 weeks, resampled within
  episodes), and every result also reported on the 13 non-overlapping sub-samples (every 13th
  Friday, as `tranches.py` does), with the spread across them shown as the luck range.
- **Pass / kill rule:**
  1. *Fit (2012-01 → 2019-12):* H2's circular-shift p-value < 0.05.
  2. *Test (2020-01 → the last Friday with 13 weeks of data):* the band → variant mapping chosen in
     the fit period (per band, the representative with the highest mean D; V0 where none beats it)
     has a mean D above zero with a 90% block-bootstrap interval above zero, and points the same
     way in at least 9 of the 13 non-overlapping sub-samples.
  3. *Real (Phase 5):* the mapping inside the Broad funnel, with switching costs and STCG, beats
     both the default and the equal-weight blend of the representatives on CAGR **and** Sharpe in
     more than 60% of the 28 rolling 3-year windows, with deflated Sharpe ≥ 0.95 counting every
     mapping considered.

  Failing 1 ends the study (informative, not adopted). Failing 2 or 3 is a kill.
- **Hold-out:** the fit/test split above. 2020-01 onwards is unseen **for the mapping**. It is not
  unseen for V0, whose lookbacks were chosen with data through 2026; the deciding test is the
  forward shadow (Phase 6), as in BL-050.
- **Will not run:** other moving-average lengths (20, 100), other band edges, variants not in the
  table, other top-N sizes, or the 50-DMA bands as a second pass/kill test. Running any of these
  needs `override: <reason>` in the Log.

### Phase 1 — Breadth series: build, store, check
- **Tasks:**
  - `breadth.py` in `packages/momentum-backtesting`: the daily series per universe — date,
    members, members with enough history, share above 50-DMA, share above 200-DMA.
  - A `market_breadth` table in the shared catalog (trading-data migration) and `mbt breadth
    build|show`; the 19:30 Friday stock sync adds the new weeks.
  - Tests: a hand-computed fixture, the cut-date look-ahead test, point-in-time membership (a
    stock stops counting the day it leaves), split handling, the `SYMBOL#2` series break.
  - Checks against known episodes (March 2020, the 2018 small-cap fall, June 2022) and against
    the Scores strip's weekly `above_ma40` (the 200-DMA series sampled on Fridays should track
    it). If the owner has an outside series, compare where they overlap.
  - Count the weeks and distinct episodes in each band. The 0–20 band is expected to be rare;
    apply Phase 0's merge rule now, before any returns are read.
- **Deliverables:** the series 2011 → today; a chart and the band counts in the Log.
- **Done when:** tests pass, the episodes look right, the Friday samples track `above_ma40`
  (correlation ≥ 0.9 or the gap explained), and the final band list is logged.

### Phase 2 — Correlation map: pick the competitors
- **Tasks:**
  - One rank table per variant over the universe (cached; no backtests).
  - On the fit period only: the return-correlation matrix and the pick-overlap matrix, as two
    heatmaps; `choose.clusters` at ρ ≥ 0.8 with the neutral seed order; one representative per
    cluster plus V0.
- **Deliverables:** `data/backtests/bl053_correlation.csv`, the two heatmaps, the representative
  list, all in the Log **before** Phase 3 starts.
- **Done when:** the representative list is committed. It is not changed after Phase 3 results
  are seen.

### Phase 3 — Weekly fresh-start study (the core test)
- **Tasks:**
  - For every Friday and every representative: the 13-week (and 4-week) forward return of its
    top N, and the paired difference D against V0.
  - Per band: weeks, episodes, mean D, median D, share of weeks D > 0, block-bootstrap 90%
    interval, and the 13-sub-sample spread. The same table for the 50-DMA bands (descriptive).
  - H1 and H2 on the fit period; if H2 passes, the mapping fixed and the test-period check run
    once.
- **Deliverables:** `data/backtests/bl053_weekly_study.csv` (one row per Friday × variant: band,
  R, D) and a band × variant table of mean D with intervals in the Log.
- **Done when:** H1, H2 and (if reached) the test-period verdict are recorded.

### Phase 4 — Explain or stop
- If Phase 3 killed the idea: record "informative, not adopted", keep the breadth series as an
  indicator, and close (Phase 6's display part may still be worth doing).
- If it passed: write down **why** the winning variant fits its band (for example, short
  lookbacks catching the first leaders out of a washout), and check the edge does not come from a
  handful of stocks or one episode (drop the top 5 contributors, drop each episode in turn).
- **Done when:** a pass survives the drop tests, or the item is closed.

### Phase 5 — The rule inside the real strategy (only after a Phase 4 pass)
- **Tasks:** run Broad with the lookbacks swapped by band (minimum 4 weeks in a band before a
  swap, so it does not flap), with the real portfolio rules, costs and tax. A swap changes the
  picks and so the turnover; that cost is the point of this phase. Score on the 28 rolling windows
  against the default and the equal-weight blend of the representatives.
- **Done when:** Phase 0's rule 3 verdict is recorded.

### Phase 6 — Show it, and shadow it (breadth display always; variant label only on a pass)
- **Tasks:**
  - Dashboard: the breadth band and a small 200/50-DMA breadth chart on Momentum › This week and
    the Scores market strip (Guide page updated in the same commit).
  - On a pass only: the band-switching rule as a shadow arm in the forward journal (BL-024), with
    a failure line fixed in advance, and a line in the Friday Telegram message naming the band
    and the variant it would use.
- **Done when:** the band is on screen and, if it passed, the shadow arm is recording.

### Phase 7 — Options (optional, after Phase 3)
- Tag each options day with the previous close's breadth band and bucket the leg-wise results
  (`obt legwise`) by it, next to the existing regime buckets. Descriptive only; India VIX and the
  gap probably matter more for intraday index options than a slow 200-DMA count.

## Risks

- **Few independent regimes.** The 0–20 band probably holds only a handful of washouts
  (2011, 2015–16, 2018–19 in small caps, 2020, 2022). Hundreds of weeks can still be only five
  episodes. Episodes are counted, bootstrapping keeps them whole, and the merge rule handles a band
  that is too thin.
- **Overlapping windows.** Reading every week at 13 weeks makes neighbouring results nearly the
  same number. Treating them as independent would make noise look significant. Block bootstrap
  and the 13 non-overlapping sub-samples guard this.
- **Many comparisons.** About 5 representatives × 5 bands is about 25 cells, and one will look
  good by chance. The test is the band × variant interaction with a circular-shift null, fixed in
  advance; the correlation map shrinks the number of competitors before any result is seen.
- **"Best everywhere" disguised as a regime effect.** If one variant wins in all bands, the
  band adds nothing; Out of scope covers it.
- **Survivorship and corporate actions.** Point-in-time membership with delisted names;
  forward-adjusted prices; the series-break test.
- **Signal test vs real strategy.** Phase 3 holds the top 20 untouched for 13 weeks; the live
  strategy rebalances with hysteresis inside a category funnel. A ranking edge can vanish in the
  real rules, which is why Phase 5 exists.
- **Lag.** A 200-DMA count turns late; the band may change after the move. The 50-DMA view is
  reported to show whether the faster count would have helped (descriptively only).

## Open questions

1. **Universe:** the point-in-time top 500 by turnover (proposed, a Nifty 500 proxy), the
   755-name Total Market, or every liquid stock?
2. **Band average:** bands on the 200-DMA with the 50-DMA shown alongside (proposed), or the
   reverse?
3. **Variants:** is the V0–V10 table right? Anything to add (for example 2, 4 or 1, 13) or drop?
4. **Top N for the signal test:** 20 (proposed, steadier) or the 8–10 the real strategy holds?
5. **Horizon:** 13 weeks with 4 as secondary (proposed), or add 26?
6. **Options:** include Phase 7, or keep this to Momentum?
7. **Outside check:** is there a published "% above 200 DMA" series to compare against?

## Log

- 2026-10-08 — created from the owner's idea. Linked to the rejected breadth gate (TODO 3.9.23,
  experiment 5b) and the Scores strip's `above_ma40` (BL-049).
- 2026-10-08 — reshaped after the owner's second message: momentum only, with the **lookback**
  as the thing that changes by band; the owner's five 20-point bands; every variant started every
  week and read after 13 weeks, paired against the default; a correlation map to choose
  low-correlation competitors before any band result is read. Phase 0 is still a draft, settled by
  the open questions when the item starts.
