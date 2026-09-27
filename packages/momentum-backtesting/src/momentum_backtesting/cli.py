import pandas as pd
import typer

from . import fyers
from .config import DATA_DIR, load_repo_env

app = typer.Typer(no_args_is_help=True, help="Weekly momentum rotation backtester.")


@app.callback()
def _setup() -> None:
    load_repo_env()


def _clipboard() -> str:
    import shutil
    import subprocess

    for command in (["pbpaste"], ["wl-paste", "--no-newline"], ["xclip", "-o", "-sel", "clip"]):
        if shutil.which(command[0]):
            result = subprocess.run(command, capture_output=True, text=True, timeout=5)
            return result.stdout.strip()
    return ""


@app.command()
def login() -> None:
    """Log in to Fyers in the browser and cache today's access token (never printed)."""
    import webbrowser

    try:
        url, state = fyers.build_auth_url()
        typer.echo("Opening the Fyers login page. If it doesn't open, visit:\n\n" + url)
        webbrowser.open(url)
        typer.echo(
            "\nAfter logging in you'll land on a localhost page that may not load - that's fine."
            "\nCopy the full URL from the address bar (Cmd-L, Cmd-C)."
        )
        # Prefer the clipboard: pasting the ~800-character URL into a hidden prompt proved
        # unreliable (it never submitted). The prompt is hidden anyway so that if the URL is
        # pasted, its login code doesn't land in the terminal scrollback.
        typed = typer.prompt(
            "Press Enter once it's copied", default="", show_default=False, hide_input=True
        )
        pasted = typed if "auth_code=" in typed else _clipboard()
        if "auth_code=" not in pasted:
            typer.echo("The clipboard doesn't hold the redirect URL - paste it instead.")
            pasted = typer.prompt("Redirected URL", hide_input=True)
        creds = fyers.exchange_auth_code(fyers.parse_auth_code(pasted, state))
    except fyers.FyersCredentialsError as error:
        typer.echo(f"login failed: {error}")
        raise typer.Exit(1) from None
    fyers.save_token(creds)
    typer.echo(f"ok: token cached until {creds.expires_at:%Y-%m-%d %H:%M %Z}")


@app.command()
def token_status() -> None:
    """Show where the Fyers token would come from and when it expires (never prints it)."""
    try:
        creds = fyers.resolve_credentials()
    except fyers.FyersCredentialsError as error:
        typer.echo(f"not ready: {error}")
        raise typer.Exit(1) from None
    expiry = f", expires {creds.expires_at:%Y-%m-%d %H:%M %Z}" if creds.expires_at else ""
    typer.echo(f"ok: token from {creds.source}{expiry}")


@app.command()
def fetch(
    no_fyers: bool = typer.Option(False, help="Only pull the public sources (cash, silver)."),
    etfs: bool = typer.Option(True, help="Also fetch the traded ETFs and their premium to NAV."),
    intraday: bool = typer.Option(
        False, help="Also fetch 10:00 prices (Fyers 15-min candles) for --execution mon_10am."
    ),
) -> None:
    """Download history and write data/weekly_closes.csv + .xlsx."""
    from .fetch import fetch_all

    try:
        table, coverage = fetch_all(
            use_fyers=not no_fyers, log=typer.echo, etfs=etfs, intraday=intraday
        )
    except fyers.FyersCredentialsError as error:
        typer.echo(f"\n{error}")
        raise typer.Exit(1) from None
    typer.echo(f"\nwrote {table.shape[0]} weeks x {table.shape[1]} indices to {DATA_DIR}")
    late = coverage[coverage["first_week"] > coverage["first_week"].min() + pd.Timedelta(weeks=4)]
    if not late.empty:
        typer.echo("\nseries that start later (they join the ranking once they have history):")
        typer.echo(late[["first_week", "weeks"]].to_string())


def _load_inputs():
    from .fetch import load_universe

    path = DATA_DIR / "weekly_closes.csv"
    if not path.exists():
        typer.echo("No data yet - run `mbt fetch` first.")
        raise typer.Exit(1)
    prices = pd.read_csv(path, index_col=0, parse_dates=True)
    includes = {inst.name: inst.include for inst in load_universe()}
    return prices, includes


def _fills(prices: pd.DataFrame, track: str, execution: str) -> pd.DataFrame | None:
    """The trade-price table for --track/--execution (None = the index at Friday close)."""
    from .trade_prices import build_trade_prices

    try:
        table = build_trade_prices(prices, track, execution)
    except ValueError as error:
        typer.echo(str(error))
        raise typer.Exit(1) from None
    if table is None:
        return None
    for warning in table.warnings:
        typer.echo(f"warning: {warning}")
    return table.prices


def _config(**options):
    from .engine import Config

    def ints(text: str) -> tuple[int, ...]:
        return tuple(int(x) for x in text.split(","))

    weights = options.pop("weights")
    return Config(
        lookbacks=ints(options.pop("lookbacks")),
        weights=tuple(float(x) for x in weights.split(",")) if weights else None,
        **options,
    )


_LOOKBACKS = typer.Option("1,4,13,26,52", help="Lookbacks in weeks, comma-separated.")
_WEIGHTS = typer.Option("", help="Weight per lookback, comma-separated (default equal).")
_TOP = typer.Option(5, help="Number of positions (buy only from this rank or better).")
_EXIT = typer.Option(10, help="Sell once a holding's rank is worse than this.")
_COST = typer.Option(0.10, help="Cost per trade side, in percent.")
_FILTER = typer.Option(13, help="Filter mode: weeks over which an index must beat cash.")
_START = typer.Option("2017-01-01", help="First week of the backtest.")
_OPTIONAL = typer.Option(False, help="Also rank the 'optional' indices.")
_DELAY = typer.Option(0, help="Weeks between the signal and the trade (0 = same close).")
_PORTFOLIO = typer.Option(
    "buffer", help="buffer (hold top N..exit rank, reinvest in top N) | slots (fixed N slots)"
)
_ENTRY = typer.Option("wait", help="Buffer rule, new top-N name with no sale: wait | make_room")
_CAP = typer.Option(35.0, help="Buffer rule: max % of the portfolio in one ETF (0 = no cap).")
_TRACK = typer.Option(
    "index",
    help="P&L on: index (the underlying) | etf (the ETF you'd trade). Ranking is "
    "always on the index.",
)
_EXECUTION = typer.Option(
    "fri_close", help="Trades fill at: fri_close | mon_open | mon_10am (after the signal)."
)


def _print_summary(summary: dict) -> None:
    from .report import pretty

    for key, value in pretty(summary).items():
        typer.echo(f"  {key:<24} {value}")


@app.command()
def backtest(
    defensive: str = typer.Option("off", help="off | ranked | filter"),
    lookbacks: str = _LOOKBACKS,
    weights: str = _WEIGHTS,
    top_n: int = _TOP,
    exit_rank: int = _EXIT,
    cost_pct: float = _COST,
    filter_lookback: int = _FILTER,
    start: str = _START,
    include_optional: bool = _OPTIONAL,
    signal_delay: int = _DELAY,
    portfolio: str = _PORTFOLIO,
    entry: str = _ENTRY,
    max_position: float = _CAP,
    track: str = _TRACK,
    execution: str = _EXECUTION,
) -> None:
    """Run one backtest and write data/backtests/<label>.xlsx."""
    from . import metrics
    from .engine import run_backtest
    from .report import write_result

    prices, includes = _load_inputs()
    config = _config(
        defensive=defensive,
        lookbacks=lookbacks,
        weights=weights,
        top_n=top_n,
        exit_rank=exit_rank,
        cost_pct=cost_pct,
        filter_lookback=filter_lookback,
        start=start,
        include_optional=include_optional,
        signal_delay=signal_delay,
        portfolio=portfolio,
        entry=entry,
        max_position=max_position / 100 or None,
        track=track,
        execution=execution,
    )
    fills = _fills(prices, track, execution)
    result = run_backtest(prices, includes, config, trade_prices=fills)
    path = DATA_DIR / "backtests" / f"{config.label}.xlsx"
    write_result(result, path)
    _print_summary(metrics.summary(result))
    typer.echo(f"\nwrote {path}")


@app.command()
def compare(
    lookbacks: str = _LOOKBACKS,
    weights: str = _WEIGHTS,
    top_n: int = _TOP,
    exit_rank: int = _EXIT,
    cost_pct: float = _COST,
    filter_lookback: int = _FILTER,
    start: str = _START,
    include_optional: bool = _OPTIONAL,
    signal_delay: int = _DELAY,
    portfolio: str = _PORTFOLIO,
    entry: str = _ENTRY,
    max_position: float = _CAP,
    track: str = _TRACK,
    execution: str = _EXECUTION,
) -> None:
    """Run the three defensive modes side by side and write data/backtests/compare.xlsx."""
    from .engine import run_backtest
    from .report import write_comparison, write_result

    prices, includes = _load_inputs()
    fills = _fills(prices, track, execution)
    results = {}
    for mode in ("off", "ranked", "filter"):
        config = _config(
            defensive=mode,
            lookbacks=lookbacks,
            weights=weights,
            top_n=top_n,
            exit_rank=exit_rank,
            cost_pct=cost_pct,
            filter_lookback=filter_lookback,
            start=start,
            include_optional=include_optional,
            signal_delay=signal_delay,
            portfolio=portfolio,
            entry=entry,
            max_position=max_position / 100 or None,
            track=track,
            execution=execution,
        )
        results[mode] = run_backtest(prices, includes, config, trade_prices=fills)
        write_result(results[mode], DATA_DIR / "backtests" / f"{config.label}.xlsx")
    path = DATA_DIR / "backtests" / "compare.xlsx"
    table = write_comparison(results, path)
    typer.echo(table.to_string())
    typer.echo(f"\nwrote {path} (and one workbook per mode alongside it)")


@app.command()
def sweep(
    start: str = _START,
    cost_pct: float = _COST,
    signal_delay: int = _DELAY,
    track: str = _TRACK,
    execution: str = _EXECUTION,
) -> None:
    """Run ~500 nearby settings and show how sensitive the result is (data/backtests/sweep.xlsx)."""
    from . import sweep as sw
    from .engine import Config
    from .report import write_tables

    prices, includes = _load_inputs()
    fills = _fills(prices, track, execution)
    base = Config(
        start=start,
        cost_pct=cost_pct,
        signal_delay=signal_delay,
        track=track,
        execution=execution,
    )
    configs = sw.grid(base)
    typer.echo(f"running {len(configs)} configurations ...")
    full = sw.run_grid(prices, includes, configs, trade_prices=fills)
    tables = {"all runs": full, **sw.plateau_summary(full, base)}
    write_tables(tables, DATA_DIR / "backtests" / "sweep.xlsx")

    pd.options.display.float_format = "{:.3f}".format
    typer.echo("\nCAGR by top-N (rows) and exit rank (columns), default lookbacks:\n")
    typer.echo(tables["CAGR top x exit"].to_string())
    typer.echo("\nSharpe by top-N and exit rank:\n")
    typer.echo(tables["Sharpe top x exit"].to_string())
    typer.echo("\nspread over all configurations, by mode:\n")
    typer.echo(tables["distribution"].to_string())
    typer.echo(f"\nbenchmark (Nifty 50) CAGR: {full['benchmark CAGR'].iloc[0]:.1%}")
    typer.echo(
        f"share of all {len(full)} runs beating the benchmark: "
        f"{(full['CAGR'] > full['benchmark CAGR']).mean():.0%}"
    )
    typer.echo(f"\nwrote {DATA_DIR / 'backtests' / 'sweep.xlsx'}")


@app.command()
def walkforward(
    split: str = typer.Option("2022-01-01", help="Fit on weeks before this date, test from it."),
    select_by: str = typer.Option("Sharpe", help="Sharpe or CAGR - what 'best' means."),
    cost_pct: float = _COST,
    signal_delay: int = _DELAY,
    track: str = _TRACK,
    execution: str = _EXECUTION,
) -> None:
    """Pick settings on the earlier period, then measure them on the later one - and reverse."""
    from . import sweep as sw
    from .engine import Config
    from .report import write_tables

    prices, includes = _load_inputs()
    fills = _fills(prices, track, execution)
    base = Config(cost_pct=cost_pct, signal_delay=signal_delay, track=track, execution=execution)
    configs = sw.grid(base)
    last = prices.index[-1].strftime("%Y-%m-%d")
    before = (pd.Timestamp(split) - pd.Timedelta(days=1)).strftime("%Y-%m-%d")
    cache: dict = {}
    typer.echo(f"{len(configs)} configurations x 2 windows x 2 directions ...")
    forward = sw.walk_forward(
        prices,
        includes,
        configs,
        ("2017-01-01", before),
        (split, last),
        cache=cache,
        select_by=select_by,
        trade_prices=fills,
    )
    reverse = sw.walk_forward(
        prices,
        includes,
        configs,
        (split, last),
        ("2017-01-01", before),
        cache=cache,
        select_by=select_by,
        trade_prices=fills,
    )
    summary = pd.DataFrame(
        {
            f"fit 2017-{before[:4]}  ->  test {split[:4]}-{last[:4]}": forward.summary,
            f"fit {split[:4]}-{last[:4]}  ->  test 2017-{before[:4]}": reverse.summary,
        }
    )
    chosen = pd.DataFrame({"forward": forward.chosen, "reverse": reverse.chosen})
    write_tables(
        {
            "summary": summary,
            "chosen configs": chosen,
            "forward joined": forward.joined,
            "reverse joined": reverse.joined,
        },
        DATA_DIR / "backtests" / "walkforward.xlsx",
    )
    pd.options.display.float_format = "{:.3f}".format
    typer.echo("\n" + summary.to_string())
    typer.echo(
        "\nchosen in the fit period (mode, lookbacks, top N, exit rank):\n  forward: "
        f"{forward.chosen['mode']} {forward.chosen['lookbacks']} top{int(forward.chosen['top_n'])} "
        f"exit{int(forward.chosen['exit_rank'])}\n  reverse: "
        f"{reverse.chosen['mode']} {reverse.chosen['lookbacks']} top{int(reverse.chosen['top_n'])} "
        f"exit{int(reverse.chosen['exit_rank'])}"
    )
    typer.echo(f"\nwrote {DATA_DIR / 'backtests' / 'walkforward.xlsx'}")


@app.command()
def tax(
    slab_rate: list[float] = typer.Option([0.20, 0.30], help="Income-tax slab rate(s) to test."),
    top_n: int = _TOP,
    exit_rank: int = _EXIT,
    cost_pct: float = _COST,
    signal_delay: int = _DELAY,
    track: str = _TRACK,
    execution: str = _EXECUTION,
) -> None:
    """After-tax results: tax is charged on every sale, so paid tax stops compounding."""
    from . import metrics
    from .engine import Config, run_backtest
    from .fetch import load_universe
    from .report import write_tables
    from .tax import TaxRules, benchmark_after_tax, cash_after_tax

    prices, includes = _load_inputs()
    fills = _fills(prices, track, execution)
    classes = {i.name: i.tax_class for i in load_universe()}
    rows = {}
    for slab in slab_rate:
        rules = TaxRules(slab_rate=slab)
        for mode in ("off", "ranked", "filter"):
            base = dict(
                defensive=mode,
                top_n=top_n,
                exit_rank=exit_rank,
                cost_pct=cost_pct,
                signal_delay=signal_delay,
                track=track,
                execution=execution,
            )
            pre = run_backtest(prices, includes, Config(**base), classes, trade_prices=fills)
            post = run_backtest(
                prices, includes, Config(**base, tax=rules), classes, trade_prices=fills
            )
            ledger = post.tax_ledger
            years = (post.equity.index[-1] - post.equity.index[0]).days / 365.25
            bench = benchmark_after_tax(post.benchmark.iloc[-1] - 1, rules) + 1
            cash = cash_after_tax(post.cash.iloc[-1] - 1, rules) + 1
            rows[f"{mode} @ {slab:.0%} slab"] = {
                "pre-tax CAGR": metrics.cagr(pre.equity),
                "after-tax CAGR": metrics.cagr(post.equity),
                "tax cost (CAGR points)": metrics.cagr(pre.equity) - metrics.cagr(post.equity),
                "Nifty 50 buy&hold after tax": bench ** (1 / years) - 1,
                "liquid fund after tax": cash ** (1 / years) - 1,
                "edge over Nifty, after tax": metrics.cagr(post.equity)
                - (bench ** (1 / years) - 1),
                "tax paid (x starting capital)": ledger.paid,
                "sales": ledger.sales,
                "long-term sales": ledger.long_term_sales,
                "after-tax max drawdown": metrics.max_drawdown(post.equity)[0],
            }
    table = pd.DataFrame(rows)
    write_tables({"after tax": table}, DATA_DIR / "backtests" / "after_tax.xlsx")
    pd.options.display.float_format = "{:.3f}".format
    typer.echo(table.to_string())
    typer.echo(f"\nwrote {DATA_DIR / 'backtests' / 'after_tax.xlsx'}")


@app.command()
def tracking(
    top_n: int = _TOP,
    exit_rank: int = _EXIT,
    cost_pct: float = _COST,
    start: str = _START,
    defensive: str = typer.Option("off", help="off | ranked | filter"),
) -> None:
    """How far index P&L is from trading the ETFs: tracking, premiums, fill timing."""
    from .engine import Config
    from .report import write_tables
    from .tracking import (
        all_tables,
        attribution,
        etf_tracking,
        fill_matrix,
        premium_on_trades,
        verdict,
    )
    from .trade_prices import load_premiums

    prices, includes = _load_inputs()
    try:
        tables = all_tables(prices)
    except ValueError as error:
        typer.echo(str(error))
        raise typer.Exit(1) from None
    warnings = {w for table in tables.values() if table is not None for w in table.warnings}
    for warning in sorted(warnings):
        typer.echo(f"warning: {warning}")
    base = Config(
        top_n=top_n, exit_rank=exit_rank, cost_pct=cost_pct, start=start, defensive=defensive
    )
    premiums = load_premiums()
    matrix, results = fill_matrix(prices, includes, base, tables)
    per_etf = etf_tracking(prices, tables[("etf", "fri_close")], premiums)
    on_trades = premium_on_trades(results[("etf", "fri_close")], premiums)
    blame = attribution(results[("index", "fri_close")], results[("etf", "fri_close")])
    lines = verdict(matrix, on_trades)

    path = DATA_DIR / "backtests" / "tracking.xlsx"
    write_tables(
        {
            "verdict": pd.DataFrame({"reading": lines}),
            "track x execution": matrix,
            "per ETF": per_etf,
            "premium on trades": on_trades,
            "P&L by instrument": blame,
            "ETF price sources": tables[("etf", "fri_close")].notes,
        },
        path,
    )
    pd.options.display.float_format = "{:.4f}".format
    typer.echo("\ntrack x execution (same signals, different fills):\n")
    typer.echo(matrix.to_string())
    if not per_etf.empty:
        cols = [
            c
            for c in ("weeks", "tracking difference / yr", "tracking error / yr", "premium mean")
            if c in per_etf
        ]
        typer.echo("\nper ETF, over the weeks it existed:\n")
        typer.echo(per_etf[cols].to_string())
    typer.echo("\n" + "\n".join(f"- {line}" for line in lines))
    typer.echo(f"\nwrote {path}")


# Scheme-name searches for `mbt amfi-codes` - AMFI names differ from the NSE symbols.
AMFI_HINTS = {
    "NIFTYBEES": "Nippon India ETF Nifty 50 BeES",
    "JUNIORBEES": "Nippon India ETF Nifty Next 50 Junior BeES",
    "MID150BEES": "Nippon India ETF Nifty Midcap 150",
    "HDFCSML250": "HDFC NIFTY Smallcap 250 ETF",
    "BANKBEES": "Nippon India ETF Nifty Bank BeES",
    "ITBEES": "Nippon India ETF Nifty IT",
    "PSUBNKBEES": "Nippon India ETF Nifty PSU Bank BeES",
    "PHARMABEES": "Nippon India Nifty Pharma ETF",
    "METALIETF": "ICICI Prudential Nifty Metal ETF",
    "INFRAIETF": "ICICI Prudential Nifty Infrastructure ETF",
    "CPSEETF": "CPSE ETF",
    "MOREALTY": "Motilal Oswal Nifty Realty ETF",
    "FMCGIETF": "ICICI Prudential Nifty FMCG ETF",
    "MOCAPITAL": "Motilal Oswal Nifty Capital Market ETF",
    "AUTOBEES": "Nippon India Nifty Auto ETF",
    "GROWWCHEM": "Groww Nifty Chemicals ETF",
    "MODEFENCE": "Motilal Oswal Nifty India Defence ETF",
    "GOLDBEES": "Nippon India ETF Gold BeES",
    "SILVERBEES": "Nippon India Silver ETF",
    "MON100": "Motilal Oswal Nasdaq 100 ETF",
    "HNGSNGBEES": "Nippon India ETF Hang Seng BeES",
    "ENERGY": "Nifty Energy ETF",
    "PVTBANIETF": "ICICI Prudential Nifty Private Bank ETF",
    "HEALTHIETF": "ICICI Prudential Nifty Healthcare ETF",
    "LTGILTBEES": "Nippon India ETF Nifty 8-13 yr G-Sec Long Term Gilt",
}


@app.command()
def amfi_codes(
    redo: bool = typer.Option(False, help="Also ask for rows that already have a code."),
) -> None:
    """Find each ETF's AMFI scheme code (for premium-to-NAV) and write it into universe.csv."""
    import csv

    from .config import UNIVERSE_CSV
    from .sources import amfi_search

    with UNIVERSE_CSV.open() as f:
        reader = csv.DictReader(f)
        fields, rows = reader.fieldnames, list(reader)
    for row in rows:
        etf = row["trade_etf"]
        if row["index"] == "Cash (liquid fund)" or (row.get("amfi_code") and not redo):
            continue
        query = AMFI_HINTS.get(etf, etf)
        while True:
            matches = [m for m in amfi_search(query) if "IDCW" not in m["schemeName"].upper()]
            typer.echo(f"\n{etf} ({row['index']}) - search '{query}':")
            for i, match in enumerate(matches[:8], start=1):
                typer.echo(f"  {i}. {match['schemeCode']}  {match['schemeName']}")
            answer = typer.prompt(
                "number, blank to skip, or new search text", default="", show_default=False
            ).strip()
            if not answer:
                break
            if answer.isdigit() and 1 <= int(answer) <= min(8, len(matches)):
                row["amfi_code"] = str(matches[int(answer) - 1]["schemeCode"])
                break
            query = answer
    with UNIVERSE_CSV.open("w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=fields, lineterminator="\n")
        writer.writeheader()
        writer.writerows(rows)
    typer.echo(f"\nwrote {UNIVERSE_CSV} - run `mbt fetch` to pull NAVs and premiums")


db_app = typer.Typer(
    no_args_is_help=True, help="Price history in Postgres (MOMENTUM_DATABASE_URL)."
)
app.add_typer(db_app, name="db")


def _db():
    from . import store

    try:
        return store.connect()
    except store.StoreNotConfigured as error:
        typer.echo(f"{error} - point it at a Postgres (e.g. a free Neon project).")
        raise typer.Exit(1) from None


@db_app.command("init")
def db_init() -> None:
    """Create the tables (safe to re-run)."""
    from . import store

    with _db() as conn:
        store.init_schema(conn)
    typer.echo("ok: momentum_prices and momentum_signals exist")


@db_app.command("push")
def db_push(
    since: str = typer.Option("", help="Only rows on/after this date (default: everything)."),
) -> None:
    """Upload data/ (after `mbt fetch`) to the database."""
    from . import store

    with _db() as conn:
        store.init_schema(conn)
        count = store.push_dir(conn, DATA_DIR, pd.Timestamp(since) if since else None)
    typer.echo(f"ok: {count} rows upserted")


@db_app.command("pull")
def db_pull() -> None:
    """Rebuild data/ from the database (what the weekly job does before it runs)."""
    from . import store

    with _db() as conn:
        count = store.pull_dir(conn, DATA_DIR)
    typer.echo(f"ok: {count} rows written under {DATA_DIR}")


@app.command()
def weekly(
    run: str = typer.Option(..., help="preview (~14:40 IST, live prices) | final (after close)"),
    use_db: bool = typer.Option(True, "--db/--no-db", help="Pull history from and save to the DB."),
    send: bool = typer.Option(True, help="Send to Telegram (prints when TELEGRAM_* is unset)."),
) -> None:
    """The Friday signal: refresh prices, rank, and send the week's trades to Telegram."""
    from . import notify
    from .weekly import run_weekly

    if run not in ("preview", "final"):
        typer.echo("--run must be preview or final")
        raise typer.Exit(2)
    try:
        creds = fyers.resolve_credentials()
    except fyers.FyersCredentialsError as error:
        typer.echo(f"Fyers: not used ({error})")
        creds = None
    conn = None
    try:
        if use_db:
            from . import store

            conn = _db()
            store.init_schema(conn)
            if not (DATA_DIR / "weekly_closes.csv").exists():
                typer.echo(f"pulled {store.pull_dir(conn, DATA_DIR)} rows from the database")
        if not (DATA_DIR / "weekly_closes.csv").exists():
            typer.echo("No history: run `mbt fetch` (and `mbt db push`) first.")
            raise typer.Exit(1)
        result = run_weekly(run, DATA_DIR, creds=creds, conn=conn, log=typer.echo)
    except typer.Exit:
        raise
    except Exception as error:
        note = notify.Notification(
            "momentum-weekly",
            "error",
            f"Momentum {run}: the job failed",
            notify.redact(f"{type(error).__name__}: {error}"),
            notify.run_url(),
        )
        notify.send(note) if send else typer.echo(notify.render(note))
        raise
    finally:
        if conn is not None:
            conn.close()
    result.notification.run_url = notify.run_url()
    if send:
        notify.send(result.notification)
    else:
        typer.echo(notify.render(result.notification))


@app.command()
def sources_check() -> None:
    """Can this machine reach every data source? (Run once from GitHub Actions before
    enabling the weekly schedule - some sites block datacenter IPs.)"""
    from datetime import date, timedelta

    from . import sources

    start = date.today() - timedelta(days=10)
    checks = {
        "Yahoo (ETF candles)": lambda: len(sources.yahoo_candles("NIFTYBEES.NS", start)),
        "Yahoo (live quote)": lambda: sources.yahoo_quote("NIFTYBEES.NS")[0],
        "Yahoo (US index)": lambda: len(sources.yahoo_daily("^NDX", start)),
        "AMFI (mfapi.in)": lambda: len(sources.amfi_nav("120304", start)),
        "niftyindices.com": lambda: len(
            sources.niftyindices_candles("NIFTY MIDCAP 150", start, date.today())
        ),
    }
    failed = 0
    for name, check in checks.items():
        try:
            typer.echo(f"  ok    {name}: {check()}")
        except Exception as error:
            failed += 1
            typer.echo(f"  FAIL  {name}: {type(error).__name__}: {str(error)[:120]}")
    try:
        creds = fyers.resolve_credentials()
        closes = fyers.daily_closes("NSE:NIFTY50-INDEX", start, date.today(), creds)
        typer.echo(f"  ok    Fyers ({creds.source}): {len(closes)} days")
    except Exception as error:
        typer.echo(f"  skip  Fyers: {str(error)[:120]}")
    raise typer.Exit(1 if failed else 0)


@app.command()
def ui(
    port: int = typer.Option(8765, help="Port on 127.0.0.1."),
    open_browser: bool = typer.Option(True, help="Open the page in your browser."),
) -> None:
    """Open the local web UI (only reachable from this machine)."""
    import threading
    import webbrowser

    import uvicorn

    url = f"http://127.0.0.1:{port}/"
    if open_browser:
        threading.Timer(1.0, lambda: webbrowser.open(url)).start()
    typer.echo(f"Momentum backtest UI at {url}  (Ctrl-C to stop)")
    uvicorn.run("momentum_backtesting.api:app", host="127.0.0.1", port=port, log_level="warning")


if __name__ == "__main__":
    app()
