# BL-227 — Options overlay backtest: run a Momentum strategy's picks as bought stock options, from the dashboard

| | |
|---|---|
| **Priority** | P2 — the owner asked for it as a tool of its own (2026-11-15); the options and momentum workbench is the next 2–3 months' goal; nothing live depends on it |
| **Status** | Planned |
| **Type** | feature |
| **Area** | momentum / options / dashboard |
| **Created** | 2026-11-15 |
| **Depends on** | [BL-226](BL-226-fno-momentum-stock-options.md) (the NSE F&O history, the point-in-time F&O list, the `fno` Broad universe and the research scripts this builds on); [BL-107](BL-107-nse-fo-bhavcopy-daily.md) for keeping the F&O files current |
| **TODO.md row** | — (filled in when started) |

## Context

BL-226 tested one fixed form of the idea (three candidates, ₹10 lakh ÷ N of premium per stock, calls
swapped weekly) and killed it: every call book failed on the confirmation weeks. The owner, 2026-11-15,
after reading the trades: add it to the backtesting as a separate item, so other settings (one lot per
stock, a smaller premium budget, other strategies, other moneyness) can be tried and their trades read.

Today the engine is two research scripts (`packages/momentum-backtesting/scripts/bl226_fno_sweep.py`,
`bl226_options_book.py`) run by hand over a scratch copy of the data; their output is files, not a page.
The PR #450 review left ten findings on them (re-struck contracts booked at zero, a NaN premium passing
the entry guard, the trade across a period boundary dropped, a no-op filter in the put list, a slow CDF,
the API accepting `fno` on live paths); the first, second and sixth matter for a tool people will read.

**What this is not:** a way round BL-226's verdict. A run here is descriptive; a finding still needs a
pre-registered item (`research/README.md`), and the page says so.

## Goal

From the dashboard, the owner picks a Momentum strategy (a saved favourite, or Broad settings on the F&O
universe), the option settings and the capital, and gets within a minute: the options book against the
same picks held as shares (equity, drawdown, after tax), the minimum capital it needed, win rate and
payoff, the winners and losers by stock, every trade, and the year-by-year split.

## Out of scope

- Selling options, intraday entries and stops, index options (the Options Lab covers those).
- Placing or suggesting live orders.
- Re-opening BL-226's verdict.

## Plan

### Phase 1 — Engine in the package, with the review's fixes
- **Tasks:** move the options book from the script into `momentum_backtesting/options_overlay.py` (pure
  functions over the F&O lake and a strategy's weekly holdings); fix the review findings: follow a contract
  re-struck by a corporate action (match the adjusted strike and lot on the exit day; booked at zero only
  when no successor exists, counted), refuse a NaN or zero premium, score trades by one rule for any window,
  vectorised normal CDF and one session array; settings: right (calls, puts, the two put forms), moneyness
  (ATM, OTM1–OTM3), expiry rule (minimum sessions left), sizing (premium per stock, a fixed number of lots,
  or a share of capital a week), minimum OI in lots, slippage, capital, tax on or off.
- **Deliverables:** the module, unit tests on synthetic chains (strike choice, expiry rule, re-strike,
  sizing modes, tax carry), and a parity test: with BL-226's settings it reproduces BL-226's registered
  numbers, except where a fix changes them (each change listed in this item).
- **Done when:** the tests pass and BL-226's Trio ATM learning book is reproduced, its differences
  explained.

### Phase 2 — API
- **Tasks:** `POST /api/options-overlay` on `mbt serve` as a job (like the other Momentum jobs: start, poll,
  cached by settings and the F&O lake's newest day); the request names a saved favourite or a Broad request
  with `broad_universe="fno"`; the response: weekly equity of both books, drawdowns, the minimum-capital
  table (one lot of every holding a week: median, 90th percentile, largest; worst fall at one lot each),
  trade statistics, by stock, by year, and the trades. Keep `fno` out of the live signal, preview and order
  paths (`LIVE_REFUSED_BROAD_UNIVERSES`), as the review asked.
- **Done when:** an API test runs a small fixture end to end and a live request returns within a minute.

### Phase 3 — Dashboard page and Guide
- **Tasks:** an "Options overlay" page under Momentum, on the Analytics page pattern
  (`apps/dashboard/CLAUDE.md`): run bar and settings drawer, a headline strip (options vs shares: total,
  CAGR, drawdown, minimum capital), the hero chart (both books' equity), then widgets: drawdown, win rate and
  payoff, winners and losers by stock, best and worst trades, by year, the trades table. A "descriptive,
  not a finding" note with a link to BL-226. Its Guide page and `guide/registry.ts` entry in the same
  change.
- **Done when:** the e2e smoke opens the page, runs BL-226's Trio ATM settings and shows its numbers.

### Phase 4 — Keep the data current
- **Tasks:** the daily `obt nse fo-fetch` and `fno-build` after NSE publishes (about 18:30), through
  BL-107's scheduler job if it lands first, else its own; the page shows the newest stored day.
- **Done when:** a weekday's file and list are in the lake by 19:15 without a hand step.

## Risks

- **Read as a finding:** a page of good-looking runs invites picking the best one; the note on the page and
  the Guide say it is descriptive, and the minimum-capital and concentration figures sit beside every total.
- **Speed:** a favourite with four sleeves over seven years took minutes in the script; the job, the cache
  and the Phase 1 speed-ups are the guard.
- **Data:** daily closes, not tradable quotes; thin strikes; corporate actions. The page shows the counts
  of each skip and fill rule.

## Open questions

1. Where does it live: under Momentum (it starts from a Momentum strategy), or in the Options Lab?
2. Which sizing modes first: one lot per stock, premium per stock, or a share of capital a week?
3. Include the puts (both forms) in the first version, or calls only?
4. Should the data refresh wait for BL-107's job, or have its own now?

## Log

- 2026-11-15 — created at the owner's request after BL-226 was killed ("add this as a separate item in
  backtesting"); planned in four phases, not started.
