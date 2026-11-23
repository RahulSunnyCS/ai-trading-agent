# BL-242 — Forward paper test: SILVERM Dir, the week before expiry

| | |
|---|---|
| **Priority** | P3 — the owner asked for it; a setting the sweep did not clear, so it is a test of a rejected setting, not a lead |
| **Status** | In progress |
| **Type** | research |
| **Area** | options / dashboard |
| **Created** | 2026-11-24 |
| **Depends on** | BL-219 (the forward-test machinery), BL-218 (the verdict and the grid), BL-148 (the nightly collector) |
| **TODO.md row** | 3.11.42 |

## Context

BL-218 passed exactly one cell, GOLDM Dir in the expiry week, and BL-219 forward-tests it. The
owner (2026-11-24, in chat) asked for "silver too" in the forward-test tab. Every silver cell
failed the sweep's pass rules; the closest is **SILVERM Dir, week before expiry** (17:05, ATM, SL
21%, no re-entry, held to close): +₹26,536 on the test year (₹442 a session, PF 1.39), but its
lower bound was −₹513 and 72% of the net came from one expiry (rules 1 and 4 failed). The other
silver finalist (Dir, expiry week) lost ₹37,572 on the test year. The research gate was read to
the owner (a test the spec gates off needs `override: <reason>`), and the owner chose the cell and
the pass rule below in chat. That answer is the override recorded in the Log.

## Goal

By the sixth silver expiry window (May 2027): a journal of every paper session, a verdict against
the rule below, and a measured entry-minute spread to set beside the 1% slippage the backtest
assumed.

## Out of scope

Real or test orders of any kind; margin; any other root, family or cell (crude and natural gas were
killed or failed and are not tested); any change to the rule (a change is a new item); the gold
test (BL-219 is untouched and keeps its own journal).

## Plan

### Phase 0 — Pre-register (committed before the first session is scored)

- **Hypothesis:** SILVERM Dir in the week before expiry keeps a positive net after charges and 1%
  slippage on sessions that came after its data. The default if it fails is "do not trade it"; the
  sweep's own default for silver was already "does not work".
- **Rule (frozen):** `dir|entry=17:05|strike=ATM|sl=21|reentry=none|exit=close` on SILVERM (BL-218
  grid SHA `88bc794621b0ee32`; `tests/unit/test_mcx_forward.py` holds the built strategy equal to
  the grid's for both seasons): the nearest option expiry, 1 lot, strikes off the future the option
  settles on, entry at the 17:05 price (the close of the 17:04 bar), exit at 23:15 on a 23:30-close
  day and 23:40 on a 23:55-close day, 1% slippage on every fill, MCX charges
  (`legwise/mcx_charges.py`), lot sized at 2026-11-11's lot as in BL-218.
- **Universe and sessions:** every SILVERM option expiry from **2026-12-28** on, and for each the
  five sessions before the expiry week (E-9..E-5) by the MCX calendar as collected: the first
  window starts 2026-12-15. A session is scored the night it happens (01:30), from the option bars
  `obt fyers mcx-daily` collects and the settling future's bars (one `/data/history` call); a
  session with no data is left pending and alerted, never skipped. One hash-chained journal line
  per session in `TRADING_DATA_ROOT/mcx-forward/silverm-dir-before/journal.jsonl`.
- **Look-ahead check:** the entry reads bars that end by 17:04; strikes come from the future's
  price at 17:05; the rule, the window and the start expiry are fixed here, before any forward
  session; the journal entry carries `recorded_at` and the grid SHA. The 2026-11-23 expiry's
  window (mid-Nov) is out: it came before this registration.
- **Pass / kill rule (after the 6th expiry, ~30 sessions; owner, 2026-11-24: "same as gold"):**
  pass = cumulative paper net > 0 after charges at 1% slippage **and** at least 4 of the 6
  expiries positive. Anything else = does not pass. Reported beside it: net at 0.5% and 0%, profit
  factor, the worst expiry, and the share of net from one expiry. Stopped early only by the owner.
- **Hold-out:** the whole forward period is the hold-out; nothing from it feeds back into the rule.
- **Spread snapshot (descriptive, outside the pass rule):** at 17:05 on each window weekday one
  read-only Fyers quotes call for the settling future and the ATM and ITM1 pairs, kept in
  `mcx-forward/silverm-dir-before/spread/<day>.json`; the page sets the median half-spread of the
  ATM pair beside the 1%.
- **Will not run:** real or test orders; any other cell, root or family; a re-score of a recorded
  session; a rule change after the first scored session; a looser pass rule after seeing sessions
  — each needs `override: <reason>`.

### Phase 1 — Build (done 2026-11-24)

- **Tasks:** `mcx_forward.py` generalised to a `Rule` (gold's behaviour and journal unchanged);
  `obt mcx-forward score|spread|status [--rule goldm-dir|silverm-dir-before]` (a bare score and
  status run every rule, a bare spread reads gold's only); the nightly `mcx-forward-score` job
  covers silver; a `mcx-forward-spread-silver` job (weekdays 17:05); the dashboard's Commodity Lab
  › Forward tests shows both; the guide page.
- **Done when:** unit tests (the strategy equals the grid cell, the E-9..E-5 window, the 5-9
  weekday band, per-rule journals); a dry run on two past silver sessions (2026-10-14, 10-15 of the
  27 Oct expiry) in a temporary journal produced entries; gold's 15 BL-219 tests unchanged.

### Phase 2 — Run (Dec 2026 → May 2027)

- **Tasks:** the jobs run; the owner reads the monthly figures; after the sixth expiry the verdict.
- **Done when:** six silver expiry windows journaled and the verdict written in the Log.

## Risks

- Silver Dir is a setting the sweep rejected; a few good weeks here would not change that, and a
  pass would still be thirty sessions of a bull-market metal.
- The silver contract calendar was last written in October; the 01:30 score extends it from the
  live MCX master, so the 28 Dec expiry must be in it before 15 Dec (the first night it runs after
  the merge does this).
- Merging needs a scheduler restart for the new 17:05 job. The first window is 15 Dec: a session
  missed for lack of the jobs is a hole in the journal, not a skip.
- ~30 sessions is a small sample.

## Open questions

None open: the owner's answers are in the Log.

## Log

- 2026-11-24 — created. Owner, in chat: "Let's do silver too in forward test tab". Asked which cell
  and pass rule; owner chose **Dir, week before expiry** (the silver cell that was positive on the
  test year) and **the same pass rule as gold**. `override:` the owner asked for a forward test of
  a setting the BL-218 sweep did not pass (silver Dir, week before: lower bound below zero, 72% of
  net from one expiry); the research gate's "test the spec gates off" is run on the owner's word.
- 2026-11-24 — built (Phase 1). A dry run on 2026-10-14 and 2026-10-15 (the 27 Oct expiry's E-9
  and E-8) ran end to end on the lake's real bars in a temporary journal: +₹6,613 and −₹4,390 at
  1% slippage after ₹161 / ₹168 charges. Not part of the forward record.
