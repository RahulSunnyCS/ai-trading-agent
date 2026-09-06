"""
The option-backtesting MCP server (stdio) — lets a Claude Code session
plan AlgoTest ingest requests, validate/run strategies, and inspect past
runs directly, without going through the FastAPI service or the Fastify
proxy (this process talks to the same Parquet cache and SQLite registry
directly, on disk).

Built on `mcp` 2.x's `MCPServer` (the FastMCP v1 API was renamed —
`mcp.server.fastmcp.FastMCP` no longer exists in the installed `mcp==2.1.1`;
see DECISIONS.md). `.tool()`-decorated functions are registered under their
own function name, so several are aliased on import to avoid shadowing the
tool function of the same name (`plan_requests`, `run_backtest`,
`list_runs`).

Every tool here reuses the same engine/strategy-loader/registry functions
the CLI and the FastAPI service call — no logic is reimplemented, only
wired up for MCP's calling convention.
"""

from __future__ import annotations

from dataclasses import asdict
from datetime import date

import yaml
from mcp.server.mcpserver import MCPServer

from ..config import resolve_cache_dir, resolve_registry_db
from ..data.cache import Cache
from ..data.providers.algotest import plan_requests as _plan_requests
from ..data.reference.loader import default_reference_data
from ..engine.loop import run_backtest as _run_backtest
from ..engine.registry import get_run, record_run
from ..engine.registry import list_runs as _list_runs
from ..engine.result import aggregate, bootstrap_ci
from ..presets import STRATEGIES_DIR, preset_names
from ..strategy.loader import StrategyValidationError, load_strategy_from_source

mcp = MCPServer("option-backtesting")


@mcp.tool()
def plan_requests(underlying: str, start_date: str, end_date: str) -> list[dict]:
    """List the AlgoTest MCP requests needed to backfill `underlying` over
    [start_date, end_date] (YYYY-MM-DD) — the same plan `obt ingest plan`
    prints. An agent driving a nightly ingest Routine calls each of these
    against the real AlgoTest MCP tools and writes the raw JSON via
    data.raw.write_raw; this tool only plans, it never fetches."""
    return _plan_requests(
        underlying.upper(), date.fromisoformat(start_date), date.fromisoformat(end_date)
    )


@mcp.tool()
def validate_strategy(yaml_text: str) -> dict:
    """Validate a strategy YAML string against the DSL schema. Returns
    {"valid": false, "errors": [...]} on failure (never raises) or
    {"valid": true, "strategy_id", "n_features", "n_ladders", "n_exits"}
    on success."""
    try:
        loaded = load_strategy_from_source(yaml_text)
    except StrategyValidationError as e:
        return {"valid": False, "errors": e.errors}
    assert loaded.strategy is not None
    return {
        "valid": True,
        "errors": [],
        "strategy_id": loaded.strategy.id,
        "n_features": len(loaded.features),
        "n_ladders": len(loaded.strategy.ladders),
        "n_exits": len(loaded.strategy.exits),
    }


@mcp.tool()
def run_backtest(
    yaml_text: str,
    from_date: str,
    to_date: str,
    bootstrap: bool = False,
    seed: int = 0,
) -> dict:
    """Run a backtest strategy (YAML text) over [from_date, to_date]
    (YYYY-MM-DD) against the cached Parquet data, record it in the run
    registry, and return the aggregate result (net/gross/win-days/... plus
    per-session detail). Returns {"error": ...} rather than raising when the
    strategy is invalid or no cached data covers the requested window."""
    try:
        loaded = load_strategy_from_source(yaml_text)
    except StrategyValidationError as e:
        return {"error": "invalid_strategy", "errors": e.errors}
    assert loaded.strategy is not None

    cache = Cache(resolve_cache_dir())
    reference = default_reference_data()
    start = date.fromisoformat(from_date)
    end = date.fromisoformat(to_date)
    sessions = _run_backtest(loaded, cache, reference, start, end)
    if not sessions:
        return {
            "error": "no_data",
            "message": (
                f"No cached sessions for {loaded.strategy.universe.underlying} "
                f"in [{start}, {end}]"
            ),
        }

    result = aggregate(sessions)
    run_id = record_run(resolve_registry_db(), loaded.strategy, start, end, result)

    out: dict = {
        "run_id": run_id,
        "net_inr": result.net_inr,
        "gross_inr": result.gross_inr,
        "win_days": result.win_days,
        "worst_day": result.worst_day,
        "sum_peak_loss": result.sum_peak_loss,
        "worst_intraday_mtm": result.worst_intraday_mtm,
        "lot_days": result.lot_days,
        "inr_per_lot_day": result.inr_per_lot_day,
        "dte_buckets": result.dte_buckets,
        "sessions": [
            {
                "date": s.date.isoformat(),
                "dte": s.dte,
                "net": s.net,
                "gross": s.gross,
                "cost": s.cost,
                "lot_days": s.lot_days,
                "peak_loss": s.peak_loss,
                "total_lots": s.total_lots,
            }
            for s in result.sessions
        ],
    }
    if bootstrap:
        ci = bootstrap_ci(
            [s.net for s in sessions], [s.lot_days for s in sessions], seed=seed
        )
        out["bootstrap"] = {
            "net_lo": ci.net_lo,
            "net_hi": ci.net_hi,
            "inr_per_lot_day_lo": ci.inr_per_lot_day_lo,
            "inr_per_lot_day_hi": ci.inr_per_lot_day_hi,
            "n_resamples": ci.n_resamples,
            "seed": ci.seed,
        }
    return out


@mcp.tool()
def list_runs(limit: int = 20) -> list[dict]:
    """List past backtest runs from the run registry, most recent first."""
    return [asdict(r) for r in _list_runs(resolve_registry_db(), limit=limit)]


@mcp.tool()
def critique_result(run_id: str) -> dict:
    """Plain-English heuristic critique of a recorded run's headline
    metrics — flags a low win rate, a worst day that dominates the total
    net, or a negative INR/lot-day. This reads only the registry's already-
    computed headline row (no new computation) — it is NOT a substitute for
    the overfitting-guard analytics (CSCV / deflated Sharpe) planned for
    M-5."""
    record = get_run(resolve_registry_db(), run_id)
    if record is None:
        return {"error": f"Unknown run_id {run_id!r}"}

    win_rate = record.win_days / record.n_sessions if record.n_sessions else 0.0
    notes: list[str] = []
    if win_rate < 0.4:
        notes.append(
            f"Low win rate ({win_rate:.0%}) — {record.win_days}/{record.n_sessions} "
            f"sessions were net positive."
        )
    if record.net_inr != 0 and abs(record.worst_day) > abs(record.net_inr):
        notes.append(
            "A single worst day exceeds the entire window's net — one bad session "
            "is driving the result."
        )
    if record.inr_per_lot_day < 0:
        notes.append(
            "Negative INR/lot-day — this strategy lost money per unit of "
            "capital-days deployed over this window."
        )
    if not notes:
        notes.append("No red flags in the headline metrics for this window.")

    return {
        "run_id": record.run_id,
        "strategy_id": record.strategy_id,
        "window": f"{record.date_from}..{record.date_to}",
        "net_inr": record.net_inr,
        "win_rate": round(win_rate, 3),
        "notes": notes,
    }


def _deep_merge(base: dict, overrides: dict) -> dict:
    result = dict(base)
    for k, v in overrides.items():
        if isinstance(v, dict) and isinstance(result.get(k), dict):
            result[k] = _deep_merge(result[k], v)
        else:
            result[k] = v
    return result


@mcp.tool()
def propose_strategy(base_preset: str, changes: dict) -> dict:
    """Mutate a base preset strategy with `changes` (a partial dict deep-
    merged into the strategy's YAML, e.g.
    {"strategy": {"caps": {"max_lots": 6}}}), then validate the result.
    `yaml.safe_load`/`yaml.safe_dump` only — never `eval`, matching the
    design's hard non-negotiable. Returns the mutated YAML text and the
    validation outcome; a failing mutation is returned with its errors, not
    silently discarded or partially applied."""
    if base_preset not in preset_names():
        return {"valid": False, "errors": [f"Unknown preset {base_preset!r}"], "yaml": None}

    base_data = yaml.safe_load((STRATEGIES_DIR / f"{base_preset}.yaml").read_text())
    merged = _deep_merge(base_data, changes)
    merged_yaml = yaml.safe_dump(merged, sort_keys=False)

    try:
        loaded = load_strategy_from_source(merged_yaml, label=f"{base_preset}+changes")
    except StrategyValidationError as e:
        return {"valid": False, "errors": e.errors, "yaml": merged_yaml}

    assert loaded.strategy is not None
    return {
        "valid": True,
        "errors": [],
        "yaml": merged_yaml,
        "strategy_id": loaded.strategy.id,
    }


def main() -> None:
    mcp.run()


if __name__ == "__main__":
    main()
