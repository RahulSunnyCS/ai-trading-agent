This dashboard is a **research workbench** for Indian markets. It answers one question over and
over: *would this trading rule have worked, and how sure can we be?* It is used by its owner and
a few friends, and it is free.

## What it does

There are three products inside it:

| Product | In one line | Where |
|---|---|---|
| **Momentum** | Each Friday, rank ETFs or stocks by how strongly they have been rising, hold the leaders, sell the ones that fall back. Backtest the rule over ten years, and get the weekly buy/sell list. | [Momentum](app:/momentum/backtest) |
| **Options Lab** | Build an intraday index-options strategy leg by leg (for example a short straddle with a stop loss), and test it on real 1-minute option prices, day by day. | [Options Lab](app:/optionslab/results) |
| **Data & operations** | The jobs that collect market data every day, the broker logins they need, and the settings. | [Jobs](app:/jobs) |

## What it does not do

- **It places no orders.** Real trades are placed by hand, or by strategies on
  [AlgoTest](glossary:algotest), outside this tool.
- **It is not advice.** A [backtest](glossary:backtest) shows how a rule behaved on past
  data. Read [Limits & caveats](guide:start/limits) before trusting any number.

## Who this Guide is for

You should know what a call and a put are, what a straddle is, and what CAGR roughly means. You
do not need to know anything about this tool. Terms with a dotted underline, like
[max drawdown](glossary:max-drawdown), show their meaning when you hover them; the
[Glossary](guide:glossary/terms) has them all.

## How the Guide is organised

- **Start here**: this page, a [tour of the screens](guide:start/tour),
  [what runs each day and week](guide:start/daily-routine), and the
  [limits](guide:start/limits).
- **Momentum** and **Options Lab**: first an explainer of how the strategy works, then one page
  per screen, then step-by-step walkthroughs.
- **Data & operations**: the Overview, Jobs, Broker logins, Coverage and Settings screens.
- **Glossary**: every term in plain words.

Every screen page follows the same order: what it is for, what it needs before you start, the
controls, how to read the results, common questions, and what it does not tell you.

> [!TIP]
> On any screen, the **How this works** link at the top right opens that screen's page in this
> Guide.

## Screens you can ignore

The **Live** group in the sidebar (Live, Trades, P&L, Personalities, Regimes) and **Billing**
belong to an earlier experiment, an automatic paper-trading engine, that is paused. They still
work but are not developed and are not covered here. You can hide them in
[Settings](app:/settings).
