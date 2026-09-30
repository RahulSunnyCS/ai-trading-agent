# The momentum lab in plain English

Who this is for: you, in six months, when you have forgotten why a setting is what it is.
Companion: `docs/momentum-parameters-reference.md` (same settings, precise wording, evidence).

Status markers used below:
- **Measured** means a real backtest in `TODO.md` section 3.9 showed it, and the section is cited.
- **Reasoned** means it follows from how the code works, but no backtest isolated it.
- **To dry-run** means the local dry run (handover Step 3) must fill in real numbers.

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
  Reasoned. One known worry: the one-week window tends to bounce back, so it may add noise. To
  dry-run (handover experiment 1).
- **Weights (equal by default).** How much each window's rank counts. Equal means every window
  has a vote of the same size. A negative weight flips a window, so the worst performer scores
  best. That is what you tried for turnarounds. It did not work because ranks cannot express
  "beaten down AND recovering". The reversal plan fixes that with a filter first.
- **Top N = 5.** How many names we are happy to buy fresh. Fewer names means bigger bets and
  bigger swings. Measured on the Custom Index tab: raising it from 5 to 8 cut the worst fall
  from about 34% to about 31% and raised yearly return (TODO 3.9.8).
- **Exit rank = 10.** A name is only sold once it drops below 10th place, not the moment it slips
  to 6th. Think of it as a doorman who lets you stay a while after you stop being the most
  popular. It cuts pointless buying and selling (which costs money and tax). Reasoned; the
  owner's default since day one.

### Managing the money

- **Portfolio rule "buffer" (default).** Keep everything you bought until it fails the exit rank.
  When something is sold, split the cash equally across the current top N, topping up the ones
  we already own. The alternative, "slots", gives each slot its own pot and never tops up.
- **Entry rule "wait" vs "make room".** When a new name enters the top N but nothing was sold,
  "wait" holds off until there is cash. "Make room" trims every holding a little to buy it
  immediately. Measured on Broad Momentum: make room was at least as good on return, worst fall
  and risk-adjusted return in all three windows tested (TODO 3.9.18). Still not the default.
- **Position cap = 35% (ETF), 15% per stock and 30% per category (Broad Momentum).** No single
  holding may grow past this share. Without it, one ETF once reached 84% of the portfolio.
  Measured: a tighter cap gives a smoother ride and a lower return; a looser cap does the
  opposite. It is a dial, not free money (TODO 3.9.18).
- **Cap band = 5 points.** A holding is only trimmed back once it is 5 points over its cap.
  Stops a trade, and a tax bill, every time a winner drifts over by a hair.
- **Max price to buy = 20,000 rupees (Broad Momentum).** With a small budget you cannot afford a
  first share of a very expensive stock. It only blocks new buys. A stock you already own is kept.

### Staying out of trouble

- **Defensive mode (off by default).** Whether cash or bonds can be held when everything looks
  weak. Measured: the "only hold things that beat cash" filter did not help (TODO 3.9.8, 3.9.18).
- **Momentum sizing (off).** Buy smaller after a losing streak. Measured and rejected: it gave up
  about 4 to 5 points of yearly return without reliably reducing risk (TODO 3.9.8, 3.9.18).
- **Mass-exit throttle (off).** If more than half the holdings exit in one week, hold back some
  cash. Measured and rejected (TODO 3.9.20).

### Costs and tax

- **Trading cost = 0.10% each way (flat).** A simple stand-in for brokerage, taxes on trades and
  the gap between buy and sell prices.
- **Itemised cost model (optional).** Adds the real line items: securities transaction tax 0.1%,
  stamp duty 0.015% on buys, exchange fees about 0.004%, a 5 basis point slippage guess, and a
  flat 16 rupees per sale. Measured: costs about 1 point of yearly return more than the flat
  model, and the strategy still wins (TODO 3.9.18).
- **Tax (off by default).** When on, each purchase is its own tax lot. Gains held up to a year on
  equity are taxed at 20%, longer than a year at 12.5%, plus 4% cess. Gold, silver,
  international and bond funds use your income-tax rate for short holds. Average holds are about
  11 weeks, so almost everything is short-term.

### Timing

- **Signal delay = 0 and trade at Friday close.** We assume you can trade at the same close the
  ranking used. That is slightly optimistic. Setting delay to 1 week is the pessimistic check.
  The live weekly job sends a 14:40 preview so you can trade near the close.
- **Track = index (backtest) vs ETF (live job).** The backtest ranks on the index. The live job
  measures profit on the ETF you would actually hold, because the gap was measured at about
  0.72 points a year (past the 0.5 threshold you set).
- **Weekly vs monthly rebalance.** Weekly is the default. Monthly trades less and changed the
  path of returns noticeably (TODO 3.9.18). An every-2-weeks option does not exist yet.

### Broad Momentum (the stock-picking funnel)

Think of it as three sieves. Numbers are the shipped defaults.

1. **Pool: top 200 of about 755 stocks, exit at 250, refreshed quarterly.** First find the
   strongest stocks in the whole market. Exit at 250 (not the earlier guess of 300) was clearly
   better on return, risk-adjusted return, worst fall and trading volume (TODO 3.9.13).
2. **Categories: top 4 fresh, exit at 8, with a 40% coverage floor.** Group stocks into sectors.
   A sector only counts if at least 40% of its stocks made the pool, so one lucky stock cannot
   carry a whole sector. A 25% floor gave better risk-adjusted return and smaller falls in all three windows, at a small cost in return, but has not yet been
   double-checked, so it is a candidate, not a change (TODO 3.9.18).
3. **Picks: 2 stocks per category.** The two strongest stocks inside each held sector.

### Custom Index tab

- **Inner top-2, exit 8.** Inside each sector, hold the top 2 stocks and swap at rank 8.
- **Outer top 8, exit 16.** Across sectors, hold the top 8. Measured win-win versus the old 5 and 10
  (TODO 3.9.8).

## What has and has not been proven

Proven on real data, in the repo's own logs: more names (top N 8), exit-rank buffer, caps as a
risk dial, make-room entry, itemised costs still profitable.
Tried and dropped: sizing by recent wins, mass-exit throttle, the cash filter.
Not yet proven: anything in the handover's new-lever list. The dry run fills that in.

## Dry-run results (to be filled by the local session)

Replace this section with the table the dry-run script prints (handover Step 3), plus one real
Friday walked through like the example above.
