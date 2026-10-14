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
- `angelone/` — the Angel One SmartAPI collector (BL-078/BL-079; `obt angel status|fetch`), the
  fallback when no Fyers token is valid. A drop-in client for `fyers.daily.collect_day`
  (`source="angelone"`): `auth.py` (REST login with `ANGELONE_API_KEY` / `_CLIENT_CODE` / `_MPIN` /
  `_TOTP_SECRET`, one attempt, never retried), `symbols.py` (Fyers contract -> Angel token by
  underlying/expiry/strike/side; instruments keep their Fyers identity), `client.py` (volume
  lots->quantity, no-trade minutes carried forward, OI from `getOIData` for NFO only, the index
  gap 15:15-15:28 flagged not filled; what was missing lands in `ingest_runs.details.flags`).
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
  `send(..., chat_id=...)` supports an explicit destination for the rotation pick's group copy;
  its environment configuration lives in the root `technical.md`.
  Rotation messages use `rotation/list_names.json` (also imported by the dashboard) for
  display names, and omit Baseline / VIX / days to expiry from the text; the journal still stores them.
  `rotation/result.py` reads the completed picked variants' net results (after estimated costs),
  reports one lot per strategy with every picked strategy's contribution under its section, and
  sends Steady / Calendar / Adaptive after the evening pipeline finishes (normally around 16:00).
  A per-entry marker prevents a retry from sending it twice;
  `obt rotation result --force` explicitly resends it.
- `api/legwise_routes.py` — `/legwise/*` on `obt-api` for the dashboard's Options Lab: `/day` and `/anatomy` (see above; `/anatomy` also overlays apps/server's T-33 `daily_regime_tags` as `t33` when `DATABASE_URL` is set in this process, with an explicit status), list/
  validate/save strategies (slug-checked name, `yaml.safe_dump` of the validated model — never
  raw client text), ad-hoc backtest over collected days, saved results, data/token status, and
  the evening run as a background job. Errors are `{"error": ...}` (what the dashboard reads).
- `api/correlation_routes.py` — `/legwise/correlation/available`, `/legwise/correlation` and `/legwise/correlation/pick`
  (BL-090, the Options Lab's Correlation tab): thin wrappers over `analytics/correlation.py` and
  `rotation/series.py`, so a figure is computed in exactly one place. Selectors are validated by pattern and
  matched only against enumerated strategy names; at most 80 strategies per request; the strategy list is
  cached for 30 s. Errors are `{"error": ...}`.
- `rotation/daylog.py`, `rotation/placements.py`, `api/rotation_log_routes.py` — the rotation daily
  log (BL-058 Phase 4): `GET /legwise/rotation/log` (one row per journal entry, plus every trading day
  since the registered first day with no entry as `not_recorded`, plus structural counters),
  `/day/{day}` (the four baskets in full, chain, re-score check, placement rows), `/placement`,
  and `/forensics?variant=&day=` (one variant's day re-simulated with `update.py`'s own call and
  `SIZING_DATE`, for the Day forensics view, with `rotation.matches_stored`).
  Read-only over the journal and results; `source=reconstructed` re-scores research-history days
  with `pick.score_history` (the function the 09:16 job calls), labelled and never counted as
  forward. The only write is `placements.append`: a row to the separate append-only
  `rotation/placements.jsonl` (`{day, list, status, note, at}`, a later row supersedes in the view,
  earlier rows kept, validated against the journal; a row identical to the list's current one is a
  no-op and `POST` answers `written: false`; an unreadable line is skipped and counted), a file
  nothing else reads. A day with a pick
  lacking a stored result is `waiting` and its gross is withheld, never zero. Tests build a store
  through the real `pick.record` (`tests/unit/rotation_synth.py`);
  `scripts/rotation-daylog-demo.py` serves the same synthetic store on :8123 for a look at the
  dashboard before the journal has real entries; it refuses the real data root and any root with a
  `rotation/` directory it did not build (marker file).
- `rotation/shadow.py` + `api/rotation_shadow_routes.py` — the Shadow scoreboard (BL-083 forward shadow;
  `GET /legwise/rotation/shadow?from=&to=`), read-only over the journal, `rotation/results/` and
  `rotation/triggers/`. Forward = sessions from 2026-10-12 (BL-058). Three parts, every figure an event minus a
  comparator: `triggers.summary(since=)` per trigger x template beside BL-083's research numbers (constants, quoted
  from its tables and checked against the backlog text by a test); the Dir at the event minute minus the list's next
  not-yet-started core pick (the earliest T1 / T4 event of the day, pick starting >= 15 minutes later, Widesl
  minimum kept), per day with a status (scored / pending / not_applied / late_entry / no_entry: a day without the
  displaced pick's stored result is pending, never zero), with the time-matched placebo Dir as its control line
  (BL-083's random-minute control is not in the trigger files, so it is reported `not_recorded`); and BL-081's two
  forward candidates returned `not_scored` with their definitions (no nightly scoring exists for them).
- `rotation/drawdowns.py` + `api/rotation_drawdowns_routes.py` — "Drawdown episodes" (BL-058 Phase 4 widget 8;
  `GET /legwise/rotation/drawdowns?list=A|B|C|REF&window=P1|P2|last63|forward&min_depth=500`), read-only. The series
  is a list's gross per lot-day from `daylog.build_log(source="all")` (recorded entries, and re-scored days before
  the journal began, counted apart; a late, unscored or missing day is left out and counted). Underwater = cumulative
  minus its running peak, the peak starting at zero (`readout.max_drawdown`'s convention); an episode runs from the
  day after a peak to the day back at it (or the last day, `open`) and is listed when at least `min_depth` per lot
  deep; each carries the fixed base's per-lot sum over the same peak-to-trough days (`base.base_per_lot`, missing
  days counted, never zero), the stops, and drivers by family x start band that add up to the depth.
  `rotation/history.py` keeps the built daily log for 30 s per span (`P1`, `P2`, `recent` = P1's start to the
  latest day) so a change of list or depth does not rebuild it; cards that read a list's history share it.
- `rotation/drift.py` + `api/rotation_drift_routes.py` — "Selection drift" (BL-058 Phase 4 widget 9;
  `GET /legwise/rotation/drift?list=A|B|C|REF`), read-only over `history.daily_log(root, "recent")`. The list's core
  picks (3 a day; a late entry or a day with no entry is not a session) counted by family (Widesl / Dir), index,
  strike method (OTM1 / closest premium / Dir ATM / Dir ITM1) and start band, over P1 (re-scored), the last 63 and
  the last 21 sessions; a last-21 share is flagged `above` / `below` only outside the 10th-90th percentile of the
  list's own rolling 21-session shares over P1 (no band under 10 windows, nothing flagged under 21 sessions); the
  concentration rows (distinct variants, most-picked, one-start-band days, Widesl-minimum days, Buy days) use the same
  yardstick. Picks, not P&L; descriptive only.
- `rotation/portfolio.py` — the basket under a portfolio MTM stop (BL-095; routes: `GET /legwise/rotation/portfolio/day|days`, `api/rotation_portfolio_routes.py` over `rotation/portfolio_log.py`, proxied at `/api/backtest/legwise/rotation/portfolio/*`; `stop` empty/0/below = none, `trail` = `sl:X,Y` | `lock:A,B` | `locktrail:A,B,X,Y`, malformed = 422; one-lot paths cached per root, day, pick and a stamp of everything the replay reads (`portfolio._stamp`: `CACHE_VERSION`, `SIZING_DATE`, the strategy file, the reference CSVs, the day's option / index / VIX bars and symbol master), with one replay per key at a time; replayed paths are also kept in `~/.cache/ai-trading-agent/portfolio-paths/<root hash>/` (`ATA_PORTFOLIO_CACHE_DIR` overrides it), so an API restart is not cold, and `obt rotation portfolio-warm` fills it ahead of the first view — the whole P1 window is ~3.5 min cold, ~2 s from the cache. Bump `CACHE_VERSION` when a code change alters what a path is. A cold `/portfolio/days` and `/rotation/drawdowns?stop=` run in a background thread (`rotation/warm.py`) and answer within 20 s (under the Fastify proxy's 30 s): `/days` is `202 {"status":"warming"}`, `/drawdowns` the registered figures with `with_stop_pending: true`; the dashboard asks again, the work fills the cache; `/portfolio/day`'s `source` is a filter (`recorded` / `reconstructed` / `all`, default `all`: the other kind is a 404). `GET /legwise/rotation/drawdowns` also takes `stop` / `trail` and returns the series run through the stop under `with_stop` and `per_lot_with` / `underwater_with` per day, beside the registered figures (`drawdowns.build(..., portfolio=(stop, trail))`). `apply_book(members, stop_inr, trail)`
  sums each pick's one-lot path (0 before it starts, its MTM, then its gross) times its lots; the first minute the sum is
  at or below the level every pick closes at that minute's close and nothing else enters. `stop_inr` empty, 0 or below is
  no stop. `Trail`: `sl:X,Y` (every X of profit moves the stop Y), `lock:A,B`, `locktrail:A,B,X,Y`; the level never moves
  down. `book_day` replays the nightly update's own strategy file and lot-sizing date. Reproduces BL-055's totals
  (`research/bl095/reproduce_bl055.py`) and the log's gross with no stop (`research/bl095/check_log_gross.py`). Stores
  nothing and never changes a stored result or the registered read-out.
- `rotation/basket.py` + `api/rotation_basket_routes.py` — the Correlation tab's "A day's basket" preset (BL-058
  Phase 4 widget 6; `GET /legwise/rotation/basket?list=A|B|C|REF|BASE&day=&window=P1|P2|last63|forward|custom`),
  read-only. A list's picks for a day are the journal entry's when there is one, else `daylog.reconstruction`'s
  (the same `pick.score_history` the 09:16 job calls), labelled `recorded` / `reconstructed`; `BASE` is
  2 x `N_wide_0917` + the Dir ATM 09:24 leg from `rotation/base/` (the Widesl listed twice, so the basket is
  2 W + D). The figures are `analytics/correlation.analyse`'s, over one window; a Forward window is the on-time
  days themselves, not the date range they span (a late or missing day between two is not forward). Under 5
  common days there are no figures (the reason says how many days), under 20 they are flagged thin.
- `rotation/regime.py` + `api/rotation_regime_routes.py` — "Forward days vs research periods" (BL-058 Phase 4
  widget 7; `GET /legwise/rotation/regime`), read-only. Per period (P1, P2 from `matrix.NAMED`; the forward window =
  the on-time journal entries' own recorded attributes; P3 reported `unavailable` with the reason): the share of
  weekday sessions by opening VIX band, NIFTY and SENSEX days to expiry (0..3, 4+) and weekday; the VIX open and each
  index's day range ((high - low) / open, from the lake's 1-minute index bars, computed at request time, cached in
  process, never written) as P10 / P50 / P90; and the total-variation distance from forward to each research period
  per row, with a 0.05 tie band. A bar file that cannot be read costs that day's range only. Describes; tests nothing.
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
- `rotation/pulse.py` + `api/rotation_pulse_routes.py` — the Rotation page's Family pulse (widget 11, read-only):
  `GET /legwise/rotation/pulse?as_of=&list=&index=`. The 12 cells the family-band criterion pools ({Widesl incl.
  closest-premium, Dir incl. Dir ITM1, Buy} x start band), grouped by `score.family_index` (a run-time check refuses to
  answer if `pulse.cell_of` and `family_index` ever disagree). Cell means are `matrix.pool_mask` / `summarise` over the
  matrix's cached cube (last 5 / 21 / 63 sessions, P1, P2; gross, one lot, a mean, sessions and variants beside it);
  "ranking sees" is `score.recent_score` of the NET history averaged by `family_index`, the value `score.composite` makes
  `crit["rfam"]`, ranked 1-12 (equal to Why this pick's Family-band recent; a test holds them equal). The flag is
  the latest full 21-session mean outside the P10-P90 of the cell's own rolling-21 means whose windows lie inside P1 (needs 10, EPS tolerance, unrounded; the selection-drift card's rule). Chips are the
  next pick's recorded entry (else the latest; trusted chain only; a late entry is labelled) or, with no entry,
  `daylog.reconstruction`'s picks labelled reconstructed; the focus list's share is over its last 21 recorded on-time
  sessions, else the last 21 reconstructed ones, never mixed. `index` narrows the means, never the rank.
  As-of is the last COMPLETE session (every variant stored; a part-stored day is reported under `store.partial`
  and left out of windows and rank); the route's snapshot is keyed on the cube object plus the journal's stat, not a TTL.
  Journal figures are those on or before as-of. A stored variant outside the 12 cells is listed in `store.unplaced`.
- `heatmap/` + `api/heatmap_routes.py` — BL-094, the Options Lab's Heatmap tab (default page): the P&L of an ATM
  short straddle for every entry time (09:16, then each half hour to 14:45), exit (15:30, 15:15) and per-leg SL
  (10..100 %, then "No SL": no stop, both legs held to the exit; `grid.NO_SL`, stored as `sl = 0`). `grid.py` restates the legwise engine's fills for the fixed two-leg shape (a test pins every cell to
  `simulate_day`); indices take ATM from the index spot, a stock (no spot, no strike step, mostly no lot size in the
  lake) from put-call parity, so stock P&L is points per share and an index's is rupees per lot at today's lot.
  NIFTY and SENSEX use the nearest weekly, every other index and stock the monthly. `store.py` keeps one Parquet per
  underlying under `TRADING_DATA_ROOT/heatmap/` (incremental: a day stored without its `sl = 0` row is rebuilt by a plain build, and until then the No SL column
  reads empty, never zero; a file with an old column layout is rebuilt);
  `view.py` reads the three views (`time_sl`, `date_time`, `date_sl`), sums a date range, filters weeks to expiry
  and gives `value` or `pct`-of-premium; `obt heatmap build [-u X | --stocks] [--force] | show | list`;
  `evening.update_heatmap` adds each index's day inside `obt daily`, isolated.
- `analytics/correlation.py` — BL-090: Pearson / Spearman of strategies' daily 1-lot P&L, loss-day
  overlap and loss-day correlation, equal-lot basket drawdown against the sum of the parts, rolling
  drift, a leaf order that clusters look-alikes, and `pick_diverse` (a basket under a correlation cap).
  numpy only. Every figure is in-sample over the window given; a trailing matrix for a research replay
  is `analyse(end=day_before)`.
- `rotation/explain.py`, `rotation/rankic.py`, `api/rotation_explain_routes.py` — the Options Lab rotation page's
  "Why this pick?" and "Does rank predict results?" (read-only, never writes `rotation/`). `explain` REBUILDS a list's
  ranking for any day with 63 earlier days of stored results (the journal keeps only the picks and their composites)
  with the ranking's own helpers (`score.recent_score` / `skewed_fit` / `pct_rank` / `composite` / `select`): each
  criterion's raw value, percentile, weight and points, the matching days behind each fit per lookback window, the
  Widesl-minimum swaps, the best left-out alternative and why Buy did or did not qualify; for a journal day it must
  reproduce the entry's composites to 4 decimals and compares `inputs_sha` (`history_digest` is held equal to
  `pick.load_history`'s by a test). `rankic` is the daily Spearman between the morning composite over all 298 variants
  and the day's gross, per criterion too, one value per day with a running mean and 95% band; `forward` mode counts
  only entries made before the first entry time, `research` mode any window. `/legwise/rotation/explain` and `/ic`
  cache the loaded store for 30 s; errors are `{"error": ...}`. If `score.py`'s criteria change, `rank_day`'s
  consistency check against `score.composite` fails loudly rather than explaining a different ranking.
- `analytics/regime_source.py` — reads `daily_regime_tags` from Postgres,
  gated on `DATABASE_URL` being exported in *this process* specifically (not
  just present in a `.env` the server reads) — see the root `technical.md`
  Gotchas for the exact silent-omission failure mode. With it set, a database
  that is down (`connect_failed`) or lacks the table (`missing_table`) raises
  `RegimeSourceUnavailable`; `features/regime.py::regime_bucket_status` turns that
  into an absent regime section plus a status (CLI line, `regime_status` /
  `regime_message` on `POST /runs`, `regime_status` in the MCP `run_backtest`
  output, `t33.status` on `/legwise/anatomy`). Any other query error still raises.

- `research/bl102/` — BL-102, the full-factorial parameter sweep over the Widesl / Dir / Buy families:
  `grid.py` (the registered axes, cells and their SHA; `tests/unit/test_bl102_grid.py` holds the counts),
  `run_grid.py` (one job per cohort, resumable parts + day × cell series under `results/<tag>/`),
  `score.py` (gates, Martin / Calmar, the plateau rule, band tables), `robust.py` (numpy CSCV,
  half-years, bootstrap vs template, DTE / VIX / weekday strata, breadth over the 25 slots),
  `stage2.py` (the winners' neighbourhoods and the flatness verdict), `check_regression.py`. Research only:
  never writes a strategy YAML; the pre-registration is the backlog item's Phase 0.

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
