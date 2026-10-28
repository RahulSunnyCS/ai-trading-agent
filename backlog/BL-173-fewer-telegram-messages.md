# BL-173 — Fewer Telegram messages: only what the owner needs to know

| | |
|---|---|
| **Priority** | P1 — the owner has stopped reading the messages, so a real failure can now be missed |
| **Status** | In progress |
| **Type** | improvement |
| **Area** | notify / scheduler / broker-login / options / momentum |
| **Created** | 2026-10-28 |
| **Depends on** | BL-172 (the morning on the Mac) |
| **TODO.md row** | 3.48 |

## Context

Owner (2026-10-28): "As the number of messages increases, I am not looking much into messages. Ideally we need to
reduce this. Only send relevant things I need to know. In some cases a success message is not required, only failed
ones."

A trading day now sends the owner's private chat about 13 messages, most of them success reports. Read from the code
and the job schedule on 2026-10-28 (settings v6, `QUANTIPLY_DEPLOY=on`, the trade monitor's switches off):

| Time | Message | Sent when | Today |
|---|---|---|---|
| 08:02 | Broker login report (`broker.algotest`) | always | 1 |
| 08:10 | Quantiply switch-on, both accounts (`broker.quantiply`) | always | 1 |
| 09:00 | Morning summary, with the stop button (`scheduler.morning`) | always | 1 |
| 09:16 | Rotation pick, Adaptive + T1 (untagged) | always | 1–2 |
| 09:19 / 09:21 | Quantiply top-up / switch-on of a 09:16 change | only on a change (BL-172) | 0 |
| 15:40 | Quantiply switch-off, per account (`broker.quantiply`) | whenever it switched something off: every day now | 2 |
| 15:45 | Options evening summary (`options.daily`) | always | 1 |
| 16:00 | Rotation result, Adaptive + T1 (untagged) | always | 1–2 |
| 16:45 | Quantiply evening upload, per account (`broker.quantiply`) | always | 2 |
| any | Scheduler "recovered" after a failure (untagged) | after each recovered job | 0–2 |
| any | Scheduler "missed" (untagged) | per missed slot, e.g. several after a sleep | 0–n |
| any | Job failures (untagged or per type) | on failure | 0–n |

Fridays add the Kite reminder (13:30, only when needed), Momentum orders (14:15), preview (14:40), final (16:45),
journal check (21:00) and live rules (21:30). Saturday has the digest. The friends' group gets the 09:16 pick and the
16:00 result (Adaptive only); that stays as it is.

What exists: `@trading/notify` and both Python `notify.py` copies read a per-type on/off list
(`notifications.json`, the dashboard's Telegram alerts page). There is no "failures only" level, and several messages
carry no type, so they cannot be switched off.

## Goal

A normal trading day sends about 4 messages: one morning confirmation, the 09:16 pick, the 16:00 result, and anything
that went wrong. Every failure still arrives at once.

## The list for the owner's approval

Each line: what changes, and why.

1. **One 08:10 morning message instead of three.** The login report (08:02) and the switch-on (08:10) become one
   message after the switch-on: "✅ Logged in · MTM SL ₹8,000 / ₹9,000 ✓ · switched on 3 Core + 3 T1". A failed login is
   still sent at once, at 08:02.
2. **The 09:00 morning summary only when something is wrong.** On a clean day the 08:10 message is the confirmation.
   The stop button moves to the 08:10 message (`/stop` keeps working at any time).
3. **The 09:16 pick: one message.** Adaptive and T1 together. T1 is sent separately only when it is late, as now.
4. **15:40 switch-off: failures only.** Success is the normal case; a failure, or an algo still on, is always sent.
5. **15:45 options evening summary: failures only.** Its useful lines (the data was collected; days to expiry, IV
   percentile) go into the 16:00 result as one line. A failed collection is sent at once, as now.
6. **16:00 result: kept**, one message (Adaptive + T1).
7. **16:45 evening upload: one message for both accounts, only when it matters.** That is: a failure, a subscription
   change that spent credits, or tomorrow's picks differing from the 16:00 "Tentative" list. Otherwise silent.
8. **Scheduler "recovered": dropped.** The 09:00 summary (when sent) and the Saturday digest list recoveries.
9. **Scheduler "missed": one message per wake-up**, listing every missed slot, instead of one per slot.
10. **Friday Momentum: orders (14:15) and final (16:45) kept.** The preview (14:40) is dropped (the orders already say
    what to buy), the journal check (21:00) only on a problem, live rules only when a rule is hit.
11. **A "failures only" level per message type** on the dashboard's Telegram alerts page (on / failures only / off).
    Every message gets a type, so anything can be turned down later without code.

## Out of scope

- The friends' group messages (unchanged).
- The trade monitor's loss alerts (off today; when on, the -₹8,000 alert always sends).

## Plan (once approved)

### Phase 1 — The levels and the types
- **Tasks:**
  - `@trading/notify` and the two Python `notify.py` copies: a message carries `severity` (`ok` / `warn` / `error`).
  - The preferences file gains a level per type (`all` / `failures` / `off`; the old `disabled` list still read as off).
  - Every send gets a type: the rotation pick and result, and the scheduler's failed / missed / recovered alerts.
  - The Telegram alerts page shows the three levels.
- **Done when:** a type set to "failures" sends its failures and none of its successes (tests on each copy).

### Phase 2 — The defaults the list asks for
- **Tasks:**
  - The morning message (items 1 and 2).
  - The switch-off and evening summary at failures only (4, 5), with the evening summary's line in the 16:00 result.
  - The combined evening upload (7).
  - Recovered dropped and missed batched (8, 9).
  - The Momentum preview off and the journal check at failures only (10).
  - Guide pages for each screen whose messages change.
- **Done when:** one ordinary trading day sends the owner at most 4 messages with nothing failing, and a simulated
  failure of each job still arrives.

## Risks

- A message the owner relied on goes quiet. Each change is a level on the alerts page, so it can be turned back on
  without code.
- The morning summary was also the daily reminder that the scheduler is alive. The 08:10 message replaces it; a
  missing 08:10 message is itself a sign (the Saturday digest also counts the days it was sent).

## Open questions

- None: the owner approved items 1–11 as written (2026-10-28).

## Log

- 2026-10-28 — Created from the owner's request; the list is waiting for the owner's approval.
- 2026-10-28 — Owner approved all eleven items ("complete and merge to main"). Built overnight:
  - Levels per type in `@trading/notify` and both Python copies (`levels`, `DEFAULT_LEVELS`, failure from severity or
    the first icon); every message typed (`options.pick` / `.result`, `scheduler.failure` / `.missed` /
    `.recovered`, `quantiply.switch_off`); the dashboard's Telegram alerts card has On / Failures only / Off.
  - 1: the Mac's 08:02 login sends its report only on a failure (`LOGIN_QUIET_SUCCESS`), the 08:10 message starts
    with "Logged in: …". 2: the 09:00 summary only on a failed check or a pause. The stop button stays with its own
    offer (`STOP_BUTTON` is off today).
  - 3, 6: unchanged (already one message unless T1 is late).
  - 4: the 15:40 switch-off is `quantiply.switch_off`, failures only. 5: `options.daily` failures only; its line was
    not added to the 16:00 result, since that message comes only once the day's data is in and scored.
  - 7: the 16:45 upload writes only a failure, credits spent, or a list unlike the 16:00 "Tentative" one, both
    accounts in one message, none otherwise. 8: "recovered" off. 9: missed slots of one pass in one message.
  - 10: the momentum preview off; the journal check and live-rules status failures only.
