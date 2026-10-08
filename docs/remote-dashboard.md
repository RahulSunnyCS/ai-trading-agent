# Remote dashboard, laptop-served research backend

Run the research APIs (Momentum `:8765`, Options `:8000`) on the backend laptop and the
Next.js dashboard somewhere else: a second laptop or Vercel. Single-user; costs nothing
beyond a domain you already own.

```
browser ──► Next (Vercel / laptop B) ──[CF-Access service token]──► Cloudflare ──tunnel──► laptop A 127.0.0.1:8765 / :8000
   └─ login page + session cookie (apps/dashboard/src/middleware.ts)
```

The browser only ever talks to the dashboard; the dashboard's **server** forwards
`/api/momentum/*`, `/api/auth/fyers/*` and `/api/backtest/legwise/*` to the APIs (the
`MOMENTUM_DIRECT` / `OBT_DIRECT` rewrites in `apps/dashboard/next.config.ts`). So the
APIs must be reachable from wherever Next runs — that is what the tunnel is for. No CORS,
no open ports, and the Python services stay bound to `127.0.0.1`.

Two locks, both required. The first is the dashboard password, or, when the dashboard host sits
behind Cloudflare Access, Access's own sign-in (see "Signing in with Google" below; the password is
then unused):

| Lock | Protects | Configured by |
|---|---|---|
| Dashboard password (or Cloudflare Access sign-in) | the dashboard (every page and `/api/*`) | `DASHBOARD_PASSWORD` on the dashboard host (or `ACCESS_TEAM_DOMAIN` + `ACCESS_AUD`) |
| Cloudflare Access service token | the tunnel hostnames, so the APIs can't be called around the dashboard | Cloudflare Zero Trust + `UPSTREAM_ACCESS_CLIENT_ID/SECRET` on the dashboard host |

The password **fails closed**: under `next start` / Vercel (or whenever the service-token
vars are set) a missing `DASHBOARD_PASSWORD` makes every request, the login page included,
return 503. Only plain local `next dev` (`bun run start`) is open, and it listens on
`127.0.0.1` only. The local production build (`bun run start:prod`, BL-004) is a `next start`
like any other, so it needs the password too: it refuses to start until `DASHBOARD_PASSWORD`
is in the environment or `apps/dashboard/.env.local`, and you sign in at `/login` once per
browser. It also binds `127.0.0.1` only. The service token fails
closed too: setting only one of `UPSTREAM_ACCESS_CLIENT_ID` / `UPSTREAM_ACCESS_CLIENT_SECRET`
(or leaving one blank) also makes every request return 503, instead of every API call failing
at Cloudflare.

The 503 body is the same in both cases ("The dashboard is not available right now.") and
names nothing. The reason is in the dashboard host's server log, on a line starting
`[dashboard gate] refusing every request:`.

## Logging in

- **People** get a login page. Any page request without a session is redirected to
  `/login?next=<where you were going>`; the right password sets a session cookie and sends you
  on. A wrong one returns to the form with an error. There is no username.
- **Scripts and curl** use HTTP Basic auth, on any path, with any username:
  `curl -u :<password> https://<dashboard-host>/api/momentum/meta`. An `/api/*` request
  without credentials gets `401`, never a redirect to the login page.
- **Session length:** 30 days from login, then you log in again. The cookie (`ata_session`) is
  `HttpOnly`, `SameSite=Lax`, and `Secure` over https. It holds two timestamps and an
  HMAC-SHA-256 signature keyed from the password; it does not contain the password.
- **Changing `DASHBOARD_PASSWORD`** (and restarting / redeploying) ends every session at once,
  on every device, because the signing key is derived from the password. That is also the only
  way to revoke a session: there is no server-side session list.
- **Logging out:** open `/logout` (Settings has the link). It clears the cookie in that
  browser and returns to the login page. It does not invalidate a copy of the cookie held
  elsewhere; change the password for that.
- **Wrong-password backoff:** five wrong passwords from one IP address lock that address out
  for 1 minute, and each further wrong one doubles it (2, 4, 8, then 15 minutes at most). While
  locked, every attempt from that address gets `429` with `Retry-After`, the right password
  included, on the form and on Basic auth alike. A browser already logged in is not affected.
  A correct password clears the count; so does an hour without a wrong one.

  Know its limits. The counts live in the memory of one server instance: they reset on a
  restart or cold start, and on Vercel separate instances each keep their own, so a
  determined guesser gets more tries than the numbers above say. The address is the first
  `X-Forwarded-For` hop, which is only trustworthy when a proxy you trust sets it (Vercel
  does); with `next start` exposed directly a client can send its own and dodge the count, and
  with no such header everyone shares one bucket, so one person's typos can lock out everybody
  for a few minutes. It slows guessing; it is not a hard limit. The password's length is what
  protects the dashboard.

## 1. Backend laptop (once)

Prerequisite: the domain's DNS is on Cloudflare (free plan). If it is registered
elsewhere, switch its nameservers to Cloudflare — first check that the import copied any
existing records (email MX, other sites).

```bash
brew install cloudflared
cloudflared tunnel login                     # browser: pick your domain
cloudflared tunnel create trading-research   # writes ~/.cloudflared/<UUID>.json
cloudflared tunnel route dns trading-research momentum-api.<your-domain>
cloudflared tunnel route dns trading-research options-api.<your-domain>
cp deploy/cloudflared/config.example.yml ~/.cloudflared/config.yml   # fill in UUID + domain
```

**Cloudflare Access** (Zero Trust dashboard — do this *before* starting the tunnel):

1. Access → Service credentials → **Service Tokens** → create one. Copy the Client ID
   and Client Secret now; the secret is shown once.
2. Access → Applications → **Add a self-hosted application** covering both
   `momentum-api.<your-domain>` and `options-api.<your-domain>`, with two policies:
   - action **Service Auth**, include → the service token from step 1 (used by Next);
   - action **Allow**, include → your email (lets you open the APIs in a browser to debug).

## 2. Run it (each session)

```bash
bun run start:backend   # Momentum + Options APIs on 127.0.0.1
bun run start:tunnel    # or: cloudflared service install  (launch agent, starts at login)
```

Check the lock before anything else:

```bash
curl -s -o /dev/null -w "%{http_code}\n" https://momentum-api.<your-domain>/api/meta   # 302/403 — Access
curl -s -o /dev/null -w "%{http_code}\n" -H "CF-Access-Client-Id: <id>" -H "CF-Access-Client-Secret: <secret>" https://momentum-api.<your-domain>/api/meta   # 200
```

The laptop must be awake and online whenever you use the dashboard — `caffeinate -s` while
on power (closing the lid still sleeps it unless an external display is attached). A
sleeping laptop shows up as proxy errors in the dashboard.

**Fyers login:** run `uv run mbt login` on the backend laptop. The OAuth callback goes to
the redirect URI registered with Fyers (localhost), so the dashboard's "Log in" button
can't finish remotely. Alternative: register `https://<dashboard-host>/api/auth/fyers/callback`
with Fyers and set `FYERS_REDIRECT_URI` to it on the backend laptop — the direct rewrite
already forwards that path — at the cost of local-only logins.

## 3. Dashboard host

Generate the password once: `openssl rand -base64 24`. Keep it that long: the wrong-password
backoff only slows guessing (see "Logging in" above).

Environment (both targets):

| Variable | Value | Read at |
|---|---|---|
| `MOMENTUM_DIRECT` | `1` | build |
| `OBT_DIRECT` | `1` | build |
| `MOMENTUM_DIRECT_API_URL` | `https://momentum-api.<your-domain>` | build |
| `OBT_DIRECT_API_URL` | `https://options-api.<your-domain>` | build |
| `UPSTREAM_ACCESS_CLIENT_ID` | service token Client ID | runtime |
| `UPSTREAM_ACCESS_CLIENT_SECRET` | service token Client Secret | runtime |
| `DASHBOARD_PASSWORD` | the generated password | runtime |

Rewrites are compiled at build time, so changing a `*_DIRECT*` value needs a rebuild /
redeploy; the other three take effect on restart.

**Vercel:** import the repo, Root Directory `apps/dashboard` (leave "include files outside
the root directory" on — the tsconfig extends the repo root's), add the variables above for
Production. Hobby is fine for personal use; its terms rule out commercial use, so move to
Pro before any subscriber touches it.

**Cloudflare Workers** (instead of Vercel; one account for the dashboard and the tunnel). The
dashboard builds with the OpenNext Cloudflare adapter (`open-next.config.ts`, `wrangler.jsonc`) and is
served at `dashboard.codifie.dev` (a custom domain, `workers_dev` off). Needs Node 22+ for `wrangler`
(Node 20 is refused).

OpenNext bundles every `.env` it finds, the repo-root `.env` included, which would upload every broker,
Telegram and Google secret. So always build with `bun run cf:build` (or `cf:deploy` / `cf:preview`, which
call it): `scripts/cf-build.mjs` renames every `.env`, `.env.local`, `.env.production` and
`.env.production.local` (repo root and `apps/dashboard`) for the build and puts them back afterwards, even
on an error or Ctrl+C. They are missing for the minutes the build takes, so avoid running a scheduled job
that reads the root `.env` meanwhile. The script then `scripts/check-no-env-bundled.mjs` fails the build unless the bundled env is
empty. Do not run `opennextjs-cloudflare build` or `wrangler deploy` directly. If a build is killed
outright and a `.env` file is missing, rename its `.cf-build-hidden` copy back (the next `cf:build` also does it).

```bash
cd apps/dashboard
npx wrangler login                                   # once
# build-time values: export these four in the shell (not in a .env file, which the build hides)
#   MOMENTUM_DIRECT=1  OBT_DIRECT=1  MOMENTUM_DIRECT_API_URL=…  OBT_DIRECT_API_URL=…
npx wrangler secret put DASHBOARD_PASSWORD           # password mode only; the name goes in the command,
npx wrangler secret put UPSTREAM_ACCESS_CLIENT_ID    # the value is typed at the hidden prompt
npx wrangler secret put UPSTREAM_ACCESS_CLIENT_SECRET
bun run cf:deploy                                    # builds, checks, then wrangler deploy
bun run cf:preview                                   # local Workers runtime on :8787
```

`cf:preview` reads secrets from `apps/dashboard/.dev.vars` (gitignored). `ACCESS_TEAM_DOMAIN` and
`ACCESS_AUD` are set in `wrangler.jsonc`, so a preview is in Access mode and refuses every request
(no Access token on localhost) unless `.dev.vars` blanks them (`ACCESS_TEAM_DOMAIN=` and `ACCESS_AUD=`),
which gives the password mode.

Checked under `wrangler dev` against an echo server: wrong or missing password gets 401 (pages redirect to
`/login`), the service-token headers reach the upstream, a client-supplied `CF-Access-Client-Id` is
overwritten, and the dashboard's `Authorization`, Access token and session cookies do not reach the
upstream. **On Workers a header the middleware deletes still reaches the rewrite target; a blank one
does not, so `upstreamHeaders` blanks them.** The bundle is 1.6 MiB gzipped (free plan limit 3 MiB).

**Auto-deploy.** Pushing to the `release` branch deploys the dashboard
(`.github/workflows/deploy-dashboard.yml`); nothing else does, and only a commit already on `main` deploys (the workflow checks, because GitHub cannot restrict which branch a push to `release` comes from). Promote a tested `main` with
`git push origin main:release`, or run the workflow by hand from the Actions tab. One-time setup:
Cloudflare dashboard → My Profile → API Tokens → Create Token → "Edit Cloudflare Workers" template,
limited to this account and the `codifie.dev` zone (add Zone → DNS → Edit if the deploy complains
about the custom domain); then store it with `gh secret set CLOUDFLARE_API_TOKEN` (the value is
typed at the prompt). The account ID and the four build values in the workflow are not secret.
The runner has no repo-root `.env`, and `cf:deploy` still refuses to ship a bundle with any env in it.

**Second laptop:** put the variables in `apps/dashboard/.env.local`, then

```bash
bun install
bun run --filter @ata/dashboard build
bun run --filter @ata/dashboard start
```

Use `start`, not `dev`: production mode is what makes the password mandatory.

## Signing in with Google (Cloudflare Access) instead of the password

Put the dashboard's own hostname behind Access too. People sign in with Google (so Google's
2-step verification, an authenticator app or a passkey, is the second factor) and the dashboard
checks the signed token Access attaches; `DASHBOARD_PASSWORD` and `/login` are then unused.

1. Google Cloud Console → APIs & Services → OAuth consent screen (External; add your Google
   address as a test user) → Credentials → Create OAuth client ID, type Web. Authorized redirect
   URI: `https://<team>.cloudflareaccess.com/cdn-cgi/access/callback`. Copy the client ID and secret.
2. Zero Trust → Settings → Authentication → Login methods → Add new → Google, paste both.
3. Zero Trust → Access → Applications → Add → Self-hosted: domain `dashboard.<your-domain>`, login
   method Google only, one **Allow** policy that includes your email. Copy the application's **AUD tag**.
4. Put `ACCESS_TEAM_DOMAIN` (`<team>.cloudflareaccess.com`) and `ACCESS_AUD` in `wrangler.jsonc`
   under `vars` (neither is secret), rebuild and `bun run cf:deploy`, then delete the
   `DASHBOARD_PASSWORD` secret (`npx wrangler secret delete DASHBOARD_PASSWORD`).

The Worker refuses (403) any request without a valid Access token, so reaching it by another route
does not get in. `/logout` hands over to Access's own logout. Scripts and curl need an Access service
token for the dashboard hostname, as for the API hostnames.

## Limits

- Research stack only. The Live / Personalities / P&L tabs need the Fastify server and its
  Postgres/Redis and keep failing remotely, exactly as they do under `bun run start`.
- One shared password, no per-user accounts, and no way to end a single session short of
  changing the password.
- Long backtests use the async `/backtest/jobs` polling endpoints, so platform proxy
  timeouts shouldn't bite — but run one cold Broad Momentum backtest after deploying to
  confirm.
