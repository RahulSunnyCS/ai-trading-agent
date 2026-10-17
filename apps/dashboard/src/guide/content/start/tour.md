A one-paragraph tour of every screen in the sidebar. Each heading links to the screen; each
"Guide" link opens its full page.

## The top bar

Every screen has the same top bar: a link to that screen's Guide page, the live system status,
and the **bell**, which lists anything that needs you (a stock to classify, data not ready, a
missing journal entry, a saved result that moved, a live-money rule) and pops up once a day.
[Guide](guide:start/alerts)

## Overview

The landing screen. One card per daily question: is the market open, is the Fyers login valid,
did this week's momentum signal go out, did last evening's options run succeed. Each card links
to the screen with the detail. [Open](app:/overview) · [Guide](guide:operations/overview)

## Options Lab

The sidebar groups it into three workspaces (what to check today, data to explore, and strategies to
build and test) and an Advanced group at the end.

| Workspace | Screen | What it is for |
|---|---|---|
| Today | [Today](app:/optionslab/rotation) | How the rotation lists are doing on days nobody had seen, and today's picks. [Guide](guide:optionslab/rotation) |
| Explore data | [Heatmap](app:/optionslab/heatmap) | What an ATM short straddle made at each entry time and stop loss. [Guide](guide:optionslab/heatmap) |
| Explore data | [Matrix](app:/optionslab/matrix) | Where the strategy variants make or lose money, by start time, date and condition. [Guide](guide:optionslab/rotation-matrix) |
| Explore data | [Correlation](app:/optionslab/correlation) | Which strategies lose on the same days. [Guide](guide:optionslab/correlation) |
| Build and test | [Strategies and baskets](app:/optionslab/strategies) | The rotation baskets and the saved strategies the evening run tests every trading day, each with its latest result; star your favourites. [Guide](guide:optionslab/strategies) |
| Build and test | [Builder](app:/optionslab/builder) | Build a strategy leg by leg, backtest it over a date range, save it. The advanced YAML engine writes strategies as text instead. [Guide](guide:optionslab/builder-form) |
| Build and test | [Runs](app:/optionslab/runs) | Every backtest run in one list; tick two to compare. [Guide](guide:optionslab/runs) |
| Advanced | [Regimes](app:/optionslab/regimes) | Labels each day Quiet, Chop, Trend up or Trend down, and tests whether those labels last. [Guide](guide:optionslab/regimes) |

The evening run's status and its **Run** button are at the top of Today.

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

- [Live](app:/live) — spot, VIX and two straddles, minute by minute; a replay of a collected day until live capture exists.
  [Guide](guide:operations/live)
- [Coverage](app:/coverage) — historical candle backfill for the paused live engine.
  [Guide](guide:operations/coverage)
- [Jobs](app:/jobs) — every scheduled job, when it runs, how its last run went.
  [Guide](guide:operations/jobs)

## Account

- [Broker logins](app:/brokerLogins) — the daily Fyers market-data login and the Angel One connection check.
  [Guide](guide:operations/broker-logins)
- [Settings](app:/settings) — appearance, defaults, which tabs show, Telegram alerts.
  [Guide](guide:operations/settings)
