# Momentum evaluation review — evidence log

The plan, findings (F1–F16, E1–E9), phases and pass/kill thresholds live in
[`backlog/BL-010-momentum-evaluation-review.md`](../../../backlog/BL-010-momentum-evaluation-review.md)
and `search_spaces/bl010_criteria.json`. This file only records **what has been measured**, phase
by phase, and what has not yet been re-verified.

## What is and is not re-verified (2026-10-05)

| Claim | State |
|---|---|
| Engine bugs E1–E7 | Each reproduced by a test that fails on the old code and passes on the fix |
| E8 (trade log could not be audited) | Fixed; a test rebuilds the final portfolio from the trade log alone |
| Stored round 7 arm A results | The unfixed code reproduces all six configs below to 5 decimals |
| F11 (live Rebalance ranking rebuilt its pool with the legacy series rule) | Fixed in Phase 1b; `verified` is now the default rule everywhere |
| E9 (API / CLI / search defaults differ) | Series rule and the CLI's skipped weeks fixed. Still different: Broad's API default signal delay is 0 and circuit locks are off, the search uses 1 and on |
| Findings F1–F10, F12–F16 and their numbers | Taken from the 2026-10-04 review session; **not** independently re-verified, and the queries that produced them are not captured here yet |

## Phase 1a — what each engine fix does to round 7 arm A

Six configs from `data/search/round7_A` (8,003 runs): the three tier winners under round 7's own
criteria and the three runs nearest the median CAGR. Each fix was applied **alone** to the
pre-fix code, then all together. Pre-tax, itemised costs, ₹2 lakh, circuit locks on, one-week
signal delay — round 7's settings, unchanged.

**CAGR, %**

| Config | Before | E1 gate | E2 UC top-up | E3 two categories | E4 `SYM#2` | E5 parked cash | E6 mass exit | All fixes |
|---|---|---|---|---|---|---|---|---|
| Aggressive winner `884b2f79a917` | 63.42 | 53.32 | 63.42 | 63.42 | 55.08 | 63.98 | 63.42 | **52.17** |
| Midway winner `e53e99105fd9` | 61.29 | 61.04 | 61.29 | 61.29 | 54.29 | 61.50 | 61.29 | **52.86** |
| Conservative winner `58e63db1cf9d` | 55.58 | 54.29 | 55.58 | 55.58 | 49.01 | 55.63 | 55.58 | **45.99** |
| Median `153ce705139a` | 32.06 | 31.86 | 32.06 | 32.06 | 34.36 | 32.06 | 32.06 | **34.88** |
| Median `b5c261648aa5` | 32.06 | 29.81 | 32.06 | 32.06 | 32.78 | 32.17 | 32.06 | **32.53** |
| Median `f49871588e07` | 32.06 | 31.43 | 32.06 | 32.15 | 32.55 | 32.06 | 32.06 | **32.40** |

**Max drawdown, %** (before → all fixes): aggressive −47.72 → −44.86; midway −30.40 → −29.10;
conservative −29.69 → −33.03; medians −28.50 → −25.88, −47.07 → −45.39, −39.99 → −38.96.

**Turnover, × per year** (E7 changes the definition, not the trades):

| Config | Old (first-time buys only) | New (everything sold), same trades | New, all fixes |
|---|---|---|---|
| Aggressive winner | 6.03 | 6.40 | 6.63 |
| Midway winner | 2.66 | 3.90 | 4.32 |
| Conservative winner | 1.37 | 2.85 | 3.01 |
| Medians | 2.74 / 11.54 / 1.49 | 5.33 / 14.12 / 2.89 | 5.15 / 14.35 / 2.96 |

### Reading it

- **The three winners lose 8–11 points of CAGR; the three median configs gain 0.3–2.8.** Two
  fixes do almost all of it: E1 (a stock failing the liquidity gate now leaves that week, not a
  week later) and E4 (stocks whose price series restarted after a demerger are pickable again in
  category mode — 34 such columns across 31 symbols; never two live at once; 30 of the midway
  winner's 654 trades).
- Six configs cannot separate "the fix removed a real advantage" from "the top result out of
  8,003 falls when anything is perturbed". The median configs moving slightly **up** while
  every winner moves **down** is what finding F4/F5 (winner's curse) predicts. Phase 4's
  re-scored search is what settles it.
- **The conservative winner no longer fits its own tier**: drawdown −33.0% against round 7's −30%
  cap, and turnover 3.0× against its 2.5× cap once turnover counts what was actually sold.
- E2 and E6 changed nothing here: none of the six ever topped up a holding locked at the upper
  circuit, and none uses the mass-exit throttle. E3 moved one median config by 0.09 points.
- E5 is a small gain (0.0–0.6 points), as expected for a cost that was overcharged.

Reproduce: `impact.py` + `picks.json` (kept with the PR description), run once per source tree
with `PYTHONPATH` pointing at that tree and `MOMENTUM_DATA_DIR` at the data directory.

## Phase 1b — live preview against the backtest (2026-10-05)

- The Rebalance preview runs the same `_run_broad` function as the backtest on the stored
  ranking plus one flat week, so its target for week t is what the backtest holds after trading
  at t. For a strategy with `signal_delay = 1` that means the target comes from the ranking at
  t−1 — exactly what was backtested, and one week older than the freshest ranking. Whether live
  trading should act on the fresher ranking is an operating decision, not a bug; it is open.
- The Friday Telegram signal (`mbt weekly`) runs the ETF strategy in `live_config.toml`. No
  Broad Momentum config feeds it.
- Not yet done: replaying the preview week by week over the last 12 weeks against the backtest
  (needs data truncated at each week — the Phase 2 harness).
