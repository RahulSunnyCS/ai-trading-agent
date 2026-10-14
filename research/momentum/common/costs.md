# Momentum: trading costs

**Status:** Descriptive · **Last updated:** 2026-10-14

## What it is

| Parameter | Default (where) | Mechanism | Grade |
|---|---|---|---|
| `cost_pct` | 0.10 percent per side (Config, API, Live) | Flat cost on each buy and each sell. A simple stand-in for all frictions | R |
| `cost_model` | `flat`. `itemised` available | STT 0.1% each side, stamp duty 0.015% on buys, exchange fees about 0.004% each side, slippage `slippage_bps` 5, DP charge 16 rupees per sell scaled by `capital` (1,000,000) and capped at 5% | M, TODO 3.9.23 |

## Live value

- ETF rotation: flat `cost_pct = 0.10` (`live_config.toml`).
- Broad search and the frozen ensemble: `cost_model = "itemised"`, `slippage_bps = 15`, capital
  Rs 2 lakh "so the flat Rs 16 DP charge per sell counts properly"
  ([`round7_A.toml`](../../../packages/momentum-backtesting/search_spaces/round7_A.toml)). Round 1
  used 5 bps ([`round1_A.toml`](../../../packages/momentum-backtesting/search_spaces/round1_A.toml)).

## Tested

| Item | Values tried | Data / period | Verdict | Evidence |
|---|---|---|---|---|
| TODO 3.9.23 dry run | `itemised` vs `flat` | ETF and Broad, 2017-01 to 2026-09 | The edge survives both | Costs 0.7 CAGR points on ETF (25.1% vs 25.8%) and 2.3 on Broad (29.4% vs 31.7%, which buys 115 names a year) |

## What we know

- Costs are not what hurts these strategies most; tax is ([tax](tax.md)).
- BL-010 engine findings on costs: parked cash paid equity costs, about 0.5% per park/un-park
  round trip (E5; the change was kept: under the itemised model the liquid fund pays stamp duty
  going in and nothing coming out); a taxed run's final sell-off charged the Rs 16 depository fee
  per lot, not per stock (E12, fixed, under 0.001 point); the model assumes zero brokerage and
  index-level instruments pay equity costs (F18, unverified)
  ([BL-010](../../../backlog/BL-010-momentum-evaluation-review.md)).
- At a 13-week cadence Rs 5 lakh splits into 13 pots of about Rs 38k, so the flat Rs 16 charge
  weighs more than it would live (BL-085 caveat).

## Not yet tested

- Brokerage above zero (F18).

## In plain words

**Trading cost = 0.10% each way (flat).** A simple stand-in for brokerage, taxes on trades and
the gap between buy and sell prices.

**Itemised cost model (optional).** Adds the real line items: securities transaction tax 0.1%,
stamp duty 0.015% on buys, exchange fees about 0.004%, a 5 basis point slippage guess, and a
flat 16 rupees per sale. Measured: costs about 0.7 of a point a year more than the flat model
on ETFs and 2.3 on Broad (which trades far more), and the strategy still wins (TODO 3.9.23).

## Related

- [Tax](tax.md), [cadence](cadence.md) (trading less often cuts costs),
  [top N and exit rank](top-n-exit-rank.md) (the zero-cost check).
