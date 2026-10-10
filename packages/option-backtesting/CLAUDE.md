# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working in this package.

For design decisions and accepted deviations from the original handoff spec,
see this package's own `DECISIONS.md` and `README.md` first — this file
stays a short orientation pointer plus the cross-package/utility-function
summary those don't cover. For the full annotated module tree, see the root
`.claude/project/technical.md`'s Repository Structure section.

## What this package does

Python 3.12/uv strategy-research workbench over AlgoTest option bars,
answering "is this strategy worth becoming a personality?" — feature-complete
end to end (M-0 through M-5): data layer, pydantic-validated YAML strategy
DSL, a bar-by-bar event engine golden-fixture-verified to the rupee, a
loopback-only FastAPI service + MCP server (`obt-mcp`), a Fastify proxy, a
React dashboard tab, walk-forward analysis, parameter sweeps, a CSCV/PBO +
deflated-Sharpe overfitting guard, a margin model, regime bucketing, and
personality export.

## Cross-package links — the important, non-obvious one

**`packages/market-reference` (TypeScript) reads this package's reference
data directly off disk**, not through any API or import: `data/reference/
lot_sizes.csv` and `strike_step.csv` under this package's own `src/
option_backtesting/` are read by `market-reference/src/loader.ts` via a
relative filesystem path, because `uv` ships these CSVs as package data
inside this package's wheel and a second copy elsewhere is exactly the kind
of drift this whole arrangement exists to prevent (`apps/server` once
hard-coded NIFTY's lot size at 50 while these CSVs said 65 — see that
package's `CLAUDE.md`). **Editing these two CSVs changes what
`market-reference` returns immediately, with no version bump on either
side** — always run both packages' tests when touching them.

Otherwise:
- `apps/server` talks to this package only through its Fastify proxy over
  HTTP (`BACKTEST_API_URL` → the FastAPI service on `127.0.0.1:8000`) —
  never imports it as code. The proxy is the only public-facing surface in
  front of it; this service must stay loopback-only.
- Shares **no code** with `packages/momentum-backtesting` — separate
  `pyproject.toml`/`uv.lock`, no cross-imports. See that package's
  `CLAUDE.md` for the one (non-functional) connection between them.
- The `obt-mcp` MCP server is registered in the root `.mcp.json`; a Claude
  Code session picks it up automatically.

## Utility functions / key modules worth knowing before you duplicate one

- `config.py` — `BACKTEST_DATA_DIR`-derived Parquet bar cache path
  resolution, shared by `api/app.py` and `mcp/server.py`. Route any new
  cache-path resolution through this rather than hand-building one. The
  run registry has no path to resolve here any more — see `engine/registry.py`.
- `engine/registry.py` — the DSL engine's run history, in the shared
  `trading_data` catalog since 2026-09-30 (`package='options_dsl'`,
  `kind='dsl'`) — the same tables `legwise/store.py` and
  `momentum_backtesting/runs_store.py` use with their own package names.
  `RunRecord`/`strategy_hash()` are unchanged from the old
  `data/registry.sqlite` era; every caller (`cli.py`, `api/routes.py`,
  `mcp/server.py`) just passes a `trading_data.db.connect()` connection
  instead of a sqlite path now — no `--registry-db` flag any more, matching
  `legwise`'s env-var-only (`TRADING_DATA_ROOT`) convention. The bar cache
  below stays file-based on purpose — see `trading-data/DECISIONS.md`.
- `presets.py` — `preset_names()`/`STRATEGIES_DIR`, the allow-list both the
  API and the MCP server check **before** building a filesystem path (no
  traversal). Any new strategy-loading path must go through this.
- `data/resolver.py` — ATM/OTMn/ITMn/EXACT → concrete strike, independent of
  any data vendor.
- `data/cache.py` — the one DuckDB façade the engine reads; never query a
  provider directly from the engine.
- `strategy/mutate.py` — `deep_merge`, shared by `propose_strategy` and
  `sweep` — the one place strategy-dict merging happens.
- `engine/loop.py` — `SessionContext`/`build_sessions`/`simulate_session`/
  `run_backtest`, pinned to reproduce the original design handoff's
  reference implementation to the rupee. Read its module docstring before
  changing any formula.
- `engine/margin.py` — `classify_strategy_type` + return-on-peak-margin,
  the shared margin model every strategy type routes through.
- `export/personality.py` — `StrategySpec` → `PersonalityConfigM2`
  candidate; unrepresentable DSL constructs go under `manual_review`, never
  guessed, and this never writes to any database.
- `fyers/` — the daily 1-minute Fyers collector (`obt fyers status|fetch`): `auth.py`
  (token resolution — dashboard `broker_tokens` when `DATABASE_URL` is set, then env,
  `FYERS_TOKEN_FILE`, then **reads `packages/momentum-backtesting`'s `mbt login` token
  file off disk**, same JSON shape, no code import), `client.py` (throttled
  history client), `symbols.py` (public symbol master), `daily.py` (range + adaptive-width
  collection into `packages/trading-data`'s store — instruments registered, bars in the Parquet
  lake, raw responses in `raw/fyers/`, one `ingest_runs` row per call; `obt fyers migrate` moved
  the old `data/fyers/` layout in). Forward-only — see `DECISIONS.md`.
- `rotation/` — the options rotation's forward paper journal (BL-058): `lists.py` (the registered lists
  A / B / C / REF, never edited after the first entry), `score.py` (a port of research/bl057/rotate.py's
  ranking, numpy only; `scripts/rotation-parity.py` must print PARITY OK), `update.py` (nightly one-day
  run of the 298 variant files in `strategies/rotation/` (the 248 original plus 50 Dir ITM1, BL-080), loading each index's day once), `store.py`
  (per-variant CSVs and `days.csv` under `TRADING_DATA_ROOT/rotation/`, not the catalog),
  `journal.py` (insert-only SHA-256 chain, one entry per day), `pick.py` / `live.py` (the 09:16 entry
  from the 09:15 VIX open read live from Fyers, polled, with Angel One as the unattended fallback, and the days to expiry of the listed contracts from Fyers' symbol master, calendar as fallback; the entry records `vix_source` / `dte_source`, the universe size + hash and `inputs_sha`, a digest of the stored results and day rows it was scored on), `series.py` (BL-090:
  which strategies have daily results now — variant CSVs plus saved legwise results at the file's current
  version — and the selectors `slot:` / `family:` / `index:` / `kind:` / globs / `a+b` that name them; nothing
  is a fixed list, so a new strategy is found once it has results), `cli.py`
  (`obt rotation update|pick|verify|show|readout|base|triggers|triggers-show|corr|corr-list|corr-pick`), `triggers.py` (BL-083: the four intraday triggers scored forward each evening from the day's bars,
  event and placebo simulations in `rotation/triggers/`; run by `obt rotation update`, isolated so a
  failure never fails it, and `obt rotation triggers|triggers-show`;
  `scripts/rotation-triggers-parity.py` must print PARITY OK). Weekend sessions are excluded from the ranking history, as
  in the research (the Budget Sunday once shifted every later pick).
- `rotation/base.py`, `rotation/readout.py` — the owner's fixed base reference (BL-058 amendment 2026-10-10: 2 x
  Widesl OTM1 09:17 = the variant `N_wide_0917`, plus 1 x Dir ATM 09:24 from `strategies/rotation_base/`, outside
  the 298 universe; its Dir results in `rotation/base/`) and the read-out (per list ₹ per lot-day, drawdown,
  random same-shape percentile, list minus REF and minus base by a circular 5-day block bootstrap, 2,000
  resamples, seed 20261012). Read-only over the journal; `obt rotation readout | base`.
- `legwise/` — AlgoTest-style leg-wise engine over the Fyers data (`obt legwise run
  strategies/legwise/*.yaml`): `schema.py` (one field per AlgoTest setting), `market.py`
  (a day on the 375-minute grid), `engine.py` (the state machine — its docstring lists every
  1-minute-bar assumption), `report.py`, `daily.py` (the evening run's steps), `evening.py` (`run_daily` — the ONE evening
  routine, collect → `refresh_day` → run → summary/Telegram, called by both `obt daily` and the
  dashboard's `POST /legwise/daily` job; add a step here, never in one caller), `store.py` (strategies, versions and
  results in the trading-data catalog — a version is a hash of the validated spec). Separate from `engine/` on purpose — see `DECISIONS.md`.
  Also `anatomy.py` (per-day, per-segment index shape — QUIET/CHOP/TREND from spot + India VIX, descriptive only: lag it a day before using it for anything actionable; `DTE_RELIABLE_FROM` guards a wrong pre-Sep-2025 expiry calendar) and `forensics.py` (one saved day re-simulated for the dashboard; `DayResult.mtm` is the per-minute curve, never persisted). `fyers/history.py` backfills index + VIX history (`obt fyers history`).
- `notify.py` — Telegram sender (TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID), a deliberate copy of
  `momentum-backtesting`'s notify.py mirroring `@trading/notify`'s contract (never `parse_mode`,
  redacts known secrets, never raises; prints when unconfigured). Tests must stub `send` —
  `load_dotenv()` would otherwise pick up the real bot token from the repo `.env`.
- `api/legwise_routes.py` — `/legwise/*` on `obt-api` for the dashboard's Options Lab: `/day` and `/anatomy` (see above; `/anatomy` also overlays apps/server's T-33 `daily_regime_tags` as `t33` when `DATABASE_URL` is set in this process, with an explicit status), list/
  validate/save strategies (slug-checked name, `yaml.safe_dump` of the validated model — never
  raw client text), ad-hoc backtest over collected days, saved results, data/token status, and
  the evening run as a background job. Errors are `{"error": ...}` (what the dashboard reads).
- `api/correlation_routes.py` — `/legwise/correlation/available`, `/legwise/correlation` and `/legwise/correlation/pick`
  (BL-090, the Options Lab's Correlation tab): thin wrappers over `analytics/correlation.py` and
  `rotation/series.py`, so a figure is computed in exactly one place. Selectors are validated by pattern and
  matched only against enumerated strategy names; at most 80 strategies per request; the strategy list is
  cached for 30 s. Errors are `{"error": ...}`.
- `rotation/matrix.py` + `api/rotation_matrix_routes.py` — the Options Lab's Matrix tab (the Strategy Matrix, read-only):
  `GET /legwise/rotation/matrix` (views `family_slot` / `date_slot` / `dte_slot` / `vix_family` / `weekday_family` /
  `pulse`; metrics `avg` / `win_rate` / `stop_rate` / `worst` / `selection`; periods P1, P2, P3 (returned as
  `unavailable`: not in the store), `forward`, `custom`; `compare=P1,P2` returns both grids on one scale plus the
  difference) and `GET /legwise/rotation/matrix/cell` (daily values, running total, pooled variants with their
  settings). Reads `rotation/results/*.csv`, `days.csv` and the journal and writes nothing. Gross per ONE-lot
  strategy-day, pooled as mean / rate / worst, never summed; `n` is distinct sessions, a cell under `min_n`
  (default 20) is flagged `thin`, never hidden; a missing value is `missing` / `excluded` / `na`, never zero.
  The selection overlay is journal entries only (late entries excluded from selection statistics); picks are never
  reconstructed. Rows of `family_slot` are the 12 index x family tags found in the store (NIFTY wide / p80 / p100 /
  dir / ditm1 / buy, SENSEX wide / p250 / p320 / dir / ditm1 / buy); `wide` is OTM1 on NIFTY and OTM2 on SENSEX,
  read from the strategy file for the label. The loaded cube is cached on the files' size and mtime.
  Saturday / Sunday sessions are left out and counted (`weekend_excluded`), as in `store.load_matrix`. A cell and its
  drill-down both come from `pool_mask`, so they cannot disagree. The pulse is as of one day (period id `asof`),
  its windows are the last N sessions that match the conditions, and `n_trades == 0` days are counted (`zt`), not dropped.
- `analytics/correlation.py` — BL-090: Pearson / Spearman of strategies' daily 1-lot P&L, loss-day
  overlap and loss-day correlation, equal-lot basket drawdown against the sum of the parts, rolling
  drift, a leaf order that clusters look-alikes, and `pick_diverse` (a basket under a correlation cap).
  numpy only. Every figure is in-sample over the window given; a trailing matrix for a research replay
  is `analyse(end=day_before)`.
- `analytics/regime_source.py` — reads `daily_regime_tags` from Postgres,
  gated on `DATABASE_URL` being exported in *this process* specifically (not
  just present in a `.env` the server reads) — see the root `technical.md`
  Gotchas for the exact silent-omission failure mode. With it set, a database
  that is down (`connect_failed`) or lacks the table (`missing_table`) raises
  `RegimeSourceUnavailable`; `features/regime.py::regime_bucket_status` turns that
  into an absent regime section plus a status (CLI line, `regime_status` /
  `regime_message` on `POST /runs`, `regime_status` in the MCP `run_backtest`
  output, `t33.status` on `/legwise/anatomy`). Any other query error still raises.

## Commands

See root `technical.md`'s Essential Commands for the full reference. From
`packages/option-backtesting/`:
```bash
uv sync
./scripts/build-cache.sh   # REQUIRED on a fresh clone before pytest
uv run pytest
uv run obt run strategies/B_pyramid.yaml --from YYYY-MM-DD --to YYYY-MM-DD
uv run obt fyers status                 # token source + data dir
uv run obt fyers fetch                  # today's 1m data — run the SAME evening
uv run obt fyers history                # backfill NIFTY + VIX index history (any time)
uv run obt legwise run strategies/legwise/*.yaml [--from D] [--to D] [--trades] [--include-excluded] [--bars 5m]
uv run python scripts/parity-5m.py --from D --to D   # same strategies on 1m vs 5m bars: agreement + timing
uv run obt daily                        # evening routine: fetch + judge the day + derived tables + run strategies/legwise + summary (verdicts, IV percentile)
uv run obt legwise rerun                # re-run every strategy over every collected day (after an edit)
uv run pytest tests/golden/test_legwise_scenarios.py  # 30 frozen-input leg-wise regressions
uv run python scripts/update-legwise-goldens.py       # check snapshots; writes nothing
```
