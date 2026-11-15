# BL-228 — Puts on falling F&O stocks: does buying the weakest stocks' puts weekly beat cash?

| | |
|---|---|
| **Priority** | P2 — the owner asked for it (2026-11-15, "what about taking PE also"); research only, nothing live depends on it |
| **Status** | Done — killed at learning (2026-11-15) |
| **Type** | research |
| **Area** | momentum / options |
| **Created** | 2026-11-15 |
| **Depends on** | [BL-226](BL-226-fno-momentum-stock-options.md) (the NSE F&O history, the point-in-time F&O list, the `fno` Broad universe, the options book) |
| **TODO.md row** | 3.10.76 |

## Context

BL-226 tested buying the calls of Momentum's strongest F&O stocks and killed it. Its Phase 4 (puts) never ran:
its own gate said to run it only after a passing call book, and it compared the puts against that call book.
The PR #450 review also found that BL-226's put list was not limited to F&O stocks: Broad's ranking includes
Gold, Silver, Nasdaq 100, Hang Seng, cash and split segments. The owner, 2026-11-15, chose a new, small test
registered first: puts on their own, against cash, over the same learning and confirmation years.

Nothing on the short side of Momentum has been tested in this repo before (`research/momentum/`); the years
2020–2024 were read for the long side in BL-226 and earlier Momentum work, so the market's path is known
(caveat below).

## Goal

A verdict, on the confirmation weeks, for whether a weekly book of bought puts on the F&O stocks with the
weakest momentum and their own trend down makes money after costs and tax at ₹10 lakh.

## Out of scope

Selling options, intraday stops, index puts, any change to the call side, live orders, the dashboard (BL-227).

## Plan

### Phase 0 — Pre-register
Committed before any run. A rule is never edited after a run.

- **Hypothesis:** buying one lot each of the puts of the N weakest-momentum F&O stocks whose own trend is down,
  swapped weekly, earns more than cash after costs and tax, with a drawdown no worse than 40 % of ₹10 lakh.
- **Universe:** each week, the stocks on NSE's F&O list (futures listed that day, `lake/eod/fno_universe`,
  BL-226 Phase 1) that also pass Momentum's tradability filter as in BL-226's grid (turnover ≥ ₹2 crore,
  worst-day floor 0.25, price ≥ ₹30, circuits), read from Broad's `fno` universe frame
  (`broad.load_stock_universe_frame(universe="fno")`): its adjusted weekly closes, split segments kept apart
  (a segment needs its own 52 weeks), point-in-time membership. Only F&O stocks: no index, ETF, commodity or
  cash column can be picked.
- **Weeks and days:** each Momentum week's rebalance day is its last F&O session (BL-226's rule), 2020-01 →
  the last full week (2026-11-13). The book enters on a rebalance day's close and exits on the next one's.
- **Selection (read at the previous week's close, as BL-226's books with `signal_delay=1`):**
  - score: Momentum's rank-sum over 1, 4, 13, 26 and 52-week returns of the adjusted weekly closes, across
    the week's eligible stocks with all five returns; the N lowest sums are the N weakest;
  - own trend down: the stock's 26-week return is below zero **and** its close is below its 40-week average
    (about 200 sessions);
  - the N weakest are kept only where their own trend is down, so a week can hold fewer than N, or none;
  - a stock in that rebalance day's F&O ban list is skipped (a day without a ban file counts as no bans).
- **Contract (BL-226's rules, for puts):** expiry = the nearest with at least 10 sessions left after the entry
  day, else the next; ATM = the listed put strike nearest the stock's unadjusted cash close on the entry day,
  OTM1 / OTM2 = one / two listed strikes lower; tradable when that strike's OI is at least 10 lots; filled at
  the close when it traded, else at the settle price (counted); a contract with no row on the exit day is
  booked at zero (counted and its trades listed).
- **Sizing:** one lot per stock (the lot of that contract that day). ₹10 lakh capital; idle capital is not
  credited with interest, and neither is cash, so the comparison is on the options P&L alone.
- **Costs, slippage, tax:** BL-226's: ₹20 an order, STT on the sell premium, NSE transaction charges, SEBI,
  stamp, GST; slippage 1 / 2 / 3 % of premium each way for ATM / OTM1 / OTM2 (double slippage reported as a
  sensitivity, not deciding); each financial year's net taxed at 30 % + 4 % cess, a loss carried forward.
- **Grid (12 books):** N ∈ {5, 10} × moneyness {ATM, OTM1, OTM2} × form:
  - **always:** the rule every week;
  - **gated:** only in weeks when NIFTY's close on the previous week's last session is below its 200-session
    average (NIFTY's daily closes from the lake's 1-minute index bars); else no position.
- **Pass rule (per book, per window):** all three of
  1. after-tax P&L above zero;
  2. the 90 % block-bootstrap interval of the weekly after-tax return on ₹10 lakh (5,000 draws, 4-week blocks,
     seed 20261115) has its lower bound above zero;
  3. maximum drawdown of the ₹10 lakh equity no worse than −40 %.
- **Hold-out:** learning = trades exiting by 2024-06-28; confirmation = trades entered from 2024-07-01, kept
  unread until the learning read is written here and committed.
- **Carried to confirmation:** the books that pass on learning, ranked by learning after-tax P&L ÷ |drawdown|,
  at most three. None passing = killed at learning; the confirmation weeks stay unread.
- **Kill / keep:** keep (as a candidate for a forward journal, a new item) only if at least one carried book
  passes on the confirmation weeks; else killed. Twelve books were tried; a single pass is read with that in
  mind.
- **Look-ahead check:** the ranking and both trend tests read only closes to the previous week's last session;
  F&O membership and the ban list are the entry day's own files (published before the next session; the
  entry at that day's close is the convention BL-226 used); the expiry choice reads the session list (an
  exchange calendar known in advance); the lot is that day's file. A unit test shifts a future week's prices
  and checks the picks before it do not move.
- **Survivorship:** the F&O list is point-in-time (stocks removed or delisted later are in it while listed).
- **Snooping caveat:** the 2020–2024 market path is known from earlier long-side work; the short side was not
  tested, but the gated form's NIFTY trigger is the textbook one, chosen before any run, not tuned.
- **Will not run:** other trend tests (breadth, NIFTY's own 26-week return), other N, a budget-based sizing,
  stops. Each needs `override: <reason>` in the Log.
- **Descriptive extras (after the verdict, not deciding):** weeks with any position and weeks gated on, per
  year; the market-switch book (BL-226's Trio ATM calls while NIFTY is above its average, this rule's puts
  while below) beside Trio ATM alone.

### Phase 0b — Mirror pool (added 2026-11-15, before any Phase 0 learning result was read)
The owner's idea: put every F&O stock's chart and its inverse (1 ÷ price) into one pool and rank all of
them for upward momentum; a stock picked buys its call, an inverse picked buys the stock's put.
- **Why it differs from Phase 0:** with log returns the inverse chart's return is exactly minus the stock's,
  so ranking the 2 × N charts together ranks each stock against the others' falls as well as their rises.
  In a falling market the inverse charts fill the top; in a rising one the stocks do. The book tilts between
  calls and puts by itself, with no NIFTY gate.
- **Score:** per horizon (1, 4, 13, 26, 52 weeks), the log return of every eligible stock and of its inverse
  (its negative), ranked across the combined pool; the rank-sum, highest first. Same universe, adjusted
  weekly closes, segments and eligibility as Phase 0, read at the previous week's close.
- **Own trend up for the chart picked:** its 26-week log return above zero and its close above its own
  40-week average (the inverse chart's average is of 1 ÷ price). A stock and its inverse cannot both pass.
- **Picks:** the top N charts of the pool, kept where their own trend is up; a stock → its ATM call, an
  inverse → the stock's ATM put; ban list skipped; one lot each; contracts, fills, costs, slippage, tax as
  Phase 0.
- **Books (2):** N ∈ {5, 10}, ATM only (the owner's form).
- **Pass rule, windows, carry and kill:** Phase 0's, against cash (both books may be carried).
- **Descriptive (not deciding):** the share of positions that were puts, by year; the same top-N stocks'
  calls alone (one lot, ATM) beside it.

### Phase 1 — Run and verdict
- **Tasks:** `packages/momentum-backtesting/scripts/bl228_fno_puts.py` (reuses BL-226's options book
  functions; the put list built as above); learning read written here and committed; then the carried books'
  confirmation; the findings page.
- **Deliverables:** the learning table, the confirmation table, the verdict, the extras.
- **Done when:** the verdict is in Result, `research/momentum/common/options-overlay.md` updated, `TODO.md`
  and `INDEX.md` rows closed.

## Result

**Killed at learning (2026-11-15).** No book of either rule set passes the learning rule, so none was carried and
the confirmation weeks (2024-07 →) were not read. Learning = trades exiting 2020-01 → 2024-06-28, 235 weeks,
₹10 lakh, after costs, slippage and 31.2 % tax; files under `packages/momentum-backtesting/data/bl226/bl228/`
(git-ignored).

**Phase 0 — puts on the weakest, down-trending F&O stocks (12 books): all lose.**

| Book | Trades | Weeks held | After tax | Drawdown | 90 % weekly | Win rate |
|---|---|---|---|---|---|---|
| N5 ATM every week | 614 | 206 | −₹12.5 lakh | −119 % | −0.86 to −0.13 % | 32 % |
| N5 OTM1 every week | 608 | 201 | −₹12.6 lakh | −120 % | −0.83 to −0.20 % | 30 % |
| N5 OTM2 every week | 609 | 203 | −₹11.3 lakh | −110 % | −0.75 to −0.15 % | 29 % |
| N5 ATM NIFTY-gated | 116 | 35 | −₹1.3 lakh | −35 % | −0.29 to +0.19 % | 31 % |
| N5 OTM1 NIFTY-gated | 116 | 35 | −₹2.0 lakh | −32 % | −0.28 to +0.11 % | 28 % |
| N5 OTM2 NIFTY-gated | 111 | 33 | −₹1.8 lakh | −31 % | −0.26 to +0.10 % | 27 % |
| N10 ATM every week | 1,158 | 216 | −₹27.7 lakh | −205 % | −1.79 to −0.48 % | 32 % |
| N10 OTM1 every week | 1,157 | 217 | −₹25.2 lakh | −191 % | −1.63 to −0.42 % | 30 % |
| N10 OTM2 every week | 1,179 | 216 | −₹25.3 lakh | −194 % | −1.57 to −0.50 % | 28 % |
| N10 ATM NIFTY-gated | 233 | 38 | −₹5.6 lakh | −70 % | −0.68 to +0.21 % | 30 % |
| N10 OTM1 NIFTY-gated | 234 | 37 | −₹6.4 lakh | −73 % | −0.67 to +0.13 % | 27 % |
| N10 OTM2 NIFTY-gated | 237 | 35 | −₹5.8 lakh | −70 % | −0.61 to +0.13 % | 26 % |

A drawdown beyond −100 % means the book lost more than the ₹10 lakh. Double slippage is worse in every book.
NIFTY was below its 200-day average in 20 weeks of 2020, none of 2021, 17 of 2022, 4 of 2023 and 2 of 2024
(the gated books' 33–38 weeks with a position). The every-week book lost in every year after 2020
(N5 ATM: 2021 −₹4.6 lakh, 2022 −₹1.3 lakh, 2023 −₹3.2 lakh, 2024 −₹2.4 lakh before tax).

**Phase 0b — the mirror pool (owner's idea, 2 books): both make money, both fail.**

| Book | Trades | After tax | Drawdown | 90 % weekly | Win rate | Payoff | Premium a week |
|---|---|---|---|---|---|---|---|
| top 5, ATM | 711 | +₹15.8 lakh | −46 % | −0.13 to +1.48 % | 43 % | 1.77 | ₹1.56 lakh |
| top 10, ATM | 1,421 | +₹27.3 lakh | −58 % | −0.09 to +2.45 % | 42 % | 1.81 | ₹2.68 lakh |

Each fails two of the three rules: the interval's lower bound is below zero, and the drawdown is beyond −40 %.
With double slippage: +₹11.1 lakh (−51 %) and +₹18.8 lakh (−67 %).

Descriptive (learning trades, before tax; not part of the verdict):
- **The pool tilts as intended:** puts were 37 % (2020), 3 % (2021), 40 % (2022), 26 % (2023) and 6 % (2024)
  of the top 5's positions (learning years only; the confirmation years' picks are not read).
- **The gain is all the calls'.** Top 5: calls +₹24.6 lakh on 550 trades (47 % won), puts −₹1.7 lakh on 161
  (32 %). Top 10: calls +₹44.4 lakh, puts −₹4.7 lakh. The puts made money in 2020 (and the top 5's, ₹11k, in 2021), lost after.
- **The gain is concentrated:** the top 5 % of trades made 173 % (top 5) and 189 % (top 10) of the net; without
  them the books lose ₹16.8 lakh and ₹35.2 lakh. 2021 alone made ₹15.1 lakh of the top 5's calls.
- **Read with BL-226:** the call side is BL-226's kind of book at one lot each, and BL-226's call books failed
  on the confirmation weeks.

**Why the puts lose:** a stock already weak on 1 to 52 weeks and below its 40-week average has mostly made its
fall; within a week it falls slowly or bounces, too little to pay a week's decay and the 1–3 % slippage each
way. NIFTY's falling weeks help a little (the gated books lose less, mostly because they trade a sixth as
often), but none of them earns.

**Caveats:** daily closes, not quotes; a missing exit row booked at zero (0–5 trades a book); 2020's crash is in
the learning years, the puts' one clearly profitable year.

## Risks

- **Daily closes, not quotes:** put closes of falling mid-caps can be stale; the settle rule and the counts
  are the guard.
- **Few positions:** in rising years the trend test leaves many weeks empty; the bootstrap reads those weeks
  as zero, which makes the lower bound hard to clear. That is intended: the book has to earn its keep.
- **Corporate actions:** a re-struck put is booked at zero (harsh for a put on a falling stock); counted.

## Log

- 2026-11-15 — created at the owner's request ("what about taking PE also"; chose a new pre-registered
  standalone test over BL-226 Phase 4 with an override); Phase 0 written and committed before any run.
- 2026-11-15 — owner: rank every stock's chart and its inverse in one pool (inverse picked = buy the put,
  stock picked = buy the call). Registered as Phase 0b while Phase 0's learning run was still loading,
  before any of its results were read.
- 2026-11-15 — learning read (both rule sets): no book passes. Phase 0's 12 put books all lose after tax
  (−₹1.3 to −₹27.7 lakh); Phase 0b's two mirror books make +₹15.8 / +₹27.3 lakh but fail the interval and the
  drawdown rule, their gain all from the calls. None carried, the confirmation weeks not read. Killed.
