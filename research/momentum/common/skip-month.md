# Momentum: skipping the latest month

**Status:** Tested · **Last updated:** 2026-10-14

## What it is

"Skip-month" measures momentum up to four weeks ago instead of up to the latest close. The
standard 12-1 convention does this to avoid short-term reversal: a name that just jumped tends to
give a little back.

| Setting | Default (where) | Mechanism | Grade |
|---|---|---|---|
| Skip-month ranksum (`levers.skip_month_ranks`) | not default | Rank on 3-1, 6-1 and 12-1 month returns (the last 4 weeks left out), fed in through `external_ranks` | M, TODO 3.9.23 |
| `voladj_skip_recent_month` | True | `voladj` returns are meant to be measured 4 weeks ago (standard 12-1 convention, avoids short-term reversal) | R |
| `Config.voladj_lookbacks` skip rule (BL-086) | off | When the lookback-following `voladj` is on, which lookbacks skip the latest 4 weeks: those of 26 weeks or more, all, or none | M, BL-086 |

## Live value

- ETF rotation: ranksum with no skip (`live_config.toml`).
- Broad search spaces and the frozen ensemble: `voladj_skip_recent_month = true` (fixed in
  [`round7_A.toml`](../../../packages/momentum-backtesting/search_spaces/round7_A.toml)). Round 1
  searched `true` and `false`
  ([`round1_A.toml`](../../../packages/momentum-backtesting/search_spaces/round1_A.toml)).

**The default `voladj` skip does not skip.** Found on 2026-10-09 while building BL-086's
addendum 1: `_compute_ranks_voladj` computes `prices / prices.shift(s + 26) - 1`. That is a
30-week (and 56-week) return to the latest close, not the 26/52-week return measured 4 weeks
back that its docstring and NSE's method describe. Every `voladj` and `blend` result so far
(round 7, the frozen ensemble, the Friday Broad signals) used the widened windows. The default
was not changed: it would move every saved result and the frozen ensemble, which is an owner
decision ([BL-086 Log](../../../backlog/BL-086-voladj-follows-lookbacks.md#log)).

## Tested

| Item | Values tried | Data / period | Verdict | Evidence |
|---|---|---|---|---|
| TODO 3.9.23 dry run | skip-month ranksum (3-1, 6-1, 12-1) vs the live ETF ranking | ETF, 2017-01 to 2026-09, 28 rolling 3-year windows | Rejected | ETF 19.7% / 0.73 / -38.0%, rolling 11 / 11 / 21%, median -5.7 |
| BL-086 addendum 1 | lookback-following `voladj` with three skip rules, against today's default score | 10 Broad strategies, after tax at Rs 5 lakh; choose FY2018-22, confirm FY2023-26 | All three killed | See the table below; [`bl086_criteria_addendum_1.json`](../../../packages/momentum-backtesting/search_spaces/bl086_criteria_addendum_1.json), [`bl086_result.json`](../../../packages/momentum-backtesting/search_spaces/bl086_result.json) |

BL-086 addendum 1, run with a true skip-month (return from skip + L to skip weeks ago); median
of the 10 strategies, after tax:

| Skip rule | FY2018-22 CAGR | Not worse | Worst fall | FY2023-26 CAGR |
|---|---|---|---|---|
| Lookbacks of 26 weeks and more (the first variant, as registered) | -11.2 pts | 0 of 10 | -9.9 pts | -2.0 pts |
| Every lookback (owner) | -12.0 pts | 0 of 10 | -4.3 pts | -14.7 pts |
| None (owner) | -7.5 pts | 1 of 10 | -7.3 pts | -6.6 pts |

## What we know

- On ETFs, skipping the latest month in a ranksum loses badly (median -5.7 points, 11% of
  windows). The 1-week window helps there ([lookbacks](lookbacks.md)).
- On Broad, the skip rule was not the whole story: even with no skip, the configs' own shorter
  lookback mixes lose 7.5 points to today's long 30/56-week windows (BL-086 addendum 1, after
  tax, in-sample strategies).
- Whether to relabel today's `voladj` (it does not skip) or test it against NSE's method as
  published is an owner decision. Nothing in BL-086 suggests the change would help.
- The JSON files still say BL-055: BL-086 was renumbered from BL-055 on 2026-10-10 and the file
  contents were left unchanged.

## Not yet tested

- Today's widened `voladj` windows against NSE's published 26/52-week-skip-4 method, on the
  same strategies (the corrected formula is pinned in tests but not run as a variant of the
  default).

## In plain words

Skipping the last month means "judge the climb, but ignore the last four weeks of it". The idea
is that a stock that jumped last week often slips back a little. On the ETF strategy it made
things clearly worse. On Broad, the score everyone thought skipped the last month turns out not
to; switching to the "proper" version, or letting the score follow each config's own windows,
made results worse every way it was tried.

## Related

- [Score](score.md) (BL-086's main result), [lookbacks](lookbacks.md),
  [execution](execution.md) (a one-week signal delay is another way of not trading on the
  latest jump).
