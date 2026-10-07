# BL-046 — Options API performance: bounded loads, reused connections, streamed proxies

| | |
|---|---|
| **Priority** | P2: Options Lab gets slower with every collected day, and one endpoint already exceeds the proxy timeout |
| **Status** | Planned |
| **Type** | improvement |
| **Area** | options (+ server proxies) |
| **Created** | 2026-10-07 |
| **Depends on** | none. Related: BL-009, BL-034 |
| **TODO.md row** | none yet (filled in when started) |

## Context

The 2026-10-07 audit found these in `packages/option-backtesting` (`obt-api`) and the Fastify proxies:

- **`/legwise/anatomy` loads too much and keeps a cache that thrashes.**
  - It loads every collected index day, not just the requested range
    (`legwise/anatomy.py:280`); NIFTY has 2,908 days.
  - Its module cache has no lock and clears completely past 6,000 entries (`:256`). NIFTY,
    BANKNIFTY and SENSEX together exceed that, so the cache thrashes.
  - It opens a new Postgres connection on every request (`legwise_routes.py:330`).
- **`/legwise/backtest` with no dates runs too long.** It simulates all ~1,015 NIFTY days
  synchronously and returns every day and every trade (`legwise_routes.py:185-197`). That runs
  past the 30 s proxy timeout (`apps/server/.../backtest.ts:73`).
- **`/legwise/results` has no limit.** It loads every saved daily result and trade
  (`legwise/store.py:186-211`).
- **`data/cache.py` (lines 66, 107, 133) opens a fresh in-memory DuckDB** and re-reads the
  Parquet files on every call.
- **The Fastify proxies re-encode every response.** `backtest.ts:124` and `momentum-backtest.ts:48`
  call `response.json()` and then re-serialise the body. With no `@fastify/compress`, momentum's
  gzip is decoded and the body is sent on uncompressed.

The audit PR `fix/security-quick-wins` added `GZipMiddleware` to `obt-api`.

## Goal

Every Options Lab request answers within 2 s on two years of data, and no endpoint returns an
unbounded list.

## Out of scope

- Engine semantics. Golden fixtures must stay byte-identical.

## Plan

### Phase 1 — Bound the loads
- **Tasks:**
  - `/anatomy`: load only the requested date range.
  - Replace the cache with a thread-safe LRU bounded per underlying.
  - Use one Postgres connection, pooled or cached per process.
  - `/legwise/backtest`: default to the last 120 sessions unless dates are given. Run a longer
    range as a background job like `/legwise/daily`.
  - `/legwise/results`: `limit`/`offset`, and the dashboard pages through them.
- **Done when:** a timing test shows each endpoint under 2 s on the live lake, and
  `pytest tests/golden` is unchanged.

### Phase 2 — Reuse DuckDB
- **Tasks:** `data/cache.py` keeps one read-only connection per process, and recreates it when
  the cache folder's mtime changes.
- **Done when:** repeated `/coverage` and `/runs` calls stop re-reading the Parquet files (profile it).

### Phase 3 — Stream the proxies
- **Tasks:**
  - Pipe the upstream body and `content-encoding` straight through in `backtest.ts` and
    `momentum-backtest.ts`, keeping the status code and the size caps.
  - Register `@fastify/compress` for the other routes.
- **Done when:** a large momentum result reaches the browser gzip-encoded through the proxy.

## Risks

- A default date range changes what a dateless API call means. The MCP `run_backtest` tool and
  any scripts must pass dates explicitly. Check them.

## Open questions

1. Default window for an undated `/legwise/backtest`: the last 120 sessions, or the last 6 months?

## Log

- 2026-10-07: created from the whole-repo audit.
