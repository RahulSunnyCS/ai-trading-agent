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
  session today, at zero incremental cost. `data/providers/algotest.py` is written against the
  same `MarketDataProvider` Protocol the original design specified, so a REST or Python-MCP-client
  transport can be swapped in later without touching the resolver, engine, or anything downstream
  of the cache.

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
