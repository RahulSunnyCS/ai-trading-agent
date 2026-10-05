# BL-002 — Go live: dashboard on Vercel, research backend on the laptop

| | |
|---|---|
| **Priority** | P1 — friends get access in week 2 of the October plan; the code is built and tested, this is the owner-side set-up |
| **Status** | Planned |
| **Type** | chore |
| **Area** | infra |
| **Created** | 2026-10-04 |
| **Depends on** | PR #2 (merged) and PR #3 (Codex review fixes); the owner's domain on Cloudflare |
| **TODO.md row** | 3.12.11 (code built; owner steps tracked here) |

## Context

The owner wants the research backend (Momentum API `:8765`, Options API `:8000`)
to keep running on their laptop while the Next.js dashboard is served from
somewhere else — Vercel (already in use for other projects) or a second laptop.
Single user; nobody may use it without a password.

The code half is **done** (`feat(dashboard): serve the dashboard off the backend
laptop`, PR #2): `apps/dashboard/src/middleware.ts` + `lib/accessGate.ts` add a
fail-closed password gate and inject a Cloudflare Access service token into the
`/api/*` calls Next forwards; `OBT_DIRECT_API_URL` joins `MOMENTUM_DIRECT_API_URL`.
Verified on a production build against a header-echo server. What was **not**
done is anything needing the owner's accounts: nothing runs through a real
tunnel or a real Vercel deployment yet. The runbook is `docs/remote-dashboard.md`;
this item is the checklist for making it real.

State at creation: the Vercel team has no project for this repo (only
`rahulsunnycs` and `vibesafe`); neither `cloudflared` nor the `vercel` CLI is
installed on the laptop.

## Goal

From a phone or any browser, `https://<dashboard>.vercel.app` asks for the
password, and after it Momentum and Options Lab work against data served from
the laptop — while a direct request to either API hostname without the service
token is refused by Cloudflare.

## Out of scope

- The Fastify stack (Live, Personalities, P&L tabs, WebSocket ticks, payments):
  they need Postgres/Redis and keep failing remotely, as under `bun run start`.
- Real multi-user auth or subscriber access (that is the commercial-SaaS track).
- Hosting the Python APIs anywhere other than the laptop.

## Plan

### Phase 1 — Cloudflare (owner)
- **Tasks:** put the domain's DNS on Cloudflare (free plan; check existing records
  such as MX carried over); `brew install cloudflared`; create the tunnel and DNS
  routes for `momentum-api.<domain>` and `options-api.<domain>`; fill
  `~/.cloudflared/config.yml` from `deploy/cloudflared/config.example.yml`; in
  Zero Trust create a service token and an Access application over both hostnames
  (Service Auth policy for the token, Allow policy for the owner's email).
- **Deliverables:** running tunnel (`bun run start:tunnel` or `cloudflared service
  install`); service token ID/secret stored in a password manager.
- **Done when:** `curl` to either hostname without the token is refused by Access,
  and with the `CF-Access-Client-Id/Secret` headers returns 200 from the API.

### Phase 2 — Vercel project (Claude can drive once Phase 1 gives the URLs)
- **Tasks:** push/merge to `main`; create a Vercel project from the GitHub repo with
  Root Directory `apps/dashboard` (keep "include files outside the root directory");
  set `MOMENTUM_DIRECT=1`, `OBT_DIRECT=1`, both `*_DIRECT_API_URL`, the two
  `UPSTREAM_ACCESS_CLIENT_*` values, and a generated `DASHBOARD_PASSWORD`
  (`openssl rand -base64 24`); deploy.
- **Deliverables:** a production deployment; env vars set for Production (and
  Preview only if previews should work — they are public URLs behind the same
  password gate).
- **Done when:** the URL returns 401 + a password prompt without the password and
  loads the dashboard with it; with `DASHBOARD_PASSWORD` removed it returns 503
  (fail-closed check).

### Phase 3 — End-to-end verification
- **Tasks:** through the deployed site run Momentum Scores, one cold Broad Momentum
  backtest, saved runs / favourites (the favourites route was added in PR #3),
  Options Lab results and a legwise day replay; watch the network tab for proxy
  errors.
- **Deliverables:** a short note in this item's log with timings and any failures.
- **Done when:** all of the above work and the cold Broad run (~1 min locally)
  finishes without a platform timeout. If it does not, fall back to the async
  `/backtest/jobs` polling path for that view or move the dashboard to the second
  laptop (`next start`).

### Phase 4 — Day-to-day hardening (optional, decide after Phase 3)
- **Tasks:** keep the backend laptop awake while serving (`caffeinate -s`, or a
  launch agent); start the APIs and `cloudflared` at login; decide how to finish
  Fyers login remotely (today: `mbt login` on the laptop); consider a lockout /
  rate limit on the password prompt (Vercel firewall rule or middleware) and an
  alert when the tunnel is down.
- **Deliverables:** whichever of those the owner opts into.
- **Done when:** a morning with the laptop untouched leaves the dashboard usable.

## Risks

- **Laptop asleep/offline** → every proxied call errors. Mitigate with Phase 4.
- **Rewrite destinations are baked at build time** — changing a `*_DIRECT*` value
  needs a redeploy; the password and service token only need a restart.
- **Vercel Hobby is non-commercial** — fine for personal use; move to Pro before
  any subscriber touches it.
- **No rate limiting on the password** — a long random password is the control;
  Phase 4 can add a limit.
- **Platform proxy timeout on long backtests** — unverified until Phase 3.
- **Current CI is red on `main`** for unrelated reasons (Biome lint in a Momentum
  view, a Ruff error in momentum-backtesting); Vercel builds are separate from CI,
  but check the Vercel build log rather than assuming it passes.

## Open questions

1. Which domain and hostnames (`momentum-api.…`, `options-api.…`, and the
   dashboard's own domain if not `*.vercel.app`)?
2. Production branch: `main`? Should Preview deployments also get the env vars?
3. How should the laptop stay awake and start services (launch agents vs manual)?
4. Finish Fyers login remotely, or keep `mbt login` on the laptop?
5. Is a second laptop still wanted as a fallback, or Vercel only?

## Log

- 2026-10-04 — created from the remote-dashboard work (PR #2 merged, PR #3 open).
  Checked Vercel: no existing project for this repo.
- 2026-10-06 — re-prioritised P2 → P1: the owner plans to give two or three friends access to
  Momentum during week 2 of the October plan. Before sharing, decide which actions friends may
  trigger (ingestion, weekly-signal sends, Fyers login) — see the review PR's approval list.
