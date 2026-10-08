# BL-050 — Momentum filter POC: volume, relative strength, overextension, residual momentum, trend quality (Broad only)

| | |
|---|---|
| **Priority** | P1 — set by the owner (2026-10-08); research only, so nothing live is at risk |
| **Status** | Planned |
| **Type** | research |
| **Area** | momentum |
| **Created** | 2026-10-07 |
| **Depends on** | BL-015 (pre-registration); BL-010 Phase 6 (the frozen ensemble is the comparator); BL-024 (the journal carries the Phase 4 shadow arm); BL-001 (goldens prove the default output is unchanged) |
| **TODO.md row** | — (filled in when started) |
| **Handoff** | [`docs/handover-bl050-filter-poc.md`](../docs/handover-bl050-filter-poc.md): paste-ready planning and working prompts, and which steps need the laptop |

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
  been used (the backcast failed against Midcap 150 TRI). BL-042's sealed 2024-01-01 → 2026-09-25
  window is still unread for pattern work. But the frozen configs were chosen with data through
  2026-10, so for them it is in-sample. The backtests here can only **rank** candidates. The
  deciding test is forward shadow tracking (Phase 4).

**Owner decisions (2026-10-07):**
- **Broad (stocks) only.** No ETF track. Volume and daily highs/lows exist only for stocks
  (`bars_1d_stock`); index and ETF series hold open/close only.
- **Fundamentals are not required now.** They are out of scope; no data spike.
- **Forward shadow tracking is the deciding test**, as recommended, because no clean backtest
  window remains.

**What this item can reuse:**
- `levers.py` features and masks.
- `run_broad_backtest(extra_no_buy=…)` for gates (blocks fresh buys only, never forces a sale).
- The BL-042 event-study and ranking-test pattern (`patterns/`).
- The PIT `turnover_rank` universe (`liquidity.turnover_rank_members_by_year`).
- `reference_benchmarks.NIFTY500_TRI`.
- The 3.9.23 yardstick (full-period CAGR / Sharpe / MaxDD plus rolling 3-year window win shares).

**What is missing:** a general rank-tilt hook on Broad. `stock_tilt_ranks` exists, but it is tied
to `stock_tilt`, and two of the four frozen configs already use that (1.0 and 0.5).

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

- **Hypothesis:** at least one of the six features below, applied the same way to all four frozen
  configs, raises the ensemble's after-cost CAGR robustly, without worsening its drawdown.
- **Universe:** Broad Momentum on the point-in-time `turnover_rank` universe, curated category
  tags, frozen liquidity gate (₹2 cr / ₹30 / 0.25, circuit gate on). Delisted names stay in their
  historical years.
- **Comparator:** the BL-010 Phase 6 ensemble exactly as frozen
  (`search_spaces/bl010_phase6_frozen.json`: four configs, equal capital reset each April,
  `signal_delay=1`, itemised costs + 15 bps slippage).
- **The six trials** (one shape, one setting each, fixed here; feature tilts use
  `rank = 0.75 × momentum rank + 0.25 × feature rank`):

  | ID | Family | Feature (weekly, point-in-time) | Shape | Pre-registered direction |
  |---|---|---|---|---|
  | V1 | Volume | Median daily **turnover (₹)** over the last 4 weeks ÷ median over 26 weeks. Turnover, not share volume: it is not distorted by splits and bonuses | Tilt | Higher is better |
  | V2 | Volume | Up-week turnover ÷ down-week turnover over 13 weeks (accumulation; the `reversal.py` definition) | Tilt | Higher is better |
  | R1 | Relative strength | 26-week return must beat Nifty 500 TRI's 26-week return | Gate (no new buy if it fails) | Names that fail are worse |
  | M1 | Momentum | Overextension: close ÷ 10-week average in the top 5% of that week's universe | Gate (no new buy if overextended) | Overextended names are worse |
  | M2 | Momentum | Residual momentum: 26-week sum of residuals from a trailing 52-week regression of weekly returns on Nifty 500 TRI, skipping the last 4 weeks | Tilt | Higher is better |
  | T1 | Trend quality | Annualised slope of log weekly close over 26 weeks × R² of that fit | Tilt | Higher is better |

- **Look-ahead check:**
  - Every feature uses data up to the decision Friday's close only; `signal_delay=1` stays.
  - A prefix-invariance test: for sampled weeks, the feature computed on data cut at that week
    equals the feature computed on full data.
  - Cross-sectional percentiles (M1) use only that week's PIT universe.
  - Regressions (M2, T1) use trailing windows only.
- **Development window:** 2012-01-01 → 2023-12-31 (the stock layer, PIT universe and Nifty 500
  TRI all exist from 2011, so 52-week lookbacks are warm by 2012). 2012–16 was read once by the
  BL-010 backcast. That read does not bias a comparison of filter against no filter.
- **Pass / kill rules:**
  - **Phase 2 screen:** run once per frozen config, each on its **own** score definition
    (score, lookbacks, weight scheme), its own cadence (2 or 4 weeks) and its own rebalance
    offset, exactly as in `bl010_phase6_frozen.json`. No config or calendar is chosen by hand.
    For each config, compute the 13-week forward-return spread within the top quintile of that
    config's score, net of a 0.3% round trip, with a Newey-West t-statistic. A feature passes
    only if the mean of the four t-statistics is ≥ 2 in the pre-registered direction **and** at
    least 3 of the 4 configs have the right sign. Otherwise it is killed.
  - **Phase 3 engine test:** against the comparator on the dev window, all of:
    - median ΔCAGR ≥ +2.0 pts across rolling 3-year windows stepped quarterly;
    - CAGR win share ≥ 70%;
    - full-period MaxDD no more than 3 pts worse;
    - PBO < 0.5 across all six trials plus the baseline (CSCV). Every trial's ensemble curve is
      built for the PBO matrix, including features killed in Phase 2. A killed feature cannot
      pass; its curve only keeps the trial count honest.
- **Hold-out:** 2024-01-01 → 2026-09-25 stays sealed for **one** confirmation run of Phase 3
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
  - A second setting or weight for any feature.
  - Combinations of survivors.

### Phase 1 — Features and hooks (no change to any default output)

- **Tasks:**
  - Add the six features as pure functions next to `levers.py`. Use turnover from
    `bars_1d_stock` (weekly median of daily) and `reference_benchmarks.NIFTY500_TRI`.
  - Add a general rank-tilt hook to `run_broad_backtest` that is independent of `stock_tilt`,
    off by default.
  - Add prefix-invariance tests per feature.
  - Add a test that with the hook off, the four frozen configs reproduce their frozen curves
    (`scored_curves_sha256`) and BL-001 goldens pass unchanged.
- **Deliverables:** feature module, hook, tests.
- **Done when:** the tests pass, the frozen ensemble's curves hash identically, and
  `update-goldens.py` reports no change.

### Phase 2 — Cheap screen (event study, the BL-042 pattern)

- **Tasks:**
  - For each of the four frozen configs, at each of its own rebalance dates in the dev window
    (its cadence and offset), take the top quintile of the universe by that config's own score.
  - For tilts, split those names by feature (top half vs bottom half). For gates, split them
    into blocked vs passed.
  - Measure forward 4- and 13-week returns net of costs and the Newey-West t-statistic.
  - Also report how many names each gate blocks per week. A gate that blocks almost nothing or
    almost everything is noted, not tuned.
- **Deliverables:** `search_spaces/bl050_screen_result.json`, a short table in this file.
- **Done when:** every feature has a recorded pass or kill under the Phase 0 rule (four per-config
  t-statistics, their mean and the sign count). Killed features get no verdict work after this;
  Phase 3 builds their curves only for PBO.

### Phase 3 — Engine test on the frozen ensemble

- **Tasks:**
  - Run **all six** features through all four frozen configs: gates via `extra_no_buy`, tilts
    via the Phase 1 hook. Build each ensemble with `choose.ensemble_curve`.
  - Compute CSCV/PBO over the six ensemble curves plus the baseline.
  - Score Phase 2 survivors only with the 3.9.23 yardstick, and give each a pass/kill verdict.
  - Run the single confirmation on the sealed 2024–26 window for survivors only.
- **Deliverables:** `search_spaces/bl050_dev_result.json`, `bl050_holdout_result.json`, a
  results table and verdict per feature.
- **Done when:** every surviving feature has a pass/kill verdict on both windows, and the
  hold-out run count is 1 (or 0 if nothing survived).

### Phase 4 — Forward shadow arm (the deciding test)

- **Tasks:**
  - Make each Phase 3 survivor saveable as a favourite config: the frozen ensemble plus the
    filter.
  - Record it weekly in the forward journal (BL-024) next to the frozen ensemble, from the next
    Friday, without changing either.
  - Show both side by side.
  - After ≥ 26 weeks, compare the two:
    - shadow return ≥ ensemble return;
    - drawdown no more than 3 pts worse;
    - no live-rule breach that the ensemble did not also hit.
- **Deliverables:** the shadow favourite, its journal entries, a dated verdict in the Log.
- **Done when:** 26 recorded weeks and a verdict. Adoption is a separate owner decision under
  BL-025 (paper first, then money), never automatic.

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
- **Turnover quirks.** Index-inclusion days, block/bulk deals, T2T/BE-series and circuit weeks
  distort turnover. The medians in V1/V2 damp them. Do not add exclusions after seeing results.
- **Trial creep.** The six trials are the whole budget. Anything else is a new dated experiment
  block that counts toward PBO.

## Open questions

To confirm when this is started:

1. Is a tilt weight of 0.25 acceptable as the one fixed setting, or should the owner fix a
   different one before Phase 0 is committed?
2. Should the Phase 4 shadow arm appear on the dashboard's Momentum journal view, or is the
   journal CLI (`mbt journal show`) enough?
3. If two features survive Phase 3, should the shadow phase run both separately (two shadow
   arms), or should the owner pick one?

## Log

- 2026-10-07 — Created from the owner's "five filters" idea. Repo check of all five families
  recorded in Context. Owner decisions: Broad only, fundamentals not required, forward shadow
  tracking as the deciding test. RS-momentum candidate withdrawn (it reduces to a lookback).
  Status `Planned`, P2.
- 2026-10-08 — Re-prioritised P2 → P1 by the owner. Handoff prompts added in
  `docs/handover-bl050-filter-poc.md`.
- 2026-10-08 — Review fixes, before any run (PR #129, Codex). The Phase 2 screen is now
  pre-registered per frozen config, on each config's own score and calendar, with a fixed rule
  for combining the four. Phase 3 builds all six curves for PBO, and only survivors get verdicts.
