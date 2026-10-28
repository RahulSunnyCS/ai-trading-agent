# BL-143 — Trade monitoring and safety: wake schedule, deploy check, loss alerts, stop button, margin check, Fyers reminder

| | |
|---|---|
| **Priority** | P1 — real money runs on AlgoTest (Finvasia) and Quantiply (Angel One) every trading day; today nothing checks the deploys, watches the day's loss or can stop everything at once |
| **Status** | In progress |
| **Type** | feature |
| **Area** | broker-login + scheduler + notify |
| **Created** | 2026-10-20 |
| **Depends on** | BL-137 / BL-138 (AlgoTest upload, deploy), BL-139 (Quantiply upload, enable), BL-140 (automation settings), BL-012 (scheduler). Item 3 of the owner's list is BL-141 |
| **TODO.md row** | 3.35 (3.35.4 = Phase 4, the stop button; PR #275) |

## Context

The owner, 2026-10-20, after asking what to improve in monitoring and automating the trades: "lets build all 7".
The seven, as proposed that day (item 3, real fills and slippage per strategy, is BL-141):

1. Keep the laptop awake for the jobs: on 2026-10-19 the 16:40 / 16:45 uploads ran at 20:27, as catch-ups, because
   the laptop slept.
2. A 09:25 check that AlgoTest /live and Quantiply hold exactly the day's picks, 1 lot, nothing extra or missing; one
   Telegram line per platform.
4. One daily loss alert across both platforms (combined live MTM).
5. A Telegram "stop everything" button.
6. A margin check before the 09:16 deploys.
7. A 09:00 reminder when today's Fyers token is missing.

## Answers (owner, 2026-10-20)

| Question | Answer |
|---|---|
| Loss alert levels | **−₹5,000 warning, −₹8,000 alert**, combined open + booked P&L of the day across AlgoTest + Quantiply. Alerts only |
| What the stop button does | **Switch off and square off**: disables the tool's Quantiply algos, holds AlgoTest deploys and uploads for the rest of the day, and closes open positions on both platforms, **only after a second confirm tap** |
| Which accounts hold the trades | **Finvasia (Shoonya) for AlgoTest, Angel One for Quantiply**, read-only through the broker APIs with the keys already in `.env` (orders only from the stop button's square-off) |

## Decisions (Claude, 2026-10-20, delegated by the owner)

- Item 1 is a macOS power setting: the owner runs it (`pmset`); the repo documents it and the morning summary flags a
  job that ran as a catch-up after sleep. Claude never changes system settings.
- Every new part is off until its own `.env` switch is `on` (`DEPLOY_CHECK`, `LOSS_ALERTS`, `MARGIN_CHECK`,
  `STOP_BUTTON`), except the Fyers reminder (alert only, on by default).
- Broker reads reuse one login per account per day where the API allows it, under the existing Angel One login guard
  (one at a time, cool-down, refused-login hold) and the TOTP window stamp (BL-139 Phase 4).
- The square-off goes through the platforms where they offer it (Quantiply's square-off/terminate action, AlgoTest's
  /live square-off), so the platform stops managing the legs; a broker-side order is the fallback only if the platform
  has none, and is never sent without the confirm tap.

## Goal

- Mornings: 09:00 Fyers reminder if needed; 09:05 margin check per account vs the day's picks; 09:25 one Telegram line
  per platform, e.g. "AlgoTest TA 3/3 · Quantiply CA 3/3 ✅", with what is missing or extra.
- During the session: combined MTM read every minute; a warning at −₹5k and an alert at −₹8k, each once a day.
- Any time: the stop button's two taps switch everything off and square off; the result is reported per platform.

## Out of scope

- Squaring off automatically on a loss level.
- Changing picks, lot sizes or deploy rules.

## Plan

### Phase 1 — Wake schedule (item 1)
- **Tasks:** document `sudo pmset repeat wakeorpoweron MTWRF 08:50:00` (and the owner's choice of a second wake) in
  `deploy/launchd/README.md`; the morning summary lists yesterday's jobs that ran as catch-ups.
- **Done when:** the owner has run it and a trading day's 16:40 job runs on time.

### Phase 2 — Fyers reminder and deploy check (items 7, 2)
- **Tasks:** a 09:00 job that alerts when no valid Fyers token exists; a 09:25 job that reads AlgoTest /live and
  Quantiply's day-wise list (read-only) and compares with the day's recorded picks per BL-140 row.
- **Done when:** both run on the scheduler and their messages match the platforms on a trading day.

### Phase 3 — Broker reads: margin and loss alerts (items 6, 4)
- **Tasks:** read-only clients for Angel One SmartAPI (positions, RMS/limits) and Shoonya (positions, limits); a 09:05
  margin job; a minute-by-minute MTM monitor 09:15–15:30 with the two levels.
- **Done when:** a trading day's figures match what the broker apps show.

### Phase 4 — Stop button (item 5)
- **Tasks:** a Telegram listener in the scheduler process (callback buttons, owner's chat only), a "stop" button in the
  morning message and on demand, a confirm tap, then switch off + square off per platform, reported back.
- **Done when:** tested end to end against stand-in servers, and the owner has pressed it once on a day of their choice.

## Risks

- A broker API login the platforms also use (Angel One TOTP): logins must stay serialised and rare.
- The square-off sends orders: the confirm tap, an owner-only chat id check and a log of every action are mandatory.

## Log

- 2026-10-20 — Created from the owner's "lets build all 7"; answers above. Item 3 is BL-141.
- 2026-10-20 — Phase 4 built (PR #275). The Telegram stop button is off until `STOP_BUTTON=on` is in the repo-root
  `.env` and the scheduler has been restarted. The square-off calls were read from the platforms' public JS:
  Quantiply `PUT /algos/:id/action/SQ_OFF_TERMINATE`; AlgoTest `PUT /execution/v2/square-off/<id>`, plus the list
  `GET /execution/v2/executions?environment=live` (`docs/algotest-execution.md`). Tested against stand-ins and
  fixtures only; nothing sent live.
- 2026-10-20 — Decisions (coordinator), from four review rounds:
  - the hold lasts until the owner resumes (Resume plus a confirm tap, or `--clear-hold`). It is kept in
    `TRADING_DATA_ROOT/stop/HOLD.json`, copied to `SCHEDULER_STATE_DIR`, and held in the scheduler's memory;
  - if the hold cannot be saved, the stop still squares off and says "HOLD NOT SAVED" first;
  - a square-off that was sent is never "square off by hand": it is "still closing: do NOT exit at the broker";
  - a call that got no answer may have been sent, and is never treated as not sent;
  - a square-off is sent once per id per day, across stops, from the stop log (with a copy in the state dir);
  - one stop runs at a time: `stop-running.json`, created atomically. It is stale after 20 minutes, or when not
    from today, or when its pid is dead, and is removed on SIGTERM / SIGINT.
- 2026-10-20 — Decision (Claude): AlgoTest deploys count as the tool's by the uploader's strategy id, a name it
  saved, or the name prefix (the owner deploys the tool's uploads by hand, and there is no ledger of execution
  ids). Quantiply algos count by ledger id; a missing ledger fails closed.
- Open, not yet seen live:
  - the exact strings of `pending_square_off`, `creation_ts` and any strategy-id field on `/executions`;
  - Quantiply's status after `SQ_OFF_TERMINATE`;
  - what a switched-off `READY` algo shows.
  Each is matched loosely, and anything unexpected is reported "check". Phase 4 is done when the owner has
  pressed the button once on a day of their choice.
- 2026-10-28 — Owner (asked in chat, 2026-10-28): the owner will switch on `MARGIN_CHECK`, `DEPLOY_CHECK`,
  `LOSS_ALERTS` and `STOP_BUTTON` themselves and check each one live, the stop button included. The item stays
  open until then. Status unchanged.
