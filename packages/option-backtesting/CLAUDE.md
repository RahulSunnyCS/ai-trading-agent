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
  `check.py` + `api/angel_routes.py` — the one guard every Angel One login goes through except
  the 09:16 VIX fallback in `rotation/live.py`: the dashboard's Test connection (`POST
  /legwise/angel/test`: `begin` takes the lock and passes the guard, then the login runs in a
  background thread and the route answers 202 at once; the card reads the result from `GET
  /legwise/angel/status`), the 08:00 job (`obt angel test --scheduled`), and the collector
  (`check.session()` in `evening.collect_detailed`, holding the lock for the whole collection).
  A check is ONE `auth.login`, nothing fetched, the session dropped, never stored. The guard: an
  exclusive `flock` on `TRADING_DATA_ROOT/angelone/check.lock` (one login at a time, across
  processes; "running" is a non-blocking probe of it, `running.json` only names the holder; a
  manual test while it is held is 409), a 60 s cool-down from the attempt's END (manual = 429 +
  `retry_after_s`; scheduled and collector wait it out), and a refused login held 15 minutes for
  every source unless the `.env`'s ANGELONE_* values changed (`fingerprint`, a digest, never the
  values; 429 `kind: held`). The ANGELONE_* keys are re-read from the repo `.env` file on every
  check and status call, the file winning (`current_env`), because obt-api and the scheduler load
  `.env` once. Failures are classified (`not_configured` / `rejected` / `network` /
  `unavailable` (5xx, `AngelUnavailableError`) / `error`), messages pass `auth._scrub` (secrets
  longest first, the client code masked, then cut), and the last result, with the client masked
  (`R1•••56`), goes to `angelone/last_check.json`. The status lists the settings by name with a
  yes/no only, and the newest `ingest_runs` row with source `angelone` as the last collection.
  Tests fake the login; none sends a real one. `funds.py` (BL-143, `obt angel funds [--json]`): one login
  under the guard with source `margin` (`check.session(source=...)`), one `getRMS` GET, the account's free
  margin (`net`) for the 09:05 margin check; SmartAPI sessions are per API key and client (Angel's FAQ on
  AB1010), so this app's login does not replace Quantiply's (Angel's publisher login, its own key).
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
  (`obt rotation update|pick|verify|show|readout|base|triggers|triggers-show|corr|corr-list|corr-pick|track-readout`; `update`/`pick --track t1` run the BL-113 T1 parallel track: `strategies/rotation_t1/` variants named `<N|S>_<base>-t1s<set>_<HHMM>`, results and journal under `rotation/track_t1/`, never the live folder or chain — `variants.track_of`, `store.result_path`, `track.py`), `triggers.py` (BL-083: the four intraday triggers scored forward each evening from the day's bars,
  event and placebo simulations in `rotation/triggers/`; run by `obt rotation update`, isolated so a
  failure never fails it, and `obt rotation triggers|triggers-show`;
  `scripts/rotation-triggers-parity.py` must print PARITY OK). Weekend sessions are excluded from the ranking history, as
  in the research (the Budget Sunday once shifted every later pick).
- `rotation/base.py`, `rotation/readout.py` — the owner's fixed base reference (BL-058 amendment 2026-10-10: 2 x
  Widesl OTM1 09:17 = the variant `N_wide_0917`, plus 1 x Dir ATM 09:24 from `strategies/rotation_base/`, outside
  the 298 universe; its Dir results in `rotation/base/`) and the read-out (per list ₹ per lot-day, drawdown,
  random same-shape percentile, list minus REF and minus base by a circular 5-day block bootstrap, 2,000
  resamples, seed 20261012). Read-only over the journal; `obt rotation readout | base`.
  Display overrides for the Rotation page (owner, 2026-10-19), every default unchanged:
  `lots_per` (`readout.build`, `daylog.build_log|build_day`, `portfolio_log.days|list_day`,
  `drawdowns.build`'s stop replay) books every pick at that many lots, so rupee totals scale and
  per-lot figures, the random-basket percentile and the pass rule do not, and no entry's recorded
  `lots_per_strategy` is rewritten; `track="t1"` (`readout.build`, `daylog`, `portfolio_log`,
  `overview.baskets`) reads the T1 journal (list C only, Core-298 + the track's variants via
  `store.result_path`; no reconstruction, placements or re-score; missing days counted from the
  track's own first entry; `vs_ref` None, the gap to the fixed base kept). The fixed base can be
  booked under a portfolio stop (`portfolio_log.base_days|base_day`, `book=base`): picks
  [(`N_wide_0917`, 2 x lots), (`N_dir_atm_0924`, 1 x lots)], weekdays both legs are stored, from
  the registered first day; `portfolio.one_lot_path` accepts the Dir leg by its enumerated name
  (`portfolio.strategy_file` resolves it to `strategies/rotation_base/`, refused if its sha256 is
  not `base.BASE_YAML_SHA256`) and replays it with `base.score_days`' own call and sizing date.
- `rotation/expiry.py` — the expiring-index rule (BL-122, owner 2026-10-18): from `EXPIRY_ONLY_FROM` (Mon
  2026-10-19), on a day when exactly one index expires (weekday label `0`; both, neither or an unknown label =
  no rule), Adaptive (list C, live and T1) is a FILTER of the unrestricted ranking: `filter_picks` runs
  `score.select` over that index's variants only (Widesl minimum kept) and keeps the Buy add-on only when it is
  already on that index. `pick.record` passes `rule_index(day, dte)` to `score_history(..., expiry_only=)`; the
  entry gets `expiry_only` and list C's block `unfiltered` + `expiry_only` (omitted on other days, so those
  entries are unchanged). Everything that re-derives a recorded pick passes the entry's `expiry_only`
  (`daylog._rescore`, `explain`, `rankic`), `tomorrow.expected_picks` uses `rule_index(next session)`, and
  reconstructed history never applies it. Kill switch `ROTATION_EXPIRY_ONLY_FROM` (`YYYY-MM-DD` | `off`, read
  at call time; any other value makes the pick fail loudly).
- `legwise/` — AlgoTest-style leg-wise engine over the Fyers data (`obt legwise run
  strategies/legwise/*.yaml`): `schema.py` (one field per AlgoTest setting), `market.py`
  (a day on the 375-minute grid), `engine.py` (the state machine — its docstring lists every
  1-minute-bar assumption), `report.py`, `daily.py` (the evening run's steps), `evening.py` (`run_daily` — the ONE evening
  routine, collect → `refresh_day` → run → summary/Telegram, called by both `obt daily` and the
  dashboard's `POST /legwise/daily` job; add a step here, never in one caller), `store.py` (strategies, versions and
  results in the trading-data catalog — a version is a hash of the validated spec). Separate from `engine/` on purpose — see `DECISIONS.md`.
  Leg options off by default and left out of the dump at their defaults (no strategy gets a new version):
  `trail_peak: {activate_percent, exit_percent}` (bought legs, BL-164: once the premium has been above
  activate % of entry, out at exit % of its highest, reason TRAIL; with an SL on the same bar the higher
  level wins) and `stop_on: tick | close` (BL-164: `close` judges the SL, target and both trails on the
  bar's close and fills there). The `.algtst` and Quantiply exporters refuse both by name.
  `reverse_on_sl: {lots_ratio, stop_loss_percent, time_stop_minutes, trail_peak}` (sold legs, BL-186,
  research only): when the leg's SL fills, the same contract is bought at that fill as its own trade
  (`<leg>_rev`; ratio 1.0 or 0.5, a fractional quantity), with its own 30% stop by default, an optional
  time stop (exit at the price N minutes after the buy, reason TIME) and peak trail, else held to the
  exit; it counts in the overall MTM; a reversed leg is not re-entered, one reversal per leg a day;
  `_DaySim._reverse_allowed` is the hook a research filter overrides. Both exporters refuse it by name.
  Also `anatomy.py` (per-day, per-segment index shape — QUIET/CHOP/TREND from spot + India VIX, descriptive only: lag it a day before using it for anything actionable; `DTE_RELIABLE_FROM` guards a wrong pre-Sep-2025 expiry calendar) and `forensics.py` (one saved day re-simulated for the dashboard; `DayResult.mtm` is the per-minute curve, never persisted). `fyers/history.py` backfills index + VIX history (`obt fyers history`). `fyers/expired.py` repairs holes in the option lake from Fyers' expired-F&O API (`obt fyers expired-options`, 2026-10-21): it plans only the index sessions with no option file (`--all-days` to top up thin ones too), takes expiries and contract symbols from the API (never reconstructed), caches every contract's raw response under `raw/fyers-expired/` (reused only when it covers the requested window), merges by (instrument_id, ts) with existing rows winning, and merges a day only once every expiry it needs is cached (one partition write per day), so a stop anywhere never leaves a day with a file but short of an expiry (which `missing_only` would then skip). `client.response_state` classifies each response: `ok` / `no_data` / `permanent` (an allow-list: "invalid symbol" / "symbol not found" / "no data", on HTTP 200/400 only; cached and listed in `failed_contracts`, asked again only with `--retry-refused`) / `retryable` (everything unrecognised, network, 5xx, other 4xx; not cached; three in a row stop the run) / `blocked` (no subscription to the API, 401/403: stops) / `rate_limited` (stops). Refusals are held (run-wide, keyed by underlying and expiry; `fyers/expired.py`'s `_Fetcher`) and cached only once a later contract answers, or once a contract that answered before (`last_ok`, seeded from any cached `ok` in the plan) answers again when asked, at five in a row, at an expiry's end and at the end of the run. With nothing answered yet, a contract from the middle of the rest of the listing (nearest the money) is asked instead. If the contract asked is refused too, the run stops with none cached (`refused_streak`); with nothing to ask at all, the run ends `refused_unconfirmed` (exit 2). A transient error on that request leaves the refusals to the next run and counts toward the retry stop. A rejected token stops too (CLI exit 1; the other stops exit 2), and the days merged so far are judged and derived even when a run fails (topped-up days with `derived.rebuild(force_days=)`). Days whose expiry set may include one not yet expired (the API lists only expired ones) are listed as `days_short_of_unexpired_expiries` and held (in `pending_days`) unless `--allow-short`; ready days merge `MERGE_CHUNK_DAYS` (5) at a time, the symbol master before the partition; an undecodable listed symbol is skipped and listed. Ingest runs are recorded as source `fyers-expired`; after a repair, `obt legwise rerun` (and `obt rotation update --day D`) refresh stored results. `FyersClient(per_minute=, max_rate_limit_hits=)` is opt-in (Prime: stay under 10/s and 500/min; a second 429 raises `RateLimitedError`, because repeated per-minute breaches block the account for the day); `candles_from_response` reads an expired response's candles by `columns` name. Plan: Prime for the real run.
- `live/session.py` + `api/live_routes.py` — the Live page's data (BL-117 Phase 3; `GET /legwise/live/days` and
  `/session?underlying=NIFTY|SENSEX&day=`, proxied at `/api/backtest/legwise/live/*`), read-only. One day on the
  375-minute grid, trimmed to the last real index bar: spot, India VIX, the ATM strike of each minute, the **rolling**
  ATM straddle (CE + PE at each minute's own ATM, so it re-strikes) and the straddle **held** from the strike that was
  ATM at the 09:15 open, both on the nearest weekly expiry; a minute with no bar of its own is `None`, never carried
  (`market.load_day` forward-fills for the engine, so `_load` blanks those minutes again from the files' bar
  minutes, for spot, VIX and every leg); days to expiry are
  weekdays (`rotation/dte.py`); the median full-session range of the last 20 sessions is context only. Today the
  source is always a collected lake day (`source.kind: replay`, `live.available: false` with the reason); a live reader
  over `TRADING_DATA_ROOT/live/<day>/` (BL-117 Phase 2) is meant to return the same shape. Replays are cached
  (`lru_cache`); nothing is written.
- `ruletest/` + `api/rule_routes.py` — rule strategies and the tester (BL-120 Phase 1; `obt rule validate|test|reveal|ledger`,
  `/legwise/rules/*`). A rule is WHEN (a condition on the index's bars, `expr.py`'s small grammar over (sessions x 375)
  arrays; every operator reads only stamps <= j and earlier sessions, held by a causality test) → WHAT (a legwise
  template's legs, each `on: up|down|both`, entered at the firing stamp + 1) → how it is managed (the template's stops
  and exit). `spec.py` validates and hashes it (`spec_hash` ignores id / name / notes; `template_hash` ignores the
  condition, so the simulation cache is shared by rules with one template) and reads it back in plain words;
  `frame.py` loads index + VIX sessions from 2020-09 and the cached ATM-straddle feature; `sim.py` runs the template
  with the legwise engine and keeps gross + turnover per (template, day, entry, side, slippage) in
  `TRADING_DATA_ROOT/ruletest/simcache/` (charges are applied on read by `charges.py`, the BL-063 model);
  `study.py` is BL-083's event study generalised: events (first firing in the window, one per session), the placebo
  (same template and side at the same minute on the 20 nearest no-event days), the random-time control (a 5-minute entry
  grid, 200 draws, seeded from the spec hash), slippage 0.5% / 1% on the events, by half-year / weekday / expiry day.
  `store.py` keeps specs, results, the **ledger** (`tests.jsonl`, every test, a sweep of K counts K) and the **reveals**
  (`reveals.jsonl`) as files, not the catalog. The learning period (2024-10-09 to 2026-10-08) is always open; the
  confirmation period (NIFTY 2022-01 to 2024-10-08) is locked until `obt rule reveal <hash>` (once per spec hash, logged)
  or an exploratory run (`--open-all`), which is itself logged as the spec's reveal (`note: exploratory test <id>`); a
  test that includes it lists every earlier test of the spec that already saw it (`confirmation_seen_before`, in the
  result and its ledger line); sessions after 2026-10-08 are forward only and never tested.
  `{straddle: {at: T}}` is NaN before `T` (its strike is chosen at `T`'s close); the straddle feature file saves only
  built rows and days whose option file lacks the strike, never a day without a file or a failed read (retried next
  run); the simulation cache skips and counts a torn row and starts every append on a fresh line. A result is labelled
  "a screen, not a finding". Indicators (2026-10-20): `{supertrend: {n, mult, minutes}}` (the line),
  `{supertrend_dir: ...}` (+1 / -1) and `{bollinger: {n, k, minutes, band}}` are TradingView's definitions over
  `minutes`-minute bars from 09:15, continuous across sessions like `rsi`, held between bar closes (`_bars`,
  `_on_grid`, values cached on the frame); `tests/unit/test_ruletest_expr.py` pins the Supertrend to a longhand
  ta.supertrend. A rule's optional `exit_when` (one condition, or `{up, down}` with `direction_up`) closes the trade
  the minute after it first holds from the entry minute on, capped at the template's `exit_time`
  (`study.exit_minutes`, applied to the events, placebo and random-time entries alike). An exit rule's cache file
  has an `exit` column and a row is used only for the exit asked for (`sim.EXIT_COLUMNS`), because an exit depends on
  indicators built from every earlier session; its `template_hash` takes only a marker, so exit rules with one template
  share simulations. The controls are trend-matched (`study.control_filter`): a placebo day or random minute is used
  only where `control_when` holds (or, without it, `exit_when` does not) the minute before it enters; the placebo looks
  further out for its ten days a side, and `random_time` reports `minutes` / `minutes_used`. `exit_when` /
  `control_when` join `spec_hash` only when set, so older rules keep their hashes and cache. A leg's
  `strike: {premium_pct_of_spot: P}` is resolved per trade to `closest_premium` = P% of the index at the entry
  (`spec._strike_for`; no index price at the entry is an error row). `load_spec` reads only true / false as YAML
  booleans (`_RuleLoader`), so an unquoted `on: up` key stays `on`.
  Event and trade values (BL-152): `max` / `min`; `{at_first: {x, when}}` and `{min_since_first | max_since_first:
  {x, when}}` hold a value from the first stamp `when` holds in the session (a breakout candle's high, a level frozen
  at the breakout, "no close below it since"); `{at_entry: x}` and `minutes_in_trade` are trade-relative, allowed only
  in `exit_when` under elementwise operators (a `trade` flag set at parse), evaluated per trade by
  `expr.evaluate_trade` from `study.exit_minutes` (the rest of the exit from one grid evaluation, shared); a rule
  whose exit uses them must give `control_when`. `study.run_test(..., frame=)` takes a frame already loaded, for a
  caller testing many rules (BL-152's `research/bl152/run_grid.py`).
  BL-164 added `{prev_at: {x, clock}}` (the previous session's x at that clock), `{prev_agg: {x, how: max|min}}`
  (its highest / lowest x over its 375 stamps; `prev_high` / `prev_low` are bar highs / lows and `prev_close` the
  15:29 close, so a close-based level needs these) and `{ever: b}` (true from b's first stamp on; with
  `not: {first: b}`, "b held at an earlier stamp"). A leg's `trail_peak` / `stop_on` (legwise, below) pass
  through a template and read back. BL-165 added the leaf `expiry_day` (the session is its own nearest
  listed weekly expiry, `frame.nearest_expiry`, the simulator's rule; built by `ExpiryDayLoader`, cached
  under `ruletest/features/`; a frame without the loader raises). BL-166 added `{swing: {kind: high|low,
  back, minutes, n}}`: the session's back-th latest fractal swing of `minutes`-minute bars (strictly beyond
  n bars each side), held from the close of the n-th bar after it; swings do not carry across sessions.
  `scripts/ruletest-acceptance.py` must print ACCEPTANCE OK: the four BL-083 triggers, said in
  the grammar (`tests/fixtures/rules/`), fire on the same days and stamps as `research/bl083/`, and T1 and T4 with the Dir
  template reproduce its event-study rows to the rupee. A leg with its own `range_breakout` is not supported yet.
  Phase 2 (2026-10-28): `obt-mcp`'s `validate_rule` / `test_rule` / `list_rule_tests` (`mcp/server.py`) call the same
  `spec.load_spec` / `read_back`, `study.run_test` and `store.ledger` / `counts`; `test_rule` takes the `spec_hash`
  `validate_rule` returned (a mismatch runs nothing), always runs `mode="locked"` (no `open_all`, no reveal tool: a
  confirmation test runs only for a rule the owner revealed with `obt rule reveal`) and returns the read-back, the result
  (per-event `rows` / `equity` only with `include_rows`), the CLI's `render` text, its ledger row and the counts.
  Synchronous: a new template's first test can take minutes. Tests: `tests/unit/test_mcp_rules.py`.
- `notify.py` — Telegram sender (TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID), a deliberate copy of
  `momentum-backtesting`'s notify.py mirroring `@trading/notify`'s contract (never `parse_mode`,
  redacts known secrets, never raises; prints when unconfigured). Tests must stub `send` —
  `load_dotenv()` would otherwise pick up the real bot token from the repo `.env`.
  `send(..., chat_id=...)` supports an explicit destination for the rotation pick's group copy;
  its environment configuration lives in the root `technical.md`.
  Rotation messages (BL-125) are plain text (`Notification(plain=True)`: no icon or source line) built by pure functions
  in `rotation/messages.py`; strategy names come from `rotation/labels.py` (`label(name)` -> head `N_widesl_OTM1` +
  params `SL115% · TSL15%/10% · REnone · MTMSL2500`, read from the variant's own YAML; an id with no file is shown
  raw, never an error) and `rotation/list_names.json` (also imported by the dashboard) for list names. `rotation/deliver.py`
  decides when they go: `pick_and_send` (the 09:16 job: Adaptive recorded first, T1 right after reusing its VIX read; the
  message carries both if T1 is in by `t1_deadline` (09:16:50 IST, or 20 s after Adaptive's entry), else Adaptive alone
  with `· follows in a separate message` (or `· not recorded today` when T1 failed) and T1 follows; the owner and the
  friends' group get every message alike (2026-10-28), alerts stay private; a dry run writes nothing, not even the T1
  catch-up)
  and `send_result` (the evening message, under `result.sending_lock`, a per-day `flock`; any error reading T1 degrades
  to `result not ready`, alerts the owner and never stops Adaptive's result; the owner's message goes first and a
  failing group copy is retried on its own, never holding back the owner's T1 follow-up; the group's copy is the owner's
  without BL-141's live lines, and a late T1 result follows to the group too (`group-t1-owed` / `group-t1` markers); `--not-before 16:00 --soft-fail` is
  the evening run's last step, so a run that succeeds only on a late retry still sends that evening). `obt rotation verify
  --track t1` checks the T1 journal. Nothing in them touches a pick, a score, a hash or a journal field. The messages
  call T1 `messages.T1_NAME`, "Tuned Adaptive (In Testing phase)"; alerts and logs still say T1.
  `rotation/result.py` reads the completed picked variants' net results (after estimated costs) for the live list or
  `track="t1"`, one lot per strategy (`NoEntry` = never picked, `NotScored` = results still coming).
  Under each list's rows the message (both chats, owner 2026-10-29) gives `Capital ₹8.5 L` (`result.CAPITAL_INR`,
  one fixed figure per book, Core and T1) and the month to date with its share of that capital
  (`month_to_date`: every journal day from the 1st, today as the message shows it, earlier days at the lots their
  Quantiply / AlgoTest export manifests recorded (Dir ×2), a day with results missing counted as `not scored`,
  never zero; a failure leaves only those lines out). Sent markers are per
  destination and piece (`.sent` owner, `.group.sent`, `.t1.sent`, `.group-t1-owed.sent`, `.group-t1.sent`; a pre-BL-125 `.sent`, recognised by its text, still
  covers owner + group), so a retry never double-sends and a late T1 result still follows as its own message; `obt rotation result --force` resends.
  Days to expiry in the rotation are **weekdays** (Monday to Friday dates after the session up to the expiry;
  holidays are not excluded; BL-109, 2026-10-15): `rotation/dte.py` holds the count, `live.py` builds the live
  labels with it, and the stored `days.csv` and the journal entries recorded before the change keep calendar
  days as written and are converted on read (`store.read_days`, `dte.entry_labels`), so nothing is rewritten.
  New entries carry `dte_basis: weekdays`. The Options Lab anatomy `dte` and the YAML engine's `days_to_expiry`
  stay calendar days.
  `rotation/tomorrow.py` supplies the evening message's "tomorrow" part (`--no-tomorrow` drops it; a failure in it never
  blocks the result): `next_session_picks(today, root, track=)` is the 09:16 ranking re-run on the stored results with
  tonight's VIX close standing in for the open, under the BL-122 rule for that session, for Core-298 or Core-298 plus a
  track's variants; the message lists those strategies in full. The old history tables, probabilities and likely changes
  are no longer sent (`build`/`Tomorrow` are kept, tested, unused by the message).
- `realised/` — BL-168 Phase 4: the contract-notes store (`TRADING_DATA_ROOT/contract-notes/`, written by
  `packages/contract-notes`) read as the owner's sheet: `store.py` (load; a damaged line is a problem, never fatal),
  `ratios.py` (the sheet's columns O, P, Q, R, S, T, U, V, W, X, Y, Z by its own formulas, the summary block, months,
  FY; `other_debits`, an estimate of ₹1,000 per F&O broker a year, beside the figures, never inside them), `trips.py`
  (fills paired flat-to-flat per contract; the note's other charges shared by turnover so trips add up
  to the final net; turnover; a broker in `TRADES_FROM` gives trips only from that day, Angel One from 2026-02-02),
  `sources.py` (the live capture's fills), `context.py` (VIX, gap, range, expiry, each index's 7-day IV percentile
  from `iv_daily`, and event days from `realised/events.csv`, kept outside `data/reference/` so the portfolio
  cache's stamp of that folder does not change; MAE / MFE from the 1-minute lake), `capital.py` (the 15:50 Angel One reading), `views.py` (the JSON the CLI and
  `api/contract_notes_routes.py` share). Figures are recomputed on read; only `capital` and the page's inputs write
  `manual/<day>.json`. Reading the store's ~900 files costs 5-7 s on the external disk, so the views use
  `store.load_cached` (the book kept against `store.stamp`: name, size and mtime of every file `load` reads; ~5 ms)
  and the routes' 20 s response cache is keyed on the same stamp; the inputs PUT clears both (`store.forget`).
  The cached book is shared: never mutate it.
- `legwise/algtst.py` + `rotation/algtst_export.py` — BL-137: a leg-wise strategy as an AlgoTest `.algtst` (import
  format, one strategy per file) and a day's picks as files + zip (`obt rotation algotest-export`). Every mapping was read
  off an AlgoTest export in `tests/fixtures/algtst/` (a closest premium is a bare number; re-entry at cost is
  `ReentryType.AtCost` / `ReentryCount`; a range breakout is `LegMomentum` `MomentumType.DelayedBreadthHigh` with `Time` in
  minutes after entry); anything else that is set raises `Unmappable`. Not `legwise/algotest.py`, which is BL-009's
  trade-log comparison.
- `legwise/quantiply.py` + `rotation/quantiply_export.py` — BL-139: a leg-wise strategy as the body of Quantiply's create
  call (`POST /algos` on `api-prod.quantiply.angelone.in`) and a day's Core picks as one `<variant>.json` body each plus
  `manifest.json` (`obt rotation quantiply-export`). The mappings were read off calls the web app made, in
  `tests/fixtures/quantiply/`. A closest premium is `selectionType: PREMIUM` + `PREMIUM_CLOSE_TO`. Re-entry at cost is a
  leg `reEntry: RE_ENTRY_COST`. A range breakout is a leg `orb: ORB_INSTRUMENT` with `orbEndTime`. Every body copies
  the execution settings of the owner's own `N_ITM1_SL21_3000` (`EXECUTION`: limit orders with buffer 3, product D,
  SL limit 1, a 3 s exit delay). One algo per weekday, so a body carries the session's weekday only. A trail in points
  is `PER_POSITION_POINT` (confirmed by the owner's `test1`). `Export.unconfirmed` lists any mapping never seen
  saved, which the uploader refuses; none is left. Anything else that is set raises `Unmappable`.
- `rotation/plan.py` + `api/rotation_plan_routes.py` — the Today page's baskets with what the platforms hold
  (dashboard review, 2026-10-28; `GET /legwise/rotation/plan`, read-only): each Adaptive book's picks for the
  latest recorded session and the next session's tentative list (`result.read_tentative`), with `labels.label`
  settings, and per account Settings › Automation has uploading, `uploaded` / `enabled` / `held` / `extra`
  replayed from the broker-login ledgers (`rotation/quantiply/ledger[-<broker>].jsonl` and
  `deploy-ledger[-<broker>].jsonl`, `rotation/algotest/ledger.jsonl`); a 15:40 `disable` counts as having been
  on; a missing ledger is an `error`, never "nothing uploaded".
- `rotation/live_compare.py` — BL-141: the 15:40 capture's day file (`rotation/live/<day>.jsonl`, written by
  `packages/broker-login/src/live-capture.ts`) beside the stored paper results (`store.result_path`, so T1 variants
  too): per variant, list and platform + broker, live per lot (copies' multipliers added up) minus paper per lot
  after the same costs, signed, summed in `Decimal`; copies that did not trade, have open legs or are off-slot, and
  discretionary lines, apart. `owner_lines` is what `deliver.send_result`
  adds to the owner's 16:00 message only, and returns None (no block) until `rotation/live/` exists.
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
  settings). Reads `rotation/results/*.csv`, `days.csv` and the journal and writes nothing. `universe=t1` (both
  routes; default `core`) adds the T1 track's extra settings from `rotation/track_t1/results/` as their own rows
  (after their Core kind, labelled "… · T1 #36, SL 20%", with an in-sample note for their BL-113 selection window);
  the `widesl` / `dirs` aliases then take them too (`Filters.groups`), the overlay stays the live journal's, and
  `universe=core` (and the pulse) never read them. One cached cube per universe. Gross per ONE-lot
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
- `heatmap/` + `api/heatmap_routes.py` — BL-094, the Options Lab's Heatmap page (Explore data): the P&L of an ATM
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
- `rotation/lot_plans.py` + `api/rotation_lot_plans_routes.py` — BL-135, lot plans tracked forward from 2026-10-19
  (`GET /legwise/rotation/lot-plans?book=core|t1`, `obt rotation lot-plans [--book t1] [--json]`), read-only over the
  live or the T1 journal (list C) and the stored one-lot results (`store.result_path`). Three plans, Buy left out: As
  picked (1 lot per core pick), Dir Boost (the Dir pick at 2 lots on a non-expiry day; on a three-Widesl day the best
  unpicked Dir added at 1 lot; expiry day = As picked) and Duo (W1, the higher recorded composite, ties by name, and
  the Dir: 2 + 2, or 2 + 1 on an expiry day). Expiry = the entry's weekday label `0` for NIFTY or SENSEX
  (`dte.entry_labels`). The best unpicked Dir is the 09:16 message's (`pick.next_best`, BL-122's
  `filtered_runners_up` on a rule day), re-derived from the history the ENTRY ranked on by `HistorySource` (the matrix read
  once per request, sliced to the first `inputs_days` stored days before the day, with no "reaches the last collected
  day" check, so a later repair or backfill cannot unverify a day; a test holds the digests equal to
  `pick.load_history`'s), in the entry's universe (the current one if its fingerprint matches, else the strategy files
  at the entry's `commit` via `git ls-tree`, else `unverified` with the reason). Verified only when `inputs_sha`, the
  picks, list C's recorded composites and the VIX band all match; otherwise `unverified` (never guessed). Answers are
  cached on the entry hash plus a stamp of the result files and `days.csv`, so they do not depend on API restarts. Net = gross × lots − ₹20 × 1.18 × 2 × `n_trades` per strategy placed. Day status
  scored / waiting (never zero) / late (not before 09:17) / unverified; only scored days count, all plans at once. The
  read-out (registered) judges the first 60 scored days: plan − As picked, `readout.block_bootstrap_mean` seed
  20261019, beats if the interval is above zero and drawdown per lot is no deeper. It is computed afresh each
  request (`READOUT_NOTE`: the BL-135 Log entry at the 60th day is the record; a later status change can move the
  shown window); days after the 60th are `after_readout`, descriptive.
- `analytics/regime_source.py` — reads `daily_regime_tags` from Postgres,
  gated on `DATABASE_URL` being exported in *this process* specifically (not
  just present in a `.env` the server reads) — see the root `technical.md`
  Gotchas for the exact silent-omission failure mode. With it set, a database
  that is down (`connect_failed`) or lacks the table (`missing_table`) raises
  `RegimeSourceUnavailable`; `features/regime.py::regime_bucket_status` turns that
  into an absent regime section plus a status (CLI line, `regime_status` /
  `regime_message` on `POST /runs`, `regime_status` in the MCP `run_backtest`
  output, `t33.status` on `/legwise/anatomy`). Any other query error still raises.

- `research/common/` — code two research items share, imported by module name after a `sys.path` insert of this
  folder (`varlib`, `early_ref`, `rotparse`; BL-164 added `gap_and_go_specs` (BL-164's rules, which BL-165 subsets); BL-186 added `adaptive_picks` (Adaptive's picks per book, recorded or reconstructed, moved out of `bl156/replay.py`); BL-152 added `cscv` (the numpy CSCV / PBO, moved out of `bl104/robust.py`, which
  re-exports it) and `breakout_specs` (BL-152's 192 registered rule specs, also used by BL-153)). A script never imports
  from another item's folder.
- `research/bl104/` — BL-104, the full-factorial parameter sweep over the Widesl / Dir / Buy families:
  `grid.py` (the registered axes, cells and their SHA; `tests/unit/test_bl104_grid.py` holds the counts),
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
uv run obt fyers history --symbol NSE:RELIANCE-EQ --name RELIANCE --asset stock   # BL-153: one symbol's history (`fyers.history.backfill_symbol`)
uv run obt legwise run strategies/legwise/*.yaml [--from D] [--to D] [--trades] [--include-excluded] [--bars 5m]
uv run python scripts/parity-5m.py --from D --to D   # same strategies on 1m vs 5m bars: agreement + timing
uv run obt daily                        # evening routine: fetch + judge the day + derived tables + run strategies/legwise + summary (verdicts, IV percentile)
uv run obt legwise rerun                # re-run every strategy over every collected day (after an edit)
uv run pytest tests/golden/test_legwise_scenarios.py  # 30 frozen-input leg-wise regressions
uv run python scripts/update-legwise-goldens.py       # check snapshots; writes nothing
```
