# Momentum: lookbacks, weights and tie-break

**Status:** Tested · **Last updated:** 2026-10-14

## What it is

The ranking looks at each name's return over several windows, ranks the names in each window,
and adds the ranks up. Lowest total wins.

| Parameter | Default (where) | Mechanism | Grade |
|---|---|---|---|
| `lookbacks` | (1, 4, 13, 26, 52) weeks (Config, API, Live) | Return over each window, ranked across eligible instruments. Approximates 1 week, 1 month, 3 months, 6 months and 12 months. A name is eligible only once it has history for the longest window | R |
| `weights` | None = equal (Config) | Score = sum of weight x rank; lowest wins. A negative weight rewards the worst-ranked name on that window. All-zero weights are rejected | M, TODO 3.9.23 |
| Tie-break | middle lookback's return, then name (engine) | Makes runs reproducible: ranks do not depend on column order | R |

Grades and the "Config / API / Live" key are explained in the [index](../README.md#how-to-read-the-numbers).

## Live value

- ETF rotation: `lookbacks = [1, 4, 13, 26, 52]`, equal weights
  (`packages/momentum-backtesting/src/momentum_backtesting/live_config.toml`).
- Broad search spaces: `lookbacks` is a heavy dimension with five choices
  (`[4, 13, 26]`, `[13, 26]`, `[13, 26, 52]`, `[1, 4, 13, 26]`, `[4, 13, 26, 52]`) and
  `weight_scheme` one of `equal`, `recent`, `long`
  ([`round7_A.toml`](../../../packages/momentum-backtesting/search_spaces/round7_A.toml)). Round 1
  also offered `[1, 4, 13, 26, 52]`
  ([`round1_A.toml`](../../../packages/momentum-backtesting/search_spaces/round1_A.toml)).
- The frozen Phase 6 ensemble uses `[4, 13, 26, 52]` (two configs), `[13, 26, 52]` and
  `[4, 13, 26]`
  ([`bl010_phase6_frozen.json`](../../../packages/momentum-backtesting/search_spaces/bl010_phase6_frozen.json)).
  Three of its four configs use `voladj`, which ignores these settings: see [score](score.md).

## Tested

| Item | Values tried | Data / period | Verdict | Evidence |
|---|---|---|---|---|
| TODO 3.9.23 dry run | weights (0, 1, 1, 1, 1): drop the 1-week window | ETF and Broad, 2017-01 to 2026-09, 28 rolling 3-year windows | Keep equal weights | ETF 23.9% / 0.92 / -31.2%, rolling 21 / 29 / 25%, median -1.6: the 1-week window helps on ETFs. Broad 33.9% / 1.11 / -26.7%, rolling 64 / 54 / 39%, median +2.8, but deeper drawdowns and the cold-start fork caveat ([Broad funnel](../strategies/broad/funnel.md#cold-start-caveat)) |

The 1-week drop on ETFs is also why the skip-month variant lost: see [skip-month](skip-month.md).

## What we know

- On ETFs the 1-week window earns its place. Dropping it lost in most rolling windows
  (rolling-window rule from TODO 3.9.23; about 90 variants were tried in that study).
- On Broad, dropping the 1-week window won 64% of windows on CAGR, but with deeper drawdowns and
  a forked category history, so it is indicative only.
- For `voladj` configs, `lookbacks` and `weights` do not change the stock ranking at all
  (BL-086). See [score](score.md).

## Not yet tested

- Unequal weight schemes on the ETF rotation (the search's `recent` / `long` schemes ran on Broad
  only).

## In plain words

**Look-back windows (1, 4, 13, 26, 52 weeks).** About one week, one month, three months, six
months, one year. Using all five asks "is it strong in the short run AND the long run?"
Measured: dropping the one-week window, or skipping the last month altogether, made the ETF
strategy worse in most stretches (TODO 3.9.23). The short window earns its place.

**Weights (equal by default).** How much each window's rank counts. Equal means every window
has a vote of the same size. A negative weight flips a window, so the worst performer scores
best. That is what you tried for turnarounds. It did not work because ranks cannot express
"beaten down AND recovering". The reversal plan fixes that with a filter first (see
[reversal sleeve](reversal-sleeve.md)).

### A worked example (made-up numbers, worked by hand)

Four things, five time windows. Each cell is the percent gain over that window.

| | 1 week | 4 weeks | 13 weeks | 26 weeks | 52 weeks |
|---|---|---|---|---|---|
| A | +2 | +6 | +15 | +30 | +60 |
| B | +4 | +5 | +10 | +20 | +40 |
| C | -1 | +1 | +12 | +35 | +70 |
| D | 0 | -2 | +2 | +5 | +10 |

Step 1. In each window, rank them: best gain gets 1, worst gets 4.

| | 1w | 4w | 13w | 26w | 52w | Total score |
|---|---|---|---|---|---|---|
| A | 2 | 1 | 1 | 2 | 2 | 8 |
| B | 1 | 2 | 3 | 3 | 3 | 12 |
| C | 4 | 3 | 2 | 1 | 1 | 11 |
| D | 3 | 4 | 4 | 4 | 4 | 19 |

Step 2. Add up the ranks. Lowest total wins. Final order: A (8), C (11), B (12), D (19).

Notice B was best this week, but ranks third overall because its longer history is weaker. That
is the point of using five windows: one hot week is not enough. A real Friday worked the same way
is on the [ETF rotation page](../strategies/etf-rotation/README.md#a-real-friday-2026-09-18).

## Related

- [Skip-month](skip-month.md), [score](score.md), [top N and exit rank](top-n-exit-rank.md).
