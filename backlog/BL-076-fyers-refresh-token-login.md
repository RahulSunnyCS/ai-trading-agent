# BL-076 — Fyers unattended login through the refresh-token grant

| | |
|---|---|
| **Priority** | P1 — the 08:05 `fyers-login` job cannot pass Fyers' human check, so market data and the evening `obt daily` collection depend on a manual login each day |
| **Status** | Dropped — Fyers disabled the refresh-token API (code -16, SEBI), 2026-10-10 |
| **Type** | feature |
| **Area** | broker-login |
| **Created** | 2026-10-10 |
| **Depends on** | BL-012 (scheduler, built), TODO 1.9 (Fyers login) |
| **TODO.md row** | 1.11 |

## Context

TODO 1.9 built a headless browser login (client ID → TOTP → PIN, `packages/broker-login/src/fyers.ts`).
On 2026-10-10 it was found that Fyers' login page now puts a Cloudflare "Verify you are human"
check in front of **Continue**. A script must not complete that check, so the unattended job cannot
get past the first screen. Three more things were found the same day:

- The page opens on "Mobile number", not "Client ID" (selector fixed in `selectors.ts`).
- The scheduler merges the repo `.env` over the shell, so an empty `HEADED=` line silently
  overrode `HEADED=1` (the empty lines are now commented out).
- **Every writer except the server's dashboard login discards the refresh token.**
  `apps/server/src/server/services/fyers-auth.ts` stores `refresh_token` (encrypted) in
  `broker_tokens`, but `packages/broker-login/src/store-token.ts` and
  `packages/momentum-backtesting/.../fyers.py` (`mbt login`) both write `refresh_token = NULL`.
  `exchangeAuthCode` in `broker-login/src/fyers-auth.ts` also drops it. A morning login would
  wipe the one a dashboard login had saved.

Fyers' API v3 has a second grant that needs no browser: POST `grant_type: "refresh_token"` with
`appIdHash`, the stored `refresh_token` and the 4-digit PIN to
`https://api-t1.fyers.in/api/v3/validate-refresh-token` returns a new access token. Per Fyers'
support portal the refresh token lasts 15 days. Sources, none of them the official API reference
(its page returned 404 when fetched):

- [Refresh Tokens in FYERS: Purpose and Validity](https://support.fyers.in/portal/en/kb/articles/what-is-the-function-of-the-refresh-token-in-fyers)
- Fyers community threads on `validate-refresh-token` errors (-371 appIdHash, -501 refresh token, -442 grant type).

`docs/epics.md` lists this as the deferred "Phase B: token refresh-grant automation"; the reason
for deferring it was storing the PIN, which `.env` now holds for the browser flow anyway.

## Goal

A day's Fyers access token is minted at 08:05 with no browser and no human, for as long as a
refresh token younger than its validity exists. A person logs in through the dashboard only when
the refresh token is about to expire, and is told by Telegram two days before.

## Out of scope

- Anything that completes or evades Fyers' human check, or calls its undocumented login
  endpoints (`vagator`) to avoid it.
- Order placement. The token stays read-only market data and holdings, as in `business.md`.
- Changing how the dashboard or `mbt login` obtain a token interactively beyond keeping the
  refresh token they receive.

## Plan

### Phase 1 — Spike: confirm the grant against the real account
- **Tasks:** with the refresh token from one dashboard login, call `validate-refresh-token` once
  from a throwaway script (no token or PIN printed). Record: the exact `appIdHash` input
  (`appId:appSecret`, as used for `validate-authcode`), whether a **new refresh token** comes
  back (a sliding window would mean no manual login at all), the access token's expiry, and the
  error codes for a wrong PIN and an expired token. One attempt only: a rejected PIN counts
  toward a lockout.
- **Deliverables:** a short findings note in this item's Log.
- **Done when:** the grant returns a working access token that passes the profile probe.
  If no refresh token has ever been stored, the first step is one dashboard login after Phase 2's
  storage fix.

### Phase 2 — Stop discarding the refresh token
- **Tasks:** `exchangeAuthCode` returns `refresh_token`; `storeFyersToken` and `mbt`'s
  store write it (encrypted, same pgcrypto path as the server) and keep the existing one when a
  response carries none; record its issue time so its age is known (`broker_tokens.updated_at`
  is overwritten by every access-token refresh, so a separate column or the refresh token's own
  expiry is needed).
- **Deliverables:** unit tests for both writers (refresh token kept, not nulled).
- **Done when:** a dashboard login followed by a morning access-token refresh leaves a
  decryptable refresh token in the row.

### Phase 3 — The unattended refresh
- **Tasks:** a `--refresh` mode of `fyers-login` (or a new entry beside `fyers.ts`): read and
  decrypt the refresh token, POST the grant, store the new access token (and refresh token if
  one is returned) with the 06:00 IST expiry rule. Fall back to the browser flow only in a
  headed run; the scheduled job never opens a browser. No retry on a rejected PIN (lockout).
  Errors classified as in `classifyFyersError`.
- **Deliverables:** the job, `apps/scheduler` entry updated (cwd, args, `fixHint`), tests with a
  fake `fetch`.
- **Done when:** the 08:05 job, run by the scheduler with no window and no human, turns the
  dashboard card green and `mbt token-status` reports the token.

### Phase 4 — Expiry warning and docs
- **Tasks:** a Telegram alert when the refresh token has fewer than two days left (or the grant
  fails because it expired), pointing at the dashboard's Broker logins page, **and a banner at
  the top of the dashboard in the same two days** (and whenever the grant has failed) with a
  Login button, so anyone using the app sees it. Update
  `technical.md` (env vars, `fyers-login` description), `deploy/launchd/README.md`, the Guide
  page for Broker logins and TODO 1.9's row.
- **Done when:** the alert and the banner are shown to fire in a simulated run, and the docs
  match the behaviour.

## Risks

- **Fyers limits.** The grant may require the app to be the one that issued the refresh token,
  or may change; the Phase 1 spike is the check, and the browser flow stays as a headed fallback.
- **Lockout.** Every call carries the PIN. No scheduler retry, one attempt per run, stop on a
  PIN rejection (as `fyers.ts` already does).
- **Secret storage.** The PIN stays in the repo `.env` (0600-style local file, never printed;
  `notify.py` and `@trading/notify` already register it for redaction). The refresh token is
  stored encrypted like the access token.
- **Validity.** The 15-day figure comes from a support article, not the API reference; Phase 1
  measures the real value before the alert threshold is set.

## Decisions (owner, 2026-10-10)

1. **Manual login cadence:** a dashboard login about every two weeks is acceptable if the refresh
   token does not roll forward. Daily is not required.
2. **On failure:** alert on Telegram **and** show a banner at the top of the dashboard whenever
   the app is in use during the two-day warning (or after a failed grant), with a login button.
   The scheduled job never opens a browser and never retries a PIN. (A headed fallback was not
   chosen.)
3. **Token age:** a new nullable column on `broker_tokens` (migration), not derived from the token.

Still open, to be settled in the phase that needs it:
- Whether `fyers-login` should move earlier than 08:05 (Phase 3).

## Log

- 2026-10-10 — created. Prompted by the Fyers human-verification check blocking the headless
  login (TODO 1.9); refresh-token discard found in `store-token.ts`, `fyers.py` and
  `exchangeAuthCode`.
- 2026-10-10 — questions answered (Decisions above); status In progress; TODO 1.11 added.
  Phase 1 started.
- 2026-10-10 — Phase 2 built ahead of Phase 1 (the spike needs a stored refresh token, and every
  writer was discarding it). Migration `016_broker_tokens_refresh_issued_at.sql`; the server's
  `saveToken`, `broker-login`'s `storeFyersToken` and `mbt`'s `save_token_to_db` now write
  `refresh_token` (encrypted) + `refresh_issued_at`, and keep the stored one when a login returns
  none (same app, encrypted). Tests: `fyers-auth.test.ts` (refresh token returned),
  `test_data.py` (carried on `Credentials`, out of repr). **Not yet applied:** Postgres on
  `localhost:5433` was not running, so `bun run migrate` has not run; until it does the writers
  fail on the missing column. Next: migrate, one dashboard login, then the Phase 1 spike.
- 2026-10-10 — No Docker on the owner's Mac, so no Postgres either (`.env` pointed at
  `localhost:5433`). Installed Homebrew `postgresql@16` (service `brew services`, port 5433,
  password auth over TCP) with only `broker_tokens`: migrations 006, 014 and 016 applied by hand;
  no TimescaleDB, so a full `bun run migrate` will fail on this cluster (the frozen engine is the
  only thing that needs it). Writers checked against it with a throwaway row (deleted): a first
  login stores the refresh token and its issue time, an access-token-only login keeps it, and a
  login for a different app drops it.
- 2026-10-10 — **Phase 1 spike: dead end.** One `validate-refresh-token` call with the stored
  refresh token (13 min old) and the PIN returned HTTP 400, `s: error`, `code: -16`,
  "Refresh token API is currently disabled to comply with SEBI regulations." No access token,
  no refresh token. Nothing was stored or retried. Fyers still *issues* a refresh token at login,
  but it cannot be used, so Phases 2-4 are void. Dropped; reopen only if Fyers re-enables the
  grant. Follow-up that keeps the owner's two decisions (Telegram + dashboard banner): BL-077.
  The Phase 2 code (migration 016 and the writers' refresh-token handling) is uncommitted and
  should be reverted rather than shipped as dead weight.

