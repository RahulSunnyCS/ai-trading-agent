# Developer Setup Guide

Three paths to a working dev environment. Pick whichever fits your machine.

| Path | Effort | Notes |
|---|---|---|
| A. Docker Compose | Lowest | One command, fully isolated |
| B. Local install | Medium | PostgreSQL + TimescaleDB + Redis installed on your OS |
| C. Hosted services | Low | No local services at all; uses free cloud tiers |

---

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

## Common problems

| Symptom | Likely cause | Fix |
|---|---|---|
| `CREATE EXTENSION timescaledb` fails | TimescaleDB not installed, or not in `shared_preload_libraries` | Re-run `timescaledb-tune` and restart PostgreSQL |
| `invalid integer value "IF" for connection option "port"` | Pasted a multi-line psql block containing `\c`; psql parsed the next line as `\c` arguments | Use `psql <dbname> -c "..."` one command at a time instead of pasting a block with `\c` inside |
| `bun run migrate` hangs | PostgreSQL not running, or wrong `DATABASE_URL` | Check the service is up; verify the URL in `.env` |
| `SIMULATE=true bun run sim` exits immediately | Redis not running, or wrong `REDIS_URL` | Check Redis; `redis-cli ping` should return `PONG` |
| `rediss://` connection refused | Using Upstash TLS URL against a local Redis | Local Redis uses `redis://` (no `s`); Upstash uses `rediss://` |
| `FYERS_ACCESS_TOKEN` errors in live mode | Token expires daily | Regenerate before 09:00 IST each market morning |
| Port 5432 or 6379 already in use | Conflicting local service | Change the Docker Compose port mapping or stop the local service |
