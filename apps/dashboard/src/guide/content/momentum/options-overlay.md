## What it is for

What would a Momentum strategy have done if, instead of buying its stocks, you had bought their
options? The page re-runs a saved strategy on F&O stocks only (the ones with options), buys an
option on each pick every week, and shows that options book beside the same picks held as shares.
It can also buy **puts** on stocks that are falling, so the downward side can be tried too.

**Read it as a look, not a finding.** The registered tests of this idea were killed: calls on the
picks failed on the weeks from July 2024; puts on falling stocks lost money in every form and the
mirror pool failed on drawdown. A good-looking run here is one of many you could
have tried. Check the capital it needed and how much of the profit came from a few trades before
trusting any total.

## Before you start

The page reads NSE's daily F&O files in the research database (`obt nse fo-fetch`, then
`obt nse fno-build`). The run bar shows the newest day stored; weeks after it are not in any run.
The strategy must be a saved **Broad** favourite or group ([Saved runs](app:/momentum/saved)).

## Settings

Open **Settings** on the run bar (or click any chip).

- **Direction**
  - *Calls on the picks*: a call on every stock the strategy holds that week.
  - *Puts on falling stocks*: a put on the **N** weakest F&O stocks whose own trend is down (their
    26-week return below zero and their price below its 40-week average). Some weeks hold fewer
    than N, or none.
  - *Mirror pool*: every F&O stock's chart and its inverse (1 ÷ price) ranked together. A stock in
    the top N buys its call, an inverse in the top N buys that stock's put. In a falling market the
    inverses take the top places, so the book tilts to puts on its own.
  - *Market switch*: the strategy's calls while the market is rising, the falling stocks' puts while
    it is falling. "Falling" is your pick: NIFTY below its 200-day average, NIFTY's 26-week return
    below zero, or under 40 % of F&O stocks above their 40-week average, read at the previous
    session's close.
  - *Both sides*: the calls and the puts every week, the budget split (puts' share, 50 % by default).
- **Strategy**: a saved favourite, re-run on each year's F&O stocks, or **Custom strategy…** (first
  in the list): pick the look-backs (1, 4, 13, 26, 52 weeks), how many stocks to hold, the rank a
  holding is sold below, the rebalance (weekly, every 2 weeks, monthly) and the score (rank-sum or
  volatility-adjusted). The rest is fixed: F&O stocks of each year that pass the liquidity filter,
  at most 25 % in one stock, bought at Friday's close a week after the signal, the share book's
  costs. The first run of a strategy takes a minute or two; later runs reuse it.
- **Moneyness**: ATM is the listed strike nearest the stock's close; OTM1 to OTM3 are one to three
  strikes further out (above the price for a call, below for a put).
- **Moneyness**: ITM2 and ITM1 are one or two listed strikes in the money (a call below the price,
  a put above it), ATM the nearest, OTM1 to OTM3 out of the money. **Delta** picks the strike whose
  delta, read from that option's own price, is nearest the target (e.g. 60 %): deeper strikes act
  more like the stock, with less time decay and less leverage.
- **Expiry**: the nearest expiry with enough sessions left, or the next one or two after it.
- **Hold while picked**: keep a contract while its stock is still picked, instead of selling and
  buying it again every week. The weeks it is kept cost nothing (no charges, no slippage); it is
  sold when the stock leaves the picks, and rolled once fewer sessions are left than the minimum.
  A held position shows as one trade ("held 5 weeks").
- **Stop / target**: sell on the first daily close at or below the buy price less the stop, or at
  or above it plus the target (daily closes from NSE's files, not intraday). The position stays
  out until the next week's picks.
- **Buy calls only when**: skip the calls in weeks the market is falling (NIFTY below its 200-day
  average, NIFTY's 26-week return below zero, or under 40 % of F&O stocks above their average).
- **Positions a week** and **premium a week** (a share of capital): caps on each week's buying.
- **Until** and **train / test split**: the last day of the run, and a day that splits it in two.
  The **Train and test** card shows the same book on each side: settings are chosen on the train
  side, and the test side is the check.
- **Sizing**
  - *One lot per stock*: one lot of each pick.
  - *Premium per stock*: that many rupees of premium a stock, in whole lots (empty = capital ÷
    sleeves ÷ N, the research test's sizing). A stock whose one lot costs more than twice it is skipped.
  - *Share of capital a week*: that share of capital spent on premium each week, split over the
    week's picks.
  - *Exposure*: each week's positions sized so that delta × stock value adds up to this share of
    capital (100 % = as much stock as the capital buys), split over the week's picks.
- **Capital**, **From** (the first week; data starts in 2020), **sessions left at entry** (the
  expiry must have at least this many sessions after the entry day), **open interest** (a strike
  with fewer lots open is skipped), **slippage** (a share of the premium, paid each way; empty =
  1 % ATM, 2 % OTM1, 3 % OTM2, 4 % OTM3) and **tax** (each financial year's net at 31.2 %, a loss
  carried forward).

## Profit booking

Off by default. Turn it on to trade like a small account that pays itself out: set the starting
**capital** (say ₹1 lakh), the **step** (₹50,000) and the share **taken out** (75 %).

- The **trading account** starts at the capital and takes every week's profit or loss (before tax).
- Each time it stands a whole step above where it last booked, that share of the step is **taken
  out** for good (₹37,500 of each ₹50,000) and the rest (₹12,500) stays to trade. Two steps at
  once take out twice that.
- After a loss the account has to make it back before the next booking.
- **Refill from money taken out** (on by default): a week the account cannot pay for a pick (a
  lot costs more than it holds) and it is below the starting capital, money taken out earlier goes
  back in, up to the starting capital, as far as it goes. Without it a book that loses its
  cushion stops trading for good. The card lists each move, out and back in.
- The next weeks are **sized on the account**: the premium budgets grow and shrink with it, and a
  one-lot book buys only the picks the account can pay for that week (skipped picks are counted).
- The chart adds the trading account and the money taken out; the **Profit booking** card lists
  every booking. The headline total is still everything made, after tax: what is in the account
  plus what was taken out, less tax.

## How a week is traded

Each week the book buys on the last F&O session's close and sells on the next week's. A contract
that did not trade that day is priced at NSE's settle price. If a corporate action re-strikes a
contract (a split or bonus), the book follows the new contract; if the contract is gone, it is
booked at zero. Costs: ₹20 an order, STT on the sale, exchange and SEBI charges, stamp duty and GST.

## Reading the result

- **Headline**: the total and CAGR (against the same picks as shares, or NIFTY when there are no
  shares to compare), the deepest drawdown and its dates, the **capital it needed** and the win rate.
  "Lost it all" means the book fell below zero: it lost more than its capital.
- **Capital it needed**: one lot of every pick each week. The premium a week (median, 90th
  percentile, largest), one lot's cost, positions a week, and the worst fall of that one-lot book.
  Suggested capital = the 90th-percentile week's premium + that fall.
  When the capital you set is below it, a red note says the percentages are not meaningful.
- **Chart tooltip**: hovering a week shows what the book did that day: what it sold (each with its
  sell price and P&L, and the day's total) and what it bought, puts first, written as trades: "Buy
  LAURUSLABS 2,000 CE at 34.00". ×N means N lots (e.g. one from each sleeve of a group).
- **Chart**: the growth of the options book, the same picks as shares and NIFTY. **Drawdown** adds
  the book's fall from its high.
- **Trades**: win rate, payoff (average win ÷ average loss), weeks won, and the net without the best
  5 % of trades. When that number is negative, the result rests on a handful of trades.
- **Calls and puts**: what each side earned; for the market switch, how many weeks were in each state.
- **Skips and fills**: how many picks each rule touched (thin strikes, ban list, no contract, settle
  prices, re-struck contracts).
- **By year**, **winners and losers by stock**, the **best and worst trades** and **all trades**
  (filter by stock). Each trade reads "Buy LAURUSLABS 2,000 CE at 34.00 → Sell at 52.00", with the
  day bought, the day sold, the quantity, the premium paid and the P&L; a contract re-struck by a
  corporate action says so, and one that vanished reads "Contract gone: booked at 0".

## Fresh starts

A small sleeve (a lakh or two of a much larger portfolio) is better judged by what a start usually
returns and how often it is lost than by one start's drawdown. The **Fresh starts** card runs the
run bar's settings afresh with the capital on many days: on the first of every month, quarter or
half-year from the start date, each held for one, two or three years (only starts whose whole
horizon is in the data). **Run starts** runs them all; it takes a few minutes the first time and
seconds after a page run of the same settings.

- Each start is **its own account**: a one-lot book buys only the picks the account can pay for that
  week, and other sizings scale with the account. Profit booking works as set; without it nothing is
  taken out.
- A start **ends** at its capital plus the after-tax total, money taken out included.
- A start is **washed out** when its trading account fell below the wash-out level (10–50 % of the
  capital; 20 % by default) at any week's close, even if it recovered later.
- The strategy's picks are its run over the page's whole window, joined on each start day.

The tiles show the **median end** (the typical start), how many **ended above** their capital, how
many **washed out**, the **average end** (pulled up by the few large wins), the best and the worst.
The chart has one bar per start day on a log scale: green ended above the capital, red washed out,
grey neither; the solid line is the capital, the dotted line the wash-out level, and an end below a
hundredth of the capital is drawn at that hundredth. Hover a bar for its dates, its end, its lowest
account and its trades.

## Limits

Daily closes, not tradable quotes; the slippage is an assumption. Stock options are monthly, so a
week's hold pays a week of time decay. The F&O list, lots and bans are point-in-time, from NSE's own
files.

## Sweeps

The **Sweeps** table at the foot of the page lists the runs of a grid of settings run overnight
(`mbt overlay-sweep <grid.json>`): one row per setting, with the strategy, direction and settings,
the train and test totals and drawdowns, the test's top-5 % share and the trades. Sort by the test
total, the train total, the test drawdown or the whole period; **Open** loads a row's settings into
the page and runs it. While a sweep runs the table refreshes every minute.

Read it with care: with hundreds of rows a few will look good by chance. Choose on the train
columns and read the test columns as the check; the 2024–2026 weeks were also read by earlier
research, so a good test row is a candidate for a forward paper test, not a result.
