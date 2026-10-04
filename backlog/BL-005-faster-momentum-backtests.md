# BL-005 — Faster Momentum backtests (Broad: 55 s cold, 21 s warm)

| | |
|---|---|
| **Priority** | P1 — the slowest step in the research loop. Every Broad iteration waits 20–55 s |
| **Status** | Planned |
| **Type** | improvement |
| **Area** | momentum (+ dashboard for polling and lazy cards) |
| **Created** | 2026-10-05 |
| **Depends on** | **BL-001** for Phase 3: any engine change must be proven result-identical by the golden suite first. Phases 1–2 do not change results |
| **TODO.md row** | — (filled in when started) |

## Context

Measured 2026-10-04 against the running Momentum API (`POST /api/backtest`, the stateless
endpoint, default settings, data through 2026-10-02):

| Dataset | First run | Re-run, identical config | Response |
|---|---|---|---|
| ETF Rotation | 6.4 s | 4.0 s | 460 KB |
| Broad Momentum | 55.1 s | 21.0 s | 1,674 KB |

The Broad response breaks down as trades 553 KB, rotations 519 KB, instruments 240 KB,
latest 230 KB, timeline 175 KB and series 72 KB.

A `cProfile` of a warm in-process Broad run (the profiler inflates absolute times, but the
proportions hold):

- **~40%** in `engine._run_buffer`, reading prices one cell at a time from pandas:
  `engine.price()` / `value()` / `group()`, with ~164k `DataFrame._get_value` calls.
- **~20%** in `analysis.payload`: `rotations` (6.8 s) and `instrument_table` (4.4 s). This
  builds tables for the UI.
- **~20%** in `api._circuit_realism`: `circuit_exposure._runs` and `lc_outcomes`. This is a
  second pass for the "Worst circuit situations" card, which concluded "about 0 CAGR points"
  on that run.
- `PerformanceWarning: DataFrame is highly fragmented` at `categories/broad.py:1170-1171` and
  `api.py:1601`.

The browser side is not the bottleneck. Rendering a finished 1.6 MB result took ~0.5 s, and
typing in settings stayed under 50 ms. But `store/momentumRuns.ts` first polls the job 2 s
after Run (`POLL_MS = 2000`), so results land up to 2 s after the server finishes.

The Python API does not compress responses: scores are 300 KB raw against 76 KB gzipped.
Once BL-002 puts the dashboard on Vercel, every response crosses the Cloudflare tunnel, so
compression matters more.

## Goal

Warm Broad run ≤ ~5 s, with an identical re-run under 1 s and the first screen of results
under ~400 KB, all with byte-identical results (BL-001 goldens).

## Out of scope

- Changing any strategy rule or default: every result must stay exactly the same.
- The weekly scheduler.

## Plan

### Phase 1 — Cheap wins, no change to results
- **Tasks:**
  - Poll at 300 ms, 700 ms, 1.5 s and then every 2 s (`store/momentumRuns.ts`).
  - Add `GZipMiddleware(minimum_size=1024)` to the FastAPI app.
  - Memoise whole backtest results in an LRU keyed by the canonical config (sorted JSON) plus
    a data version (the stock/price catalog mtimes the service already tracks for its other
    caches). `fresh: true` bypasses and clears it.
- **Deliverables:** `api.py`, `store/momentumRuns.ts`, tests for the cache key (config order
  must not matter; a data change must invalidate).
- **Done when:** an identical re-run returns in < 1 s; responses carry `Content-Encoding:
  gzip`; median Run→results latency drops by ~1 s for ETF.

### Phase 2 — Load the heavy tables only when opened
- **Tasks:** keep KPIs, series and summary rotations in the job result. Move circuit realism,
  `instrument_table`, full trades and full rotations to on-demand endpoints keyed by job id
  (computed on first request, then cached). The cards show the existing `Shimmer` while they
  load.
- **Deliverables:** new `GET /api/backtest/jobs/{id}/{section}` routes, Next rewrites plus
  Fastify proxy entries, card components fetching on open.
- **Done when:** a warm Broad run is ≤ ~10 s with a result < 400 KB, and each card loads in
  < 2 s when opened.

### Phase 3 — Engine without one-cell-at-a-time pandas
- **Tasks:** in `engine.py`, pre-extract the price/value matrices to NumPy arrays plus
  date/symbol index maps, and replace `price()`/`value()`/`group()` lookups with array
  indexing. Fix the fragmentation warnings (`pd.concat` / `.copy()`).
- **Deliverables:** engine changes plus a micro-benchmark script.
- **Done when:** BL-001 goldens pass unchanged and a warm Broad run is ≤ ~5 s.

### Phase 4 — Progress the user can read
- **Tasks:** the job reports its stage (loading data → ranking → simulating → analysing). The
  run banner shows the stage and "usually ~N s", taken from the last finished run of that
  dataset.
- **Done when:** a cold Broad run shows at least three stage changes before finishing.

## Risks

- Silent result drift from the engine rewrite: blocked on BL-001, and diff every golden.
- A stale result cache: key on the data version, and test that an ingest invalidates it.
- Memory use of the result LRU: cap by count (e.g. 8) and drop the largest sections first.

## Open questions

- Is the circuit-realism card worth computing on every run, or only on demand?
- Target for a *cold* Broad run? (The first-run cost is building category rankings.)

## Log

- 2026-10-05 — created from the Momentum UI performance review (2026-10-04 session).
