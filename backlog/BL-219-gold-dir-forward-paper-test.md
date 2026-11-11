# BL-219 — Forward paper test: GOLDM Dir in the expiry week

| | |
|---|---|
| **Priority** | P2 — the one setting BL-218 found worth a forward test; no live money until it passes |
| **Status** | In progress |
| **Type** | research |
| **Area** | options / trading-data |
| **Created** | 2026-11-12 |
| **Depends on** | BL-218 (the verdict and the MCX engine), BL-148 (the nightly MCX collector) |
| **TODO.md row** | 3.11.29 |

## Context

BL-218 swept Dir, Widesl and Buy on four MCX minis. One cell passed the untouched test year:
**GOLDM Dir in the expiry week** — sell ITM1 CE + PE at 18:00, 21% leg stops, one re-entry at
cost, held to 15 minutes before the close: ₹96,369 a lot over Nov 2025–Oct 2026 (LB +₹653), but
in a gold bull run, ~60 sessions a year, one pass among 8 finalists, and a 1% slippage that was
never checked against real option spreads. The owner (2026-11-12) asked for a forward paper test
that runs by itself each expiry week, one private Telegram line a session, six expiries, and a
read-only spread snapshot at 18:00.

## Goal

By the sixth gold expiry (Apr 2027): a journal of every paper session, a verdict against the
rule below, and a measured spread to set beside the 1% slippage the backtest assumed.

## Out of scope

Real orders of any kind (nothing here places or sends an order), margin, any other commodity or
family, any change to the rule (a change is a new item).

## Plan

### Phase 0 — Pre-register (committed before the first session is scored)

- **Hypothesis:** the BL-218 cell keeps a positive net after charges and slippage in sessions
  that came after its data. The default if it fails is "do not trade it".
- **Rule (frozen):** `dir|entry=18:00|strike=ITM1|sl=21|reentry=cost1|exit=close` on GOLDM
  (BL-218 grid SHA `88bc794621b0ee32`; `tests/unit/test_mcx_forward.py` holds the built strategy
  equal to the grid's): the nearest option expiry (the expiring monthly contract), 1 lot, strikes
  off the future the option settles on, entry at the 18:00 price (the close of the 17:59 bar),
  exit at 23:15 on a 23:30-close day and 23:40 on a 23:55-close day, 1% slippage on every fill,
  MCX charges (`legwise/mcx_charges.py`: ₹20 an order, CTT 0.05% sell side, MCX 0.0418%, SEBI,
  stamp, GST 18%).
- **Universe and sessions:** every GOLDM option expiry from **2026-11-27** on, and for each the
  last 5 sessions ending on expiry day (E-4..E0) by the MCX calendar as collected. A session is
  scored the night it happens, from the option bars `obt fyers mcx-daily` collects and the
  settling future's bars (one `/data/history` call). A session with no data is left pending and
  alerted, never skipped; a weekday scored before a holiday is known stays in (the real window
  only widens). One journal line per session, hash-chained (`rotation/journal.py`), never edited.
- **Look-ahead check:** the entry reads bars that end by 18:00; strikes come from the future's
  price at 18:00; the rule, the expiry window and the start expiry are fixed here, before any
  forward session; the journal entry carries `recorded_at` and the grid SHA.
- **Pass / kill rule (after the 6th expiry, ~30 sessions):** pass = cumulative paper net > 0
  after charges at 1% slippage **and** at least 4 of the 6 expiry weeks positive. Anything else
  = does not pass. Reported beside it: net at 0.5% and 0% slippage, profit factor, the worst
  expiry week, and the share of net from one expiry. Stopped early only by the owner.
- **Hold-out:** the whole forward period is the hold-out; nothing from it feeds back into the
  rule.
- **Spread snapshot (descriptive, outside the pass rule):** at 18:00 on each expiry-week weekday,
  one read-only Fyers quotes call for the settling future and the two entry contracts (ITM1 CE,
  ITM1 PE) and the ATM pair: bid, ask, last, spread as % of mid, kept in
  `TRADING_DATA_ROOT/mcx-forward/goldm-dir/spread/<day>.json`. The result sets the median
  half-spread beside the 1% per-fill slippage.
- **Will not run:** real or test orders; any other cell, root or family; a re-score of a
  recorded session; a rule change after the first scored session — each needs `override:`.

### Phase 1 — Build

- **Tasks:** `option_backtesting/mcx_forward.py` and `obt mcx-forward score|spread|status`;
  the contract calendar extended each night from the live MCX master; the MCX charge model moved
  into `legwise/` (research keeps a re-export); scheduler jobs `mcx-forward-spread` (18:00
  weekdays) and `mcx-forward-score` (01:30, after the collector, group `catalog`); private
  Telegram line a session.
- **Done when:** unit tests; a dry run of the score on a past expiry-week session reproduces the
  BL-218 backtest figure for that session to the rupee; `jobs status` shows both jobs.

### Phase 2 — Run (Nov 2026 → Apr 2027)

- **Tasks:** the jobs run; the owner reads the monthly figures; after the sixth expiry the verdict.
- **Done when:** six expiry weeks journaled and the verdict written in the Log.

## Risks

- The jobs need PRs #445, #446 and #447 merged and the scheduler restarted: the first session
  is **2026-11-23**. Until then nothing runs; a session missed for lack of the jobs is a hole in
  the journal, not a skip (the first expiry may be re-based by a dated rule).
- A late or failed collector (token, Fyers outage): the night's score waits, and a later night
  completes it while the bars are still collectable (an expired contract cannot be fetched).
- ~30 sessions is a small sample: a pass here is still not a proof.

## Open questions

None open: the owner's answers are in the Log.

## Log

- 2026-11-12 — created. Owner's answers: scored by a nightly scheduler job; one private Telegram
  line a session; 6 expiries, pass = net > 0 and at least 4 of 6 expiries positive; an 18:00
  read-only spread snapshot.
