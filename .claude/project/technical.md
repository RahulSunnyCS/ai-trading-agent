# Technical Context

## Tech Stack

| Area | Choice |
|---|---|
| Language | TypeScript 5.x — strict mode |
| Runtime | Bun (latest) — used for all execution, including migrations and scripts |
| Web Framework | Fastify 4.x — schema-validated routes, ~2ms p99 latency target |
| Primary DB | PostgreSQL 16 + TimescaleDB 2.x extension (required, not optional) |
| ORM / DB Access | Raw SQL via `pg` pool — no ORM. Custom migration runner in `apps/server/src/db/migrate.ts` |
| Message Queue / Event Bus | Redis 7 Streams — topics: `market.ticks`, `straddle.values`, `signals.generated` |
| Background Jobs | BullMQ (Redis-backed) — EOD retrospection batch |
| Cache | Redis 7 — sub-ms reads for price cache and personality state |
| Frontend | Next.js 15 + React 18 + Zustand (state) + Tailwind CSS 3.x + Lightweight Charts. The in-app Guide renders Markdown with `react-markdown` + `remark-gfm` (pages in `apps/dashboard/src/guide/content`, imported `?raw`) |
| Testing | Vitest (unit + integration) + Playwright (E2E) |
| Market Data | Fyers WebSocket via `fyers-api-v3` SDK (untyped — TypeScript shim in `apps/server/src/types/`) |
| Paper Trading | Quantiply API (paper trade execution tracking) |
| VIX Data | NSE public API endpoint (polling fallback) + Fyers tick (`NSE:INDIAVIX-INDEX`) |
| Deployment | Docker Compose (dev) → Railway / Fly.io (prod) |
| Options Backtesting | Python 3.12 + `uv`, in `packages/option-backtesting` — Parquet + DuckDB cache, pydantic-validated YAML strategy DSL, bar-by-bar event engine (golden-fixture-verified to the rupee), FastAPI service + MCP server, fronted by a Fastify proxy and a React dashboard tab; walk-forward, parameter sweeps, a CSCV/PBO + deflated-Sharpe overfitting guard, a margin model, regime bucketing, and personality export are all built (M-5) — the epic is feature-complete |
| Momentum Backtesting | Python 3.12 + `uv` research engine and private FastAPI service (`mbt serve`) in `packages/momentum-backtesting`; the shared Next.js dashboard owns the Momentum frontend. Weekly index, stock, Custom Index and Broad Momentum rotation use Fyers/public-source prices and the shared local research database (`packages/trading-data`). The CLI supports fetching, backtesting, weekly signals and rebalance previews. |

## Package Manager & Runtime

- **Monorepo:** Bun workspaces — `workspaces: ["apps/*", "packages/*"]`. One `bun.lock` at the repo root covers every JS workspace. Root scripts fan out via `bun run --filter <pkg> <script>` or `bun run --workspaces <script>`; run them from the repo root unless you deliberately want to scope to one package
- **Package manager:** Bun — single lockfile (`bun.lock`) at the repo root. Do not use `npm` or `yarn`; they will create a second lockfile and conflict
- **Runtime:** Bun for `apps/*`. Four exceptions: **`packages/contract-notes` runs on Node 20** (CommonJS; its scripts shell out to `node`), and **`packages/option-backtesting`, `packages/momentum-backtesting` and `packages/trading-data` are Python/uv**, not Bun workspace members
- **CI pins bun `1.2.x`**, which *hoists*; bun 1.3+ uses an *isolated* layout for workspaces. Both read the same lockfile — verified — but they produce different `node_modules` trees. See the hoisting gotcha below
- **TypeScript:** Compiled and executed natively by Bun — no `tsc` build step for running. `tsc --noEmit` is used only for type-checking

## Essential Commands

All commands below are run from the **repo root** and fan out to the relevant workspace package(s).

```bash
# Install dependencies (single lockfile for the whole monorepo)
bun install

# Start infrastructure (PostgreSQL + Redis via Docker)
docker compose up -d
docker compose ps          # verify both show (healthy)

# Run database migrations (idempotent — safe to re-run)
bun run migrate

# Development — simulation mode (no broker credentials needed)
bun run sim                 # equivalent to SIMULATE=true bun run dev

# Development — live mode (Fyers credentials required)
bun run dev                 # watch mode with auto-reload (apps/server)
bun run start:server         # production-style start (apps/server)

# Standalone research stack (no Docker): both Python APIs + one dashboard
bun run start                # restart Momentum :8765, Options :8000, dashboard :5190 (next dev, for UI editing)
bun run start:backend        # restart the two Python APIs only
bun run start:frontend       # restart the dashboard only
bun run stop:research        # stop this checkout's research processes
# Same, with a production build of the dashboard (BL-004: pages ready in ~1 s, not 6-10 s).
# Builds into apps/dashboard/.next-prod, skipped when nothing changed; refuses to start without
# DASHBOARD_PASSWORD (env or apps/dashboard/.env.local). Both modes bind 127.0.0.1 only.
bun run start:prod           # APIs + `next start` on :5190; sign in at /login
bun run start:frontend:prod  # the production dashboard only; add `-- --rebuild` / `-- --port 5191`

# Dashboard dev server (Next.js on :5173; rewrites /api to the server on :3000)
bun run --filter @ata/dashboard dev

# Type-check the server (root script is scoped to @ata/server only; the
# dashboard has its own check, which CI runs in the dashboard job — run it
# explicitly if you touch apps/dashboard)
bun run typecheck
bun run --filter @ata/dashboard typecheck

# Workspace-wide
bun run --filter '*' typecheck     # packages only — NOT the root app
(cd packages/broker-login   && bun run typecheck)
(cd packages/contract-notes && bun run test)   # Jest; needs Node 20 on PATH

# Scheduler service (BL-012) — apps/scheduler; see its CLAUDE.md
bun run --filter @ata/scheduler jobs status    # every job: schedule, last run, next run
bun run --filter @ata/scheduler jobs run <id>  # run one job now

# Laptop scheduler (launchd keeps apps/scheduler alive) — see deploy/launchd/README.md
deploy/launchd/install.sh    # (re)install the scheduler agent; retires the old per-job plists
deploy/launchd/uninstall.sh

# Git hooks (lefthook, installed by `bun install`). pre-push runs Biome on the changed files,
# Ruff, and the unit tests of each package the branch changes (BL-014); pytest stays in CI
node_modules/.bin/lefthook run pre-push   # run the pre-push checks without pushing

# Tests
bun run test                # unit tests in every workspace package
bun run test:unit           # server unit tests only
bun run test:integration    # server integration tests (requires Docker services running)
bun run test:e2e            # dashboard Playwright suite (start the Next dev server first)

# option-backtesting (Python) — run from packages/option-backtesting/
cd packages/option-backtesting
uv sync
./scripts/build-cache.sh   # REQUIRED on a fresh clone before pytest — see note below
uv run pytest
uv run obt ingest plan --date YYYY-MM-DD --to YYYY-MM-DD --underlying NIFTY
uv run obt ingest --date YYYY-MM-DD --underlying NIFTY
uv run obt validate strategies/B_pyramid.yaml
uv run obt run strategies/B_pyramid.yaml --from YYYY-MM-DD --to YYYY-MM-DD
uv run obt registry
uv run obt walkforward strategies/B_pyramid.yaml --is-from YYYY-MM-DD --is-to YYYY-MM-DD --oos-from YYYY-MM-DD --oos-to YYYY-MM-DD
uv run obt sweep strategies/B_pyramid.yaml --changes changes.json --from YYYY-MM-DD --to YYYY-MM-DD [--overfit --n-blocks 4]
uv run obt export-personality <run_id>
uv run obt fyers fetch [--date YYYY-MM-DD]   # daily 1m Fyers collector — same evening, expiring contracts vanish
uv run obt fyers history [--underlying NIFTY] [--from D] # backfill index + India VIX 1m history (resumable; any time — indexes never expire)

# trading-data (Python) — the shared local database; run from any package that depends on it
uv run tdata init           # create TRADING_DATA_ROOT (~/TradingData) + catalog, load reference data
uv run tdata status         # where it lives, rows/days per view, ingest runs, reference-CSV drift
uv run tdata reference sql "INSERT INTO ref_lot_sizes VALUES ('NIFTY', 75, DATE '2027-01-01')"  # edit + re-export CSVs
uv run tdata backup --to /Volumes/<disk>/TradingData   # monthly; copies only new lake/raw files
uv run tdata mount          # attach TRADING_DATA_IMAGE if the root's volume is not mounted (idempotent)
uv run tdata vendor import --from "/Volumes/RAHUL'S SSD/Stock Market Data/parquet/options" --unit nifty  # BL-034: vendor options history -> lake (resumable; Fyers days never overwritten); import-index <csv> --symbol NIFTY for spot / INDIAVIX
uv run tdata derived rebuild [--day D] [--force] [--check]  # 5-minute chain snapshots, straddle series, IV tables from the lake (BL-034 Phase 3; NIFTY+SENSEX)
uv run tdata reference derive-expiries  # rebuild the real expiry list per index from the lake (prints gaps) + re-export CSVs
uv run tdata quality rebuild  # re-judge every lake day -> data_quality (usable / excluded + why); `quality status` summarises; `quality export` rewrites the lock-free verdict file the engine reads
uv run obt legwise run strategies/legwise/*.yaml [--trades] [--include-excluded] [--bars 5m]   # AlgoTest-style leg-wise backtests over that data; skips (and counts) days data_quality excludes
uv run obt legwise rerun    # re-run every strategy over every collected day and save (after editing a strategy)
uv run obt daily            # the evening routine: fetch the last closed session (+ nearest/next futures), judge it (data_quality), build its derived tables, run every strategies/legwise/*.yaml, save, summarise + Telegram with verdicts and IV percentile (--no-telegram)
uv run pytest tests/golden/test_legwise_scenarios.py  # 30 frozen-input exact-output scenarios
uv run python scripts/update-legwise-goldens.py       # check-only; --accept-results after reviewing an intentional correction

# option-backtesting FastAPI service (loopback-only, port 8000) — from repo root
bun run py:api               # equivalent to: cd packages/option-backtesting && uv run obt-api
# The Fastify proxy (BACKTEST_API_URL, default http://127.0.0.1:8000) is the only
# public-facing surface in front of it — see apps/server/src/server/routes/backtest.ts.

# momentum-backtesting (Python) — run from packages/momentum-backtesting/
cd packages/momentum-backtesting
uv sync
uv run pytest
uv run mbt login            # browser login; caches today's Fyers token in data/ (never printed)
uv run mbt token-status     # where the token would come from and when it expires
uv run mbt fetch            # daily history from 2016 -> data/weekly_closes.csv + .xlsx
uv run mbt fetch --no-fyers # only the public sources (cash NAV, silver)
uv run mbt compare         # rank-and-rotate backtest, off/ranked/filter modes -> data/backtests/
uv run mbt serve           # private Momentum API on 127.0.0.1:8765
uv run mbt journal show    # forward-signal journal (BL-024): every weekly signal as recorded
uv run mbt journal verify  # check no journal entry was changed, removed or reordered
uv run mbt journal check [--send]  # did this week's runs record every favourite? (Fri 21:00 scheduler job)
uv run python scripts/update-goldens.py   # check frozen results; --accept-results --reason "..." after an intended change
uv run python scripts/bench-backtest.py [--scenario broad_default] [--live] [--profile out.prof]   # time one backtest cold/warm/cached/via jobs, with the seconds per stage; golden-fixture data by default
uv run python scripts/result-baseline.py capture --data-dir <data> --out <dir>   # snapshot every result on LIVE data; `compare --baseline <dir>` after a change meant to keep them
uv run mbt stocks fetch --skip-download  # rebuild the Nifty 50 stock data layer from the raw cache, no network
uv run mbt stocks pin-manifest           # commit the raw cache + events as the new reproducibility baseline

# option-backtesting MCP server (stdio) — registered in root .mcp.json as "option-backtesting";
# a Claude Code session picks it up automatically, no manual start needed.

# Teardown
docker compose down         # stop services, keep data volumes
docker compose down -v      # stop + destroy data volumes (full reset)
```

## Package Index — cross-package links & shared utilities

Every app/package below now has its own `CLAUDE.md` (deep, package-local context — commands,
source layout, gotchas) and a thin `AGENTS.md` that just points at it, so any coding agent
lands in the right file regardless of which convention it reads by default. This table is the
one place that shows the **whole** dependency graph at a glance; each package's own `CLAUDE.md`
only documents its own edges (what it imports, what imports it) per the "one fact, one file"
rule below.

| Package/App | Purpose | Exports other code uses | Used by |
|---|---|---|---|
| `packages/notify` (`@trading/notify`) | Outbound Telegram notifications + the never-emit secret registry | `send`, `sendText`, `istTimestamp`, `registerSecret`, `redact` | `packages/broker-identity`, `packages/broker-login` (Node/Bun only — Python callers reimplement the `Notification` shape rather than importing an ESM package) |
| `packages/market-reference` (`@trading/market-reference`) | Effective-dated NSE/BSE lot-size / strike-step lookups | `lotSize`, `strikeStep` | `apps/server` (`trading/paper-trade-executor.ts`, `trading/portfolio-risk.ts`) |
| `packages/broker-identity` (`@trading/broker-identity`) | Canonical `BrokerId` type + the one RFC 6238 TOTP generator + the Fyers 06:00 IST token-expiry rule | `BrokerId`, `generateTotp`, `freshTotp`, `waitForNextWindow`, `fyersTokenExpiry` | `apps/server` (`ingestion/brokers/angelone.ts`, `services/fyers-auth.ts`), `packages/broker-login` |
| `packages/broker-login` | Daily Playwright jobs — logs Angel One/Finvasia into AlgoTest via TOTP; separately logs Fyers in headlessly (`fyers-login`, stores to `broker_tokens`) | — (leaf; nothing in-repo imports it) | depends on `broker-identity` + `notify` |
| `packages/contract-notes` | Daily Gmail → PDF → Google Sheet F&O P&L pipeline | — (leaf; Node 20/CommonJS, reimplements the `Notification` shape itself instead of importing the ESM `@trading/notify`) | none |
| `packages/momentum-backtesting` | Python weekly momentum-rotation research tool (`mbt` CLI) | private FastAPI service (`mbt serve`) | `apps/dashboard` through Fastify's `/api/momentum/*` proxy; still no code imports from `option-backtesting` |
| `packages/option-backtesting` | Python options-strategy backtesting engine (`obt` CLI, FastAPI, MCP) | its `data/reference/*.csv` files are read directly off disk — not imported as code — by `market-reference`'s loader (see below); since 2026-09-30 those CSVs are EXPORTED from `trading-data`'s catalog (`tdata reference export`), which is the master | `apps/server`, via the Fastify proxy over HTTP only — never imported as a package |
| `packages/trading-data` | Python/uv: the local research database — DuckDB catalog (instruments, reference data, ingest runs, strategies, backtest results, companies/corporate actions/index+category membership, momentum's cross-instrument price series) + Parquet lake (`bars_1m_*`, `bars_1d_stock`) + raw vendor copies under `TRADING_DATA_ROOT`; `tdata init/status/backup/reference` | `db.connect`, `lake.*` paths/writers and the bars_1m schemas, `instruments.register`, `ingest.start_run/finish_run`, `quality.rebuild/verdict/excluded_days`, `derived.rebuild/build_day`, `reference.export_csvs/check` | `packages/option-backtesting` and `packages/momentum-backtesting` (both editable path dependencies) |
| `apps/server` (`@ata/server`) | Fastify/Bun trading backend | — | `apps/dashboard` (HTTP only) |
| `apps/scheduler` (`@ata/scheduler`) | Runs every recurring job (BL-012): registry, IST schedules, runner, SQLite run history | — | none — leaf; runs the other packages' CLIs as child processes |
| `apps/dashboard` (`@ata/dashboard`) | Next.js/React frontend | — | none — leaf; talks to `apps/server` over HTTP only, imports no internal package |

**The one filesystem-level (non-import) cross-package link, easy to miss:**
`packages/market-reference/src/loader.ts` does not carry its own copy of the NSE lot-size/
strike-step CSVs — it reads them straight out of
`packages/option-backtesting/src/option_backtesting/data/reference/` by relative path at
runtime, specifically so the TypeScript live engine and the Python backtest engine can never
disagree about a lot size the way they did for months (`apps/server` once hard-coded NIFTY at
50 while these CSVs said 65 — see the NIFTY lot-size gotcha below). Because of this, changing
`option-backtesting`'s reference CSVs changes what `market-reference` returns with no code
change or version bump on either side — always check both packages' tests together when editing
those CSVs.

## Repository Structure

A Bun-workspaces monorepo: three apps — `apps/server` (Fastify/Bun backend), `apps/dashboard` (Next.js/React frontend) and `apps/scheduler` (recurring jobs, BL-012) — and eight packages. Five are Bun/TypeScript workspace members: `packages/notify`, `packages/market-reference`, and `packages/broker-identity` (small, dependency-thin shared libraries imported by the apps and/or the other packages), plus `packages/broker-login` and `packages/contract-notes` (both Node 20, each with its own CI workflow — see below). The other three, `packages/option-backtesting`, `packages/momentum-backtesting` and `packages/trading-data` (the shared local research database both backtesting packages use), are Python/uv and not Bun workspace members. Shared config (biome, lefthook, docker-compose, CI) stays at the repo root.

```
ai-trading-agent/
├── package.json                     # workspace root: "workspaces": ["apps/*", "packages/*"]
├── bun.lock                         # single lockfile for the whole monorepo
├── tsconfig.base.json               # shared strict compilerOptions, extended by each package's tsconfig.json
├── docker-compose.yml               # TimescaleDB (timescale/timescaledb:latest-pg16) + Redis 7
├── .env.example                     # single shared .env at repo root; both apps read it
├── biome.json · lefthook.yml        # repo-wide lint/format + pre-commit hooks
├── .mcp.json                        # registers the "option-backtesting" MCP server (obt-mcp, stdio)
├── scripts/install-biome.sh         # root-level tooling (downloads the Biome binary), not app code
├── deploy/cloudflared/              # tunnel config template for serving the research APIs from a laptop (docs/remote-dashboard.md)
├── deploy/launchd/                  # the one LaunchAgent that keeps apps/scheduler running + install/uninstall (BL-012)
├── apps/
│   ├── server/                      # @ata/server — the Fastify/Bun backend
│   │   ├── package.json · tsconfig.json · vitest.config.ts · vitest.workspace.ts
│   │   ├── scripts/                 # replay.ts, backtest.ts, backfill-legs.ts, reconstruct.ts
│   │   └── src/
│   │       ├── db/
│   │       │   ├── client.ts               # PostgreSQL pool + query helpers
│   │       │   ├── migrate.ts              # Custom migration runner with retry logic
│   │       │   ├── schema.ts               # TypeScript types for every DB table
│   │       │   └── migrations/             # Sequential SQL migration files (001_*.sql, etc.)
│   │       ├── redis/
│   │       │   └── client.ts               # Redis client + streamPublish / streamRead helpers
│   │       ├── ingestion/
│   │       │   ├── straddle-calc.ts        # ATM strike calculation, 15s snapshots, ROC/acceleration
│   │       │   ├── vix-feed.ts             # VIX poller (NSE public API fallback)
│   │       │   ├── market-data-sim.ts      # Random-walk simulator for dev (no broker needed)
│   │       │   └── brokers/
│   │       │       ├── types.ts            # BrokerFeed interface + BrokerTick type
│   │       │       ├── broker-factory.ts   # createBroker() factory — selects adapter by BROKER / SIMULATE env
│   │       │       ├── fyers.ts            # Fyers fyersDataSocket adapter (socketFactory DI, reconnect circuit breaker, AUTH_FAILURE detection)
│   │       │       ├── angelone.ts         # Angel One (SmartAPI) adapter
│   │       │       └── instrument-registry.ts  # Weekly/monthly symbol builder + expiry helpers
│   │       ├── jobs/
│   │       │   └── token-validity-check.ts # Pre-market Fyers token expiry check + BullMQ scheduler
│   │       ├── state/
│   │       │   └── broker-status.ts        # Runtime broker auth degradation flag (AUTH_FAILURE detection)
│   │       ├── trading/                    # Personalities, signal detection, paper execution
│   │       ├── types/
│   │       │   └── fyers-api-v3.d.ts       # TypeScript declaration shim for untyped Fyers SDK
│   │       └── index.ts                    # Main entry point (branches on SIMULATE env var)
│   └── dashboard/                   # @ata/dashboard — the Next.js/React frontend
│       ├── package.json · tsconfig.json · next.config.ts · vitest.config.ts · playwright.config.ts
│       ├── tailwind.config.ts · postcss.config.js
│       ├── e2e/                     # Playwright specs
│       └── src/                     # App.tsx, components/, hooks/, lib/, store/, types/
│                                     # components/optionslab/ + hooks/useBacktest*.ts, useLegwise*.ts — Options
│                                     # Lab (Strategies, Builder with Form | YAML modes, Runs, Daily results,
│                                     # Regimes); the YAML engine's tab (M-4) is now the Builder's YAML mode.
│                                     # Fed entirely through /api/backtest/* (never the Python service directly)
└── packages/
    ├── notify/                      # @trading/notify — outbound notifications plus the
    │                                 # never-emit secret registry. Imported by the Node/Bun
    │                                 # workspaces; Python mirrors the Notification shape
    │                                 # rather than importing (see Notifications below).
    ├── market-reference/            # @trading/market-reference — effective-dated NSE/BSE lot
    │                                 # size / strike step lookups, read from the same CSVs as
    │                                 # the Python engine (packages/option-backtesting). apps/server
    │                                 # imports this rather than hard-coding a lot size — see the
    │                                 # NIFTY lot-size gotcha under Gotchas below.
    ├── broker-identity/              # @trading/broker-identity — the canonical `BrokerId` type
    │                                 # ('angelone' | 'finvasia') and the one RFC 6238 TOTP
    │                                 # generator (generateTotp/freshTotp/waitForNextWindow) used
    │                                 # by every broker login path: apps/server's live Angel One
    │                                 # WebSocket auth and packages/broker-login's Playwright
    │                                 # AlgoTest automation both depend on this instead of each
    │                                 # carrying (or, formerly, apps/server depending on otplib
    │                                 # for) its own generator. See the TOTP convention under Key
    │                                 # Patterns & Conventions below.
    ├── broker-login/                # Node 20 + Playwright. Was the algo-automation repo, merged via
    │                                 # git subtree (history preserved). Logs Angel One and
    │                                 # Finvasia into AlgoTest each morning via TOTP; the broker
    │                                 # OAuth handshake happens on the broker's own domain, so it cannot
    │                                 # be done over HTTP. Every locator lives in src/selectors.ts.
    │                                 # Daily workflow's schedule is currently disabled — see
    │                                 # docs/algotest-execution.md
    ├── contract-notes/              # Node 20 + CommonJS + Jest. Was the trade-analytics repo, merged via
    │                                 # git subtree. Gmail IMAP → qpdf decrypt → PDF parse → Google Sheet,
    │                                 # producing realised F&O P&L per broker account. Needs the qpdf
    │                                 # system binary. Has its own CLAUDE.md. Schedule disabled pending
    │                                 # cutover — the trade-analytics repo still owns the live cron.
    │                                 # All money math (brokers/*.js, updateSheet.js) uses decimal.js —
    │                                 # see the decimal.js convention under Key Patterns & Conventions.
    ├── momentum-backtesting/        # Python 3.12 / uv — weekly momentum rotation across ~21 NSE sector/
    │                                 # broad indices plus gold, silver, Nasdaq 100, Hang Seng and a
    │                                 # defensive cash/gilt pair. Own pyproject.toml/uv.lock; `mbt` CLI.
    │                                 # Fyers token: valid broker_tokens via DATABASE_URL > env >
    │                                 # FYERS_TOKEN_FILE > `mbt login` cache (0600). Direct-mode UI
    │                                 # previews prefer the local cache over stale env fallbacks. Instrument
    │                                 # list + trade ETFs in src/momentum_backtesting/universe.csv.
    │                                 # data/ is gitignored and regenerated by `mbt fetch`.
    │                                 # stocks/ — a separate, from-scratch survivorship-free Nifty 50
    │                                 # daily/weekly stock data layer (`mbt stocks fetch`/`pin-manifest`/
    │                                 # `validate`); curated/ (company identity, membership, manual
    │                                 # corporate actions, guard exceptions) is committed, data/stocks/
    │                                 # is gitignored. Wired into the ranking engine and the UI (stock
    │                                 # mode in the shared dashboard, incl. gold/silver/debt ranked alongside
    │                                 # stocks) — see the package README's "Stocks data" section.
    │                                 # categories/ — a separate "category momentum" layer: the existing
    │                                 # sector/thematic ETF engine (unmodified) ranks categories as
    │                                 # today, and when one is investable an inner backtest substitutes
    │                                 # the top-K individual stocks currently tagged to it instead of the
    │                                 # ETF (`mbt categories fetch|resolve|backtest`). Wired into the UI
    │                                 # as the Custom Index tab (compose.py) and the Broad Momentum tab
    │                                 # plus Momentum Scores page (broad.py) — TODO.md §3.9, §3.11.8.
    └── option-backtesting/          # Python 3.12 / uv — strategy-research workbench over AlgoTest option
                                      # bars, answering "is this strategy worth becoming a personality?"
                                      # (a different question from apps/server's `bun run backtest`, which
                                      # replays the live personalities historically). Not a Bun workspace
                                      # member — has its own pyproject.toml/uv.lock. Feature-complete
                                      # end to end (M-0 through M-5): data layer, strategy DSL, and the
                                      # bar-by-bar engine (golden-fixture-verified to the rupee, M-1/M-2/
                                      # M-3); FastAPI service, MCP server, Fastify proxy, dashboard tab
                                      # (M-4); walk-forward, sweeps, a CSCV/PBO + deflated-Sharpe
                                      # overfitting guard, a margin model, regime bucketing, personality
                                      # export, and a nightly ingest Routine (M-5).
        ├── pyproject.toml · uv.lock · .python-version · DECISIONS.md
        ├── src/option_backtesting/
        │   ├── config.py                 # BACKTEST_DATA_DIR-derived Parquet bar cache path resolution —
        │   │                              # shared by api/app.py and mcp/server.py (the run registry has
        │   │                              # no path to resolve any more — see engine/registry.py)
        │   ├── presets.py                # preset_names()/STRATEGIES_DIR — the allow-list both the API and
        │   │                              # the MCP server check BEFORE building a filesystem path (no traversal)
        │   ├── data/
        │   │   ├── providers/{base,algotest,dhan}.py   # MarketDataProvider Protocol, canonical Bar/InstrumentKey
        │   │   ├── resolver.py         # ATM/OTMn/ITMn/EXACT -> concrete strike, independent of any vendor
        │   │   ├── reference/          # effective-dated CSVs: expiry_calendar, holidays, lot_sizes, strike_step, margin
        │   │   ├── quality.py          # ingest-time gates: identical_series, bar_gaps, zero_volume, etc.
        │   │   ├── raw.py              # raw AlgoTest JSON manifest read/write (data/raw/algotest/, tracked)
        │   │   ├── ingest.py           # raw JSON -> quality-gated Parquet (data/cache/, gitignored)
        │   │   └── cache.py            # DuckDB façade the engine reads (never a provider directly)
        │   ├── features/                # named, cached, point-in-time feature evaluation (leg_sum, raw, gap,
        │   │   │                         # greek, days_to_expiry, max_runup, session_high/low, rolling_mean/
        │   │   │                         # ewma/rolling_pctile) — registry.py (M-2) is the declarative schema,
        │   │   │                         # the rest (M-3) is the runtime evaluator
        │   │   ├── registry.py · store.py · evaluator.py
        │   │   ├── leg.py · greeks.py · calendar.py · path.py · rolling.py
        │   │   └── regime.py           # M-5, R2: post-hoc regime bucketing only, NOT a DSL condition
        │   │                           # feature — see DECISIONS.md for why
        │   ├── strategy/                 # schema.py (M-2 pydantic AST) · loader.py (line-numbered YAML errors)
        │   │   │                         # · mutate.py (M-5: deep_merge, shared by propose_strategy + sweep)
        │   ├── engine/                   # bar-by-bar event engine (M-3), pinned to reproduce the design
        │   │   │                         # handoff's reference implementation to the rupee — see
        │   │   │                         # engine/loop.py's module docstring before changing any formula
        │   │   ├── loop.py             # SessionContext, build_sessions, simulate_session, run_backtest
        │   │   ├── conditions.py       # Condition/Ref grammar evaluation (all/any/not/feature/time, anchors)
        │   │   ├── fills.py            # trigger_level (default)/bar_close/worst_of_bar/next_open + slippage
        │   │   ├── costs.py            # flat cost = total_lots × 2 legs × per_leg_rt
        │   │   ├── ledger.py · state.py  # Fill/SessionLedger; per-session running-anchor/last-fill state
        │   │   ├── result.py           # SessionResult/AggregateResult, bootstrap_ci (R1a), render_report
        │   │   ├── margin.py           # M-5, R1: classify_strategy_type + return on peak margin
        │   │   └── registry.py         # Run history in the shared trading-data catalog (package=
        │   │                           # 'options_dsl', since 2026-09-30 — was data/registry.sqlite).
        │   │                           # The `strategy_yaml` column (M-5) lets export-personality
        │   │                           # reconstruct a run's exact strategy from just its run_id
        │   ├── analytics/                 # M-5: research tools that consume the engine's output, not part
        │   │   │                          # of a single backtest run
        │   │   ├── walkforward.py      # same-strategy in-sample/out-of-sample split (no re-fitting)
        │   │   ├── sweep.py            # run a base strategy against many change-dicts over one window
        │   │   ├── overfit.py          # CSCV/PBO + simplified (Gaussian) Deflated Sharpe over a sweep
        │   │   └── regime_source.py    # reads daily_regime_tags from Postgres, gated on DATABASE_URL,
        │   │                           # lazy psycopg import; no connection without DATABASE_URL
        │   ├── export/
        │   │   └── personality.py        # M-5, R3: StrategySpec -> PersonalityConfigM2 candidate
        │   │                             # ({entryType, managementStyle, params}); unrepresentable DSL
        │   │                             # constructs go under manual_review, never guessed; never writes
        │   │                             # to any database
        │   ├── api/                      # FastAPI service (M-4), loopback-only (127.0.0.1:8000) — the
        │   │   │                         # Fastify proxy is the only public-facing surface in front of it
        │   │   ├── app.py              # create_app() factory + `obt-api` uvicorn entry point
        │   │   ├── routes.py           # validate/runs/presets/coverage/health
        │   │   └── models.py           # pydantic request/response models
        │   ├── mcp/
        │   │   └── server.py             # `obt-mcp` stdio MCP server (M-4/M-5) — mcp 2.x's MCPServer (see
        │   │                             # DECISIONS.md); tools: plan_requests, validate_strategy,
        │   │                             # run_backtest, run_walkforward, run_sweep, check_overfit,
        │   │                             # list_runs, critique_result, export_personality, propose_strategy
        │   └── cli.py                    # `obt` — ingest plan | ingest | validate | run | registry |
        │                                 # walkforward | sweep [--overfit] | export-personality
        └── tests/{golden,parity,unit}/    # tests/golden/test_engine_golden.py is the M-3 exit gate —
                                            # reproduces golden_15_sessions.expected.txt to the rupee for A/B/C/D
```

## Architecture

The system is a **real-time event-driven pipeline** in four layers:

1. **Data Ingestion:** Fyers WebSocket (or simulator) → raw tick → Redis `market.ticks` stream
2. **Event Processing:** Redis Streams fan-out to straddle calculator and VIX feed
3. **Signal Generation:** Straddle calc → ROC/acceleration engine → peak detection → signal router → personality filter stages → paper trade execution
4. **Execution & Retrospection:** Paper trades stored in PostgreSQL; BullMQ EOD job runs retrospection; rule engine queues parameter suggestions

**Personality routing:** Every signal is broadcast to all active personalities simultaneously. Each personality runs its own 5-stage filter chain independently. There is no shared state between personalities at decision time.

**BrokerFeed interface:** All broker adapters implement a common `BrokerFeed` interface (`src/ingestion/brokers/types.ts`). The simulator and the Fyers adapter are interchangeable. New brokers follow this pattern.

**Hypertables:** `market_ticks`, `straddle_snapshots`, and `option_ticks` are TimescaleDB hypertables (auto-partitioned by time). Queries against these tables must always include a time-range filter — full-table scans on hypertables are extremely slow and should never appear in production code.

**Continuous aggregates:** `straddle_1min` is a TimescaleDB materialized view. Refresh is automatic. Do not manually insert into it.

**Clockwork immutability:** `personality_configs.is_frozen = TRUE` for the Clockwork row. The evolution engine checks this flag before applying any rule and throws `FROZEN_VIOLATION` (not silently skips) if violated. Never bypass this check.

**Comparison integrity:** Precision, Adjuster, and Reducer all use `entry_type = MOMENTUM_EXHAUSTION`. Their `min_probability` thresholds must stay within 8 percentage points of each other. The `checkComparisonIntegrity()` function enforces this and pauses evolution on the outlier if breached.

## Key Patterns & Conventions

- **No ORM:** All DB access is raw SQL via the `pg` pool. Query results are typed against the interfaces in `apps/server/src/db/schema.ts`
- **Migration files:** Named `NNN_description.sql` in `apps/server/src/db/migrations/`. The runner applies them in order and records applied versions in `schema_migrations`. Always add new migrations as new files — never edit applied ones. Runner identifies migrations by **filename only** (no content checksum): once a file is applied, its name is registered in `schema_migrations` and re-runs are skipped. Editing already-applied migrations affects only fresh installs; existing databases skip them. For schema changes, determine the canonical source: `personality_configs` and `straddle_signals` are canonically defined in `001_core_schema.sql` (params-shape); later migration files that repeat these CREATE TABLEs are no-ops on fresh installs. When editing historical migrations, verify the change applies to the intended phase of deployment (fresh vs. existing DB).
- **Broker symbol format (Fyers):** Weekly options: `NSE:NIFTY{YY}{M}{DD}{STRIKE}{TYPE}` where months Oct–Dec use single letter codes (O, N, D). See `instrument-registry.ts` for the encoder/decoder
- **ATM strike intervals:** NIFTY = 50pt, BankNifty = 100pt, Sensex = 100pt. Always use `getAtmStrike()` — never compute this inline
- **Broker adapter selection:** All brokers (Fyers, Angel One, simulator) implement the common `BrokerFeed` interface. The `createBroker()` factory in `apps/server/src/ingestion/brokers/broker-factory.ts` selects the adapter based on `BROKER` and `SIMULATE` env vars: `BROKER=fyers` → FyersBroker, `BROKER=angelone` → AngelOneBroker, `BROKER=sim` or `SIMULATE=true` → MarketDataSimulator. If `BROKER` is unset/empty AND `SIMULATE !== 'true'`, the factory throws a descriptive error at startup — safe default-throw prevents silent misconfiguration in live environments.
- **TOTP generation is centralised in `@trading/broker-identity`:** `generateTotp()` (RFC 6238, SHA-1/30s/6-digit) is the one implementation in the repo. `apps/server/src/ingestion/brokers/angelone.ts` (live Angel One WebSocket auth) and `packages/broker-login` (Playwright AlgoTest automation, which also uses the package's `freshTotp`/`waitForNextWindow` for its retry-on-stale-code flow) both depend on it — apps/server no longer depends on `otplib`. Never add a second TOTP generator; import this one.
- **Canonical broker identifier is `finvasia`, not `shoonya`:** `@trading/broker-identity` exports `BrokerId = 'angelone' | 'finvasia'`. `packages/broker-login` used `shoonya` as its internal key until 2026-09 (Shoonya was Finvasia's old product name); every internal identifier there (the broker's `key`, `config.ts`'s field, `selectors.ts`'s `finvasiaForm`/`brokerNames`/`dataBrokerKeys`, the filename `brokers/finvasia.ts`) now says `finvasia`, matching `packages/contract-notes` (which always did). The `SHOONYA_CLIENT_ID`/`SHOONYA_PASSWORD`/`SHOONYA_TOTP_SECRET` env vars deliberately were NOT renamed — they are already-configured GitHub Actions repository secrets (an external contract); only the internal code identifier changed.
- **All monetary arithmetic uses `decimal.js` — never native JS number arithmetic.** This applies repo-wide, not just `apps/server` (where it was already the rule for straddle/P&L math in `trading/`): `packages/contract-notes/brokers/segments.js`'s `parseAmounts()` returns `Decimal` instances (constructed directly from the matched digit string, never routed through `Number.parseFloat` first), and every sum/subtraction/tolerance-comparison in `brokers/finvasia.js`, `brokers/angelone.js`, and `updateSheet.js`'s `buildAccountValues()` stays in `Decimal` until the final boundary, where `.toNumber()` converts back to a plain number only because that's what `daily_summary.json` and the Google Sheets API (`RAW` value input) require. Before 2026-09, `updateSheet.js` computed `total_charges`/`final_net` with native `+`/`-` on real rupee figures — silently imprecise the same way `0.1 + 0.2 !== 0.3` is, just usually not visible at 2dp display precision. See `tests/updateSheet.test.js`'s `'total_charges is exact for values that break native float addition'` test for the regression case.
- **Simulation mode:** Controlled by `SIMULATE=true` env var. The simulator generates realistic random-walk NIFTY tick data at configurable interval AND emits synthetic ATM CE/PE option-leg ticks so the straddle pipeline works end-to-end. Everything downstream is identical — simulation is not a test mode, it uses the real pipeline. Hypertable writes are trimmed to ~10000 rows via MAXLEN on all ingestion xadds.
- **Regime tagging:** Every retrospection result must carry a `market_regime` tag. Never compare personality performance across different regimes without filtering. The four tags are: `RANGING`, `TRENDING_STRONG`, `VOLATILE_REVERTING`, `EVENT_DAY`
- **Probability scores:** Not empirically calibrated yet. Treat as relative rankings, not absolute probabilities. Brier scores are tracked in `retrospection_results.signal_brier_score`
- **TypeScript strict mode:** Enabled. `fyers-api-v3` has no official types — the shim at `apps/server/src/types/fyers-api-v3.d.ts` covers the SDK surface we use
- **No default exports:** Use named exports throughout
- **Merges into `main` go through green CI (BL-014).** Branch protection requires the four
  CI jobs that run on every PR. In Claude Code, `.claude/hooks/merge-guard.py` (a `PreToolUse`
  hook on Bash) refuses `gh pr merge` while any check is failing or pending, `--admin`, a PR over
  500 changed lines (data, fixtures and lockfiles excluded) without the `reviewed` label, and a
  push to `main` that changes anything but `*.md` outside `packages/*/src/`. Add `reviewed` only
  after `/code-review` has run and its result is on the PR
- **Dashboard colours and type come from tokens** — never a hex in a component. Token roles,
  the chart palette helpers (`lib/chartTheme.ts`) and the font setup (self-hosted `next/font/local`, IBM Plex
  Sans / Mono) are in `docs/dashboard-design-tokens.md`
- **Guide pages stay in step with their screens** — a change to a dashboard screen's controls, labels,
  defaults or metrics updates its page in `apps/dashboard/src/guide/content/` in the same commit; a new
  screen or sub-section gets a page and a `guide/registry.ts` entry (conventions in `apps/dashboard/CLAUDE.md`)
- **Dashboard display formatting lives in `apps/dashboard/src/lib/format.ts`** — components
  never call `Intl.*`, `toFixed` or `toLocaleString`. Use `formatInr`, `formatPct` (takes a
  fraction; pass `{ unit: 'percent' }` otherwise), `formatPp`, `formatNumber`, `formatDay`
  (a zone-less 'YYYY-MM-DD'), `formatIstDate` / `formatIstTime` (instants), `EMPTY`
- **Dashboard controls come from `components/ui/`** — `SegmentedControl` for one-of-N,
  `Tabs` for any tab bar (the only place `role="tablist"` appears), `Input` / `Select` /
  `NumberField` for fields, `RefreshButton`, `CopyButton`, `toast()`. Do not hand-roll another
- **Dashboard data fetching goes through `usePolledResource<T>`**
  (`apps/dashboard/src/hooks/usePolledResource.ts`) — never hand-roll another
  AbortController + in-flight-guard fetch loop. It existed independently in
  ~10 hooks before being extracted, and two of them (usePersonalities,
  useRegimeTags) had a real bug from that duplication: calling `refresh()`
  while a fetch was already in flight aborted it and then skipped starting a
  replacement, leaving the view stuck on "loading" forever. The shared hook
  fixes this by construction — `refetch()` (including the initial mount
  fetch) always cancels and replaces; only a poll tick skips itself when one
  is already in flight, so a slow endpoint does not pile up overlapping
  requests. Pass `{ intervalMs }` for a polling hook (e.g. `usePaperTrades`);
  omit it for fetch-once-with-manual-refresh (most of the others). Add
  `{ cache: true }` when a view re-mounts often (the Momentum sections, the
  global `useMeta` / `useFyersAuthStatus` / `usePaymentBalance`): it
  starts from the last response for that URL, kept in memory for the session,
  and still revalidates; `fetchCached()` shares that cache for one-off reads.
  Instances share one in-flight request per URL (mount and poll ticks join it,
  `refetch()` starts afresh). Poll ticks pause while the tab is hidden. Poll a
  job's status only while it runs (`useMomentumWeeklyJob`, `useDailyJob`)

## Testing

- **Unit tests (Vitest):** Peak detection algorithm, decision engine filter stages (each stage independently), evolution rule trigger conditions, P&L calculations, parameter clamping, ATM strike rounding, symbol builder correctness
- **Integration tests (Vitest):** Signal → personality → paper trade full flow; Redis Streams message passing; TimescaleDB continuous aggregate correctness. Require Docker services to be running
- **E2E tests (Playwright):** Dashboard renders live data; trade log updates in real-time; retrospection results display
- **Dashboard hook tests (Vitest + `@testing-library/react` + `happy-dom`):**
  `apps/dashboard/src/hooks/__tests__/usePolledResource.test.tsx` — the only
  hook test file so far, and the only one needing a DOM. It opts in per-file
  via a `// @vitest-environment happy-dom` pragma rather than changing
  `vitest.config.ts`'s shared `'node'` default, so the two existing
  pure-logic test files are unaffected
- **Tailwind class test (Vitest):**
  `apps/dashboard/src/lib/__tests__/tailwindClasses.test.ts` compiles Tailwind over
  `src/**` and fails on any token-bearing utility (`bg-`, `text-`, `border-`, `ring-`,
  `shadow-`, `rounded-`, `font-`, …) that emits no CSS — Tailwind drops an unknown class
  silently, which is how `bg-positive/12` and `bg-surface-1` shipped with no style. A
  utility-shaped string that is not a class goes in that file's `NOT_CLASSES`
- **No coverage threshold set yet** — will be added when Sprint 2 test suite stabilises
- **Backtesting requirement:** Before any production deployment, run against minimum 6 months of historical tick data with separate training and test periods

## Environment Variables

Critical variables whose misconfiguration causes real pain:

| Variable | Notes |
|---|---|
| `DATABASE_URL` | Must point at PostgreSQL 16 with TimescaleDB extension installed. Missing extension → migration fails with `type "timestamptz" does not exist in hypertable` or similar |
| `REDIS_URL` | Must be Redis 7+. BullMQ uses Redis Streams features not in Redis 6 |
| `FYERS_ACCESS_TOKEN` | **Expires daily.** Fallback when no valid dashboard `broker_tokens` row is available; a fresh Broker logins token takes precedence. AUTH_FAILURE on stale token is detected and surfaced to the frontend via /api/meta `authDegraded=true` and /api/auth/fyers/status `needsReauth=true` |
| `FYERS_APP_ID` | Format is `XXXXXXXXXXXX-100` (app ID + `-100` suffix). Wrong format → Fyers SDK auth failure. A stored token minted for a different app ID is rejected and the UI requires re-login |
| `FYERS_APP_SECRET` | Server-only OAuth secret. Also supplies pgcrypto's passphrase for AES-256 encryption of new `broker_tokens` rows; never returned to or stored by the browser. Existing plaintext rows remain readable only until the next login rewrites them encrypted |
| `QUANTIPLY_API_KEY` | Required in live mode. Missing → paper trade writes fail silently if error handling isn't tight |
| `BROKER` | Selects the adapter: `fyers` (default), `angelone`, or `sim`. Omitting this AND omitting `SIMULATE=true` → safe default-throw error at startup (no silent fallback) |
| `SIMULATE` | Set to `true` for credential-free development mode. When set, MarketDataSimulator is selected regardless of `BROKER` value |
| `MAX_WS_CONNECTIONS` | Max concurrent /ws/ticks WebSocket connections (default 50). Positive integers only; non-positive values silently fall back to 50 |
| `EVOLUTION_REQUIRE_APPROVAL` | Should be `true` in any environment where the retrospection engine runs. Setting `false` allows the system to autonomously modify personality parameters without human review |
| `TOKEN_VALIDITY_SCHEDULER_ENABLED` | When set to `true`, registers a BullMQ cron job that checks Fyers token expiry at 08:45 IST weekdays. Disabled by default; opt-in via this flag |
| `BACKTEST_API_URL` | Base URL of the loopback-only Python FastAPI service (default `http://127.0.0.1:8000`). The Fastify proxy validates this resolves to loopback/private address space at startup — a public host throws (safe default-throw), the proxy never starts against it |
| `MOMENTUM_API_URL` | Base URL of the loopback-only Momentum FastAPI service (default `http://127.0.0.1:8765`). The Fastify `/api/momentum/*` proxy applies the same loopback/private-host guard as options backtesting |
| `MOMENTUM_DIRECT_API_URL` / `OBT_DIRECT_API_URL` | Dashboard build-time origins for the `MOMENTUM_DIRECT=1` / `OBT_DIRECT=1` rewrites (defaults `http://127.0.0.1:8765` / `http://127.0.0.1:8000`). Point them at Cloudflare Tunnel hostnames to run the dashboard off the backend laptop — see `docs/remote-dashboard.md` |
| `SCHEDULER_API_PORT` / `SCHEDULER_DIRECT` / `SCHEDULER_DIRECT_API_URL` | The scheduler (`apps/scheduler`, `jobs serve`) runs a loopback-only JSON API on `127.0.0.1:$SCHEDULER_API_PORT` (default 8790). `SCHEDULER_DIRECT=1` (set by `scripts/dev-stack.mjs`; off in a plain production build) makes the dashboard rewrite `/api/scheduler/*` to `SCHEDULER_DIRECT_API_URL` (default `http://127.0.0.1:8790`), ahead of the `/api/*` catch-all. The dev stack never starts a second scheduler loop |
| `DASHBOARD_PASSWORD` | Password for the dashboard (`apps/dashboard/src/middleware.ts`): a `/login` page that sets a 30-day signed `HttpOnly` session cookie for people, and HTTP Basic (username ignored) for `/api/*` and curl. Changing it signs everyone out. **Required** whenever the dashboard is reachable remotely — a production build, or either `UPSTREAM_ACCESS_*` var set — and a missing one makes every request 503 rather than serve openly. Unset is fine only for local `next dev` |
| `UPSTREAM_ACCESS_CLIENT_ID` / `UPSTREAM_ACCESS_CLIENT_SECRET` | Cloudflare Access service token the dashboard's Next server adds to `/api/*` requests it forwards to the tunnel hostnames; client-supplied copies are always stripped. Set both or neither: one without the other (or one blank) makes every request 503 rather than letting every API call fail upstream |
| ~~`MOMENTUM_DATABASE_URL`~~ | **Retired 2026-09-30** (TODO 3.11.5) — `packages/momentum-backtesting`'s price history and weekly signals now live in the shared `momentum_prices`/`momentum_signals` tables (`TRADING_DATA_ROOT`), not a separate Neon Postgres. `DATABASE_URL` (unrelated, still live) is what momentum's `fyers.py` reads for `broker_tokens` |
| `FYERS_TOKEN_FILE` | Path of the 0600 JSON token `packages/broker-login`'s `bun run fyers-token` writes in CI (headless Fyers login: `FYERS_CLIENT_ID`/`FYERS_PIN`/`FYERS_TOTP_SECRET` + app id/secret/redirect). `mbt` reads it after the dashboard token and `FYERS_ACCESS_TOKEN`; the workflow deletes it when the job ends |
| `NOTIFY_PREFS_FILE` | Optional override for the notification preferences file (default `~/.config/ai-trading-agent/notifications.json`, `{"disabled": [type, ...]}`) that `@trading/notify` and both Python `notify.py` copies read before every Telegram send (BL-012). Missing or broken = everything on |
| `TRADING_DATA_ROOT` | The local research database (`packages/trading-data`): `catalog.duckdb` + the Parquet `lake/` + gzipped `raw/` vendor responses. Default `~/TradingData`. On the owner's laptop it is `/Volumes/TradingData`, an APFS disk image on the external SSD (BL-034: ~110k day files would cost 2×256 KiB each on ExFAT). Every process refuses a root on a `/Volumes/<name>` that is not mounted (`trading_data.db.check_mounted`) rather than writing elsewhere; `tdata mount` attaches it. `obt`, `obt-api` and `obt-mcp` load the repo `.env` at start, `mbt` already did; `tdata` reads the environment only. Replaced `FYERS_DATA_DIR` (2026-09-30). The Fyers 1-minute data in it cannot be re-downloaded once contracts expire — back it up monthly with `tdata backup --to <disk>` |
| `TRADING_DATA_IMAGE` | Path of the disk image `tdata mount` attaches (and the `trading-data-mount` LaunchAgent at login / when a volume appears). Must be double-quoted in `.env`: the launchd jobs `source` it with bash and the SSD's name contains an apostrophe and a space |
| `SCHEDULER_STATE_DIR` / `SCHEDULER_LOG_DIR` | `apps/scheduler`'s run history (`scheduler.db`) and per-job logs. Defaults `~/Library/Application Support/ai-trading-agent` and `~/Library/Logs/ai-trading-agent` |
| `BACKUP_VOLUME` | Mount point of the external disk the scheduler's monthly `backup` job copies `TRADING_DATA_ROOT` to (default `/Volumes/RAHUL'S SSD`). Not mounted → `~/Downloads/TradingData-backup` plus a Telegram warning |
| `BACKTEST_DATA_DIR` | Optional override for where the FastAPI/MCP service reads its Parquet bar cache (`<dir>/cache`). Defaults to `packages/option-backtesting`'s own `data/` when unset. The run registry no longer lives under this — it's in the shared `trading_data` catalog, rooted at `TRADING_DATA_ROOT` |

## Common Tasks

**Add a new broker adapter:**
1. Implement `BrokerFeed` interface from `apps/server/src/ingestion/brokers/types.ts`
2. Add the adapter file under `apps/server/src/ingestion/brokers/`
3. Update `apps/server/src/index.ts` to select the new adapter based on an env var

**Add a new personality:**
1. Insert a row into `personality_configs` in the seed migration (or via a new migration)
2. Add the personality's evolution rules to the rule engine
3. If Phase 2+, set `phase = 2` so it is gated behind the Phase 2 flag

**Add a database table:**
1. Create a new migration file `apps/server/src/db/migrations/NNN_description.sql`
2. Add TypeScript interface to `apps/server/src/db/schema.ts`
3. Run `bun run migrate` to apply

**Change a signal parameter:**
1. Adjust the env var (e.g., `SIGNAL_MIN_EXPANSION_PCT`) — no code change needed for thresholds in `PeakDetectionConfig`
2. For structural algorithm changes, modify `apps/server/src/ingestion/straddle-calc.ts`

## Gotchas

- **NIFTY lot-size gotcha** — `apps/server` once hard-coded NIFTY's lot size at 50; the real,
  effective-dated reference data (`packages/option-backtesting/src/option_backtesting/data/
  reference/lot_sizes.csv`, also read by `packages/market-reference`) said 65. Every paper P&L
  was ~30% out for months because nothing compared the two. Never hard-code a lot size or
  strike interval anywhere — always call `lotSize()`/`strikeStep()` from `@trading/market-reference`
  (TypeScript) or read the CSVs directly (Python); see that package's `CLAUDE.md` for the
  filesystem-level link between it and `option-backtesting`'s reference data.
- **Lot size belongs to the contract's expiry, not the trading day** — the exchanges revise a lot size per contract, and a contract listed before a revision keeps its old size until it expires. On 2025-01-15 NIFTY's 16 Jan weekly is 75 while the 30 Jan monthly is still 25. `lot_sizes.csv`'s `effective_date` is therefore the first expiry a size applies to (history 2024-10 → today for all six indices, each value checked against the circulars and against the vendor volumes, whose per-minute quantities are multiples of the lot). Look it up with the leg's expiry (`ReferenceData.lot_size(underlying, expiry)`, `lotSize(underlying, expiry)`) — the legwise engine's `execution.lot_sizing: historical`. Its default is `current` (owner, 2026-10-07, like AlgoTest): today's lot on every day, so a rupee stop means the same throughout. A day-keyed lookup is 3× wrong for the weeklies between 2024-11-20 and 2025-01-01.
- **Fyers token dies at the next 06:00 IST, not 24h after login** — `expires_in` is ignored: `fyersTokenExpiry()` (`packages/broker-identity`; Python mirror `fyers.token_expiry`) sets the expiry, stored rows are clamped on read from `updated_at`, and `/api/auth/fyers/status` also probes Fyers' profile endpoint so a revoked token shows Expired. The laptop's `fyers-login` launchd job (08:05 IST) refreshes it unattended; the dashboard button is the manual fallback. Dashboard-login tokens are no longer "manual daily only". New dashboard-login tokens are AES-256 encrypted at rest in `broker_tokens` through PostgreSQL pgcrypto; the browser receives only app ID/status/expiry. Missing, expired, or app-ID-mismatched tokens surface as “No API token” and require re-login. A pre-market token-validity check job runs at 08:45 IST on weekdays (opt-in via TOKEN_VALIDITY_SCHEDULER_ENABLED).
- **TimescaleDB is not optional** — the standard `postgres:16-alpine` image does NOT have TimescaleDB. The Docker Compose uses `timescale/timescaledb:latest-pg16`. Pointing the app at a vanilla PostgreSQL instance will fail on migration
- **Hypertable full-table scans** — a query on `market_ticks` or `straddle_snapshots` without a `WHERE time > ...` filter will scan years of data. Always filter by time range
- **Two test commands** — `bun run test:integration` requires Docker services running. Running it without them produces confusing connection errors, not a test-not-found error
- **Clockwork evolution guard** — the `is_frozen` flag must be checked in the evolution engine before any rule application. If you add a new rule that bypasses this check, Clockwork parameters will silently drift and invalidate months of comparative data
- **Comparison integrity drift** — if Precision, Adjuster, or Reducer `min_probability` thresholds drift more than 8 percentage points apart, the management comparison is invalidated. The `checkComparisonIntegrity()` function must run before any threshold evolution rule is applied
- **Simulation is not a mock** — `SIMULATE=true` runs the full production pipeline with synthetic data. It writes to the real database and Redis. Use `docker compose down -v` to reset state between test runs if needed
- **Port conflicts** — PostgreSQL default port 5432, Redis default 6379. If either is in use locally, edit the port mapping in `docker-compose.yml` and update the corresponding `_URL` env var
- **`data/cache/` is gitignored and the Python tests need it** — a fresh clone
  has no Parquet cache, so ~16 tests in `tests/unit/test_mcp_server.py` fail with
  `{"error": "no_data"}` before you have done anything wrong. Run
  `packages/option-backtesting/scripts/build-cache.sh`, which rebuilds it from
  the raw JSON committed under `data/raw/` (range derived from the fixture
  filenames, so it does not rot). CI does the same, behind an `actions/cache`
  keyed on `data/raw/**`
- **Hoisting differs by bun version** — 1.2 hoists, 1.3 isolates. A transitive
  dependency that resolves by accident under 1.2 will fail under 1.3. Four such
  latent bugs were found during the monorepo merge (`fastify-plugin`, `ws`,
  `google-auth-library`, and the `bun-types` types reference). **Always declare
  what you import**; never rely on a transitive copy being reachable
- **Notifications go through `@trading/notify`** — never call the Telegram API
  directly. It redacts every outbound string against the same registry that
  masks GitHub Actions logs, and it deliberately never sets `parse_mode`
  (broker names break Telegram's Markdown parser and Telegram then drops the
  whole message silently). `send()` is the structured API; `sendText()` is for
  a caller that builds its own layout. Buttons are `callback_data`, never
  URLs — Telegram pre-fetches links for previews, so a URL fires before anyone
  taps it. **The boundary is the contract, not a service:** `broker-login`
  runs in GitHub Actions while `apps/server` runs on Railway, so routing
  alerts through the server would mean losing the alert that says the server
  is down. Python callers reimplement ~40 lines against the same
  `Notification` shape
- **`DATABASE_URL` must be exported in the process that runs `obt`/`obt-api`** —
  not merely present in a `.env` the *server* reads. The regime section is
  omitted silently when it is missing, so a backtest that "lost" its regime
  buckets is usually this, not a data problem
- **Dashboard shows a proxy error** — `bun run py:api` is not running, or
  `BACKTEST_API_URL` does not match where it bound. The dashboard never talks
  to the Python service directly; everything goes through the Fastify proxy
- **Backtest returns "no cached sessions"** — wrong `--cache-dir`, or
  `BACKTEST_DATA_DIR` pointing somewhere other than the cache you built
- **Bun-only repo** — do not run `npm install` or `yarn install`. They generate a `package-lock.json` or `yarn.lock` that will conflict with `bun.lock`
