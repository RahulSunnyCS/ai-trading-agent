# Remote dashboard, laptop-served research backend

Run the research APIs (Momentum `:8765`, Options `:8000`) on the backend laptop and the
Next.js dashboard somewhere else: a second laptop or Vercel. Single-user; costs nothing
beyond a domain you already own.

```
browser ──► Next (Vercel / laptop B) ──[CF-Access service token]──► Cloudflare ──tunnel──► laptop A 127.0.0.1:8765 / :8000
   └─ password prompt (apps/dashboard/src/middleware.ts)
```

The browser only ever talks to the dashboard; the dashboard's **server** forwards
`/api/momentum/*`, `/api/auth/fyers/*` and `/api/backtest/legwise/*` to the APIs (the
`MOMENTUM_DIRECT` / `OBT_DIRECT` rewrites in `apps/dashboard/next.config.ts`). So the
APIs must be reachable from wherever Next runs — that is what the tunnel is for. No CORS,
no open ports, and the Python services stay bound to `127.0.0.1`.

Two locks, both required:

| Lock | Protects | Configured by |
|---|---|---|
| Dashboard password | the dashboard (every page and `/api/*`) | `DASHBOARD_PASSWORD` on the dashboard host |
| Cloudflare Access service token | the tunnel hostnames, so the APIs can't be called around the dashboard | Cloudflare Zero Trust + `UPSTREAM_ACCESS_CLIENT_ID/SECRET` on the dashboard host |

The password **fails closed**: under `next start` / Vercel (or whenever the service-token
vars are set) a missing `DASHBOARD_PASSWORD` makes every request return `503
DASHBOARD_PASSWORD not configured`. Only plain local `next dev` (`bun run start`) is open.
The service token fails closed too: setting only one of `UPSTREAM_ACCESS_CLIENT_ID` /
`UPSTREAM_ACCESS_CLIENT_SECRET` (or leaving one blank) makes every request return a 503 naming
both, instead of every API call failing at Cloudflare.

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

Generate the password once: `openssl rand -base64 24`. There is no rate limiting on the
prompt, so keep it long.

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

**Second laptop:** put the variables in `apps/dashboard/.env.local`, then

```bash
bun install
bun run --filter @ata/dashboard build
bun run --filter @ata/dashboard start
```

Use `start`, not `dev`: production mode is what makes the password mandatory.

## Limits

- Research stack only. The Live / Personalities / P&L tabs need the Fastify server and its
  Postgres/Redis and keep failing remotely, exactly as they do under `bun run start`.
- One shared password, no per-user accounts.
- Long backtests use the async `/backtest/jobs` polling endpoints, so platform proxy
  timeouts shouldn't bite — but run one cold Broad Momentum backtest after deploying to
  confirm.
