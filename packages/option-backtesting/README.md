# option-backtesting

Strategy-research workbench for Indian index options (NIFTY / SENSEX / BANKNIFTY), reading a
local Parquet cache built from AlgoTest option data. Answers "is this strategy shape worth
turning into a personality?" — a different question from `apps/server`'s in-memory personality
replay backtester (`bun run backtest`), which answers "how would the live personalities have
done historically". Both exist; neither replaces the other.

Python 3.12, managed with [uv](https://docs.astral.sh/uv/). Never imports a live broker — the
engine reads only the on-disk cache; providers exist solely to fill it.

## Quick start

```bash
cd packages/option-backtesting
uv sync
uv run pytest
uv run obt --help
```

## Layout

See `.claude/project/technical.md` for the full monorepo layout. Within this package:

- `src/option_backtesting/data/` — provider protocol, resolver, reference tables, quality gates,
  raw-JSON ingest, DuckDB cache
- `src/option_backtesting/features/` — point-in-time feature registry
- `src/option_backtesting/strategy/` — YAML strategy DSL (pydantic-validated)
- `src/option_backtesting/engine/` — bar-by-bar event loop, fills, costs, ledger
- `src/option_backtesting/analytics/` — metrics, buckets, sweeps, walk-forward, registry
- `src/option_backtesting/api/`, `mcp/` — FastAPI service and MCP server (later milestones)
- `strategies/` — example strategy YAML
- `data/raw/algotest/` — tracked raw AlgoTest responses (source of truth; see "Data ingestion")
- `data/cache/`, `data/registry.sqlite` — gitignored, derived from `data/raw/`

## Data ingestion

AlgoTest is only reachable via Claude Code's MCP tools, not from a plain Python process. The
ingestion flow is therefore:

1. `uv run obt ingest plan --date YYYY-MM-DD --underlying NIFTY,SENSEX` prints the list of
   AlgoTest requests needed for that day (CASH + OPT bars at several strike rules, both legs,
   plus Greeks).
2. A Claude Code session (interactive, or a scheduled Routine) calls the AlgoTest MCP tools for
   each planned request and writes the verbatim JSON response under `data/raw/algotest/...`.
3. `uv run obt ingest --date YYYY-MM-DD` reads those raw files, runs the quality gates, and
   writes Parquet under `data/cache/`.

See `DECISIONS.md` for the reasoning and the accepted Phase-1 deviation (strike-relative, not
concrete-contract, ingest).
