# BL-044 — Local-service auth and network hardening

| | |
|---|---|
| **Priority** | P1: protects broker credentials and the Telegram signal channel, and is needed before BL-002 puts anything online |
| **Status** | Planned |
| **Type** | improvement |
| **Area** | cross-cutting (server, dashboard, options, momentum, scheduler) |
| **Created** | 2026-10-07 |
| **Depends on** | none. Related: BL-002 (hosting), BL-004 (prod mode locally) |
| **TODO.md row** | none yet (filled in when started) |

## Context

The whole-repo audit of 2026-10-07 found that none of the local services authenticates its
caller. The quick fixes shipped in the audit's PRs:

- `apps/server` binds to `127.0.0.1`;
- CORS uses an allow-list instead of `origin:true`;
- `next dev`/`next start` bind to loopback;
- Postgres and Redis publish on loopback;
- the dashboard rejects cross-site POSTs.

Those fixes stop strangers on the LAN. They do not stop:

- **Any website you visit** (via the browser) or a DNS-rebinding page. These can send body-less
  POSTs to the loopback services without CORS approval:
  - the scheduler `POST /jobs/<id>/run` (`apps/scheduler/src/api.ts:166`);
  - mbt `POST /api/weekly/stock-sync` (`momentum_backtesting/api.py`);
  - obt `/legwise/daily`.

  None of these services checks `Host` or `Origin`.
- **Fyers token swap.** `GET /api/auth/fyers/login` (`apps/server/src/server/routes/fyers-auth.ts:63-81`)
  hands out a valid `state` to any caller, and that `state` is not tied to the caller's session.
  A caller who can reach it can finish the OAuth flow with their own Fyers account and overwrite
  `broker_tokens`.
- **`apps/server` has no login at all.** `requireAccess` is a paywall that is off when
  `RAZORPAY_KEY_ID` is empty, and the `/api/momentum/*` proxy has no gate. A caller can:
  - send a FINAL weekly signal to Telegram;
  - write stock-action factors;
  - delete saved runs and favourites;
  - start a backfill.
- **Tunnelled Python APIs** (`deploy/cloudflared/config.example.yml`) skip Fastify's input caps.
  The only protection is Cloudflare Access, configured outside the repo and never checked.
  Specifically:
  - `bootstrap_resamples` is unbounded;
  - `/runs` date ranges are unbounded;
  - mbt `/api/docs` is public.
- **WebSocket `/ws/ticks`** bypasses the Next middleware gate.
- **Token encryption reuses `FYERS_APP_SECRET`** as the pgcrypto key (`services/fyers-auth.ts:125`,
  `broker-login/src/store-token.ts:17`, mbt `fyers.py:211`), and that secret sits in the same
  `.env`. Old plaintext rows are still readable (`migrations/014`).
- **Sessions cannot be revoked.**
  - The dashboard session lasts 30 days.
  - The key is derived from the password alone.
  - The rate limit keys on a forgeable `X-Forwarded-For`.
- **Risky dependencies:**
  - `smartapi-javascript` pins `axios@0.20.0` (known CVEs; frozen Angel One path).
  - contract-notes uses `imap@0.8.19` (abandoned) and `pdf-parse@1.1` (unmaintained).
  - apps/server pairs vitest 2 with `@vitest/coverage-v8@4`.
  - `@types/bun: latest` is unpinned.

## Goal

Every state-changing endpoint on every local service refuses a request that did not come from
the owner's dashboard, CLI or scheduler. The Fyers OAuth flow can only be completed by the
browser that started it.

## Out of scope

- Multi-user accounts (BL-028 decides whether others ever get access).
- Payments (frozen).

## Plan

### Phase 1 — Host and Origin guard on the loopback services
- **Tasks:**
  - Add one small middleware per service: obt FastAPI, mbt FastAPI, scheduler Bun API, apps/server.
  - Reject a `Host` that is not loopback or a configured tunnel hostname (stops DNS rebinding).
  - Reject non-GET requests with a cross-site `Origin` or `Sec-Fetch-Site`.
  - Tests for each service.
- **Done when:** a curl with `Host: evil.example` or `Origin: https://evil.example` gets 403
  from all four; the dashboard, CLI and scheduler still work.

### Phase 2 — Fyers OAuth state bound to the browser
- **Tasks:**
  - `/api/auth/fyers/login` sets a short-lived `HttpOnly` cookie holding a nonce.
  - The callback requires that the cookie matches `state`.
  - Do the same for mbt's own OAuth (`api.py` around line 2955).
- **Done when:** a callback without the cookie is rejected, with a test.

### Phase 3 — A shared secret between dashboard and backends
- **Tasks:**
  - The dashboard's Next server adds an `X-Internal-Token` header (from `.env`) on rewrites and proxies.
  - apps/server, obt, mbt and the scheduler require it on state-changing routes.
  - The CLI and scheduler call the Python packages directly, so they are unaffected.
- **Done when:** a direct POST to any backend without the token gets 401.

### Phase 4 — Tunnel, WebSocket, tokens, sessions
- **Tasks:**
  - Verify the `Cf-Access-Jwt-Assertion` on the tunnelled Python services, or route the tunnel
    through Fastify only.
  - Mirror Fastify's caps in obt's pydantic models.
  - Hide mbt `/api/docs` unless running locally.
  - Authenticate `/ws/ticks`.
  - Add a dedicated `BROKER_TOKEN_KEY` and re-encrypt the rows; delete the plaintext rows.
  - Add a session version stored server-side, so sessions can be revoked.
- **Done when:** each item has a test or a documented manual check.

### Phase 5 — Dependency hygiene
- **Tasks:**
  - Force a newer axios for smartapi (override), or isolate it.
  - Align vitest and coverage-v8.
  - Pin `@types/bun`.
  - Replace `imap` with `imapflow` and `pdf-parse` with `pdfjs-dist`. This belongs to the
    contract-notes cutover (TODO §2), so it can move there.
- **Done when:** `bun audit` (or an equivalent) shows nothing High on the active paths.

## Risks

- The token header breaks the remote dashboard if the Vercel or tunnel env is not updated in the
  same change. Ship it together with `docs/remote-dashboard.md`.
- Re-encrypting the tokens can lock out the 08:05 Fyers login if the key is missing on the laptop.
  Test with the scheduler's `fyers-login` job before deleting the plaintext rows.

## Open questions

1. Phase 3: one shared token for all services, or one per service?
2. Should the tunnel go through Fastify only (simpler auth, one hop more), or keep pointing straight at Python?

## Log

- 2026-10-07: created from the whole-repo audit. The quick fixes (loopback binds, CORS
  allow-list, cross-site POST check, security headers) shipped in the audit PRs.
