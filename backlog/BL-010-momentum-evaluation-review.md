# BL-010 — Momentum evaluation review: prove the arithmetic, remove hindsight, fix selection

| | |
|---|---|
| **Priority** | P0 — the 55–63% CAGR headline, the saved favourites and the weekly signal all rest on an evaluation with known leaks and engine bugs |
| **Status** | In progress (Phase 0 done; Phase 1 engine fixes in review) |
| **Type** | research (+ bug fixes in the engine) |
| **Area** | momentum (+ trading-data for corporate-action matching) |
| **Created** | 2026-10-05 |
| **Depends on** | Interlocks with **BL-001** (see "Order against BL-001"); BL-005 Phase 3 (engine rewrite) should wait until Phase 1 here is done |
| **TODO.md row** | 3.13 |

## Context

Round 7 of the weekly NSE stock-momentum search (arm A, corrected price series) reports best
pre-tax CAGRs of 55–63%. The owner asked for (1) a way to prove the numbers trade by trade,
(2) a better definition of "good strategy", including top configs over separate time windows,
and (3) a critical review of the evaluation pipeline. A review session on 2026-10-04 read the
code and ran read-only queries on `data/search/*` and the catalog; this item is that review,
tightened on 2026-10-05 (see "Changes made when finalising").

**Verdict so far.** The arithmetic may well be right, but 55–63% is not a believable *expected*
return yet. Two point-in-time leaks inflate it (today's index list used as the universe for
every year; a category taxonomy built from 2026 themes), and the search's own results show that
picking "the best" config does not persist out of sample.

### Findings (ranked by how much each changes the headline)

| # | Finding | Evidence | Severity |
|---|---|---|---|
| F1 | **Arms A and B: the universe is today's list for every year.** | `category_membership` and `total_market_membership.csv` hold 755 symbols with `source_tier=constant_current` for every year 2016–2026. 371 of the 755 have no prices before 2016, so the 2017 universe is about 380 names, all survivors into today's index. 78 are renames whose earlier history is invisible. | Must fix |
| F2 | **The category taxonomy is hindsight.** | 113 subgroups were written on 2026-09-29 from *current* Nifty thematic indices and StockScans themes (Defence, EMS, Data Centres, Railways, Solar, PSU …). Tags carry no dates. Median H1: A 25.1% vs B 31.4%; median H2: A 39.9% vs B 25.8%. | Must fix |
| F3 | **C1 also has survivorship through tagging.** | With categories on, only tagged stocks can be picked. Of 176 liquid names that stopped trading before 2026, 0 have curated tags and 77 have curated+wide tags, against 1,503 of 1,524 for names still trading. C2 (no categories) is the only clean arm. | Must fix |
| F4 | **Picking the best config does not persist.** | Arm A, 8,003 configs: rank correlation between H1 CAGR (2017→~Nov 2021) and H2 CAGR is −0.08. The top decile by H1 lands at median H2 percentile 0.48. Arm B: +0.53. | Must fix (the selection rule) |
| F5 | **Concentration × argmax = winner's curse.** | Median CAGR is flat at ~32% from 2 up to 24 holdings; the max rises from 51% (12–24 holdings) to 73% (≤2). | Must fix (how finalists are chosen) |
| F6 | **The rebalance phase is searched.** | `rebalance_offset_raw` is a light dimension in every round7 space, so winners choose their lucky Friday. Never averaged out, though `tranches.py` exists. | Must fix |
| F7 | **Placebo is not a fair null.** | Ranks are reshuffled weekly, so placebo turnover is 6–34x against 1–3x real — up to ~15 pts/yr of extra cost. Only 3–5 seeds, mean only. | Must fix |
| F8 | **DSR tests the wrong null and uses the wrong N.** | It tests Sharpe > 0 against cash; 70% of all round7_A trials would pass. N is typed by hand (20,866/22,000) against ~44.6k logged runs plus nudges and rescores. | Must fix (or demote) |
| F9 | **Price-series integrity outside the 755 is unreviewed.** | 2,096 drops ≥20% still in `review` (159 are ≥45% since 2016). Splits missed across renames (MCDOWELL-N 1:5 filed under UNITDSPR; MINDAIND bonus under UNOMINDA). Bonuses of 1:4 or smaller never adjusted. One-day rises >25% with no exchange adjustment: 156 in 2015, 169 in 2016, 45–98 a year in 2017–20. | Must fix for C1/C2 |
| F10 | **Validation checks are circular.** | Steady's Winner test requires blocks that were already selection filters; the Round 4 "hold-out" (2023+) was the hottest small/mid momentum run in the sample. | Must fix (how validation is read) |
| F11 | **Live preview ≠ backtest.** | `rebalance.py` builds membership with the *legacy* series rule even when the ranking uses verified; legacy is still the default in `prices.py`, `broad.py`, `api.py` and the `bias.py` fallback. | Must fix — affects the weekly signal **today** |
| F12 | **Reproducibility gaps.** | Tier rules live only in `round7_criteria.json` (no code applies them). The run id has no data snapshot or end date. Round 7 re-used Round 6's exact 8,000 points (seed 1). | Must fix |
| F13 | **The nudge test doesn't cover Round 7 winners.** | `robust.py` tables are hard-coded for Round 2; many dimensions never nudged; arms B and C2 crash with a KeyError. | Must fix before Phase 5 |
| F14 | Circuit-lock mask uses the full lock length including days after the trade date (`circuit_exposure.py:67-94`). Windows count rows, not sessions. Fyers top-up rows set prevclose = open. | Small, both directions | Nice to have |
| F15 | The engine is value-based (no share counts). At ~60% CAGR, ₹2L becomes ₹1–2cr, so late positions are 25–100% of a ₹2cr/day median turnover at a flat 15 bps. | Only matters if capital grows | Nice to have |
| F16 | Conservative biases: no dividends in broad prices (~1%/yr vs TRI benchmarks), today's tax rates applied from 2017, delisted names exit at last close. | Make the real result *better* | Nice to have |

### Engine bugs (reproduced on synthetic inputs by the review session)

What is right: with `signal_delay=1` (Round 5–7 spaces) timing is correct — every ranking input
at row t uses data up to close t, the rank table is shifted together, fills happen at t+1's
close, and CAGR / drawdown / cost formulas compute correctly.

| # | Bug | Where | Direction |
|---|---|---|---|
| E1 | **Liquidity gate lets a failing week pass.** Only passing rows are pivoted, so a failing week is NaN and `ffill(limit=1)` fills it with the previous True. Every gate exit happens a week late. | `categories/liquidity.py:236` | Optimistic |
| E2 | **A stock locked at the upper circuit can still be topped up** (`n in held or not blocked(n)`). | `engine.py:548` | Optimistic |
| E3 | **A stock in two held categories gets the later category's (worse) rank** — `ranks.at[w,name]` is overwritten. 65 symbols sit in two categories. | `categories/broad.py:960` | Distorts picks |
| E4 | **A post-break `SYM#2` column is never pickable in category mode** (SIEMENS, VEDL, NMDC, TATACHEM; ADANIENT since Sep 2018). | `broad.py:909` | Pessimistic |
| E5 | **Parked cash pays equity costs** — ~0.5% per park/un-park round trip. | `engine.py:1131,1200` | Pessimistic |
| E6 | **`mass_exit_weeks` is not shifted by `signal_delay`.** | `engine.py:720-727` | Look-ahead when the throttle is on |
| E7 | **Turnover has two definitions.** Search counts new BUYs only over mean equity; the dashboard counts SELL+TRIM. Tier turnover caps run on the understated one. | `search.py:308-310`, `analysis.py:110` | Understates the cap |
| E8 | **The trade log can't be reconciled** — no share counts, fill prices or cost amounts; the API `trades` list holds sells only, gross of costs/tax, on a ₹1L basis. | `engine.py:573-586`, `analysis.py:12,54` | Blocks auditing |
| E9 | **API / CLI / search defaults differ** — API: `signal_delay=0`, legacy series, circuits off; CLI `categories broad-backtest` doesn't pass `min_ranked`. | `api.py:456,550,571`, `cli.py:1559-1582` | Mismatch risk |

Spot-checked on 2026-10-05 against the working tree: E1, E2 and E3 read exactly as described.
The other findings and every number above are taken from the review session and are **not
independently re-verified** — Phase 0 records the queries that reproduce them.

### Changes made when finalising (2026-10-05)

1. **Live-signal parity moved from last to first.** F11/E9 affect the Friday signal the owner
   already receives; it should not wait behind weeks of research.
2. **Order against BL-001 made explicit** — otherwise the goldens freeze E1–E7 and every fix
   becomes an "accept changed result".
3. **The 2012–2016 backcast moved after the final choice and made one-shot.** The original ran
   it in the robustness phase *before* choosing a config, which would turn the only clean
   hold-out into another selection input.
4. **Pass/kill thresholds are committed before any run** (Phase 0) and cannot be edited after
   results are seen, only superseded with a logged reason.
5. **Gates are judged after cost and after tax**, with pre-tax shown alongside — the question
   that matters was already stated post-tax, but the phases reported pre-tax.
6. **The ledger replay takes fill prices from the raw lake, not from the trade log**, and
   compares the two — a replay that trusts the log's prices only proves the bookkeeping.
7. **Weekly returns are stored for every config in a search**, not only tier-passers + 500.
   It is small (≈8,000 × 500 weeks) and makes the walk-forward of the selection rule and PBO
   computable from stored data instead of re-running searches per year.
8. **Engine-fix impact is measured two ways** — each fix alone from the baseline, and all
   together — because the effects are not additive.
9. **A freeze** on new search rounds and on promoting favourites until Phase 3 passes; round 7
   C1/C2 (running on 2026-10-04) finish but are read as pre-fix results.
10. Effort figures are the review session's estimates and look optimistic; treat them as a
    lower bound.

## Goal

- Every rupee of a backtest's P&L reconciles to an independent replay from raw exchange prices.
- The headline is re-measured with a point-in-time universe, a taxonomy free of hindsight and
  reviewed price series, and the CAGR lost at each step is reported.
- A config is chosen by a rule that survives walk-forward — or the review concludes, in
  writing, that no config beats the index alternative.
- The live weekly signal provably equals the backtest's trade list for the same weeks.

The deciding question: **after the fixes, after cost and tax, what is the highest CAGR each
basket can reach inside its drawdown limit — and does it still clear the benchmark by a clear
margin?** (Minimum bar: Nifty200 Momentum 30 TRI + 5 pts after tax.)

### Owner's objective and baskets (2026-10-05)

Highest CAGR after cost and tax, within an acceptable drawdown, in three baskets. A drawdown
passes a basket if it meets **either** the fixed limit **or** the relative limit, and is never
deeper than the hard ceiling:

| Basket | Fixed limit | Or, relative to the index over the same period | Hard ceiling |
|---|---|---|---|
| Conservative | 25% | no worse than the Midcap 150's fall | 40% |
| Medium | 30% | no worse than the Smallcap 250's fall | 40% |
| Aggressive | 35% | up to 1.2× the Smallcap 250's fall | 40% |

"Same period": for each strategy drawdown (peak to trough), the index's largest fall inside
that window. These replace round 7's tiers (−30% / −40% / −55%) and are committed in
`packages/momentum-backtesting/search_spaces/bl010_criteria.json`.

### Portfolio view (owner, 2026-10-05)

The strategy is a 10–20% slice (about ₹5 lakh) of a ~₹25 lakh portfolio that is otherwise mostly
Indian small and mid caps, with 10–20% in US gold/silver miners and ~20% in gold; the owner is
deliberately taking high risk for about two years. So every phase that reports results also reports:

- each drawdown as a share of the slice **and** of the whole portfolio (at 10%, 15%, 20%);
- behaviour in the weeks the Smallcap 250 / Midcap 150 fall most (the slice overlaps the rest
  of the portfolio, so it is not a diversifier);
- recovery time for each major fall, and a resampled 95th-percentile drawdown;
- every rolling two-year window since 2017 — worst, median, best — after cost and tax;
- comparators: Nifty200 Momentum 30, Smallcap 250, Midcap 150, Midcap150 Momentum 50 (all TRI);
- how often a sale was blocked by a lower circuit, and what it cost;
- realism checks at **₹5 lakh** (not ₹2 lakh).

### Model per phase (owner, 2026-10-05)

A session cannot change its own model, so the split is done with helper agents.

| Phase | Model |
|---|---|
| 0 | Sonnet helper (done inline on Fable — it was a few file edits) |
| 1–4: engine fixes, replay, hindsight fixes, evaluation method | Fable, main session |
| 5: robustness windows and runs | Sonnet helper; the choice rule checked on Fable |
| 6: hold-out run and paper tracking | Sonnet helper |

## Out of scope

- Speeding up the engine (BL-005) and the regression goldens themselves (BL-001).
- New strategy ideas or new search dimensions — nothing new is searched until Phase 3 passes.
- ETF and Nifty-50 stock modes, except where an engine fix also changes them.

## Order against BL-001

1. Phase 1 here, **engine fixes only** (E1–E7, E9 defaults) — each with its own test.
2. BL-001 Phases 1–2 — goldens taken from the fixed engine. BL-001's truncation look-ahead test
   is the same test as Phase 2 step 4 here: build it once, in BL-001's harness, and run it here
   on the full data.
3. The rest of this item, with every later engine or data change passing through BL-001's
   accept-with-reason step.

If the owner prefers BL-001 first, each E-fix is accepted into the goldens with a logged reason
instead; more ceremony, same end state.

## Plan

### Phase 0 — Freeze and pre-register
- **Tasks:** mark every saved favourite "Candidate — unvalidated"; no new search rounds; commit
  a `criteria` file holding every pass/kill threshold below, before any run; save the review's
  reproducing queries as an appendix (`packages/momentum-backtesting/docs/evaluation-review.md`,
  pointing back here — the plan itself lives only in this file).
- **Done when:** thresholds are committed with a hash, and the appendix reproduces F1–F13's numbers.

### Phase 1 — Engine fixes and live-signal parity
- **Tasks:** fix E1–E7, each with a failing-then-passing unit test; add `units`, `fill_price`,
  `cost_rs`, `prev_units` to the trade record (E8); one series-break policy everywhere, `legacy`
  removed as a default (F11); API, CLI and search defaults made identical — delay 1, verified
  series, circuits on, `min_ranked=1`, ₹2L (E9); a test that the live preview's holdings for
  week t equal the backtest's; shadow check over the last 12 weeks. Re-run the three tier
  winners and three median configs: report each fix alone and all together.
- **Deliverables:** fixes + tests, an impact table, the parity test.
- **Done when:** the last 12 weeks of live signals equal the backtest's trade list, and the
  impact table is written.

### Phase 2 — Prove the arithmetic
1. **Independent ledger replay** — a separate script sharing no code with `engine.py`. Inputs:
   the trade log's dates, symbols and directions only; raw closes from `bars_1d_stock`
   (`NOT synthetic_close`) adjusted by `stock_action_candidates.confirmed_factor`. It derives
   fill prices itself, compares them with the log's `fill_price`, rebuilds share counts, costs
   and the weekly equity curve.
   *Pass:* fill prices within 0.05%, weekly equity within 0.1%, CAGR within 0.1 pt, max DD
   within 0.2 pt. *Fail:* name the first diverging week and symbol; stop everything else.
2. **Ten trades checked by hand against an outside source** (NSE, Screener, TradingView): top 5
   contributors by rupee P&L, 2 holdings spanning a corporate action, 1 sale blocked by a lower
   circuit, 2 random. *Pass:* all ten within 0.5%.
3. **Unexplained-jump scan** over every holding period: any day with |close/prev − 1| > 20%
   where bhavcopy `prevclose` ≈ prior close. Recompute CAGR with those days zeroed.
   *Kill:* a top-20 contributor has a flagged day, or CAGR moves more than 2 pts.
4. **Look-ahead truncation test** on the full data at three cut dates (harness from BL-001).
   *Kill:* any difference before the cut date.
5. **Contribution profile** — P&L by stock, calendar year, financial year, category.
   *Flag:* top-5 stocks > 50% of total log return, or one year > 40%.
6. **Realism at ₹2L** — integer shares, price cap, participation (position ÷ 60-day median
   turnover) per fill. *Flag:* any fill above 5%; report CAGR at a 1% participation cap.
- **Done when:** steps 1–4 pass on the 3 tier winners and 3 median configs.

### Phase 3 — Remove the point-in-time leaks, then re-measure
1. **PIT universe, both ways** (owner's choice): (a) a turnover-rank proxy for Total Market —
   each quarter the top ~750 EQ stocks by trailing 6-month median traded value, delisted names
   included, keyed by ISIN (fixes the 78 renames and 220 multi-symbol ISINs); (b) **C2** (all
   liquid, no categories) as the honest reference arm.
2. **Data fixes before re-running C1/C2** (F9): match corporate-action filings by ISIN; use the
   exchange's own `prevclose` jump as a second split/bonus detector; triage the 159 drops ≥45%
   and every rise >25%. Extend the same review to 2011–2016 so Phase 6's backcast has clean data.
3. **Category hindsight tests:** a launch-dated taxonomy (a theme is selectable only after its
   index was public; cruder variant: long-standing NSE sectors only); a label-shuffle placebo
   (100 permutations keeping sizes and multi-membership counts).
4. **Re-run the tier winners + 50 near-winners on each variant**; report the CAGR lost at each
   step: engine fixes → universe → taxonomy → data fixes.
   *Kill (arm A as a headline):* the PIT re-run loses more than 10 pts, or falls below Mom30 TRI
   + 5 pts. *Kill (the category layer):* real categories fail to beat the shuffle's 95th
   percentile, or A − B ≤ 2 pts under the launch-dated taxonomy.
- **Done when:** the step-by-step loss table exists and both kill tests are decided.

### Phase 4 — Fix the evaluation machinery (before any new search)
1. **Average out the rebalance phase** — drop `rebalance_offset_raw` from every space; score a
   config as the mean of its offset tranches. *Kill (per finalist):* tranche-averaged CAGR more
   than 3 pts below the reported one.
2. **A fair placebo** — persistent random scores matched for rank autocorrelation and turnover,
   100 seeds, judged by percentile. *Pass:* beats the placebo's 95th percentile by ≥5 pts.
3. **Store weekly returns for every config**; make **CSCV/PBO** the gate on excess over Mom30
   TRI (S=16 blocks), reporting PBO, the OOS-vs-IS slope and P(OOS excess < 0). DSR becomes a
   footnote on excess returns with N = all logged runs.
   *Kill:* PBO > 0.3 → stop selecting a single winner; use Phase 5's cluster rule.
4. **Tiers, criteria and windows become code** — one `criteria.py`; the run id gains the data
   snapshot (catalog version + last bar date) and the end date.
5. **Generic nudges in `robust.py`** — neighbours from the space file on every dimension; fix
   the B/C2 KeyError.
6. **No window is both a selection filter and a validation block** — recorded in the criteria file.
- **Done when:** a re-scored round 7 exists under the new machinery, with PBO reported.

### Phase 5 — Robustness over time, then choose
1. **Top 100 per tier vs 100 random configs** from the same space, on every financial year
   FY2018–FY2026, event windows (2018 small-cap bear, Feb–Mar 2020, 2020–21, 2022, 2023–24,
   Sep-24→Mar-25, 2025–26) and rolling 3-year windows; fresh starts per window. Report excess
   over Mom30 TRI and over the random median, rank per window, Kendall's W, worst window.
   *Pass (a config):* top half of the space in ≥70% of FY windows and no FY trailing Mom30 TRI
   by more than 10 pts. *Kill ("top-100 is special"):* beats random-100 in fewer than 60% of FY
   windows, or the edge sits mostly in FY24–25.
2. **Walk-forward the selection rule** — for each year Y from 2019, apply the rule to data
   before Y only (from stored weekly returns), hold through Y with a 13-week embargo, stitch.
   *Kill:* not ≥3 pts above the stitched median config, or not above Mom30 TRI.
3. **Factor regression + block bootstrap** — weekly returns on Nifty 50, a size spread and a
   momentum spread; stationary bootstrap (13–26-week blocks) for CAGR and max-DD intervals.
   Add Nifty500 Momentum 50 and Midcap150 Momentum 50 to `reference_benchmarks.py`.
   *Kill:* alpha < 5%/yr or |t| < 2 → it is small-cap-momentum beta; the index fund is the
   honest alternative.
4. **Choose** — rank by a pre-set lower bound (25th percentile of FY-window excess, or worst
   block); Ulcer index / Martin ratio and CDaR-95 instead of max DD; cluster offset-averaged
   configs (return correlation ≥ 0.9 or holdings overlap), take the medoid of the cluster with
   the best 25th-percentile member, ties to the simpler config. Prefer **8–12 names**, equal
   weight with a cap (also test inverse-vol), since F5 shows expected return is flat from 2 to
   24 holdings. Report winner stability when tier thresholds move ±5 pts.
   *Kill:* lower-bound top-50 overlaps CAGR top-50 by under 20% (CAGR-first was ranking noise);
   the medoid's walk-forward does not beat a random member of its cluster (there is no "best" —
   take the simplest); 2–6-stock configs beat 8–12 by more than 3 pts at similar Ulcer index
   (drop the 8–12 advice).
- **Done when:** one config (or "none") is named and frozen with its commit and data snapshot.

### Phase 6 — One-shot hold-out and forward tracking
1. **2012–2016 backcast, run exactly once** on the frozen choice, on C2 and the PIT-proxy
   universe (no curated categories). Nobody runs strategy backtests on 2012–16 before this.
   *Pass:* beats Nifty 500 TRI / Midcap 150 TRI by ≥5 pts with DD no worse than 1.5× the
   benchmark's. A fail is reported, not tuned around.
2. **Paper-track** the choice, the median config and Mom30 for 6–12 months, with failure fixed
   in advance (e.g. trailing Mom30 TRI by more than 10 pts over 6 months, or DD above 1.3× the
   bootstrap 95th percentile).
- **Done when:** the backcast result is recorded and paper tracking is running.

### Phase 7 — Optional accuracy items
F14 (circuit-lock mask, session-counted windows, Fyers prevclose), F15 (share-count engine and
capacity), F16 (dividends, historical tax rates, delisting exits). Pick up after Phase 6.

## Risks

- **The honest number may be far below 55–63%**, possibly below the index alternative. That is
  a valid outcome of this item, not a failure of it.
- **Fixing bugs while a sweep's results are being read** — round 7 results predate E1–E7; label
  them pre-fix everywhere.
- **Using up the hold-out** — one accidental 2012–16 strategy run before Phase 6 spoils it.
- **Thresholds drifting after results** — Phase 0's committed criteria file is the guard.
- **Scope** — seven phases; Phases 1–3 carry most of the value. Stop-points after 3 and 5.
- **Unverified evidence** — only E1–E3 were re-checked; Phase 0's appendix covers the rest.

## Open questions

1. Broad defaults in the API and dashboard: signal delay 0 and circuit locks off, against the
   search's 1 and on. Switch them (changes what a default dashboard run shows)?
2. For a delay-1 strategy the Rebalance preview targets last week's ranking, as backtested.
   When trading live, act on that or on the freshest ranking?
3. Which strategy will be followed with real money (ETF signal or a Broad candidate) — not yet decided.

### Answered

- **E5, parked cash (2026-10-05):** keep the change — under the itemised model the liquid fund
  pays stamp duty going in and nothing coming out.
- **E3, shared stock (2026-10-05):** leave the worse-placed category's slot empty for now.
- **Round 7 arm C2 (2026-10-05):** dropped at 754 of 4,000 runs; Phase 3's point-in-time
  universe runs replace it.
- **Order against BL-001 (2026-10-05):** BL-010's engine fixes go first.
- **Real money (2026-10-05):** not yet followed with real money; the owner plans to start. The
  live-signal parity check (Phase 1, second half) is therefore the next thing to finish.
- **Round 7 (2026-10-05):** the owner stopped it after C1 (A 8,003 runs, C1 4,000, C2 754).
  All of it is pre-fix.
- **Capital (2026-10-05):** ₹5 lakh for realism checks.
- **Bar (2026-10-05):** the three baskets above; beating the benchmark by a clear margin is a minimum.

## Log

- 2026-10-04 — review written in a separate session (findings F1–F16, E1–E9, six phases).
- 2026-10-05 — finalised and added to the backlog as BL-010; ten changes listed above; E1–E3
  spot-checked against the code.
- 2026-10-05 — started. Owner answers recorded (order, baskets, ₹5 lakh, portfolio view, model
  split). Phase 0: criteria committed; the ten round 7 favourites were already saved under
  "Candidate - …" names, so nothing in the catalog was changed (two older "Finalist - …" runs
  from Round 4 keep their names — rename in the dashboard if wanted). The review's reproducing
  queries are **not** yet captured; `docs/evaluation-review.md` records what has and has not
  been re-verified. Phase 1, first half: E1–E8 fixed with tests on branch
  `feat/bl-010-phase-0-1`; impact table in `docs/evaluation-review.md`.
- 2026-10-05 — owner accepted the three Phase 1a decisions (E5 kept, E3 gap left, C2 dropped).
- 2026-10-05 — Phase 1a merged (PR #10). Phase 1b: `verified` made the default series rule (owner
  approved), live ranking uses the ranking's own rule, CLI thin weeks fixed. Found: the Telegram
  signal is the ETF strategy; the Broad preview is literally equal to the backtest by construction.
