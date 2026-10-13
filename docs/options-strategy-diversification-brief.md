# Options Strategy Diversification Brief

**Status:** Owner-suggested research brief — hypotheses only, not validated trading advice

**Purpose:** Capture the current options-portfolio problem, the strategy directions worth researching, and a prompt for a stronger LLM to challenge and extend these ideas.

This document records the owner's current thinking. It is intended to be given to another, more powerful LLM for deeper strategy research. It must not be treated as a conclusion that any strategy has an edge.

## 1. Problem statement

The options book is looking at three broad strategy families:

1. **Wide Sell** — a short-premium strategy with a relatively wide stop loss. It is intended to capture theta when NIFTY is choppy, range-bound, or moving slowly in one direction.
2. **NIFTY Directional Sell** — a directional option-selling strategy. It attempts to benefit when the market moves in the intended direction, and includes re-costing: after the first position is stopped or displaced, the strategy can enter again, with a maximum of two attempts in a direction.
3. **Directional Buy** — a range-breakout option-buying strategy. It is intended to participate in a strong breakout, but its standalone profitability is currently considered weak and needs improvement.

The core problem is not simply to discover more strategies. It is to construct a portfolio in which the strategies fail for different reasons.

The desired portfolio should have the following property:

> When one or more short-premium strategies are damaged by a fast move, volatility expansion, gap, or trend, another sleeve should either profit or materially reduce the combined drawdown.

This requires diversification by **risk exposure and market regime**, not merely diversification by:

- another entry time;
- another strike distance;
- another stop-loss percentage;
- another nearby expiry;
- another near-copy of Wide Sell.

The research question is therefore:

> Which additional options strategy families have genuinely different exposures from Wide Sell, NIFTY Directional Sell, and Directional Buy, and how should they be combined and evaluated as a portfolio?

## 2. Current understanding of the existing book

The current strategies can be described by their dominant exposures:

| Strategy | Likely dominant exposure | Intended environment | Main failure environment |
|---|---|---|---|
| Wide Sell | Short gamma, short vega, positive theta | Small range, slow movement, IV stable or falling | Fast trend, gap, IV expansion |
| Directional Sell | Short gamma plus directional delta | Smooth move in the predicted direction | Wrong-way move, fast reversal, gap |
| Directional Buy | Long gamma/delta, usually long premium | Breakout or strong directional expansion | Choppy market, time decay |

These descriptions need to be confirmed from the actual leg definitions and daily P&L, rather than assumed from the strategy names.

The repository's existing correlation work is relevant:

- NIFTY Wide Sell variants are highly similar to one another.
- SENSEX Wide Sell variants are also a related cluster.
- Directional strategies have been closer to neutral against Wide Sell than Wide Sell variants are to one another.
- Buy strategies have shown the strongest opposite relationship to Wide Sell in the initial in-sample read.

These findings are informative, but they are not evidence of future performance. The work is documented in [BL-090 — Strategy correlation and diverse baskets](../backlog/BL-090-strategy-correlation-and-diverse-baskets.md).

## 3. The main portfolio insight

All short-premium strategies can lose together during a sufficiently large or fast move. Therefore:

> A portfolio of several option-selling strategies is not necessarily diversified if all of them are short gamma and short convexity.

To diversify the failure of short premium, the portfolio probably needs at least one sleeve that is:

- long gamma or convexity;
- long volatility in selected conditions;
- exposed to relative volatility or term structure rather than outright direction;
- or based on a different underlying relationship, such as NIFTY versus SENSEX.

There is no requirement that every sleeve be independently profitable every day. A long-volatility sleeve may have negative carry while still being useful if it pays on the worst days of the short-premium book. Its value must therefore be judged at the combined-portfolio level.

## 4. Strategy families worth researching

These are candidate research directions, not recommendations to trade.

### 4.1 Two-sided long-volatility or convexity strategy

Examples:

- defined-risk long strangle;
- ATM or near-ATM straddle substitute;
- double debit spread;
- compression-breakout strategy that buys both sides only when the expected move or realized-range compression justifies the premium.

Why it may diversify the current book:

- It can profit from a large move in either direction.
- It is naturally aligned with the days on which short gamma is most vulnerable.
- It is different from a directional buy because it does not need the breakout direction to be predicted correctly.

Main risks:

- repeated premium decay during quiet markets;
- overpaying for implied volatility before known events;
- poor execution and wide bid-ask spreads;
- a strategy that looks like a hedge but is too small or too far out-of-the-money to pay meaningfully.

### 4.2 Calendar or diagonal spread

Examples:

- sell the near-week option and buy a later-expiry option at the same strike;
- use different strikes to form a diagonal;
- condition the trade on the front-month versus back-month implied-volatility spread.

Why it may diversify the current book:

- Its main exposure is to term structure and relative volatility, not simply spot direction.
- It can benefit from front-expiry decay while retaining some longer-dated vega.
- It may behave differently from same-expiry Wide Sell positions.

Main risks:

- an immediate large move before the short leg decays;
- implied volatility falling in the long leg;
- expiry and liquidity effects;
- the strategy secretly becoming another short-gamma trade if the legs are poorly selected.

### 4.3 Defined-risk directional credit spread

Examples:

- call credit spread after a bearish trend signal;
- put credit spread after a bullish trend signal;
- debit-supported directional premium selling with a fixed long wing.

Why it may be useful:

- It may preserve some of the directional-seller thesis while capping catastrophic loss.
- It can be compared against the current re-costing strategy as a risk-engineering alternative.

Important limitation:

This is not automatically a new source of alpha. If it uses the same entry signal, expiry, and market regime as Directional Sell, its P&L may remain highly correlated. It should be treated initially as a safer implementation variant, not assumed to be a diversifier.

### 4.4 Gap-reversal or opening-range reversal strategy

Examples:

- after a large opening gap, sell a defined-risk spread in the direction of mean reversion;
- wait for the first 15–30 minutes to establish a range, then trade a failure of the opening move;
- use a debit spread when the reversal is confirmed rather than selling naked premium.

Why it may diversify the current book:

- It uses opening-gap and early-session structure rather than all-day theta capture.
- It can profit when a fast opening move reverses, a path that may be different from a trend-following directional seller.

Main risks:

- gap continuation rather than reversal;
- news-driven moves;
- entry slippage during the most volatile part of the session;
- a small sample of qualifying gap days.

### 4.5 Cross-index relative-value strategy

Examples:

- compare NIFTY and SENSEX realized movement;
- compare implied volatility or skew between NIFTY, SENSEX, and BANKNIFTY;
- buy volatility in the relatively cheap index and sell volatility in the relatively expensive index, with defined risk.

Why it may diversify the current book:

- The trade can work from relative divergence even when the overall market direction is unclear.
- It uses index relationship and relative pricing as the driver.
- It is a natural extension of the repository's existing NIFTY and SENSEX data.

Main risks:

- correlations can converge precisely during a market shock;
- different contract specifications and liquidity;
- leg execution risk;
- the trade may accidentally become a directional NIFTY position.

### 4.6 Dispersion or correlation strategy

Examples:

- compare index implied volatility with a basket of constituent implied volatilities;
- buy component volatility and sell index volatility, or the reverse;
- begin with a simplified research proxy before attempting multi-leg live execution.

Why it may be interesting:

- It targets correlation and diversification pricing rather than only NIFTY direction or theta.
- It could provide a genuinely different return driver.

Main risks:

- high data, execution, and margin complexity;
- index/component correlation often changes sharply during stress;
- stock-option liquidity and corporate actions;
- likely outside the first implementation scope.

### 4.7 Event-volatility strategy

Examples:

- defined-risk long volatility before a scheduled event;
- post-event IV-crush strategy after the event risk has passed;
- separate rules for RBI policy, Budget, major global events, and expiry-related events.

Why it may be different:

- It isolates event risk rather than treating every session as interchangeable.
- A long-volatility version may hedge event-day losses in short-premium strategies.

Main risks:

- event premiums may already fully compensate the risk;
- large slippage and unstable spreads;
- small sample size;
- event calendars and contract regimes change over time.

## 5. Recommended research priority

The first research slate should be small and deliberately different:

1. Two-sided long-volatility / convexity strategy.
2. Weekly-versus-monthly calendar or diagonal strategy.
3. NIFTY-versus-SENSEX relative-volatility strategy.
4. Gap-reversal strategy with defined risk.
5. Defined-risk directional credit spread as a risk-control comparison to Directional Sell.

Researching another large grid of nearby Wide Sell timings should be lower priority. The repository has already shown that nearby variants can create the appearance of choice without creating independent risk.

## 6. Portfolio rules to investigate

These should be tested as hypotheses, not hard-coded as final rules.

### 6.1 Cap aggregate short gamma

The portfolio should track aggregate short-gamma exposure or a practical proxy such as:

- total short-premium lots;
- expected loss under a fixed intraday move;
- loss under a volatility jump;
- worst historical one-day loss of the combined short book.

Adding a second short-premium strategy should not automatically increase total short-gamma risk just because it has a different name.

### 6.2 Use a regime governor

Potential regime inputs include:

- opening gap;
- first 15–30 minute realized range;
- India VIX level and intraday change;
- implied versus realized volatility;
- front-month versus back-month IV;
- days to expiry;
- scheduled event flags.

Example hypothesis:

- quiet range plus stable/falling IV: permit more carry strategies;
- fast range expansion plus rising IV: suppress new short-gamma trades;
- low IV plus compression: permit a limited long-volatility sleeve;
- event day: use defined risk and a separate event rule.

Any regime decision must use only information available at the decision time.

### 6.3 Treat the Buy sleeve as portfolio insurance, not only a standalone trade

The current Directional Buy strategy may be weak as a standalone strategy. It should be judged on two dimensions:

1. Its own after-cost expectancy.
2. Its contribution to the combined book on the worst days of Wide Sell and Directional Sell.

The proposed “20% option buying” allocation must be defined precisely. It could mean 20% of premium budget, capital, margin, lots, or risk. Those are materially different. The stronger LLM should force this definition before recommending sizing.

## 7. Required evaluation framework

For every new candidate, report:

- standalone net P&L after charges and slippage;
- daily P&L correlation with each existing strategy;
- loss-day overlap;
- P&L on the current book's worst 5%, 10%, and 20% days;
- combined maximum drawdown;
- drawdown duration and recovery time;
- worst gap and volatility-jump scenarios;
- margin and peak-loss requirements;
- sensitivity to entry time, strike, expiry, and costs;
- results by volatility, gap, trend, range, weekday, and days-to-expiry bucket;
- performance on a genuinely unseen hold-out or forward period.

The most important question is not “Does the candidate have low average correlation?” It is:

> Does the candidate behave acceptably when the existing book is losing badly?

The correlation analysis should include the existing repository tooling and the safeguards in [BL-090](../backlog/BL-090-strategy-correlation-and-diverse-baskets.md). Any new experiment should be pre-registered before running a broad parameter search, consistent with the repository research gate.

## 8. Questions the stronger LLM must answer

The stronger LLM should be asked to:

1. Challenge the assumption that more strategies automatically create diversification.
2. Separate new alpha sources from simple risk-control variations.
3. Classify every candidate by delta, gamma, vega, theta, skew, term structure, gap, and correlation exposure.
4. Identify which candidates are genuinely different from the current three strategies.
5. Propose exact, testable option structures rather than vague names such as “calendar strategy” or “volatility strategy.”
6. Explain which market regimes each candidate should win and lose in.
7. Identify failure clusters where several candidates would lose together.
8. Suggest a small research slate instead of an uncontrolled strategy explosion.
9. Design a look-ahead-safe, transaction-cost-aware backtest plan.
10. Define portfolio-level acceptance and kill rules before examining results.
11. Say what data is missing, especially IV surface, bid-ask, event, and constituent-option data.
12. Distinguish strategies suitable for the existing intraday research engine from strategies that require a new data or execution layer.
13. Recommend how to use a long-option sleeve without disguising a consistently negative-expectancy strategy as a hedge.
14. Explicitly reject strategies that are merely renamed versions of Wide Sell.

## 9. Copy-paste prompt for a stronger LLM

```text
You are a senior quantitative options researcher and portfolio architect. I am building a personal research system for NSE index options, mainly NIFTY and SENSEX. I want a rigorous research memo, not generic trading advice and not a list of fashionable option strategies.

My current strategy families are:

1. Wide Sell: a short-premium strategy with a relatively high stop loss. It is intended to capture theta during choppy, range-bound, or slowly moving markets.
2. NIFTY Directional Sell: a directional option-selling strategy with re-costing. It may try twice in one direction after a loss or stop.
3. Directional Buy: a range-breakout option-buying strategy. Its standalone profitability is currently weak, but it may provide convexity during strong moves.

My actual problem is portfolio diversification. I do not want ten versions of the same short-gamma trade. I want strategy sleeves that fail for different reasons. When Wide Sell and Directional Sell are hurt by a fast move, gap, volatility expansion, or trend, another sleeve should ideally profit or materially reduce the combined drawdown.

The owner is considering allocating roughly 20% of the options risk budget to option buying, but this percentage is not yet well defined. Treat that as an open question. Explain whether the allocation should be defined by premium paid, capital, margin, lots, or stress loss.

Repository context:

- The project has an options backtesting engine using 1-minute data, a leg-wise strategy engine, daily P&L, walk-forward tools, regime buckets, overfitting checks, and correlation analysis.
- Existing correlation work found that nearby Wide Sell variants are highly correlated. Directional strategies are closer to neutral against Wide Sell, and Buy strategies have shown the strongest opposite relationship in an initial in-sample analysis.
- That result is only exploratory and must not be treated as proof.
- The repository requires pre-registration before broad searches and is concerned about look-ahead bias, data snooping, survivorship, slippage, charges, and stale data.

Think through the problem from first principles.

First, classify the current strategies by their likely exposure to delta, gamma, vega, theta, skew, term structure, gap risk, and correlation risk. State which assumptions need to be verified from the actual leg definitions.

Then propose 8–12 candidate strategy families, including but not limited to:

- two-sided long volatility or convexity;
- calendars and diagonals;
- defined-risk directional credit spreads;
- gap-reversal strategies;
- cross-index relative value;
- dispersion or correlation strategies;
- event-volatility strategies;
- other ideas you believe are materially different.

For every candidate provide:

- exact payoff structure and legs;
- directional, volatility, and time-decay exposure;
- market regimes in which it should win;
- market regimes in which it should lose;
- why it is or is not genuinely different from the current three families;
- likely correlation with each existing strategy;
- the main tail risk;
- required data and execution assumptions;
- whether the current backtesting engine can model it;
- whether it is a strategy, a hedge, or merely a risk-control implementation;
- how it could be accidentally overfit.

Do not assume that low average correlation is enough. Design portfolio tests using:

- loss-day overlap;
- P&L on the current book's worst 5%, 10%, and 20% days;
- combined maximum drawdown;
- drawdown duration and recovery time;
- high-VIX and volatility-jump behavior;
- opening-gap behavior;
- charges, slippage, and margin;
- an unseen hold-out or forward period.

Recommend a small first research slate of no more than three candidates. Explain why each is a different risk source and why the others should be deferred.

Create a pre-registration template for each shortlisted candidate. Include:

- hypothesis;
- universe;
- exact entry and exit rules;
- information available at the decision time;
- data-quality requirements;
- costs and slippage;
- sizing;
- comparator strategies;
- acceptance rule;
- kill rule;
- hold-out period;
- what parameter searches are forbidden after seeing results.

Challenge my assumptions aggressively. In particular:

- Tell me if the 20% option-buying idea is poorly defined.
- Tell me if the proposed candidates are secretly all short gamma.
- Tell me if the current Directional Buy strategy is a bad hedge despite being negatively correlated.
- Tell me what would happen if all short-premium strategies failed on the same gap day.
- Tell me which ideas are not practical with Indian index-option liquidity, expiry, and execution constraints.

Finish with:

1. A ranked shortlist of three strategies to research.
2. A portfolio architecture showing carry, directional, convexity, and relative-value sleeves.
3. A list of metrics the existing system should add if they are missing.
4. The exact next research experiment, written so an engineer can implement it without guessing.
5. A list of reasons why the entire idea should be rejected if the data does not support it.

Do not recommend live trading. This is a research design exercise.
```

## 10. Useful follow-up prompts for the stronger LLM

After the first answer, ask targeted follow-ups rather than asking it to keep generating more strategies.

### Follow-up A — expose hidden correlation

```text
Take your proposed strategies and build a failure-mode matrix. For each pair, describe whether they lose together during: a slow trend, fast trend, opening gap, IV expansion, IV crush, expiry pinning, and an event shock. Remove every candidate that is only cosmetically different from Wide Sell.
```

### Follow-up B — convert ideas into testable structures

```text
Convert the top three candidates into exact leg-wise rules suitable for a 1-minute bar backtest. Specify strikes by delta or moneyness, expiry selection, entry time, exits, stops, re-entry rules, position sizing, and the information allowed at every decision point. Do not use parameters that cannot be observed in the available data.
```

### Follow-up C — portfolio-level test

```text
Design a portfolio experiment comparing the existing three-strategy book with each proposed addition. The primary metric is improvement in combined worst-day loss and maximum drawdown after costs, not standalone CAGR. Define the comparator, hold-out, minimum sample size, and kill rule before any result is inspected.
```

### Follow-up D — data and implementation gap

```text
Review the proposed strategy families against the current repository capabilities. Separate what can be tested immediately using existing 1-minute NIFTY/SENSEX option data from what requires IV surface, bid-ask, constituent options, event calendars, or a new execution model. Recommend the smallest engineering change for each missing capability.
```

## 11. Current research stance

The current stance should be:

- do not change live or paper-trading allocations from this document;
- do not infer an edge from standalone win rate;
- do not add a strategy merely because its average correlation is low;
- do not count nearby times or strikes as independent strategies without evidence;
- prefer defined-risk structures while the failure modes are being learned;
- evaluate the candidate as part of the whole book;
- pre-register the experiment before broad parameter searches;
- keep a genuine unseen or forward evaluation period.

NSE contract specifications and expiry conventions can change, so any research using weekly/monthly term structure must pin the contract regime and calendar used in the test. See the [NSE equity-derivatives contract specifications](https://www.nseindia.com/static/products-services/equity-derivatives-contract-specifications).

This brief is a starting point for deeper analysis. It is not a trading plan, performance claim, or recommendation to deploy any strategy.
