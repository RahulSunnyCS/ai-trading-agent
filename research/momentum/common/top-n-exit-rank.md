# Momentum: top N and exit rank (hysteresis)

**Status:** Tested · **Last updated:** 2026-10-14

## What it is

Buy only names in the top N; sell a holding only once its rank is worse than the exit rank. The
gap between the two is the hysteresis that stops a name being sold the week it slips a place.

| Parameter | Default (where) | Mechanism | Grade |
|---|---|---|---|
| `top_n` | 5 (Config, API, Live). Custom Index 8 (TODO 3.9.8) | Names eligible for fresh money | M, TODO 3.9.23, 3.9.8 |
| `exit_rank` | 10 (Config, API, Live). Custom Index 16 | Sell only when rank is worse than this. Must be >= `top_n` (validated) | M, TODO 3.9.23 |
| Zero-cost check | n/a | Re-ran with `cost_pct=0` | M, TODO 3.9.8 |

Broad Momentum ignores `top_n` / `exit_rank`: its funnel has its own pool, category and pick
settings ([Broad funnel](../strategies/broad/funnel.md)).

## Live value

ETF rotation: `top_n = 5`, `exit_rank = 10` (`live_config.toml`). Custom Index outer rotation:
8 / 16 ([inner and outer rotation](../strategies/custom-index/inner-outer-rotation.md)).

## Tested

| Item | Values tried | Data / period | Verdict | Evidence |
|---|---|---|---|---|
| TODO 3.9.23 dry run | ETF `top_n` 3, 8 | ETF, 2017-01 to 2026-09, 28 rolling 3-year windows | Top 3 wins most, at the cost of three ~33% positions; top 8 loses | Top 3: 28.5% / 1.07 / -31.1%, rolling 96 / 79 / 61%, median +2.7. Top 8: rolling 39 / 43 / 54%, median -0.6 |
| TODO 3.9.23 dry run | ETF `exit_rank` 6, 16 | same | 10 is the sweet spot of those tried | Exit 6: median -5.3 (21 / 29 / 25%), churn up to 69 buys a year. Exit 16: median -1.4, deeper drawdowns (-32.7%) |
| TODO 3.9.8 | Custom Index `top_n` 5 to 8 (exit 10 to 16) | Custom Index, real runs | 8 / 16 adopted | Max drawdown -34.42% to -30.80% while CAGR rose 19.77% to 24.60% |
| TODO 3.9.8 zero-cost check | `cost_pct=0` | Custom Index | Whipsaw is not the main driver of drawdown | Drawdown improved only 0.5 to 2 points, so an exit debounce was not built |

## What we know

- `top_n=3` on the ETF rotation won in 96% of windows, but each name then holds about a third of
  the money. It is listed as an owner decision in TODO 3.9.23, not adopted.
- A tight exit (6) churns and loses about 5 points a year; a loose one (16) holds losers too long.
- Costs do not explain Custom Index's drawdowns (zero-cost check).

## Not yet tested

- Exit ranks between 10 and 16, or tied to `top_n` (only 6, 10 and 16 were run).

## In plain words

**Top N = 5.** How many names we are happy to buy fresh. Fewer names means bigger bets and
bigger swings. Measured on the Custom Index tab: raising it from 5 to 8 cut the worst fall
from about 34% to about 31% and raised yearly return (TODO 3.9.8). On the ETF strategy, 3
names beat 5 in nearly every stretch (about 2.7 points a year more), but each then holds about
a third of the money (TODO 3.9.23).

**Exit rank = 10.** A name is only sold once it drops below 10th place, not the moment it slips
to 6th. Think of it as a doorman who lets you stay a while after you stop being the most
popular. It cuts pointless buying and selling (which costs money and tax). Measured: 6 churns
far more and earns about 5 points a year less; 16 holds losers too long (TODO 3.9.23).

## Related

- [Portfolio rule and entry](portfolio-entry.md), [caps](caps.md),
  [Broad funnel](../strategies/broad/funnel.md), [Custom Index](../strategies/custom-index/README.md).
