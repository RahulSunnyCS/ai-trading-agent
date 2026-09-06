"""
`obt` — the option-backtesting CLI.

M-1 implements `ingest plan` and `ingest`. M-2 implements `validate`. M-3
implements `run` and `registry`. `export-personality` is still stubbed
(not `NotImplementedError` — a CLI should say plainly what's missing) until
M-5.
"""

from __future__ import annotations

import json
from datetime import date
from pathlib import Path

import typer

from .data.ingest import DEFAULT_CACHE_DIR, ingest_date
from .data.providers.algotest import plan_requests
from .data.raw import DEFAULT_RAW_DIR
from .engine.registry import DEFAULT_REGISTRY_DB

app = typer.Typer(no_args_is_help=True, add_completion=False)
ingest_app = typer.Typer(no_args_is_help=True)
app.add_typer(ingest_app, name="ingest")


def _underlyings(value: str) -> list[str]:
    return [u.strip().upper() for u in value.split(",") if u.strip()]


@ingest_app.command("plan")
def ingest_plan(
    date_: str = typer.Option(..., "--date", help="YYYY-MM-DD (single day; use --to for a range)"),
    to: str | None = typer.Option(None, "--to", help="End date YYYY-MM-DD for a range backfill"),
    underlying: str = typer.Option("NIFTY", "--underlying", help="Comma-separated: NIFTY,SENSEX"),
) -> None:
    """Print the AlgoTest MCP requests needed to cover a day or range —
    consumed by a Claude Code session (interactive or a scheduled Routine),
    which calls the MCP tools and writes raw JSON via data.raw.write_raw."""
    start = date.fromisoformat(date_)
    end = date.fromisoformat(to) if to else start
    all_requests = []
    for u in _underlyings(underlying):
        all_requests.extend(plan_requests(u, start, end))
    typer.echo(json.dumps(all_requests, indent=2))


@ingest_app.callback(invoke_without_command=True)
def ingest_main(
    ctx: typer.Context,
    date_: str = typer.Option(None, "--date", help="YYYY-MM-DD"),
    underlying: str = typer.Option("NIFTY", "--underlying"),
    raw_dir: Path = typer.Option(DEFAULT_RAW_DIR, "--raw-dir"),
    cache_dir: Path = typer.Option(DEFAULT_CACHE_DIR, "--cache-dir"),
) -> None:
    """Read raw JSON for --date and write quality-gated Parquet. Run
    `obt ingest plan` first and get a Claude Code session to populate the raw
    files before calling this."""
    if ctx.invoked_subcommand is not None:
        return
    if date_ is None:
        typer.echo(ctx.get_help())
        raise typer.Exit(code=1)
    day = date.fromisoformat(date_)
    total_bars = 0
    total_flags = []
    for u in _underlyings(underlying):
        result = ingest_date(u, day, raw_dir=raw_dir, cache_dir=cache_dir)
        total_bars += result.bars_written
        total_flags.extend(result.flags)
        typer.echo(f"{u} {day}: {result.bars_written} bars, {len(result.flags)} quality flag(s)")
        for f in result.flags:
            typer.echo(f"  [{f.severity}] {f.gate}: {f.message}")
    if any(f.severity == "error" for f in total_flags):
        raise typer.Exit(code=1)


@app.command()
def validate(strategy_path: Path) -> None:
    """Validate a strategy YAML against the DSL schema."""
    from .strategy.loader import StrategyValidationError, load_strategy

    try:
        loaded = load_strategy(strategy_path)
    except StrategyValidationError as e:
        typer.echo(f"INVALID: {strategy_path}")
        for err in e.errors:
            typer.echo(f"  {err}")
        raise typer.Exit(code=1) from None

    n_ladders = len(loaded.strategy.ladders)
    n_exits = len(loaded.strategy.exits)
    n_features = len(loaded.features)
    typer.echo(
        f"Valid. {loaded.strategy.id}: {n_features} feature(s), "
        f"{n_ladders} ladder(s), {n_exits} exit(s)."
    )


@app.command()
def run(
    strategy_path: Path,
    from_: str = typer.Option(..., "--from"),
    to: str = typer.Option(..., "--to"),
    cache_dir: Path = typer.Option(DEFAULT_CACHE_DIR, "--cache-dir"),
    registry_db: Path = typer.Option(DEFAULT_REGISTRY_DB, "--registry-db"),
    bootstrap: bool = typer.Option(False, "--bootstrap", help="Print a session-level bootstrap CI"),
    bootstrap_resamples: int = typer.Option(2000, "--bootstrap-resamples"),
    seed: int = typer.Option(0, "--seed"),
) -> None:
    """Run a backtest over the cached window and record it in the run registry."""
    from .data.cache import Cache
    from .data.reference.loader import default_reference_data
    from .engine.loop import run_backtest
    from .engine.registry import record_run
    from .engine.result import aggregate, bootstrap_ci, render_bootstrap, render_report
    from .strategy.loader import StrategyValidationError, load_strategy

    try:
        loaded = load_strategy(strategy_path)
    except StrategyValidationError as e:
        typer.echo(f"INVALID: {strategy_path}")
        for err in e.errors:
            typer.echo(f"  {err}")
        raise typer.Exit(code=1) from None

    start = date.fromisoformat(from_)
    end = date.fromisoformat(to)
    cache = Cache(cache_dir)
    reference = default_reference_data()

    sessions = run_backtest(loaded, cache, reference, start, end)
    if not sessions:
        typer.echo(
            f"No cached sessions found for {loaded.strategy.universe.underlying} "
            f"in [{start}, {end}]."
        )
        raise typer.Exit(code=1)

    result = aggregate(sessions)
    typer.echo(render_report(result))

    run_id = record_run(registry_db, loaded.strategy, start, end, result)
    typer.echo(f"\nRecorded as run {run_id} in {registry_db}")

    if bootstrap:
        ci = bootstrap_ci(
            [s.net for s in sessions],
            [s.lot_days for s in sessions],
            n_resamples=bootstrap_resamples,
            seed=seed,
        )
        typer.echo("")
        typer.echo(render_bootstrap(ci))


@app.command()
def registry(
    registry_db: Path = typer.Option(DEFAULT_REGISTRY_DB, "--registry-db"),
    limit: int = typer.Option(20, "--limit"),
) -> None:
    """List past backtest runs."""
    from .engine.registry import list_runs

    runs = list_runs(registry_db, limit=limit)
    if not runs:
        typer.echo(f"No runs recorded yet in {registry_db}.")
        return
    for r in runs:
        typer.echo(
            f"{r.run_id}  {r.strategy_id} (v{r.strategy_version})  "
            f"{r.date_from}..{r.date_to}  net={r.net_inr:.0f}  "
            f"win_days={r.win_days}  INR/lot-day={r.inr_per_lot_day:.0f}"
        )


@app.command(name="export-personality")
def export_personality(run_id: str) -> None:
    """Export a validated run as a personality_configs candidate. Coming in M-5."""
    typer.echo("Not yet implemented — personality export lands in M-5.")
    raise typer.Exit(code=1)


def main() -> None:
    app()


if __name__ == "__main__":
    main()
