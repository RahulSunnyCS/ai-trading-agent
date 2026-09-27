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
) -> None:
    """Download history and write data/weekly_closes.csv + .xlsx."""
    from .fetch import fetch_all

    try:
        table, coverage = fetch_all(use_fyers=not no_fyers, log=typer.echo)
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
    )
    result = run_backtest(prices, includes, config)
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
) -> None:
    """Run the three defensive modes side by side and write data/backtests/compare.xlsx."""
    from .engine import run_backtest
    from .report import write_comparison, write_result

    prices, includes = _load_inputs()
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
        )
        results[mode] = run_backtest(prices, includes, config)
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
) -> None:
    """Run ~500 nearby settings and show how sensitive the result is (data/backtests/sweep.xlsx)."""
    from . import sweep as sw
    from .engine import Config
    from .report import write_tables

    prices, includes = _load_inputs()
    base = Config(start=start, cost_pct=cost_pct, signal_delay=signal_delay)
    configs = sw.grid(base)
    typer.echo(f"running {len(configs)} configurations ...")
    full = sw.run_grid(prices, includes, configs)
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
) -> None:
    """Pick settings on the earlier period, then measure them on the later one - and reverse."""
    from . import sweep as sw
    from .engine import Config
    from .report import write_tables

    prices, includes = _load_inputs()
    base = Config(cost_pct=cost_pct, signal_delay=signal_delay)
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
    )
    reverse = sw.walk_forward(
        prices,
        includes,
        configs,
        (split, last),
        ("2017-01-01", before),
        cache=cache,
        select_by=select_by,
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
) -> None:
    """After-tax results: tax is charged on every sale, so paid tax stops compounding."""
    from . import metrics
    from .engine import Config, run_backtest
    from .fetch import load_universe
    from .report import write_tables
    from .tax import TaxRules, benchmark_after_tax, cash_after_tax

    prices, includes = _load_inputs()
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
            )
            pre = run_backtest(prices, includes, Config(**base), classes)
            post = run_backtest(prices, includes, Config(**base, tax=rules), classes)
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
