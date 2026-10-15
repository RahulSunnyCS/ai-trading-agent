# Momentum: position caps, cap band, category cap, price ceiling, minimum trade

**Status:** Tested · **Last updated:** 2026-10-14

## What it is

Limits on how much money one holding (or one category) can take, and small-trade guards.

| Parameter | Default (where) | Mechanism | Grade |
|---|---|---|---|
| `max_position` | 0.35 (Config, API, Live). Broad UI 0.15 | No holding is bought or topped up past it | M, TODO 3.9.23 |
| `cap_band` | 0.05 | Trim back to the cap only once over cap + band. Avoids a trade and tax event on small drifts | R |
| `max_group` (UI "max category") | None in Config; Broad UI 0.30 | Cap on all stocks held through one category (category mode on only) | M, TODO 3.9.23 |
| `max_stock_price` | Broad UI 20,000 rupees; 0 = off | Entry-only block via `no_buy`: a stock priced above it cannot be newly bought; a held one is kept and topped up | M, TODO 3.9.23 |
| `MIN_TRADE` | 0.5% of portfolio (engine constant) | Parked cash is not moved for less. Avoids dust trades | R |

## Live value

- ETF rotation: `max_position = 0.35`, cap band 0.05 (`live_config.toml`, engine default).
- Broad, a new dashboard run: 15% per stock, 30% per category, Rs 20,000 ceiling
  (`categories/broad.py` `DEFAULT_MAX_POSITION`, `DEFAULT_MAX_CATEGORY`, `DEFAULT_MAX_STOCK_PRICE`).
- Broad search: `max_position` one of 0.2, 0.25, 0.35, 0.5, none; `max_stock_price` fixed at
  10,000; `cap_band` fixed at 0.05
  ([`round7_A.toml`](../../../packages/momentum-backtesting/search_spaces/round7_A.toml)). Round 1
  also searched `max_category` (none, 0.2, 0.3, 0.4) and `cap_band` 0.02 to 0.1
  ([`round1_A.toml`](../../../packages/momentum-backtesting/search_spaces/round1_A.toml)).

## Tested

| Item | Values tried | Data / period | Verdict | Evidence |
|---|---|---|---|---|
| TODO 3.9.23 dry run | ETF `max_position` 0.25, 0.50, none | ETF, 2017-01 to 2026-09, 28 rolling 3-year windows | A risk/return dial, confirmed | 0.25: rolling 32 / 71 / 64%. 0.50: 75 / 68 / 32% (median +0.6). No cap: 82 / 68 / 32% (+1.0; one ETF once reached 84%) |
| TODO 3.9.23 dry run | Broad `max_position` 0.10, 0.25 | Broad, every week simulated | A dial | 0.10: 7 / 79 / 100% (median -2.8, MaxDD -16.1%). 0.25: 43 / 29 / 14% |
| TODO 3.9.23 dry run | Broad `max_group` removed | same | The cap costs a little and buys nothing measurable | 32.0% / 1.07 / -20.2%, rolling 71 / 75 / 68%, median +0.4 |
| TODO 3.9.23 dry run | Broad `max_stock_price` removed | same | An affordability rule, not alpha | 32.3% / 1.08 / -20.3%, rolling 54 / 57 / 50%, median +0.3 |

## What we know

- Without a cap the buffer rule concentrates in long-running leaders: one ETF reached 84% of the
  portfolio in the default backtest. At 35% the largest position stays at or under 40%, for about
  1.3 points less CAGR and a slightly better Sharpe (package `README.md`, "Position cap").
- Tighter caps smooth the ride and cost return; looser caps do the opposite. Neither wins on both.
- Removing Broad's 30% category cap or its Rs 20,000 ceiling gains a median 0.4 and 0.3 points
  a year. The category cap buys nothing measurable; the ceiling is an affordability rule, not alpha.

## Not yet tested

- `cap_band` values other than 0.05 under the rolling-window rule (round 1 searched them, pre-fix).

## In plain words

**Position cap = 35% (ETF), 15% per stock and 30% per category (Broad Momentum).** No single
holding may grow past this share. Without it, one ETF once reached 84% of the portfolio.
Measured: a tighter cap gives a smoother ride and a lower return; a looser cap does the
opposite. It is a dial, not free money (TODO 3.9.18).

**Cap band = 5 points.** A holding is only trimmed back once it is 5 points over its cap.
Stops a trade, and a tax bill, every time a winner drifts over by a hair.

**Max price to buy = 20,000 rupees (Broad Momentum).** With a small budget you cannot afford a
first share of a very expensive stock. It only blocks new buys. A stock you already own is kept.
It costs about a third of a point a year, which is the price of the budget, not a mistake.

## Related

- [Portfolio rule and entry](portfolio-entry.md), [sizing](sizing.md),
  [Broad funnel](../strategies/broad/funnel.md).
