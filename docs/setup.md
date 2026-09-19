# Setup & Deployment

One document for getting the stack running, locally or in production. It
replaces the three that covered overlapping ground before (`SETUP.md`,
`docs/dev-setup.md`, `docs/DEPLOYMENT.md`), which had drifted into three
different answers for the same Docker steps.

Repository layout and the command reference are in
`.claude/project/technical.md`; they are not repeated here.


## Prerequisites (all paths)

- **Bun** — install from [bun.sh](https://bun.sh): `curl -fsSL https://bun.sh/install | bash`
- **Git** — should already be present

```bash
git clone <repo-url>
cd ai-trading-agent
bun install
cp .env.example .env   # edit .env with your chosen connection strings
```

---


## Path A — Docker Compose (recommended)

Docker handles PostgreSQL 16 + TimescaleDB and Redis 7 in one command. No manual extension setup.

**Requirement:** Docker Desktop (Mac/Windows) or Docker Engine (Linux).

```bash
docker compose up -d          # start both services
docker compose ps             # wait until both show (healthy)
bun run migrate               # apply DB migrations
SIMULATE=true bun run sim     # start in simulation mode
```

To stop and keep data:
```bash
docker compose down
```

To reset completely (wipes all trade data):
```bash
docker compose down -v
```

---


## Path B — Local install (no Docker)

### PostgreSQL 16 + TimescaleDB

TimescaleDB is a PostgreSQL extension. Install both together using the official packages.

**macOS (Homebrew)**

```bash
brew install postgresql@16
brew install timescaledb

# Enable the extension
timescaledb-tune --quiet --yes   # adjusts postgresql.conf

# Add to postgresql.conf (Homebrew path shown):
echo "shared_preload_libraries = 'timescaledb'" >> /opt/homebrew/var/postgresql@16/postgresql.conf

brew services restart postgresql@16

# Create the database and user — run each line separately, do NOT paste as a block.
# Using -c flags avoids the \c meta-command paste-parsing bug.
psql postgres -c "CREATE USER trading WITH PASSWORD 'trading';"
psql postgres -c "CREATE DATABASE trading OWNER trading;"
psql trading  -c "CREATE EXTENSION IF NOT EXISTS timescaledb CASCADE;"
psql postgres -c "GRANT ALL PRIVILEGES ON DATABASE trading TO trading;"
```

**Ubuntu / Debian**

```bash
# Add TimescaleDB repo (installs PostgreSQL 16 + extension together)
sudo apt install -y gnupg postgresql-common apt-transport-https lsb-release wget
sudo /usr/share/postgresql-common/pgdg/apt.postgresql.org.sh

# TimescaleDB repo
echo "deb https://packagecloud.io/timescale/timescaledb/ubuntu/ $(lsb_release -c -s) main" \
  | sudo tee /etc/apt/sources.list.d/timescaledb.list
wget --quiet -O - https://packagecloud.io/timescale/timescaledb/gpgkey | sudo apt-key add -

sudo apt update
sudo apt install -y timescaledb-2-postgresql-16

sudo timescaledb-tune --quiet --yes
sudo systemctl restart postgresql

sudo -u postgres psql -c "CREATE USER trading WITH PASSWORD 'trading';"
sudo -u postgres psql -c "CREATE DATABASE trading OWNER trading;"
sudo -u postgres psql trading  -c "CREATE EXTENSION IF NOT EXISTS timescaledb CASCADE;"
sudo -u postgres psql postgres -c "GRANT ALL PRIVILEGES ON DATABASE trading TO trading;"
```

**Windows**

Use [WSL 2](https://learn.microsoft.com/en-us/windows/wsl/install) and follow the Ubuntu steps above. Native Windows PostgreSQL + TimescaleDB installers exist but WSL 2 is simpler for development.

### Redis 7

**macOS**
```bash
brew install redis
brew services start redis
```

**Ubuntu**
```bash
# Redis 7 is in the official Ubuntu 22.04+ repos; for older Ubuntu use the Redis repo
sudo apt install -y redis-server
sudo systemctl enable --now redis-server
```

### .env for local install

```
DATABASE_URL=postgresql://trading:trading@localhost:5432/trading
REDIS_URL=redis://localhost:6379
```

### Then run

```bash
bun run migrate
SIMULATE=true bun run sim
```

---


## Path C — Hosted services (no local services at all)

Use free-tier cloud databases. Zero installation, but requires a network connection while developing.

### PostgreSQL + TimescaleDB — Timescale Cloud

1. Sign up at [console.cloud.timescale.com](https://console.cloud.timescale.com) — free trial, no credit card required for the first 30 days.
2. Create a service (PostgreSQL 16, TimescaleDB pre-installed).
3. Copy the connection string from the dashboard.

```
DATABASE_URL=postgresql://tsdbadmin:<password>@<host>.tsdb.cloud:5432/tsdb?sslmode=require
```

### Redis — Upstash

1. Sign up at [upstash.com](https://upstash.com) — free tier: 10 000 commands/day.
2. Create a Redis database, choose the region closest to you.
3. Copy the Redis URL from the console.

```
REDIS_URL=rediss://default:<password>@<host>.upstash.io:6379
```

Note the `rediss://` (with double `s`) — Upstash requires TLS.

### Then run

```bash
bun run migrate              # applies migrations to the hosted DB
SIMULATE=true bun run sim    # runs fully on your laptop, data goes to the cloud DBs
```

---


## Verify the setup

Whichever path you chose, run:

```bash
bun run migrate              # should print "All migrations applied" with no errors
SIMULATE=true bun run sim    # should print "[index] Simulation mode active"
```

In a second terminal:

```bash
curl http://localhost:3000/health
# → {"status":"ok","time":<epoch-ms>}

curl http://localhost:3000/dashboard/live
# → 404 until the first 15-second snapshot publishes, then a straddle snapshot object
```

---


## Frontend (optional)

The React dashboard is served separately in development:

```bash
cd frontend
bun install
bun run dev       # Vite dev server at http://localhost:5173
```

Vite proxies `/api` and `/ws` to the Fastify backend at `localhost:3000`.

---


## Corporate / restricted network (JFrog proxy)

If your organisation routes all npm traffic through a JFrog Artifactory proxy and
`@biomejs/biome` is not cached there, `bun install` will fail with an error like:

```
error: GET https://<proxy>/artifactory/api/npm/.../biome-1.9.4.tgz
```

Biome is NOT in `devDependencies` for this reason — it is installed as a standalone
binary instead.

**One-time setup (run after cloning):**

```bash
bash scripts/install-biome.sh   # downloads ./tools/biome from GitHub Releases
```

`bun run lint` and the pre-commit hook both check for `./tools/biome` first; they
skip gracefully if it is absent (you can still develop, lint just won't run locally).

**If GitHub Releases is also blocked:** download the binary on a machine with internet
access from `https://github.com/biomejs/biome/releases/tag/cli/v1.9.4`, place it at
`./tools/biome`, then `chmod +x ./tools/biome`.

**Permanent fix:** ask your JFrog admin to add these packages to the virtual npm repo
as proxied from `https://registry.npmjs.org`:
- `@biomejs/biome`
- `@biomejs/cli-linux-x64`
- `@biomejs/cli-linux-arm64`
- `@biomejs/cli-darwin-arm64`
- `@biomejs/cli-darwin-x64`
- `@biomejs/cli-win32-x64`

Once they are available, run `bun install` and restore `@biomejs/biome` to
`devDependencies`; the standalone-binary path can then be removed.

---



## Troubleshooting

### Common issues

### Docker-Specific Issues

#### 1. Docker services not starting
```bash
# Check logs
docker compose logs postgres
docker compose logs redis

# Restart services
docker compose down
docker compose up -d
```

#### 2. Port conflicts (5432 or 6379 already in use)
```bash
# Check what's using the ports
lsof -i :5432
lsof -i :6379

# Either stop the conflicting service or edit docker-compose.yml to use different ports:
# For PostgreSQL: change "5432:5432" to "5433:5432"
# For Redis: change "6379:6379" to "6380:6379"
# Then update DATABASE_URL and REDIS_URL in .env accordingly
```

#### 3. Migration fails (Docker)
```bash
# Reset database (WARNING: deletes all data)
docker compose down -v
docker compose up -d
bun run migrate
```

### Native Setup Issues

#### 4. PostgreSQL connection refused
```bash
# Check if PostgreSQL is running (macOS)
brew services list | grep postgresql

# Start it if stopped
brew services start postgresql@16

# Check if PostgreSQL is running (Linux)
sudo systemctl status postgresql

# Start it if stopped
sudo systemctl start postgresql
```

#### 5. TimescaleDB extension not found
```bash
# Reinstall TimescaleDB and restart PostgreSQL
# macOS
brew reinstall timescaledb
brew services restart postgresql@16

# Linux
sudo apt install --reinstall timescaledb-2-postgresql-16
sudo systemctl restart postgresql
```

#### 6. Redis connection refused
```bash
# Check if Redis is running (macOS)
brew services list | grep redis

# Start it if stopped
brew services start redis

# Check if Redis is running (Linux)
sudo systemctl status redis-server

# Start it if stopped
sudo systemctl start redis-server
```

#### 7. PostgreSQL authentication failed
```bash
# Edit pg_hba.conf to allow local connections
# macOS: /usr/local/var/postgresql@16/pg_hba.conf
# Linux: /etc/postgresql/16/main/pg_hba.conf

# Add this line:
# local   all   trading   md5

# Restart PostgreSQL
brew services restart postgresql@16  # macOS
sudo systemctl restart postgresql    # Linux
```

### General Issues

#### 8. Migration fails (schema errors)
```bash
# Drop and recreate database (WARNING: deletes all data)
psql postgres -c "DROP DATABASE IF EXISTS trading;"
psql postgres -c "CREATE DATABASE trading OWNER trading;"
psql -U trading -d trading -c "CREATE EXTENSION IF NOT EXISTS timescaledb CASCADE;"
bun run migrate
```

#### 9. Fyers connection fails
- Verify `FYERS_APP_ID` and `FYERS_ACCESS_TOKEN` are correct
- Check if access token has expired (regenerate daily)
- Try simulation mode first: `SIMULATE=true`

#### 10. TypeScript errors
```bash
# Check for compilation errors (both workspace packages)
bun run typecheck
```

---


### More problems

| Symptom | Likely cause | Fix |
|---|---|---|
| `CREATE EXTENSION timescaledb` fails | TimescaleDB not installed, or not in `shared_preload_libraries` | Re-run `timescaledb-tune` and restart PostgreSQL |
| `invalid integer value "IF" for connection option "port"` | Pasted a multi-line psql block containing `\c`; psql parsed the next line as `\c` arguments | Use `psql <dbname> -c "..."` one command at a time instead of pasting a block with `\c` inside |
| `bun run migrate` hangs | PostgreSQL not running, or wrong `DATABASE_URL` | Check the service is up; verify the URL in `.env` |
| `SIMULATE=true bun run sim` exits immediately | Redis not running, or wrong `REDIS_URL` | Check Redis; `redis-cli ping` should return `PONG` |
| `rediss://` connection refused | Using Upstash TLS URL against a local Redis | Local Redis uses `redis://` (no `s`); Upstash uses `rediss://` |
| `FYERS_ACCESS_TOKEN` errors in live mode | Token expires daily | Regenerate before 09:00 IST each market morning |
| Port 5432 or 6379 already in use | Conflicting local service | Change the Docker Compose port mapping or stop the local service |
| `bun install` fails fetching `@biomejs/biome` | Corporate npm proxy doesn't have the package | Run `bash scripts/install-biome.sh` — see Corporate / restricted network section above |

### Shutting down

### Docker Setup
```bash
# Stop application (Ctrl+C in terminal)
^C

# Stop Docker services
docker compose down

# Stop and remove all data (WARNING: deletes volumes)
docker compose down -v
```

### Native Setup
```bash
# Stop application (Ctrl+C in terminal)
^C

# PostgreSQL and Redis keep running in the background
# To stop them:

# macOS
brew services stop postgresql@16
brew services stop redis

# Linux
sudo systemctl stop postgresql
sudo systemctl stop redis-server
```

---



## Production deployment



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
- Applies all pending migrations in `apps/server/src/db/migrations/` in `NNN_` order
- Records each applied version in `schema_migrations`
- Is idempotent — safe to re-run on every deployment
- Creates TimescaleDB hypertables and continuous aggregates

**Never edit applied migration files.** Always add a new `NNN_description.sql` file for schema changes.

**Verify the database after first deploy:**
```bash
bun -e "
import { pool } from './apps/server/src/db/client.ts';
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
bun run --filter @ata/dashboard build
# Output: apps/dashboard/dist/ (index.html + hashed JS/CSS bundles)
```

#### Configure Fastify to Serve Static Files

Ensure `apps/server/src/server/index.ts` registers the static plugin:

```typescript
import fastifyStatic from '@fastify/static';
import path from 'path';

// In production, serve the built frontend
if (process.env.NODE_ENV === 'production') {
  await server.register(fastifyStatic, {
    root: path.join(import.meta.dirname, '../../../dashboard/dist'),
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

