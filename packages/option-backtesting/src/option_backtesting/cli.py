"""
`obt` — the option-backtesting CLI.

M-1 implements `ingest plan` and `ingest`. `validate`/`run`/`registry`/
`export-personality` are stubbed here (not `NotImplementedError` — a CLI
should say plainly what's missing) until their milestones land.
"""

from __future__ import annotations

import json
from datetime import date
from pathlib import Path

import typer

from .data.ingest import DEFAULT_CACHE_DIR, ingest_date
from .data.providers.algotest import plan_requests
from .data.raw import DEFAULT_RAW_DIR

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
    """Validate a strategy YAML against the DSL schema. Coming in M-2."""
    typer.echo("Not yet implemented — strategy DSL + loader land in M-2.")
    raise typer.Exit(code=1)


@app.command()
def run(
    strategy_path: Path,
    from_: str = typer.Option(..., "--from"),
    to: str = typer.Option(..., "--to"),
) -> None:
    """Run a backtest over the cached window. Coming in M-3 (the golden
    fixture must reproduce expected.txt to the rupee before this ships)."""
    typer.echo("Not yet implemented — the engine (loop/fills/costs/ledger) lands in M-3.")
    raise typer.Exit(code=1)


@app.command()
def registry() -> None:
    """List past backtest runs. Coming in M-3 (SQLite registry)."""
    typer.echo("Not yet implemented — the run registry lands in M-3.")
    raise typer.Exit(code=1)


@app.command(name="export-personality")
def export_personality(run_id: str) -> None:
    """Export a validated run as a personality_configs candidate. Coming in M-5."""
    typer.echo("Not yet implemented — personality export lands in M-5.")
    raise typer.Exit(code=1)


def main() -> None:
    app()


if __name__ == "__main__":
    main()
