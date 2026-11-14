# BL-226 — F&O stock momentum through options: a point-in-time F&O list, a stock-only sweep for three candidates, then buying their calls (and puts in a downtrend), rebalanced weekly

| | |
|---|---|
| **Priority** | P2 — a new strategy family over data we do not hold yet; behind finishing Momentum this month (BL-010, BL-001, BL-024, BL-025) |
| **Status** | Planned |
| **Type** | research |
| **Area** | momentum / options / trading-data |
| **Created** | 2026-11-15 |
| **Depends on** | the F&O bhavcopy reader of [BL-107](BL-107-nse-fo-bhavcopy-daily.md) (this item needs its history, not only the daily file); Momentum's ranking engine (`categories/broad.py`) and search harness (BL-010, BL-176); the vendor stock options of [BL-037](BL-037-stock-options-in-the-lake.md) for a fill check only |
| **TODO.md row** | — (filled in when started) |

## Context

The owner, 2026-11-15: run Momentum's stock strategy on F&O stocks only, over the last 5–6 years, with the
F&O list as it was each year (stocks enter and leave it); a basic sweep picks about three strategies; then,
for each stock a strategy holds, **buy its option** (ATM, OTM1, OTM2 tried) instead of the stock, rebalanced
weekly; when the trend is down, perhaps buy puts. Earlier the same day: momentum on F&O stock futures,
rebalanced at month end. Futures were set aside in discussion: one lot is roughly ₹5–15 lakh of exposure
(10 stocks ≈ ₹50–100 lakh on ₹15–25 lakh margin), against ₹50k lots in the current Momentum book. A bought
option costs a few percent of that, and its loss is capped at the premium.

What exists (checked 2026-11-15):
- **Stock daily prices:** the lake's `bars_1d/asset=stock` is the NSE cash-market bhavcopy, every listed
  stock, 2011 →. Momentum's Broad engine ranks it (`turnover_rank` / `total_market` universes).
- **No F&O list history** anywhere in the repo, and **no stock futures** (the lake's futures are the indices
  and MCX only).
- **Stock options:** only the vendor archive on the SSD (`stock options.zip`, 206 stocks, monthly expiries
  2024-10 → 2026-04, 1-minute, never imported, BL-037 P3). No collector (BL-038 Planned).
- **The F&O bhavcopy** (NSE's official end-of-day file of every F&O contract, BL-107 Planned) gives all three
  in one source, back many years: the F&O list on any day (a stock is on it when its futures are listed),
  every stock future's and stock option's daily OHLC, settle price, contracts, value and OI. NSE keeps the
  daily files in its public archives (the old format until 2024-07, the UDiFF format since; lot size is a
  column in UDiFF and must be derived before it).
- Related findings: BL-085 killed a slower (monthly) cadence and several other levers for Broad after tax;
  BL-010 and BL-176 searched Momentum's settings on 2016 → 2026 stock data.

## Goal

A pre-registered answer to: **does buying calls (and, in a downtrend, puts) on momentum-ranked F&O stocks,
rebalanced weekly, beat holding the same stocks, after option costs, slippage and tax?** If it does, one
configuration goes to a forward paper journal; if not, the item says why and stops.

## Out of scope

- Stock futures as the traded instrument (set aside above; Phase 1 still keeps their daily rows, so it can
  be revisited cheaply).
- Intraday entries, intraday stops, and 1-minute stock options beyond the fill check.
- Selling options (premium-selling on momentum names).
- Any live order; any change to the current Momentum book.

## Plan

### Phase 0 — Decisions and pre-registration
Owner's answers first (open questions below), then this block filled in and committed **before any run**.
- **Hypothesis:** the calls of the top-ranked F&O stocks, held a week, earn more than the stocks after
  option costs, because the momentum move is convex in the option; with a trend filter, the puts of the
  bottom-ranked stocks earn in falling markets.
- **Universe:** on each rebalance day, the stocks whose futures are listed in that day's F&O bhavcopy, minus
  any in the F&O ban period that day. Never today's list for a past day.
- **Look-ahead check:** the ranking on day D uses closes up to D only; the option is entered at D's close or
  settle price and exited at the next rebalance day's; strikes and expiries are chosen from contracts listed
  on D; a cut-off copy test like `mbt audit lookahead-requests` for the stock sweep.
- **Periods:** data from 2019-01 so a 12-month look-back is ready by 2020-01. Learning: 2020-01 → 2024-06;
  confirmation: 2024-07 → the last full week (locked until the learning read is written).
  Caveat to record: Broad's settings were already searched on these years (BL-010, BL-176), so the
  confirmation is not fully unseen for the **stock signal**; it is unseen for the options layer. The forward
  journal (Phase 5) is the clean test.
- **Pass / kill (options layer, per candidate, confirmation period):** the options book's net after costs,
  slippage and slab-rate tax beats the same picks held as stock (after delivery costs and capital-gains tax)
  on total return and is not worse than 1.5× its maximum drawdown; a block-bootstrap 90% interval of the
  weekly difference above zero. Kill if none of the three candidates × three moneyness levels pass.
- **Will not run:** strike, expiry or stop rules invented after the learning read; more than the grid below.

### Phase 1 — F&O history (data)
- **Tasks:** fetch the daily F&O bhavcopy from NSE's archive, 2019-01 → today (about 1,750 files, both
  formats), into `raw/` and a lake table (shared with BL-107's daily job, one reader); derive per day the F&O
  stock list (futures listed), each contract's lot size (UDiFF column; before 2024-07 from value ÷ contracts ÷
  price, checked against NSE's lot-size circulars on a sample) and strike grid; fetch the daily ban-list file
  (`fo_secban`) for the same days (if NSE's archive lacks early years, record the gap and treat those days as
  unbanned, flagged). Check that the stock price series used for ranking is adjusted for splits and bonuses
  for every F&O stock, not only Nifty 50 (Momentum's corporate actions), and that option strikes around a
  split are matched to the adjusted series.
- **Deliverables:** the lake table and a `tdata`/`obt` command; a membership table (stock, from, to); a
  report: stocks on the list per month, entries and exits, ban days.
- **Done when:** the list's entries and exits match NSE's inclusion and exclusion circulars on 20 sampled
  events, and lot sizes match the circulars on 20 samples.

### Phase 2 — Stock-only sweep on the F&O universe (three candidates)
- **Tasks:** add an `fno` universe to the Broad engine (point-in-time, from Phase 1); run a **small**
  pre-registered grid over the learning period with stock costs: look-back (3, 6, 12 months; Momentum's
  score as it is), top N (5, 8, 10), cadence (weekly, monthly at expiry), Momentum's current exits; plus
  Momentum's current headline and favourites unchanged on the new universe. Rank by the pre-registered
  criterion (net after tax, drawdown-penalised; the BL-010 harness's deflated Sharpe and PBO reported) and
  keep the top three, as long as they differ in look-back or N (not three neighbours of one cell).
- **Deliverables:** the grid's results; the three candidates and why.
- **Done when:** the three are written here before Phase 3 starts.

### Phase 3 — Options overlay (calls), weekly
- **Tasks:** for each candidate and each moneyness (ATM, OTM1, OTM2 by the stock's listed strike grid on
  the day), buy the call of every held stock at the rebalance close (settle price when the contract did not
  trade that day; skip the stock when neither exists or the strike's OI is under a threshold set in Phase 0),
  sell it at the next rebalance close. Expiry: stock options are monthly only, so use the current month when
  it has at least 10 trading days left, else the next (fixed in Phase 0). Sizing: an equal premium budget per
  stock, rounded to whole lots (a stock whose single lot costs more than twice the budget is skipped and
  counted). Costs: brokerage per order, STT on the sell premium, exchange and SEBI charges, stamp duty, and
  slippage by moneyness (1 / 2 / 3 % of premium, with a sensitivity at double). Comparators: the same picks as
  stock; the same picks at the same delta exposure in stock (to separate convexity from leverage).
- **Fill check:** on 2024-10 → 2026-04, compare the bhavcopy close used for fills with the vendor's 1-minute
  last half-hour for 200 sampled entries and exits; if the gap is larger than the slippage assumed, raise it.
- **Variants (pre-registered, at most two):** skip a stock whose results fall inside the holding week;
  cap the option's IV percentile (bought only below its 1-year 80th percentile).
- **Done when:** the learning read is written, then the confirmation run and the pass / kill verdict.

### Phase 4 — Down-trend side (puts)
- **Tasks (two pre-registered forms, run only if Phase 3 has a candidate that passes):**
  (a) market gate: when NIFTY's close is below its 200-day average (or the share of F&O stocks above their own
  is under 40 %), the book buys the puts of the bottom-ranked N instead of the calls of the top N;
  (b) long-short: always the top N's calls and the bottom N's puts at half budget each.
  Same costs, fill rules and pass / kill as Phase 3, against the Phase 3 book.
- **Done when:** verdict written.

### Phase 5 — Forward paper journal (only if something passed)
- **Tasks:** a hash-chained weekly journal like BL-024 / BL-219: picks, strikes, entry and exit prices from
  the day's F&O bhavcopy; 20 weeks before any real money.
- **Done when:** 20 forward weeks scored against the pass rule.

## Risks

- **Liquidity:** OTM2 calls of mid-caps can go days without a trade; bhavcopy closes are then stale. The OI
  filter, the settle-price rule and the fill check are the guard; OTM2 may be dropped for thin names.
- **Theta and IV:** momentum names often carry raised IV; a week of decay on a monthly option eats the move.
  The IV variant measures it; results days are the sharpest case.
- **Lot sizes:** some single lots cost more than the per-stock budget at small capital; skipped stocks change
  the book. Counted and reported.
- **Snooping:** the stock signal's years were searched before (Phase 0 caveat); the grid is kept small and
  the forward journal is the deciding test.
- **Tax:** option P&L is business income at the slab rate; the comparison uses it, not capital-gains rates.
- **Data:** NSE's archive formats and URLs change; the 2024-07 format switch must give identical membership
  either side of it.

## Open questions

1. Period: data from 2019-01, signals from 2020-01, learning to 2024-06 and confirmation after — or another split?
2. The stock sweep: a small grid on Broad's engine as above, or a wider BL-010-style search?
3. Cadence for the options: weekly only (as asked), or monthly at expiry beside it?
4. Puts: the market-gate form, the long-short form, or both?
5. Capital for the options book (it sets the per-stock budget and which lots are affordable)?
6. Fold BL-107's daily bhavcopy job into Phase 1 (same reader), or keep them apart?

## Log

- 2026-11-15 — created from the owner's idea (futures momentum, then options on momentum-ranked F&O stocks,
  weekly, puts in a downtrend); data checked: stock daily prices 2011 →, no F&O list history, no stock
  futures, vendor stock options 2024-10 → 2026-04 only.
