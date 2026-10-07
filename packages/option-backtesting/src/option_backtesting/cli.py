"""
`obt` — the option-backtesting CLI.

M-1 implements `ingest plan` and `ingest`. M-2 implements `validate`. M-3
implements `run` and `registry`. M-5 adds `walkforward`, `sweep` (with
`--overfit`), and `export-personality`. `fyers status|fetch` is the daily
1-minute Fyers collector (see `fyers/daily.py`); `legwise run` backtests
AlgoTest-style strategies over that data (see `legwise/`).
"""

from __future__ import annotations

import json
from datetime import date, datetime, time, timedelta, timezone
from pathlib import Path

import typer

from .data.ingest import DEFAULT_CACHE_DIR, ingest_date
from .data.providers.algotest import plan_requests
from .data.raw import DEFAULT_RAW_DIR

app = typer.Typer(no_args_is_help=True, add_completion=False)
ingest_app = typer.Typer(no_args_is_help=True)
app.add_typer(ingest_app, name="ingest")
fyers_app = typer.Typer(no_args_is_help=True, help="Daily 1-minute Fyers collector.")
app.add_typer(fyers_app, name="fyers")
legwise_app = typer.Typer(no_args_is_help=True, help="AlgoTest-style leg-wise backtests.")
app.add_typer(legwise_app, name="legwise")


@app.callback()
def _load_env() -> None:
    """Fill unset env vars from the repo-root .env before any command. Without this only
    the commands that resolve Fyers credentials saw it, so `obt daily --no-fetch` or
    `obt legwise run` silently used the default TRADING_DATA_ROOT."""
    from .fyers.auth import load_dotenv

    load_dotenv()


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
    bootstrap: bool = typer.Option(False, "--bootstrap", help="Print a session-level bootstrap CI"),
    bootstrap_resamples: int = typer.Option(2000, "--bootstrap-resamples"),
    seed: int = typer.Option(0, "--seed"),
) -> None:
    """Run a backtest over the cached window and record it in the run registry."""
    from trading_data.db import connect

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

    with connect(views=()) as con:
        run_id = record_run(con, loaded.strategy, start, end, result, strategy_path.read_text())
    typer.echo(f"\nRecorded as run {run_id} in the shared catalog.")

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
    limit: int = typer.Option(20, "--limit"),
) -> None:
    """List past backtest runs."""
    from trading_data.db import catalog_path, connect, data_root

    from .engine.registry import list_runs

    if not catalog_path(data_root()).exists():
        typer.echo("No runs recorded yet — no catalog at that path (run `tdata init` first).")
        return
    with connect(read_only=True, views=()) as con:
        runs = list_runs(con, limit=limit)
    if not runs:
        typer.echo("No runs recorded yet in the shared catalog.")
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
def export_personality_cmd(run_id: str) -> None:
    """Export a recorded run's strategy as a personality_configs candidate
    ({entryType, managementStyle, params}), with anything the DSL expresses
    that PersonalityConfigM2 has no field for listed under manual_review.
    Never writes to any database — prints JSON for a human to review."""
    from trading_data.db import catalog_path, connect, data_root

    from .engine.registry import get_run
    from .export.personality import export_personality
    from .strategy.loader import StrategyValidationError, load_strategy_from_source

    record = None
    if catalog_path(data_root()).exists():
        with connect(read_only=True, views=()) as con:
            record = get_run(con, run_id)
    if record is None:
        typer.echo(f"Unknown run_id {run_id!r} in the shared catalog.")
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


@fyers_app.command("status")
def fyers_status() -> None:
    """Where today's Fyers token comes from and where data is written (never prints the token)."""
    from .fyers.auth import FyersCredentialsError, resolve_credentials
    from .fyers.daily import data_dir

    typer.echo(f"data dir: {data_dir()}")
    try:
        creds = resolve_credentials()
    except FyersCredentialsError as error:
        typer.echo(f"token: not ready - {error}")
        raise typer.Exit(1) from None
    expiry = f", expires {creds.expires_at:%Y-%m-%d %H:%M %Z}" if creds.expires_at else ""
    typer.echo(f"token: ok, from {creds.source}{expiry}")


@fyers_app.command("fetch")
def fyers_fetch(
    day: str = typer.Option(date.today().isoformat(), "--date", help="Trading day, YYYY-MM-DD."),
    underlyings: str = typer.Option(
        "NIFTY,BANKNIFTY,MIDCPNIFTY,FINNIFTY,SENSEX", help="Comma-separated underlyings."
    ),
    premium_floor: float = typer.Option(
        2.0, help="Keep walking outward while the OTM leg's intraday high is at least this (Rs)."
    ),
    max_extra: int = typer.Option(
        60, help="Cap on strikes fetched beyond the day's range, per side."
    ),
    force: bool = typer.Option(False, help="Re-fetch underlyings already collected for this day."),
) -> None:
    """Collect one day's 1-minute index, VIX, future and option candles. Run it the same
    evening: contracts expiring that day cannot be fetched once they have expired."""

    from .fyers.auth import FyersCredentialsError

    try:
        errors = _collect(date.fromisoformat(day), underlyings, premium_floor, max_extra, force)
    except FyersCredentialsError as error:
        typer.echo(f"stopped: {error}")
        raise typer.Exit(1) from None
    if errors:
        raise typer.Exit(2)


@fyers_app.command("history")
def fyers_history(
    underlying: str = typer.Option(
        "NIFTY", help="Underlying whose index (and India VIX) to backfill."
    ),
    from_: str = typer.Option(
        "", "--from", help="Oldest day to fetch, YYYY-MM-DD. Blank = as far back as Fyers serves."
    ),
    to: str = typer.Option("", "--to", help="Newest day, YYYY-MM-DD. Blank = yesterday."),
    force: bool = typer.Option(False, help="Rewrite days already in the lake."),
) -> None:
    """Backfill the index + India VIX 1-minute history (walks back from yesterday in
    95-day chunks until Fyers has no more). Index bars never expire, so unlike option
    contracts this can be done any time, and re-running only fills what is missing.
    Feeds the Options Lab's market-regime study."""

    from .fyers.auth import FyersCredentialsError, resolve_credentials
    from .fyers.client import FyersClient
    from .fyers.daily import UNDERLYINGS, data_dir
    from .fyers.history import backfill_index

    if underlying not in UNDERLYINGS:
        raise typer.BadParameter(f"unknown underlying {underlying}; known: {sorted(UNDERLYINGS)}")
    try:
        client = FyersClient(resolve_credentials())
        result = backfill_index(
            client,
            data_dir(),
            underlying,
            start=date.fromisoformat(from_) if from_ else None,
            end=date.fromisoformat(to) if to else None,
            force=force,
            log=typer.echo,
        )
    except FyersCredentialsError as error:
        typer.echo(f"stopped: {error}")
        raise typer.Exit(1) from None
    typer.echo(
        f"done: {client.calls} requests; wrote {result['written_days']} days"
        f"{f', oldest {result["oldest"]}' if result['oldest'] else ''}; "
        f"{len(result['short_days'])} short days skipped -> {data_dir()}"
    )


def _collect(
    trading_day: date, underlyings: str, premium_floor: float, max_extra: int, force: bool
) -> int:
    """`fyers fetch`: collect one day, return the per-symbol error count. A token problem
    raises FyersCredentialsError for the caller to report."""
    from .legwise.evening import UnknownUnderlying, collect

    try:
        return collect(
            trading_day,
            _underlyings(underlyings),
            premium_floor=premium_floor,
            max_extra=max_extra,
            force=force,
            log=typer.echo,
        )
    except UnknownUnderlying as error:
        raise typer.BadParameter(str(error)) from None


@fyers_app.command("migrate")
def fyers_migrate(
    from_: Path = typer.Option(
        Path(__file__).parent.parent.parent / "data" / "fyers",
        "--from",
        help="The old FYERS_DATA_DIR layout (1m/, symbols/, manifest/, results/).",
    ),
) -> None:
    """One-off: copy the pre-database Fyers data into TRADING_DATA_ROOT (lake + catalog).
    Copies, never deletes — remove the old folder yourself once `tdata status` looks right."""
    from .fyers.daily import data_dir, migrate_legacy

    if not from_.exists():
        raise typer.BadParameter(f"{from_} does not exist")
    n = migrate_legacy(from_, data_dir(), log=typer.echo)
    typer.echo(f"done: {n} day(s) migrated into {data_dir()}")


@legwise_app.command("run")
def legwise_run(
    strategies: list[Path] = typer.Argument(..., help="Leg-wise strategy YAML file(s)."),
    from_: str | None = typer.Option(None, "--from", help="First day, YYYY-MM-DD."),
    to: str | None = typer.Option(None, "--to", help="Last day, YYYY-MM-DD."),
    trades: bool = typer.Option(False, "--trades", help="List every trade."),
    include_excluded: bool = typer.Option(
        False,
        "--include-excluded",
        help="Also run days data_quality excludes (special/short sessions, thin chains, no spot).",
    ),
    bars: str = typer.Option(
        "1m",
        "--bars",
        help="1m: the raw 1-minute lake. 5m: the 5-minute chain snapshots (tdata derived "
        "rebuild) — much faster; strategy times must be on 5-minute marks.",
    ),
) -> None:
    """Backtest leg-wise strategies over the lake's days (vendor history and Fyers)."""
    from .fyers.daily import data_dir
    from .legwise.engine import run_legwise, skipped_summary
    from .legwise.market import UnsupportedOn5m
    from .legwise.report import day_table
    from .legwise.schema import load_legwise

    start = date.fromisoformat(from_) if from_ else None
    end = date.fromisoformat(to) if to else None
    for path in strategies:
        strategy = load_legwise(path)
        skipped: dict[date, str] = {}
        try:
            days = run_legwise(
                strategy,
                data_dir(),
                start,
                end,
                include_excluded=include_excluded,
                skipped=skipped,
                bars=bars,
            )
        except UnsupportedOn5m as error:
            raise typer.BadParameter(str(error)) from error
        typer.echo(day_table(strategy.id, days, show_trades=trades))
        if skipped:
            typer.echo(skipped_summary(skipped))
        typer.echo("")


@legwise_app.command("compare")
def legwise_compare(
    strategy_path: Path = typer.Argument(..., help="Leg-wise strategy YAML."),
    algotest_csv: Path = typer.Argument(..., help="AlgoTest trade-log export (Download Report)."),
    from_: str | None = typer.Option(None, "--from", help="First day, YYYY-MM-DD."),
    to: str | None = typer.Option(None, "--to", help="Last day, YYYY-MM-DD."),
    out: Path | None = typer.Option(None, "--out", help="Write the Markdown report here."),
) -> None:
    """Run a strategy over the days of an AlgoTest backtest export and compare trade by trade:
    strikes, exit reasons, minutes, prices, P&L (BL-009 Phase 1)."""
    from .fyers.daily import data_dir
    from .legwise.algotest import compare, load_algotest_csv, report
    from .legwise.engine import run_legwise
    from .legwise.schema import load_legwise

    strategy = load_legwise(strategy_path)
    theirs = load_algotest_csv(algotest_csv)
    start = date.fromisoformat(from_) if from_ else None
    end = date.fromisoformat(to) if to else None
    theirs = [d for d in theirs if not ((start and d.day < start) or (end and d.day > end))]
    if not theirs:
        raise typer.BadParameter("no AlgoTest days in that range")
    skipped: dict[date, str] = {}
    ours = run_legwise(
        strategy,
        data_dir(),
        theirs[0].day,
        theirs[-1].day,
        include_excluded=True,
        skipped=skipped,
        only_days={d.day for d in theirs},
    )
    text = report(compare(theirs, ours, strategy, skipped), strategy)
    if out:
        out.write_text(text)
        typer.echo(f"wrote {out}")
    typer.echo(text if not out else text.split("## Days that differ")[0])


@legwise_app.command("rerun")
def legwise_rerun(
    from_: str | None = typer.Option(None, "--from", help="First day, YYYY-MM-DD."),
    to: str | None = typer.Option(None, "--to", help="Last day, YYYY-MM-DD."),
    strategies_dir: Path = typer.Option(
        Path(__file__).parent.parent.parent / "strategies" / "legwise",
        help="Folder of leg-wise strategy YAMLs.",
    ),
) -> None:
    """Re-run every strategy over every collected day and save the daily results — after
    editing a strategy (its old days show as stale until re-run), or to rebuild results."""
    from .fyers.daily import data_dir
    from .legwise.daily import load_strategy_files, run_day
    from .legwise.market import available_days

    root = data_dir()
    files = load_strategy_files(strategies_dir)
    days = sorted({d for f in files for d in available_days(root, f.strategy.underlying)})
    start = date.fromisoformat(from_) if from_ else None
    end = date.fromisoformat(to) if to else None
    days = [d for d in days if not ((start and d < start) or (end and d > end))]
    for d in days:
        records = run_day(d, root, files)
        done = sum(1 for r in records if "skipped" not in r)
        typer.echo(f"{d}: {done}/{len(files)} strategies saved")
    typer.echo(f"done: {len(days)} day(s)")


def _last_closed_session(now: datetime) -> date:
    """The latest trading day whose session (and Fyers' 15:40 F&O close) has ended, in IST."""
    from .data.reference.loader import default_reference_data

    reference = default_reference_data()
    day = now.date() if now.time() >= time(15, 45) else now.date() - timedelta(days=1)
    while not reference.is_trading_day(day):
        day -= timedelta(days=1)
    return day


@app.command()
def daily(
    day: str | None = typer.Option(
        None, "--date", help="Trading day (default: the last session that has closed, IST)."
    ),
    fetch: bool = typer.Option(True, "--fetch/--no-fetch", help="Collect the day's data first."),
    strategies_dir: Path = typer.Option(
        Path(__file__).parent.parent.parent / "strategies" / "legwise",
        help="Folder of leg-wise strategy YAMLs to run.",
    ),
    underlyings: str = typer.Option(
        "NIFTY,BANKNIFTY,MIDCPNIFTY,FINNIFTY,SENSEX", help="Underlyings to collect."
    ),
    telegram: bool = typer.Option(
        True, "--telegram/--no-telegram", help="Send the summary to Telegram (TELEGRAM_* in .env)."
    ),
) -> None:
    """The evening routine: collect the day's 1-minute data, judge it (data_quality) and build
    its derived tables (5-minute snapshots, IV), run every leg-wise strategy on it, save the
    results, print the day's P&L with running totals, the data verdicts and the IV percentile,
    and send it to Telegram."""
    from .fyers.auth import FyersCredentialsError
    from .legwise.daily import telegram_failure
    from .legwise.evening import UnknownUnderlying, run_daily
    from .notify import send

    ist = timezone(timedelta(hours=5, minutes=30))
    trading_day = date.fromisoformat(day) if day else _last_closed_session(datetime.now(ist))
    try:
        run_daily(
            trading_day,
            _underlyings(underlyings),
            strategies_dir,
            fetch=fetch,
            telegram=telegram,
            log=typer.echo,
        )
    except UnknownUnderlying as error:
        raise typer.BadParameter(str(error)) from None
    except FyersCredentialsError as error:
        typer.echo(f"stopped: {error}")
        if telegram:
            send(telegram_failure(trading_day, str(error)))
        raise typer.Exit(1) from None


def main() -> None:
    app()


if __name__ == "__main__":
    main()
