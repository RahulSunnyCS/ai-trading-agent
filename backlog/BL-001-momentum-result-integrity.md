# BL-001 — Momentum result integrity: goldens, parameter coverage, drift alerts

| | |
|---|---|
| **Priority** | P0 — protects the correctness of the numbers favourites and weekly signals are chosen on |
| **Status** | Done (2026-10-28): Phases 1 and 2 done; F1, F6, F7 fixed; Phase 3 closed as superseded by BL-052; Phase 4 built as the history check only, the pinned favourite re-run → BL-177; F3 and F4 deferred |
| **Type** | improvement |
| **Area** | momentum (+ trading-data for one migration, dashboard for one provenance line) |
| **Created** | 2026-10-04 |
| **Depends on** | none — the baseline commit is already in place (see Context) |
| **TODO.md row** | 3.14 |

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

### Answered when starting (2026-10-05)

- **Scope:** Phases 1 and 2 now; 3 and 4 later. BL-010 was waiting on these two.
- **Fixture:** about 15 MB is acceptable. Built at 14.7 MB: 170 stocks, bars from 2017, end
  2025-06-27.
- **Baseline:** freeze the engine as it is, then fix BL-010's E10 to E13 through the accept
  step.

Questions 2 to 4 above belong to Phases 3 and 4 and are still open.

### As built (differences from the plan)

- Scenarios start from the API's own defaults (`$meta`) and change a few settings each, instead
  of spelling out every field. A default that flips then moves a frozen result, which is the
  case this item exists for.
- Expected results are one gzipped JSON per scenario (1.5 MB in all; plain JSON was 10 MB) plus
  a readable `summary.json`. The accept script prints the differences.
- The coverage test checks every request field and every choice. It does not map fields to
  datasets or inspect `engine.Config`.
- The look-ahead test runs at three cut dates on all four datasets and compares results only.
  Three fields are left out with reasons: `price` (a level on today's share count), `proxy`,
  and the order of equal-weight holdings.
- Not built: the always-true checks, the nightly reverse-order and wiring runs, and the CI
  nightly flag.

## Where it stands (2026-10-22)

**Phase 2's missing pieces are built** (branch `feat/bl001-invariants`): `tests/golden/test_invariants.py`
(the always-true checks, on the frozen payloads, no extra runs), `tests/golden/test_nightly.py`
(reverse-order re-run, which passes; every setting wired, 141 variants, 4 minutes) and the CI flag
`MOMENTUM_GOLDEN_FULL` on the schedule trigger. Findings from building them, in order of weight:

| # | Finding | Effect | Status |
|---|---|---|---|
| F1 | **Weights left the waiting cash out.** After an off-cadence sale (`sell_every_week`, or a stop paid to cash), and in the weeks before the first buy of a slow-cadence run, `engine.py` normalised `weights[week]` over the holdings only, so the rest looked bigger and the idle share smaller (a two-name book that sells one showed the other at 100%, not 50%). Equity was right. | Display and KPIs only: `idle_share`, `holdings_count`, `avg_holdings`, `time_in_cash`, `avg_share`, the Rotation rows and `max_position_share`. Equity, CAGR and trades did not move. | **Fixed 2026-10-22 (owner: as recommended).** `uninvested` is part of the total and of the idle share. Three golden scenarios moved and were accepted with a reason (`tests/golden/CHANGELOG.md`); `tests/test_weights_after_off_cadence_sell.py` is now an ordinary test.
| F2 | **`max_position` is not a hard cap off the weekly cadence.** The trim is inside `if is_buy_week`, so with `rebalance_every` above 1 or monthly rebalancing a holding can sit above cap + band until the next trade week (a 50% cap reached 59% in the four-weekly Broad scenario; the 54% first seen in a fortnightly ETF scenario was the F1 artefact and is 39% now). The slots rule has no cap. | The invariant is asserted only for weekly buffer runs. Worth knowing for the 4-weekly sleeves you follow (25% cap). | Documented in the test; a design fact, not changed. |
| F3 | **No scenario depends on `broad_respect_circuits`** (corrected 2026-10-24). Putting it back to its default changes the result of none of the six Broad scenarios that set it: no lock in the fixture falls on a name the ranking ranks that week. `broad_gates_loosened_and_tilted`, once thought to depend on it, sets it to `False`, the default, so the nightly check never varies it, and its result is identical either way (its realism section shows ignoring = respecting locks). The setting is wired: a planted upper lock on a name the Monday-open run buys moves its CAGR (PR #314 review). `blocked_entries` / `blocked_exits` do not prove a result cannot move (they come from the locked run and date fills on Friday). | No golden coverage: a wiring break passes the goldens. Pinned since 2026-10-24 by `test_broad_parity.py::test_respect_circuits_hands_the_engine_masks_for_the_fill_session` (masks built for the fill session and handed to the engine; none when off). | Open: a scenario where a lock blocks a fill would still be the real guard; deferred 2026-10-22 when it was thought one scenario guarded it, so worth re-asking the owner. |
| F4 | **No scenario makes `max_category` bind**, so a broken group cap would pass. | Same kind of hole. | Open. |
| F5 | The payload has nulls in the newest week (`holdings_count`, often `idle_share`; the engine never trades its newest week). Before the F1 fix, all-cash weeks had nulls too. | Charts must treat null as a gap in the last point. | Only the newest week may be null; the test now says so. |
| F6 | **A Broad backtest at a past date depends on data after that date** (2026-10-24, `docs/lookahead-requests-2026-10-24.md`). Running the followed strategy and the Phase 6 ensemble at three cut dates on today's database and on a copy holding nothing later gives different ranks, different trades in the ensemble and, in 24 of 24 pairs, some difference. Two causes, isolated exactly: the `voladj` z-scores run over every column of the frame, including stocks that are in it only because a later year's `turnover_rank` list holds them; and a column that is stale at the end of the data is forward-filled over its whole length, internal gaps included. | CAGR moves by up to 0.12 points for the followed strategy (one extra trade in one sleeve at two cuts) and up to 1.03 points for an ensemble sleeve, both signs. Max drawdown up to 0.21. No effect on the live Friday signal. Every historical Broad figure carries it. | **Fixed 2026-10-25 (owner: "fix F6"), branch `fix/momentum-f6-point-in-time-ranking`; merged 2026-10-28 (`778ba02e`).** Cross-section = the week's point-in-time members behind the gate, also for the stock tilt; only the tail after a stale column's last price is forward-filled (Broad only). `mbt audit lookahead-requests`: 24 of 24 pairs identical. Levels moved: followed strategy 42.93% to 35.03%, worst fall -30.8% to -36.9%; `docs/lookahead-requests-2026-10-24.md` has every strategy. Eight Broad goldens accepted. |
| F7 | `_compute_pool_membership` gave the weeks before the first quarter-end that quarter's pool, decided with later ranks. Unreachable with a 52-week lookback (those weeks have no rank). | None on any saved favourite (identical results on all 7 distinct lookback/score settings, live data, end 2026-10-16) or on a golden scenario. | **Fixed 2026-10-24**: those weeks have no pool. Two unit tests in `test_broad.py`. |
| F8 | **A holding can end a week a few thousandths over `max_position + cap_band`.** The trim check runs on the week's value before that week's buy costs are paid. Seen once F6's fix moved the frozen results: ADANIENT#2 at 20.004% against 20% in `broad_category_mode_off`, the week after it drifted from 18.85%. | Costs are a few basis points of the portfolio. | **Documented in the invariant** (`COST_SLACK = 1e-3` in `test_invariants.py`), no engine change. Anything larger is still a failure. |

`tax` on a Broad request is accepted and ignored (documented in `api.py` and `IGNORED_FIELDS`);
the wiring test lists it as inert with that reason.

**Phases 3 and 4 against what BL-052 built.** BL-052's `saved_identity` already stores, for every
run, the data version (catalog tables, lake files, input files) and the code commit, and labels a
moved result `data_revised`, `intended` (a same-dataset accepted golden change lies between the
commits), `check` or `not_reproducible`; a favourite that is `not_reproducible` sends a Telegram, and
`check` shows in the alerts bell. That delivers the intent of Phase 3 and half of Phase 4. What it does not do:

- the three catalog columns this item names (`code_version`, `date_from`, `date_to`) are still empty;
  the stamp lives in the run's summary instead;
- the data fingerprint is per table, not per instrument, so a restated old price is named only as
  "a table changed";
- there is no pinned end date, so every Friday's new week reads as `data_revised`, and a restated
  history hides in that noise (this was the design point of Phase 4);
- `data_revised` and `check` send no Telegram.

**Proposal:** close Phase 3 as superseded by BL-052 (fill the three empty columns in one small
change, or drop them); re-scope Phase 4 to the one thing missing: a weekly check that re-runs each
favourite with the end pinned to its last accepted anchor and names the instruments whose history changed.

## Decisions (owner, 2026-10-22: "as per your recommendation")

- F1: apply the engine fix and accept the changed frozen results. Done.
- Phase 3: closed as superseded by BL-052. The three empty catalog columns (`code_version`,
  `date_from`, `date_to`) are dropped from scope; the stamp stays in each run's summary.
- Phase 4: re-scoped to the one missing piece, a weekly check that re-runs each favourite with its
  end pinned to the last accepted anchor and names the instruments whose history changed. Built
  2026-10-28 as the history check only (see Phase 4 as built).
- F3 and F4 (a second scenario where a circuit lock changes a fill, one where `max_category` binds):
  **deferred (owner, 2026-10-22, "as per your recommendation").** The live strategy's fills and caps work
  today; the gap is that the tests would not notice a future break. Revisit when the engine is next
  changed in those areas, or when the fixture is next rebuilt (it is at 14.7 of its 15 MB).

## Open questions for when this resumes (2026-10-22)

1. ~~F1~~ answered above.
2. ~~F3 and F4~~ deferred, see Decisions.
3. ~~Phases 3 and 4~~ answered above.
4. The original Phase 4 questions 2 to 4 (hold a signal on a "same data, different result" alert,
   the anchor date, the badge) matter only when the re-scoped Phase 4 is started.
   (2026-10-28: they move to BL-177 with the pinned re-run.)

## Phase 4 as built (2026-10-28, owner: "history check only")

- `mbt verify history` (`src/momentum_backtesting/verify.py`, built 2026-10-24): per instrument and
  calendar year, a row count and an order-independent hash of every `momentum_prices` row, every
  stock daily bar in the lake, every corporate action and the two stock-action review tables, up to
  an anchor Friday (the last Friday at least 14 days back, so the Fyers top-up's stopgap rows for the
  newest week are never inside it). The baseline is `history_baseline.json` in the Momentum state
  folder (`data/`), every event appended to `history_baseline_log.jsonl`. A clean check whose anchor is
  more than 28 days behind moves it forward; a change is never accepted without `--accept --reason`.
- **Exit codes:** a change exits 0 once its own Telegram is delivered (`notify.deliver`; the message
  is the alert, the same rule as `mbt live-rules check` on a breach), so the scheduler does not alert
  twice. A change that reached nobody (no `--send`, Telegram off or unreachable) exits 1, as does a
  check that cannot run (also sent). A missing baseline file is refused while the log shows an earlier
  one (re-recording it would accept every change since); a baseline recorded under `--send` is
  messaged. Tests in `tests/test_verify.py` (from the PR #365 review).
- **Scheduled:** job `momentum-history`, Fri 22:00 IST (after the 19:30 stock sync's two-hour window
  and the 21:00 / 21:30 checks), `catalog` group, `alertsItself`, one retry 10 minutes later.
  Replaces the plan's "appended to the 19:30 LaunchAgent": the per-job plists are gone (BL-012).
- **Not built:** the per-favourite re-run with the end pinned to the anchor (the data changed /
  result same or changed table above) → [BL-177](BL-177-momentum-favourite-pinned-rerun.md), with
  open questions 2 to 4.

## Log

- 2026-10-04 — created from the planning conversation. Priority P0 (protects result
  correctness). Baseline and enforcement questions answered. Status `Planned`.
- 2026-10-05 — started. Phases 1 and 2 built: 16 scenarios frozen, coverage test, look-ahead
  test (passes on all four datasets at three cut dates; fails on a planted `shift(-1)`), accept
  script with a changelog, pre-push hook. A changed cost constant trips five scenarios.
- 2026-10-22 — Phase 2's missing pieces built and run: always-true checks (all pass on the frozen
  results once the engine's documented limits are written into them), nightly reverse-order
  re-run (passes), every-setting-wired (nine setting/scenario pairs could not be proven and are listed as inert with
  reasons; the first version compared the whole response and missed a setting the payload echoes, fixed after review). Five findings F1 to F5 above. F1 reproduced by a strict-xfail test; the fix waits for the owner.
  Gap analysis of Phases 3 and 4 against BL-052 written above.
- 2026-10-22 — owner: "as per your recommendation". F1 fixed in `engine.py` (three golden scenarios
  accepted: equity, CAGR and trades unchanged; idle share, holdings count, time in cash and the cap
  figure moved). Phase 3 closed as superseded by BL-052; Phase 4 re-scoped. F3 and F4 still open.
- 2026-10-22 — owner: F3 and F4 deferred as recommended; no work.
- 2026-10-24 — nightly CI red since about 2026-10-19: `test_every_setting_a_scenario_changes_changes_its_result`
  flagged `broad_monday_open::broad_respect_circuits` (the scenario BL-036 Phase 2 added). Not a wiring
  gap: a Monday-open run builds its lock masks for the first session (`api._run_broad`, `session="first"`),
  and no lock in the fixture falls on a name the ranking ranks that week (checked against the masks; a
  planted lock on a bought name moves the CAGR, so the path works). Listed in `INERT` as `LOCKS_IDLE`. The
  PR #314 review found F3 was wrong: no golden scenario depends on the setting
  (`broad_gates_loosened_and_tilted` sets the default and is identical either way). F3 corrected above;
  a unit test now pins the wiring (`test_broad_parity.py`).
- 2026-10-24 — owner asleep; non-blocking work done on branch `verify/momentum-gaps`. (1) `mbt audit
  lookahead-requests` runs whole requests (saved favourites, frozen configs) through the real API on
  the live database and on a cut copy: it covers `turnover_rank` and the followed strategy, which the
  golden test and `mbt audit lookahead` do not. First live run, 2 groups x 4 sleeves x 3 cuts: all 24
  pairs differ, by up to 0.12 CAGR points (followed) and 1.03 (ensemble): finding F6. (2) First-quarter
  pool leak confirmed in a unit test and fixed (F7), no result moves. (3) Phase 4's detector built:
  `mbt verify history` fingerprints every price series, stock bar and corporate action up to a fixed
  anchor Friday and names each instrument whose history changed; 3 s on live data; not scheduled, and it
  does not re-run any strategy (so it says what changed, not whether a result moved).
- 2026-10-25 — owner: "fix F6" (rank over the week's point-in-time members and gate only, forward-fill only the stale tail, re-accept the goldens, re-measure). Done on `fix/momentum-f6-point-in-time-ranking`: `engine.compute_ranks(cross_section=)`, `broad.cross_section_mask`, tilt ranking and live preview use it; Broad frame fills only the tail. Cut-off check 24 of 24 identical (it first found the stock tilt still ranking the whole frame). Eight Broad goldens accepted (-3.44 to +0.35 points). Live re-measure of every favourite in the doc: the followed strategy loses 7.9 points of headline CAGR and 6 of drawdown depth, its lot 1 trades differently this Friday. F8 (cost-sized cap overshoot) logged. Not merged: the owner decides when, because the next Friday's orders change.
- 2026-10-28 — F6 merged (owner): PRs #318, #319, #322, merge commit `778ba02e`. On the merge's
  live re-measure the followed strategy's backtest (Four Sectors Monthly, No Tilt · all Fridays) went
  from 43.2% to 35.3% CAGR, and the blend's worst fall from -27.0% to -34.8%, in April 2020. The search
  re-run on the fixed ranking is BL-176; the live-rules drawdown thresholds are BL-025's to revisit.
- 2026-10-28 — owner: Phase 4 = the history check only. `mbt verify history` now exits 0 on a change
  once its Telegram is delivered (the message is the alert) and is scheduled as `momentum-history`, Fri 22:00 IST; the first baseline
  is written once from the main checkout after the merge (owner-approved). The pinned favourite re-run
  is BL-177 (P2). F3 and F4 stay deferred (owner, 2026-10-22). Status `Done`.
