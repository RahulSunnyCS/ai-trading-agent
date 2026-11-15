# BL-228 — Puts on falling F&O stocks: does buying the weakest stocks' puts weekly beat cash?

| | |
|---|---|
| **Priority** | P2 — the owner asked for it (2026-11-15, "what about taking PE also"); research only, nothing live depends on it |
| **Status** | In progress |
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

### Phase 1 — Run and verdict
- **Tasks:** `packages/momentum-backtesting/scripts/bl228_fno_puts.py` (reuses BL-226's options book
  functions; the put list built as above); learning read written here and committed; then the carried books'
  confirmation; the findings page.
- **Deliverables:** the learning table, the confirmation table, the verdict, the extras.
- **Done when:** the verdict is in Result, `research/momentum/common/options-overlay.md` updated, `TODO.md`
  and `INDEX.md` rows closed.

## Risks

- **Daily closes, not quotes:** put closes of falling mid-caps can be stale; the settle rule and the counts
  are the guard.
- **Few positions:** in rising years the trend test leaves many weeks empty; the bootstrap reads those weeks
  as zero, which makes the lower bound hard to clear. That is intended: the book has to earn its keep.
- **Corporate actions:** a re-struck put is booked at zero (harsh for a put on a falling stock); counted.

## Log

- 2026-11-15 — created at the owner's request ("what about taking PE also"; chose a new pre-registered
  standalone test over BL-226 Phase 4 with an override); Phase 0 written and committed before any run.
