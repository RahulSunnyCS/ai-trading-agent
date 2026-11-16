# BL-226 — F&O stock momentum through options: a point-in-time F&O list, a stock-only sweep for three candidates, then buying their calls (and puts in a downtrend), rebalanced weekly

| | |
|---|---|
| **Priority** | P2 — a new strategy family over data we do not hold yet; behind finishing Momentum this month (BL-010, BL-001, BL-024, BL-025) |
| **Status** | Done — killed |
| **Type** | research |
| **Area** | momentum / options / trading-data |
| **Created** | 2026-11-15 |
| **Depends on** | the F&O bhavcopy reader of [BL-107](BL-107-nse-fo-bhavcopy-daily.md) (this item needs its history, not only the daily file); Momentum's ranking engine (`categories/broad.py`) and search harness (BL-010, BL-176); the vendor stock options of [BL-037](BL-037-stock-options-in-the-lake.md) for a fill check only |
| **TODO.md row** | 3.10.75 |

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
Owner's answers (2026-11-15): learning 2020-01 → 2024-06, confirmation 2024-07 → the last full week; a small
stock grid; both put forms; the options book sized for **₹10 lakh**. Taken as the default, not asked: weekly
cadence for the options (as the idea said), monthly only as a stock-grid cell; the history reader is the one
BL-107's daily job will use (same table), BL-107's schedule stays its own item.

This block is the pre-registration; it is committed before any run and never edited after one.
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
- **Fixed numbers:** budget per stock = ₹10 lakh ÷ N (rounded to whole lots, at least one; a stock whose one
  lot costs over twice its budget is skipped and counted); expiry = the current month when it has at least 10
  trading days left on the entry day, else the next; a strike is tradable when it has open interest of at
  least 10 lots on the entry day; the fill is the day's close when the contract traded, else its settle price
  (flagged and counted); slippage 1 / 2 / 3 % of premium for ATM / OTM1 / OTM2, each way, with a sensitivity
  at double; costs: ₹20 brokerage per order, STT on sell premium at the rate of the day, NSE transaction and
  SEBI charges, stamp duty on buys, GST on brokerage and charges; tax: option net at a 30 % slab plus cess,
  stock at the capital-gains rates of the day.
- **Stock grid (Phase 2):** Broad's score with look-back 3, 6, 12 months × top N 5, 8, 10 × cadence weekly,
  monthly (the day after the monthly expiry) = 18 cells, plus Momentum's current headline and its saved
  favourites run unchanged on the F&O universe. Ranked on the learning period by after-tax CAGR ÷ maximum
  drawdown; the BL-010 harness's deflated Sharpe and PBO reported beside it. The three kept must differ in
  look-back or N.
- **Will not run:** strike, expiry or stop rules invented after the learning read; more than the grid above
  and the two Phase 3 variants; the confirmation period before the learning read is written here.
- **How the rules map onto the engine (written 2026-11-15 before any Phase 2 or 3 run; reading, not
  change):** Phase 2 runs Broad with `broad_universe="fno"` (the stock universe gated week by week by the F&O
  list; `categories/fno.py`). Grid cells: category layer off, the default `ranksum` score with equal
  weights over Broad's horizons up to the look-back ((1, 4, 13), (1, 4, 13, 26), (1, 4, 13, 26, 52)
  weeks), top N held with an exit rank of 2N, weekly = every Friday, monthly = Broad's `monthly`
  cadence (the weekly grid has no expiry-day rebalance); realism from the invested favourite (signal
  delay 1, Friday close, itemised costs, 15 bps slippage, circuits respected, liquidity gate on), ₹10 lakh
  and no share-price cap; capital-gains tax on (`tax.TaxRules()` defaults). Favourite groups: every
  member's saved settings unchanged except the universe and the window, sleeves blended at equal
  capital. Phase 3 trades the candidate's weekly holdings (each sleeve with its share of the budget);
  the rebalance day is the last F&O session of the Momentum week; ATM = the listed strike nearest
  the stock's unadjusted cash close. Variant "skip a results week": **not run**, the repo holds no
  results calendar (logged). Variant "IV cap": the stock's ATM call IV (Black-Scholes, 6.5 %) at
  or above the 80th percentile of its previous 52 rebalance-day readings (26 needed). Phase 4's
  bottom N: the N worst-ranked eligible stocks in the candidate's own ranking; NIFTY's 200-day
  average from the lake's NIFTY index closes; each form scored against the Phase 3 book of the
  same candidate and moneyness with Phase 3's pass rule. Code: `obt nse ...`,
  `scripts/bl226_fno_sweep.py`, `scripts/bl226_options_book.py` (momentum-backtesting).

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

## Result

**Killed (2026-11-15).** On the locked confirmation weeks (2024-07 → 2026-11, 124 weeks) none of the nine
registered call books (three candidates × ATM / OTM1 / OTM2) passes: every one fails the drawdown rule, seven
lose money after tax, and no 90 % interval of the weekly difference is above zero. Phase 4 (puts) was not
run, by its own gate (only after a passing call book); Phase 5 is moot.

- **Learning (2020-01 → 2024-06):** the books made +511 % to +1,190 % on ₹10 lakh after tax, against +229 %
  to +289 % for the same stocks held; one book (Trio ATM) met all three rules.
- **Confirmation:** Trio ATM +42 % against +27 % for the stock, but a −82 % drawdown on the ₹10 lakh
  (limit −42 %) and an interval of −1.57 to +1.27 % a week; its confirmation net comes from its top 21
  trades (5 %): without them it loses ₹22.6 lakh before tax. Mix ATM −182 %, grid ATM −444 %.
- **Why:** the gain is leverage. In every book the same delta held in shares earned more before tax than the
  calls; the stock signal itself weakened after mid-2024 (5–11 % a year after tax, Phase 2), and a book
  that spends ₹2–11 lakh of premium a week on ₹10 lakh multiplies a weak signal's losses.
- **Kept:** the NSE F&O history and the point-in-time F&O list (`obt nse fo-fetch / fno-build`, BL-107's
  reader), the `fno` Broad universe (`broad_universe="fno"`), and the two research scripts.
- **Caveats:** daily closes, not tradable quotes (slippage 1–3 % assumed, doubled as a sensitivity); a
  contract missing on the exit day (a corporate action re-strikes it) is booked at zero; results-week skip
  not run (no results calendar); the stock signal's years were searched before (Phase 0 caveat).
- **Review amendment (2026-11-16): not re-scored.** The nine call books were run **without** Phase 0's
  F&O ban-period rule (`bans.parquet` was written but no code read it), so a few entries were in stocks no
  account could open that day. `run_book` now skips and counts them (`banned`), but the figures above and
  the table in the Log were not re-run and stand as unverified until BL-230. Four registered checks were
  also not run and are not recorded as passed: the stock sweep's cut-off-copy look-ahead test, deflated
  Sharpe and PBO beside the Phase 2 ranking, the Phase 3 fill check against the vendor's 1-minute data
  (200 entries and exits), and the split/bonus adjustment check of every F&O stock's ranking series. The
  "killed" verdict rests on every call book missing the drawdown rule by a wide margin, which a few ban-day
  entries are not expected to change; that is a judgement, not a re-score.

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

Answered 2026-11-15 (Phase 0). As first asked:

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
- 2026-11-15 — started (owner: "Start it"). Answers in Phase 0. Checked before code: NSE's archive serves the
  old-format F&O file for 2019-01-01, the UDiFF file for 2024-11-01 and the ban-list file for 2019-01-01 and
  2026-11-13 (browser User-Agent, nseindia.com Referer). Broad's engine takes its universe as members by
  **year** (`broad.py`, `members_by_year`); the F&O list changes within a year, so Phase 2 needs membership by
  rebalance date (or by month) for the `fno` universe, not a yearly set.
- 2026-11-15 — owner, before an overnight run: on finishing, push the branch and open a PR with a code
  review (not merged); Phase 5 (the forward journal) is left for the owner's read, not built.
- 2026-11-15 — **Phase 1 done.** `obt nse fo-fetch` stored every session 2019-01-01 → 2026-11-13: 1,942 days
  (1,740 + the 2026-11-13 test day + a few weekend sessions; 99 weekdays with no file = holidays), 1.1 GB
  in the lake (`lake/eod/fo_bhavcopy/`) and 1.4 GB raw; ban lists for 1,724 days (16 sessions have no
  ban file in NSE's archive; treated as unbanned). `obt nse fno-build`: 355 symbols on the list at some
  time, 356,682 member-days, 185 entries and 167 exits; about 200 stocks in 2019, ~140 after the
  2019-20 cuts, 180–200 in 2022-24, 227 after the 45 added on 2024-11-29, ~210 now. Checked against
  NSE's announcements on three batches: the 45 stocks added on 29 Nov 2024 (ZOMATO, JIOFIN, DMART, LICI,
  PAYTM, … all 45 present that day), the 16 excluded after the Feb 2025 expiry (ABBOTINDIA, ATUL,
  BATAINDIA, CANFINHOME, COROMANDEL, CUB, GNFC, GUJGASLTD, INDIAMART, IPCALAB, LALPATHLAB, METROPOLIS,
  NAVINFLUOR, PVRINOX, SUNTV, UBL — last day 2025-02-27) and the June 2019 cut (34 last seen 2019-06-27);
  renames show as an exit and an entry (LTIM → LTM, ICICIPRULI → ICICILIFE), and every F&O symbol but
  ICICILIFE (renamed 2026-10) is a stock instrument of its own, so the weekly gate follows each name.
  **Lot sizes:** the old format's lot is derived (OI gcd, then the divisor matching the futures' value
  per contract within 5 %, else the contract-life gcd); on the 359,080 UDiFF contract-days where NSE
  states it, 355,881 are equal (99.1 %), none a multiple, 919 a divisor, 2,280 had no OI. This replaces
  the 20-sample circular check planned for lots (it is a check on every stated day). Old-format days:
  648,250 agree with the value estimate, 1,982 differ, 51,613 unchecked (no futures trade).
- 2026-11-15 — Phase 2 learning sweep run (`scripts/bl226_fno_sweep.py learn`, scratch data copy).
  
  **Phase 2 learning read (2026-11-15, 2020-01-03 → 2024-06-28, 235 weeks, after capital-gains tax; Nifty 50
  benchmark 16.2 % a year).** 30 runs, none failed. Top ten by CAGR ÷ max drawdown:
  
  | Rank | Run | Calmar | CAGR after tax | Max DD | Buys a year |
  |---|---|---|---|---|---|
  | 1 | Four-Strategy Mix, BSE Tags (`fav-b2e4bcdc91df`) | 1.31 | 31.3 % | -24 % | 34.1 |
  | 2 | grid-12m-top10-weekly (`grid-12m-top10-weekly`) | 1.01 | 29.5 % | -29 % | 244.7 |
  | 3 | Trio Fortnightly · all Fridays (`fav-1258177078c9`) | 0.96 | 33.7 % | -35 % | 23.9 |
  | 4 | grid-12m-top5-monthly (`grid-12m-top5-monthly`) | 0.95 | 36.3 % | -38 % | 48.2 |
  | 5 | grid-6m-top10-weekly (`grid-6m-top10-weekly`) | 0.86 | 25.1 % | -29 % | 291.4 |
  | 6 | grid-12m-top8-monthly (`grid-12m-top8-monthly`) | 0.85 | 32.5 % | -38 % | 68.8 |
  | 7 | grid-12m-top8-weekly (`grid-12m-top8-weekly`) | 0.83 | 24.9 % | -30 % | 214.6 |
  | 8 | grid-12m-top5-weekly (`grid-12m-top5-weekly`) | 0.83 | 26.8 % | -32 % | 155.1 |
  | 9 | Phase 6 ensemble (`fav-9f553845b09c`) | 0.83 | 28.1 % | -34 % | 35.3 |
  | 10 | Four Sectors, Half Tilt · all Fridays (`fav-0114cc82baed`) | 0.82 | 25.2 % | -31 % | 17.9 |
  
  Short look-backs are worst: every 3-month cell is below 0.52 (the 3-month top-5 weekly 0.10).
  Kept (distinct look-back or N): **Four-Strategy Mix, BSE Tags** (the invested favourite, on F&O stocks),
  **grid 12 months / top 10 / weekly**, **Trio Fortnightly**. Descriptive only: the stock signal's years were
  searched before (Phase 0 caveat). For Phase 3 a favourite's N is the stocks it holds per sleeve
  (categories × picks per category: 9, 8, 12 and 8 for the Mix's four members, 9 for both Trio sleeves),
  not its category count.
- 2026-11-15 — Phase 2 confirmation (2024-07-05 → 2026-11-13, 124 weeks, after tax; Nifty 50 1.4 % a year): Mix
  6.4 % a year (max DD −23 %), grid 12m top 10 weekly 5.4 % (−18 %), Trio 11.2 % (−22 %). No stock-layer
  pass rule (Phase 2 only chooses the candidates); all three beat the index, far less than in learning.
- 2026-11-15 — **Phase 3 learning read** (calls, 2020-01 → 2024-06, 235 weeks; ₹10 lakh book, P&L after costs,
  slippage and 31.2 % tax on each financial year's net; the stock book after capital-gains tax). Options total
  and drawdown are on the ₹10 lakh (the book does not compound; a drawdown below −100 % means losses beyond the
  capital). Pass = options total > stock's, options drawdown ≥ 1.5 × stock's, 90 % interval of the weekly
  difference above zero.

  | Book | Moneyness | Options total | Options DD | Stock total | Stock DD | Weekly diff 90 % | Win rate | Premium a week | Pass |
  |---|---|---|---|---|---|---|---|---|---|
  | Mix | ATM | +1190 % | -60 % | +265 % | -24 % | +0.86 to +8.60 % | 48 % | ₹7.0 lakh | no |
  | Mix | OTM1 | +999 % | -84 % | +265 % | -24 % | -0.18 to +7.90 % | 46 % | ₹7.3 lakh | no |
  | Mix | OTM2 | +653 % | -120 % | +265 % | -24 % | -1.34 to +6.33 % | 41 % | ₹7.2 lakh | no |
  | Grid 12m top 10 | ATM | +931 % | -73 % | +229 % | -29 % | -0.73 to +7.54 % | 44 % | ₹8.4 lakh | no |
  | Grid 12m top 10 | OTM1 | +773 % | -100 % | +229 % | -29 % | -2.01 to +7.41 % | 41 % | ₹8.9 lakh | no |
  | Grid 12m top 10 | OTM2 | +511 % | -129 % | +229 % | -29 % | -2.89 to +6.02 % | 38 % | ₹8.6 lakh | no |
  | Trio | ATM | +837 % | -49 % | +289 % | -35 % | +0.03 to +5.95 % | 47 % | ₹3.7 lakh | yes |
  | Trio | OTM1 | +758 % | -78 % | +289 % | -35 % | -0.38 to +5.83 % | 44 % | ₹3.8 lakh | no |
  | Trio | OTM2 | +611 % | -73 % | +289 % | -35 % | -0.77 to +4.92 % | 42 % | ₹3.8 lakh | no |

  Variants (same table, not shown): double slippage cuts every book and fails all; the IV cap lowers
  drawdowns a little (Mix ATM −60 → −54 %) and totals more, passing none. Only **Trio ATM** passes in
  learning (+837 % against +289 %, −49 % against a −52 % limit, interval +0.03 to +5.95 % a week); Mix ATM
  fails on drawdown alone (−60 % against −36 %). In every book the equivalent stock exposure (the calls'
  delta in shares) earned more before tax than the calls (e.g. Mix ATM ₹1.95 crore against ₹1.73 crore): the
  gain is leverage, not convexity. Skips: strikes under 10 lots of OI (Mix 3,575 of 9,318 stock attempts), the
  favourites' Gold, Silver, Nasdaq 100, Hang Seng and idle-cash holdings (no stock options; their budget is
  left unspent, the stock comparator keeps them), one lot dearer than twice the budget (Mix 1,287).
- 2026-11-15 — scratch outputs lost at an app restart; the Phase 2 confirmation and the Phase 3 books re-run into
  `packages/momentum-backtesting/data/bl226/` (git-ignored): the learning figures reproduced to the rupee.
- 2026-11-15 — **Phase 3 confirmation (registered verdict): killed.** Base books on 2024-07-05 → 2026-11-13:

  | Book | Moneyness | Options total | Options DD | Stock total | Stock DD | Weekly diff 90 % | Win rate | Pass |
  |---|---|---|---|---|---|---|---|---|
  | Mix | ATM | -182 % | -308 % | +17 % | -22 % | -5.28 to +1.80 % | 37 % | no |
  | Mix | OTM1 | -395 % | -474 % | +17 % | -22 % | -6.94 to -0.37 % | 35 % | no |
  | Mix | OTM2 | -591 % | -708 % | +17 % | -22 % | -9.00 to -1.87 % | 32 % | no |
  | Grid 12m top 10 | ATM | -444 % | -579 % | +10 % | -19 % | -8.83 to +0.47 % | 40 % | no |
  | Grid 12m top 10 | OTM1 | -852 % | -970 % | +10 % | -19 % | -12.08 to -2.88 % | 37 % | no |
  | Grid 12m top 10 | OTM2 | -979 % | -1125 % | +10 % | -19 % | -13.61 to -3.68 % | 35 % | no |
  | Trio | ATM | +42 % | -82 % | +27 % | -28 % | -1.57 to +1.27 % | 41 % | no |
  | Trio | OTM1 | +26 % | -108 % | +27 % | -28 % | -1.93 to +1.24 % | 39 % | no |
  | Trio | OTM2 | -49 % | -171 % | +27 % | -28 % | -2.79 to +0.55 % | 34 % | no |

  Double slippage and the IV cap fail too. Phase 4 not run (its gate). Item closed; Result above.
- 2026-11-15 — PR #450 review (10 findings). Fixed: the live preview, signal and order paths now refuse
  `broad_universe="fno"` with its own reason (`LIVE_REFUSED_BROAD_UNIVERSES`); a ban list NSE does not have
  is recorded in the manifest and not asked again; the manifest is saved every 50 days actually fetched.
  Left in the research scripts, which are this item's registered record (changing them would make it no
  longer reproduce): contracts re-struck by a corporate action booked at zero, the NaN-premium guard, the
  trade across the learning / confirmation cut, the bottom-N filter, the look-back labels in the
  distinctness check, the slow CDF and the script's location. All are tasks of BL-227 Phase 1, where the
  engine moves into the package.
- 2026-11-16 — PR #450 second review. Fixed in code, with tests: the ban rule is applied in `run_book` (day
  -> banned symbols from `bans.parquet`, `fno.load_bans`); the F&O list file is in `db_read.data_version()`
  (so `input_version()` and the Broad ranking caches) and in `search.data_snapshot()` (a digest of its
  rows up to the run's end date); the put books take the bottom-N's own N, so Trio and the Four-Strategy Mix
  no longer crash; a body NSE serves that is not a zip stops `obt nse fo-fetch` like any other failed
  request, with the day on record and the manifest saved. Not fixed, only recorded: the Result's figures
  were not re-scored and four registered checks were not run (Review amendment above). Re-run: BL-230.
