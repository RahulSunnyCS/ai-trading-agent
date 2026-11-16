# BL-233 — Sell (or trim) a holding 70% above its 200-day EMA

| | |
|---|---|
| **Priority** | P2 — the owner asked (2026-11-16); an exit rule for the money-carrying Momentum groups |
| **Status** | In progress |
| **Type** | research |
| **Area** | momentum |
| **Created** | 2026-11-16 |
| **Depends on** | none |
| **TODO.md row** | — (research POC, no TODO row) |

## Context

The owner shared a selling rule (2026-11-16, from a post on X): when a stock's price is more than 70% above
its 200-day EMA, the rise is parabolic ("everyone and their neighbours are talking about it"); sell, or at
least book part of it, before it breaks. They asked to add it as an exit to the Momentum favourites: the
headline, the paper and the watched groups.

What is already known ([filters](../research/momentum/strategies/broad/filters.md),
[stop](../research/momentum/strategies/broad/stop.md)):
- BL-050's M1 (do not buy a name whose close / 10-week average is in the week's top 5 %) was killed the wrong
  way round: blocked names did better (mean t −2.41, 0 of 4 right sign).
- BL-084 / BL-085 stop-losses were killed: the rank exit already sells collapsing names; extra sells mostly sell
  a good name that is bought back.
- In liquid NSE stocks 2012–2026 a close more than 70 % above the 200-day EMA happens on about 1 % of
  stock-days, 467 names ever, bunched in 2014, 2021 and 2024 (counted 2026-11-16, unadjusted closes, no
  returns read).

None of these tested an exit on extension. This item does, on the favourites as they stand.

## Goal

For each of the 12 favourite groups, CAGR, worst fall and Ulcer index after tax with and without the exit,
and a keep / kill verdict for a full sell and for a half trim.

## Out of scope

Changing any favourite, the weekly signal, the orders or the dashboard. ETF and Stock datasets (no favourite
uses them). Other EMA lengths. A buy-side gate on its own.

## Plan

### Phase 0 — Pre-register
Committed before any run.

- **Hypothesis:** selling (or halving) a holding once its close is more than 70 % above its 200-day EMA
  makes the groups' worst falls shallower without costing CAGR, because such names fall back hard.
  The prior evidence (M1) points the other way: extended names kept rising.
- **Universe:** the 12 favourite groups in `GET /api/favorite-strategies` on 2026-11-16 (the snapshot is
  committed with the script as `search_spaces/bl233_favourites.json`): the headline "Four-Strategy Mix, BSE
  Tags" (invested), "Four Sectors Monthly, No Tilt · all Fridays" (invested), "Five Sectors, Rank Sum · all
  Fridays" (paper) and nine watched groups. Each group's sleeves are run with their saved configs unchanged
  (point-in-time `turnover_rank` universe, each config's own start, 2017-01-01, to the newest data) and
  combined at equal capital (mean of the sleeves' normalised curves), as BL-085 did.
- **The measure of extension:** for each stock, the split- and bonus-adjusted daily close (built from the
  daily moves, `categories/daily_moves.py`, the factors the weekly series uses) over its EMA with span 200
  (`ewm(span=200, adjust=False)`, at least 200 trading days of history, else no value and no action), minus 1,
  read on the last trading day on or before the week's signal Friday. Atomics (gold, silver, debt) have no
  daily stock bars and are never acted on.
- **Arms:**
  - **A** — as saved (no exit).
  - **B (tested)** — full sell: a holding whose extension is above 0.70 is sold whole that week, every week
    (not only on rebalance weeks).
  - **C (tested)** — half trim: half of the holding is sold the first week its extension is above 0.70; it is
    not trimmed again until its extension has gone back to 0.70 or below and crossed above again.
  - **D, E (description only)** — full sell at 0.50 and at 1.00.
  - In B–E a name above the threshold is not bought and not topped up that week (it keeps its slot, as a
    stock locked at the upper circuit does), so a sold name is not bought straight back. The money waits as
    cash until the next rebalance week, as the stop-loss's `cash` proceeds do.
- **Look-ahead check:** the EMA is causal (`adjust=False`), read at or before the signal Friday, and shifted
  by the config's `signal_delay` exactly as the ranks are; the sale fills at the engine's fill price for the
  week (the same as the BL-084 stop with `stop_delay` 0). A unit test checks the extension table computed on
  data cut at a date equals the full table up to that date.
- **Control:** with the setting off the engine is unchanged (the golden tests pass unchanged).
- **Measure:** after tax (`TaxRules()`), per group: CAGR, worst fall (max drawdown), Ulcer index, and the
  number of extension sells / trims; the same pre-tax as description. Also per half (2017-01 → 2021-12 and
  2022-01 → the end) CAGR.
- **Keep / kill (B and C each, after tax):** an arm **helps** only if, across the 12 groups,
  1. the median change in worst fall is at least +1.0 point (shallower) **and** the median change in CAGR is at
     least −0.3 points, **or** the median change in CAGR is at least +0.5 points with the median worst fall not
     more than 1.0 point deeper; **and**
  2. the headline group's CAGR changes by no less than −0.5 points; **and**
  3. in each half the median CAGR change is at least −0.5 points.
  Otherwise killed. Two arms are tested, so two tries; a pass on one is still read as a candidate for a
  forward shadow, not a live change.
- **Hold-out:** none. The favourites were chosen with every year in view and BL-085 used up FY2023–26. A
  pass is a reason to shadow the rule forward, not to adopt it.
- **Will not run:** other thresholds as tests, other EMA lengths, money to the next-ranked name instead of
  cash, ETF / Stock datasets, a buy gate alone. Each needs `override: <reason>` in the Log.

### Phase 1 — Build and run
- **Tasks:** `engine.Config.extension_exit` / `extension_action` and the weekly sell / trim step;
  `categories/extension.py` (the table); `run_broad_backtest(extension_exit=…)` and `api._run_broad`
  passing it through (research callers only; the API's requests never set it); unit tests;
  `scripts/bl233_extension_exit.py`.
- **Done when:** every group run in every arm; Result written; findings pages updated.

## Risks

- The trim and sell fill at the week's fill price. A parabolic stock can be locked at its upper circuit on the
  day; the circuit masks the favourites already use block nothing on the sell side for that.
- Twelve groups share many sleeves' picks, so they are not twelve independent tests.

## Log

- 2026-11-16 — created at the owner's request; Phase 0 committed before any run.
