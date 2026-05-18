# AI Trading Agent

Paper-trading research platform for weekly index options strategies on Indian markets (NSE/BSE).

## Quick Start

### Prerequisites
- Docker and Docker Compose
- [Bun](https://bun.sh) runtime

### 1. Start infrastructure

```bash
docker compose up -d
docker compose ps  # wait until both show (healthy)
```

### 2. Install dependencies

```bash
bun install
```

### 3. Run database migrations

```bash
bun run migrate
```

### 4. Start in simulation mode (no broker credentials needed)

```bash
SIMULATE=true bun run sim
```

The server starts on `http://localhost:3000`.

### 5. View the dashboard

In development, serve the frontend separately:

```bash
cd frontend
bun install
bun run dev      # Vite dev server at http://localhost:5173
```

In production (after `cd frontend && bun run build`), the built files are in `frontend/dist/`. Point a static server or the Fastify static plugin at that directory.

### API endpoints

| Endpoint | Description |
|---|---|
| `GET /health` | Health check |
| `GET /api/trades` | Open paper trades |
| `GET /api/trades/history` | Last 100 closed trades |
| `GET /dashboard/live` | Latest straddle snapshot |
| `GET /dashboard/summary` | Today's trades summary |
| `GET /paper-trades` | Paper trades with filters |
| `WS /ws/ticks` | Real-time straddle tick stream |

### Environment variables

See `.env.example` for the full list. Key variables:

| Variable | Default | Description |
|---|---|---|
| `SIMULATE` | — | Set to `true` for simulation mode |
| `DATABASE_URL` | `postgresql://trading:trading@localhost:5432/trading` | PostgreSQL connection string |
| `REDIS_URL` | `redis://localhost:6379` | Redis connection string |
| `BROKER` | `sim` | Broker adapter: `sim`, `fyers`, or `angelone` |
| `PORT` | `3000` | Fastify server port |
