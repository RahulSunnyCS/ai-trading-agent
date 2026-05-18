# Local Setup Guide — AI Trading Agent

This guide walks through setting up and running the AI Trading Agent on your local machine.

**Choose your setup method:**
- **[Option A: Docker Setup](#option-a-docker-setup-recommended)** (Recommended - easiest)
- **[Option B: Native Setup](#option-b-native-setup-without-docker)** (Without Docker)

---

## Prerequisites

### Required for Both Options

```bash
# Check Bun version
bun --version                # >= 1.0 required
```

**Install Bun** (if not already installed):
```bash
curl -fsSL https://bun.sh/install | bash
```

### Required for Option A (Docker Setup)

```bash
# Check Docker versions
docker --version             # >= 24 required
docker compose version       # >= 2.0 required
```

**Install Docker**: Follow instructions at [docker.com/get-started](https://www.docker.com/get-started)

### Required for Option B (Native Setup)

- **PostgreSQL 16+** with TimescaleDB extension
- **Redis 7+**

---

# Option A: Docker Setup (Recommended)

This is the easiest way to get started. Docker handles all infrastructure dependencies.

---

## Step 1: Clone and Install Dependencies

```bash
cd ai-trading-agent
bun install
```

This installs all Node dependencies defined in `package.json`.

---

## Step 2: Start Infrastructure (PostgreSQL + Redis)

The project uses Docker Compose to run TimescaleDB (PostgreSQL 16 + TimescaleDB extension) and Redis 7.

```bash
docker compose up -d
```

**Verify services are healthy:**
```bash
docker compose ps
```

Expected output:
```
NAME               STATUS
trading_postgres   Up X seconds (healthy)
trading_redis      Up X seconds (healthy)
```

Both should show `(healthy)` status. Health checks run every 5 seconds; allow up to 60 seconds on first start.

**Manual verification:**
```bash
# PostgreSQL
docker exec trading_postgres psql -U trading -d trading -c "SELECT version();"

# Redis
docker exec trading_redis redis-cli ping
# Expected: PONG
```

---

## Step 3: Configure Environment Variables

Copy the example environment file and configure credentials:

```bash
cp .env.example .env
```

**Edit `.env` file:**

### Required for Simulation Mode (Quick Start)
```bash
# Database (default Docker Compose values)
DATABASE_URL=postgresql://trading:trading_dev@localhost:5432/trading
REDIS_URL=redis://localhost:6379

# Simulation mode (no broker credentials needed)
SIMULATE=true
SIM_UNDERLYING=NIFTY
SIM_TICK_INTERVAL_MS=1000

# Runtime
NODE_ENV=development
PORT=3000
LOG_LEVEL=info
```

### Required for Live Mode (Fyers Broker)
If you want to connect to **live Fyers market data**, you need API credentials:

```bash
# Set simulation to false
SIMULATE=false

# Fyers credentials
FYERS_APP_ID=XXXXXXXXXXXX-100          # Your Fyers App ID
FYERS_ACCESS_TOKEN=your_access_token   # OAuth token (regenerate daily)
```

**How to get Fyers credentials:**
1. Log in to [Fyers API Dashboard](https://myapi.fyers.in/dashboard)
2. Create an app → note your **App ID** (client_id)
3. Generate an **access token** via OAuth flow (must be regenerated daily)
4. Token format: `{APP_ID}:{ACCESS_TOKEN}` (SDK handles this automatically)

**Note:** Fyers access tokens expire daily. For production use, automate token refresh using the `fyers-api-v3` auth API.

---

## Step 4: Run Database Migrations

Apply the schema to the PostgreSQL database:

```bash
bun run migrate
```

**Expected output:**
```
[migrate] Applying 001_initial_schema.sql...
[migrate] Applying 002_seed_personalities.sql...
[migrate] Migration complete.
```

This creates:
- Time-series hypertables for ticks, straddle snapshots, signals
- Tables for personalities, positions, trades, evolution rules
- Seeds 10 trading personalities

**Verify schema:**
```bash
docker exec trading_postgres psql -U trading -d trading -c "\dt"
```

---

## Step 5: Run the Application

### Simulation Mode (Default)
```bash
bun run sim
```

This starts the ingestion pipeline with a **simulated market data generator**:
- Generates realistic NIFTY option tick data
- No broker credentials needed
- Ideal for development and testing

### Live Mode (Fyers)
```bash
bun start
```

Or use watch mode for auto-reload during development:
```bash
bun run dev
```

**Expected console output:**
```
[main] AI Trading Agent — Data Ingestion (Broker: Fyers)
[main] Mode: SIMULATION (or LIVE)
[migrate] Migration complete.
[redis] Connected
[fyers] WebSocket connected (or [sim] Market simulator started)
[straddle] ATM: 24000, CE: 123.45, PE: 125.60, Total: 249.05
[main] Ingestion pipeline running. Ctrl+C to stop.
```

---

## Step 6: Verify Data Flow

### Check Redis Streams
```bash
docker exec trading_redis redis-cli
> XLEN market.ticks
> XLEN straddle.values
> XLEN signals.generated
```

You should see increasing stream lengths as ticks flow through the system.

### Check PostgreSQL Data
```bash
docker exec trading_postgres psql -U trading -d trading

-- Check recent ticks
SELECT symbol, ltp, volume, timestamp 
FROM ticks 
ORDER BY timestamp DESC 
LIMIT 10;

-- Check straddle snapshots
SELECT underlying, atm_strike, straddle_value, timestamp 
FROM straddle_snapshots 
ORDER BY timestamp DESC 
LIMIT 10;

-- Check trading personalities
SELECT id, name, entry_timing, roll_discipline 
FROM trading_personalities;
```

---

## Step 7: Run Tests (Optional)

```bash
# All tests
bun test

# Unit tests only
bun run test:unit

# Integration tests only
bun run test:integration
```

**Note:** Integration tests require running Docker services.

---

# Option B: Native Setup (Without Docker)

If you prefer to run PostgreSQL and Redis natively on your machine, follow these steps.

---

## B1: Install PostgreSQL with TimescaleDB

### macOS (using Homebrew)

```bash
# Install PostgreSQL 16
brew install postgresql@16

# Install TimescaleDB
brew tap timescale/tap
brew install timescaledb

# Start PostgreSQL service
brew services start postgresql@16

# Enable TimescaleDB extension
timescaledb-tune --quiet --yes
```

### Linux (Ubuntu/Debian)

```bash
# Add PostgreSQL repository
sudo sh -c 'echo "deb http://apt.postgresql.org/pub/repos/apt $(lsb_release -cs)-pgdg main" > /etc/apt/sources.list.d/pgdg.list'
wget --quiet -O - https://www.postgresql.org/media/keys/ACCC4CF8.asc | sudo apt-key add -

# Add TimescaleDB repository
echo "deb https://packagecloud.io/timescale/timescaledb/ubuntu/ $(lsb_release -c -s) main" | sudo tee /etc/apt/sources.list.d/timescaledb.list
wget --quiet -O - https://packagecloud.io/timescale/timescaledb/gpgkey | sudo apt-key add -

# Install
sudo apt update
sudo apt install postgresql-16 timescaledb-2-postgresql-16

# Start PostgreSQL
sudo systemctl start postgresql
sudo systemctl enable postgresql

# Tune TimescaleDB
sudo timescaledb-tune --quiet --yes
sudo systemctl restart postgresql
```

### Create Database and User

```bash
# Connect to PostgreSQL as superuser
psql postgres

# Run these SQL commands:
CREATE USER trading WITH PASSWORD 'trading_dev';
CREATE DATABASE trading OWNER trading;
\c trading
CREATE EXTENSION IF NOT EXISTS timescaledb CASCADE;
GRANT ALL PRIVILEGES ON DATABASE trading TO trading;
\q
```

**Verify installation:**
```bash
psql -U trading -d trading -c "SELECT version();"
psql -U trading -d trading -c "SELECT default_version FROM pg_available_extensions WHERE name='timescaledb';"
```

---

## B2: Install Redis

### macOS (using Homebrew)

```bash
# Install Redis
brew install redis

# Start Redis service
brew services start redis

# Verify
redis-cli ping
# Expected: PONG
```

### Linux (Ubuntu/Debian)

```bash
# Install Redis
sudo apt update
sudo apt install redis-server

# Configure to run as service
sudo systemctl start redis-server
sudo systemctl enable redis-server

# Verify
redis-cli ping
# Expected: PONG
```

**Optional Redis configuration** (edit `/usr/local/etc/redis.conf` on macOS or `/etc/redis/redis.conf` on Linux):
```conf
maxmemory 512mb
maxmemory-policy allkeys-lru
appendonly yes
```

Then restart Redis:
```bash
# macOS
brew services restart redis

# Linux
sudo systemctl restart redis-server
```

---

## B3: Install Dependencies and Configure

```bash
cd ai-trading-agent
bun install

# Copy and edit environment file
cp .env.example .env
```

**Edit `.env` file** to match your local setup:

```bash
# Database (native PostgreSQL)
DATABASE_URL=postgresql://trading:trading_dev@localhost:5432/trading

# Redis (native)
REDIS_URL=redis://localhost:6379

# Simulation mode (no broker credentials needed)
SIMULATE=true
SIM_UNDERLYING=NIFTY
SIM_TICK_INTERVAL_MS=1000

# Runtime
NODE_ENV=development
PORT=3000
LOG_LEVEL=info
```

---

## B4: Run Database Migrations

```bash
bun run migrate
```

**Expected output:**
```
[migrate] Applying 001_initial_schema.sql...
[migrate] Applying 002_seed_personalities.sql...
[migrate] Migration complete.
```

**Verify schema:**
```bash
psql -U trading -d trading -c "\dt"
```

---

## B5: Run the Application

```bash
# Simulation mode
bun run sim

# Or watch mode for development
bun run dev
```

---

## B6: Verify Data Flow (Native Setup)

### Check Redis Streams
```bash
redis-cli
> XLEN market.ticks
> XLEN straddle.values
> XLEN signals.generated
> exit
```

### Check PostgreSQL Data
```bash
psql -U trading -d trading

-- Check recent ticks
SELECT symbol, ltp, volume, timestamp
FROM ticks
ORDER BY timestamp DESC
LIMIT 10;

-- Check straddle snapshots
SELECT underlying, atm_strike, straddle_value, timestamp
FROM straddle_snapshots
ORDER BY timestamp DESC
LIMIT 10;

-- Check trading personalities
SELECT id, name, entry_timing, roll_discipline
FROM trading_personalities;

\q
```

---

## Common Issues

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
# Check for compilation errors
bun run --bun tsc --noEmit
```

---

## Project Structure

```
ai-trading-agent/
├── src/
│   ├── db/              # PostgreSQL client, migrations, schema types
│   ├── redis/           # Redis client, stream helpers
│   ├── ingestion/       # Fyers broker adapter, straddle calculator, VIX feed
│   ├── trading/         # Trading personalities, signal detection, execution
│   ├── types/           # Shared TypeScript types
│   └── index.ts         # Main entry point
├── docker-compose.yml   # PostgreSQL + Redis infrastructure
├── .env.example         # Environment variable template
├── package.json         # Bun project config
└── tsconfig.json        # TypeScript config
```

---

## Next Steps

- **Review personalities:** See `PERSONALITIES.md` for the 10 trading strategies
- **Monitor signals:** Watch the console for signal detection events
- **Explore data:** Query PostgreSQL to see real-time straddle evolution
- **Read architecture:** See `TECHNICAL_REFERENCE.md` for in-depth system design

---

## Shutting Down

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

## Getting Help

- Check `QA_VERIFICATION.md` for detailed verification steps
- Review `PRODUCT_OVERVIEW.md` for system architecture
- See `.env.example` for all configuration options
