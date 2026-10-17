# BL-115 — Do a stock's own-history numbers separate winning from losing picks?

| | |
|---|---|
| **Priority** | P1 — the owner wants a way to avoid the losing picks of the two strategies they follow, before more money goes in |
| **Status** | Done — killed: no feature passes in both strategies (the average-weekly score passes in Four Sectors Monthly only) |
| **Type** | research |
| **Area** | momentum |
| **Created** | 2026-10-17 |
| **Depends on** | BL-052 (saved strategies), BL-114 (the pair: Trio Fortnightly + Four Sectors Monthly, No Tilt) |
| **TODO.md row** | — |

## Context

Both strategies choose stocks by comparing them with each other: Trio by rank (blend of rank sum
and the volatility-adjusted score), Four Sectors Monthly by NSE's volatility-adjusted score, which
is z-scored across stocks. The owner (2026-10-17): instead of a percentile, give each stock a number
from its own history, for example the average weekly return over each window added up, and check
whether that number was weaker for the losing picks and higher for the winning ones, so the
losers could be avoided later.

Prior work: BL-050 screened seven stock features inside the top momentum quintile (turnover
expansion t = 4.8, trend quality 3.3, accumulation 3.1, overextension the wrong way) and none
moved the backtest more than 0.3 points as a tilt; absolute momentum against cash was rejected
twice on ETF and Custom Index (TODO 3.9.18, 3.9.23). A trade-level winner/loser test of the
owner's average-weekly score on the Broad picks has not been run.

## Goal

A pre-registered answer, on 2017-2022 only: does any of seven own-history measures, taken at the
week a stock was chosen, separate the picks that beat Nifty 500 from those that did not, in both
strategies?

## Out of scope

Changing the engine or the live signal (Phase 2, only if a feature passes); other features; the
ETF track; reading 2023 onwards.

## Plan

### Phase 0 — Pre-register (committed before any run)

The binding rule is `packages/momentum-backtesting/search_spaces/bl115_criteria.json`. In words:

- **Hypothesis:** at the decision week, winning picks have a higher average-weekly score (and
  steadier, smoother rises, nearer their 52-week high, with rising turnover, fewer circuit days and
  less of the rise from one day) than losing picks.
- **Trades:** every new position of the six sleeves (Trio's 2, Four Sectors Monthly's 4), each
  re-run with its saved settings and data ending 30 Dec 2022; the decision week is the Friday
  before the fill. Winner = the position's return beat Nifty 500 TRI over the same weeks.
- **Features (owner's first, then six):** F0 the sum of each own lookback's average weekly return
  (return / weeks); F1 share of up weeks in 26; F2 deepest fall inside 26 weeks; F3 distance below
  the 52-week high; F4 turnover in the last 20 sessions / the last 130; F5 circuit-edge sessions in
  the last 65; F6 the best single day's share of the 13-week rise.
- **Pass / kill rule:** a feature passes when, in BOTH strategies, its rank correlation with the
  excess return has the expected sign at |t| >= 3 (block bootstrap over decision weeks) AND its
  worst fifth holds at least 10 points more losers than the strategy overall. No feature passing
  kills the idea.
- **Look-ahead check:** a test recomputes each feature with every price after the decision week
  removed and requires the same value; nothing after 30 Dec 2022 is read.
- **Hold-out:** 2023-01-06 to 2026-10-16 sealed; a weak check only, because both strategies were
  chosen on results that include it.
- **Will not run:** listed in the JSON (other features, other lookback sets, tuned thresholds,
  other strategies, 2023 onwards).
- **Report only (no verdict):** the same-week view (feature and outcome relative to that week's
  other picks), a 13-week fixed-horizon outcome, F0's components and F0 / volatility, the worst
  20% of trades by quintile, and the engine's own entry rank for comparison.

### Phase 1 — Trade-level test on 2017-2022
- **Tasks:** `scripts/bl115_own_history_features.py` (re-run the sleeves to 2022, build the trade
  table, compute the features point-in-time, the tests and the report-only tables); a look-ahead
  test.
- **Deliverables:** `search_spaces/bl115_result.json`, the tables under `data/search/bl115/`, the
  result below, and a findings page in `research/momentum/`.
- **Done when:** the verdict is written here under the rule above.

### Phase 2 — Backtest a floor (only if a feature passes)
- Pre-registered as an addendum before it runs: the floor's value from the 2017-2022 trades, the
  backtest on 2017-2022 against the strategy as it is, then one check on the sealed window.

## Result (2026-10-17): killed

`search_spaces/bl115_result.json` (rule: `bl115_criteria.json`, committed before the run); trade
table `data/search/bl115/trades.csv` (git-ignored; regenerate with
`uv run python scripts/bl115_own_history_features.py`). 2017-2022 only; nothing after 30 Dec 2022 was
read.

| | Trio Fortnightly | Four Sectors Monthly, No Tilt |
|---|---|---|
| Trades (closed, 2017-2022) | 384 (16 open at the end, left out) | 508 (21 open) |
| Losers (did not beat Nifty 500) | 57% | 49% |

Rank correlation with the trade's return over Nifty 500 (t from 2,000 bootstraps over decision
weeks), and the loser share of each feature's worst fifth against the strategy's overall share:

| Feature | Trio rho / t | Trio worst fifth | Four Sectors rho / t | Four Sectors worst fifth | Passes |
|---|---|---|---|---|---|
| F0 average-weekly score (owner) | +0.08 / 1.7 | 61% vs 57% | **+0.15 / 3.9** | **60% vs 49%** | Four Sectors only |
| F1 steadiness | +0.06 / 1.1 | 64% vs 57% | +0.11 / 2.7 | 52% vs 49% | no |
| F2 smoothness | +0.02 / 0.4 | 62% vs 57% | +0.08 / 1.9 | 49% vs 49% | no |
| F3 distance below 52-week high | +0.10 / 1.8 | 60% vs 57% | +0.07 / 1.7 | 56% vs 49% | no |
| F4 turnover expansion | -0.01 / -0.2 | 60% vs 56% | +0.14 / 2.9 | 51% vs 47% | no |
| F5 circuit days (expected -) | +0.03 / 0.6 | 55% vs 57% | +0.09 / 2.0 | 46% vs 49% | no (wrong way in Four Sectors) |
| F6 spike dependence (expected -) | -0.06 / -0.9 | 57% vs 56% | -0.06 / -1.4 | 52% vs 47% | no |

**Verdict under the rule: killed.** No feature passes in both strategies. The owner's score has the
expected sign in both and passes both tests in Four Sectors Monthly, but not in Trio.

Report only (no verdict):

- **Same week:** taking the feature and the outcome relative to the other picks decided that week,
  the score's correlation is +0.18 in Four Sectors and +0.08 in Trio, so where it works it is not
  only market timing.
- **The engine's own entry rank** correlates about as much (-0.11 and -0.10; rank 1 is best), so the
  score adds little a rank does not already carry.
- **Components:** in Four Sectors the 13- and 26-week average weekly returns carry it (+0.16, +0.17);
  the 4- and 52-week parts add little. Score / 26-week volatility: +0.17 and +0.10.
- **Fixed 13 weeks after the fill** (fills to Sep 2022): score +0.09 and -0.02; steadiness +0.15 and
  +0.07.
- **Big losers:** the worst 20% of trades are spread about evenly over the score's quintiles (Four
  Sectors 22%, 23%, 17%, 22%, 18% from lowest score to highest), so a floor would not avoid them.
- **Medians:** winners 9.0 vs losers 8.1 (Four Sectors), 6.6 vs 5.9 (Trio): heavy overlap.

What this means: among stocks these strategies already chose, the stock's own numbers at the buy
week say little about which picks will lag the index. A follow-up on the score in Four Sectors alone
would be a new, post-hoc question and needs its own pre-registration; the 2023-2026 window stays
unread.

## Risks

- The trades are only stocks the strategy already picked, so every score is high; the test asks
  whether the number still sorts the picks.
- A raw score is high for most stocks in a rising market, so a floor can turn into market timing;
  the same-week view shows whether that is all it does.
- Fourteen tests: hence |t| >= 3 and both strategies.

## Open questions

Answered by the owner on 2026-10-17: the score uses each strategy's own lookbacks as average weekly
returns (return / weeks) added up; a winner beats Nifty 500; analysis first; the six extra
features and the report-only views as listed.

## Log

- 2026-10-17 — created; Phase 0 pre-registration committed before any feature was computed (96d6e2d2).
- 2026-10-17 — Phase 1 run: killed. No Phase 2.
