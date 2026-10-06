# How a momentum backtest runs on the backend, and how we made it faster

> **As of 2026-10-07**, written against the code after BL-005 Phases 1-4 (PRs #56, #70, #73, #81).
> The code and `packages/momentum-backtesting/CLAUDE.md` are the source of truth: schedule times,
> defaults and table sizes below are accurate for that date and will drift. Figures that came from
> the live data are labelled with their date.

This document is for someone who knows the product from the outside and has never read the
backend. It explains, in order:

1. what a backtest is here, and the path one request takes;
2. **where the data comes from and how it is captured, cleaned and stored**;
3. **how every number is calculated** (ranking, the weekly simulation, costs, tax, the metrics);
4. how the four datasets differ (ETF, Stock, Custom Index, Broad Momentum);
5. why a Broad run took 55 seconds, and **what we changed on the backend to fix it** (BL-005);
6. how we know no result moved while we did it.

For each part that changed, it says **how it worked before** and **what it does now**. File names
are given so you can look at the code, but you do not need to read any to follow this.

Numbers in this document were measured, not estimated, and say where and how. Where something
could not be measured, it says so.

---

## 1. What a backtest is, and the path of one request

A **backtest** asks: "if I had followed this rule every week since 2017, what would have
happened?" The rule here is *weekly momentum rotation*: each Friday, rank a list of things
(sector indices, stocks) by how well they did recently, hold the best few, sell the ones that
have fallen too far down the ranking. The backtest replays that rule week by week over the
stored price history and records every buy and sell, the costs and tax, and the resulting
growth of money.

Nothing in the backtest places real orders. It is a calculation over stored data.

### The path of one request

```
Browser (the dashboard)
   │  "Run backtest" with the settings
   ▼
Fastify proxy (apps/server)            only forwards; validates the shape of the URL
   ▼
Momentum API (Python, FastAPI)         packages/momentum-backtesting/src/momentum_backtesting/api.py
   │  1. start a background JOB and answer at once with a job id
   │  2. the job thread: load data → rank → simulate → analyse
   ▼
Engine (engine.py)                     the weekly simulation: the actual "backtest"
   ▼
Analysis (analysis.py)                 turns the simulation into what the screen shows
   ▼
Result (JSON)  ──►  the dashboard polls the job until it is done, then draws it
```

Four ideas to keep in mind through the rest:

- **The engine works on a weekly table.** Rows are weeks (labelled by that week's Friday),
  columns are things you can hold (an index, a stock), cells are closing prices. Everything is
  derived from that table.
- **Preparing the table is slow, running the rule over it is fast, and reading it badly is slow
  again.** Most of the speed-up came from the third part.
- **Caches** keep expensive intermediate results (the loaded table, the rankings) so a second
  run does not redo them. A cache is only safe if it forgets exactly when the data changes.
- **A result must never change because of speed work.** That rule shaped how every change was
  made and checked (Part 6).

---

## 2. Where the data comes from and how it is captured

### 2.1 The four datasets and their sources

| Dataset | What it ranks | Where the prices come from |
|---|---|---|
| **ETF rotation** | 26 instruments listed in `universe.csv`: 21 core (4 broad indices, 12 sectors, Defence, Gold, Silver, Nasdaq 100, Hang Seng), 3 optional, 2 defensive (a liquid fund and a gilt fund) | Daily candles from the **Fyers** history API for NSE indices; extended backwards from **niftyindices.com** where Fyers starts late; **AMFI** fund NAV for the cash series; **Yahoo** index closes times the exchange rate for Nasdaq 100 and Hang Seng; COMEX silver times the rupee rate, spliced onto the SILVERBEES ETF; Gold through the GOLDBEES ETF |
| **Stock** (Nifty 50) | The 95 companies that were ever in the Nifty 50, with the right members in each year | **NSE bhavcopy** (the exchange's daily price file) from 2011, **NSE corporate actions**, and **niftyindices.com** total-return indices |
| **Custom Index** | About 62 categories (16 official sector/thematic indices plus ~46 custom ones). Each category is first run through its own mini-backtest; its growth curve becomes a price column, and the categories are then ranked like ETFs | The same bhavcopy price lake, plus category membership lists |
| **Broad Momentum** | Every stock in a wide universe (about 755 names for "Total Market"), through a multi-step funnel (Part 4) | The same bhavcopy price lake |

History starts in **2016** for the ETF table (a year before the 2017 backtest start, so the
52-week lookback has data from January 2017) and in **2011** for stocks.

**Fyers login.** Fyers gives a token that dies at the next 06:00 IST regardless of what it
says. A scheduled job logs in at 08:05 on trading days and stores the token; the code looks for
a token in four places in order (the dashboard login, environment variables, a token file,
a local cache from `mbt login`).

### 2.2 The commands that capture it, and how often they run

| Command | What it does | When |
|---|---|---|
| `mbt fetch` | For each instrument in `universe.csv`: fetch daily prices (Fyers, backfilled from niftyindices where needed), write `data/daily/<name>.csv`, resample to weekly, drop the unfinished current week, fetch the traded ETFs and their premium to NAV, write `data/weekly_closes.csv`. About 5 minutes | **Manual** (nothing schedules it) |
| `mbt stocks fetch` | Download NSE bhavcopies for every trading session, fetch corporate actions by quarter, rebuild `data/stocks/daily.parquet`, then clean and adjust (2.3). Exits non-zero if a data-quality guard of severity F fails | Part of `stocks sync` |
| `mbt local migrate` | Copy those files into the shared database (2.5). Every target table is **replaced**, not appended to | Part of `stocks sync` |
| `mbt stocks sync` | `stocks fetch` followed by `local migrate`. The second step is mandatory, because readers prefer the database once it has rows | **Friday 19:30 IST**, by the scheduler |
| `mbt weekly` | The weekly signal run. Refreshes only the **last 20 days** of ETF prices (Fyers first, then niftyindices, then an ETF-implied estimate), rebuilds the recent rows of the weekly table, pushes them to the database | **Friday 14:40** (preview) and **16:45** (final), then re-run at 19:30 for the stock datasets |
| `mbt categories fetch` / `fetch-universe` | Category and Total Market membership lists | **Manual** |

Other scheduled jobs: Friday 21:00 checks that every favourite recorded its signal; the first
Sunday of the month backs the database up to an external disk.

**When NSE blocks us.** NSE's site sometimes refuses scripted requests. `stocks sync` then falls
back to Fyers for the missing week: for the current Nifty 50 members it writes plain closes, and
for the ~755 Total Market names it writes Fyers daily bars flagged `synthetic_close`. These
stopgaps are replaced by the next successful real sync.

### 2.3 Cleaning and adjusting the prices

Raw prices lie in several ways. The code corrects for each.

**Splits, bonuses, dividends (Nifty 50 layer).** A stock that splits 5-for-1 drops 80% overnight
without anyone losing money. The return for each day is computed as

```
return_t = ( price_t / share_factor_t + dividend_t ) / price_(t-1)
```

where `share_factor` is the split/bonus ratio on that day and `dividend` the per-share dividend
(per pre-event share). The result is a **total-return series** that starts at 1.0 and compounds.
Demergers, rights issues and schemes use a neutral rule (return = 1.0 on that day) because they
cannot be valued as a simple split. Corporate-action text from NSE is parsed automatically for
splits, bonuses and rupee dividends; everything else is tagged "manual only" and entered by hand
in `stocks/curated/actions_manual.csv`. The raw bars in the database are **not** split-adjusted.

**Gaps.** If one trading session is missing, a synthetic row is filled in (flagged
`synthetic_close`). Two or more consecutive missing sessions fail the run.

**Guards** (`stocks/guards.py`). Severity **F** stops the run; severity **G** only flags it. F
covers: a missing-session gap, a break in price continuity (yesterday's close must equal today's
"previous close"), unresolved corporate actions, a wrong number of index members in a week
(50, or 51 inside demerger windows), and any unexplained one-day move above 20%. G flags
single synthetic fills, suspensions longer than 3 sessions, and dividend yields outside 0-15%.

**Survivorship-free membership.** A backtest that only ranks today's Nifty 50 would quietly
exclude every company that fell out, which flatters the result. `nifty50_membership.csv` lists
who was in the index and when (105 rows, citing archived NSE lists), and the engine may **buy**
only current members that week. Delisted companies leave at their last traded close.

**The Broad / Custom Index price builder** (`categories/prices.py`):

1. Load daily closes (from the database, or the parquet file).
2. Back-adjust earlier closes by confirmed split/bonus factors.
3. Flag a possible corporate event: a close that falls at least **15%** while turnover rises by
   less than 3×. (A real crash comes with a volume spike; a split does not.)
4. Drop events a reviewer has classified as genuine crashes.
5. Keep only events that match a filed corporate action nearby ("verified" mode, the default).
6. At each kept event, start a **new column** (`SYMBOL#2`, `#3`, ...) so a corporate action
   cannot look like a loss.
7. Forward-fill columns whose own data has ended, so a held position never turns into "no
   price" mid-run (they are also made unbuyable).

**An honest limitation.** The "Total Market" list of ~755 names is today's list, applied to
every year since 2016 (all rows are tagged `constant_current`). That carries survivorship. The
Broad options `all_liquid` and `turnover_rank` avoid it by taking membership from the price
data itself.

### 2.4 From daily prices to the weekly table

Every source is fetched **daily** and then resampled: for each calendar week (Monday to Sunday),
take the **last** close, and label the week by its **Friday**. If Friday is a holiday, Thursday's
close carries the Friday label. The unfinished current week is dropped. A series that starts
late stays empty until it exists, and joins the ranking once it has enough history.

This weekly table is the single input the engine reads. For ETFs it is `weekly_closes.csv`
(and its database twin); for stocks, the stock weekly tables.

### 2.5 Where it is stored

**The shared database** lives in `TRADING_DATA_ROOT` (on the owner's machine, an external disk).
It has two parts:

- **`catalog.duckdb`**: a file database (DuckDB). Only one process can write it at a time, so
  connections are short. The tables backtests read:

  | Table | Holds | Size on the live data (2026-10-07) |
  |---|---|---|
  | `momentum_prices` | ETF/index/weekly price series, by `kind` | 140,209 rows |
  | `stock_weekly_prices` | Nifty 50 total-return and price series, weekly | 142,258 rows, 95 companies |
  | `stock_membership_weekly` | Who was in the Nifty 50 each week | 76,403 rows |
  | `stock_weekly_series` | The benchmark total-return indices and cash | 7,395 rows, 9 series |
  | `category_membership` | Category and Total Market membership, by year | 10,754 rows |
  | `corporate_actions` | Splits, bonuses, dividends, ... | 1,886 rows |
  | `instruments` | One row per tradable thing | 4,305 stock instruments |
  | `stock_action_candidates` / `_reviews` | Large drops matched to filed actions, and the reviews of them | 3,199 candidates |

- **The parquet lake**: daily bars for every stock, one file per year,
  `lake/bars_1d/asset=stock/year=2024/data.parquet`, exposed to queries as the view
  `bars_1d_stock`. Columns: instrument, date, series, open, high, low, close, previous close,
  volume, turnover, `synthetic_close`. On the live data: **6,918,419 bars from 2011-01-03 to
  2026-10-01**.

**The `data/` folder** (not in git) holds files backtests still read directly: the daily CSVs
used to price trades (`daily/`, `daily_etf/`), `etf_premium.csv`, and the category and stock
files.

**The database is preferred, the file is the fallback.** Each reader (`db_read.py`) returns
"nothing" when the catalog is missing or empty, and the caller then reads the file. That keeps a
fresh checkout and the tests working without a database.

---

## 3. How the numbers are calculated

Everything in this part happens inside `engine.py`, on the weekly table from Part 2.4. Default
values are the engine's; the dashboard sets different defaults for some datasets (Stock uses
`top_n` 10 and `exit_rank` 20, for example).

### 3.1 Ranking: who is "best" this week

Each instrument gets a rank (1 = best) each week from its recent returns.

**Step 1: returns over several lookbacks.** `lookbacks` are in **weeks**; the default is
`(1, 4, 13, 26, 52)`. For each lookback `k`:

```
return_k = price_now / price_k_weeks_ago - 1
```

An instrument is **eligible** only if it has a price for every lookback, so with the defaults it
needs at least 53 weekly closes.

**Step 2: rank each lookback, then add the ranks ("ranksum", the default).** For every lookback,
rank all eligible instruments (highest return = rank 1; ties share the lower rank). Then
`score = sum of (weight × rank)` across lookbacks, and **the lowest score is best**. Equal
weights by default. (Negative weights are allowed on purpose: they reward the worst recent
performers, a reversal signal.)

A worked example with three lookbacks (1, 4, 13 weeks) and equal weights:

| | 1-week | 4-week | 13-week | ranks in each | score |
|---|---|---|---|---|---|
| A | +2% | +5% | +20% | 2, 2, 1 | 5 |
| B | +6% | +4% | +10% | 1, 3, 3 | 7 |
| C | −1% | +9% | +15% | 3, 1, 2 | 6 |

Lowest score wins, so the final order is **A (1), C (2), B (3)**.

**Step 3: ties.** If two scores tie, the higher return over the middle lookback wins (the
13-week one by default); if still tied, the name that sorts first alphabetically. Every
instrument therefore gets a unique rank 1..N each week. (This is done with one sort per week.)

**Alternative scores.** `voladj` (the NSE-style method) divides the 6-month and 12-month returns
by the stock's volatility (the standard deviation of the last 26 weekly returns), converts each
to a z-score across that week's eligible names, and adds them; higher is better. `blend` averages
the ranksum and voladj ranks and re-ranks. *A note for the curious:* the voladj docstring says
the "skip the most recent month" option excludes the last four weeks; the code actually lengthens
the window by four weeks (it measures from the price 30 and 56 weeks ago to **today**). That is
how it has always behaved and no result was changed by the speed work.

### 3.2 The weekly simulation loop

For each week from the start date to the second-last week (the newest week is never traded),
in this order. `top_n` (default 5) is how many names are **bought**; `exit_rank` (default 10) is
how far down a held name may slide before it is **sold**. The gap between them is a buffer that
stops constant churn (it is called *hysteresis*).

**Which prices.** Rankings use the weekly signal prices. Trades fill at a separate price: by
default Friday's close; or the next Monday's open (`mon_open`); or Monday 10:00. A holding's
weekly return is next week's fill price over this week's.

**Which weeks may trade.** Normally every week. `rebalance_every` > 1 trades only every n-th
week (counted from a fixed calendar start, not from the run's start); `monthly` trades on the
last week of each month. Weeks with no trade only revalue what is held.

**The buffer rule (the default portfolio), each trading week:**

1. **Sell** every holding whose rank is worse than `exit_rank`, or has no rank, or (in `filter`
   mode) whose return is below cash. 100% of the position is sold; the money joins "proceeds"
   after costs and tax. A stock locked at its lower circuit cannot be sold (Part 4).
2. **Trim** any holding that grew past `max_position` plus a tolerance band: e.g. with a 35%
   cap and a 5-point band, a holding at 41% is cut by `1 − 0.35/0.41 = 14.6%` back to 35%; one
   at 38% is left alone (but gets no new money).
3. **Bring parked cash back** if the top names can absorb it.
4. **Split the available money equally across the current top `top_n` names** that have room
   under the cap. Each purchase is recorded as BUY (new name) or ADD (already held). Money no
   name can take is parked in the liquid fund (PARK). Existing holdings are **not** equalised:
   only new money is split, so weights drift between trades.
   *Example:* a sale nets 12% of capital, less a 0.1% cost = 0.11988. Five top names with no caps
   each receive 0.023976.
5. **Optional rules.** `momentum_sizing` shrinks how much is invested after a run of losing
   trades (it scores the last N closed trades, newest weighted most: win, loss, win scores 66.7%
   and invests in full; loss, loss, win scores 29.6% and invests 59%). `entry = make_room` buys a
   new top name by trimming every holding by `1/(count+1)` instead of waiting for cash.

**The slots rule (alternative)** is simpler: `top_n` equal slots of `1/top_n`. A slot whose
holding falls out of the buffer is sold and refilled by the best top name not already held; no
caps, no top-ups.

**Defensive money.** Idle money sits in the liquid-fund pool. In `ranked` mode, cash and gilt
join the ranking like any other instrument. In `filter` mode a name is only held while its
return beats cash.

**The trade log.** Every action appends a row: week, action (BUY, SELL, ADD, TRIM, PARK, UNPARK),
asset, its rank that week, value (as a fraction of starting capital), reason, tax, and for real
fills the fill price, units traded, units before, and cost. SELL rows also carry the entry week,
weeks held and the position's return. Everything the screen shows is derived from this log and
the weekly equity.

**End of run.** If tax is on, all open positions are "sold" at the last week so open gains are
taxed in the final figure.

### 3.3 Costs and tax

**Flat cost model:** `cost_pct` (default 0.10%) on every buy and every sell.

**Itemised model** (what a real broker charges), per side:

| Item | Rate |
|---|---|
| Securities transaction tax | 0.1% |
| Stamp duty | 0.015%, buys only |
| Exchange, SEBI and GST charges | 0.004% |
| Slippage | `slippage_bps`/10,000 (0.05% by default) |
| Depository charge | a flat ₹16 per sell, as a fraction of the sold value (capped at 5%) |
| Liquid fund | buys 0.005% stamp duty; sells 0 |

An equity buy costs 0.169%; an equity sell 0.154% plus the depository fraction (selling 20% of
a ₹10 lakh portfolio adds 16/200,000 = 0.008%, so 0.162%).

**Tax** (`tax.py`), tracked **per purchase lot**: a partial sale takes the same fraction of every
lot, and each lot's gain is `sale value after cost − its cost basis`, held for its own number of
days.

- Long-term means held more than 365 days (not for debt). Rates: short-term equity gain 20%;
  long-term 12.5%; gold, silver, international and debt at your slab rate (30% by default);
  plus 4% cess.
- A loss goes into a loss pool and carries forward without limit. A long-term gain is offset by
  the long-term pool first; whatever gain is left (long or short) is offset by the short-term
  pool.
- Example on a ₹10,000 gain: short-term equity pays 10,000 × 0.20 × 1.04 = **₹2,080**;
  long-term 10,000 × 0.125 × 1.04 = **₹1,300**; slab-rate 10,000 × 0.30 × 1.04 = **₹3,120**.
- `tax_hold_band` lets a holding in profit that is close to turning long-term stay a little
  longer before a rank slip sells it.
- Not modelled: the ₹1.25 lakh long-term exemption, surcharge, and any limit on carrying losses.

### 3.4 The metrics

All come from the weekly equity curve (normalised to 1.0 at the start):

| Metric | How it is calculated |
|---|---|
| **CAGR** | `(end / start) ^ (1 / years) − 1`, years = days between first and last week ÷ 365.25 |
| **Max drawdown** | each week `equity / highest-equity-so-far − 1`; the worst of those |
| **Volatility** | standard deviation of weekly returns × √52 |
| **Sharpe (vs cash)** | `mean(strategy weekly return − liquid-fund weekly return) / std(...) × √52` |
| **Sortino** | `(CAGR − cash CAGR) / (std of the negative weekly returns × √52)` |
| **Turnover** | `(value of all SELL and TRIM rows) / average equity / years` |
| **Yearly returns** | last equity of each calendar year, year over year; "vs benchmark" is the difference |
| **Win rate, average win/loss** | over closed trades, a win being a position return > 0 |
| **Crash table** | the benchmark's three deepest non-overlapping falls, and the strategy's return over the same dates |
| **Rolling 52-week excess** | `equity/equity(52 weeks ago) − benchmark/benchmark(52 weeks ago)` |

Rupee figures on screen are for ₹1 lakh invested at the start.

---

## 4. How the four datasets differ

**ETF rotation.** The 26 instruments, ranked on index closes. Trades can fill on the actual ETF
(before it listed, the index stands in, scaled to join and less the expense ratio).

**Stock (Nifty 50).** The 95 companies with total-return prices, plus gold, silver, cash and
gilt in the same ranking. The membership table gates **new buys only**; it never forces a sale.

**Custom Index.** For each of ~62 categories, an inner backtest (default: hold 2, exit at 8)
turns the category's stocks into one **equity curve**. That curve becomes the category's price
column; Gold, Silver, Cash, Gilt, Nasdaq 100 and Hang Seng are added; duplicates of Gold/Cash
("copies") let them take more than one slot. An ordinary backtest then ranks these columns. The
~60 inner backtests are why a cold Custom Index run is slow; the result is cached per setting.

**Broad Momentum** is a funnel from ~755 stocks to a handful of positions:

1. **Step 1, the price table.** Stock prices (Part 2.3) with point-in-time membership and an
   optional liquidity gate.
2. **Step 2, rank everything.** The engine's own ranking runs over all ~755 stocks plus four
   "atomics" (Gold, Silver, Nasdaq 100, Hang Seng). Then a **quarterly pool**: at each quarter-end
   the top 200 by rank enter the pool, and a previous member stays while it ranks within 250.
   This step is the expensive one (about 20 seconds cold) and is cached.
3. **Step 3, pick categories.** A category's score is the average pool rank of its members that
   are in the pool; it counts only if at least 40% of its members qualify. Each week, the top 4
   categories are "fresh" and up to 8 are held (the same buffer idea, applied to categories).
4. **Step 4, turn categories back into stock ranks.** The category list is converted into a
   rank for each stock so the **engine can be reused unchanged**. With 2 picks per category,
   positions 1-4 get ranks 1-8 and positions 5-8 ("lingering") get ranks 9-16, and the engine
   runs with `top_n = 8`, `exit_rank = 16`. A stock that stops being one of its category's top
   two picks loses its rank and is sold with the reason "ineligible".

Three overlays apply to Broad:

- **Liquidity gate** (each Friday, a stock is tradable only if): at least 55 sessions traded in
  the last 60, all in series EQ, none with zero volume; median daily turnover ≥ ₹1 crore; its
  10th-percentile day ≥ 25% of that; last close ≥ ₹20; and (optionally) no run of three or more
  band-edge closes in the last 125 sessions.
- **Price ceiling:** a stock above ₹20,000 (raw close) cannot be newly bought; a held one is
  never force-sold.
- **Circuit locks:** a stock that closed at the same price-band edge (up or down) for three or
  more sessions in a row is treated as locked: an upper-locked stock cannot be bought, a
  lower-locked stock cannot be sold. NSE publishes no band data in bhavcopy, so bands are
  **inferred** from close-to-close moves of 2%, 5%, 10% and 20%.

---

## 5. Why it was slow, and what we changed on the backend (BL-005)

### 5.1 The symptoms

Measured on 2026-10-04 on the running service: a **Broad run took 55 s cold and 21 s warm**,
and returned a **1.67 MB** result. An ETF run took 4-6 s. Every iteration of the research waited
that long.

### 5.2 What the profiler said

Profiling a warm Broad run showed where the time went:

- About **40%** in the engine's weekly loop, reading prices **one cell at a time** out of a
  pandas table (about 160,000 single-cell lookups).
- About **20%** building the tables for the screen (`rotations`, `instrument_table`).
- About **20%** on the "Worst circuit situations" card, which re-ran the **whole backtest a
  second time** with the opposite circuit setting, plus per-row Python loops over every daily bar.
- Hundreds of single-column edits that fragmented a pandas table (a warning in the logs).

Then, when we started the work, we found a bug that made all of it worse (5.3, first item).

### 5.3 What we changed, in the order we did it

Each item says how it was before, what it is now, and what it bought. Timings are on the frozen
**test dataset** (the golden fixture, 170 stocks, the same data every time), best of three runs on
a machine that was shared with other work, so they are approximate. "Live" numbers are on the
real data.

#### Phase 1: stop throwing the caches away (PR #56)

**Before.** The server kept caches (the loaded prices, the rankings including the 20-second Broad
ranking, liquidity features, circuit masks), each valid only while "the database has not changed".
It decided that by looking at the database file's **modified time**. But after every finished run
the dashboard **saves it** into that same database (a "saved run"), which changes the file's
modified time. So **every run emptied every cache the next run needed**. The "21 s warm" number
had been measured on an endpoint that does not save; in real dashboard use it was closer to cold.

**Now.**
- Caches are keyed on **`db_read.data_version()`**: a fingerprint of the market-data tables (row
  count plus a hash of every row, for each table except the ones that only record runs) plus the
  size and time of the stock price files. A saved run no longer changes it. It costs about 0.1 s,
  recomputed only when the database file changes. If the database is busy being written, it
  keeps the last known version instead of changing the key.
- **A whole-result cache**: the last 8 results are kept, keyed on the exact request and on
  everything the result depends on (the database fingerprint and every input file). An identical
  re-run is answered from memory.
- **gzip** on responses (a 1.8 MB result is about 0.25 MB on the wire; level 5, since level 9 cost
  three times the CPU for 4% less size).

**Measured.** An identical re-run went from 1.5-20 s to **0.03-0.2 s**. 28 of 28 real runs
(the 16 golden scenarios plus the 12 saved favourites) came back identical to a snapshot taken
before the change.

#### Phase 2: do not build what nobody has looked at yet (PR #70)

**Before.** Every run built the **whole** result: the KPIs and chart data, but also the closed
trade list (614 KB), the instrument attribution, the holdings timeline, this week's signal table,
and the circuit card with its second backtest. All of it went to the browser even if only the
chart was looked at.

**Now.** A background job's result is the **core** (KPIs, chart series, rotations, yearly,
crashes, comparisons, open positions). The heavy parts, called *sections*, are built **only when
asked**, from `GET /api/backtest/jobs/{id}/sections/{name}`: `trades`, `instruments`, `timeline`,
`latest`, and for Broad `circuit_exposure`. `run_parts.RunParts` holds a result as core plus
builders, builds a section once on first use, and then drops the builder. The synchronous
endpoint, the weekly job and the tests still get the whole thing, so nothing they read moved.

Two safeguards came out of the code review: unbuilt sections hold a run's whole price data in
memory, so only the **newest 4** runs keep them (older ones answer "run it again", and a "fresh"
run releases them all); and jobs release by **finish** order, not start order.

**Measured on a real Broad result.** The whole result was 1,714 KB (259 KB compressed); the core
is **593 KB (106 KB compressed)**. The circuit card now costs nothing until opened.
**One goal was not met:** the core is not under 400 KB, because `rotations` alone is 515 KB
(every week that traded embeds its full list of holdings and the chart reads it at once).
Shrinking it needs the chart to fetch a week's holdings when asked; it is recorded as an open
decision.

#### Phase 3: make the engine and the table-building fast (PR #73)

This is the part that changed how the calculation itself is *executed*, without changing what it
computes.

**1. The engine reads its tables by position, not one DataFrame cell at a time.**
*Before:* the weekly loop asked pandas for `prices.at[week, asset]`, `ranks.at[...]`,
`lc_locked.at[...]`, `groups.at[...]` for every holding every week: roughly **170,000-200,000
calls per run (the profiler counted both) at ~10 microseconds each**. And every week `top_names` looked up the rank of **every one of the
~760 ranked names** one by one, although only the best few matter.
*Now:* `_Sim` keeps each table as a NumPy array plus two small dictionaries (week → row,
asset → column). A lookup is two dictionary reads and an array index, and returns exactly the
number pandas returned. `top_names` takes advantage of the ranks being sorted best-first: the
names within `top_n` are a **prefix**, found with a binary search instead of testing every name.
A table with a repeated label (which pandas handles lazily) falls back to the old path, so a
case that used to work cannot start failing.
*Measured:* `engine.run_backtest` (two per Broad request) **1.60 s → 0.3 s**.

**2. `rotations`** (the per-week "what went out, what came in, what is held" list that the chart
needs at once). *Before:* for each traded week it cut the trade table into sub-tables with three
boolean filters and walked them. *Now:* it works on the trade log's columns as plain lists, in
the same order. *Measured:* **0.74 s → 0.07 s**.

**3. The circuit card's runs.** *Before:* a Python loop over every daily bar of every stock held
(about 194,000 calls), each testing four price bands. *Now:* all bars are classified at once with
NumPy and only the (few) band-edge days are walked; each run's compound move is still multiplied
one step at a time, exactly as before. The per-holding date windows are slices of date-sorted
bars instead of comparing every row. *Measured:* the card **2.8 s → 1.3 s** end to end.

**4. `build_effective_stock_ranks`** (Step 4 of Broad). *Before:* a pandas cell write per pick per
week. *Now:* it fills two arrays and builds the tables once (keeping the groups table as `object`
type, because building it from an object array turns it into a string type in this version of
pandas; a test caught exactly that). *Measured:* **0.28 s → 0.08 s**.

**5. The fragmented table.** *Before:* replacing hundreds of "stale" columns one at a time with
`frame[col] = ...` split pandas' internal storage into one block per column, which raised
"DataFrame is highly fragmented" the next time a column was added. *Now:* one `concat`
(on the test data, 14 blocks → 3).

**Measured, all of Phase 3 together** (test dataset, `broad_default`):

| | Before Phase 3 | After |
|---|---|---|
| Whole request, warm | 4.3 s | **1.9 s** |
| What the dashboard waits for (the core, via the job route) | 2.4 s | **0.4 s** |
| Engine (two runs per request) | 1.60 s | 0.3 s |
| `rotations` | 0.74 s | 0.07 s |
| Circuit card (separate request) | 2.8 s | 1.3 s |
| `build_effective_stock_ranks` (two) | 0.28 s | 0.08 s |

On the **real data**, measured just before Phase 3: a warm Broad run took **12.7 s** (11 s of CPU)
and the core 3.9 s. It could not be re-measured afterwards because another process had the
database locked; the ratios above are the best guide to the live improvement until it can be.

#### Phase 4: show the user where a run is (backend part)

**Before.** The dashboard only knew a job was "queued" or "running".
**Now.** A job reports its step as it goes: `loading` → `ranking` → `simulating` → `analysing`.
The job record carries the current step (`stage`) and the ordered list of steps (`stages`, so the
dashboard does not hard-code the order or the count), plus how long the computation took in
milliseconds (`compute_ms`). The dashboard shows "Step 2 of 4 · Ranking" and, once it has seen a
few real runs of that dataset, "usually about 20 s" (the middle of the last five real
computations, remembered in the browser; a result answered from the cache is not counted). Because
a cold run (rebuilding the rankings) can take several times longer than a warm one, the banner
stops quoting the usual time once a run is past twice of it and explains why it is slow instead.

### 5.4 Things that were deliberately **not** done

- **The weekly job still builds the full payload**, including the circuit card for each Broad
  favourite, although it reads only the core and this week's signal. Skipping that would save
  about one card per favourite, but means changing tests other work depends on.
- **Two identical runs started at the same moment both compute.** The second is fast once the
  first finishes; true "share the work in flight" was left out.
- **Shrinking `rotations`** (the 515 KB) is a decision for the owner (see 5.3, Phase 2).

---

## 6. How we know no result moved

The rule for this whole piece of work was: **a golden diff means the change is wrong.** Four
checks, from broad to narrow:

1. **The goldens** (`tests/golden/`). 16 scenarios (5 ETF, 3 Stock, 2 Custom Index, 6 Broad) run
   through the real API on a frozen slice of real data. Every number is compared to a stored
   result (to 10 significant digits). None was ever "accepted" during this work.
2. **A live-data snapshot** (`scripts/result-baseline.py`). Before any code change we saved the
   full results of all 16 scenarios and all 12 saved favourites on the real data, then re-ran
   them after each phase: **28 of 28 identical**. (Phase 3 could not be re-checked live because
   the database was locked; the goldens and the tests below covered it.)
3. **A twin test for every rewrite.** For each piece of replaced code, the test suite keeps a
   verbatim copy of the old version and compares it with the new one on **random data built to
   hit the edges**: ties in rankings, missing values, gaps, opposite-direction runs, every gate.
   These cover things the 16 scenarios do not. Examples: `test_engine_grid.py` (it fails if the
   prefix shortcut handled ties differently, which we checked by deliberately breaking it),
   `test_analysis_rotations.py`, `test_circuit_runs_equivalence.py`,
   `categories/test_effective_ranks_equivalence.py`, `categories/test_forward_filled.py`.
   Writing these caught a real difference once (the string-type issue in 5.3).
4. **The look-ahead test and the independent replay** that already existed. The look-ahead test
   re-runs each dataset on data cut off at three dates and requires identical results up to the
   cut. The audit replay rebuilds fills, costs, tax and equity from raw bars with code that shares
   nothing with the engine.

And every phase went through a code review (`/code-review`, high effort) before merging: 9 findings
on Phase 1, 7 on Phase 2, 5 on Phase 3, each fixed or explicitly declined with a reason.

---

## 7. Glossary

| Term | Meaning |
|---|---|
| **Backtest** | Replaying a trading rule over stored history to see what it would have done |
| **Rank / hysteresis** | Position 1 = best this week. Buy only the top `top_n`; sell only when rank slides past `exit_rank`; the gap prevents churn |
| **Lookback** | How many weeks back a return is measured |
| **Bhavcopy** | The exchange's end-of-day price file for every listed stock |
| **Corporate action** | A split, bonus, dividend, demerger... that changes the price without changing value |
| **Total-return series** | A price series with splits and dividends folded in, so it measures what an investor earned |
| **Survivorship** | Bias from ranking only companies that still exist today |
| **Catalog / lake** | The database file / the folder of parquet price files |
| **Cache key** | What a cache compares to decide "the data has not changed"; a wrong key means stale results or no caching |
| **Job** | A backtest running in the background while the dashboard polls it |
| **Core / section** | The part of a result needed at once / a heavy part fetched when its tab is opened |
| **Golden** | A stored, expected result a test compares against |
| **Warm / cold** | With the caches filled / empty |

## 8. Where to look in the code

| What | Where |
|---|---|
| The request path, jobs, caches, sections | `src/momentum_backtesting/api.py`, `run_parts.py` |
| The weekly simulation, ranking, costs | `engine.py`; tax in `tax.py` |
| What the screen is built from | `analysis.py`, `metrics.py` |
| Data fetching and weekly conversion | `fetch.py`, `sources.py`, `weekly.py`, `fyers.py` |
| Stock cleaning and guards | `stocks/adjust.py`, `stocks/guards.py`, `stocks/corporate_actions.py` |
| Broad's funnel, liquidity, circuits | `categories/broad.py`, `categories/liquidity.py`, `categories/circuit_exposure.py` |
| Database reads and the cache fingerprint | `db_read.py`; the database itself in `packages/trading-data` |
| Timing a run | `scripts/bench-backtest.py` |
| Checking nothing moved | `tests/golden/`, `scripts/result-baseline.py`, the `*_equivalence.py` tests |
| Project notes | `packages/momentum-backtesting/CLAUDE.md`, `backlog/BL-005-faster-momentum-backtests.md` |
