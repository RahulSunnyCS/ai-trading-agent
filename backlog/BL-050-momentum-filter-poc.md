# BL-050 — Momentum filter POC: volume, relative strength, overextension, residual momentum, trend quality (Broad only)

| | |
|---|---|
| **Priority** | P2 — research on top of a strategy that is only now entering paper trading; this month's commitment is BL-010/001/024/025 |
| **Status** | In progress |
| **Type** | research |
| **Area** | momentum |
| **Created** | 2026-10-07 |
| **Depends on** | BL-015 (pre-registration); BL-010 Phase 6 (the frozen ensemble is the comparator); BL-024 (the journal carries the Phase 4 shadow arm, and Phase 4's comparison needs BL-024 Phase 2, journal scoring, which is not built yet); BL-001 (goldens prove the default output is unchanged) |
| **TODO.md row** | [§3.23](../TODO.md) |

## Context

The owner's idea (2026-10-07), from a "five filters to add" slide: momentum, volume expansion,
trend strength, relative strength and fundamental filters. Before planning, the repo was checked
against each of the five. Most of the ground is already covered:

| Filter family | Already in the repo | Earlier result |
|---|---|---|
| Momentum | Ranksum / voladj / blend scores; `defensive="filter"` (13-week return must beat cash); skip-month; grouped tilt (`levers.grouped_momentum_ranks`) | Cash hurdle rejected twice (TODO 3.9.18, 3.9.23); skip-month rejected; grouped tilt wins on ETF but loses on Broad at every setting |
| Volume expansion | Used only inside the liquidity gate (`categories/liquidity.py`), the reversal entry (`reversal.py`) and the BL-042/043 breakout state | **Never tested as a standalone ranking or gate** |
| Trend strength | Market-wide gates in `levers.py`: `trend_gate_mask`, `breadth_gate_mask`, `choppy_mask`, `dispersion_timing`; `high_vol_mask` | All rejected on Broad (median ΔCAGR −2.8 to −16.1). `high_vol_mask` is the one robust ETF win but a disaster on Broad. **No per-stock trend-quality score exists** |
| Relative strength | The cross-sectional ranking is relative strength; `levers.high52_proximity` / `below_high52_mask` / `high52_ranks` | 52-week-high proximity marginal, not adopted |
| Fundamental | None; no point-in-time fundamentals in the repo, and the handover says not to fabricate a proxy | — |

Two notes that shape the plan:

- **Relative strength vs a benchmark leaves the ranking unchanged.** Dividing every stock's
  return by the same Nifty return keeps the order (exactly for ranksum, almost exactly for the
  others). RS adds information only as a **hurdle** (pass/fail against the benchmark). The
  "RS improving" axis of a rotation chart (RRG) is the same thing again. Against a shared
  benchmark it comes down to a short-lookback return or an acceleration across stocks: the first
  is already a lookback, and the second was rejected in the reversal work. The 2026-10-07
  discussion first suggested it as a candidate; that suggestion is withdrawn here.
- **No clean unseen backtest window is left for this strategy.** BL-010's 2012–16 hold-out has
  been used (the backcast failed against Midcap 150 TRI). The 2024-01-01 → 2026-09-25 window is
  unread by pattern work (BL-042 passed it to BL-043, whose development failed, so it was never
  run), but the frozen configs were chosen with data through 2026-10, and 3.9.23 ran close
  relatives of T1 and M1 over it. For this strategy it is a **reserved** window, not an unseen
  one. The backtests here can only **rank** candidates. The deciding test is forward shadow
  tracking (Phase 4).

**Owner decisions (2026-10-07):**
- **Broad (stocks) only.** No ETF track. Volume and daily highs/lows exist only for stocks
  (`bars_1d_stock`); index and ETF series hold open/close only.
- **Fundamentals are not required now.** They are out of scope; no data spike.
- **Forward shadow tracking is the deciding test**, as recommended, because no clean backtest
  window remains.
- **The comparator is the BL-010 Phase 6 frozen ensemble**, which must not change. Paper trading
  of it starts 2026-10-09 (BL-025); the Friday signal, saved favourites and goldens stay
  byte-identical.

**What this item can reuse:**
- `levers.py` features and masks.
- `run_broad_backtest(extra_no_buy=…)` for gates (blocks fresh buys only, never forces a sale).
- The BL-042 event-study pattern (`patterns/study.py`: momentum-decile-matched controls,
  `newey_west_t`, Holm).
- The PIT `turnover_rank` universe (`liquidity.turnover_rank_members_by_year`).
- `reference_benchmarks.NIFTY500_TRI`.
- `choose.ensemble_curve`, and the 3.9.23 yardstick (`sweep.rerun_windows` + `compare_rolling`:
  rolling-window win shares and median deltas).

**What is missing:** a tilt hook at the **pick** level of the category funnel. All four frozen
configs run category mode ON, where the rank table holds only the 1–2 picks of each held category,
ranked by slot. `stock_tilt` re-orders those slots, so it can never choose a different stock
inside a category, and two of the four configs already use it (1.0 and 0.5).

## Goal

A pre-registered, kill-early answer for six specific filters on the frozen Broad ensemble:
does any of them improve it after costs, robustly across rolling windows and without
overfitting? Any survivor then runs as a shadow arm in the forward journal before it can be
proposed for real money (through BL-025).

## Out of scope

- The ETF / index rotation (`live_config.toml`) and its pending 3.9.23 decisions.
- Fundamentals of any kind, including market cap from shareholding filings.
- Changing the frozen ensemble, the Friday signal, saved favourites or goldens. All of it stays
  byte-identical until an owner decision under BL-025.
- Delivery % (not ingested; it would be a separate data item).
- Combining surviving filters. That needs a new, dated experiment block after Phase 3.

## Plan

### Phase 0 — Pre-register (`search_spaces/bl050_criteria.json`, committed before any run)

The criteria file is the machine-readable copy of these rules and holds the exact formulas,
windows and thresholds; code reads it and never restates a number.

- **Hypothesis:** at least one of the six features below, applied the same way to all four frozen
  configs, raises the ensemble's after-cost CAGR robustly, without worsening its drawdown.
- **Universe:** Broad Momentum on the point-in-time `turnover_rank` universe, curated category
  tags, frozen liquidity gate (₹2 cr / ₹30 / 0.25, circuit gate on). Delisted names stay in their
  historical years. Any cross-sectional step uses only that week's members that pass the gate
  (`stock_membership`), never every column of the price frame: the frame also holds names that
  only join in later years.
- **Comparator:** the BL-010 Phase 6 ensemble exactly as frozen
  (`search_spaces/bl010_phase6_frozen.json`: four configs, equal capital reset each April,
  `signal_delay=1`, itemised costs + 15 bps slippage, pre-tax), with only `start`/`end` set to
  the window being tested.
- **The six trials** (one shape, one setting each; tilt weight 0.25):

  | ID | Family | Feature (weekly, point-in-time) | Shape | Pre-registered direction |
  |---|---|---|---|---|
  | V1 | Volume | Median daily **turnover (₹)** over the last 20 sessions ÷ median over 130 sessions. Turnover, not share volume: it is not distorted by splits and bonuses | Tilt | Higher is better |
  | V2 | Volume | Up-week turnover ÷ down-week turnover over 13 weeks (accumulation; the `reversal.py` idea on turnover) | Tilt | Higher is better |
  | R1 | Relative strength | 26-week return must beat Nifty 500 TRI's 26-week return | Gate (no new buy if it fails) | Names that fail are worse |
  | M1 | Momentum | Overextension: close ÷ 10-week average in the top 5% of that week's universe | Gate (no new buy if overextended) | Overextended names are worse |
  | M2 | Momentum | Residual momentum: residuals from a trailing 52-week regression of weekly returns on Nifty 500 TRI, summed over the 26 weeks ending 4 weeks ago, divided by the residuals' standard deviation | Tilt | Higher is better |
  | T1 | Trend quality | Annualised slope of log weekly close over 26 weeks × R² of that fit | Tilt | Higher is better |

- **Where each shape acts** (owner, 2026-10-08):
  - **Tilts act at the pick level.** Categories are chosen exactly as frozen. Inside each held
    category, the picks are the best names by
    `0.75 × momentum percentile + 0.25 × feature percentile`, both percentiles taken over that
    week's pool. A missing feature counts as the median. The config's own `stock_tilt` then
    applies unchanged on top. A tilt changes exits too: a held name that stops being a pick is
    sold, as today.
  - **Gates go through `extra_no_buy`.** They block fresh buys only and never force a sale. A
    blocked pick's slot goes to the next buyable slot (a lower category's pick), not to the next
    stock in the same category.
  - Atomics (`ATOMIC_NAMES`: Gold, Silver, Nasdaq 100, Hang Seng) are never gated and get a
    neutral tilt.
- **Look-ahead check:**
  - Every feature uses data up to the decision Friday's close only; `signal_delay=1` stays.
  - Daily turnover and prices are labelled by their W-FRI week, as prices and the liquidity gate
    already are. Fyers top-up rows (`synthetic_close`) are left out of turnover.
  - Nifty 500 TRI is matched to the stock weeks exactly, with no carry-forward: a missing TRI
    week makes R1/M2 missing that week (counted, not filled).
  - A prefix-invariance test: for sampled weeks, every feature computed from **raw daily bars cut
    at that Friday, with membership rebuilt from the cut data**, equals the full-data value.
    Slicing the weekly frame instead would miss a universe leak.
  - Regressions (M2, T1) use trailing windows only; M1's percentile uses that week's members only.
  - Screen forward returns start at the fill week (t+1), not the decision week.
  - Nothing reads a bar dated 2024-01-01 or later before the one hold-out run, and no
    development forward return ends after 2023-12-29.
- **Development window:** 2012-01-01 → 2023-12-29. 2012–16 was read once by the BL-010 backcast.
  That read does not bias a comparison of filter against no filter.
- **Trial count:** the 6 trials here plus at least 39 related earlier trials on the same Broad
  base: at least 15 levers in 3.9.23 (the 11 of the corrected re-run plus at least 4 grouped-tilt
  settings) and BL-042's 24 ranking trials. None was adopted. T1 is a cousin of the
  smoothness gate (rejected), M1 near the inverse of the 52-week-high gate (marginal), R1 a
  relative cousin of the cash hurdle. PBO runs over this experiment's 6 + baseline; the deflated
  Sharpe is reported with N = 45.
- **Pass / kill rules** (owner chose the tighter bar, 2026-10-08):
  - **Phase 2 screen:** one-sided test in the pre-registered direction at 13 weeks, Holm across
    the six at α 0.05, Newey-West t. The spread is measured inside momentum deciles of the top
    quintile, as BL-042 did, so a feature correlated with momentum cannot pass on momentum
    alone. A feature below the minimum sample, or a gate blocking under 2% of candidates, is
    inconclusive and does not pass.
  - **Phase 3 engine test:** against the comparator on the dev window, all of:
    - median ΔCAGR ≥ +2.0 pts across rolling 3-year windows stepped quarterly;
    - CAGR win share ≥ 70%;
    - full-period MaxDD no more than 3 pts worse;
    - PBO ≤ 0.3 across the six trials plus the baseline (CSCV).
- **Hold-out:** 2024-01-01 → 2026-09-25 stays reserved for **one** confirmation run of Phase 3
  survivors only. Pass = ΔCAGR ≥ 0 and MaxDD no more than 3 pts worse. This is a weaker rule
  because the window is short and, for the base configs, in-sample. Phase 4 is the deciding test.
- **Will not run:** each needs `override: <reason>` in the Log.
  - Fundamentals (owner, 2026-10-07).
  - The ETF track (owner, 2026-10-07).
  - Market-wide trend, breadth or choppiness gates (rejected in 3.9.23).
  - Cash-hurdle absolute momentum (rejected twice).
  - 52-week-high proximity (marginal).
  - RSI (a duplicate of M1).
  - ADX (daily highs/lows are not split-adjusted, and it overlaps T1).
  - RS momentum / the RRG axis (it reduces to a lookback; see Context).
  - Delivery %.
  - A second setting or weight for any feature, or a tilt at the slot or pool level.
  - Combinations of survivors.
  - A second hold-out run.

### Phase 1 — Features and hooks (no change to any default output)

- **Tasks:**
  - Add the six features as pure functions next to `levers.py`, reading their definitions from
    `bl050_criteria.json`. Use turnover from `bars_1d_stock` and
    `reference_benchmarks.NIFTY500_TRI`.
  - Add the pick-level tilt hook (`build_effective_stock_ranks` / `category_picks`), off by
    default, independent of `stock_tilt`.
  - Add a guard that refuses any read of bars on or after 2024-01-01, except the one-shot
    hold-out run, which claims `search_spaces/bl050_holdout_result.json` before it reads.
  - Add prefix-invariance tests per feature (raw bars cut, membership rebuilt).
- **Deliverables:** feature module, hook, guard, tests.
- **Done when:** the tests pass, `update-goldens.py` reports no change,
  `tests/test_broad_parity.py` passes, and on current data the four frozen configs give
  identical curves with the hook off and with no hook. The frozen `scored_curves_sha256` can be
  reproduced only on the frozen data snapshot (last week 2026-10-02, factors `4d066205752f`); if
  the data has moved since, log that instead of claiming the hash.

### Phase 2 — Cheap screen (event study, the BL-042 pattern)

- **Tasks:**
  - At every 4-weekly decision Friday in the dev window, take the top quintile of the universe
    by config `1281e8ed6824`'s score (voladj, 4/13/26/52 weeks, recent weights; two of the four
    frozen configs share it), split into its two momentum deciles.
  - For tilts, split each decile by feature (top half vs bottom half). For gates, split it into
    blocked vs passed.
  - Measure forward 4- and 13-week returns from the fill week, net of costs, and the Newey-West
    t-statistic. Only the 13-week test decides.
  - Also report how many names each gate blocks per week. A gate that blocks almost nothing or
    almost everything is noted, not tuned.
- **Deliverables:** `search_spaces/bl050_screen_result.json`, a short table in this file.
- **Done when:** every feature has a recorded pass or kill under the Phase 0 rule; killed ones
  stop here (except as PBO trials in Phase 3).

### Phase 3 — Engine test on the frozen ensemble

- **Tasks:**
  - Run all six features through all four frozen configs: gates via `extra_no_buy`, tilts via
    the Phase 1 hook. Features killed in Phase 2 run only as PBO trials and cannot pass.
  - Build the ensemble with `choose.ensemble_curve`.
  - Score with the 3.9.23 yardstick (each rolling window a fresh run from its start) and CSCV/PBO
    over all six trials, so the trial count stays honest. Report average holdings, cash share,
    turnover and gate substitutions next to every result, and the deflated Sharpe with N = 45.
  - Run the single confirmation on the reserved 2024–26 window for survivors only.
- **Deliverables:** `search_spaces/bl050_dev_result.json`, `bl050_holdout_result.json`, a
  results table and verdict per feature.
- **Done when:** every surviving feature has a pass/kill verdict on both windows, and the
  hold-out run count is 1 (or 0 if nothing survived).

### Phase 4 — Forward shadow arm (the deciding test)

- **Tasks:**
  - One shadow arm per Phase 3 survivor (owner, 2026-10-08: if two survive, two arms). Each arm
    is the four frozen configs plus that filter, saved as four favourites that are never the
    active (Telegram) favourite.
  - Record them weekly in the forward journal (BL-024) next to the frozen ensemble, from the next
    Friday, without changing either. A new request field adds a golden scenario; existing
    goldens stay unchanged.
  - Read the comparison from the CLI (`mbt journal show`, the tracker). No dashboard view.
  - After ≥ 26 weeks, compare each arm with the ensemble over the same weeks:
    - shadow return ≥ ensemble return;
    - drawdown no more than 3 pts worse;
    - no live-rule breach that the ensemble did not also hit.
- **Deliverables:** the shadow favourites, their journal entries, a dated verdict in the Log.
- **Done when:** 26 recorded weeks and a verdict per arm. Adoption is a separate owner decision
  under BL-025 (paper first, then money), never automatic. Needs BL-024 Phase 2 (journal
  scoring) for the comparison.

## Risks

- **Low statistical power.** 26 forward weeks cannot prove an edge. They can catch an
  implementation slip or a clear deterioration. Treat a "pass" as permission to keep watching,
  not as proof.
- **The dev window flatters the comparator.** The frozen configs were selected on 2017–2026, so
  the base is in-sample. The filter is applied to the same base, so the *difference* is what
  counts, but interactions can still mislead. This is why the screen (Phase 2) does not depend
  on the configs.
- **Gates can starve the portfolio.** `entry="make_room"` and `min_ranked=1` mean a strict gate
  can leave fewer than the planned holdings, making a "lower drawdown" partly "more cash". Report
  average holdings and cash share next to every result.
- **R1 may block almost nothing.** Top-momentum names nearly always beat the index over 26 weeks;
  a near-null R1 is expected and is recorded as inconclusive, not tuned.
- **R1 is slightly biased against stocks.** Nifty 500 TRI includes dividends; the stock frame is
  split/bonus-adjusted prices only. The gap is about half the index's dividend yield over 26
  weeks. Accepted and recorded, no new data.
- **Turnover quirks.** Index-inclusion days, block/bulk deals, T2T/BE-series and circuit weeks
  distort turnover. The medians in V1/V2 damp them. Do not add exclusions after seeing results.
- **Live turnover can lag.** When the NSE sync fails, the newest week holds only Fyers top-up
  rows, which V1/V2 leave out. A shadow arm then uses one stale week of turnover; the journal
  entry notes it.
- **Trial creep.** The six trials are the whole budget. Anything else is a new dated experiment
  block that counts toward PBO.

## Open questions

Answered by the owner on 2026-10-08, when the item was started:

1. ~~Is a tilt weight of 0.25 acceptable as the one fixed setting?~~ **Yes, 0.25.**
2. ~~Should the Phase 4 shadow arm appear on the dashboard's Momentum journal view, or is the
   journal CLI enough?~~ **The CLI is enough.**
3. ~~If two features survive Phase 3, two shadow arms or one picked by the owner?~~ **Two arms,
   one per survivor.**
4. ~~(New, from the red-team) Where does a tilt act in the category funnel: pick level, slot
   level (like `stock_tilt`) or pool level?~~ **Pick level.**
5. ~~(New, from the red-team) Keep the draft's |t| ≥ 2 and PBO < 0.5, or tighten to BL-042/043's
   bar?~~ **Tighten:** Holm across the six with a momentum-decile-matched split at the screen;
   PBO ≤ 0.3 at the engine test; deflated Sharpe reported with the full trial count.

## Experiments

### 2026-10-08 — Six filters on the frozen Broad ensemble
- **Hypothesis:** at least one of V1, V2, R1, M1, M2, T1, applied the same way to all four
  frozen configs, raises the ensemble's after-cost CAGR robustly without worsening its drawdown.
- **Universe:** Broad Momentum, `turnover_rank` membership as known each January, tradability
  gate (₹2 cr, ₹30, floor 0.25, circuit run 3), circuit locks on (point-in-time source:
  `turnover_rank_members_by_year`, `bars_1d_stock`, `stock_weekly_series` for Nifty 500 TRI).
- **Look-ahead check:** per-feature prefix-invariance tests on raw daily bars cut at sampled
  Fridays with membership rebuilt; TRI matched by exact week; screen returns from the fill week;
  a guard refusing reads on or after 2024-01-01 before the one hold-out run.
- **Pass / kill rule:** `packages/momentum-backtesting/search_spaces/bl050_criteria.json`.
  - Screen: 13-week one-sided Newey-West test inside momentum deciles of the top quintile,
    Holm across 6 at α 0.05, minimum sample met.
  - Engine: median rolling ΔCAGR ≥ +2.0 pts, CAGR win share ≥ 70%, MaxDD ≤ 3 pts worse,
    PBO ≤ 0.3.
  - Hold-out: ΔCAGR ≥ 0 and MaxDD ≤ 3 pts worse, one run.
  - Forward: ≥ 26 weeks, shadow return ≥ ensemble, drawdown ≤ 3 pts worse, no extra live-rule
    breach.
  - Comparator: `bl010_phase6_frozen.json`, unchanged.
- **Hold-out:** data cut-off for development 2023-12-29; reserved period 2024-01-01 → 2026-09-25,
  one run.
- **Will not run:** see Phase 0.
- **Result:** (after the run)

## Log

- 2026-10-07 — Created from the owner's "five filters" idea. Repo check of all five families
  recorded in Context. Owner decisions: Broad only, fundamentals not required, forward shadow
  tracking as the deciding test. RS-momentum candidate withdrawn (it reduces to a lookback).
  Status `Planned`, P2.
- 2026-10-08 — Started (planning only; nothing run). Red-team of the Phase 0 draft before
  commit; changes made because of it:
  - M1's percentile uses that week's members only: copying `high_vol_mask` (a quantile over
    every column) would leak later years' members into earlier weeks. The prefix test now cuts
    raw bars and rebuilds membership so it can catch that.
  - Screen returns start at the fill week (t+1), matching `signal_delay=1`; otherwise M1 gets
    credit for one-week reversal the strategy cannot capture (3.9.23: delay 1 is worth ~+4 pts on
    Broad).
  - A 14-week embargo (fill week + 13 forward weeks) before 2024-01-01 and a read guard; "sealed" hold-out renamed "reserved",
    since the frozen configs and relatives of T1/M1 have been run over it.
  - Nifty 500 TRI matched by exact week (no carry-forward); its dividend bias against stocks
    in R1 recorded.
  - M2 pinned to the standard definition (residual sum ÷ residual standard deviation); without
    it the score mostly ranks idiosyncratic volatility.
  - V1 windows in sessions (20/130); Fyers top-up rows left out of turnover.
  - The screen's score pinned to config `1281e8ed6824` (the draft's "frozen voladj score" was
    ambiguous: the configs use three different scores).
  - The trial count is honest for PBO but not for the family: at least 39 earlier related trials on this
    base, recorded; deflated Sharpe uses N = 45.
  - Phase 1's "hash identical" check limited to the frozen data snapshot.
  - Phase 4 depends on BL-024 Phase 2 (journal scoring), not yet built.
  Owner answers: tilt weight 0.25; tilts at the pick level; the tighter statistical bar (Holm +
  matched split, PBO ≤ 0.3); two shadow arms if two survive, read from the CLI. Status
  `In progress`; TODO §3.23 added; `search_spaces/bl050_criteria.json` committed with this entry,
  before any run.
