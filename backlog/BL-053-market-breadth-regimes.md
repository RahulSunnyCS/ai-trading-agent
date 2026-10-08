# BL-053 — Market breadth regimes: which strategy works when few or most stocks are above their 50/200-day average

| | |
|---|---|
| **Priority** | P2 — this month's goal is Momentum with real money (BL-010, BL-024, BL-025) and BL-050 is the P1 research line; a breadth gate was already rejected once (below), so this starts as a cheap indicator plus a descriptive map |
| **Status** | Planned |
| **Type** | research |
| **Area** | momentum (Phase 5 touches options) |
| **Created** | 2026-10-08 |
| **Depends on** | BL-015 (pre-registration); BL-010 Phase 6 (the frozen ensemble's sleeves are candidates); BL-024 (the journal carries any shadow arm); the point-in-time `turnover_rank` universe (`liquidity.turnover_rank_members_by_year`, delisted names included) |
| **TODO.md row** | — (filled in when started) |

## Context

**The owner's idea (2026-10-08):** measure market breadth as the share of stocks closing above
their 50-day (or 200-day) moving average. Different strategies may suit different breadth
levels, for example:

- **about 20% above:** a downtrend, where one strategy works;
- **about 40–50% above:** a mixed market, where another works better;
- **about 80% above:** a broad rally, where a third works.

Test whether that is true, and if so, which strategy belongs in which band.

**What already exists:**

| Piece | Where | State |
|---|---|---|
| Breadth **gate**: block every fresh buy while fewer than 40% of the universe close above their 40-week average (≈ 200-DMA) | `levers.breadth_gate_mask` (TODO 3.9.23, experiment 5b) | **Rejected.** Broad median rolling ΔCAGR −14.1 (every week simulated), ETF −1.7 |
| Share above the 40-week average now, a week ago and four weeks ago; share up over 13 weeks | `categories/momentum_scores._breadth` (BL-049), on the Momentum Scores market strip | Display only, weekly, point-in-time members |
| Post-hoc regime bucketing of options results | `option_backtesting/features/regime.py` (M-5) | Built; uses volatility/trend tags, not breadth |
| Candidate strategies | Frozen ensemble (`search_spaces/bl010_phase6_frozen.json`, four sleeves), ETF live config, 13-week reversal sleeve (`reversal.py`), liquid fund, Nifty 500 / Midcap 150 TRI (`reference_benchmarks`) | All have weekly curves today |

**What is missing:** a daily 50-DMA / 200-DMA breadth series over a point-in-time universe, and
any table of how each strategy did in each breadth band.

**How this differs from the rejected gate.** The gate asked "should momentum stop buying when
breadth is low?" and the answer was no, by a lot: low-breadth weeks are often where the rebound
starts, and missing those costs more than the falls it avoids. The owner's idea asks a different
question: **which** strategy to run in each band (selection, not on/off). The gate result is
still a warning for one band.

**A prior to test, not a mined pattern.** The momentum-crash literature (Daniel and Moskowitz,
2016) finds that momentum's worst losses come in sharp rebounds after a bear market: the
beaten-down names (which momentum is short of, or here simply does not hold) bounce hardest. In
breadth terms that is a **washout then thrust**: the share above the 200-DMA falls very low, then
the share above the 50-DMA rises fast. That gives one hypothesis fixed before any data is seen
(H1 below), alongside the owner's broader three-band one (H2).

## Goal

1. A point-in-time daily breadth series (share above the 50-DMA and the 200-DMA), 2011 to today,
   stored in the shared catalog and rebuilt by the weekly stock sync.
2. A **regime map**: each candidate strategy × each breadth band, with weeks, distinct
   episodes, excess return over Nifty 500 TRI and a block-bootstrap interval.
3. A pass/kill verdict on **one** pre-registered switching (or weighting) rule against the
   honest comparators: the best single candidate and an equal-weight blend of all candidates.
4. Only on a pass: a forward shadow arm in the journal, and the breadth band shown on the
   dashboard next to the weekly signal.

## Out of scope

- Inventing new strategies for a band. Candidates are the strategies already in the repo.
- Sweeping band edges or moving-average lengths to find the best fit (fixed in Phase 0).
- Intraday breadth (advance/decline lines), sector-level breadth, new-high/new-low counts.
- Trading on it before the Phase 4 shadow has run.

## Plan

### Phase 0 — Pre-register (draft; finalised and committed before any run)
A rule is never edited after a run: a new, dated rule supersedes it with a logged reason, and
both stay here. The numbers below are proposals; the open questions settle them.

- **Breadth definition:** on each trading day *d*, among point-in-time universe members with at
  least *N* daily closes, the share whose close on *d* is above the simple average of their last
  *N* closes (including *d*); *N* = 50 and 200. Prices forward-adjusted by the confirmed share
  factors (as `patterns/` does), so a split never shows as a crash and every value depends only
  on events up to *d*. The weekly decision reads Friday's value; fills follow the repo's
  Monday-open convention (BL-010 addendum 1).
- **Bands (200-DMA, primary):** weak < 30%, mixed 30–70%, strong > 70%, with a 5-point
  hysteresis so a band changes only when the value crosses the edge by 5 points. The owner's
  20% and 80% tails are reported descriptively, not as extra bands.
- **H1 (theory-led):** in the 13 weeks after a washout-thrust (share above the 200-DMA below 20%
  at some point in the last 8 weeks, and share above the 50-DMA rising above 50%), the Broad
  frozen ensemble's excess over Nifty 500 TRI is lower than in all other weeks, and the reversal
  sleeve and the equal-weight index both beat it.
- **H2 (owner's):** the best candidate by Sharpe differs between the weak, mixed and strong bands,
  with non-overlapping 90% block-bootstrap intervals (8-week blocks) in at least one band.
- **Universe:** point-in-time top 500 by trailing turnover (`turnover_rank`, delisted names
  included) — a Nifty 500 proxy. Not today's list for past years.
- **Look-ahead check:** a test rebuilds the series on data cut at a date and requires every value
  before the cut to be identical (the `test_lookahead.py` pattern); forward returns start at the
  Monday open after the Friday read.
- **Pass / kill rule (Phase 3):** the switching rule must beat **both** the best single candidate
  and the equal-weight blend of candidates on CAGR **and** Sharpe in more than 60% of the 28
  rolling 3-year windows (the 3.9.23 yardstick), with deflated Sharpe ≥ 0.95 counting every
  mapping considered, and PBO < 0.5 (CSCV over the mappings). Costs and STCG on the switch trades
  included. Anything less is a kill.
- **Hold-out:** the band → strategy mapping is chosen on data up to 2019-12-31 only, and judged on
  2020-01-01 → the latest week. This is not a clean hold-out for the candidates themselves (the
  frozen configs were chosen with data through 2026), only for the mapping. The deciding test is
  the forward shadow (Phase 4), as in BL-050.
- **Will not run:** other moving-average lengths (20, 100), other band edges, sector breadth, or
  the Phase 3 rule if Phase 2 shows no separation (H2 fails). Running any of these needs
  `override: <reason>` in the Log.

### Phase 1 — Breadth series: build, store, check
- **Tasks:**
  - `breadth.py` in `packages/momentum-backtesting`: the daily series per universe — date,
    members, members with enough history, share above 50-DMA, share above 200-DMA.
  - A `market_breadth` table in the shared catalog (trading-data migration) and `mbt breadth
    build|show`; the 19:30 Friday stock sync rebuilds the new weeks.
  - Tests: a hand-computed fixture, the cut-date look-ahead test, point-in-time membership (a
    stock that left the index stops counting the day it left), split handling, the
    `SYMBOL#2` series break.
  - Checks against known episodes (March 2020, the 2018 small-cap fall, June 2022) and against
    the existing weekly `above_ma40` on the Scores strip (the 200-DMA daily series sampled on
    Fridays should track it closely). If the owner has an outside series (a charting site's
    "Nifty 500 % above 200 DMA"), compare where they overlap.
- **Deliverables:** the series 2011 → today in the catalog; a chart in the item's Log.
- **Done when:** tests pass, the episodes look right, and the Friday samples track `above_ma40`
  (correlation ≥ 0.9, or the gap is explained).

### Phase 2 — Regime map (descriptive)
- **Tasks:**
  - Tag every week by its Friday band. For each candidate: weeks, **distinct episodes** (runs of
    consecutive weeks in one band; the honest sample size), mean weekly excess over Nifty 500
    TRI, annualised return, Sharpe, hit rate, worst fall inside the band, and a 90% interval by
    block bootstrap.
  - Transitions: forward 4- and 13-week returns after entering each band, and after a
    washout-thrust (H1).
  - Write `data/backtests/bl053_regime_map.csv` and a summary table in the Log.
- **Deliverables:** the regime map; H1 and H2 verdicts.
- **Done when:** both verdicts are recorded. If H2 fails, stop here, record "informative, not
  adopted", and close (the breadth series still stays as an indicator).

### Phase 3 — One switching rule, tested (only if H2 passes)
- **Tasks:**
  - The mapping rule chosen from data to 2019 only: per band, the candidate with the best Sharpe.
    A minimum of 4 weeks in a band before switching.
  - The action form the owner chooses (open question 5): switch the whole portfolio, change the
    weights between the ensemble's sleeves, or change exposure (rest in the liquid fund).
    Every switch pays costs and tax.
  - Score it on the 28 rolling windows against the best single candidate, the equal-weight blend
    and the rejected breadth gate; deflated Sharpe and PBO over every mapping considered.
- **Deliverables:** pass/kill against Phase 0's rule, with run ids.
- **Done when:** the verdict is recorded and not tuned around.

### Phase 4 — Show it, and shadow it (breadth display always; strategy label only on a pass)
- **Tasks:**
  - Dashboard: the breadth band and a small 200/50-DMA breadth chart on Momentum › This week and
    the Scores market strip (Guide page updated in the same commit). This part is useful as
    information whatever Phase 3 says.
  - On a pass only: the switching rule as a shadow arm in the forward journal (BL-024), with a
    failure line fixed in advance (for example trailing the equal-weight blend by more than 5
    points over 26 weeks), and a line in the Friday Telegram message naming the band.
- **Done when:** the band is on screen and, if it passed, the shadow arm is recording.

### Phase 5 — Options (optional, after Phase 2)
- Tag each options day with the previous close's breadth band and bucket the leg-wise results
  (`obt legwise`) by it, next to the existing regime buckets. Expect little: the options
  strategies are intraday on the index, where India VIX and the gap probably matter more than a
  slow 200-DMA count. Descriptive only.

## Risks

- **Few independent regimes.** 2011–2026 holds only a handful of washouts (2011, 2013,
  2015–16, 2018–19 in small caps, 2020, 2022). Counting weeks overstates the evidence; Phase 2
  counts episodes and bootstraps in blocks.
- **Data snooping.** Two averages × band edges × candidates × mappings is a large search. Phase 0
  fixes all of them, and the deflated Sharpe counts the mappings.
- **Survivorship.** Breadth over today's list overstates past strength (the survivors were the
  ones above their averages). Point-in-time membership with delisted names only.
- **Corporate actions.** An unadjusted split looks like a crash and pushes a stock below its
  average. Forward-adjusted prices; the series-break test.
- **Switch costs and tax.** Moving a whole stock portfolio between strategies realises short-term
  gains (20% STCG) and pays costs both ways. A rule that wins before tax can lose after it, which
  is why reweighting the ensemble's sleeves may be the safer action form.
- **Lag.** A 200-DMA count turns late; by the time the band changes, much of the move may be
  done. The 50-DMA thrust leg of H1 exists for this.
- **The universe changes the number.** Small caps dominate an equal-count share; the Nifty 500
  proxy and the 755-name Total Market will differ. One universe is fixed in Phase 0.

## Open questions

1. **Universe:** the point-in-time top 500 by turnover (proposed, a Nifty 500 proxy), the
   755-name Total Market, or every liquid stock?
2. **Average:** 200-DMA as the primary band and 50-DMA for the thrust (proposed), or one only?
3. **Band edges:** weak < 30 / mixed 30–70 / strong > 70 (proposed), or your 20 / 40–50 / 80
   with the gaps between them reported but not traded?
4. **Candidates:** the four frozen sleeves separately, the ETF live config, the 13-week reversal
   sleeve, the liquid fund, Nifty 500 TRI — anything to add or drop?
5. **Action form:** switch the whole portfolio, reweight the ensemble's sleeves, or change
   exposure with the rest in the liquid fund?
6. **Options:** include Phase 5, or keep this to Momentum?
7. **Outside check:** do you have a published "% above 200 DMA" series to compare against?

## Log

- 2026-10-08 — created from the owner's idea. Linked to the rejected breadth gate (TODO 3.9.23,
  experiment 5b) and the Scores strip's `above_ma40` (BL-049). Phase 0 drafted, not committed as
  final: it is settled by the open questions when the item starts.
