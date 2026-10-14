# Broad Momentum: simulate every week (`min_ranked`)

**Status:** Descriptive · **Last updated:** 2026-10-14

## What it is

`engine.run_backtest` only simulates a week when at least `min_ranked` names are ranked
(0 = `top_n`, the old rule). Broad's rank table ranks only the picks of the held categories, so
with the old rule a week with fewer than categories x picks ranked stocks was skipped: no sale,
no buy, and the curve jumps.

| Parameter | Default (where) | Mechanism | Grade |
|---|---|---|---|
| `min_ranked` (API `broad_every_week`) | engine 0 = `top_n`; the 3.9.23 study used 1 | A week is simulated only if this many names are ranked | M, TODO 3.9.23 |

This is a correctness fix, not a lever.

## Live value

On. `BacktestRequest.broad_every_week` defaults to True (TODO 3.11.17), so `min_ranked=1` for
every new Broad run; a saved run that set it explicitly is unaffected. The search spaces fix
`min_ranked = 1` ([`round7_A.toml`](../../../../packages/momentum-backtesting/search_spaces/round7_A.toml)),
and BL-010 made API, CLI and search identical on it (E9).

## Tested

| Item | Values tried | Data / period | Verdict | Evidence |
|---|---|---|---|---|
| TODO 3.9.23 | skipping thin weeks vs simulating every week | Broad dashboard defaults, 2017-2026 | The skipped curve is the wrong one; every week should be the default | With the old default, 194 of 508 weeks since 2017 were skipped. Skipping: 37.5% / 1.67 / -19.0%; every week: 31.7% / 1.06 / -20.4%. Last 5 years 31.48% / 1.06 / -19.14% vs 41.14% / 1.76 / -15.92%; last 3 years 30.15% / 0.99 / -19.14% vs 36.41% / 1.63 / -12.47% |

## What we know

- Broad numbers logged before 2026-10-01 are "gapped engine" numbers: see
  [how to read the numbers](../../README.md#how-to-read-the-numbers).
- The gaps were mostly in weak markets such as 2018 (63 gaps, the longest 15 weeks).
  `picks_per_category=3` lost 369 weeks and showed a fake Sharpe of 2.70.
- Checked elsewhere: the ETF live config has 509 weeks and no gaps; Custom Index defaults 456
  weeks and no gaps (TODO 3.9.23).

## Not yet tested

- Nothing: it is a fix. The Nifty 50 stock dataset could not be checked for the same gap at the
  time (see [Stock](../stock/README.md)).

## In plain words

**A bug that made Broad look better than it was (found 1 October 2026).** In weeks when few
categories qualified, the backtest silently skipped the whole week: nothing sold, nothing
bought. That happened in about 190 of 508 weeks, mostly in weak markets like 2018. Counting every
week, Broad made about 31.7% a year with a worst fall of 20%, not the 37.5% the dashboard showed.
That is still far ahead of Nifty with dividends (12.6%) and the Momentum 30 index (17.0%). The
fix is the "Simulate every week" switch in the Broad settings; it should become the default
(TODO 3.9.23). (It has since become the default, TODO 3.11.17.)

## Related

- [Broad funnel](funnel.md), [Broad strategy](README.md).
