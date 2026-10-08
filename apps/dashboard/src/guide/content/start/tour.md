A one-paragraph tour of every screen in the sidebar. Each heading links to the screen; each
"Guide" link opens its full page.

## Overview

The landing screen. One card per daily question: is the market open, is the Fyers login valid,
did this week's momentum signal go out, did last evening's options run succeed. Each card links
to the screen with the detail. [Open](app:/overview) · [Guide](guide:operations/overview)

## Options Lab

| Screen | What it is for |
|---|---|
| [Strategies](app:/optionslab/strategies) | The saved strategies the evening run tests every trading day, with each one's latest result. [Guide](guide:optionslab/strategies) |
| [Builder](app:/optionslab/builder) | Build a strategy leg by leg, backtest it over a date range, save it. A YAML mode writes strategies as text instead. [Guide](guide:optionslab/builder-form) |
| [Runs](app:/optionslab/runs) | Every backtest run in one list; tick two to compare. [Guide](guide:optionslab/runs) |
| [Daily results](app:/optionslab/results) | How every saved strategy did on every collected day, with a minute-by-minute replay of any day. [Guide](guide:optionslab/daily-results) |
| [Regimes](app:/optionslab/regimes) | Labels each day Quiet, Chop, Trend up or Trend down, and tests whether those labels last. [Guide](guide:optionslab/regimes) |

## Momentum

| Screen | What it is for |
|---|---|
| [Backtest](app:/momentum/backtest) | Choose a dataset (ETF Rotation or Broad Momentum), set the rules, run a ten-year backtest and read the result. [Guide](guide:momentum/backtest-settings) |
| [Scores](app:/momentum/scores) | Today's momentum score of every stock and sector. [Guide](guide:momentum/scores) |
| [Saved runs](app:/momentum/saved) | Every backtest you have run; mark favourites, choose which one Telegram follows. [Guide](guide:momentum/saved-runs) |
| [This week](app:/momentum/week) | Friday's buy and sell list, and whether the data is ready for it. [Guide](guide:momentum/this-week) |
| [Rebalance](app:/momentum/rebalance) | Type in what you hold; see the trades that would match the model. [Guide](guide:momentum/rebalance) |
| [Journal](app:/momentum/journal) | The permanent record of every weekly signal as it was produced. [Guide](guide:momentum/journal) |

## Data

- [Coverage](app:/coverage) — historical candle backfill for the paused live engine.
  [Guide](guide:operations/coverage)
- [Jobs](app:/jobs) — every scheduled job, when it runs, how its last run went.
  [Guide](guide:operations/jobs)

## Account

- [Broker logins](app:/brokerLogins) — the daily Fyers market-data login.
  [Guide](guide:operations/broker-logins)
- [Settings](app:/settings) — appearance, defaults, which tabs show, Telegram alerts.
  [Guide](guide:operations/settings)
