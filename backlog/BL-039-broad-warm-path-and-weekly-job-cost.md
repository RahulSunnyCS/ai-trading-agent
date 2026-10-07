# BL-039 — Broad warm path and weekly-job cost

| | |
|---|---|
| **Priority** | P2 — the dashboard and the weekly job pay for work the result does not need. This month's priorities (BL-010, BL-001, BL-024, BL-025) do not wait on it: the parameter search calls `run_broad_backtest` directly, not this API path |
| **Status** | Planned |
| **Type** | improvement |
| **Area** | momentum (+ trading-data for the catalog connection) |
| **Created** | 2026-10-07 |
| **Depends on** | **BL-001** goldens (done): every change here must leave every result identical. Follow-up to [BL-005](BL-005-faster-momentum-backtests.md) (closed) |
| **TODO.md row** | — (filled in when started) |

## Context

BL-005 (Phases 1–4, merged 2026-10-07) fixed the identical re-run (62 s → 0.0 s on real data), the
ETF and Stock runs (3–4× faster) and the engine (1.6 s → 0.3 s for two runs). It did **not** meet its
warm-Broad goal of about 5 s on the real data: a Broad request with only `cost_pct` changed (so the
ranking is reused) is still about 19.5 s of CPU, against 24 s before. The fixture the goldens use is
too small to show why.

A cProfile of that request on a private copy of the real catalog (old and new code side by side,
2026-10-07) puts the engine at about 1.3 s for both runs. The rest is two database reads that BL-005
never touched:

- `liquidity.compute_weekly_features` for the held stocks, called from
  `exit_reasons.explain_exits` (the Trades section): about **37 s**. A DuckDB query over the
  `bars_1d_stock` Parquet lake, not cached between requests (by design, for "a handful of symbols").
- `db_read.has_total_market_data`, a one-row existence check on the catalog: about **15 s**. Opening a
  catalog connection is itself slow on the real lake, which now holds many thousands of day files
  since the vendor import (BL-034).

The core result the dashboard waits for skips the first (it is a lazy section). The stateless
`POST /api/backtest`, the weekly job (`mbt weekly`, which builds the full payload per favourite and
reads only the core and `latest`) and the circuit card all pay for both.

**Caveat that decides Phase 0:** the profile was taken on a *copy* of the catalog with the lake
symlinked, because the owner's `mbt serve` holds the real one. The copy may exaggerate the
connection cost: before BL-005's Phase 3 the real server measured 12.7 s warm, which does not fit with
24 s of CPU for the old code on the copy.

Dropped from BL-005, on purpose: the "core result under 400 KB" target. The core is 593 KB
uncompressed (`rotations` is 515 KB) but 106 KB over the wire with gzip on, and slimming `holdings`
means changing the chart and the result shape. Not worth the risk.

## Goal

- A changed Broad request (ranking reused) on the real running server: ≤ ~5 s, measured on the real
  server and not on a copy.
- The Friday weekly run (14:40, 16:45, 19:30 IST) spends no time building sections nobody reads:
  its run time is measured before and after and the saving is recorded.
- Every result, journal entry and weekly signal identical to before (goldens, live compare, a diff of
  the weekly signal output).

## Out of scope

- Slimming `rotations` / the 400 KB core target (see Context).
- The ranking build (Step 2, about 20 s cold, cached per setting): only touched if Phase 0 shows it
  is part of the problem.
- Any change to what the engine decides: this item moves work and caches it, nothing else.

## Plan

### Phase 0 — Measure on the real server
- **Tasks:** check whether the running `mbt serve` (127.0.0.1:8765) has the post-BL-005 code,
  restarting it first if not. POST the same Broad request, then variants changing only `cost_pct`,
  and read `compute_ms` from the job route and `cache.hit`. Also read the real weekly runs'
  durations from `data/launchd-weekly-*.log` / the scheduler's run history.
- **Deliverables:** the real warm time, and how long the Friday weekly run takes per favourite
  today, recorded in this item's Log. Decide from them whether Phases 1 and 2 are worth doing.
- **Done when:** both numbers are in the Log. If the real warm time is already near 5 s, close the
  warm-path part and keep only Phase 1.

### Phase 1 — The weekly job builds only what it reads
- **Tasks:** `_*_backtest(req)` return the whole payload for the weekly job, which uses the core and
  `latest`. Give it a path that builds the core and `latest` only (the lazy-sections machinery from
  BL-005 Phase 2 already separates them); the stateless `POST /api/backtest` keeps returning the
  whole payload so goldens and journals see no change.
- **Deliverables:** the change, with a test that the weekly signal and journal entry are identical to
  the full-payload path for every favourite type, and the before/after run time.
- **Done when:** a diff of the weekly signal output for every saved favourite is empty, the goldens
  pass with nothing accepted, and the run-time saving is in the Log. Ship on a Monday, never on a
  Friday: this is the path behind the real-money signal.

### Phase 2 — Cache the weekly features and the catalog connection (only if Phase 0 says so)
- **Tasks:** cache `compute_weekly_features` per `db_read.data_version()` and symbol set (the
  caching rule in `packages/momentum-backtesting/CLAUDE.md` applies: never key on
  `catalog_mtime`); open the catalog connection once per process, or find out why `connect` costs
  seconds on the real lake.
- **Deliverables:** the change, an equivalence test against a verbatim copy of the uncached code on
  random data, and a test that a data refresh invalidates the cache.
- **Done when:** the real-server warm time from Phase 0 meets the goal, goldens unchanged, and the
  live compare of every favourite is identical.

## Risks

- The real-money path (Phase 1): a mistake there changes a Telegram signal. Same gates as BL-005 and
  a diff of the actual signal output, not just the goldens.
- A stale cache (Phase 2): key on the data version and test that an ingest invalidates it.
- Phase 0 may show the problem is mostly the private copy; then most of this item is not needed.

## Open questions

- None blocking Phase 0. Phase 2 goes ahead only if Phase 0 still shows a warm time over ~5 s.

## Log

- 2026-10-07 — Created from BL-005's close-out: the live check there showed the warm-Broad target
  missed and where the time goes. Priority P2 and Planned by the owner's decision (recommendations:
  re-measure first; weekly job is the most valuable part; drop the 400 KB target).
