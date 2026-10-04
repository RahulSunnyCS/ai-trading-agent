# CAGR-first search: three tiers (aggressive / midway / conservative)

Written 2026-10-04 (overnight), after Rounds 1-4 and the steady-highs re-score. Status: **plan**.
Nothing here has been run yet except where it says so.

## The idea in one paragraph

Until now the search protected the drawdown (Round 2 capped it, Round 5 added time-under-water).
This plan puts **CAGR first** and treats everything else (drawdown, time under water, churn) as a
*tier setting*: how much of each you tolerate. One wide search produces the runs; three selection
rules then pick one family of finalists per tier. Same data, same realism rules, three appetites.

## 1. The three tiers

Every tier ranks by **after-cost, after-tax CAGR** (see "tax" below), not pre-tax CAGR. A strategy
that turns over 6x a year looks 7-8 points better before tax than after it.

| | Highly aggressive | Midway | Conservative (still CAGR-first) |
|---|---|---|---|
| Rank by | after-tax CAGR | after-tax CAGR | after-tax CAGR |
| Max drawdown depth | -55% | -40% | -30% |
| Longest time below a high | not capped (reported) | <= 130 weeks | <= 104 weeks |
| Turnover (one-way, x/yr) | <= 8 | <= 4 | <= 2.5 |
| Min activity | >= 10 buys/yr | >= 10 | >= 10 |
| Realism (same for all) | Rs5cr gate, 1-week delay, 10 bps, circuit locks | same | same |

The numbers are starting points; the first screening run shows where the data actually bends, and
I would adjust them *before* looking at any validation result, not after.

## 2. What is different from Rounds 1-5

1. **Wider, more concentrated space.** Round 2 narrowed to a plateau around 4-9 categories. An
   aggressive search must reach the corner Round 2 never sampled: 1-4 categories, 1-2 picks (2-8
   stocks), no position cap or a 0.5 cap, `coverage_floor` 0.0-0.15, shorter lookbacks
   (`[4,13,26]`, `[1,4,13]`), weekly rebalance, `entry=make_room`.
2. **Other universes.** Arms B (no category layer), C1 and C2 (the ~4,000-stock all-liquid
   universe) were never searched. More small caps means more CAGR potential *and* more illiquidity
   risk, so the liquidity gate stays fixed.
3. **Levers that exist in the code but were never searched:** `stock_tilt` (re-orders the picks by a
   short-vs-long-lookback blend), the 52-week-low mask, `max_stock_price` removed.
4. **Ranking on after-tax CAGR** (tax wiring added in Round 4).

## 3. Before ANY run: the checklist

Most wasted overnight runs were avoidable. Check these first.

1. **How much money will run this?** It decides which stocks are tradeable. A Rs10 lakh account can
   trade stocks a Rs5 crore account cannot. The Rs5cr/day gate is my default; if the real size is
   much larger, tighten it; if much smaller, a Rs2cr gate is defensible. *I need your number.*
2. **Which return counts?** After-cost and after-tax, or pre-tax? Tax is ~7-8 points a year at
   current turnover (almost every sale is short-term, STCG 20%). Decide before looking.
3. **What is fixed, what is searched?** Write both down. Anything left to chance (a default
   nobody chose) becomes a hidden parameter. Round 1's `momentum_sizing` default cost a day.
4. **Realism is never a search dimension.** A search allowed to loosen the liquidity gate, the
   delay or the slippage drifts to the setting that flatters it. Fix them; test sensitivity
   *afterwards* (the bias checks do this).
5. **Hold-out design.** All data to Oct-2026 has now been looked at, so there is no clean
   hold-out left. Use time blocks (2017-19 / 2020-22 / 2023-26: every block must hold up),
   a placebo, the nudge test, and **forward paper tracking** as the real test. State this up front.
6. **Statistical power.** ~509 weeks, one big crash, one bull run. 20,000+ trials already.
   Deflated Sharpe with the true trial count; treat a 0.7 as "suggestive", not "proven".
7. **Reproduce first.** Any config must reproduce through the dashboard path to 3 decimals before
   it is saved (this caught the `Load settings` UI bug).
8. **Known traps:** `momentum_sizing` can lock in cash; start-date / rebalance-day luck (up to
   8.6 points); profit concentrated in 3-5 stocks (check top-5 share); signal delay 0 is
   optimistic; stocks that gap through circuit limits.
9. **Compute budget.** This laptop has 8 GB; ~1 GB per worker (1.5 GB for the 4,000-stock
   universe). Runs slow ~2x when memory is tight. Plan 2.5 h per 12,000-run arm.
10. **Write the criteria down before running** (`round*_criteria.json`), including what result
    would mean "it did not work".

## 4. How to run it

| Stage | What | Runs | Time |
|---|---|---|---|
| 0 | Fix inputs: capital size, return definition, tier thresholds; write criteria file | - | 10 min |
| 1 | Wide screening, **arm A expanded space** (Sobol, 100 ranking combos x 120 light) | ~12,000 | ~2.5 h |
| 1b | Same space on arm B and on C1 (fewer ranking builds, 56 s each on C) | ~6,000 each | ~2-3 h each |
| 2 | Pick the best arm per tier from the results; one focused round per tier around its plateau | ~4,000 per tier | ~1 h per tier |
| 3 | Nudge test (neighbours, other rebalance days, later starts), tier-specific pass rules | ~40 cands x 21 | ~20 min per tier |
| 4 | Validation: time blocks, placebo, after-tax, strict gate, deflated Sharpe | ~10 finalists per tier | ~10 min per tier |
| 5 | Save Winners/Finalists as favourites (never Telegram-active); forward-track 3-6 months | - | - |

Total roughly 8-12 hours of machine time and a few hours of my work, run over 1-2 nights.

## 5. Ideas to push CAGR (ordered by how much I expect them to matter)

1. **Lower `coverage_floor` further and combine with concentration.** The strongest single lever
   so far (0.10-0.20 gave ~25% vs 11% at 0.5+). Test 0.0-0.10 with 2-6 stocks.
2. **Concentrate.** Fewer holdings raises variance and CAGR. Check profit concentration so one
   stock does not make the result.
3. **Wider universe (C1/C2).** More small caps; the strict-gate check tells us how much is real.
4. **Faster signals.** Weekly rebalance with `[4,13,26]`/`[1,4,13]` and `entry=make_room`. Round 1
   hinted the 1-week lookback hurt; test it in the concentrated corner before dismissing it.
5. **`stock_tilt`** (short-vs-long blend among already-selected picks).
6. **Execution:** Monday-open fills instead of Friday close (engine supports `execution`); only if
   it is realistic for how you will trade.
7. **After-tax tuning:** longer holds cut tax (LTCG 12.5% after a year) but also cut CAGR;
   `tax_hold_band` in the engine trades one for the other. Worth one dimension.
8. **Tranches** (staggered portfolios) to remove rebalance-day luck. Reduces dispersion, not CAGR.
9. **Overlays only if they raise CAGR** (vol targeting reduces drawdown, usually at a cost).
10. **Leverage / derivatives are out of scope** for this engine; mention only as an idea.

## 6. What I need from you

1. Capital size to be run (sets the liquidity gate).
2. After-tax or pre-tax CAGR as the ranking metric.
3. Tier thresholds above: OK, or change?
4. Run arm A only first, or A + B + C1?

## 7. Later (owner's idea, 2026-10-04): can we see a drawdown starting and ending?

Not for now; parked until the work above is done. A first sketch so it is not lost:

- **What exists already.** We now hold the weekly equity curve of ~3,000 candidates over the full
  period (`data/search/round2_A/round5/`), so drawdown episodes (peak -> trough -> new high) can be
  extracted for every one of them. `levers.py` already has two crude timing overlays
  (`vol_target`, `dispersion_timing`) and the mass-exit trigger (`categories/broad.py`) is a first
  "many holdings fell out of the ranks at once" signal.
- **Candidate signals to test (all computed point-in-time, weekly):**
  breadth (share of ranked stocks above their own 26-week average, share of holdings with a
  negative 13-week return), cross-sectional dispersion of returns, how fast holdings are leaving
  the top ranks (rank churn), the index's own drawdown and volatility, the gap between the
  strategy's held stocks and the broad pool, and the strategy's own recent win rate.
- **Two separate questions:** (a) *start* - do these signals move before the equity curve turns
  down? (b) *end* - do they flip back before the curve makes its next high? Judge each by lead time
  and false alarms, not just correlation.
- **Hard parts / honesty rules.** Only ~10 years and a handful of real episodes (2018, 2020, 2022,
  2024-25), so any rule is easy to overfit; use walk-forward (fit on earlier episodes, test on
  later ones), no look-ahead (signal known by Friday close, acted on a week later), and count
  every rule tried toward the trial count. Previous evidence is mixed: the win-rate sizing lever
  (`momentum_sizing`) was rejected and can deadlock in cash, so a timing rule must not be able to
  switch the strategy off permanently.
- **Output if it works:** a rule that cuts time under water without cutting CAGR much, tested as
  an overlay on the finalists; if it does not work on out-of-sequence episodes we say so.
