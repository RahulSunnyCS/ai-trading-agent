## What it is for

The **Trade book** is your real profit and loss, read from the contract notes your brokers e-mail every evening. It is the same book your Trade Book sheet keeps, worked out with the sheet's own formulas, plus what the sheet cannot show: the charges by kind, every trade paired from its fills, where each trade came from, how far it went for and against you, and the money that moved in and out of the accounts.

Nothing here is a backtest and nothing here places an order. Every figure comes from a stored contract note, a ledger e-mail or a number you typed.

## Where the figures come from

- **Contract notes.** The laptop reads each broker's notes from the mailbox after midnight (and again at 07:30) and stores them. A note gives the day's F&O figures per account: the pay-in / pay-out obligation, brokerage, the other charges, total charges and the final net.
- **Ledger e-mails.** Deposits, payouts, quarterly fund settlements, Angel One's collateral-interest e-mail and the margin-shortfall warnings.
- **Your inputs.** The two columns the sheet asked you to type: the number of algo trades taken that day and the capital. Angel One's capital is also read at 15:50 for the next session; Finvasia's stays what you type and carries forward until you change it.

The chip at the top right, **Notes in through ...**, is the newest day with a stored note.

## The run bar

- **F&O, Trades, Money, Momentum** switch between the four views.
- **Year** is the financial year, April to March. A year with no notes yet shows when it starts and offers the newest year that has some.
- **Accounts** narrows the page to one broker account. One account uses its own notes only: the day's algo fees belong to the whole book and are left out, as in the sheet.
- The refresh button re-reads everything; the link button copies a link to exactly this view (year, account, benchmark and an open day are in the address).

## F&O: the headline

Five tiles answer "how is the year going?", each against the benchmark you pick under **Compare with**:

| Tile | How it is worked out |
|---|---|
| Net profit | Every day's net profit added up (see the day's figures below). |
| Return | Net profit ÷ the average of each day's capital, as a %. |
| Max drawdown | The deepest fall of the running net below its own earlier peak within the year, in ₹ and as a % of the average capital. |
| Charges / net profit | The year's charges (notes plus algo fees) ÷ its net profit, as a %. Lower is better. |
| Win days | Days with a profit ÷ days with a profit or a loss. |

**Benchmarks.** A **target pace** (24% a year by default; 12, 18, 30 and 36 are offered) is capital × the rate × the share of the financial year that has passed since the year's first session (1 April, or a later first session in the store) up to the last day shown. It has a figure for net profit and return only, and the other tiles say "no target figure". **Last FY** compares every tile with the year before, up to the same calendar day, and draws last year's running net on the chart. The badge on each tile is the gap: green when it is in your favour, red when it is not.

The line under the tiles has the average day, average win and loss, best and worst day, the **longest drawdown** (the most sessions in a row spent below the running peak), the latest 100-day average profit and profit/capital, the number of sessions, the algo fees, the collateral interest, **other debits (est.)** and the **net after both**. Other debits are the account charges no note or e-mail shows (DP charges, AMC and the like), estimated at ₹1,000 per broker a year and counted per calendar day from each broker's first note. Like the interest they sit beside the net profit, never inside it.

## The day's figures (the sheet's columns)

For each session:

- **Note net**: the final net of every F&O note that day, added over the accounts.
- **Algo fees** (the sheet's algo charges): AlgoTest's fee for the day's algo trades, `ROUNDUP((algos − 3) × 12.5 + 62.5)`, rounded up to the rupee. 4 algos is ₹75, 10 algos ₹150; no algos typed means no fee.
- **Net profit** (the sheet's Profit): note net − algo fees. This is the **Net** column in the Days table.
- **Charges**: the notes' total charges + the algo fees.
- **To date** and **Drawdown**: the running net profit from the first day of the year you picked, and how far it is below its running peak (zero at a new high).
- **Capital**: the morning's capital: the total you typed (or imported from the sheet), else Finvasia's and Angel One's figures added when both exist, else the last known capital carried forward. Angel One's is read after the previous session's close (15:50) and filled in for you; Finvasia's is typed.
- **Deposits, payouts and interest** e-mailed on a weekend or holiday count on the next session.

A day whose note failed to read is **open**: it says so, and its figures leave that note out until it is read. A day with no note on any account (no trade that day) says **no note**. Neither is ever shown as a zero.

## The chart

The running net to date with the benchmark's line. Hover a day for its profit, to-date figure and drawdown; **click** to open it. **Drawdown pane** adds the fall from the peak underneath; **Daily bars** adds each day's profit as a bar.

## Ratios (T, U, V, W, Z)

The sheet's rolling columns, counted over the sessions with a note and running from the first day in the store, as the sheet's do:

- **T**, 50-day average profit: the average net profit of the last 50 sessions.
- **U**, 100-day average profit: the same over 100 sessions.
- **V**, 100-day average charge: the average charges of the last 100 sessions.
- **W**, charge / profit: V × 100 ÷ U. Charges per rupee of net profit; lower is better.
- **Z**, profit / capital: U × 10,000 ÷ the 100-day average capital, in basis points of capital a day.

Each is blank until its window has 50 or 100 sessions. Averages are rounded to the rupee, as in the sheet. The range beside W's latest value counts only sessions where U is at least ₹100: when U is near zero, W divides by almost nothing and swings to thousands of percent either way, which says nothing about charges.

## Months and accounts

The sheet's summary block (net profit, max drawdown, the longest drawdown, win days, the average winning, losing and overall day, and the charges) is not repeated here: every figure in it is on the tiles or the line under them.

- **Monthly returns** shows April to March: each month's gain as a % of that month's average capital (or in ₹), and **3m**, the average of that month's and the two before. The table below has one row per financial year; a click opens that year.
- **By account** gives each account's net, average capital, return and charge / profit, and the year's algo fees on their own row. **Charges by kind** splits the year's charges into the notes' own charges, the algo fees, Angel One's collateral interest and the estimated other debits. The interest and the estimate are shown beside the charges, never inside the net profit: the sheet never had them.

## The Days table and the day drawer

One row per session, newest first, with its notes, net, charges, algos, to date, drawdown and the sources of its trades; an **RBI** or **Budget** badge marks a policy-decision or Budget day. **Show days with no note** hides the days without a note on any account (a day with a failed note always shows). **CSV** downloads the year's rows.

A row opens the day in a drawer: each account's note (obligation, charges, net) or why there is none, every charge of the day by kind (brokerage, STT, exchange, GST, SEBI, stamp, the algo fees and the collateral interest), the fills paired into trades, the market that day (an RBI policy decision or a Union Budget first, then India VIX at the open and its percentile, and each index's gap, range, 7-day IV at 15:00 with its percentile over the last year, and whether it was an expiry day), the ledger e-mails, and your inputs. The arrows step to the previous and next session.

**Edit inputs** opens the inputs dialog: the algo trades taken (the fee is shown as you type) and the capital, as one total or per broker. Only what you change is saved; clearing a field removes it. The page re-reads the day and the year after a save.

## Trades

Every trade, paired from the notes' fills: one contract on one account, from a flat position back to flat. A position carried overnight is one trade from the day it opened to the day it closed; its **Held** says overnight, and its row is under the day it closed.

**Period** picks a month (the newest with trades opens first) or the whole year. The best and worst points are read a month at a time, so the whole year shows every trade without them.

- **Source** says where a trade came from, matched against the 15:40 live capture by contract and entry minute: **Core** and **T1** are the tool's Adaptive lists, **Own algo** is one of your own AlgoTest or Quantiply strategies, **Manual** matched nothing although every strategy that traded carried its fills, **Unattributed** matched nothing while some strategy showed no fills (Quantiply gives only its P&L), and **Unknown** is a day with no live capture (before 19 Oct 2026, or a day it missed).
- A trade with no P&L is **open** (not closed yet) or **unresolved** (the note that closed it could not be read); the cards count those apart.
- **P&L** is the fills' own sum, already after the brokerage printed on each fill. **Charges** are the note's other charges shared out over the day's trades by turnover, so a note's trades add up to its final net. **Net** is P&L − charges.
- **Worst** and **Best** (MAE and MFE) come from the contract's 1-minute bars between entry and exit: how far the trade went against you, and how far in your favour, in rupees for its quantity. They exist only for index options the collector stores and for notes that print fill times; otherwise they are blank.
- **From spot** is the strike minus the index at entry, in points. **DTE** is weekdays to expiry.
- The cards add up each source's closed trades: net, how many won, the average. The scatter puts every trade with a best and worst point at its worst point (across) and the share of its best point it kept (up).
- **Angel One's trades start on 2 Feb 2026.** Its earlier notes came in older layouts whose trades did not all read, so they are left out of the trades, the cards and the turnover (the line under the turnover counts them). Their days still count in every day figure, total and ratio.
- **Turnover** is the whole year's F&O turnover, whatever the Period, for your CA, except in a year marked **partial**: FY 2025-26 leaves out Angel One's trades before 2 Feb 2026 (the sum of each trade's absolute P&L): a figure, not tax advice.

Filters for source, index and days to expiry sit above the cards and stay in the address.

## Money

- **Return on money in the account** compounds each day's net profit ÷ that day's capital, so a deposit never reads as a return.
- **Money in · out**: deposits and payouts from the ledger e-mails, with the count of fund settlements. With all accounts picked these are the F&O accounts' (Finvasia and Angel One); Zerodha's belong to Momentum.
- **Collateral interest**: Angel One's daily interest on the cash shortfall of the margin it lends against collateral.
- **Margin above 95%**: how many margin-shortfall warnings said 95% or more of the margin was in use.
- **Capital** charts the capital each day is measured against, with arrows on deposit and payout days, and **Ledger events** lists every e-mail; a row opens its day.

## Momentum

The Zerodha contract notes. That account trades nothing but Momentum, so every fill on it is a Momentum buy or sell: what was bought and sold, the charges and their share of the turnover, and every fill. **Open Momentum › This week** goes to the weekly plan the fills carried out.

> [!NOTE]
> The page reads the notes as they were stored. If a figure differs from your sheet for the same day, the day drawer shows the note's own figures and inputs, which is where to look first.
