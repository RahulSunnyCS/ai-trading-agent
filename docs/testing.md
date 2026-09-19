# Testing & Verification

The single manual-verification guide. It replaces four documents that overlapped
heavily (`TEST_PLAN.md`, `MANUAL_QA_CHECKLIST.md`, `QA_VERIFICATION.md`,
`E2E_TEST_CATALOG.md`) — the same Docker and migration steps were written out
three times, in three different ways.

What runs automatically (Vitest, Jest, pytest, Playwright, and the CI jobs) is
described in `.claude/project/technical.md`. This file is for the checks a human
has to do on a real machine.

## How To Use This Document

- Each test has an ID (`T3-4`). If something fails, quote the ID — it uniquely identifies the step.
- Mark `[x]` pass, `[~]` partial (add a note), `[✗]` fail.
- Parts are ordered by dependency. Don't skip ahead: Part 5 assumes Part 2 passed.
- **Parts 1, 3 and 4 need no Docker** — you can run those on any machine today.
- Record results in the sign-off table (Part 10) as you go.

### Time budget

| Part | Needs | Rough time |
|---|---|---|
| 0 — Machine prep | — | 20–40 min (mostly downloads) |
| 1 — Baseline | — | 10 min |
| 2 — Infrastructure | Docker | 30 min |
| 3 — `obt` CLI | — | 20 min |
| 4 — FastAPI service | — | 15 min |
| 5 — Full round trip | Docker + browser | 30 min |
| 6 — Payment gate | Docker | 30 min |
| 7 — Regime bucketing | Docker | 25 min |
| 8 — Playwright E2E | Browser | 15 min |
| 9 — Nightly Routine | Real trading day | passive |

Realistically: **one focused half-day** for Parts 0–8, with Part 9 observed later.

---


## Part 0 — Machine Prep

### T0-1: Install the toolchain

| # | Tool | Install | Verify |
|---|---|---|---|
| [ ] | Docker + Compose v2 | Docker Desktop, or `docker.io` + `docker-compose-plugin` | `docker --version && docker compose version` |
| [ ] | Bun 1.3+ | `curl -fsSL https://bun.sh/install \| bash` | `bun --version` → `1.3.x` or higher |
| [ ] | Python 3.12 | system package or `uv python install 3.12` | `python3 --version` |
| [ ] | `uv` | `curl -LsSf https://astral.sh/uv/install.sh \| sh` | `uv --version` |
| [ ] | git | system package | `git --version` |

> **Do not install Node/npm/yarn for this repo.** It is Bun-only with a single `bun.lock`;
> an `npm install` will generate a competing lockfile. This is a documented gotcha in
> `.claude/project/technical.md`, and it is a real one.

### T0-2: Clone and check out the working branch

```bash
git clone https://github.com/RahulSunnyCS/ai-trading-agent.git
cd ai-trading-agent
git checkout claude/option-backtesting-monorepo-xvcz5z
git log --oneline -3
```

| # | Check | Expected |
|---|---|---|
| [ ] | On the right branch | `git branch --show-current` → `claude/option-backtesting-monorepo-xvcz5z` |
| [ ] | M-5 commit present | `git log --oneline` includes `a669920` (M-5) and `e3f7f46` (M-4) |
| [ ] | Working tree clean | `git status --short` → empty |

### T0-3: Create `.env`

```bash
cp .env.example .env
```

For **Parts 1–5** the defaults are sufficient — `SIMULATE=true`, and the DB/Redis URLs already
match `docker-compose.yml` (ports **5433** and **6380**, deliberately non-default to avoid
clashing with anything already running locally).

Leave these **unset/commented for now** — later parts turn them on deliberately:

| Variable | Turn on in | Why |
|---|---|---|
| `RAZORPAY_KEY_ID` | Part 6 | Its mere presence flips `PAYMENT_ENABLED` on |
| `DATABASE_URL` (for the Python side) | Part 7 | Gates regime bucketing |
| `FYERS_*` | Not needed | Everything here runs in `SIMULATE=true` |

| # | Check | Expected |
|---|---|---|
| [ ] | `.env` exists and is gitignored | `git status --short` still empty after creating it |
| [ ] | `RAZORPAY_KEY_ID` is commented out or empty | Part 6 depends on starting from "payments off" |

---


## Part 1 — Baseline (no Docker needed)

**Why this part exists:** to establish that the checkout is healthy before infrastructure enters
the picture. If anything here fails, nothing later is meaningful.

### T1-1: Install dependencies

```bash
bun install
cd packages/option-backtesting && uv sync --frozen && cd ../..
```

| # | Check | Expected |
|---|---|---|
| [ ] | One lockfile only | `ls bun.lock package-lock.json yarn.lock 2>/dev/null` → only `bun.lock` |
| [ ] | Bun install clean | no peer-dependency errors |
| [ ] | `uv sync --frozen` succeeds | lockfile satisfied without resolution changes |

### T1-2: Static checks

```bash
bun run typecheck                          # server only, by design
bun run --filter @ata/dashboard typecheck  # expect exactly 1 known error
bun run lint                               # expect exactly 11 known findings
cd packages/option-backtesting && uv run ruff check . && cd ../..
```

| # | Check | Expected |
|---|---|---|
| [ ] | Server typecheck clean | exit 0, no output |
| [ ] | Dashboard typecheck | **exactly one** error: `FyersAuthCard.tsx(75,12): error TS2375` (`pulse` / `exactOptionalPropertyTypes`) |
| [ ] | Biome | **exactly 11** findings, all in files listed below |
| [ ] | `ruff check` | `All checks passed!` |

> **These two "failures" are expected and pre-existing** — they predate the whole
> option-backtesting epic and are deliberately not fixed (fixing them was out of scope for a
> mechanical migration). Treat them as a baseline fingerprint: **11 Biome findings and 1 dashboard
> type error means no regression. More than that means something you did broke something.**
>
> The 11 findings live in: `EditPersonalityDialog.tsx`, `PendingSuggestionsCard.tsx`,
> `apps/server/src/index.ts`, `expiry-resolver.{ts,test.ts}`, `instrument-registry.{ts,test.ts}`,
> `scheduled-signal-emitter.ts`, `paper-trade-executor.ts`.

### T1-3: Unit tests

```bash
bun run test:unit                      # @ata/server
bun run --filter @ata/dashboard test    # @ata/dashboard
cd packages/option-backtesting && uv run pytest -q && cd ../..
```

| # | Check | Expected |
|---|---|---|
| [ ] | Server unit tests | **925 passed, 3 skipped** (51 files) |
| [ ] | Dashboard unit tests | **54 passed** (2 files) |
| [ ] | Python tests | **330 passed** |

> Counts are a floor, not a ceiling — if you've added tests since, higher is fine. What matters is
> **zero failures**.

### T1-4: The golden-fixture parity test in isolation

This is the single most important automated test in the repo: it proves the backtest engine
reproduces the original reference implementation **to the rupee** for all four strategy variants.

```bash
cd packages/option-backtesting
uv run pytest tests/golden/test_engine_golden.py -v
```

| # | Check | Expected |
|---|---|---|
| [ ] | All golden assertions pass | every test in the file green |
| [ ] | It is actually asserting real numbers | see Appendix A — A/B/C 15-day nets are 7568 / 6517 / 6003 |

**If this fails, stop.** It means the engine's arithmetic has drifted. Nothing downstream
(sweeps, walk-forward, overfitting stats) is trustworthy until it's green again.

---


## Part 2 — Infrastructure (closes the M-0 gap)

**Why this part exists:** `bun run sim` has **never** been booted against a live TimescaleDB and
Redis. In the sandbox it got as far as attempting a real DB connection and failing on
`ECONNREFUSED` — which proved the migration-path fix worked, but nothing beyond it.

### T2-1: Bring up services

```bash
docker compose up -d
docker compose ps
```

| # | Check | Expected |
|---|---|---|
| [ ] | Both containers healthy | services `postgres` and `redis` show `(healthy)` |
| [ ] | PostgreSQL 16 | `docker compose exec postgres psql -U trading -d trading -c "SELECT version();"` → `PostgreSQL 16` |
| [ ] | **TimescaleDB extension present** | `docker compose exec postgres psql -U trading -d trading -c "\dx"` lists `timescaledb` |
| [ ] | Redis 7+ | `docker compose exec redis redis-cli INFO server \| grep redis_version` → `7.x` |
| [ ] | Ports as configured | Postgres on host **5433**, Redis on host **6380** (deliberately non-default) |

> The compose file sets no `container_name`, so the actual container names are auto-generated
> (`ai-trading-agent-postgres-1` and similar). Always address them through
> `docker compose exec <service>` using the service names `postgres` / `redis`, never
> `docker exec <guessed-name>`.

> **Triage:** if migrations later fail with a hypertable/type error, the cause is almost always a
> vanilla `postgres:16-alpine` image instead of `timescale/timescaledb:latest-pg16`. TimescaleDB
> is not optional here.

### T2-2: Migrations

```bash
bun run migrate
bun run migrate   # run it twice — it must be idempotent
```

| # | Check | Expected |
|---|---|---|
| [ ] | First run applies cleanly | ends with a completion message, no errors |
| [ ] | Second run is a no-op | reports already-applied; **no duplicate-key errors** |
| [ ] | All migrations recorded | `SELECT count(*) FROM schema_migrations;` → **16** (matches files in `apps/server/src/db/migrations/`) |
| [ ] | Hypertables exist | `SELECT hypertable_name FROM timescaledb_information.hypertables;` → `market_ticks`, `straddle_snapshots`, `option_ticks` |
| [ ] | Continuous aggregate exists | `SELECT view_name FROM timescaledb_information.continuous_aggregates;` → `straddle_1min` |

### T2-3: Seed data integrity

```bash
docker compose exec postgres psql -U trading -d trading -c \
  "SELECT name, entry_type, management_style, is_frozen, is_active, phase FROM personality_configs ORDER BY name;"
```

| # | Check | Expected |
|---|---|---|
| [ ] | 10 personalities seeded | 10 rows |
| [ ] | **Clockwork is frozen** | `clockwork` row has `is_frozen = t` |
| [ ] | Three active at launch | `clockwork`, `precision`, `adjuster` have `is_active = t` |
| [ ] | Levelhead is Phase 2 gated | `levelhead` has `phase = 2`, `is_active = f` |

> The frozen-Clockwork flag is load-bearing: the evolution engine must throw `FROZEN_VIOLATION`
> rather than silently skip. If `is_frozen` is false here, months of comparative benchmark data
> would be invalidated later.

### T2-4: **Boot the server** — the headline M-0 gap

```bash
bun run sim
```

Leave it running; in a second terminal:

```bash
curl -s localhost:3000/api/meta | jq .
```

| # | Check | Expected |
|---|---|---|
| [ ] | Server boots without crashing | startup logs show DB + Redis connected, no stack trace |
| [ ] | `/api/meta` responds | HTTP 200 with JSON |
| [ ] | `authDegraded` is false | we're in simulation mode, no Fyers token involved |
| [ ] | Simulator is producing ticks | logs show tick activity within ~30s |
| [ ] | Ticks reach the database | `SELECT count(*) FROM market_ticks WHERE time > now() - interval '5 minutes';` → growing |
| [ ] | Straddle pipeline works end-to-end | `SELECT count(*) FROM straddle_snapshots WHERE time > now() - interval '5 minutes';` → **> 0** |

> That last row is the real prize. It proves the synthetic ATM CE/PE option-leg ticks added in
> Phase A flow all the way through the straddle calculator — the thing that could only be
> asserted from unit tests until now.

### T2-5: WebSocket tick stream

```bash
# any WS client; e.g. websocat, or the browser console on the dashboard
websocat ws://localhost:3000/ws/ticks
```

| # | Check | Expected |
|---|---|---|
| [ ] | Connection accepted | handshake succeeds |
| [ ] | Ticks stream in | JSON messages arrive continuously |
| [ ] | Connection cap enforced | open more than `MAX_WS_CONNECTIONS` (default 50) → further connections rejected |

### T2-6: Integration tests (Docker-dependent — never run before)

```bash
bun run test:integration
```

| # | Check | Expected |
|---|---|---|
| [ ] | Suite runs (doesn't error on connection) | tests execute rather than failing to connect |
| [ ] | All pass | zero failures |

> If this errors with connection refused rather than test failures, Docker services aren't up —
> that's the confusing failure mode called out in the project gotchas.

---


## Part 3 — `obt` CLI End-to-End (no Docker)

**Why this part exists:** these commands were verified in the sandbox against the real committed
90-day AlgoTest cache, so **the expected numbers below are exact and should reproduce bit-for-bit
on your machine.** Any deviation is a genuine finding.

All commands run from `packages/option-backtesting/`.

### T3-1: Ingest planning

```bash
uv run obt ingest plan --date 2026-09-04 --underlying NIFTY | jq 'length'
```

| # | Check | Expected |
|---|---|---|
| [ ] | Request count | **23** (1 CASH + 5 strike rules × 2 legs × 2 timeframes + 2 Greeks) |
| [ ] | Shape is right | each entry has `kind`, `data_source`, `timeframe`, `start_date`, `end_date`, `raw_key` |

### T3-2: Strategy validation (positive)

```bash
for f in strategies/*.yaml; do uv run obt validate "$f"; done
```

| # | Check | Expected |
|---|---|---|
| [ ] | All five validate | `A_flat`, `B_pyramid`, `C_pyramid_fallback`, `D_adaptive_trailing`, `or_breakout` all OK |
| [ ] | B reports its structure | `nifty_pyramid_B: 1 feature(s), 2 ladder(s), 1 exit(s)` |

### T3-3: Strategy validation (negative — the point-in-time guard)

```bash
uv run obt validate tests/unit/fixtures/bad_lagless_feature.yaml; echo "exit=$?"
```

| # | Check | Expected |
|---|---|---|
| [ ] | Rejected | `INVALID: ...` |
| [ ] | **With a line number** | `line 10: rolling_mean.lag: Field required` |
| [ ] | Non-zero exit | `exit=1` |

> This is the design's hard non-negotiable made mechanical: a cross-day aggregation feature with
> no explicit `lag` cannot be expressed at all, so today's own data can never leak into today's
> own signal.

### T3-4: Run a backtest against the real cache

```bash
uv run obt run strategies/A_flat.yaml --from 2026-08-17 --to 2026-09-04
```

| # | Check | Expected (exact) |
|---|---|---|
| [ ] | Gross | `gross INR: 14768` |
| [ ] | **Net** | `net INR: 7568` |
| [ ] | Win days | `win days: 7` |
| [ ] | Worst day | `worst day: -6577` |
| [ ] | Lot-days | `lot-days: 60.00` |
| [ ] | INR/lot-day | `INR/lot-day: 126` |
| [ ] | Both gross **and** net always shown | required by the M-3 exit criterion |
| [ ] | DTE breakdown present | buckets for DTE 0/1/4/5/6 |
| [ ] | Registry row written | `Recorded as run <id> in .../data/registry.sqlite` |

> Note `sum pkLoss` will read **-75140** here, which differs from the golden fixture's -58136.
> That is expected and correct: the golden fixture's synthetic bars have `high=low=close`, so
> intraday excursions are flat, while the real cache has genuine intraday paths. Net, win-days,
> worst-day, lot-days and INR/lot-day all match the fixture exactly — that agreement across two
> independent data sources is the strongest correctness signal in the project.

### T3-5: Margin model (M-5)

Same command as T3-4 — check the margin block that follows the DTE breakdown:

| # | Check | Expected (exact) |
|---|---|---|
| [ ] | Category | `strategy type: short-straddle` |
| [ ] | Peak lots and date | `peak lots: 4 (on 2026-08-17)` |
| [ ] | Rate | `margin/lot: 140000` |
| [ ] | Peak margin | `peak margin: 560000` |
| [ ] | Return | `return on peak margin: 1.35%` |

> Sanity: 7568 / 560000 = 1.351%. If the percentage doesn't equal net ÷ peak margin, the metric
> is wired wrong.

### T3-6: Bootstrap confidence interval

```bash
uv run obt run strategies/A_flat.yaml --from 2026-08-17 --to 2026-09-04 --bootstrap --seed 7
```

| # | Check | Expected |
|---|---|---|
| [ ] | CI block appears **separately** | after the main report, under `--- Bootstrap CI ... ---` |
| [ ] | Deterministic | re-run with the same `--seed 7` → identical interval |
| [ ] | Main report unchanged | the deterministic figures above are byte-identical with and without `--bootstrap` |

### T3-7: Registry listing

```bash
uv run obt registry --limit 5
```

| # | Check | Expected |
|---|---|---|
| [ ] | Recent runs listed | most recent first, with id / strategy / window / net |

### T3-8: Walk-forward (M-5)

```bash
uv run obt walkforward strategies/A_flat.yaml \
  --is-from 2026-06-08 --is-to 2026-08-04 \
  --oos-from 2026-08-05 --oos-to 2026-09-04
```

| # | Check | Expected (exact) |
|---|---|---|
| [ ] | **OOS is printed first** | `=== OUT-OF-SAMPLE (headline) [2026-08-05 .. 2026-09-04] ===` |
| [ ] | OOS net | `net INR: 56495` |
| [ ] | OOS INR/lot-day | `614` |
| [ ] | IS printed below, marked reference-only | `--- in-sample (reference only) [2026-06-08 .. 2026-08-04] ---` |
| [ ] | IS net | `net INR: 118796` |
| [ ] | IS INR/lot-day | `724` |

### T3-9: Walk-forward rejects invalid windows

```bash
uv run obt walkforward strategies/A_flat.yaml \
  --is-from 2026-06-08 --is-to 2026-08-04 \
  --oos-from 2026-08-04 --oos-to 2026-09-04; echo "exit=$?"
```

| # | Check | Expected |
|---|---|---|
| [ ] | Overlapping windows rejected | message contains `must start strictly after` |
| [ ] | Non-zero exit | `exit=1` |

> An overlapping "out-of-sample" window would produce a number that *looks* like validation but
> isn't. Refusing to compute it is the feature.

### T3-10: Parameter sweep (M-5)

```bash
cat > /tmp/changes.json <<'EOF'
[
  {"strategy": {"entry": {"lots": 4}, "caps": {"max_lots": 4}}},
  {"strategy": {"entry": {"lots": 3}, "caps": {"max_lots": 3}}},
  {"strategy": {"entry": {"lots": 2}, "caps": {"max_lots": 2}}},
  {"strategy": {"caps": {"max_lots": -1}}}
]
EOF

uv run obt sweep strategies/A_flat.yaml --changes /tmp/changes.json \
  --from 2026-08-17 --to 2026-09-04
```

| # | Check | Expected (exact) |
|---|---|---|
| [ ] | Header | `Sweep [2026-08-17 .. 2026-09-04]: 4 config(s), 3 succeeded` |
| [ ] | config_0 (4 lots) | `net=7568  INR/lot-day=126  win_days=7` |
| [ ] | config_1 (3 lots) | `net=5676` |
| [ ] | config_2 (2 lots) | `net=3784` |
| [ ] | Linear scaling holds | 7568 : 5676 : 3784 = 4 : 3 : 2, and INR/lot-day identical across all three |
| [ ] | **Invalid config is reported, not dropped** | `config_3: line 23: caps.max_lots: Input should be greater than 0` |
| [ ] | Config count stays honest | header says 4 even though only 3 ran |

> That last point matters more than it looks: the overfitting statistics in T3-11 are meaningless
> if the number of configurations tried is silently under-reported.

### T3-11: Overfitting guard — CSCV/PBO + Deflated Sharpe (M-5)

```bash
uv run obt sweep strategies/A_flat.yaml --changes /tmp/changes.json \
  --from 2026-06-08 --to 2026-09-04 --overfit --n-blocks 8
```

| # | Check | Expected (exact — CSCV is deterministic) |
|---|---|---|
| [ ] | Sweep nets over 90 days | config_0 `175291`, config_1 `131468`, config_2 `87645` |
| [ ] | CSCV header | `CSCV: 3 config(s), 8 block(s), 70 IS/OOS combination(s)` |
| [ ] | Combination count is C(8,4) | 70 — if it isn't, the block-splitting is wrong |
| [ ] | PBO | `47.1%` |
| [ ] | DSR best config | `config_1` |
| [ ] | Observed Sharpe | `0.243` |
| [ ] | Deflated Sharpe | `97.3%` |

> Interpretation, so the numbers mean something to you later: a PBO near 50% here is *correct and
> expected* — these three configs are pure linear scalings of one strategy, so which one "wins"
> in-sample really is a coin flip. A PBO near 50% on genuinely different strategies would be the
> warning sign.

### T3-12: Guard rejects an under-powered CSCV

```bash
uv run obt sweep strategies/A_flat.yaml --changes /tmp/changes.json \
  --from 2026-08-17 --to 2026-09-04 --overfit --n-blocks 8
```

| # | Check | Expected |
|---|---|---|
| [ ] | Refuses rather than computing junk | `(overfit analysis not computed: Need at least 16 sessions ...)` |
| [ ] | Sweep results still printed above it | the sweep itself isn't discarded |

> 15 sessions can't support 8 blocks with ≥2 sessions per IS/OOS half. Producing a PBO anyway
> would be worse than producing nothing.

### T3-13: Personality export (M-5, R3)

```bash
RUN_ID=$(uv run obt run strategies/B_pyramid.yaml --from 2026-08-17 --to 2026-09-04 \
  | grep "Recorded as run" | awk '{print $4}')
echo "run_id=$RUN_ID"
uv run obt export-personality "$RUN_ID"
```

| # | Check | Expected |
|---|---|---|
| [ ] | Valid JSON emitted | parses with `jq` |
| [ ] | `source_strategy_id` | `nifty_pyramid_B` |
| [ ] | `entryType` | `fixed_time` |
| [ ] | `managementStyle` | `roll` (B has ladders) |
| [ ] | `params` | `dsl_entry_lots: 2`, `dsl_max_lots: 4` |
| [ ] | **`roll_trigger_points` is absent** | B has 2 ladder rungs; the live model supports only one threshold |
| [ ] | `manual_review` has the ladder note | mentions `2 ladder rungs declared` |
| [ ] | `manual_review` has the risk-cap note | mentions `max_daily_trades and max_daily_loss` |
| [ ] | **Nothing was written to any database** | this command only reads |

Then the contrast case — `A_flat` has no ladders:

```bash
RUN_A=$(uv run obt run strategies/A_flat.yaml --from 2026-08-17 --to 2026-09-04 \
  | grep "Recorded as run" | awk '{print $4}')
uv run obt export-personality "$RUN_A" | jq '.managementStyle, .manual_review'
```

| # | Check | Expected |
|---|---|---|
| [ ] | `managementStyle` | `hold` |
| [ ] | Only the risk-cap note remains | no ladder/fallback notes |

### T3-14: Export fails cleanly on a pre-M-5 run

Older registry rows predate the `strategy_yaml` column and cannot be reconstructed.

```bash
# find a row with no stored YAML, if any exist in your registry
uv run python3 -c "
from pathlib import Path
from option_backtesting.engine.registry import list_runs
old=[r for r in list_runs(Path('data/registry.sqlite'), limit=200) if r.strategy_yaml is None]
print(old[0].run_id if old else 'none — skip this test')
"
```

| # | Check | Expected |
|---|---|---|
| [ ] | Clear message, not a crash | `... was recorded before strategy_yaml was tracked (pre-M-5) — re-run ...` |
| [ ] | Non-zero exit | `exit=1` |

### T3-15: Registry auto-migration on an old database

If you have a `registry.sqlite` created before M-5, simply running any `obt` command that touches
it must add the `strategy_yaml` column in place, without losing rows.

```bash
uv run python3 -c "
import sqlite3
con = sqlite3.connect('data/registry.sqlite')
print('columns:', [r[1] for r in con.execute('PRAGMA table_info(runs)')])
print('rows:', con.execute('SELECT COUNT(*) FROM runs').fetchone()[0])
"
```

| # | Check | Expected |
|---|---|---|
| [ ] | Column present after any `obt` command | `strategy_yaml` in the column list |
| [ ] | **No rows lost** | count is unchanged from before the migration |

---


## Part 4 — FastAPI Service (no Docker)

**Why this part exists:** the service was exercised via `TestClient` and once as a real uvicorn
process, but its **network binding** was never verified on a machine with a real LAN interface.

### T4-1: Boot the service

```bash
bun run py:api     # from repo root; equivalent to: cd packages/option-backtesting && uv run obt-api
```

| # | Check | Expected |
|---|---|---|
| [ ] | Starts on 127.0.0.1:8000 | uvicorn startup log |
| [ ] | Health | `curl -s localhost:8000/health` → `{"status":"ok"}` |
| [ ] | Presets | `curl -s localhost:8000/presets \| jq -r '.[].name'` → the five strategy names |
| [ ] | Coverage | `curl -s "localhost:8000/coverage?underlying=NIFTY" \| jq .` → a `15m` range covering ~2026-06-08 → 2026-09-04 |

### T4-2: **Loopback-only binding** (security)

Find your machine's LAN IP (`ip addr` / `ifconfig`), then:

```bash
curl -s --max-time 3 http://<YOUR_LAN_IP>:8000/health; echo "exit=$?"
```

| # | Check | Expected |
|---|---|---|
| [ ] | **Not reachable from the LAN** | connection refused / timeout, non-zero exit |

> The Python service has no authentication of its own by design. Its only intended caller is the
> Fastify proxy on the same host, which is where access-gating and credit consumption live. If
> this responds on a LAN address, the payment gate is trivially bypassable — treat it as a
> blocking finding.

### T4-3: Run through the API

```bash
curl -s -X POST localhost:8000/runs -H 'content-type: application/json' -d '{
  "yaml": '"$(jq -Rs . < packages/option-backtesting/strategies/A_flat.yaml)"',
  "from": "2026-08-17", "to": "2026-09-04"
}' | jq '{net_inr, gross_inr, win_days, margin, n: (.sessions|length)}'
```

| # | Check | Expected |
|---|---|---|
| [ ] | Net matches the CLI | `net_inr: 7568` |
| [ ] | Session count | 15 |
| [ ] | `margin` object populated | `strategy_type: "short-straddle"`, `peak_margin_inr: 560000` |
| [ ] | `regime_buckets` is `null` | correct while `DATABASE_URL` is unset — Part 7 turns this on |

### T4-4: Malformed input never 500s

```bash
curl -s -X POST localhost:8000/validate -H 'content-type: application/json' \
  -d '{"yaml": "{{{not yaml"}' | jq .
```

| # | Check | Expected |
|---|---|---|
| [ ] | HTTP 200, not 500 | a YAML parse error is a *validation* failure, not a server fault |
| [ ] | Body | `valid: false` with a populated `errors` array |

### T4-5: Preset path traversal is refused

```bash
curl -s -o /dev/null -w '%{http_code}\n' "localhost:8000/presets/..%2F..%2F..%2Fetc%2Fpasswd"
curl -s -o /dev/null -w '%{http_code}\n' "localhost:8000/presets/%2e%2e"
```

| # | Check | Expected |
|---|---|---|
| [ ] | Both refused | `404` (or 400) — never 200, never a file's contents |

> Preset names are allow-listed against real files on disk *before* any path is constructed, so
> an arbitrary name can't escape the directory. This test confirms that holds through URL
> encoding too.

---


## Part 5 — Full Round Trip (closes the M-4 gap)

**Why this part exists:** the Backtest dashboard tab has only ever been screenshotted with the
backend deliberately absent. The complete browser → Fastify → Python → Parquet → back path has
never executed.

**Setup — three processes, three terminals:**

```bash
# 1  docker compose up -d      (from Part 2, already running)
# 2
bun run sim
# 3
bun run py:api
# 4
bun run --filter @ata/dashboard dev     # Vite on :5173
```

### T5-1: Proxy health through Fastify

```bash
curl -s localhost:3000/api/backtest/health | jq .
curl -s localhost:3000/api/backtest/presets | jq -r '.[].name'
```

| # | Check | Expected |
|---|---|---|
| [ ] | Proxy reaches Python | same `{"status":"ok"}` as T4-1 |
| [ ] | Presets come through | five names |

### T5-2: Drive the Backtest tab

Open `http://localhost:5173`, click into **Backtest** (Research nav group).

| # | Check | Expected |
|---|---|---|
| [ ] | Tab renders without console errors | no red in devtools |
| [ ] | Preset buttons load | five buttons; clicking `A_flat` fills the YAML textarea |
| [ ] | Debounced validation fires | a green **Valid** badge appears ~500ms after the YAML loads |
| [ ] | Invalid YAML shows errors inline | delete a required line → red badge + line-numbered error list |
| [ ] | Coverage hint shows | `cached: 15m 2026-06-08→2026-09-04` (or similar) near the Run button |
| [ ] | Date pickers accept the window | from `2026-08-17`, to `2026-09-04` |
| [ ] | **Run works** | click Run → result card appears |

### T5-3: Verify the result card contents

| # | Check | Expected |
|---|---|---|
| [ ] | Net | ₹7,568 (positive tone/green) |
| [ ] | Gross | ₹14,768 |
| [ ] | Win days | `7 / 15` |
| [ ] | Worst day | ₹-6,577 |
| [ ] | Lot-days | `60.00` |
| [ ] | INR / lot-day | ₹126 |
| [ ] | **Return on peak margin card** | `1.35%` — the M-5 addition |
| [ ] | Peak-margin caption below | `Peak margin: ₹560,000 (4 lots × ₹140,000/lot on 2026-08-17, category: short-straddle)` |
| [ ] | DTE breakdown table | rows for each DTE bucket |
| [ ] | Sessions table | 15 rows |
| [ ] | Past-runs table populates | the run you just did appears |

### T5-4: Graceful degradation when Python is down

Stop the `bun run py:api` process, then click Run again.

| # | Check | Expected |
|---|---|---|
| [ ] | No white screen / crash | the tab stays usable |
| [ ] | A `StateMessage` error renders | human-readable "Run failed" message |
| [ ] | Recovery | restart `py:api`, click Run → works again without a page reload |

### T5-5: SSRF guard on `BACKTEST_API_URL`

```bash
# stop the server first
BACKTEST_API_URL=http://example.com bun run sim
```

| # | Check | Expected |
|---|---|---|
| [ ] | **Server refuses to start** | throws a descriptive error at plugin registration |
| [ ] | Error names the reason | mentions the URL must resolve to loopback/private space |
| [ ] | Loopback still fine | `BACKTEST_API_URL=http://127.0.0.1:8000 bun run sim` boots normally |

> Safe default-throw, same convention as the broker factory: a misconfiguration that would turn
> the proxy into an open relay stops the process rather than being logged and ignored.

---


## Part 6 — Payment / Credit Gate (first-ever real execution)

**Why this part exists:** `consumeCredit()` and `requireAccess` existed for milestones with
**zero callers**. The backtest route is their first production consumer, and it has only been
tested against a mocked `fetch`. This part is the first time real money-adjacent logic touches a
real database.

### T6-1: Payments disabled (baseline)

With `RAZORPAY_KEY_ID` unset/empty in `.env`, restart `bun run sim`.

```bash
curl -s -o /dev/null -w '%{http_code}\n' -X POST localhost:3000/api/backtest/runs \
  -H 'content-type: application/json' \
  -d "{\"yaml\": $(jq -Rs . < packages/option-backtesting/strategies/A_flat.yaml), \"from\": \"2026-08-17\", \"to\": \"2026-09-04\"}"
```

| # | Check | Expected |
|---|---|---|
| [ ] | Runs freely | `200` |
| [ ] | No credit rows created | `SELECT count(*) FROM credit_transactions;` unchanged |

### T6-2: Payments enabled, **no** grant → 402

Set `RAZORPAY_KEY_ID=rzp_test_dummy` in `.env`, restart `bun run sim`, then repeat the same curl.

| # | Check | Expected |
|---|---|---|
| [ ] | Refused | `402` |
| [ ] | Body | `{"error":"insufficient_credits"}` |
| [ ] | **Python was never called** | run the query below — the registry row count must be **unchanged** |

```bash
# before and after the 402, compare:
uv run python3 -c "
import sqlite3; print(sqlite3.connect('packages/option-backtesting/data/registry.sqlite').execute('SELECT COUNT(*) FROM runs').fetchone()[0])"
```

> This is the most important assertion in Part 6. Credit consumption deliberately happens
> **before** the Python call, because the Python service records the run in its registry as part
> of producing a 2xx — there is no "don't persist" to fall back on afterwards. A new registry row
> alongside a 402 would mean a user got compute without paying for it.

### T6-3: Seed a test grant and credits

The webhook path isn't exercised here — insert the grant directly. The SQL below is written
against the constraints as they exist **after** `005_payment_schema_constraints.sql`, which are
stricter than the original `003`/`004` table definitions.

```sql
-- run inside: docker compose exec postgres psql -U trading -d trading

-- NOTE: for grant_type='credits_pack', BOTH days_granted AND expires_at must be NULL
-- (chk_access_grants_days_granted_type / chk_access_grants_expires_at_type).
-- Omit both columns — do not pass 0 or a date.
INSERT INTO access_grants (razorpay_order_id, razorpay_payment_id, grant_type, status)
VALUES ('order_TEST_manual_001', 'pay_TEST_manual_001', 'credits_pack', 'active');

-- Purchase row: positive delta, feature NULL. Valid because the audit CHECK is
-- (credits_delta > 0 OR feature IS NOT NULL) — only *consumption* rows must name a feature.
INSERT INTO credit_transactions (razorpay_order_id, credits_delta, feature)
VALUES ('order_TEST_manual_001', 3, NULL);

SELECT * FROM credit_balance;   -- expect 3
```

| # | Check | Expected |
|---|---|---|
| [ ] | Both inserts succeed | no CHECK-constraint violation |
| [ ] | Balance | `credit_balance` → **3** |
| [ ] | `status` is one `consumeCredit` accepts | it queries `status IN ('paid','active')` — `'pending'` would silently yield 402 |

**Constraint cheat-sheet** (why an insert might be rejected):

| Constraint | Rule |
|---|---|
| `grant_type` | ∈ `monthly_pass`, `credits_pack` |
| `status` | ∈ `pending`, `paid`, `active`, `expired` |
| `chk_access_grants_days_granted_type` | `monthly_pass` → `days_granted` NOT NULL and > 0; `credits_pack` → `days_granted` **NULL** |
| `chk_access_grants_expires_at_type` | `monthly_pass` → `expires_at` NOT NULL; `credits_pack` → `expires_at` **NULL** |
| `chk_credit_transactions_feature_required` | `credits_delta > 0 OR feature IS NOT NULL` |

### T6-3b: The audit constraint actually bites (optional, 30 seconds)

```sql
-- must FAIL: a consumption row with no feature named
INSERT INTO credit_transactions (razorpay_order_id, credits_delta, feature)
VALUES ('order_TEST_manual_001', -1, NULL);
```

| # | Check | Expected |
|---|---|---|
| [ ] | Rejected | `violates check constraint "chk_credit_transactions_feature_required"` |

> This guarantees the ledger can always answer "what was this credit spent on?" — an untraceable
> debit can't be written even by hand.

### T6-4: A paid run consumes exactly one credit

Repeat the T6-1 curl (payments still enabled).

| # | Check | Expected |
|---|---|---|
| [ ] | Run succeeds | `200` with the usual result body |
| [ ] | A consumption row appears | `SELECT credits_delta, feature FROM credit_transactions ORDER BY created_at DESC LIMIT 1;` → `-1`, `backtest_run` |
| [ ] | Balance decremented | `SELECT * FROM credit_balance;` → **2** |
| [ ] | Exactly one credit per run | not 0, not 2 |

### T6-5: Exhaustion returns to 402

Run twice more (balance 2 → 1 → 0), then once more.

| # | Check | Expected |
|---|---|---|
| [ ] | Balance reaches 0 | after three successful runs total |
| [ ] | Fourth run refused | `402` again |
| [ ] | Balance never goes negative | `SELECT * FROM credit_balance;` → `0` |
| [ ] | No orphan registry row from the refused run | registry count unchanged across the 402 |

### T6-6: Free routes stay free

With payments enabled and **zero** credits:

| # | Check | Expected |
|---|---|---|
| [ ] | `GET /api/backtest/health` | 200 |
| [ ] | `GET /api/backtest/presets` | 200 |
| [ ] | `GET /api/backtest/coverage?underlying=NIFTY` | 200 |
| [ ] | `POST /api/backtest/validate` | 200 |
| [ ] | Only `POST /runs` is gated | the metered operation is the expensive one |

### T6-7: Cleanup

```sql
DELETE FROM credit_transactions WHERE razorpay_order_id = 'order_TEST_manual_001';
DELETE FROM access_grants      WHERE razorpay_order_id = 'order_TEST_manual_001';
```

| # | Check | Expected |
|---|---|---|
| [ ] | Test data removed | `credit_balance` back to its pre-test value |

---


## Part 7 — Regime Bucketing Against Real Postgres (closes the M-5 gap)

**Why this part exists:** the regime data source has only ever been tested against a **fake
`psycopg` module** injected into `sys.modules`. It has never opened a real connection, and the
lag-1 semantics have never been proven against real rows.

### T7-1: Baseline — gracefully absent

With `DATABASE_URL` **unset in the shell** running `obt`:

```bash
cd packages/option-backtesting
unset DATABASE_URL
uv run obt run strategies/A_flat.yaml --from 2026-08-17 --to 2026-09-04 | tail -20
```

| # | Check | Expected |
|---|---|---|
| [ ] | **No regime section at all** | no "Regime breakdown" heading |
| [ ] | No error, no warning, no empty table | silent omission is the contract |
| [ ] | Everything else unchanged | net still 7568 |

### T7-2: Install the optional dependency

```bash
uv sync --extra regime
uv run python3 -c "import psycopg; print(psycopg.__version__)"
```

| # | Check | Expected |
|---|---|---|
| [ ] | `psycopg` importable | version prints (3.2+) |
| [ ] | It was genuinely optional before | T7-1 passed *without* it installed |

### T7-3: Seed regime tags

Values must satisfy the CHECK in `008_regime_tagging.sql`
(`RANGING`, `TRENDING_STRONG`, `VOLATILE_REVERTING`, `EVENT_DAY`, `UNCLASSIFIED`) and the
`UNIQUE (trade_date, symbol)` constraint.

```sql
-- docker compose exec postgres psql -U trading -d trading

INSERT INTO daily_regime_tags (trade_date, symbol, regime, regime_confidence) VALUES
  ('2026-08-14', 'NIFTY', 'RANGING',            0.8100),
  ('2026-08-17', 'NIFTY', 'TRENDING_STRONG',    0.7400),
  ('2026-08-18', 'NIFTY', 'RANGING',            0.6900),
  ('2026-08-19', 'NIFTY', 'VOLATILE_REVERTING', 0.7700),
  ('2026-08-20', 'NIFTY', 'EVENT_DAY',          0.9200)
ON CONFLICT (trade_date, symbol) DO NOTHING;
```

| # | Check | Expected |
|---|---|---|
| [ ] | Rows insert | 5 rows |
| [ ] | Confidence in range | CHECK requires 0 ≤ confidence ≤ 1 |

### T7-4: **The lag-1 proof** — the point-in-time guarantee

This is the test worth doing carefully. Run a two-session window and check which bucket each
session lands in.

```bash
export DATABASE_URL=postgresql://trading:trading@localhost:5433/trading
uv run obt run strategies/A_flat.yaml --from 2026-08-18 --to 2026-08-19 | tail -12
```

Given the seed above, the correct bucketing is:

| Session | Its own tag | **Bucketed under (lag-1)** | Why |
|---|---|---|---|
| 2026-08-18 | RANGING | **TRENDING_STRONG** (from 08-17) | the most recent tag *strictly before* the session |
| 2026-08-19 | VOLATILE_REVERTING | **RANGING** (from 08-18) | same rule |

| # | Check | Expected |
|---|---|---|
| [ ] | Section appears | `Regime breakdown (lag-1):` |
| [ ] | **08-18's P&L is under TRENDING_STRONG, not RANGING** | if it lands under its own day's tag, lag-1 is broken |
| [ ] | **08-19's P&L is under RANGING, not VOLATILE_REVERTING** | same |
| [ ] | Bucket sum equals total net | the two buckets add to the window's net |

> Why this matters: a regime tag for day D is computed *after* D closes. Bucketing D's result
> under D's own tag would be look-ahead bias — the analysis would quietly know something the
> strategy couldn't have known. This test is the only place that guarantee is checked against
> real data.

### T7-5: Full-window bucketing

```bash
uv run obt run strategies/A_flat.yaml --from 2026-08-17 --to 2026-09-04 | tail -12
```

| # | Check | Expected |
|---|---|---|
| [ ] | Buckets appear for tagged days | using each session's lag-1 tag |
| [ ] | Sessions with no prior tag are skipped | 2026-08-17 has 08-14 before it → included; a session with no earlier tag at all contributes to no bucket |
| [ ] | No fabricated `UNCLASSIFIED` bucket | missing data is omitted, never defaulted |

### T7-6: Regime data through the API and dashboard

Restart `bun run py:api` **with `DATABASE_URL` exported in its environment**, then re-run T4-3.

| # | Check | Expected |
|---|---|---|
| [ ] | `regime_buckets` is no longer null | an object keyed by regime name |
| [ ] | Dashboard shows the table | "Regime breakdown (lag-1)" table appears in the result card |
| [ ] | Unset `DATABASE_URL` → table disappears | restart without it; the tab renders fine, just without that section |

### T7-7: Connection failure surfaces, not swallowed

```bash
DATABASE_URL=postgresql://trading:trading@localhost:9999/nope \
  uv run obt run strategies/A_flat.yaml --from 2026-08-17 --to 2026-09-04
```

| # | Check | Expected |
|---|---|---|
| [ ] | A real connection error is raised | not silently treated as "no regime data" |

> The distinction is deliberate: *no `DATABASE_URL`* means "this feature isn't configured" and is
> silent; *a configured DB that won't answer* is a genuine fault and must be loud.

---


## Part 8 — Playwright E2E

### How to Run

```bash
# Start the Vite dev server first (required for all UI tests)
SIMULATE=true bun run dev &   # Fastify on :3000
# In another terminal: bun run vite (if you've separated front + back)

# Run all E2E tests
bun run test:e2e

# Run a single spec file
npx playwright test e2e/live-view.spec.ts

# Run only critical tests
npx playwright test --grep @critical

# Run with headed browser (shows the browser window)
npx playwright test --headed

# Debug a single test
npx playwright test --debug e2e/navigation.spec.ts
```


### Test Tag Definitions

| Tag | Meaning | Gate impact |
|-----|---------|-------------|
| `@critical` | Blocking — a failing critical test blocks Gate 2 | Must be green before merge |
| `@functional` | CONDITIONAL PASS — failures surface as named conditions at Gate 2 | Should be green; noted if not |
| `@non-blocker` | Informational — logged but does not block the gate | Track but do not block |

---


### File 1 — `e2e/live-view.spec.ts`

**Purpose:** Verify the Live dashboard tab renders correctly, handles the WebSocket connection lifecycle, and correctly distinguishes synthetic tick data from real straddle data.

All HTTP calls to `/api/straddle/latest` are mocked. WebSocket behaviour is tested by observing what happens when no WS server is reachable (connection transitions to Disconnected).

**Test count:** 7

| # | Test name | Tag | What it verifies |
|---|-----------|-----|-----------------|
| 1 | The tick chart area labels the feed as synthetic/dev — not real straddle data | `@critical` | Confirms the NIFTY heading is present, the straddle section shows "not yet connected", and forbidden phrases ("live straddle", "real price") do not appear in the page body |
| 2 | When /api/straddle/latest returns `{ data: null }` the UI shows a graceful "not yet connected" notice | `@critical` | Stubs the straddle endpoint with `null`; asserts the "Straddle feed not yet connected" text is visible and no large decimal-formatted number appears in the straddle card |
| 3 | LiveView shows a connection-status pill in Connecting state when no WS server is reachable | `@critical` | Locates the `[role="status"]` pill with `aria-label^="WebSocket status"` and asserts it shows a valid state string (Connecting / Connected / Disconnected) |
| 4 | Connection pill transitions to Disconnected or reconnecting state when the WebSocket cannot connect | `@critical` | Polls the pill's `aria-label` for up to 8 seconds until it shows "disconnected" or "connected" (i.e. the Connecting initial state resolves) |
| 5 | Switching away from LiveView to another tab does not leave stale console errors | `@critical` | Listens to `console error` and `pageerror` events; navigates to Trades tab (unmounting LiveView) and asserts no React "state update on unmounted component" warnings fire |
| 6 | Switching away from LiveView and back does not crash or show visual corruption | `@non-blocker` | Round-trips Live → Trades → Live; asserts NIFTY heading and straddle notice are both present after remount, with no JS errors |
| 7 | Connection status pill has an accessible aria-label with the current status | `@non-blocker` | Asserts the pill exists and its `aria-label` is longer than 10 characters (is descriptive, not empty) |

---


### File 2 — `e2e/navigation.spec.ts`

**Purpose:** Verify the app shell and tab-switching behaviour. Confirms that each tab renders the correct view, the payment test-mode banner persists across tabs, error states surface when the backend is unreachable, and tab buttons are keyboard-accessible.

All API routes are mocked. The "backend unreachable" test aborts all `/api/**` requests.

**Test count:** 4

| # | Test name | Tag | What it verifies |
|---|-----------|-----|-----------------|
| 1 | Switching between Live / Trades / P&L / Pricing tabs renders the right view | `@functional` | Clicks each of the four tabs and asserts the expected heading appears and the previous heading disappears: Live→ "NIFTY Index", Trades→ "Paper Trades", P&L→ "P&L Summary", then back to Live |
| 2 | All three wired tabs show an error or unavailable state when the backend is completely unreachable | `@functional` | Aborts all `/api/**` requests to simulate offline backend; visits Live (WS pill must appear), Trades (error alert must appear), and P&L (error alert must appear) — no white screen, no JS exceptions |
| 3 | PaymentTestModeBanner remains visible on all four tabs | `@non-blocker` | Cycles through all four tabs and confirms the `<header>` element is visible after each tab switch (the payment test-mode banner lives in the header) |
| 4 | Tab buttons are keyboard-focusable and activatable via Enter | `@non-blocker` | Focuses the "Live" button, presses Tab to move focus to "Trades", presses Enter, and asserts the "Paper Trades" heading becomes visible |

---


### File 3 — `e2e/personalities-api.spec.ts`

**Purpose:** Test the personality CRUD REST API (`/personalities`) at the HTTP level using Playwright's `APIRequestContext`. No browser window is opened — these are pure API tests. Requires a running Fastify server on `http://localhost:3000` with a migrated database.

Personality IDs are fetched dynamically from `GET /personalities` rather than hardcoded, so the tests are not brittle to UUID changes.

**Test count:** 7

| # | Test name | Tag | What it verifies |
|---|-----------|-----|-----------------|
| 1 | GET /personalities returns a list of personalities | `@critical` | Status 200, response body is a non-empty JSON array |
| 2 | GET /personalities returns 9 active personalities by default (Levelhead excluded) | `@functional` | Array length is exactly 9, all items have `isActive:true`, Levelhead is absent |
| 3 | GET /personalities?include_inactive=true returns 10 personalities | `@functional` | With the flag, all 10 seed rows are returned (including Levelhead with `is_active=FALSE`) |
| 4 | GET /personalities/:id returns 404 for unknown UUID | `@non-blocker` | A well-formed but non-existent UUID (`00000000-0000-...`) returns 404 with `{"error":"NOT_FOUND"}` |
| 5 | PUT /personalities/:id returns 403 FROZEN_VIOLATION when target is Clockwork | `@critical` | Fetches the frozen personality ID dynamically; PUT to that ID returns 403 with `error:"FROZEN_VIOLATION"` and a message matching `/immutable/i` |
| 6 | PUT /personalities/:id returns 409 COMPARISON_INTEGRITY_VIOLATION when min_probability drift > 8pp | `@critical` | Reads current `min_probability` for all momentum_exhaustion personalities, computes a violating value (+9pp from the minimum), PUTs it, and asserts 409 with `error:"COMPARISON_INTEGRITY_VIOLATION"` |
| 7 | PUT /personalities/:id validates param ranges and returns 400 for out-of-range values | `@functional` | Tests two cases: `min_probability:0.95` (above 0.90 ceiling) and `min_probability:0.30` (below 0.40 floor) — both must return 400 |
| 8 | PUT /personalities/:id writes audit log entry on successful change | `@functional` | Makes a valid +0.01 change, asserts 200 with updated params, then restores the original value — confirms the happy-path HTTP contract (DB-level audit log is verified in integration tests) |
| 9 | GET /personalities/:id/performance excludes pre-M2 NULL personality_id rows | `@critical` | Fetches performance for an active personality; asserts `personalityId` matches, `winRate` ∈ [0,1], `totalTrades` ≥ 0 — proves the `WHERE personality_id = $1` query does not leak NULL rows |
| 10 | GET /personalities/:id/performance returns personality-scoped stats only | `@critical` | Fetches performance for two different personality IDs in parallel; asserts each response's `personalityId` matches the requested ID |

---


### File 4 — `e2e/pnl-view.spec.ts`

**Purpose:** Verify the P&L dashboard tab computes and displays financial figures correctly. All critical arithmetic invariants are tested: correct decimal summation, exclusion of open trades from totals, win-rate denominator, IST date boundaries, and correct error/empty states.

All `/api/trades` responses are mocked via `page.route()`. Trade payloads are constructed using the `makeTrade()` factory with field overrides.

**Test count:** 8

| # | Test name | Tag | What it verifies |
|---|-----------|-----|-----------------|
| 1 | Total net P&L is the correct arithmetic sum — not string concatenation | `@critical` | Feeds 3 trades (100.00, 200.50, −50.25); asserts the Realized P&L card shows `250.25`, not string concatenation (`"100.00200.50"`) or NaN |
| 2 | Open trades with null net_pnl are excluded from the total P&L sum | `@critical` | 1 closed trade (300.00) + 1 open trade (null); asserts total is 300.00 and no NaN appears |
| 3 | When /api/trades returns HTTP 500 PnlView shows an error notice, not a zeroed-out P&L dashboard | `@critical` | Stubs `/api/trades` with 500; asserts `role="alert"` appears with error text, and the Realized P&L stat card is **not** visible (zeroed data looks like a quiet day — very misleading) |
| 4 | Today's P&L uses IST date boundaries | `@critical` | Uses a trade with `exit_time` at midnight IST on "today"; asserts the value `500.00` appears and no NaN is present — confirms the IST `+05:30` offset logic |
| 5 | Win rate is computed as closed-wins / total-closed — open trades excluded from denominator | `@functional` | 2 winning + 1 losing closed trades + 2 open trades; asserts win rate shows `66.7%` (2/3), not `40.0%` (2/5) |
| 6 | Cumulative P&L chart renders without crash when there are only open trades | `@functional` | Single open trade; asserts "No closed trades yet" text visible, cumulative chart is not rendered, no JS errors |
| 7 | When /api/trades returns an empty array PnlView shows a no-closed-trades empty state | `@functional` | Empty array; asserts "No closed trades yet" visible, Realized P&L card not visible |
| 8 | Open and closed position counts are displayed separately and accurately | `@functional` | 3 open + 5 closed trades; asserts "Closed Trades" card shows `5` and "Open Positions" card shows `3` |
| 9 | Total net P&L is colored green for positive values and red for negative | `@non-blocker` | Positive total: asserts a `p.text-green-400` element is visible |

---


### File 5 — `e2e/trades-view.spec.ts`

**Purpose:** Verify the Trades dashboard tab renders paper trades correctly — including correct parsing of NUMERIC string fields from the API, color-coded P&L, IST timestamps, status badges, and appropriate error/empty states.

All `/api/trades` responses are mocked. Trades are built with the `makeTrade()` factory.

**Test count:** 9

| # | Test name | Tag | What it verifies |
|---|-----------|-----|-----------------|
| 1 | NUMERIC string fields render as formatted numbers, not raw strings | `@critical` | Trade with `net_pnl:"-45.00"` and `straddle_at_entry:"22456.75"` — asserts numbers are formatted (not raw JSON strings with quotes), digits `45` and `22...456` visible in the row |
| 2 | Negative net_pnl is colored red and positive net_pnl is colored green | `@critical` | 1 negative and 1 positive trade; asserts `span.text-red-400` contains the negative value and `span.text-green-400` contains the positive value |
| 3 | Open trades with null net_pnl show an em dash placeholder — never NaN or undefined | `@critical` | Open trade with `net_pnl:null`; asserts `span.text-gray-500` with `—` is visible, page body contains neither `NaN` nor `undefined` |
| 4 | When /api/trades returns an empty array TradesView shows a "No trades yet" empty state | `@critical` | Empty array; asserts "No paper trades yet" text visible, no table rows present (table is not rendered in empty state) |
| 5 | When /api/trades returns HTTP 500 TradesView shows an error notice and does not crash | `@critical` | 500 stub; asserts `role="alert"` appears, alert text matches `/couldn\|load\|error\|fail/`, no JS exceptions |
| 6 | Entry times are displayed in IST — 04:00 UTC renders as 09:30 IST | `@functional` | Trade with `entry_time:"2026-05-23T04:00:00.000Z"` (= 09:30 IST); asserts row text contains `09:30` and does not contain `04:00` |
| 7 | Status badges render for open and closed trade status values | `@functional` | 1 open + 1 closed trade; asserts both "Open" and "Closed" badge texts visible, no "undefined" in page |
| 8 | When /api/trades returns HTTP 404 TradesView shows an error notice rather than an empty table | `@functional` | 404 stub; asserts `role="alert"` visible, "No paper trades yet" is NOT shown (404 is not the same as no data) |
| 9 | Exit reason is shown for closed trades and a dash for open trades | `@non-blocker` | Closed trade with `exit_reason:"stop_loss"` + open trade; asserts `stop_loss` text in page body |
| 10 | Straddle-at-entry column shows a formatted decimal number, not scientific notation | `@non-blocker` | `straddle_at_entry:"22456.75"`; asserts no `e+4` notation in page body, and `22456` digits are present |

---


### Coverage Summary

| Spec file | Tests | @critical | @functional | @non-blocker |
|-----------|-------|-----------|-------------|--------------|
| live-view.spec.ts | 7 | 4 | 0 | 3 |
| navigation.spec.ts | 4 | 0 | 2 | 2 |
| personalities-api.spec.ts | 10 | 6 | 4 | 1 |
| pnl-view.spec.ts | 9 | 4 | 4 | 1 |
| trades-view.spec.ts | 10 | 5 | 4 | 2 |
| **Total** | **40** | **19** | **14** | **9** |

---


### What Is Not Covered by E2E Tests

These scenarios are covered in unit or integration tests instead:

| Scenario | Covered in |
|----------|-----------|
| DB-level audit log row exists after PUT | `apps/server/src/test/integration/personalities-api.integration.test.ts` |
| TimescaleDB hypertable migration idempotency | `apps/server/src/test/integration/migrations.integration.test.ts` |
| Peak detection algorithm correctness | `apps/server/src/signals/__tests__/peak-detection-engine.test.ts` |
| Replay determinism (100× identical-ledger gate) | `apps/server/src/ingestion/historical/__tests__/replay-determinism.test.ts` |
| Clockwork evolution guard (`is_frozen` check) | `apps/server/src/trading/__tests__/entry-engine.test.ts` |
| Razorpay webhook HMAC verification | `apps/server/src/payment/__tests__/razorpay.test.ts` |
| ATM strike rounding (property tests) | `apps/server/src/utils/__tests__/atm-strike.property.test.ts` |
| P&L arithmetic sign convention | `apps/server/src/utils/__tests__/pnl.property.test.ts` |

## Part 9 — Nightly Ingest Routine (observed, not forced)

**Why this part exists:** the Routine is registered and enabled, but its first real firing
correctly **stopped** — AlgoTest had no data for the sandbox's simulated date. Its happy path is
still unproven.

### T9-1: Confirm registration

Ask Claude in a session on this repo, or check the Routines UI on claude.ai.

| # | Check | Expected |
|---|---|---|
| [ ] | Routine exists and is enabled | name: `option-backtesting nightly NIFTY ingest` |
| [ ] | Schedule | cron `30 12 * * 1-5` UTC = 18:00 IST, weekdays |
| [ ] | `next_run_at` is in the future | a coming weekday evening |

### T9-2: Happy path (on a real trading day evening)

| # | Check | Expected |
|---|---|---|
| [ ] | 23 raw files written for the day | `find packages/option-backtesting/data/raw/algotest/NIFTY -name "*<DATE>*" \| wc -l` → 23 |
| [ ] | Ingest ran | new Parquet under `data/cache/` |
| [ ] | Commit landed | `git log --oneline -1` → `chore(option-backtesting): nightly ingest <date> NIFTY` |
| [ ] | Push succeeded | remote branch advanced |
| [ ] | The day is backtestable | `obt run strategies/A_flat.yaml --from <date> --to <date>` produces a session |

### T9-3: Negative paths

| # | Check | Expected |
|---|---|---|
| [ ] | On a market holiday (weekday) | Routine reports "not a trading day — nothing to ingest"; **no commit** |
| [ ] | If any AlgoTest request fails | reports which one; **no partial raw files, no commit** |
| [ ] | Re-running an already-ingested day | idempotent; doesn't duplicate or corrupt |

> The all-or-nothing rule is the point: a half-ingested day committed to the repo would silently
> corrupt every backtest that touches it afterwards.

---


## Part 10 — Sign-Off

| Part | Result | Notes / failing test IDs |
|---|---|---|
| 0 — Machine prep | ☐ pass ☐ fail | |
| 1 — Baseline | ☐ pass ☐ fail | |
| 2 — Infrastructure (M-0 gap) | ☐ pass ☐ fail | |
| 3 — `obt` CLI | ☐ pass ☐ fail | |
| 4 — FastAPI service | ☐ pass ☐ fail | |
| 5 — Full round trip (M-4 gap) | ☐ pass ☐ fail | |
| 6 — Payment / credit gate | ☐ pass ☐ fail | |
| 7 — Regime bucketing (M-5 gap) | ☐ pass ☐ fail | |
| 8 — Playwright E2E | ☐ pass ☐ fail | |
| 9 — Nightly Routine | ☐ pass ☐ fail ☐ pending | |

### Triage quick-reference

| Symptom | First thing to check |
|---|---|
| Migration fails on a hypertable/type error | You're on `postgres:16-alpine`, not `timescale/timescaledb:latest-pg16` |
| `test:integration` fails with connection refused | Docker services aren't up — this is a setup error, not a test failure |
| Backtest returns "no cached sessions" | Wrong `--cache-dir`, or `BACKTEST_DATA_DIR` pointing elsewhere |
| Unexpected 402 | `RAZORPAY_KEY_ID` is set (its presence alone enables payments) |
| Unexpected 200 where you wanted 402 | `RAZORPAY_KEY_ID` empty/unset |
| No regime section when you expect one | `DATABASE_URL` not exported **in the process running `obt`/`obt-api`** |
| Dashboard shows a proxy error | `bun run py:api` not running, or `BACKTEST_API_URL` mismatch |
| Server won't start after env change | SSRF guard rejecting a non-loopback `BACKTEST_API_URL` — that's it working |
| Numbers differ from Appendix A | Cache changed (new ingested days shift multi-day windows). Single-day and fixed-window figures should not move |

---


## Appendix A — Expected Values Reference

Every falsifiable number in one place. **Golden-fixture** figures are asserted by the automated
test; **real-cache** figures were observed during development against the committed 90-day
AlgoTest backfill.

### Golden fixture — 15 sessions, 2026-08-17 → 2026-09-04 (synthetic)

| Metric | A_flat | B_pyramid | C_fallback |
|---|---|---|---|
| net INR | 7568 | 6517 | 6003 |
| win days | 7 | 10 | 9 |
| worst day | -6577 | -5314 | -6740 |
| sum pkLoss | -58136 | -41913 | -46390 |
| lot-days | 60 | 39 | 44 |
| INR/lot-day | 126 | 169 | 138 |

**Variant D** (10 tradeable days — first 5 sessions are calibration-only):
net `-2064`, lot-days `22.42`, INR/lot-day `-92`, win-days `4`, sum-peak-loss `-28743`.

**Recomputed 10-day sub-window** (all four): A `-6854`, B `-2142`, C `-1398`, D `-2064`.

### Real cache — A_flat, 2026-08-17 → 2026-09-04

| Metric | Value | Matches fixture? |
|---|---|---|
| gross INR | 14768 | — |
| net INR | **7568** | ✅ identical |
| win days | 7 | ✅ |
| worst day | -6577 | ✅ |
| lot-days | 60.00 | ✅ |
| INR/lot-day | 126 | ✅ |
| sum pkLoss | -75140 | ❌ expected difference (real intraday paths vs flat synthetic bars) |
| worst intraday mtm | -24167 | — |

**B_pyramid, same window:** net `6517` — also identical to the fixture.

### Margin (A_flat, same window)

`short-straddle` · peak 4 lots on 2026-08-17 · ₹140,000/lot · ₹560,000 peak margin · **1.35%**

### Walk-forward (A_flat)

| Window | net | win days | lot-days | INR/lot-day |
|---|---|---|---|---|
| OOS 2026-08-05 → 09-04 | 56495 | 13 | 92.00 | 614 |
| IS 2026-06-08 → 08-04 | 118796 | 33 | 164.00 | 724 |

### Sweep + overfit (A_flat, 4 configs)

| Window | config_0 | config_1 | config_2 | config_3 |
|---|---|---|---|---|
| 2026-08-17 → 09-04 | 7568 | 5676 | 3784 | invalid (reported) |
| 2026-06-08 → 09-04 | 175291 | 131468 | 87645 | invalid (reported) |

CSCV over the 90-day window, `--n-blocks 8`: **70 combinations**, **PBO 47.1%**.
DSR: best `config_1`, observed Sharpe `0.243`, deflated **97.3%**.

### Test-suite fingerprints

| Suite | Expected |
|---|---|
| Python (`uv run pytest`) | 330 passed |
| TS server (`bun run test:unit`) | 925 passed, 3 skipped |
| Dashboard (`--filter @ata/dashboard test`) | 54 passed |
| Biome (`bun run lint`) | 11 pre-existing findings |
| Dashboard typecheck | 1 pre-existing error (`FyersAuthCard.tsx`) |
| Server typecheck | clean |
| `ruff check` | clean |

---


## Appendix B — Reset & Teardown

```bash
# Stop services, keep data
docker compose down

# Stop services and destroy all data volumes (full clean slate)
docker compose down -v

# Reset the derived Python artifacts (raw JSON is the source of truth and is tracked —
# never delete data/raw/)
rm -rf packages/option-backtesting/data/cache/
rm -f  packages/option-backtesting/data/registry.sqlite

# Rebuild the cache from the committed raw files
cd packages/option-backtesting
uv run obt ingest --date 2026-09-04 --underlying NIFTY   # repeat per date, or script the range
```

| # | Check | Expected |
|---|---|---|
| [ ] | `data/raw/algotest/` still intact | it is tracked in git and is the reproducibility anchor |
| [ ] | Cache rebuilds from raw | backtests reproduce the same numbers as Appendix A |

> `data/cache/` and `data/registry.sqlite` are gitignored derived artifacts — safe to delete and
> regenerate. `data/raw/algotest/` is **tracked and irreplaceable**: AlgoTest only serves a
> rolling 3-month window, so anything older than that exists nowhere else. Never delete it.


---

# Trading engine — milestone verification


These predate the Parts above and cover the TypeScript trading engine, which the
main plan does not touch. Run them when changing signals, personalities or the
historical pipeline.

## M1 — Live Paper-Trading + Dashboard

### M1-1: All 10 Personalities Seeded

```bash
curl http://localhost:3000/personalities?include_inactive=true | jq 'length'
curl http://localhost:3000/personalities | jq 'length'
```

| # | Check | Expected |
|---|-------|----------|
| [ ] | 10 total personalities | `include_inactive=true` → 10 |
| [ ] | 9 active personalities | Default (no flag) → 9 |
| [ ] | Levelhead is inactive | `jq '.[] \| select(.name=="Levelhead") \| .isActive'` → `false` |
| [ ] | Clockwork is frozen | `jq '.[] \| select(.name=="Clockwork") \| .isFrozen'` → `true` |

### M1-2: Entry Engine

Start in simulation mode and check the logs:

```bash
SIMULATE=true bun run dev
```

| # | Check | Expected |
|---|-------|----------|
| [ ] | No entries before 09:15 IST | Entries logged only after `09:15` appears in the timestamp |
| [ ] | No entries after 09:45 IST | After 09:45 in logs, no new `[entry]` lines |
| [ ] | VIX gate respected | If VIX > 30 in sim (force it via env), entries are blocked |
| [ ] | One-open limit enforced | If a trade is open, a second entry is not taken by the same personality |

### M1-3: Trigger/Exit Engine

With an open paper trade, verify exits work:

| # | Check | Trigger condition |
|---|-------|------------------|
| [ ] | Hard stop-loss exits at 30% loss | Straddle value ≥ entry × 1.30 |
| [ ] | Trailing stop-loss activates | After straddle drops 15% from peak, then reverses 15% — exit triggered |
| [ ] | Target profit exit at 30% gain | Straddle value ≤ entry × 0.70 |
| [ ] | EOD square-off at 15:25 IST | Any open trade closes at 15:25 regardless of P&L |

```bash
# Check closed trades after running through a simulated session
curl http://localhost:3000/trades | jq '.data | map(select(.status=="closed")) | length'
```

Expected: > 0 trades with `exit_reason` set to one of: `stop_loss`, `target`, `eod_squareoff`, `trailing_stop`.

### M1-4: Paper Trade API

```bash
# Get all trades
curl http://localhost:3000/trades | jq '.data[0]'
```

| # | Check | Expected |
|---|-------|----------|
| [ ] | GET /trades returns array | Status 200, `data` is an array |
| [ ] | Each trade has required fields | `id`, `entry_time`, `status`, `straddle_at_entry`, `lots`, `lot_size` present |
| [ ] | Closed trades have `net_pnl` | `exit_time` and `net_pnl` non-null for closed trades |
| [ ] | `exit_reason` is meaningful | One of: `stop_loss`, `target`, `eod_squareoff`, `trailing_stop` |

### M1-5: REST API & WebSocket

```bash
# REST health
curl http://localhost:3000/health

# WebSocket (requires wscat: npm install -g wscat)
wscat -c ws://localhost:3000/ws/ticks
```

| # | Check | Expected |
|---|-------|----------|
| [ ] | GET /health returns 200 | `{"status":"ok"}` or similar |
| [ ] | WebSocket connects | `wscat` shows `Connected` |
| [ ] | Tick messages arrive on WS | JSON messages with `ltp`, `symbol`, `timestamp` every ~1s |
| [ ] | WS disconnects cleanly | Ctrl+C in wscat → no server error |

### M1-6: React Dashboard — Live Tab

```bash
# Start Vite frontend separately
cd ai-trading-agent
bun run dev &   # starts Fastify on 3000 (sim mode)
# Open http://localhost:5173 in browser
```

| # | Check | Expected in Browser |
|---|-------|---------------------|
| [ ] | App loads without white screen | Dashboard renders with tab bar |
| [ ] | Default tab is "Live" | Live tab content visible on load |
| [ ] | NIFTY LTP ticks update | Number in "NIFTY Index" card increments/changes over time |
| [ ] | WS status pill is visible | Pill reads "Connected" (green) or "Connecting" / "Disconnected" |
| [ ] | Straddle section shows value or notice | Either a numeric value or "Straddle feed not yet connected" |
| [ ] | Tick chart renders | Chart area draws lines as ticks arrive |

### M1-7: React Dashboard — Trades Tab

| # | Check | Expected in Browser |
|---|-------|---------------------|
| [ ] | Click "Trades" tab | Table heading "Paper Trades" visible |
| [ ] | Rows appear as trades are taken | Each sim trade appears in the table |
| [ ] | Open badge is green/yellow | Colored "Open" badge per row |
| [ ] | Closed badge renders correctly | "Closed" badge with exit reason |
| [ ] | IST timestamps displayed | Entry time shows e.g. `09:30:00` (not UTC `04:00:00`) |
| [ ] | Net P&L colored correctly | Positive = green, negative = red |
| [ ] | Null P&L shows `—` | Open trades show dash, not NaN |

### M1-8: React Dashboard — P&L Tab

| # | Check | Expected in Browser |
|---|-------|---------------------|
| [ ] | Click "P&L" tab | "P&L Summary" heading visible |
| [ ] | Realized P&L is the correct sum | Check against DB: `SELECT SUM(net_pnl::numeric) FROM paper_trades WHERE status='closed';` |
| [ ] | Win rate excludes open trades | Win rate denominator = closed trades only |
| [ ] | Open positions count correct | Matches `SELECT count(*) FROM paper_trades WHERE status='open';` |
| [ ] | Empty state shows message | On a fresh DB, shows "No closed trades yet" |
| [ ] | Cumulative chart renders | Line chart appears once ≥1 closed trade exists |

---


## M2 — Momentum Signals + Multi-Personality

### M2-1: Personality CRUD API

```bash
# GET all personalities
curl http://localhost:3000/personalities | jq '.[0] | keys'

# GET single personality
PERSONALITY_ID=$(curl -s http://localhost:3000/personalities | jq -r '.[0].id')
curl http://localhost:3000/personalities/$PERSONALITY_ID | jq '.'
```

| # | Check | Expected |
|---|-------|----------|
| [ ] | GET /personalities returns 9 active | Array length 9, all `isActive:true` |
| [ ] | GET with `include_inactive=true` returns 10 | All 10 personalities including Levelhead |
| [ ] | GET /:id returns 404 for unknown UUID | `curl .../personalities/00000000-0000-0000-0000-000000000000` → 404 with `"error":"NOT_FOUND"` |
| [ ] | Each personality has `params` object | `min_probability`, `max_daily_trades`, `management_style`, etc. |

### M2-2: Clockwork Immutability (FROZEN_VIOLATION)

```bash
CLOCKWORK_ID=$(curl -s "http://localhost:3000/personalities?include_inactive=true" | jq -r '.[] | select(.isFrozen==true) | .id')
curl -X PUT http://localhost:3000/personalities/$CLOCKWORK_ID \
  -H 'Content-Type: application/json' \
  -d '{"params":{"max_daily_trades":2}}'
```

| # | Check | Expected |
|---|-------|----------|
| [ ] | PUT to Clockwork returns 403 | HTTP status code 403 |
| [ ] | Error code is FROZEN_VIOLATION | `{"error":"FROZEN_VIOLATION","message":"...immutable..."}` |
| [ ] | Clockwork params unchanged | GET /personalities/$CLOCKWORK_ID → params identical to before |

### M2-3: Comparison Integrity (8pp Rule)

```bash
# Get a momentum_exhaustion personality
MUTABLE_ID=$(curl -s http://localhost:3000/personalities | jq -r '[.[] | select(.entryType=="momentum_exhaustion" and .isFrozen==false)][0].id')

# Try to push min_probability more than 8pp away from others (e.g., 0.85 when others are at 0.70)
curl -X PUT http://localhost:3000/personalities/$MUTABLE_ID \
  -H 'Content-Type: application/json' \
  -d '{"params":{"min_probability":0.90}}'
```

| # | Check | Expected |
|---|-------|----------|
| [ ] | Wide drift returns 409 | HTTP status 409 if the change would put spread > 8pp |
| [ ] | Error code correct | `{"error":"COMPARISON_INTEGRITY_VIOLATION"}` |
| [ ] | Small change accepted | Changing by 0.01 within bounds returns 200 |

### M2-4: Param Range Validation

```bash
# Above ceiling (0.95 > max 0.90)
curl -X PUT http://localhost:3000/personalities/$MUTABLE_ID \
  -H 'Content-Type: application/json' \
  -d '{"params":{"min_probability":0.95}}'
# Expected: 400

# Below floor (0.30 < min 0.40)
curl -X PUT http://localhost:3000/personalities/$MUTABLE_ID \
  -H 'Content-Type: application/json' \
  -d '{"params":{"min_probability":0.30}}'
# Expected: 400
```

| # | Check | Expected |
|---|-------|----------|
| [ ] | Value above ceiling → 400 | HTTP 400 |
| [ ] | Value below floor → 400 | HTTP 400 |
| [ ] | Boundary value accepted | `0.90` (ceiling) or `0.40` (floor) returns 200 |

### M2-5: Audit Log Written on Param Change

```bash
# Make a valid change
curl -X PUT http://localhost:3000/personalities/$MUTABLE_ID \
  -H 'Content-Type: application/json' \
  -d '{"params":{"min_probability":0.71},"reason":"manual_qa_test"}'

# Verify audit log (direct DB)
docker exec trading_postgres psql -U trading -d trading -c \
  "SELECT personality_id, changed_fields, reason, created_at FROM personality_audit_log ORDER BY created_at DESC LIMIT 3;"
```

| # | Check | Expected |
|---|-------|----------|
| [ ] | PUT returns 200 with updated params | `params.min_probability` in response = `0.71` |
| [ ] | Audit log row created | At least one row with `reason='manual_qa_test'` |
| [ ] | `changed_fields` records what changed | Contains `min_probability` key |

### M2-6: Personality Performance API

```bash
curl http://localhost:3000/personalities/$MUTABLE_ID/performance | jq '.'
```

| # | Check | Expected |
|---|-------|----------|
| [ ] | Returns 200 with stats | `personalityId`, `totalTrades`, `winRate`, `openTrades` all present |
| [ ] | `winRate` in [0, 1] | Never negative, never > 1 |
| [ ] | NULL-row isolation | `totalTrades` is 0 for a personality with no linked trades (not counting pre-M2 NULL rows) |
| [ ] | Personality scoping correct | Two different personality IDs return different `personalityId` in response |

### M2-7: Signal Generation

Run in sim mode and watch for signal events:

```bash
SIMULATE=true bun run dev 2>&1 | grep -E "\[signal\]|\[peak\]|\[prob\]|\[filter\]"
```

| # | Check | Expected |
|---|-------|----------|
| [ ] | Peak detection fires | Log lines showing peak detected when momentum conditions met |
| [ ] | Probability score logged | Score value between 0.0 and 1.0 |
| [ ] | Fallback scheduled signal at 10:00 IST | After 10:00 IST in logs, `SCHEDULED` signal entry if no MOMENTUM signal earlier |
| [ ] | Signals fan out to all personalities | Multiple `[filter]` lines (one per personality) for each signal |

### M2-8: Management Styles Observed

After several trades close, verify management style is reflected:

```bash
docker exec trading_postgres psql -U trading -d trading -c "
SELECT p.name, p.management_style, t.exit_reason, count(*) 
FROM paper_trades t 
JOIN personality_configs p ON t.personality_id = p.id
WHERE t.status = 'closed'
GROUP BY p.name, p.management_style, t.exit_reason;"
```

| # | Check | Expected |
|---|-------|----------|
| [ ] | Holder trades exit at EOD or SL | Holder personality's closed trades show `eod_squareoff` or `stop_loss` (not roll exits) |
| [ ] | Adjuster shows roll events | Adjuster personality logs `[roll]` events in console |
| [ ] | Reducer shows cut/re-entry | Reducer personality logs `[cut]` and `[reenter]` events |

### M2-9: Portfolio Risk Rules

| # | Check | Verification |
|---|-------|-------------|
| [ ] | Max 4 open legs enforced | Trigger 5 simultaneous entries; 5th is blocked and logged |
| [ ] | Daily stop respected | After daily loss cap hit, further entries blocked for that day |
| [ ] | Event-day gate (RBI/Budget) | Set `today` to a known blocked date in test; verify entries blocked |
| [ ] | VIX staleness gate | If VIX hasn't updated in >30 min, new entries blocked |

---


## M3 — Historical Data, Replay & Backtesting

### M3-1: Historical Backfill (Fyers)

> Requires valid `FYERS_ACCESS_TOKEN` in `.env`. Skip to M3-2 if running credentials-free.

```bash
# Trigger backfill via API (adjust dates to a recent past week)
curl -X POST http://localhost:3000/backfill \
  -H 'Content-Type: application/json' \
  -d '{"from":"2026-05-01","to":"2026-05-07","underlying":"NIFTY"}'
```

| # | Check | Expected |
|---|-------|----------|
| [ ] | Backfill job starts | HTTP 202 Accepted |
| [ ] | Straddle snapshots appear in DB | `SELECT count(*) FROM straddle_snapshots WHERE time > '2026-05-01';` increases |
| [ ] | Backfill is resumable | Stop mid-way (Ctrl+C), restart → picks up from checkpoint, no duplicates |
| [ ] | Idempotent on re-run | Run same backfill twice → same row count (unique index prevents duplicates) |
| [ ] | Holidays/gaps marked | Days with no NSE data show gap markers, not missing entries |

### M3-2: Replay Harness (Simulation Mode)

```bash
# Run a deterministic replay against already-backfilled data (or fixture data)
bun run replay -- --from 2026-05-01 --to 2026-05-03 --underlying NIFTY --dry-run
```

| # | Check | Expected |
|---|-------|----------|
| [ ] | Replay completes without error | Exit code 0 |
| [ ] | Events processed in order | Log lines show monotonically increasing timestamps |
| [ ] | VirtualClock drives time | `[clock]` lines show simulated IST time advancing (not wall time) |
| [ ] | Replay is deterministic | Run twice with same inputs → identical trade log (same entries, exits, P&L) |

### M3-3: Regime Tagging

```bash
# Check regime tags on straddle snapshots (after replay or live data)
docker exec trading_postgres psql -U trading -d trading -c "
SELECT market_regime, count(*) 
FROM straddle_snapshots 
WHERE market_regime IS NOT NULL 
GROUP BY market_regime;"
```

| # | Check | Expected |
|---|-------|----------|
| [ ] | All four regime tags exist | `RANGING`, `TRENDING_STRONG`, `VOLATILE_REVERTING`, `EVENT_DAY` all appear |
| [ ] | No look-ahead contamination | Regime determined using only data up to 14:30 IST cutoff |
| [ ] | Regime tag on every replay row | After replay: `SELECT count(*) FROM straddle_snapshots WHERE market_regime IS NULL AND time < NOW();` → 0 |
| [ ] | Regime API returns data | `curl http://localhost:3000/regimes` → 200 with regime-tagged data |

### M3-4: Regime API Endpoint

```bash
curl http://localhost:3000/regimes | jq '.'
curl "http://localhost:3000/regimes?date=2026-05-01" | jq '.'
```

| # | Check | Expected |
|---|-------|----------|
| [ ] | GET /regimes returns 200 | Array of days with regime tag |
| [ ] | Each entry has `date` and `regime` | Fields present and typed correctly |
| [ ] | Date filter works | `?date=2026-05-01` returns only that day's regime |

### M3-5: Dashboard — Backfill Tab

Open `http://localhost:5173` → click "Backfill" tab:

| # | Check | Expected in Browser |
|---|-------|---------------------|
| [ ] | Backfill tab is visible and clickable | Tab renders |
| [ ] | Date range picker present | From/To date inputs visible |
| [ ] | Submit triggers API call | Network tab shows POST to `/backfill` on form submit |
| [ ] | Progress or status shown | Status updates as backfill runs |

### M3-6: Dashboard — Replay Tab

Click "Replay" tab:

| # | Check | Expected in Browser |
|---|-------|---------------------|
| [ ] | Replay tab is visible | Tab renders |
| [ ] | Date range inputs visible | From/To fields present |
| [ ] | Replay starts on submit | POST to `/replay` API triggered |
| [ ] | Replay results show on completion | Personality P&L comparison visible after replay |

### M3-7: Dashboard — Regimes Tab

Click "Regimes" tab:

| # | Check | Expected in Browser |
|---|-------|---------------------|
| [ ] | Regimes tab is visible | Tab renders |
| [ ] | Regime distribution chart renders | Chart or table with `RANGING/TRENDING_STRONG/VOLATILE_REVERTING/EVENT_DAY` |
| [ ] | Historical data needed | Shows empty state gracefully if no backfill data available |

---


## Cross-Milestone Checks

### Error Handling

| # | Check | How to Verify |
|---|-------|--------------|
| [ ] | 500 errors surface in UI | Kill the backend while Trades tab is open → error alert appears, no white screen |
| [ ] | Offline backend shows error states | Disable Docker, open dashboard → all tabs show error alerts, not blank/zeroed data |
| [ ] | WebSocket disconnection handled | Stop Fastify → WS pill transitions to "Disconnected", no console errors |

### Data Integrity

| # | Check | How to Verify |
|---|-------|--------------|
| [ ] | Clockwork is never modified | After a full sim session: `SELECT params FROM personality_configs WHERE is_frozen=TRUE;` — unchanged from seed |
| [ ] | Comparison integrity maintained | Precision/Adjuster/Reducer `min_probability` differ by ≤ 8pp at all times |
| [ ] | No NaN in P&L calculations | `SELECT * FROM paper_trades WHERE net_pnl = 'NaN';` → 0 rows |
| [ ] | Decimal precision correct | All `net_pnl` values in DB have exactly 2 decimal places |

### Teardown & Reset

```bash
# Clean shutdown
docker compose down

# Full reset (destroys all data — use to re-run QA from scratch)
docker compose down -v
bun run migrate   # re-apply schema after volume destruction
```

| # | Check | Expected |
|---|-------|----------|
| [ ] | `down` stops services | `docker compose ps` shows no running containers |
| [ ] | `down -v` destroys data | After `down -v` then `docker compose up -d` + `migrate`, DB is empty again |
| [ ] | Re-running QA from scratch gives identical results | All checks above pass on a clean slate |

---

