# BL-231 — Collect the day's option data during the session, so no evening job is needed

| | |
|---|---|
| **Priority** | P1 — protects the data that cannot be re-downloaded (expiring contracts vanish the same evening) and removes the evening's dependence on a Fyers login |
| **Status** | In progress |
| **Type** | improvement |
| **Area** | options / infra |
| **Created** | 2026-11-16 |
| **Depends on** | none (BL-203's live board and BL-079's Angel One collector already exist) |
| **TODO.md row** | 3.49 |

## Context

On 2026-11-16 Fyers was not logged in at 15:45. `obt daily` fell back to Angel One, read NIFTY's
option chain (919 requests, one every 0.4 s, about 6 minutes), then got
`HTTP 403, not JSON: Access denied because of exceeding access rate` on the BANKNIFTY future and
exited 1. Without the day's bars, `rotation update` stored nothing, three of the day's picks had no
result (`N_dir_1147`, `S_p320_0917`, `S_wide_0917`), the 16:00 result message failed eight times,
and the 16:40 / 16:45 uploads ran without the day in the ranking.

What the code does today:

- `angelone/client.py` `_call` retries a rate-limited answer five times, sleeping 1, 2, 4, 8 s
  (15 s in all). That is far shorter than any per-minute or per-hour window, so a real rate limit
  is never outlasted; after the fifth attempt `minute_candles` raises `RuntimeError`, which ends the
  whole `collect_day` and with it the evening.
- The 5-minute live board (BL-203, `rotation/live_board.py`) reads Angel One on the same account
  all session (09:18 to 15:31, about 70 requests a refresh per index) and shares its budget with the
  evening collector, with no coordination between the two.
- The evening chain (`options-evening`, 15:45) is one burst: `obt daily` (fetch, judge, derived
  tables, every leg-wise strategy), `rotation update`, `tdata derived rebuild`, the T1 update, then
  the result. Everything waits for the exchange close and for a working source at that moment.
- Fyers' expiring contracts vanish the evening they expire, so a failed evening on an expiry day
  loses that data for good.

Owner, 2026-11-16: fetch during the session, on the same 5-minute rhythm as the live board, what
the evening job fetches, "so that no evening job is required".

**The constraint that shapes the plan.** A candle request returns one contract's bars for a time
range, so its cost is per contract, not per minute. NIFTY alone is about 919 requests for a full
chain. Refreshing every contract every 5 minutes would be about 78 times that, far over any
SmartAPI limit. A literal "everything every 5 minutes" is therefore not possible; the plan below
reaches the same end (no fixed evening job, the day complete minutes after the close) by tiering
what is read when.

## Goal

- By about 15:40 on a normal day, the lake holds the day's full 1-minute option, future, index and
  VIX bars, judged by the same `data_quality` rules, with no fixed evening collection job and no
  login to Fyers needed after the morning.
- The chain that follows (derived tables, `rotation update`, the T1 update, the result message)
  starts by itself when the day is complete, not at a fixed clock time.
- A rate limit never loses a day: it is waited out and the collection resumes where it stopped.
- The intraday-built day matches what the evening collector stores, bar for bar, before the evening
  job is retired.

## Out of scope

- Changing what the strategies, ranking or uploads do with the data.
- Moving the 16:40 / 16:45 AlgoTest and Quantiply uploads earlier (a follow-up once results land by
  about 15:45).
- MCX collection (its own 23:31 job, BL-148).
- Running `rotation update` on a partial day: the stored results are written once per variant-day and
  never rewritten, so scoring waits for the final bars. The live board already shows the picks
  intraday.

## Plan

### Phase 1 — Stop a rate limit from losing the day (the 403 fix)
- **Tasks:**
  - In `AngelClient._call`, treat the rate limit as a cool-down, not a retry count: on a 429 or a
    message with `RATE_WORDS`, sleep a growing, capped delay (for example 5, 15, 30, 60 s, then
    60 s repeating) and keep the same request until it answers or a wall-clock budget (default 20
    minutes in all for the run, not per request; the live board's refresh uses 15 s) ends. Only then raise a typed `AngelRateLimited` error (not a bare
    `RuntimeError`).
  - In `collect_day`, catch it per contract: record the contract as unread, carry on or stop
    cleanly, and keep every contract already read. A rerun reads only what is missing (the raw
    responses under `raw/fyers/date=<day>/` are the cache; extend it to Angel One reads if it is not
    already).
  - Count requests: log requests per minute and per hour in the run, and record the first rate-limit
    answer's time and the count before it. This is the measurement Phase 2 needs for the real
    limits.
  - Pace the evening fallback slower than the 0.4 s default (a `--pace` setting, default taken from
    the Phase 1 measurement).
  - Alert (private Telegram) when `obt daily` falls back from Fyers to Angel One, so a missing Fyers
    login is seen at 15:45, not at 16:35.
- **Deliverables:** the client change with unit tests (a fake `post` that rate-limits then answers; a
  budget that runs out; a mid-chain limit leaving earlier contracts stored), the fallback alert, the
  request counters, and a one-paragraph note of the measured limits in
  `packages/option-backtesting/CLAUDE.md`.
- **Done when:** a run against a fake client that rate-limits for 3 simulated minutes completes the
  day with every contract, and a real Angel One fallback run on a trading evening completes with the
  counters logged.

### Phase 2 — Measure the budget and design the tiers
- **Tasks:**
  - From Phase 1's counters and one deliberate test (read-only, outside market hours), find
    Angel One's real per-second, per-minute and per-hour caps for `getCandleData`, and whether they
    are per API key, per IP or per account (the live board and the collector share all three).
  - Check Fyers' `/data/history` for the current session's bars: same caps (the client paces it at
    0.34 s), and whether today's partial-day candles are complete and identical to the evening's.
  - Write the tier table: which contracts are read how often (for example the picks' band every 5
    minutes, which the live board already reads; the strikes near spot hourly; the far wings once in
    the final pass), the requests per hour that adds up to, and its headroom under the measured
    caps.
  - Decide the source order (Fyers while its token is valid, else Angel One; one request budget
    shared by the live board and the collector, through a file-locked token bucket under
    `TRADING_DATA_ROOT/locks/`).
- **Deliverables:** the measured limits and the tier table written into this item's Log; a shared
  request-budget helper design.
- **Done when:** the plan's worst-case requests per hour sit under the measured cap with a stated
  margin, or the item is re-scoped (a lower cadence, fewer strikes) with the reason logged.

### Phase 3 — The intraday collector, in shadow
- **Tasks:**
  - A loop (the scheduler's `options-collect-live`, one process like `rotation-live-board`, trading
    days from 09:16) that reads the tiers from Phase 2 and appends each contract's new bars to a
    staging area (`TRADING_DATA_ROOT/staging/intraday/<day>/`, not backed up), never to the lake.
    It re-reads the day's range as the day's low and high move, so strikes outside the first
    reading are added when the range reaches them; contracts that expire today are read first.
  - A final pass from 15:30 reads each contract's remaining minutes once, then checks the staged
    day (rows per contract, gaps, the same quality gates `obt daily` applies).
  - Run beside the existing 15:45 job and compare the staged day with the day `obt daily` stores,
    bar for bar and field for field, every evening, writing the differences to a report; the lake
    is untouched by the loop.
- **Deliverables:** the loop, the staging writer, the comparison report and a Jobs page entry.
- **Done when:** 10 consecutive trading days, including at least one expiry day and one day Fyers
  was down, compare equal (or every difference is explained and accepted by the owner) and no
  rate-limit alert in those days.

### Phase 4 — Promote the staged day and start the chain by itself
- **Tasks:**
  - When the final pass is done and the staged day passes the gates, write it to the lake (same
    writer and run record as `obt daily`, dataset name distinguishing the source), then run the rest
    of the chain in order: derived rebuild, `rotation update`, the T1 update, the result. A failure
    in any step keeps the later steps from running and alerts once.
  - `options-evening` stays registered as a safety net: it runs at its usual time but does nothing
    when the day is already promoted, and falls back to the old collection when it is not.
  - The result message's fixed 16:00 wait becomes "when the day's results are in".
- **Deliverables:** the promotion step, the chained follow-up, the safety-net behaviour, the Guide
  and `technical.md` updates (commands, job list, environment).
- **Done when:** three trading days in a row finish with the result sent before 16:00 without the
  15:45 job collecting anything.

### Phase 5 — Retire the evening collection
- **Tasks:** remove the 15:45 collection (keep a manual `obt daily` for repairs), move the chain's
  catch-up and retry rules to the new job, update `CLAUDE.md` files, `overview.md`, `technical.md`
  and the Guide.
- **Deliverables:** the registry change and docs in the same commit.
- **Done when:** a month passes with no evening collection run and no day missing from the lake.

### Phase 6 — Live matrix on the Live board (picks × time)
Owner, 2026-11-16: "show a live matrix chart with live data". Chosen from the options as the Live
board's picks-by-time grid. It needs no new collection: every pick in the board's snapshot already
carries its minute-by-minute MTM (`curve`, `[session minute, ₹ at one lot]`), so this phase can be
built before or alongside Phases 1–5, and it is the first place the 5-minute reads become visible as
a grid. It does not depend on the collector.
- **Tasks:**
  - A "Live matrix" card under the Live board's panels (`RotationLiveMatrix.tsx`, pure view logic in
    `lib/rotationLiveMatrix.ts`, unit-tested without a DOM): one row per pick, grouped by book
    (Adaptive Classic, Adaptive Tuned), one column per time bucket from 09:15 to the board's `as_of`,
    each cell the pick's MTM at the end of that bucket, plus a book-total row. A `SegmentedControl`
    picks the bucket (5 / 15 / 30 minutes, default 15).
  - It follows the card's existing switches: A lot each / Your lots (the total row multiplies by the
    lots the API says each pick trades). The minute curve is before slippage, so the card says so,
    as the line chart does.
  - Diverging positive / negative tint from tokens (no hex), banded as the Strategy Matrix does
    (`bandOf`, `toneClass`), with a legend; a cell before the pick's entry is empty and dashed, never
    zero; a pick closed by a stop or its exit time holds its last value and is marked; a pick with no
    data is a dashed row with its state.
  - The newest column is shaded as "so far" while its bucket is incomplete; a gap in the snapshot (a
    missed refresh) stays a gap. The grid follows the snapshot, so it moves with each 5-minute
    refresh and the minute poll, and says when its last figure was read.
  - The Live board's Guide page (`optionslab/rotation-live-board.md`) gets the matrix in its "What you
    see" table and its switches; the dashboard `CLAUDE.md` gets one line for the card.
- **Deliverables:** the card, the view library and its tests (bucketing, carry-forward after a close,
  empty before entry, the total row at one lot and at your lots, a snapshot with no curve), the
  guide update.
- **Done when:** on a trading day the grid fills in as the 5-minute refreshes land, its total row
  equals the Live board's book curve at the same minute, and the final column agrees with each
  panel's P&L at the last bar (checked in the running dashboard).

## Risks

- **The request budget** (above) may leave too little room for a frequent refresh; Phase 2 decides
  and may shrink the plan to "far wings once, near strikes hourly".
- **Partial-day bars may differ from the evening's** (a late minute, a bar revised after the
  exchange publishes it). Phase 3's comparison exists to find this before anything depends on it.
- **A laptop that sleeps mid-session** leaves gaps in the intraday reads. The final pass reads the
  whole day's range, so a gap costs requests, not data.
- **Strikes that only enter the range late** need reading from the open; the range-widening step
  reads the full day for a new contract.
- **The live matrix** (Phase 6) reads the minute curve, which is before slippage and at the prices
  Angel One had sent; a late-arriving bar can change an earlier cell between refreshes, so the card
  shows the figures as of the last read, not as a record.
- **The live board and the collector share one account's limit**; a collector bug could starve the
  board. The shared budget gives the board priority.
- **Writing to the lake from two sources** (`obt daily` and the loop) for one day: existing rows win
  and the promotion is atomic per day, as the MCX staging does.

## Open questions

- Is a result message at about 15:45 wanted (earlier than today's 16:00), or keep 16:00?
- If Fyers is down, is Angel One's data accepted as the day's record, as today (with the later Fyers
  repair), or should the day wait for Fyers?
- Should the live board's picks band be reused as the first tier directly (one read serves both), or
  kept separate so a collector fault cannot affect the board?

## Log

- 2026-11-16 — created from the day's failure (Fyers not logged in; the Angel One fallback hit
  `exceeding access rate` after 919 NIFTY requests). Owner asked for Phase 1 to be the 403 fix and
  for the intraday collection to replace the evening job. Corrected an earlier statement: the 403
  was retried (5 attempts over about 15 s), then aborted the whole run; it was not unretried.
- 2026-11-16 — owner asked for a live matrix chart with live data; chosen as the Live board's
  picks × time grid and added as Phase 6 (builds on data the board already has).
- 2026-11-16 — Phase 1 (Angel One rate limit waited out, request counters, fallback alert) and
  Phase 6 (the Live matrix card) built; PR #457. Phases 2-5 wait on Phase 1's counters (TODO 3.49).
- 2026-11-20 — PR #457 review fixes: the live board's Angel One client waits at most 15 s on a rate
  limit (the 20-minute budget is the evening collection's; the board holds the guard's lock); a
  stopped Fyers run no longer replaces a complete raw file (the partial goes beside it) and always
  closes its ingest run; a rate-limited Angel One fallback keeps the Fyers-login hint in its alert.
