## What it is for

Test a momentum rule over about ten years of history before trusting it. You choose what to
rank, how to rank it, how to hold it and what it costs, then run.

## Before you start

- Pick the dataset in the run bar at the top: **ETF Rotation** or **Broad Momentum**. They
  have different settings; saved runs are kept per dataset.
- Press **Settings** in the run bar (or click any setting's chip) to open the settings drawer
  from the right. **Run** is at the foot of the drawer and in the run bar; Ctrl/Cmd + Enter
  runs from anywhere in the drawer, and the drawer closes once the run has started. **Defaults** at
  the top of the drawer resets every setting.
- No login is needed to backtest. Prices come from the research database, refreshed by the
  scheduled jobs.

> [!TIP]
> Start from the defaults. They are the settings the owner's validation has tested most; the
> chips in the run bar show what the next run tests.

## The controls, section by section

The settings drawer is grouped into sections. Hover the (i) next to any field on the screen for
a one-line reminder.

### Universe & tradability

| Control | What it does |
|---|---|
| Instrument groups (ETF) | Which kinds of ETF may be ranked: Broad, Sector, Thematic, Commodity, International, Debt. |
| Universe (Broad) | Which stocks may be ranked. **As each year saw it** (the default for a new run) uses each year's 750 most-traded stocks, delisted names included in the ranking. In the default category mode a stock is bought only if it carries a category tag, and a company that later failed rarely does (none carries a curated tag, most carry no extended one), so it can be ranked but not bought; *Rank stocks directly* buys any ranked stock. **Today's index list (survivors only)** applies today's Total Market list to every year, which flatters the result. **Whole NSE market (liquid only)** ranks every listed equity that passes the tradability filter. The categories are still today's themes whichever you pick. |
| Pool top N / Pool exit rank (Broad) | How many of the strongest stocks form the pool (default 200), and how far a pool stock may slip before it leaves (250). Refreshed quarterly. |
| Tradability filter | Keeps only stocks with enough daily turnover to buy and sell, that are not stuck at a [circuit limit](glossary:circuit). Uses only data known on each date. Always on for the *As each year saw it* and *Whole NSE market* universes. |
| Respect circuit locks | When on, the backtest cannot buy a stock locked at the upper circuit or sell one locked at the lower circuit. More realistic. |

### Period

**From** and **To** set the test window. The benchmark is not a setting: it is picked on the
result's headline card, and switching it does not need a re-run (see
[Reading backtest results](guide:momentum/backtest-results)). A strategy should beat a cheap
index fund after costs; otherwise there is no point.

### Selection (Broad only)

| Control | What it does |
|---|---|
| Rank categories / Rank stocks directly | Pick sectors first and then their best stocks (default), or skip sectors and rank the pool's stocks on their own. |
| Coverage floor % | A sector counts only if at least this share of its stocks is in the pool (default 40%). |
| Categories held / Sell category when rank > | How many sectors to buy fresh (4), and how far one may slip before it is sold (8). |
| Top stocks per category | How many of each held sector's strongest stocks to own (2). |
| Simulate every week | Trade every week, holding fewer names plus cash when few sectors qualify. Recommended; leaving it off skips weak weeks and flatters the result. |

### Ranking rule

| Option | What it does |
|---|---|
| Rank-sum (default) | Rank each [lookback's](glossary:lookback) return and add the weighted ranks; lowest wins. The lookback table sets the windows and their weights. |
| Volatility-adjusted | Return divided by volatility: prefers steady climbers. See [volatility-adjusted score](glossary:vol-adjusted). |
| Blend | The average of the two. |

The ETF dataset also has a **beaten-down tilt** and a **short-term screen**, experimental
options for mixing in names that fell hard and are turning up. Leave them at 0% unless you are
researching that idea.

### Portfolio rule

| Control | What it does |
|---|---|
| Buffer / Fixed slots | See [Buffer vs Fixed slots](glossary:buffer-slots). Buffer is the default. |
| Wait / Make room | When a new name enters the top N but nothing was sold: wait for cash (default) or trim everything to buy it now. |
| Top N / Sell when rank > | How many to buy, and the [exit rank](glossary:exit-rank). The ETF default is 5 and 10. |
| Rebalance | Every week, every 2 or 4 weeks, or monthly. |
| Fridays: One / All (split) | For a slower cadence (every 2 or 4 weeks). **One** trades a single set of Fridays; **All (split)** runs every set with an equal share of the money each, evens the shares out again each April, and adds them into one account. See [All Fridays](glossary:all-fridays). |
| Which Fridays | With **One**: which set of Fridays. Try each: if they differ a lot, the result owes much to calendar luck. Hidden for **All (split)**, which holds every set. |
| Sell exits weekly, buy only on the cadence | Sell a fallen name the week it falls, but only buy on cadence Fridays. |
| Win-rate position sizing | Buy smaller after a losing streak. Off by default; on its own tests it cost return without cutting risk. |

### Position limits

| Control | What it does |
|---|---|
| Max per holding %, Max per category % | The [position cap](glossary:position-cap) for one holding (35% by default on ETFs) and, on Broad, for everything held through one sector. Broad has its own defaults: the form shows the current values. Tighter is smoother but earns less. |
| Trim when above by (pts) | A holding is only trimmed once it passes its cap by this many points, so it is not trimmed every week. |
| Max price to buy ₹ (Broad) | A stock priced above this cannot be newly bought (a small budget cannot buy one share of a very expensive stock). |
| Skip most volatile % | Never freshly buy the jumpiest share of the ranked list that week. Helped on ETFs in testing; hurts on stocks. |

### Crash protection

**Off** (always invested), **Debt in ranking** (liquid fund and gilt compete like any other
asset and rise to the top in a sell-off), or **Cash filter** (only hold names beating cash).
See [crash protection](glossary:crash-protection).

### Costs, timing & tax

| Control | What it does |
|---|---|
| Cost model | **Flat %** per buy and sell (0.10% default), or **Itemised** real Indian charges (STT, stamp duty, exchange fees, DP charge, [slippage](glossary:slippage)) on an actual rupee capital. |
| Trade | Trade at the signal week's close, or 1–2 weeks later, to see how much acting late hurts. |
| P&L on (ETF) | Measure profit on the index or on the ETF you would actually hold. |
| Fill at | Friday close, Monday open, or Monday 10:00. |
| Apply capital-gains tax / Slab | Deduct Indian capital-gains tax on every sale, using your income-tax slab where needed. |

## Running

Press **Run momentum backtest** (or Ctrl/Cmd + Enter from any field). A badge says
**Changed since last run** when the form no longer matches the result on screen.
**Re-run fresh** ignores the server's caches; use it only when numbers look stale. Every
finished run is saved automatically to [Saved runs](guide:momentum/saved-runs).

## Common questions

**Why does Broad take longer than ETF?** It ranks about 750 stocks every week instead of two
dozen indices. A first run can take a minute; repeats are much faster.

**Which settings matter most?** Top N and the exit rank, the rebalance cadence, costs and tax.
Small changes to lookback weights rarely matter and are the easiest way to overfit.

## What it does not tell you

A good backtest says the rule worked on this history with these costs. It does not say it will
keep working, or that a setting found by trying many is real. See
[Limits & caveats](guide:start/limits) and [reading the results](guide:momentum/backtest-results).
