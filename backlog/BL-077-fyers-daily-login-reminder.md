# BL-077 — Fyers daily login: reminder, dashboard banner, and a truthful 08:05 job

| | |
|---|---|
| **Priority** | P1 — a missed Fyers login means no market data for Momentum and no 1-minute collection that evening, and expired contracts cannot be re-downloaded |
| **Status** | Dropped — superseded by BL-079 (2026-10-10) |
| **Type** | feature |
| **Area** | broker-login |
| **Created** | 2026-10-10 |
| **Depends on** | BL-012 (scheduler), TODO 1.9; replaces the unattended-login goal of BL-076 |
| **TODO.md row** | — (filled in when started) |

## Context

Two things were established on 2026-10-10 (see BL-076's log):

1. Fyers' login page puts a Cloudflare human check in front of client ID entry, so the 08:05
   headless browser login (`fyers-login`) cannot pass it.
2. Fyers' refresh-token grant is disabled by Fyers ("to comply with SEBI regulations", code -16),
   so there is no browser-free way to mint a day's token.

A person has to tick the box once per trading day. What the system can still do is make that one
action easy to remember and quick, and stop reporting a job as a login attempt when it cannot be.

## Goal

Every trading day the owner is told, before it matters, if there is no valid Fyers token, and can
fix it in one click; nothing pretends an unattended login is happening.

## Out of scope

Anything that completes or evades Fyers' human check, or calls its undocumented login endpoints.

## Plan

### Phase 1 — Replace the 08:05 browser job with a token check
- **Tasks:** `fyers-login` stops launching Chromium. It reads the stored token, probes Fyers'
  profile endpoint (as `/api/auth/fyers/status` already does), and, when there is no valid token,
  sends one Telegram message with a link to the dashboard's Fyers login. Valid token: silent.
  Re-check at about 15:45 (before `obt daily` at 16:15) with the same message.
- **Done when:** a day with no token produces exactly one message at 08:05 and one at 15:45, none
  on a day with a valid one, and the job's log says what it did.

### Phase 2 — Dashboard banner
- **Tasks:** a banner at the top of every dashboard page while the Fyers token is missing,
  expired or rejected, with a Login button that opens `/api/auth/fyers/start`. Hidden once valid.
- **Done when:** the banner shows after deleting the stored token and clears after a login.

### Phase 3 — Clean up
- **Tasks:** remove the now-dead headless flow (`fyers.ts` browser steps, `fyersLogin` selectors,
  the HEADED/SLOW_MO knobs it used) or keep it behind an explicit flag; update `technical.md`,
  `deploy/launchd/README.md`, the Broker logins Guide page and TODO 1.9.

## Risks

- A reminder is not a login: a missed day still costs data. The 15:45 check exists for that.
- The Fyers login page can change again; this plan does not depend on its structure.

## Open questions

1. Reminder times: 08:05 and 15:45, or others?
2. Telegram only on a trading day (calendar-aware, as the scheduler already is)?
3. Delete the headless browser code, or keep it behind a flag for the day Fyers drops the check?

## Log

- 2026-10-10 — created after BL-076's spike showed the refresh-token API is disabled.
- 2026-10-10 — superseded: the owner removed the 08:05 job and chose Angel One as the fallback source (BL-079). The dashboard already shows a Fyers token banner (`TokenBanner.tsx`).
