# BL-055 — Volatility-adjusted score that follows the selected lookbacks and weights

| | |
|---|---|
| **Priority** | P2 — owner question; affects half the search space's meaning |
| **Status** | In progress |
| **Type** | research (+ an opt-in engine flag) |
| **Area** | momentum |
| **Created** | 2026-10-09 |
| **Depends on** | BL-054 (runner, strategies, windows) |
| **TODO.md row** | 3.13.9 |

## Context

The owner (2026-10-09) asked whether the volatility-adjusted score should use whatever
lookbacks are selected, with their priority weights. Today `engine._compute_ranks_voladj` always
uses 26- and 52-week returns (4 weeks back) over 26-week volatility, the NSE Momentum index
method, and ignores `lookbacks` and `weights`. Consequences found on 2026-10-09:

- 2,600 of round 7's 8,003 configs use voladj. For them the 15 lookback x weight combinations
  give the same stock ranking; in 882 (stock tilt off) the two settings have no effect at all,
  in the rest lookbacks only feed the stock tilt. Weights never matter for voladj.
- Five top-10 names described those inert settings and were renamed (see
  `packages/momentum-backtesting/docs/top-strategies-2026-10-08.md`, "Name changes").

## Goal

A pre-registered verdict on whether a lookback-following voladj improves the strategies after
tax, and an opt-in flag; the default stays NSE's method.

## Out of scope

A new search; changing the default; the frozen ensemble's definition.

## Plan

### Phase 0 — Pre-register (committed before any run)
`packages/momentum-backtesting/search_spaces/bl055_criteria.json`. In words: per selected
lookback, return / 26-week volatility, z-scored, weighted by the selected weights; the 4-week
skip only for lookbacks of 26 weeks or more (NSE's convention is for its 6- and 12-month
returns). Ten strategies (the 11 less the rank-sum one, which is unaffected), after tax at Rs 5
lakh, chosen on FY2018-22: median CAGR +1.0 pt or more, not lower in 6 of 10, worst fall no
more than 2 pts deeper; confirmed on FY2023-26: median change >= 0, not lower in 5 of 10.

### Phase 1 — Engine flag
`Config.voladj_lookbacks` (heavy setting, in the rank-cache key), threaded through
`compute_universe_base` / `bias.Runner`; tests; goldens unchanged.

### Phase 2 — Run and verdict
`scripts/bl054_levers.py l7`; result in this file and `search_spaces/bl055_result.json`.

## Log

- 2026-10-09 — created and started (owner: "do both"); Phase 0 committed before any run.
