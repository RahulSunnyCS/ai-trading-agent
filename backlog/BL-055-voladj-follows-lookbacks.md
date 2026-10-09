# BL-055 — Volatility-adjusted score that follows the selected lookbacks and weights

| | |
|---|---|
| **Priority** | P2 — owner question; affects half the search space's meaning |
| **Status** | Done — killed (all three variants) |
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

## Result (2026-10-09): killed

After tax at Rs 5 lakh, median of the 10 strategies (`search_spaces/bl055_result.json`):

| Window | CAGR change | Strategies not worse | Worst fall change |
|---|---|---|---|
| FY2018-22 (choose) | **-12.2 pts** | 0 of 10 | -9.6 pts deeper |
| FY2023-26 (confirm) | -1.4 pts | 3 of 10 | -3.5 pts deeper |

Every strategy lost on FY2018-22, by 6 to 21 points (pre-tax median -15.0). Checked for a bug:
none (the variant reproduces today's score exactly at 26/52 with equal weights). The cause is the
pre-registered skip rule: lookbacks under 26 weeks are measured to the latest close, so the score
favours stocks that just jumped, and those reverse. On a sample of weeks for Five Sectors Monthly
the variant's top 30 had risen 13.1% over the last 4 weeks (7.3% for today's score) and then fell
4.4% over the next 4 (0.9%); the two top-30 lists shared 9 names. NSE skips the latest month for
this reason.

**Keep today's NSE method.** The flag stays in the engine, off. A variant that skips the latest
month on every lookback is a different question; it would need its own addendum and run.

## Result, addendum 1 (2026-10-09): all three variants killed

Run with a true skip-month, against today's default score; after tax at Rs 5 lakh, median of the
10 strategies:

| Skip rule | FY2018-22 CAGR | Not worse | Worst fall | FY2023-26 CAGR |
|---|---|---|---|---|
| Lookbacks of 26 weeks and more (the first variant, as registered) | -11.2 pts | 0 of 10 | -9.9 pts | -2.0 pts |
| Every lookback (owner) | -12.0 pts | 0 of 10 | -4.3 pts | -14.7 pts |
| None (owner) | -7.5 pts | 1 of 10 | -7.3 pts | -6.6 pts |

Even with no skip, the plain returns over each config's selected lookbacks lose 7.5 points: the
problem is not only the skip rule. Today's score uses 30- and 56-week windows (the widened
"skip"), and on this history those long windows rank stocks much better than the configs' own
shorter mixes. **Keep today's default.** Whether to relabel it (it does not skip the latest
month) or test it against NSE's method as published is an owner decision; nothing here suggests
the change would help.

## Log

- 2026-10-09 — created and started (owner: "do both"); Phase 0 committed before any run.
- 2026-10-09 — run (13 runs, 2 cells); killed. Diagnosed as short-term reversal, not a bug.
- 2026-10-09 — owner: also test skipping the latest month on every lookback, and not skipping at
  all. Addendum 1 (`search_spaces/bl055_criteria_addendum_1.json`) committed before any run; same
  strategies and rules, 3 variants in all.
- 2026-10-09 — **bug found while building addendum 1, before any addendum run:** the default
  voladj score's "skip the latest month" does not skip. `_compute_ranks_voladj` computes
  `prices / prices.shift(s + 26) - 1`, a 30-week (and 56-week) return to the latest close, not
  the 26/52-week return measured 4 weeks back that its docstring and NSE's method describe. Every
  voladj and blend result so far (round 7, the frozen ensemble, the Friday Broad signals) used
  the widened windows. The default is **not** changed here (it would move every saved result
  and the frozen ensemble: an owner decision). Consequences for this item:
  - the first variant (killed above) copied the same formula for lookbacks >= 26, so it did not
    match its own pre-registration on those components; its short components were as
    registered, so the reversal diagnosis stands;
  - the lookback-following path now does a true skip (return from skip + L to skip weeks ago),
    and lever l8 runs the first variant again as registered (`skip_long`) next to addendum 1's
    `skip_all` and `skip_none`, all against today's default;
  - tests pin the default's actual behaviour and the corrected NSE formula.
- 2026-10-09 — addendum 1 run (13 runs, 4 cells); all three variants killed.
