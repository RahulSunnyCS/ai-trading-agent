"""
`obt` — the option-backtesting CLI.

M-1 implements `ingest plan` and `ingest`. M-2 implements `validate`. M-3
implements `run` and `registry`. M-5 adds `walkforward`, `sweep` (with
`--overfit`), and `export-personality`.
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

    from .engine.margin import compute_return_on_peak_margin, render_margin

    try:
        margin = compute_return_on_peak_margin(loaded.strategy, reference, result)
    except (NotImplementedError, ValueError) as e:
        margin = None
        typer.echo(f"\n(margin not computed: {e})")
    if margin is not None:
        typer.echo("")
        typer.echo(render_margin(margin))

    from .features.regime import regime_bucket_report

    regime_buckets = regime_bucket_report(sessions, loaded.strategy.universe.underlying)
    if regime_buckets is not None:
        typer.echo("\nRegime breakdown (lag-1):")
        for regime_name in sorted(regime_buckets):
            typer.echo(f"  {regime_name}: {regime_buckets[regime_name]:.0f}")

    run_id = record_run(registry_db, loaded.strategy, start, end, result, strategy_path.read_text())
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


@app.command()
def walkforward(
    strategy_path: Path,
    is_from: str = typer.Option(..., "--is-from"),
    is_to: str = typer.Option(..., "--is-to"),
    oos_from: str = typer.Option(..., "--oos-from"),
    oos_to: str = typer.Option(..., "--oos-to"),
    cache_dir: Path = typer.Option(DEFAULT_CACHE_DIR, "--cache-dir"),
) -> None:
    """Run a strategy, unchanged, over an in-sample window and a strictly
    later out-of-sample window; the OOS figures are the headline. No
    parameter re-fitting happens between windows — our strategies are
    hand-authored YAML, not tunable, so this is a same-strategy split-window
    comparison, not a re-optimizing walk-forward loop."""
    from .analytics.walkforward import render_walkforward, run_walkforward
    from .data.cache import Cache
    from .data.reference.loader import default_reference_data
    from .strategy.loader import StrategyValidationError, load_strategy

    try:
        loaded = load_strategy(strategy_path)
    except StrategyValidationError as e:
        typer.echo(f"INVALID: {strategy_path}")
        for err in e.errors:
            typer.echo(f"  {err}")
        raise typer.Exit(code=1) from None

    cache = Cache(cache_dir)
    reference = default_reference_data()

    try:
        result = run_walkforward(
            loaded,
            cache,
            reference,
            date.fromisoformat(is_from),
            date.fromisoformat(is_to),
            date.fromisoformat(oos_from),
            date.fromisoformat(oos_to),
        )
    except ValueError as e:
        typer.echo(str(e))
        raise typer.Exit(code=1) from None

    typer.echo(render_walkforward(result))


@app.command()
def sweep(
    strategy_path: Path,
    changes_path: Path = typer.Option(..., "--changes", help="JSON file: a list of change-dicts"),
    from_: str = typer.Option(..., "--from"),
    to: str = typer.Option(..., "--to"),
    cache_dir: Path = typer.Option(DEFAULT_CACHE_DIR, "--cache-dir"),
    overfit: bool = typer.Option(
        False, "--overfit", help="Also run CSCV/PBO + deflated Sharpe over the sweep results"
    ),
    n_blocks: int = typer.Option(4, "--n-blocks", help="CSCV block count (even, >=2)"),
) -> None:
    """Run `strategy_path` as the base, deep-merging each change-dict in
    `--changes` (a JSON array) over it, and report every configuration's
    result over the same window — the raw material for CSCV/PBO overfitting
    analysis (see `analytics.overfit`, `--overfit`)."""
    from .analytics.sweep import render_sweep, run_sweep
    from .data.cache import Cache
    from .data.reference.loader import default_reference_data

    changes_list = json.loads(changes_path.read_text())
    if not isinstance(changes_list, list):
        typer.echo(f"{changes_path} must contain a JSON array of change-dicts.")
        raise typer.Exit(code=1)

    cache = Cache(cache_dir)
    reference = default_reference_data()

    try:
        report = run_sweep(
            strategy_path.read_text(),
            changes_list,
            cache,
            reference,
            date.fromisoformat(from_),
            date.fromisoformat(to),
        )
    except ValueError as e:
        typer.echo(str(e))
        raise typer.Exit(code=1) from None

    typer.echo(render_sweep(report))

    if overfit:
        from .analytics.overfit import render_overfit, run_cscv, run_deflated_sharpe

        try:
            cscv = run_cscv(report, n_blocks=n_blocks)
            dsr = run_deflated_sharpe(report)
        except ValueError as e:
            typer.echo(f"\n(overfit analysis not computed: {e})")
            return
        typer.echo("")
        typer.echo(render_overfit(cscv, dsr))


@app.command(name="export-personality")
def export_personality_cmd(
    run_id: str,
    registry_db: Path = typer.Option(DEFAULT_REGISTRY_DB, "--registry-db"),
) -> None:
    """Export a recorded run's strategy as a personality_configs candidate
    ({entryType, managementStyle, params}), with anything the DSL expresses
    that PersonalityConfigM2 has no field for listed under manual_review.
    Never writes to any database — prints JSON for a human to review."""
    from .engine.registry import get_run
    from .export.personality import export_personality
    from .strategy.loader import StrategyValidationError, load_strategy_from_source

    record = get_run(registry_db, run_id)
    if record is None:
        typer.echo(f"Unknown run_id {run_id!r} in {registry_db}.")
        raise typer.Exit(code=1)
    if record.strategy_yaml is None:
        typer.echo(
            f"Run {run_id} was recorded before strategy_yaml was tracked (pre-M-5) — "
            f"re-run `obt run` on this strategy to record it with export support."
        )
        raise typer.Exit(code=1)

    try:
        loaded = load_strategy_from_source(record.strategy_yaml, label=f"run {run_id}")
    except StrategyValidationError as e:
        typer.echo("Stored strategy_yaml failed to re-validate:")
        for err in e.errors:
            typer.echo(f"  {err}")
        raise typer.Exit(code=1) from None
    assert loaded.strategy is not None

    export = export_personality(loaded.strategy)
    output = {
        "source_run_id": run_id,
        "source_strategy_id": loaded.strategy.id,
        "entryType": export.entry_type,
        "managementStyle": export.management_style,
        "params": export.params,
        "manual_review": export.manual_review,
    }
    typer.echo(json.dumps(output, indent=2))


def main() -> None:
    app()


if __name__ == "__main__":
    main()
