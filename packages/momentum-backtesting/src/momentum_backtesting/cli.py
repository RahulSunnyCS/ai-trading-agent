from datetime import date
from pathlib import Path

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


local_app = typer.Typer(
    no_args_is_help=True,
    help="The shared local research database (packages/trading-data, TRADING_DATA_ROOT).",
)
app.add_typer(local_app, name="local")


@local_app.command("migrate")
def local_migrate() -> None:
    """Copy companies/renames/corporate-actions/membership, stock daily bars, and the
    index/ETF/premium/weekly price series into the shared local database. The curated
    CSVs and data/ stay the master copies — safe to re-run; every table/partition this
    touches is replaced wholesale, never appended to."""
    from trading_data.db import connect, data_root

    from . import db_migrate

    root = data_root()
    with connect(root) as con:
        report = db_migrate.migrate(con, root)
    typer.echo(
        f"companies {report.companies}, renames {report.company_symbols}, "
        f"corporate actions {report.corporate_actions}, "
        f"NIFTY50 membership rows {report.index_membership}, "
        f"category membership rows {report.category_membership} "
        f"(of which Total Market: {report.total_market_membership})"
    )
    typer.echo(
        f"stock instruments {report.stock_instruments}, bars {report.stock_bars:,} "
        f"over {report.stock_years} year(s), momentum_prices rows {report.momentum_prices:,}"
    )
    typer.echo(
        f"stock weekly prices {report.stock_weekly_prices:,}, "
        f"stock weekly membership {report.stock_membership_weekly:,}, "
        f"stock benchmark/cash rows {report.stock_weekly_series:,}"
    )
    typer.echo(f"catalog: {root}  (see `tdata status` for the full picture)")


stocks_app = typer.Typer(
    no_args_is_help=True, help="Nifty 50 survivorship-free stock data layer (plan.md, stocks/)."
)
app.add_typer(stocks_app, name="stocks")


def _stocks_data_dir() -> Path:
    return DATA_DIR / "stocks"


def _stocks_curated_dir() -> Path:
    # The package's own committed curated/ dir (src/momentum_backtesting/stocks/curated),
    # not a data/ path -- these files are package data, checked into git (plan.md §6).
    return Path(__file__).parent / "stocks" / "curated"


#: niftyindices.com index name -> raw TRI snapshot filename (matches the names
#: adjust.load_tri_local / build_benchmarks_weekly already read).
_BENCHMARK_TRI_FILES = {
    "NIFTY_50_TRI.json": "NIFTY 50",
    "NIFTY200_MOMENTUM_30_TRI.json": "NIFTY200 MOMENTUM 30",
    "NIFTY50_EQUAL_WEIGHT_TRI.json": "NIFTY50 EQUAL WEIGHT",
}


def _fetch_niftyindices_tri_raw(name: str, start, end) -> list[dict]:
    """Fetch the raw getTotalReturnIndexString rows for `name` across
    yearly-or-smaller chunks (niftyindices.com allows at most ~1 year per
    request) and return them unparsed.

    Deliberately separate from sources.niftyindices_tri_daily: that function
    (the ETF path's, T4's) parses straight to a pd.Series and never touches
    disk, but adjust.load_tri_local needs the *raw* JSON rows written under
    raw/benchmarks/ (plan.md's out-of-band snapshot shape) so this replicates
    sources._niftyindices_history's request shape locally rather than editing
    sources.py (out of T8's scope) to add a raw-row-returning mode.
    """
    import json
    import time
    import urllib.request
    from datetime import timedelta

    from .sources import NIFTYINDICES_TRI_URL

    rows: list[dict] = []
    chunk_start = start
    while chunk_start <= end:
        chunk_end = min(chunk_start + timedelta(days=364), end)
        cinfo = str(
            {
                "name": name,
                "startDate": f"{chunk_start:%d-%b-%Y}",
                "endDate": f"{chunk_end:%d-%b-%Y}",
                "indexName": name,
            }
        )
        request = urllib.request.Request(
            NIFTYINDICES_TRI_URL,
            data=json.dumps({"cinfo": cinfo}).encode(),
            headers={
                "User-Agent": "Mozilla/5.0",
                "Content-Type": "application/json; charset=UTF-8",
                "Referer": "https://www.niftyindices.com/reports/historical-data",
                "X-Requested-With": "XMLHttpRequest",
            },
        )
        body = json.load(urllib.request.urlopen(request, timeout=60))  # noqa: S310
        payload = body.get("d", body) if isinstance(body, dict) else body
        chunk_rows = json.loads(payload) if isinstance(payload, str) else payload
        rows.extend(chunk_rows or [])
        chunk_start = chunk_end + timedelta(days=1)
        time.sleep(0.5)
    return rows


def _refresh_benchmark_raw_files(raw_dir: Path, start, end) -> None:
    """Refresh raw/benchmarks/*.json (TRI x3) + NIFTY50_EQUAL_WEIGHT_PRICE.csv.

    The three TRI snapshots are written as raw JSON rows (adjust.load_tri_local's
    expected shape). The EW *price* file is written already-parsed as a plain
    date,close CSV -- matching the shape of the out-of-band file it replaces
    (see benchmarks.fetch_equal_weight_price / adjust.load_ew_price_local's
    docstrings: this is a parsed CSV, not a JSON row dump, because
    load_ew_price_local reads it straight with pd.read_csv).
    """
    import json

    from .stocks import benchmarks
    from .stocks.nse import atomic_write_bytes

    bench_dir = raw_dir / "benchmarks"
    bench_dir.mkdir(parents=True, exist_ok=True)

    for filename, index_name in _BENCHMARK_TRI_FILES.items():
        rows = _fetch_niftyindices_tri_raw(index_name, start, end)
        atomic_write_bytes(bench_dir / filename, json.dumps(rows).encode("utf-8"))

    price = benchmarks.fetch_equal_weight_price(start, end)
    price_df = price.rename("close").rename_axis("date").reset_index()
    price_df.to_csv(bench_dir / "NIFTY50_EQUAL_WEIGHT_PRICE.csv", index=False)


def _print_fetch_summary(report, div_report: pd.DataFrame | None) -> None:
    from .stocks.schemas import GuardSeverity

    n_f = sum(1 for g in report.guard_results if g.severity == GuardSeverity.F)
    n_g = len(report.guard_results) - n_f
    typer.echo(f"\nguards: {n_f} F (failing), {n_g} G (flagged), {report.elapsed_seconds:.1f}s")
    if report.event_counts:
        typer.echo("events by kind/source:")
        for key, n in sorted(report.event_counts.items()):
            typer.echo(f"  {key:<40} {n}")
    if not report.ca_diff.empty:
        typer.echo(f"CA event diff: {len(report.ca_diff)} row(s) vs the committed baseline")
    if report.baseline_created:
        typer.echo("events_baseline.csv.gz created (first run)")
    if report.cash_weekly_skipped:
        typer.echo(f"cash_weekly skipped: {report.cash_weekly_skipped}")
    if div_report is not None:
        n_flags = int((div_report["verdict"] == "flag").sum())
        typer.echo(f"dividend verifier: {n_flags} flagged day(s) of {len(div_report)}")
    typer.echo("\nwrote:")
    for path in report.outputs_written:
        typer.echo(f"  {path}")
    if n_f:
        typer.echo(f"\n{n_f} guard failure(s) -- see fetch_report.csv")


@stocks_app.command("fetch")
def stocks_fetch(
    from_: str = typer.Option(
        "2011-01-01", "--from", help="Start date (YYYY-MM-DD) for CA history / bhavcopy download."
    ),
    skip_download: bool = typer.Option(
        False,
        "--skip-download",
        help="No network -- rebuild from the already-downloaded raw cache.",
    ),
    accept_ca_diff: Path | None = typer.Option(
        None,
        "--accept-ca-diff",
        help="CSV of previously reviewed (company_id, ex_date, subject_sha1) rows -- accepts a "
        ">30-day-old CA event diff for these keys and advances the baseline.",
    ),
) -> None:
    """Fetch/refresh the raw cache and rebuild daily.parquet, events.parquet and
    every data/stocks/ output (plan.md §7 T8). Exits non-zero if any guard fails.
    """
    from datetime import date as date_cls

    from .stocks import adjust, bhavcopy, corporate_actions, validate
    from .stocks.nse import NseClient

    start = date_cls.fromisoformat(from_)
    data_dir = _stocks_data_dir()
    curated_dir = _stocks_curated_dir()
    raw_dir = data_dir / "raw"

    if not skip_download:
        client = NseClient()
        typer.echo("refreshing benchmark raw files (TRI x3 + EW price)...")
        _refresh_benchmark_raw_files(raw_dir, start, date_cls.today())

        typer.echo("fetching the corporate-actions history (quarterly snapshots)...")
        try:
            corporate_actions.fetch_history(raw_dir, client, start=start)
        except ValueError as error:
            typer.echo(f"CA fetch guard failed: {error}")
            raise typer.Exit(1) from None

        typer.echo("downloading bhavcopies for the TRI session calendar...")
        tri_dates = adjust.load_tri_local(raw_dir, "NIFTY_50_TRI.json").index
        sessions = [ts.date() for ts in tri_dates]
        bhavcopy.download(sessions, raw_dir, client)

        typer.echo("rebuilding daily.parquet from the raw bhavcopy cache...")
        stats = bhavcopy.build_daily_parquet(raw_dir, data_dir / "daily.parquet")
        typer.echo(
            f"  {stats.rows} rows, {stats.n_symbols} symbols, {stats.date_min}..{stats.date_max}"
        )

    if not (data_dir / "daily.parquet").exists():
        typer.echo("No data/stocks/daily.parquet yet -- run without --skip-download first.")
        raise typer.Exit(1)

    typer.echo("\nrunning adjust.build_all (company resolution, guards, outputs)...")
    report = adjust.build_all(data_dir, curated_dir, accept_ca_diff=accept_ca_diff)

    div_report = None
    try:
        typer.echo("running the dividend verifier...")
        curated = adjust.load_curated(curated_dir)
        events = pd.read_parquet(data_dir / "events.parquet")
        daily = pd.read_parquet(data_dir / "daily.parquet")
        tri = adjust.load_tri_local(raw_dir, "NIFTY50_EQUAL_WEIGHT_TRI.json")
        price = adjust.load_ew_price_local(raw_dir)
        div_report = validate.dividend_check(
            tri, price, events, curated["nifty50_membership.csv"], daily
        )
        div_report.to_csv(data_dir / "dividend_check.csv", index=False)
    except FileNotFoundError as error:
        typer.echo(f"dividend verifier skipped: {error}")

    _print_fetch_summary(report, div_report)

    if report.n_failures() > 0:
        raise typer.Exit(1)


@stocks_app.command("pin-manifest")
def stocks_pin_manifest() -> None:
    """Pin the current raw cache as the reproducibility baseline: copy
    data/stocks/raw_manifest.csv into curated/raw_manifest.pinned.csv, and
    advance curated/events_baseline.csv.gz to this run's events (plan.md §2 --
    "the accepted state moves forward"). No network; re-derives events from the
    already-downloaded raw cache the same way adjust.build_all's steps 2-4 do.
    """
    import shutil

    from .stocks import adjust

    data_dir = _stocks_data_dir()
    curated_dir = _stocks_curated_dir()
    manifest_path = data_dir / "raw_manifest.csv"

    if not manifest_path.exists():
        typer.echo("No data/stocks/raw_manifest.csv yet -- run `mbt stocks fetch` first.")
        raise typer.Exit(1)

    pinned_path = curated_dir / "raw_manifest.pinned.csv"
    shutil.copyfile(manifest_path, pinned_path)
    typer.echo(f"wrote {pinned_path}")

    curated = adjust.load_curated(curated_dir)
    aliases = curated["aliases.csv"]
    membership = curated["nifty50_membership.csv"]
    actions_manual = curated["actions_manual.csv"]

    daily = pd.read_parquet(data_dir / "daily.parquet")
    daily["company_id"] = adjust.resolve_daily_companies(daily, aliases)
    isin_to_company, symbol_to_company_latest = adjust.build_ca_lookups(daily, aliases)
    ca_raw = adjust.load_ca_feed_local(data_dir / "raw")
    feed_result = adjust.build_feed_events(
        ca_raw, isin_to_company, symbol_to_company_latest, aliases
    )
    manual_events = adjust.build_manual_events(actions_manual)
    combined_events = adjust.combine_manual_over_feed(feed_result.events, manual_events, aliases)
    attached_events, _failures = adjust.attach_events_tolerant(combined_events, daily)

    # _write_events_baseline is adjust.py's private helper (underscore-prefixed);
    # called directly here rather than adding a new public wrapper to adjust.py,
    # since the T8 task contract permits only the one CA-snapshot edit there.
    adjust._write_events_baseline(curated_dir, attached_events, membership)  # noqa: SLF001
    typer.echo(f"wrote {curated_dir / 'events_baseline.csv.gz'} (advanced to current events)")


@stocks_app.command("validate")
def stocks_validate() -> None:
    """Re-run the dividend verifier (plan.md §4.1) against the existing
    data/stocks/ outputs -- no fetch, no guards, just validate.py's check."""
    from .stocks import adjust, validate

    data_dir = _stocks_data_dir()
    curated_dir = _stocks_curated_dir()
    raw_dir = data_dir / "raw"

    for name in ("daily.parquet", "events.parquet"):
        if not (data_dir / name).exists():
            typer.echo(f"No data/stocks/{name} yet -- run `mbt stocks fetch` first.")
            raise typer.Exit(1)

    curated = adjust.load_curated(curated_dir)
    events = pd.read_parquet(data_dir / "events.parquet")
    daily = pd.read_parquet(data_dir / "daily.parquet")
    tri = adjust.load_tri_local(raw_dir, "NIFTY50_EQUAL_WEIGHT_TRI.json")
    price = adjust.load_ew_price_local(raw_dir)
    report = validate.dividend_check(tri, price, events, curated["nifty50_membership.csv"], daily)
    report.to_csv(data_dir / "dividend_check.csv", index=False)

    n_flags = int((report["verdict"] == "flag").sum())
    typer.echo(f"dividend verifier: {n_flags} flagged day(s) of {len(report)}")
    typer.echo(f"wrote {data_dir / 'dividend_check.csv'}")


categories_app = typer.Typer(
    no_args_is_help=True,
    help="Category-momentum stock-tag data layer (categories/) -- which stocks "
    "belong to which sector/thematic category, by year.",
)
app.add_typer(categories_app, name="categories")


def _categories_data_dir() -> Path:
    return DATA_DIR / "categories"


def _categories_curated_dir() -> Path:
    # The package's own committed curated/ dir (src/momentum_backtesting/categories/curated),
    # not a data/ path -- category_extras.csv is package data, checked into git.
    return Path(__file__).parent / "categories" / "curated"


@categories_app.command("fetch")
def categories_fetch(
    from_year: int = typer.Option(
        2016, "--from-year", help="First year to resolve category membership for."
    ),
    to_year: int | None = typer.Option(
        None, "--to-year", help="Last year, inclusive (default: the current year)."
    ),
) -> None:
    """Fetch/refresh data/categories/category_membership.csv and
    fetch_report.csv for every mapped Sector/Thematic category in
    universe.csv (see categories/sources.py's CATEGORY_SLUGS). Never fails
    the run for one category's missing/thin data -- see
    categories/snapshots.py's module docstring for the three source tiers.
    """
    from datetime import date as date_cls

    from .categories import snapshots
    from .stocks.nse import NseClient

    years = list(range(from_year, (to_year or date_cls.today().year) + 1))
    data_dir = _categories_data_dir()
    client = NseClient()

    typer.echo(f"resolving {len(years)} year(s) ({years[0]}-{years[-1]}) per category...")
    summary = snapshots.run_fetch(data_dir, client, years)

    n_fetched = len(summary.categories_fetched)
    unit = "category" if n_fetched == 1 else "categories"
    n_skipped = len(summary.categories_skipped)
    skipped_list = ", ".join(summary.categories_skipped) or "none"
    typer.echo(f"\nfetched {n_fetched} {unit}, skipped {n_skipped}: {skipped_list}")
    if summary.tier_counts:
        typer.echo("source tiers (row count):")
        for tier, n in sorted(summary.tier_counts.items()):
            typer.echo(f"  {tier:<22} {n}")
    typer.echo(f"\nwrote {summary.rows_written} row(s) in {summary.elapsed_seconds:.1f}s:")
    typer.echo(f"  {data_dir / snapshots.MEMBERSHIP_FILENAME}")
    typer.echo(f"  {data_dir / snapshots.FETCH_REPORT_FILENAME}")


@categories_app.command("resolve")
def categories_resolve(
    category: str = typer.Argument(..., help='e.g. "Nifty Bank" (see universe.csv index column).'),
    year: int = typer.Argument(..., help="Resolve membership as of this year."),
    mode: str = typer.Option(
        "narrow", help='"narrow" (official snapshot only) or "broad" (+ category_extras.csv).'
    ),
) -> None:
    """Print the resolved member symbols for one category/year -- a quick
    manual check against `category_membership.csv` without writing Python."""
    from .categories.resolve import CategoryDataNotFoundError, resolve_category_members

    if mode not in ("narrow", "broad"):
        typer.echo('--mode must be "narrow" or "broad"')
        raise typer.Exit(2)
    try:
        symbols = resolve_category_members(
            category,
            year,
            mode,  # type: ignore[arg-type]
            data_dir=_categories_data_dir(),
            curated_dir=_categories_curated_dir(),
        )
    except CategoryDataNotFoundError as error:
        typer.echo(str(error))
        raise typer.Exit(1) from None

    if not symbols:
        typer.echo(f"0 symbols for {category!r} in {year} ({mode}) -- check fetch_report.csv")
        return
    typer.echo(f"{len(symbols)} symbol(s) for {category!r} in {year} ({mode}):")
    for symbol in sorted(symbols):
        typer.echo(f"  {symbol}")


@categories_app.command("backtest")
def categories_backtest(
    category: str = typer.Argument(..., help='e.g. "Nifty PSU Bank" (see universe.csv index).'),
    start: str = _START,
    end: str | None = typer.Option(None, help="Last week (default: latest outer price data)."),
    mode: str = typer.Option(
        "narrow", help='"narrow" (official snapshot only) or "broad" (+ category_extras.csv).'
    ),
    top_n: int = typer.Option(2, help="Individual stocks held per in-favour category."),
    exit_rank: int = typer.Option(8, help="Inner rotation threshold (sell once rank passes this)."),
) -> None:
    """Run the category-momentum composition end to end: resolve `category`'s
    member stocks, run the inner top-K stock rotation (categories/compose.py),
    splice its equity curve in as `category`'s price in the outer engine, and
    run the existing, unmodified outer backtest over universe.csv. Prints a
    quick CAGR comparison plus any detected corporate-action-like splits
    (categories/prices.py) -- a full report needs `report.write_result`,
    not wired up here.
    """
    from . import metrics
    from .categories.compose import run_inner_category_backtest, splice_category_into_outer_prices
    from .categories.resolve import CategoryDataNotFoundError
    from .engine import run_backtest

    prices, includes = _load_inputs()
    if category not in prices.columns:
        typer.echo(f"{category!r} is not a column of weekly_closes.csv -- check universe.csv")
        raise typer.Exit(2)

    try:
        inner = run_inner_category_backtest(
            category,
            mode=mode,  # type: ignore[arg-type]
            top_n=top_n,
            exit_rank=exit_rank,
            start=start,
            end=end,
            outer_prices=prices,
            data_dir=_categories_data_dir(),
            curated_dir=_categories_curated_dir(),
            stocks_data_dir=DATA_DIR / "stocks",
        )
    except (CategoryDataNotFoundError, ValueError, FileNotFoundError) as error:
        typer.echo(str(error))
        raise typer.Exit(1) from None

    typer.echo(
        f"inner universe ({len(inner.universe_symbols)} symbols): "
        + ", ".join(inner.universe_symbols)
    )
    if inner.events.empty:
        typer.echo("no corporate-action-like events detected")
    else:
        typer.echo(f"{len(inner.events)} corporate-action-like event(s) detected:")
        typer.echo(inner.events.to_string(index=False))
    no_event_stale = {
        col: week
        for col, week in inner.stale_columns.items()
        if col not in set(inner.events["symbol"]) | set(inner.events["new_column"])
    }
    if no_event_stale:
        typer.echo(
            f"{len(no_event_stale)} column(s) went stale with no detected event (e.g. a "
            "plain symbol rename -- see prices.py's module docstring):"
        )
        for col, week in sorted(no_event_stale.items()):
            typer.echo(f"  {col}: last real data {week.date()}")
    typer.echo(f"\ninner CAGR: {metrics.cagr(inner.result.equity):+.2%}")

    spliced = splice_category_into_outer_prices(prices, category, inner.result.equity)
    outer_config = _config(
        defensive="off",
        lookbacks="1,4,13,26,52",
        weights="",
        top_n=5,
        exit_rank=10,
        cost_pct=0.10,
        filter_lookback=13,
        start=start,
        include_optional=False,
        signal_delay=0,
        portfolio="buffer",
        entry="wait",
        max_position=0.35,
        track="index",
        execution="fri_close",
        end=end,
    )
    outer_result = run_backtest(spliced, includes, outer_config)
    typer.echo(
        f"outer CAGR (with {category!r} replaced by the inner rotation): "
        f"{metrics.cagr(outer_result.equity):+.2%}"
    )


@categories_app.command("fetch-universe")
def categories_fetch_universe(
    from_year: int = typer.Option(2016, "--from-year", help="First year to resolve for."),
    to_year: int | None = typer.Option(None, "--to-year", help="Last year (default: this year)."),
) -> None:
    """Fetch/refresh data/categories/total_market_membership.csv -- point-in-time membership of
    NSE's own Nifty Total Market index (Nifty 500 + Microcap 250, ~755 names), the "Broad
    Momentum" feature's base universe (TODO.md 3.9.13 Step 1). Same three-tier Wayback
    resolution as `categories fetch`, generalised to this one (label, slug) pair.
    """
    from datetime import date as date_cls

    from .categories import broad
    from .stocks.nse import NseClient

    years = list(range(from_year, (to_year or date_cls.today().year) + 1))
    data_dir = _categories_data_dir()
    client = NseClient()

    typer.echo(f"resolving {len(years)} year(s) ({years[0]}-{years[-1]}) for Total Market...")
    summary = broad.run_fetch_total_market(data_dir, client, years)

    typer.echo(f"\nwrote {summary.rows_written} row(s) in {summary.elapsed_seconds:.1f}s:")
    if summary.tier_counts:
        typer.echo("source tiers (report-row count):")
        for tier, n in sorted(summary.tier_counts.items()):
            typer.echo(f"  {tier:<22} {n}")
    typer.echo(f"  {data_dir / broad.TOTAL_MARKET_MEMBERSHIP_FILENAME}")
    typer.echo(f"  {data_dir / broad.TOTAL_MARKET_FETCH_REPORT_FILENAME}")


@categories_app.command("broad-backtest")
def categories_broad_backtest(
    mode: str = typer.Option(
        "on", "--mode", help='Category mode: "on" (funnel) | "off" (direct top-N).'
    ),
    start: str = _START,
    end: str | None = typer.Option(None, help="Last week (default: latest data)."),
    pool_top_n: int = typer.Option(200, help="Qualifying pool size."),
    pool_exit_rank: int = typer.Option(250, help="Pool exit buffer."),
    coverage_floor: float = typer.Option(0.40, help="Min qualifying-member share for a category."),
    category_top_n: int = typer.Option(4, help="Categories/atomics freshly held (ON mode)."),
    category_exit_rank: int = typer.Option(8, help="Category exit buffer (ON mode)."),
    picks_per_category: int = typer.Option(2, help="Top-K stocks per held category (ON mode)."),
    off_top_n: int = typer.Option(10, help='Individual stocks held (OFF mode, "SL").'),
    off_exit_rank: int = typer.Option(20, help="Individual-stock exit buffer (OFF mode)."),
    rebalance: str = typer.Option("weekly", help="Trading cadence: weekly | monthly."),
    rebalance_every: int = typer.Option(1, help="Weekly cadence only: trade every K weeks."),
    rebalance_offset: int = typer.Option(0, help="Calendar phase 0..K-1 for --rebalance-every."),
    sell_every_week: bool = typer.Option(
        False, help="Sell a dropped-rank holding every week; buys still wait for the cadence."
    ),
    stock_tilt: float = typer.Option(
        0.0, help="Re-rank the current selection by the short/long beaten-down blend (0 = off)."
    ),
    stock_tilt_screen_pct: float = typer.Option(
        0.0, help="stock_tilt only: keep just the top share by short-term momentum (0 = off)."
    ),
    cost_pct: float = _COST,
) -> None:
    """Run the full Broad Momentum backtest end to end (TODO.md 3.9.13 Steps 2-4) and print a
    quick CAGR/max-drawdown/turnover summary -- the fast manual-verification path used while
    building/sweeping this feature, ahead of the dashboard's "Broad Momentum" tab.
    """
    from . import metrics
    from .categories import broad

    if mode not in ("on", "off"):
        typer.echo('--mode must be "on" or "off"')
        raise typer.Exit(2)

    prices, _includes = _load_inputs()
    try:
        outcome = broad.run_broad_backtest(
            outer_prices=prices,
            stocks_data_dir=DATA_DIR / "stocks",
            categories_data_dir=_categories_data_dir(),
            curated_dir=_categories_curated_dir(),
            category_mode=mode,  # type: ignore[arg-type]
            start=start,
            end=end,
            pool_top_n=pool_top_n,
            pool_exit_rank=pool_exit_rank,
            coverage_floor=coverage_floor,
            category_top_n=category_top_n,
            category_exit_rank=category_exit_rank,
            picks_per_category=picks_per_category,
            off_top_n=off_top_n,
            off_exit_rank=off_exit_rank,
            rebalance=rebalance,  # type: ignore[arg-type]
            rebalance_every=rebalance_every,
            rebalance_offset=rebalance_offset,
            sell_every_week=sell_every_week,
            stock_tilt=stock_tilt,
            stock_tilt_screen_pct=stock_tilt_screen_pct,
            cost_pct=cost_pct,
        )
    except (broad.TotalMarketDataNotFoundError, ValueError) as error:
        typer.echo(str(error))
        raise typer.Exit(1) from None

    result = outcome.result
    typer.echo(f"mode: {mode}")
    typer.echo(f"CAGR: {metrics.cagr(result.equity):+.2%}")
    typer.echo(f"max drawdown: {metrics.max_drawdown(result.equity)[0]:+.2%}")
    typer.echo(f"benchmark CAGR: {metrics.cagr(result.benchmark):+.2%}")
    typer.echo(f"trades: {len(result.trades)}")
    if outcome.held_by_week:
        last_week = max(outcome.held_by_week)
        typer.echo(f"held as of {last_week.date()}: {outcome.held_by_week[last_week]}")


@categories_app.command("broad-sweep-caps")
def categories_broad_sweep_caps(
    mode: str = typer.Option("on", "--mode", help='Category mode: "on" | "off".'),
    positions: str = typer.Option("0.10,0.15,0.20,0.25,0.35", help="Per-stock caps (fractions)."),
    categories: str = typer.Option("0.20,0.30,0.40,0", help="Per-category caps; 0 = none."),
    bands: str = typer.Option("0.05", help="Trim bands: trim once this far over a cap."),
    windows: str = typer.Option(
        "2017-01-01:2021-12-31,2019-01-01:2023-12-31,2021-01-01:", help="start:end windows."
    ),
    max_stock_price: float = typer.Option(20_000.0, help="Buy-price ceiling; 0 = off."),
    cost_pct: float = _COST,
) -> None:
    """Sweep the concentration caps and trim band across several time windows, so a cap is judged
    by whether it helps in EVERY window rather than in one lucky one. The universe ranking is
    computed once and reused. Prints one row per (window, caps) with CAGR / Sharpe / max drawdown
    and the average idle-cash share (caps that are too tight hold cash back by design)."""
    from itertools import product

    import pandas as pd

    from . import sweep
    from .categories import broad

    if mode not in ("on", "off"):
        typer.echo('--mode must be "on" or "off"')
        raise typer.Exit(2)

    def floats(text: str) -> list[float]:
        return [float(x) for x in text.split(",") if x.strip()]

    spans = [tuple((part.split(":") + [""])[:2]) for part in windows.split(",") if part.strip()]
    prices, _includes = _load_inputs()
    common = dict(
        outer_prices=prices,
        stocks_data_dir=DATA_DIR / "stocks",
        categories_data_dir=_categories_data_dir(),
    )
    try:
        ranking = broad.compute_universe_ranking(**common)
        rows = []
        for (start, end), pos, cat, band in product(
            spans, floats(positions), floats(categories) if mode == "on" else [0.0], floats(bands)
        ):
            outcome = broad.run_broad_backtest(
                **common,
                curated_dir=_categories_curated_dir(),
                ranking=ranking,
                category_mode=mode,  # type: ignore[arg-type]
                start=start,
                end=end or None,
                max_position=pos or None,
                max_category=(cat or None) if mode == "on" else None,
                cap_band=band,
                max_stock_price=max_stock_price or None,
                cost_pct=cost_pct,
            )
            stats = sweep.quick_stats(outcome.result)
            idle = outcome.result.weights.get("Idle cash", pd.Series(dtype=float)).fillna(0).mean()
            rows.append(
                {
                    "window": f"{start[:4]}-{(end or 'now')[:4]}",
                    "stock cap": f"{pos:.0%}" if pos else "none",
                    "cat cap": f"{cat:.0%}" if cat else "none",
                    "band": f"{band:.0%}",
                    "CAGR": f"{stats['CAGR']:+.1%}",
                    "Sharpe": f"{stats['Sharpe']:.2f}",
                    "max DD": f"{stats['max drawdown']:+.1%}",
                    "idle cash": f"{idle:.0%}",
                }
            )
    except (broad.TotalMarketDataNotFoundError, ValueError) as error:
        typer.echo(str(error))
        raise typer.Exit(1) from None
    typer.echo(pd.DataFrame(rows).to_string(index=False))


@app.command()
def rebalance(
    config: Path = typer.Option(
        ...,
        exists=True,
        file_okay=True,
        dir_okay=False,
        help="Backtest configuration JSON (Stock or Broad Momentum).",
    ),
    holdings: Path = typer.Option(
        ...,
        exists=True,
        file_okay=True,
        dir_okay=False,
        help="JSON object of asset identifiers to current percentage weights.",
    ),
    portfolio_value: float = typer.Option(
        ..., min=0.01, help="Current total portfolio value in INR."
    ),
    json_output: bool = typer.Option(False, "--json", help="Print the complete JSON response."),
) -> None:
    """Fetch Fyers LTPs and preview the buys/sells needed to reach the model target."""
    import json

    from fastapi import HTTPException

    from .api import RebalanceRequest, rebalance_preview

    try:
        settings = json.loads(config.read_text())
        actual = json.loads(holdings.read_text())
        if not isinstance(settings, dict) or not isinstance(actual, dict):
            raise ValueError("Config and holdings files must each contain a JSON object.")
        request = RebalanceRequest(
            **settings,
            holdings_pct=actual,
            portfolio_value=portfolio_value,
        )
        plan = rebalance_preview(request)
    except (ValueError, HTTPException) as error:
        typer.echo(str(error.detail) if isinstance(error, HTTPException) else str(error), err=True)
        raise typer.Exit(1) from None

    if json_output:
        typer.echo(json.dumps(plan, indent=2))
        return
    typer.echo(f"{plan['dataset']} rebalance preview at {plan['as_of']}")
    typer.echo(f"Portfolio: ₹{portfolio_value:,.2f}; signal week {plan['signal_week']}")
    if not plan["rows"]:
        typer.echo("No weight changes are indicated.")
    for row in plan["rows"]:
        quantity = (
            f"~{row['indicative_quantity']} shares @ ₹{row['ltp']:,.2f}"
            if row["indicative_quantity"] is not None
            else "cash allocation"
        )
        typer.echo(
            f"{row['action']:4} {row['asset']:25} "
            f"{row['current_pct']:6.2f}% → {row['target_pct']:6.2f}% "
            f"({row['delta_pct']:+6.2f} pp), {quantity}"
        )
    typer.echo(plan["note"])


@app.command()
def weekly(
    run: str = typer.Option(..., help="preview (~14:40 IST, live prices) | final (after close)"),
    use_db: bool = typer.Option(
        True, "--db/--no-db", help="Pull history from and save to the shared local database."
    ),
    send: bool = typer.Option(True, help="Send to Telegram (prints when TELEGRAM_* is unset)."),
) -> None:
    """The Friday signal: refresh prices, rank, and send the week's trades to Telegram.
    Since 2026-09-30 this reads/writes the shared local database (TRADING_DATA_ROOT) instead
    of Neon (`MOMENTUM_DATABASE_URL`, retired — see TODO.md 3.11.5); a fresh laptop with no
    `data/` yet gets it rebuilt from the database's `momentum_prices`, same as before."""
    from contextlib import nullcontext

    from trading_data.db import connect

    from . import api as api_module
    from . import local_store, notify, runs_store
    from .weekly import run_favorite_strategies, week_ending_on_or_before

    if run not in ("preview", "final"):
        typer.echo("--run must be preview or final")
        raise typer.Exit(2)
    try:
        creds = fyers.resolve_credentials()
    except fyers.FyersCredentialsError as error:
        typer.echo(f"Fyers: not used ({error})")
        creds = None
    try:
        with connect() if use_db else nullcontext() as conn:
            if use_db and not (DATA_DIR / "weekly_closes.csv").exists():
                typer.echo(f"pulled {local_store.pull_dir(conn, DATA_DIR)} rows from the database")
            if not (DATA_DIR / "weekly_closes.csv").exists():
                typer.echo("No history: run `mbt fetch` first.")
                raise typer.Exit(1)
            favorites_by_id = (
                {item["id"]: item for item in runs_store.list_favorites(conn)}
                if conn is not None
                else {}
            )
            outcomes = run_favorite_strategies(
                run, DATA_DIR, creds=creds, conn=conn, log=typer.echo
            )
        if run == "final":
            target = pd.Timestamp(week_ending_on_or_before(date.today()))
            for outcome in outcomes:
                if outcome["result"] is not None or outcome["dataset"] == "etf":
                    continue
                try:
                    outcome["result"], outcome["blocked"] = api_module._research_weekly_result(
                        favorites_by_id[outcome["id"]], target
                    )
                except Exception as error:
                    outcome["blocked"] = str(getattr(error, "detail", error))
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
    active = next((outcome for outcome in outcomes if outcome["active"]), None)
    for outcome in outcomes:
        if outcome["result"] is not None:
            typer.echo(f"\n[{outcome['name']}]\n{notify.render(outcome['result'].notification)}")
        else:
            typer.echo(f"\n[{outcome['name']}] blocked: {outcome['blocked']}")
    if active is None or active["result"] is None:
        typer.echo("No eligible active favourite; Telegram was not sent.")
        return
    active["result"].notification.run_url = notify.run_url()
    if send:
        notify.send(active["result"].notification)


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
def serve(
    port: int = typer.Option(8765, help="Port on 127.0.0.1."),
) -> None:
    """Serve the private API for the shared dashboard."""
    import uvicorn

    typer.echo(f"Momentum API at http://127.0.0.1:{port}/api/docs  (Ctrl-C to stop)")
    uvicorn.run("momentum_backtesting.api:app", host="127.0.0.1", port=port, log_level="warning")


if __name__ == "__main__":
    app()
