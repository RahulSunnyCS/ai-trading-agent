# The momentum lab in plain English

Who this is for: you, in six months, when you have forgotten why a setting is what it is.
Companion: `docs/momentum-parameters-reference.md` (same settings, precise wording, evidence).

Status markers used below:
- **Measured** means a real backtest in `TODO.md` section 3.9 showed it, and the section is cited.
- **Reasoned** means it follows from how the code works, but no backtest isolated it.

"Measured" results from 1 October 2026 (TODO 3.9.23) were tested the strict way: the same
change restarted from scratch in 28 overlapping three-year stretches between 2017 and 2026, and
a change only counts as better if it wins most of those stretches, not just the one big
nine-year run. "ETF strategy" means the one the Friday Telegram signal follows; "Broad" means
the Broad Momentum tab with its default settings.

## The idea in one paragraph

Every Friday we look at about 21 things we could own (Indian sector indexes, gold, silver, the
Nasdaq, Hang Seng). We ask: which ones have been going up the most? We buy the best few. We
keep them until they stop being among the best, then swap them out. The bet is that things that
have been rising tend to keep rising for a while. That bet is called momentum.

## A worked example (made-up numbers, worked by hand)

Four things, five time windows. Each cell is the percent gain over that window.

| | 1 week | 4 weeks | 13 weeks | 26 weeks | 52 weeks |
|---|---|---|---|---|---|
| A | +2 | +6 | +15 | +30 | +60 |
| B | +4 | +5 | +10 | +20 | +40 |
| C | -1 | +1 | +12 | +35 | +70 |
| D | 0 | -2 | +2 | +5 | +10 |

Step 1. In each window, rank them: best gain gets 1, worst gets 4.

| | 1w | 4w | 13w | 26w | 52w | Total score |
|---|---|---|---|---|---|---|
| A | 2 | 1 | 1 | 2 | 2 | 8 |
| B | 1 | 2 | 3 | 3 | 3 | 12 |
| C | 4 | 3 | 2 | 1 | 1 | 11 |
| D | 3 | 4 | 4 | 4 | 4 | 19 |

Step 2. Add up the ranks. Lowest total wins. Final order: A (8), C (11), B (12), D (19).

Notice B was best this week, but ranks third overall because its longer history is weaker. That
is the point of using five windows: one hot week is not enough.

## What each setting does, in everyday terms

### Choosing what to buy

- **Look-back windows (1, 4, 13, 26, 52 weeks).** About one week, one month, three months, six
  months, one year. Using all five asks "is it strong in the short run AND the long run?"
  Measured: dropping the one-week window, or skipping the last month altogether, made the ETF
  strategy worse in most stretches (TODO 3.9.23). The short window earns its place.
- **Weights (equal by default).** How much each window's rank counts. Equal means every window
  has a vote of the same size. A negative weight flips a window, so the worst performer scores
  best. That is what you tried for turnarounds. It did not work because ranks cannot express
  "beaten down AND recovering". The reversal plan fixes that with a filter first.
- **Top N = 5.** How many names we are happy to buy fresh. Fewer names means bigger bets and
  bigger swings. Measured on the Custom Index tab: raising it from 5 to 8 cut the worst fall
  from about 34% to about 31% and raised yearly return (TODO 3.9.8). On the ETF strategy, 3
  names beat 5 in nearly every stretch (about 2.7 points a year more), but each then holds about
  a third of the money (TODO 3.9.23).
- **Exit rank = 10.** A name is only sold once it drops below 10th place, not the moment it slips
  to 6th. Think of it as a doorman who lets you stay a while after you stop being the most
  popular. It cuts pointless buying and selling (which costs money and tax). Measured: 6 churns
  far more and earns about 5 points a year less; 16 holds losers too long (TODO 3.9.23).

### Managing the money

- **Portfolio rule "buffer" (default).** Keep everything you bought until it fails the exit rank.
  When something is sold, split the cash equally across the current top N, topping up the ones
  we already own. The alternative, "slots", gives each slot its own pot and never tops up.
- **Entry rule "wait" vs "make room".** When a new name enters the top N but nothing was sold,
  "wait" holds off until there is cash. "Make room" trims every holding a little to buy it
  immediately. An earlier test said make room was a clean win (TODO 3.9.18). The stricter test
  says no: on ETFs it gives a smoother ride but less money, and on Broad it is a coin-flip with
  deeper falls. Keep "wait" (TODO 3.9.23).
- **Position cap = 35% (ETF), 15% per stock and 30% per category (Broad Momentum).** No single
  holding may grow past this share. Without it, one ETF once reached 84% of the portfolio.
  Measured: a tighter cap gives a smoother ride and a lower return; a looser cap does the
  opposite. It is a dial, not free money (TODO 3.9.18).
- **Cap band = 5 points.** A holding is only trimmed back once it is 5 points over its cap.
  Stops a trade, and a tax bill, every time a winner drifts over by a hair.
- **Max price to buy = 20,000 rupees (Broad Momentum).** With a small budget you cannot afford a
  first share of a very expensive stock. It only blocks new buys. A stock you already own is kept.
  It costs about a third of a point a year, which is the price of the budget, not a mistake.
- **Skip the most jumpy ETFs (new, ETF only, off by default).** Never freshly buy the most
  volatile fifth of the ETFs that week. In practice that mostly keeps out Realty and PSU Bank,
  which tend to spike and fall back. Measured: about 2 points a year more, smoother, and better
  in about 9 of every 10 stretches, whichever exact setting is used. On individual stocks it is
  the opposite and loses badly, because there the jumpy stocks are the winners (TODO 3.9.23).

### Staying out of trouble

- **Defensive mode (off by default).** Whether cash or bonds can be held when everything looks
  weak. Measured: the "only hold things that beat cash" filter did not help (TODO 3.9.8, 3.9.18).
- **Momentum sizing (off).** Buy smaller after a losing streak. Measured and rejected: it gave up
  about 4 to 5 points of yearly return without reliably reducing risk (TODO 3.9.8, 3.9.18).
- **Mass-exit throttle (off).** If more than half the holdings exit in one week, hold back some
  cash. Measured and rejected (TODO 3.9.20).
- **Other "stay out of weak markets" ideas.** Stop buying when Nifty is below its 40-week
  average, or when most stocks are below theirs; only buy things near their 52-week high; only
  buy things that rose smoothly. All measured, none helped (TODO 3.9.23). Scaling the whole
  portfolio down when it gets bumpy (volatility targeting) does make falls shallower, but costs
  return about one for one: it is a comfort dial, not extra profit.
- **Volume, the 50-day average and trend stages (not built).** Three popular trading ideas:
  prefer stocks whose trading volume is surging or which trade more on up days; only buy stocks
  above their 50-day average; skip stocks whose trend is topping out (Weinstein "Stage 3") and
  prefer ones just starting a new uptrend. All measured on Broad Momentum, none helped once you
  allow for the momentum score itself (TODO 3.9.27). Two even pointed slightly the wrong way:
  stocks above their average, and stocks early in a new uptrend, did a little worse than
  similar stocks that were not. Volume also does not tell a blow-off spike from a healthy one.
- **How much of the profit could really be traded.** About a quarter of Broad Momentum's profit
  came from stocks that trade less than ₹5 crore a day. Refusing to buy anything under ₹1 crore a
  day costs about 3 points a year. With ₹10 lakh invested this does not matter (a position is a
  tiny slice of a day's trading); for a much bigger account the headline return is optimistic
  (TODO 3.9.27, 3.9.29).

### Costs and tax

- **Trading cost = 0.10% each way (flat).** A simple stand-in for brokerage, taxes on trades and
  the gap between buy and sell prices.
- **Itemised cost model (optional).** Adds the real line items: securities transaction tax 0.1%,
  stamp duty 0.015% on buys, exchange fees about 0.004%, a 5 basis point slippage guess, and a
  flat 16 rupees per sale. Measured: costs about 0.7 of a point a year more than the flat model
  on ETFs and 2.3 on Broad (which trades far more), and the strategy still wins (TODO 3.9.23).
- **Tax (off by default).** When on, each purchase is its own tax lot. Gains held up to a year on
  equity are taxed at 20%, longer than a year at 12.5%, plus 4% cess. Gold, silver,
  international and bond funds use your income-tax rate for short holds. Average holds are about
  9 weeks, so almost everything is short-term. Measured: tax takes about 5 points a year off the
  ETF strategy (25.8% to 20.9%), which still beats Nifty with dividends by about 8 points. Waiting
  a few extra weeks for a winner to become long-term did not help: hardly any holding lives that
  long (TODO 3.9.23).

### Timing

- **Signal delay = 0 and trade at Friday close.** We assume you can trade at the same close the
  ranking used. The live weekly job sends a 14:40 preview so you can trade near the close.
  Measured: on ETFs, waiting a week or buying at Monday's open is worse, so trading on Friday is
  right. On Broad, waiting one week is better (about 4 points a year): individual stocks that
  just jumped tend to give a little back the next week (TODO 3.9.23).
- **Track = index (backtest) vs ETF (live job).** The backtest ranks on the index. The live job
  measures profit on the ETF you would actually hold, because the gap was measured at about
  0.72 points a year (past the 0.5 threshold you set).
- **Weekly, every 2 weeks, or monthly.** Weekly is the default, and now there is an every-2 and
  every-4-weeks option too. Measured, and the answer depends on what you trade (TODO 3.9.23):
  - ETFs: weekly wins. Every 2 weeks costs about 3 points a year.
  - Broad (stocks): every 2 weeks wins in every stretch tested, about 5 points a year more with
    a better ride. Weekly trading buys about 115 stocks a year and holds each for under a month,
    which is mostly churn.
  - Which Fridays you pick matters a lot: the two possible every-2-weeks schedules differed by
    7 points a year on Broad, by pure luck of the calendar. So the fair comparison splits the
    money into two halves trading on alternate Fridays, and that is the number quoted above.

### Broad Momentum (the stock-picking funnel)

Think of it as three sieves. Numbers are the shipped defaults.

**A bug that made Broad look better than it was (found 1 October 2026).** In weeks when few
categories qualified, the backtest silently skipped the whole week: nothing sold, nothing
bought. That happened in about 190 of 508 weeks, mostly in weak markets like 2018. Counting every
week, Broad made about 31.7% a year with a worst fall of 20%, not the 37.5% the dashboard showed.
That is still far ahead of Nifty with dividends (12.6%) and the Momentum 30 index (17.0%). The
fix is the "Simulate every week" switch in the Broad settings; it should become the default
(TODO 3.9.23). The numbers below are all counted every week.

1. **Pool: top 200 of about 755 stocks, exit at 250, refreshed quarterly.** First find the
   strongest stocks in the whole market. A smaller pool (100) did worse; a bigger one (300) did a
   little better in most stretches, but this changes which sectors get picked from the start,
   so treat it as a hint, not proof (TODO 3.9.23).
2. **Categories: top 4 fresh, exit at 8, with a 40% coverage floor.** Group stocks into sectors.
   A sector only counts if at least 40% of its stocks made the pool, so one lucky stock cannot
   carry a whole sector. The 25% floor that looked promising earlier lost once every week was
   counted, and 3 or 6 categories did worse than 4 (TODO 3.9.23).
3. **Picks: 2 stocks per category.** The two strongest stocks inside each held sector. Three
   picks did better in most stretches (about 3 points a year), mainly by owning more names;
   one pick did much worse (TODO 3.9.23).

### Custom Index tab

- **Inner top-2, exit 8.** Inside each sector, hold the top 2 stocks and swap at rank 8.
- **Outer top 8, exit 16.** Across sectors, hold the top 8. Measured win-win versus the old 5 and 10
  (TODO 3.9.8).

## What has and has not been proven

Proven on real data, in the repo's own logs: more names on Custom Index (top N 8), the exit-rank
buffer, caps as a risk dial, itemised costs still profitable, and (TODO 3.9.23):

- The ETF strategy beats Nifty with dividends by about 13 points a year and the Momentum 30
  index by about 9. Broad beats them by about 19 and 15.
- Broad must count every week (the skipped-week bug above).
- Broad does better trading every 2 or 4 weeks, or a week late, than every week.
- The ETF strategy does better if it never buys the jumpiest fifth of ETFs.

Tried and dropped: sizing by recent wins, mass-exit throttle, the cash filter, trend and breadth
filters, 52-week-high and smooth-path filters, skipping the last month, volatility timing of
the whole portfolio (a comfort dial only), waiting for long-term tax, "make room" as a
default, (TODO 3.9.27) volume surges, accumulation, the 50-day average and trend-stage
filters, and (TODO 3.9.31) buying or holding a strong stock through a small pullback: being in
a pullback does not actually predict a better forward return once you control for how strong
the stock already is, and the one settings tweak and one hold-through-pullback rule that did
pass a backtest on their own stopped winning on drawdown the moment either was combined with
the already-adopted every-2-weeks trading cadence — the same effect expressed twice, not two
effects.

Turnaround stocks: the beaten-down-and-recovering screen (`reversal.py`) is a little better than
keeping 20% of the money in a liquid fund, but costs about 4 points a year against plain
momentum. Not worth running on its own; never use it to replace momentum.

Not proven: anything that only won on the single nine-year run. About 90 variations were tried,
so one or two "wins" could be luck; the ones listed above won in nearly every stretch, which
luck rarely does.

## Dry-run results (1 October 2026)

One real Friday, 18 September 2026, on the ETF strategy (the latest week with a sale), worked
exactly like the made-up example above. Percent gains over each window, then the rank in each
window (1 = best of the 21), then the total:

| | 1w | 4w | 13w | 26w | 52w | Ranks | Total | Place | What happened |
|---|---|---|---|---|---|---|---|---|---|
| Nasdaq 100 | +2.3 | +1.5 | +0.5 | +24.6 | +31.7 | 2, 1, 9, 1, 3 | 16 | 1 | topped up |
| Nifty Pharma | +0.7 | +1.3 | +9.2 | +18.5 | +17.7 | 5, 2, 1, 6, 6 | 20 | 2 | kept, already at the 35% limit |
| Nifty Metal | +0.4 | -0.9 | +0.2 | +14.4 | +30.7 | 6, 4, 10, 7, 4 | 31 | 3 | topped up |
| Gold | +1.1 | -3.7 | +5.6 | +4.5 | +38.5 | 3, 13, 2, 13, 2 | 33 | 4 | bought (new) |
| Nifty Smallcap 250 | -0.3 | -0.7 | +3.2 | +23.6 | +4.5 | 13, 3, 6, 2, 10 | 34 | 5 | topped up |
| Silver | +4.5 | -3.8 | +1.2 | +1.9 | +81.2 | 1, 15, 8, 15, 1 | 40 | 6 | not owned, not in top 5 |
| Nifty Capital Markets | -0.8 | -1.8 | -4.2 | +20.0 | +21.6 | 18, 5, 17, 5, 5 | 50 | 8 | kept: 8th is still inside the top 10 |
| Nifty India Defence | -3.8 | -4.9 | -2.5 | +20.9 | +12.4 | 21, 18, 15, 4, 8 | 66 | 14 | sold: fell below 10th |

Defence was about a quarter of the money. Selling it paid for four equal slices of 6.4% each:
Nasdaq, Metal and Smallcap were topped up and Gold was bought for the first time. Pharma, ranked
2nd, got nothing because it already held 35.7% of the money. Notice Silver: best of all this
week and over a year, but 15th over one and six months, so its total of 40 kept it out. That is
the "one hot week is not enough" rule doing its job.

How each setting fared is in `docs/momentum-parameters-reference.md`, sections 2 to 11.
