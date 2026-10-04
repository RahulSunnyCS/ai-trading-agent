# BL-001 — Momentum result integrity: goldens, parameter coverage, drift alerts

| | |
|---|---|
| **Priority** | P0 — protects the correctness of the numbers favourites and weekly signals are chosen on |
| **Status** | Planned |
| **Type** | improvement |
| **Area** | momentum (+ trading-data for one migration, dashboard for one provenance line) |
| **Created** | 2026-10-04 |
| **Depends on** | none — the baseline commit is already in place (see Context) |
| **TODO.md row** | — (filled in when started) |

## Context

Backtest numbers (CAGR, drawdown, trades) drive real decisions, and the momentum code changes
often. The owner's requirement: if a code change moves a backtest result, someone must be
alerted. A result should only move when the data changed, and that must be flagged too. The
owner said correctness of the output matters "very very very much".

What exists today:

- `packages/momentum-backtesting` has **no golden/regression suite**. `packages/option-backtesting`
  does (`tests/golden/test_legwise_scenarios.py` + `scripts/update-legwise-goldens.py`). This
  item copies that pattern.
- All 25 saved momentum runs have **`code_version`, `date_from` and `date_to` set to NULL** in
  `backtest_runs`. Nothing records which code or data produced a saved number.
- **This has already happened.** Re-running favourites on 2026-10-04 gave:

  | Favourite | CAGR when saved | CAGR on 2026-10-04 |
  |---|---|---|
  | ETF Weekly Core | 25.47% | 25.36% |
  | Stock Weekly Core | 11.69% | 11.63% |

  Nothing can say whether code or data caused either shift.
- **Silent default changes.** Flipping the `broad_every_week` default (TODO 3.11.17) was a
  deliberate fix, but it changed the result of every Broad run that hadn't set the field
  explicitly. Nothing flagged that.
- **Baseline.** The owner chose to take goldens only from committed, reviewed code. The
  in-flight momentum work (search, robust, final, bias, rescore, steady, wide tags,
  exit_reasons) is committed in `c3ba15d` and merged via PR #2, and the package was clean on
  2026-10-04. When starting, generate goldens from whatever HEAD is then, provided
  `packages/momentum-backtesting` and `packages/trading-data` have no uncommitted changes.

Key design point: **"code changed" and "data changed" are separate alarms.** A test on the
live database would trip on every Friday data refresh, and the owner would learn to ignore
it. So code changes are caught on frozen data (Phases 1–2), and data changes are caught on
the live database with a pinned end date (Phase 4).

Goldens prove a result is *unchanged*, not that it is *correct*: if today's code has a bug,
the goldens freeze it. Correctness comes from the always-true checks and the look-ahead test
in Phase 2.

## Goal

- Any code change that alters any momentum backtest result fails CI and the local pre-push
  hook. The failure comes with a readable diff, and accepting it is an explicit, logged step
  with a written reason.
- Adding a backtest parameter without a scenario that exercises it fails CI.
- A result may only move without a code change when the data changed, and then the owner gets
  a Telegram alert naming the favourites affected, the KPI deltas, and the instruments whose
  history changed.
- Every saved run records the code commit and data fingerprint that produced it.

## Out of scope

- An independent second implementation of the engine to cross-check results.
- Detecting look-ahead already baked into stored inputs, such as back-adjusted prices or
  year-level index membership. The truncation test only sees look-ahead in computation.
- `option-backtesting`, which already has its own goldens.

## Plan

Each phase updates `packages/momentum-backtesting/CLAUDE.md` / `README.md`,
`.claude/project/technical.md` (Essential Commands) and its `TODO.md` row in the same commit
as the code.

### Phase 1 — Golden scenarios on frozen data

**Tasks:**

- **Frozen fixture** in `packages/momentum-backtesting/tests/golden/fixture/` plus
  `manifest.json`. It is a small, self-consistent real-data window from `~/TradingData`, with
  a size target under 15 MB:
  - Database tables as zstd Parquet, ~2018-01 → 2025-06:
    - `momentum_prices` (all kinds)
    - `stock_weekly_prices`, `stock_weekly_series`, `stock_membership_weekly` (all 95
      companies)
    - `category_membership`
    - `instruments` rows for the symbols kept
  - `bars_1d_stock` daily bars trimmed to ~200 symbols (8 of the 16 categories plus ~60
    liquid Total Market names), with membership trimmed to the same symbols.
  - File-only inputs:
    - `daily/*.csv`, `daily_etf/*.csv` (trade fills, `trade_prices.py`)
    - `stocks/benchmarks_weekly.csv`, `stocks/cash_weekly.csv`
    - `etf_premium.csv`
  - `manifest.json` holds a sha256 per file plus the window.
  - Curated CSVs (`categories/curated`, `stocks/curated`) are versioned with the code, so
    editing them trips the goldens too. That is intended.
- **Harness** `tests/golden/harness.py`, run in a **subprocess**. `config.DATA_DIR` is bound
  at import time in ~10 modules, so `MOMENTUM_DATA_DIR` must be set before import. It:
  1. Builds a temporary `TRADING_DATA_ROOT`: `trading_data.db.connect(root)` runs the
     migrations; insert the table Parquets; write the lake via
     `trading_data.lake.bars_1d_stock_path` / `write_parquet`; call `refresh_views`.
  2. Points `MOMENTUM_DATA_DIR` at a temporary copy of the file inputs.
  3. POSTs each scenario through `TestClient(api.create_app())` to `/api/backtest`. This is
     the exact production path: pydantic validation → `_dispatch_backtest` →
     `analysis.payload` → JSON.
  4. Wraps `run_backtest` at each import site to record the effective `engine.Config` per
     scenario.
  5. Emits, per scenario: the request, the effective config(s), and the full payload with
     floats rounded to 10 significant digits.

  It has options for reverse scenario order and for truncating inputs at a date (used in
  Phase 2).
- **Scenarios** `tests/golden/scenarios.py`, ~16, each with a named id and an explicit full
  request with `end` set to the fixture end:

  | Dataset | Scenarios |
  |---|---|
  | ETF (5) | the real **ETF Weekly Core** params; slots + ranked-defensive + custom weights + `signal_delay`; filter-defensive + tax + tax-hold + itemised costs; `track=etf` / `mon_open` + `reversal_tilt` / screen + `exclude_high_vol` + no cap; cadence 2 / offset 1 + `sell_every_week` + `momentum_sizing` + `make_room` + blend |
  | Stock (3) | **Stock Weekly Core**; voladj + monthly + no skip-month; blend + slots |
  | Custom Index (2) | defaults; inner top-N/exit + commodity/debt copies = 2 |
  | Broad (6) | 3 of the favourite candidates (1Cat-3Pick 4-weekly, 8Cat-1Pick, 2Cat-3Pick bi-weekly); category mode off; liquidity-gate variants + `max_category` + `max_stock_price` + `broad_reversal_tilt` + `broad_every_week=False` + category tags |

  Favourite-derived scenarios run on trimmed data, so their numbers differ from the
  dashboard. Phase 4 is what pins the real dashboard numbers.
- **Test** `tests/golden/test_golden.py`:
  - Compares the full payload and effective config per scenario. Structure, strings and ints
    must match exactly; floats use `rel_tol=1e-9`, which absorbs macOS-arm64 vs Linux-CI
    last-digit noise.
  - The failure message gives a summary (KPI deltas, first divergent week, trades
    added/removed) and the command to run.
  - It also checks that the fixture matches `manifest.json`.
- **Update script** `scripts/update-goldens.py`, modelled on
  `option-backtesting/scripts/update-legwise-goldens.py`:
  - **Default:** check-only, writes nothing.
  - **`--accept-results --reason "…"`:** rewrites `expected/*.json` and appends to
    `tests/golden/CHANGELOG.md` (date, commit, scenarios affected, KPI before→after, reason).
  - **`--source-root ~/TradingData --accept-inputs --accept-results`:** re-extracts the
    fixture. The same extraction code builds the first fixture.
- **`lefthook.yml` `pre-push`:** runs `uv run pytest tests/golden` in
  `packages/momentum-backtesting`, only when the pushed diff touches
  `packages/momentum-backtesting/**` or `packages/trading-data/**`. CI needs no change: the
  momentum job's `uv run pytest` picks the suite up.

**Deliverables:**
- `tests/golden/` (fixture, manifest, harness, scenarios, `expected/`, `test_golden.py`,
  `CHANGELOG.md`)
- `scripts/update-goldens.py`
- the pre-push hook

**Done when:**
- `uv run pytest tests/golden` passes in under ~2 minutes, locally and in CI.
- Changing the flat cost by 1 bp in `engine.py` fails with a readable diff (then reverted).
- Flipping one fixture byte fails the manifest check.
- `scripts/update-goldens.py` with no flags reports clean and writes nothing.

### Phase 2 — Coverage and correctness checks

**Tasks:**

- **`tests/golden/test_coverage.py`** — new parameter means new scenario, enforced:
  - Every `BacktestRequest` field (66 at `c3ba15d`) must be listed in `FIELD_DATASETS`
    (field → the datasets that read it).
  - Every field must be **non-default** in ≥1 scenario of an applicable dataset, or be in
    `EXEMPT` with a reason (e.g. `fresh`).
  - Every value of every `Literal` field must appear in some scenario. `execution="mon_10am"`
    needs `data/intraday`, which doesn't exist yet, so it is exempt with that reason.
  - Every `engine.Config` field must be non-default in ≥1 recorded effective config, or be
    exempt with a reason.
  - Old scenarios never set a new field, so Phase 1 automatically proves a new field's default
    leaves every old result unchanged.
- **Always-true checks** on every scenario payload, inside `test_golden.py` (no extra runs):
  - `series.strategy[0] == CAPITAL`, and every value is > 0
  - `kpis.cagr` and max drawdown recomputed via `metrics.cagr` / `metrics.max_drawdown` match
    the reported values; `drawdown_strategy` recomputes too
  - yearly returns compound to the total return
  - `idle_share` ∈ [0, 1]
  - open positions are ≤ `max_position + cap_band` when a cap is set
  - `trade.pnl == value − entry_value`, and `weeks_held ≥ 0`

  Each check is first confirmed against the engine's documented semantics. Any check that
  fails on the baseline is a **finding to investigate**, never a reason to loosen the check.
- **`tests/golden/test_lookahead.py`**, one scenario per dataset:
  1. Run A: full fixture with `end = T1` (≈ fixture end − 12 weeks).
  2. Run B: inputs physically truncated at T1.
  3. Series, trades and KPIs must be identical. Other differing fields (e.g. `latest`) are
     reported for review.

  This covers the Broad funnel, liquidity gate and ranking caches, which the engine-only
  `test_decisions_never_use_future_prices` cannot see.
- **Nightly only** (`MOMENTUM_GOLDEN_FULL=1`):
  - A reverse-order re-run in a fresh subprocess must give identical results (this catches
    `_Data` cache-key bugs).
  - **Wiring test:** for each covered field, re-run its scenario with that field reset to its
    default. The payload must differ, which proves the parameter reaches the engine.
  - `.github/workflows/ci.yml` sets the flag when `github.event_name == 'schedule'`.

**Deliverables:** `test_coverage.py`, `test_lookahead.py`, the always-true checks, the
nightly tests and the CI flag.

**Done when:**
- Adding a dummy `BacktestRequest` field fails `test_coverage`.
- Inserting a `.shift(-1)` into `compute_ranks` fails `test_lookahead` (both reverted).
- `MOMENTUM_GOLDEN_FULL=1 uv run pytest tests/golden` passes.
- Any always-true check that fails on the baseline is written up as a finding, not deleted.

### Phase 3 — Provenance on every saved run

**Tasks:**

- New `src/momentum_backtesting/provenance.py`:
  - **`code_version()`:** `git rev-parse --short HEAD`, plus `+dirty.<sha256(git diff)[:8]>`
    when `packages/momentum-backtesting` or `packages/trading-data` has uncommitted changes,
    or `unknown` if git is unavailable.
  - **`data_fingerprint(dataset, through)`:** per-instrument
    `md5(string_agg(date‖values ORDER BY date))` in DuckDB (stable across versions, unlike
    `hash()`), over the tables that dataset reads plus its file inputs. Returns per-instrument
    hashes plus a combined hash, cached on `db_read.catalog_mtime()`.
- `runs_store.save_run` fills `code_version`, `date_from`, `date_to` and
  `summary.provenance = {code_version, data_fingerprint, data_through}`.
- `analysis.payload` gets a `provenance` block:
  - the golden comparison excludes it (it changes with every commit)
  - the Saved runs view shows it as one muted line (`MomentumSavedRunsView.tsx`,
    `types/momentum.ts`)

**Deliverables:** `provenance.py`, the `runs_store` / `api` / `analysis` changes, the
dashboard line, and unit tests.

**Done when:**
- A run saved from the dashboard has `code_version` / `date_from` / `date_to` filled in the
  catalog, and the provenance line shows in Saved runs.
- A dirty tree is visibly marked `+dirty`.

### Phase 4 — Weekly favourites check (catches data changes)

**Tasks:**

- New `src/momentum_backtesting/verify.py` and `mbt verify favourites [--accept --reason …]
  [--no-telegram]`.
- New migration `packages/trading-data/src/trading_data/migrations/007_momentum_favourite_baselines.sql`.
  It creates an append-only `momentum_favourite_baselines` table: `run_id`, `anchor_end`,
  `params_hash`, `code_version`, per-instrument fingerprint JSON, result JSON (KPIs + curve
  hash + trades hash), `accepted_at`, `reason`.
- **Each check:**
  1. For every favourite (`runs_store.list_favorites`), re-run its stored params with `end`
     pinned to its baseline's `anchor_end`. New weekly data never trips it; only restated
     history does.
  2. Recompute the fingerprint up to the anchor.
  3. Classify the outcome:

  | Data ≤ anchor | Result | Outcome |
  |---|---|---|
  | same | same | OK |
  | changed | same | info: data changed, no effect |
  | changed | changed | ⚠️ Telegram: per favourite, CAGR / max drawdown / Sharpe before→after; up to 10 changed instruments with their earliest changed date |
  | same | changed | ❌ Telegram: the result changed with identical data. Cause is a code change the goldens missed (add a scenario), look-ahead, or non-determinism. Shows the baseline commit vs the current commit |

- **Accepting and re-anchoring:**
  - Nothing is ever auto-accepted after a change: `--accept --reason` re-baselines.
  - A favourite with no baseline gets one, reported as "new baseline".
  - A clean check whose anchor is more than 4 weeks old advances the anchor to the latest
    complete week.
- **Schedule:** appended to the 19:30 IST Friday stock-ingest LaunchAgent
  (`scripts/com.ai-trading-agent.momentum-weekly-stock-ingest.plist`), after the data
  refresh. Alerts go through the existing `notify.py`.

**Deliverables:** `verify.py`, the CLI command, the migration, the plist change, and unit
tests (classification and fingerprint diffing).

**Done when:**
- `mbt verify favourites --no-telegram` on real data creates a baseline per favourite (12 on
  2026-10-04), and a second run reports all OK.
- On a scratch copy of `~/TradingData`:
  - editing one close before the anchor yields "data changed" naming that instrument
  - with the copy restored, patching a cost constant yields the ❌ "identical data"
    classification

## Risks

- **Fixture outgrows git.** Keep the trimmed universe and window; fail the manifest test if
  the total exceeds the size budget. Revisit the window rather than adopting LFS.
- **Cross-platform float noise** (macOS-arm64 vs Linux CI). Handled by the `rel_tol=1e-9`
  comparison. If a real difference ever sits below that, tighten per field rather than
  globally.
- **Slow suite.** If it exceeds ~2 minutes, trim the fixture before moving tests to nightly:
  the per-push run is the point.
- **Accept fatigue.** Rubber-stamping `--accept-results` defeats the purpose. The required
  `--reason` and the changelog entry make each accept visible in review.
- **Import-time `DATA_DIR`.** Monkeypatching ~10 modules is fragile, so the harness always
  runs in a subprocess.
- **The trimmed universe behaves differently from the full one.** Acceptable: goldens detect
  *change*, not absolute performance. Phase 4 covers the real numbers.
- **DuckDB lock contention.** The favourites check reads the catalog while `mbt serve` may be
  writing. Use read-only connections with `trading_data.db`'s existing retry.
- **Laptop asleep at 19:30.** The check then runs late or not at all. The existing weekly
  status panel already flags late jobs, and the check can be re-run manually.

## Open questions

Already answered (2026-10-04):

- **Baseline:** commit the in-flight work first, then take goldens from that commit. Done:
  `c3ba15d`.
- **Enforcement:** CI plus a local pre-push hook (not pre-commit).

To ask when starting:

1. Is ~15 MB of committed fixture acceptable, and is a ~2018-01 → 2025-06 window with ~200
   Broad/Custom Index symbols the right trade-off?
2. If the favourites check returns ❌ "identical data" for the favourite that is active that
   week, should that week's Telegram signal be held back, or sent with a warning?
3. Initial anchor date for the favourites check (proposed: 2026-09-25), and is auto-advancing
   after 4 clean weeks acceptable?
4. Is one muted provenance line in Saved runs enough, or should the dashboard also badge a run
   whose re-run no longer matches?

## Log

- 2026-10-04 — created from the planning conversation. Priority P0 (protects result
  correctness). Baseline and enforcement questions answered. Status `Planned`.
