# Deployment Guide — Local & Production

This guide covers everything needed to run the AI Trading Agent from a fresh checkout to a production-ready deployment.

---

## Table of Contents

1. [Local Development Setup](#local-development-setup)
   - [Prerequisites](#prerequisites)
   - [Quick Start (Docker + Simulation)](#quick-start-docker--simulation)
   - [Environment Variables Reference](#environment-variables-reference)
   - [Live Mode (Fyers Broker)](#live-mode-fyers-broker)
   - [Angel One Fallback Broker](#angel-one-fallback-broker)
   - [Native Setup (Without Docker)](#native-setup-without-docker)
   - [Running Tests](#running-tests)
   - [Common Local Issues](#common-local-issues)
2. [Production Deployment](#production-deployment)
   - [Infrastructure Requirements](#infrastructure-requirements)
   - [Railway Deployment](#railway-deployment)
   - [Fly.io Deployment](#flyio-deployment)
   - [Production Environment Variables](#production-environment-variables)
   - [Database Setup in Production](#database-setup-in-production)
   - [Frontend Build & Serving](#frontend-build--serving)
   - [Health Checks & Monitoring](#health-checks--monitoring)
   - [Fyers Token Refresh (Critical)](#fyers-token-refresh-critical)
   - [Secrets Management](#secrets-management)
   - [Pre-Launch Checklist](#pre-launch-checklist)

---

## Local Development Setup

### Prerequisites

| Tool | Minimum version | Install |
|------|----------------|---------|
| **Bun** | 1.0+ | `curl -fsSL https://bun.sh/install \| bash` |
| **Docker** | 24+ | [docker.com/get-started](https://www.docker.com/get-started) |
| **Docker Compose** | v2+ | Bundled with Docker Desktop; `docker compose version` to verify |

```bash
# Verify
bun --version          # e.g. 1.1.34
docker --version       # e.g. Docker version 26.1.0
docker compose version # e.g. Docker Compose version v2.27.0
```

> **Bun is mandatory.** Do not use `npm install` or `yarn install` — they will create a conflicting lockfile. All scripts run via `bun run`.

---

### Quick Start (Docker + Simulation)

This is the fastest path. No broker credentials required.

```bash
# 1. Clone repository
git clone https://github.com/rahulsunnycs/ai-trading-agent.git
cd ai-trading-agent

# 2. Install dependencies
bun install

# 3. Start infrastructure (TimescaleDB + Redis)
docker compose up -d

# 4. Wait for health checks (~30s on first start)
docker compose ps
# Both must show (healthy):
# trading_postgres   Up X seconds (healthy)
# trading_redis      Up X seconds (healthy)

# 5. Configure environment
cp .env.example .env
# The default values in .env work for Docker Compose — no edits needed for simulation mode

# 6. Apply database schema
bun run migrate
# Expected: "[migrate] Migration complete."

# 7. Start the backend in simulation mode
SIMULATE=true bun run dev
# Expected startup logs:
# [main] AI Trading Agent — Data Ingestion (Broker: Simulator)
# [main] Mode: SIMULATION
# [redis] Connected
# [sim] Starting market data simulator — NIFTY @ 24000, tick every 1000ms
# ... (snapshot lines every 15s)

# 8. Start the frontend (in a separate terminal)
bun run vite
# Open http://localhost:5173 in your browser
```

The backend API runs on `http://localhost:3000`. The frontend dev server runs on `http://localhost:5173`.

---

### Environment Variables Reference

Copy `.env.example` to `.env` and configure:

#### Always Required

| Variable | Default | Notes |
|----------|---------|-------|
| `DATABASE_URL` | `postgresql://trading:trading_dev@localhost:5432/trading` | Must point at PostgreSQL 16 with TimescaleDB. Docker Compose default works as-is |
| `REDIS_URL` | `redis://localhost:6379` | Must be Redis 7+. Docker Compose default works as-is |
| `NODE_ENV` | `development` | Set to `production` in prod |
| `PORT` | `3000` | Fastify listens on this port |
| `LOG_LEVEL` | `info` | One of: `trace`, `debug`, `info`, `warn`, `error` |

#### Simulation Mode

| Variable | Default | Notes |
|----------|---------|-------|
| `SIMULATE` | `false` | Set to `true` to use the random-walk simulator instead of a real broker |
| `SIM_UNDERLYING` | `NIFTY` | Which underlying to simulate: `NIFTY`, `BANKNIFTY`, `SENSEX` |
| `SIM_TICK_INTERVAL_MS` | `1000` | Milliseconds between simulated ticks |

#### Fyers Broker (Live Mode)

| Variable | Required | Notes |
|----------|----------|-------|
| `FYERS_APP_ID` | Yes (live mode) | Format: `XXXXXXXXXXXX-100` (your App ID + `-100` suffix) |
| `FYERS_ACCESS_TOKEN` | Yes (live mode) | OAuth token. **Expires every day at midnight.** Must be regenerated before 09:00 IST |

#### Angel One Fallback Broker

| Variable | Required | Notes |
|----------|----------|-------|
| `ANGEL_API_KEY` | For Angel One | Your Angel One API key |
| `ANGEL_CLIENT_ID` | For Angel One | Your Angel One client ID |
| `ANGEL_TOTP_SECRET` | For Angel One | TOTP secret for login automation |

#### Signal Tuning (Optional Overrides)

| Variable | Default | Notes |
|----------|---------|-------|
| `SIGNAL_MIN_EXPANSION_PCT` | `0.10` | Minimum straddle expansion % to qualify as a peak |
| `SIGNAL_CONFIRMATION_SNAPSHOTS` | `3` | Number of consecutive snapshots needed to confirm a peak |
| `ENTRY_WINDOW_START_IST` | `09:15` | Entry window open time (IST) |
| `ENTRY_WINDOW_END_IST` | `09:45` | Entry window close time (IST) |
| `EOD_SQUAREOFF_IST` | `15:25` | Force-close all positions at this IST time |

#### Payment (Razorpay)

| Variable | Notes |
|----------|-------|
| `RAZORPAY_KEY_ID` | If absent, payment subsystem is disabled (free/dev mode). Set to a live key for production |
| `RAZORPAY_KEY_SECRET` | Required when `RAZORPAY_KEY_ID` is set |
| `RAZORPAY_WEBHOOK_SECRET` | Required for webhook HMAC verification |

#### Evolution Engine

| Variable | Default | Notes |
|----------|---------|-------|
| `EVOLUTION_REQUIRE_APPROVAL` | `true` | **Keep `true` in all real environments.** Setting `false` allows the engine to autonomously modify personality parameters without human review — only safe in offline experiments |

---

### Live Mode (Fyers Broker)

#### Step 1: Create a Fyers API App

1. Log in to [myapi.fyers.in/dashboard](https://myapi.fyers.in/dashboard)
2. Create a new app — note the **App ID** (format: `XXXXXXXXXXXX-100`)
3. Set the redirect URI to `http://localhost:3000/fyers/callback` (or your server URL)

#### Step 2: Generate an Access Token

Fyers uses an OAuth2 flow. Run the auth helper:

```bash
bun -e "
import { FyersAuthHelper } from './src/ingestion/brokers/fyers-auth.ts';
const helper = new FyersAuthHelper(process.env.FYERS_APP_ID!);
console.log('Login URL:', helper.getAuthUrl());
"
```

Copy the printed URL into a browser, log in, and copy the `auth_code` from the redirect URL. Then exchange it:

```bash
bun -e "
import { FyersAuthHelper } from './src/ingestion/brokers/fyers-auth.ts';
const helper = new FyersAuthHelper(process.env.FYERS_APP_ID!);
const token = await helper.exchangeCode('PASTE_AUTH_CODE_HERE');
console.log('Access token:', token);
"
```

Set the printed token in `.env`:
```bash
FYERS_ACCESS_TOKEN=<the token printed above>
```

> **Tokens expire daily at midnight IST.** Repeat this process every morning before 09:00 IST for live market sessions. Automate this before your first live day.

#### Step 3: Start in Live Mode

```bash
SIMULATE=false bun run dev   # watch mode (auto-reload on file changes)
# or
bun start                    # production-style (no auto-reload)
```

---

### Angel One Fallback Broker

The Angel One adapter is the secondary broker. It activates automatically when `FYERS_APP_ID`/`FYERS_ACCESS_TOKEN` are absent and `ANGEL_API_KEY` is present.

```bash
# .env — Angel One only
SIMULATE=false
ANGEL_API_KEY=your_api_key
ANGEL_CLIENT_ID=your_client_id
ANGEL_TOTP_SECRET=your_totp_secret   # Base32 TOTP secret from Angel One 2FA setup
```

> Angel One requires the weekly option master CSV for symbol-to-token mapping. Download it from the Angel One API docs and place it at `data/angel-master.csv`. The adapter logs a warning if the file is missing.

---

### Native Setup (Without Docker)

Use this if you cannot run Docker. You need to install TimescaleDB-enabled PostgreSQL 16 and Redis 7 yourself.

#### PostgreSQL 16 + TimescaleDB

**macOS (Homebrew):**
```bash
brew install postgresql@16
brew tap timescale/tap
brew install timescaledb
brew services start postgresql@16
timescaledb-tune --quiet --yes
brew services restart postgresql@16
```

**Ubuntu/Debian:**
```bash
# Add repos
sudo sh -c 'echo "deb http://apt.postgresql.org/pub/repos/apt $(lsb_release -cs)-pgdg main" > /etc/apt/sources.list.d/pgdg.list'
wget --quiet -O - https://www.postgresql.org/media/keys/ACCC4CF8.asc | sudo apt-key add -
echo "deb https://packagecloud.io/timescale/timescaledb/ubuntu/ $(lsb_release -c -s) main" | sudo tee /etc/apt/sources.list.d/timescaledb.list
wget --quiet -O - https://packagecloud.io/timescale/timescaledb/gpgkey | sudo apt-key add -

sudo apt update
sudo apt install postgresql-16 timescaledb-2-postgresql-16
sudo timescaledb-tune --quiet --yes
sudo systemctl restart postgresql
```

**Create database and user:**
```bash
psql postgres
```
```sql
CREATE USER trading WITH PASSWORD 'trading_dev';
CREATE DATABASE trading OWNER trading;
\c trading
CREATE EXTENSION IF NOT EXISTS timescaledb CASCADE;
GRANT ALL PRIVILEGES ON DATABASE trading TO trading;
\q
```

#### Redis 7+

**macOS:**
```bash
brew install redis
brew services start redis
redis-cli ping   # → PONG
```

**Ubuntu:**
```bash
sudo apt install redis-server
sudo systemctl start redis-server
redis-cli ping   # → PONG
```

After installing both services, the rest of the setup is identical to the Docker path (steps 2–8 in Quick Start, skipping `docker compose up -d`).

---

### Running Tests

```bash
# Type-check (no compilation)
bun run --bun tsc --noEmit

# Lint
bun run lint

# Unit tests only (no Docker needed)
bun run test:unit

# Integration tests (requires Docker services running)
bun run test:integration

# All tests
bun test

# E2E tests (requires Vite on :5173 and optionally Fastify on :3000)
bun run test:e2e

# E2E — only critical tests
npx playwright test --grep @critical

# Coverage report
bun run test:coverage
```

---

### Common Local Issues

| Symptom | Cause | Fix |
|---------|-------|-----|
| `docker compose ps` shows `(unhealthy)` | Port 5432 or 6379 in use | `lsof -i :5432` / `lsof -i :6379` to find the conflict; stop it or change the port mapping in `docker-compose.yml` and update `.env` |
| Migration fails with `type "timestamptz" does not exist in hypertable` | Vanilla PostgreSQL (no TimescaleDB) | Use the Docker Compose image `timescale/timescaledb:latest-pg16`, not `postgres:16` |
| `FYERS_ACCESS_TOKEN` error on startup | Token expired (expires daily) | Regenerate the token — see Live Mode Step 2 |
| `bun run test:integration` shows connection errors | Docker services not running | `docker compose up -d` and wait for healthy status |
| `error TS` from typecheck | TypeScript error in source | Fix the reported error; `tsc --noEmit` must be clean before any commit |
| `npm install` / `yarn install` accidentally run | Creates conflicting lockfile | Delete `package-lock.json` / `yarn.lock`; run `bun install` only |
| Straddle snapshots have `roc=null` after 30s | Only one snapshot recorded | ROC needs ≥2 snapshots (30s cadence); wait 60s+  |

---

## Production Deployment

### Infrastructure Requirements

| Component | Requirement | Notes |
|-----------|------------|-------|
| **Database** | PostgreSQL 16 + TimescaleDB 2.x | Standard `postgres:16` images will NOT work; use `timescale/timescaledb:latest-pg16` |
| **Cache / Queue** | Redis 7+ | BullMQ uses Redis Streams features not in Redis 6 |
| **Runtime** | Bun 1.0+ | The backend is a Bun process; Node.js is not used |
| **Frontend** | Static file server or CDN | Build output goes to `dist/` via `bun run build` |
| **Compute** | Single server or PaaS (Railway, Fly.io) | No horizontal scaling needed for Phase 1 |

### Railway Deployment

Railway is the recommended PaaS for this stack. It supports custom Dockerfiles, managed PostgreSQL add-ons, and Redis add-ons.

#### 1. Create a New Railway Project

```bash
# Install Railway CLI
npm install -g @railway/cli
railway login
railway init
```

#### 2. Add PostgreSQL + TimescaleDB

Railway's built-in PostgreSQL plugin does not include TimescaleDB. Use a custom database service:

```bash
railway add --name timescaledb
```

Set the image to `timescale/timescaledb:latest-pg16` in the service settings. Railway will expose `DATABASE_URL` automatically.

Alternatively, use [Aiven](https://aiven.io) or [Timescale Cloud](https://cloud.timescale.com) for a managed TimescaleDB — both offer free tiers.

#### 3. Add Redis

```bash
railway add --name redis
```

Use Railway's native Redis plugin. It exposes `REDIS_URL` automatically.

#### 4. Create a Dockerfile

Railway can build from a Dockerfile. Create one at the repository root:

```dockerfile
FROM oven/bun:1 AS base
WORKDIR /app

# Install dependencies
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

# Copy source
COPY . .

# Build frontend
RUN bun run build

# Run migrations then start the server
CMD ["sh", "-c", "bun run migrate && bun start"]
```

> The `bun run build` step compiles the Vite frontend into `dist/`. The Fastify server must be configured to serve `dist/` as static files in production (see Frontend Build section below).

#### 5. Set Environment Variables in Railway

In the Railway dashboard → your service → Variables, set:

```
NODE_ENV=production
PORT=3000
DATABASE_URL=<from Railway TimescaleDB service>
REDIS_URL=<from Railway Redis service>
SIMULATE=false
FYERS_APP_ID=<your app id>
FYERS_ACCESS_TOKEN=<daily token — see Fyers Token Refresh>
EVOLUTION_REQUIRE_APPROVAL=true
LOG_LEVEL=info
```

Add Razorpay variables if payment is enabled:
```
RAZORPAY_KEY_ID=<live key>
RAZORPAY_KEY_SECRET=<live secret>
RAZORPAY_WEBHOOK_SECRET=<webhook secret>
```

#### 6. Deploy

```bash
railway up
```

Railway builds the Docker image, runs migrations via `CMD`, and starts the app.

---

### Fly.io Deployment

Fly.io is an alternative PaaS with native support for Bun.

#### 1. Install and Authenticate

```bash
curl -L https://fly.io/install.sh | sh
fly auth login
```

#### 2. Create a Fly App

```bash
cd ai-trading-agent
fly launch --no-deploy
```

This creates `fly.toml`. Edit it:

```toml
app = "ai-trading-agent"
primary_region = "bom"   # Mumbai — nearest to NSE/BSE

[build]
  dockerfile = "Dockerfile"

[env]
  NODE_ENV = "production"
  PORT = "8080"
  LOG_LEVEL = "info"
  SIMULATE = "false"

[[services]]
  internal_port = 8080
  protocol = "tcp"

  [[services.ports]]
    port = 80
    handlers = ["http"]

  [[services.ports]]
    port = 443
    handlers = ["tls", "http"]

  [services.concurrency]
    type = "requests"
    hard_limit = 200

[checks]
  [checks.health]
    grace_period = "30s"
    interval = "15s"
    method = "get"
    path = "/health"
    port = 8080
    timeout = "5s"
    type = "http"
```

#### 3. Provision Database (Timescale Cloud or Aiven)

Fly does not provide TimescaleDB. Use an external managed service:

- **Timescale Cloud**: [cloud.timescale.com](https://cloud.timescale.com) — managed TimescaleDB, free tier available. Select the Mumbai (ap-south-1) region for lowest latency.
- **Aiven**: [aiven.io](https://aiven.io) — managed PostgreSQL + TimescaleDB add-on.

Copy the connection string and set it as a Fly secret:
```bash
fly secrets set DATABASE_URL="postgresql://user:pass@host:5432/dbname?sslmode=require"
```

#### 4. Provision Redis (Upstash)

[Upstash](https://upstash.com) provides serverless Redis compatible with Fly.io:

```bash
fly secrets set REDIS_URL="rediss://default:token@host:6379"
```

#### 5. Set All Secrets

```bash
fly secrets set \
  FYERS_APP_ID="XXXXXXXXXXXX-100" \
  FYERS_ACCESS_TOKEN="<token>" \
  EVOLUTION_REQUIRE_APPROVAL="true" \
  RAZORPAY_KEY_ID="<key>" \
  RAZORPAY_KEY_SECRET="<secret>" \
  RAZORPAY_WEBHOOK_SECRET="<secret>"
```

#### 6. Deploy

```bash
fly deploy
```

---

### Production Environment Variables

Complete reference for production deployments. Never commit these to version control.

```bash
# ── Core ──────────────────────────────────────────────────────────────────────
NODE_ENV=production
PORT=3000              # or 8080 for Fly.io
LOG_LEVEL=warn         # reduce noise in prod; use info for first launch
SIMULATE=false         # must be false in production

# ── Database ──────────────────────────────────────────────────────────────────
DATABASE_URL=postgresql://user:pass@host:5432/dbname?sslmode=require
# TimescaleDB must be installed — vanilla PostgreSQL will fail on migration

# ── Redis ─────────────────────────────────────────────────────────────────────
REDIS_URL=redis://default:token@host:6379
# Redis 7+ required; use rediss:// (TLS) for managed providers

# ── Fyers Broker ──────────────────────────────────────────────────────────────
FYERS_APP_ID=XXXXXXXXXXXX-100
FYERS_ACCESS_TOKEN=<daily_oauth_token>   # Must be refreshed every day before 09:00 IST

# ── Angel One Broker (fallback, optional) ─────────────────────────────────────
ANGEL_API_KEY=
ANGEL_CLIENT_ID=
ANGEL_TOTP_SECRET=

# ── Payment (Razorpay) ────────────────────────────────────────────────────────
RAZORPAY_KEY_ID=rzp_live_XXXXXXXXXX     # Omit to run in free/open mode
RAZORPAY_KEY_SECRET=<secret>
RAZORPAY_WEBHOOK_SECRET=<webhook_signing_secret>

# ── Safety Guards ─────────────────────────────────────────────────────────────
EVOLUTION_REQUIRE_APPROVAL=true   # Never set false in prod

# ── Optional Overrides ────────────────────────────────────────────────────────
ENTRY_WINDOW_START_IST=09:15
ENTRY_WINDOW_END_IST=09:45
EOD_SQUAREOFF_IST=15:25
SIGNAL_MIN_EXPANSION_PCT=0.10
SIGNAL_CONFIRMATION_SNAPSHOTS=3
```

---

### Database Setup in Production

Run migrations once before first launch. Subsequent deployments are idempotent.

```bash
# Run from within your production environment / CI step
bun run migrate
```

The migration runner:
- Applies all pending migrations in `src/db/migrations/` in `NNN_` order
- Records each applied version in `schema_migrations`
- Is idempotent — safe to re-run on every deployment
- Creates TimescaleDB hypertables and continuous aggregates

**Never edit applied migration files.** Always add a new `NNN_description.sql` file for schema changes.

**Verify the database after first deploy:**
```bash
bun -e "
import { pool } from './src/db/client.ts';
const r = await pool.query('SELECT hypertable_name FROM timescaledb_information.hypertables;');
console.log('Hypertables:', r.rows.map(r=>r.hypertable_name));
await pool.end();
"
```
Expected: `market_ticks`, `straddle_snapshots`, `option_ticks`

---

### Frontend Build & Serving

In production, build the React frontend into static files and serve them from Fastify.

#### Build

```bash
bun run build
# Output: dist/ directory (index.html + hashed JS/CSS bundles)
```

#### Configure Fastify to Serve Static Files

Ensure `src/server/index.ts` registers the static plugin:

```typescript
import fastifyStatic from '@fastify/static';
import path from 'path';

// In production, serve the built frontend
if (process.env.NODE_ENV === 'production') {
  await server.register(fastifyStatic, {
    root: path.join(import.meta.dir, '../../dist'),
    prefix: '/',
    decorateReply: false,
  });

  // SPA fallback — serve index.html for all non-API routes
  server.setNotFoundHandler((_req, reply) => {
    return reply.sendFile('index.html');
  });
}
```

> In development, Vite handles frontend serving on `:5173` and proxies API calls to Fastify on `:3000`. In production, Fastify serves everything on a single port.

---

### Health Checks & Monitoring

#### Health Endpoint

The server exposes `GET /health`. Use this for load balancer and PaaS health checks:

```bash
curl http://localhost:3000/health
# Expected: {"status":"ok","db":"connected","redis":"connected"}
```

#### Key Metrics to Monitor

| Metric | Where to check | Alert threshold |
|--------|---------------|----------------|
| Straddle snapshot cadence | `SELECT count(*), max(time) FROM straddle_snapshots WHERE time > NOW() - INTERVAL '5 minutes';` | Alert if `count < 5` during market hours (09:15–15:30 IST) |
| Redis stream lengths | `XLEN straddle.values` | Alert if not growing during market hours |
| Open paper trades at EOD | `SELECT count(*) FROM paper_trades WHERE status = 'open' AND entry_time < '15:25 IST today';` | Alert if > 0 at 15:30 IST (EOD squareoff should have fired) |
| Fyers WS connection | Log lines | Alert on `[fyers] WebSocket disconnected` that is not followed by reconnect within 60s |

#### Log Aggregation

Set `LOG_LEVEL=info` (or `debug` for troubleshooting). All logs are structured JSON when `NODE_ENV=production`. Pipe to your preferred aggregator (Datadog, Grafana Loki, Railway's built-in log viewer):

```bash
# Railway: view logs live
railway logs

# Fly.io: view logs live
fly logs
```

---

### Fyers Token Refresh (Critical)

**The Fyers access token expires every day at midnight IST.** If the token is stale, the WebSocket silently disconnects with no retry. This is the most common cause of production outages.

#### Manual Daily Process (Pre-automation)

Before 09:00 IST every market day:

1. Open the Fyers auth URL in a browser:
   ```bash
   bun -e "
   import { FyersAuthHelper } from './src/ingestion/brokers/fyers-auth.ts';
   const h = new FyersAuthHelper(process.env.FYERS_APP_ID!);
   console.log(h.getAuthUrl());
   "
   ```

2. Log in and copy the `auth_code` from the redirect URL

3. Exchange for a token:
   ```bash
   bun -e "
   import { FyersAuthHelper } from './src/ingestion/brokers/fyers-auth.ts';
   const h = new FyersAuthHelper(process.env.FYERS_APP_ID!);
   const token = await h.exchangeCode('PASTE_CODE');
   console.log(token);
   "
   ```

4. Update the secret in your PaaS:
   ```bash
   # Railway
   railway variables set FYERS_ACCESS_TOKEN="<new_token>"

   # Fly.io
   fly secrets set FYERS_ACCESS_TOKEN="<new_token>"
   ```

5. Restart the app to pick up the new token.

#### Automated Token Refresh (Planned)

Token automation is a pre-production blocker. The flow requires storing the Fyers refresh token (or TOTP secret) securely and triggering a refresh job at 08:45 IST via a cron job or BullMQ scheduled task. Until this is built, do not operate in live mode unattended.

---

### Secrets Management

**Never commit secrets to git.** The repository has a pre-commit hook (lefthook) that blocks commits containing obvious secrets.

#### Local Development
- Store secrets in `.env` (git-ignored)
- `.env.example` documents all variables with safe defaults

#### Production
- Use your PaaS secret management:
  - **Railway**: Settings → Variables (encrypted at rest)
  - **Fly.io**: `fly secrets set KEY=VALUE` (encrypted, not in `fly.toml`)
- Rotate `RAZORPAY_WEBHOOK_SECRET` and `FYERS_ACCESS_TOKEN` regularly
- The app masks secrets in logs (only first 4 characters are logged)

#### What to Rotate

| Secret | Rotation trigger |
|--------|----------------|
| `FYERS_ACCESS_TOKEN` | Every day (mandatory) |
| `RAZORPAY_WEBHOOK_SECRET` | On suspected compromise |
| `RAZORPAY_KEY_SECRET` | On suspected compromise or quarterly |
| Database password | On suspected compromise or quarterly |

---

### Pre-Launch Checklist

Work through this before going live with real broker data.

#### Infrastructure

```
[ ] TimescaleDB 2.x confirmed on prod database (not vanilla PG)
[ ] All 9 migrations applied: SELECT count(*) FROM schema_migrations; → 9
[ ] 3 hypertables exist: SELECT hypertable_name FROM timescaledb_information.hypertables;
[ ] straddle_1min continuous aggregate exists
[ ] Redis is Redis 7+: docker exec redis redis-cli info server | grep redis_version
[ ] GET /health returns {"status":"ok","db":"connected","redis":"connected"}
```

#### Application

```
[ ] bun run --bun tsc --noEmit produces zero output
[ ] bun run test:unit — all tests pass
[ ] bun run test:integration — all tests pass (run against a staging DB)
[ ] 10 personality_configs rows: SELECT count(*) FROM personality_configs;
[ ] Clockwork is frozen: SELECT is_frozen FROM personality_configs WHERE name='Clockwork'; → true
[ ] EVOLUTION_REQUIRE_APPROVAL=true confirmed in prod env
[ ] Simulation mode was tested for ≥1 full market day before live mode
```

#### Broker Connectivity

```
[ ] Fyers App ID format verified (ends in -100)
[ ] Fyers access token generated today (not yesterday's)
[ ] WebSocket connects and first tick arrives within 60s of startup
[ ] Test with: docker exec redis redis-cli XLEN market.ticks → growing count
[ ] Angel One fallback tested in simulation before relying on it in live mode
```

#### Payment (if RAZORPAY_KEY_ID is set)

```
[ ] Razorpay is in LIVE mode (key starts with rzp_live_, not rzp_test_)
[ ] Webhook URL configured in Razorpay dashboard: https://your-domain.com/webhooks/razorpay
[ ] RAZORPAY_WEBHOOK_SECRET matches the value in Razorpay dashboard
[ ] GET /pricing returns correct plan amounts
[ ] Test payment flow end-to-end in Razorpay test mode before going live
```

#### Operations

```
[ ] Log aggregation is set up and receiving logs
[ ] Health check endpoint is configured in the PaaS
[ ] Alerting set up for: straddle snapshot staleness, WS disconnect, EOD squareoff failures
[ ] Fyers token refresh process documented and tested (manual or automated)
[ ] Rollback plan exists: docker compose down -v + restore DB from backup
[ ] Database backup schedule confirmed (TimescaleDB has continuous archiving options)
```

---

## Shutting Down

### Local
```bash
# Stop the application (Ctrl+C in terminal)

# Stop Docker services (data preserved)
docker compose down

# Full reset — deletes ALL data (use only to start completely fresh)
docker compose down -v
```

### Production (Railway)
```bash
railway down          # stop services
# Redeploy with: railway up
```

### Production (Fly.io)
```bash
fly scale count 0    # scale to zero (stop instances without deleting)
fly apps destroy ai-trading-agent   # permanent destruction
```
