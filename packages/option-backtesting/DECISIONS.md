# Decisions

Boring/default choices and accepted deviations, logged per the handoff's convention: "when a
design question isn't covered by the plan, prefer the boring choice and note it here rather than
asking."

## Superseding the original handoff

- **UI: React tab in the existing dashboard, not Streamlit.** The original design (chatted before
  the monorepo/SaaS context existed) picked Streamlit for Phase 1 speed. Once this became a
  sub-package of a product with an existing React dashboard and a credit-gated access model,
  a second, ungated, unauthenticated Streamlit surface would duplicate UI investment and bypass
  the payment gate entirely. Superseded: FastAPI (loopback-only) behind the existing Fastify
  server, with a "Backtest" tab in `apps/dashboard`. See the epic plan for the full rationale.
- **AlgoTest transport: Claude Routine via MCP, not a REST/API-key client.** No AlgoTest REST
  credentials exist for this project; the AlgoTest MCP tools are available in a Claude Code
  session today, at zero incremental cost. `data/providers/base.py` keeps the `MarketDataProvider`
  Protocol the original design specified, so a REST or Python-MCP-client transport can be swapped
  in later without touching the resolver, engine, or anything downstream of the cache. Removed
  2026-10-07 as dead code: the `AlgoTestProvider` and `DhanProvider` stubs (both only raised
  `NotImplementedError`) and the Dhan parity harness (`compare`/`run_parity_suite`/`verdict`/
  `GATES`), none of which anything called; recover them from git history if a second vendor is
  ever wired.

## Phase-1 deviation: strike-relative ingest, not concrete-contract

`providers.py`'s docstring says "Providers return concrete contracts only. Strike-relative rules
are resolved by our own resolver before reaching a provider" — the reason being the observed
AlgoTest resolver collision (3 Sep, identical ATM and OTM1 PE series at a mismatched fix_time).

In practice, `get_ohlc_by_data_source` resolves `StrikeType.ATM` / `StrikeType.OTMn` internally
and does not echo the concrete strike or expiry it resolved to in the response. There is no
lower-level "give me exactly this listed contract" call exposed by the MCP tools. Phase 1 ingest
is therefore strike-relative by construction, not concrete-contract as originally planned.

Mitigations, in place from M-1:
- `resolver.py` independently computes the expected ATM strike from the CASH series at the
  session's fix_time and records it as `strike_resolved` alongside every OPT bar in Parquet —
  an independent cross-check against whatever AlgoTest actually resolved.
- `quality.py`'s identical-series gate (comparing e.g. ATM PE vs OTM1 PE for the same day) is the
  direct, permanent mitigation for the exact collision class this deviation exists because of.
- The expiry-day convergence gate (straddle → |spot − strike_resolved|, not zero) is a second,
  independent check that the resolved strike was the right one.
- An `EntryType.EntryByExactStrike` cross-check pull for a sample of days is planned as an M-1
  parity test, once `strike_resolved` values are available to pull against.

Revisit when a REST transport (AlgoTest or Dhan) is wired — both expose exact-strike entry kinds
that close this gap fully.

## Nightly ingest Routine is self-bound to a session, not fresh-per-fire — M-5

The plan called for a fresh-session-per-fire Routine (`create_new_session_on_fire=true`) so each
nightly ingest starts from a clean slate. In practice, this account's org does not support granting
MCP connectors (e.g. AlgoTest) to a fresh-session Routine at all — `create_trigger`'s `connectors`
parameter is rejected outright ("the connectors parameter is not available for this organization").
A fresh-session firing would therefore have zero MCP tools, making an AlgoTest-dependent ingest job
impossible to run that way in this environment.

The Routine (`option-backtesting nightly NIFTY ingest`, cron `30 12 * * 1-5` UTC = weekday 18:00
IST) is instead **self-bound** to the session that built M-5 — the only mode where a Routine can
reach a connector, because connector access rides on the session already having the connector
enabled, not on anything the trigger grants. Trade-off, accepted deliberately: every nightly firing
resumes and grows this same long-lived conversation rather than starting clean, which is not ideal
hygiene for a job meant to run indefinitely. Revisit if/when this org's Routines support connector
grants for fresh sessions — at that point, `create_trigger` with `create_new_session_on_fire=true`
and `connectors=["AlgoTest"]` is the design to switch to; no ingest logic changes, only how the
Routine is registered.

## Fyers collector is forward-only, concrete-contract, 1-minute — 2026-09-29

`fyers/` (`obt fyers fetch`) is a second data source alongside AlgoTest, added for daily
1-minute backtests across NIFTY, BANKNIFTY, MIDCPNIFTY, FINNIFTY and SENSEX with India VIX.
Verified live on 2026-09-29 before building anything on it:

- **Expired contracts are gone.** A NIFTY weekly that expired 2026-09-22 returns
  "Invalid symbol provided" for any date; the public symbol master stops listing it too. A
  contract must therefore be captured **on its expiry day, the same evening** — a missed expiry
  day is unrecoverable. Collected data is the only copy; back it up.
- **Live contracts have history.** A still-listed contract returns 1m bars for earlier days
  (the 2026-10-06 NIFTY weekly served 2026-09-25), so a missed *non*-expiry day can be caught up
  with `--date`, minus whatever expired in between.
- **Index symbols return every minute twice** (identical rows) — de-duplicated by epoch in
  `fyers/client.py`. Option bars run 09:15-15:39 (the master lists the F&O session as 0915-1540);
  stored as-is, the engine should restrict itself to 09:15-15:29.
- Unlike AlgoTest (strike-relative only, see "Phase-1 deviation" above), Fyers serves exact
  contracts, so this data is concrete-contract by construction — the gap that section says to
  revisit "when a REST transport is wired".

Expiries collected (owner's choice): NIFTY and SENSEX current + next weekly; BANKNIFTY,
MIDCPNIFTY, FINNIFTY current monthly, plus the next monthly on the monthly expiry day itself.

Width is data-driven, not a fixed ±N: every strike inside the day's index low-high, then walk
outward until the OTM leg's intraday high stays under `--premium-floor` (₹2) for two strikes in
a row, capped at `--max-extra` (60) per side. The per-side widths land in
`manifest/<date>.json` so the floor can be tuned once the real strategies are written.

**Superseded 2026-09-30:** storage moved to `packages/trading-data` (see its DECISIONS.md) — the
paragraph below records the original choice.

Storage is Parquet under `FYERS_DATA_DIR` (default `data/fyers/`, gitignored) rather than a
database server — the owner wants it local now and on an external disk later, which is then a
one-env-var move, and DuckDB already reads this layout for the AlgoTest cache.

## Leg-wise engine is separate from `engine/`, schema mirrors AlgoTest — 2026-09-29

The owner's four daily strategies are AlgoTest strategies: per-leg SL/target/trail SL, per-leg
re-entry (RE COST), a per-leg range-breakout entry on the option's own premium, closest-premium
strikes, mixed buy/sell, and an overall MTM stop. `engine/loop.py` sums every leg into ONE
premium series with ONE side and is pinned to the golden fixture to the rupee, so none of that
fits without rewriting it. `legwise/` is a separate minute-by-minute state machine over the Fyers
1-minute concrete-contract data instead; the golden-fixture engine is untouched.

The YAML schema (`legwise/schema.py`) mirrors AlgoTest's strategy page field for field so a PDF or
screen transcribes directly, and `extra="forbid"` rejects any AlgoTest setting not implemented
yet (simple momentum, overall re-entry/trailing, RE MOMENTUM, trail SL to break-even, BTST) rather
than silently ignoring it. `range_breakout.source`, not `on` — YAML 1.1 parses a bare `on` key as
the boolean `true`.

Every intrabar-ordering assumption (entry at the open of the entry minute, SL before trail within
a bar, no SL check on an intrabar-entry bar, overall MTM at bar closes including realised P&L,
closest-premium tie to the lower premium) is listed in `legwise/engine.py`'s docstring. They are
best guesses from AlgoTest's docs, not verified: comparing trade logs against AlgoTest's own
backtest of the same strategies over the same days (TODO 3.10.7) is what settles them.

## Other boring choices

- **CSV, not JSON, for reference tables.** Matches the original design (`reference/*.csv`) and
  is trivially diffable/editable by hand for calendar/lot-size updates.
- **`hatchling` build backend.** No compiled extensions, no reason for anything heavier.
- **`typer` for the CLI**, not raw `argparse`— the CLI has multiple subcommands
  (`ingest plan`, `ingest`, `validate`, `run`, `registry`, `export-personality`) from day one.

## `mcp` SDK is v2.x (`MCPServer`), not v1.x (`FastMCP`) — M-4

`pyproject.toml`'s `mcp>=1.1` dependency spec (written at M-1 scaffolding time, before any MCP
server code existed) had no upper bound, so `uv sync` resolved and locked `mcp==2.1.1` by the
time M-4 actually wrote `mcp/server.py`. Between v1 and v2 the SDK renamed its high-level
decorator API: `mcp.server.fastmcp.FastMCP` no longer exists — the module raises
`ModuleNotFoundError` with an explicit migration message pointing at
`mcp.server.mcpserver.MCPServer`. The replacement's `.tool()` decorator and `.run()` (defaulting
to stdio transport) behave the same way for our purposes; `mcp/server.py` is written against
`MCPServer`. Not repinning the dependency spec to `mcp>=2.0` — `uv.lock` already pins the exact
resolved `2.1.1`, which is what actually matters for reproducibility; the loose `pyproject.toml`
constraint being technically satisfiable by a now-incompatible v1 install is a latent footgun
for a *fresh* `uv sync` against a hypothetically-yanked lockfile, not something this session hit
in practice — flagged here rather than "fixed" with a change that has no test coverage behind it.

## Regime bucketing (R2) is post-hoc reporting only, not a DSL feature — M-5

The Part-B spec's original wording ("features/regime.py exposes it as a lag-1 feature for
filters") suggested regime should be usable inside a strategy's `entry.filter`/ladder conditions,
the same way `rolling_mean`/`greek`/etc. are. Built instead as post-hoc bucketing only:
`features/regime.py::regime_bucket_report()` takes an already-computed run's session list and
buckets net P&L by each session's lag-1 regime tag (read via `analytics/regime_source.py`, gated
on `DATABASE_URL`) — it is not wired into `strategy/schema.py`'s feature registry, the loader, or
`engine/conditions.py`.

Reason: every other DSL feature (`features/registry.py`) is computed purely from the offline
local Parquet/DuckDB cache via `features/evaluator.py`'s two-pass, no-network design — a
regime-as-condition feature would need a live PostgreSQL round-trip mid-evaluation, a structurally
different kind of dependency the evaluator was never built to accommodate. Retrofitting that
safely would touch six files central to the golden-fixture-verified engine core
(`features/registry.py`, `strategy/schema.py`, `strategy/loader.py`, `features/evaluator.py`,
`engine/loop.py`, `engine/conditions.py`) for a capability no committed strategy needs yet.
Post-hoc bucketing needs none of that — it only reads "which regime applied yesterday, for dates
a run already covers" — and delivers the real analytical value (P&L broken down by regime) without
the risk. Revisit if a strategy actually needs to gate entries on regime; the DSL's `==`/`in`/
`not_in` operators and `Op` grammar already support a categorical condition, so the schema/loader
side is a smaller lift than the evaluator's data-source problem.

---

## AlgoTest comparison, round 1: fills at the close of the bar ending at T — 2026-10-07

BL-009 Phase 1. `obt legwise compare <strategy> <algotest.csv>` runs a strategy over the days of
an AlgoTest trade-log export and classifies each day (`missing / strike / reason / minute /
price / match`). First export: Nifty_Widesl_917_OTM1, 436 days.

- **AlgoTest's candles are end-stamped.** Its 1-minute candle "09:17" is the bar that starts at
  09:16 (fetched through the AlgoTest connector for 2026-09-24: its closes equal our Fyers bars'
  closes exactly; opens/highs/lows differ slightly). Its fills at a scheduled time T use that
  candle's close: the 09:17 entry 92.25 and the 13:43 combined-stop exit 64.00 are exactly our
  09:16 and 13:42 closes. Across all 436 days the close of the bar ending at T is the nearest
  of our prices to AlgoTest's (entry median gap 0.30 vs 0.45 for our 09:17 open; time exits 0.05
  vs 0.10).
- **So the engine's price at T is now the close of the bar ending at T** (`Series.price_at`),
  used for fixed-time entries, exits at the exit time, strike selection from the index and
  closest-premium selection. It was the open of the T bar. Stops are unchanged (checked on each
  bar's high/low from the bar after the fill instant; filled at the trigger, or at a gapped
  open). RE ASAP still enters at the next bar's open: no export with re-entries yet.
- **Effect:** strike mismatches 9 → 0 days; legs within a tick 37 → 73; P&L gap to AlgoTest
  ₹14,640 → ₹7,147 over 429 days. 22 golden scenarios (the fixed-time strategies) re-accepted.
- **Lot size: today's lot for all history** (owner, 2026-10-07; `execution.lot_sizing: current`,
  default) — AlgoTest sizes every day at the current lot (qty 65 in Jan 2025), and with a rupee
  combined stop the lot decides the minute it fires. `historical` keeps the per-expiry lots.
- **Reading AlgoTest's log:** it has no exit reasons; the comparator infers them (exit time;
  legs out together = combined stop; a lone early exit = either stop) and accepts a leg SL that
  fired in the minute the combined stop closed the rest. AlgoTest stamps stop exits at the END of
  the triggering minute: its stop minutes read ours + 1 (253 legs).
- **5-minute tables:** a window's `open` stays its first minute's open — the engine checks a
  stop's gap against it. The price at the window's start, which fills use, comes from the
  previous window's close on the filler minutes (`load_day_5m`), so 5-minute fills follow the
  new rule unchanged. (A short-lived version 2 made `open` the previous close, which hid gaps
  from stop fills; the code review caught it; `DERIVED_VERSION` 3.)

---

## AlgoTest comparison, round 2: four strategies; stop levels on the tick; NIFTY data differs — 2026-10-07

The owner exported all four strategies (fixtures in `tests/fixtures/algotest/`); each strategy
file now follows the settings in the owner's PDF of the same day (the source of truth):
closest premium ₹65 (was ₹60), a new `sensex_widesl_917_otm2` (SL 114% on the call, 115% on the
put, as set in AlgoTest), Dir_924 unchanged.

- **Rule: stop and target levels are rounded to the nearest 0.05 tick.** Across the four
  exports, 512 of 515 untrailed stop exits equal entry × (1 + SL%) rounded to the nearest tick;
  88 equal it unrounded, 261 rounded up. Trailed levels are rounded the same way. Golden
  scenarios with stops re-accepted (stop prices move onto the tick, e.g. 53.4875 → 53.50).
- **Comparator:** a re-entry (RE COST / RE ASAP) is an event AlgoTest stamps at the end of the
  triggering minute, like a stop exit — its entry minute is now compared with the same 0..2
  tolerance (Dir_924: "minute" days 145 → 38).
- **Results** (days fully matching / P&L engine vs AlgoTest):

  | Strategy | Days | Match | P&L engine | P&L AlgoTest |
  |---|---|---|---|---|
  | SENSEX OTM2 | 424 | 375 | ₹1,58,352 | ₹1,58,676 |
  | NIFTY OTM1 | 429 | 6 | ₹1,30,911 | ₹1,38,054 |
  | NIFTY ITM1 RE COST | 236 | 2 | ₹44,139 | ₹40,518 |
  | NIFTY closest premium | 241 | 2 | ₹50,294 | ₹44,688 |

- **Why NIFTY differs: AlgoTest's NIFTY prices come from a different feed.** SENSEX legs are
  within a tick on 788 of 848 legs, vendor days and Fyers days alike, so the engine's rules
  reproduce AlgoTest. NIFTY legs are not even on Fyers-collected days (1 of 18 legs within a
  tick, 2026-09-23 → 10-06); AlgoTest's own 15-minute candles for NIFTY 23200 PE on 2026-09-24
  equal our Fyers closes at only 7 of 25 marks (gaps up to ~1 point). With tight thresholds (21%
  stops, ₹2,500–3,000 combined stops) those gaps move exit minutes and, on some days, exit
  reasons and closest-premium strikes. Remaining NIFTY differences are data, not rules.
- **Not settled yet:** RE COST's fill when a bar gaps through the cost price (AlgoTest
  re-entries in the Dir_924 export are at the cost price; none of ours gapped differently in the
  days inspected), RE ASAP (no export uses it).
- **Range breakout (2026-10-07, fifth export, AlgoTest's "Download trades" format, now parsed
  too — it adds each leg's expiry, which the comparator checks):** 168 of 244 days match, 280 of
  361 legs within a tick — far closer than the other NIFTY strategies because a breakout fills
  at the range level, not at a feed-dependent close. The P&L gap (AlgoTest ₹260, engine ₹8,132)
  sits mostly on 8 days where a 1/1-point trailed stop is decided by a fraction of a point:
  2026-09-29 (Fyers day) needs AlgoTest's 11:11 high ≥ 77.75 against our 77.15 for its 63.05
  exit; the 5-minute candle around it agrees with ours (high 101.15). 2026-09-03 is a thin
  vendor day (its put's range differs wholesale). Trail rule unchanged: data, not rules.
