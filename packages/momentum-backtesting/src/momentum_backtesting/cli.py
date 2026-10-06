import json
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
    # Reopen after the Parquet write: lake views are fixed when connect() opens.
    from . import stock_actions

    with connect(root) as con:
        action_report = stock_actions.scan_and_store(con, DATA_DIR / "stocks" / "raw")
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
    typer.echo(
        f"large-drop review: {action_report['candidates']} candidates, "
        f"{action_report['confirmed']} exchange-confirmed, "
        f"{action_report['review']} need review"
    )


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


#: raw TRI snapshot filename -> niftyindices.com index name (matches the names
#: adjust.load_tri_local / build_benchmarks_weekly already read).
_BENCHMARK_TRI_FILES = {
    "NIFTY_50_TRI.json": "NIFTY 50",
    "NIFTY200_MOMENTUM_30_TRI.json": "NIFTY200 MOMENTUM 30",
    "NIFTY50_EQUAL_WEIGHT_TRI.json": "NIFTY50 EQUAL WEIGHT",
}


def _extra_benchmark_tri_files() -> dict[str, str]:
    """Comparison-only TRIs (BL-010 Phase 5), filename -> niftyindices name: same snapshot
    shape as the three above, kept apart because they are optional - a failure fetching one
    never stops a stock-data refresh. Imported lazily, like every heavy module here."""
    from .stocks.benchmarks import EXTRA_TRI_INDICES

    return {filename: name for name, filename in EXTRA_TRI_INDICES.values()}


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
    """Refresh raw/benchmarks/*.json (TRI x7) + NIFTY50_EQUAL_WEIGHT_PRICE.csv.

    The TRI snapshots are written as raw JSON rows (adjust.load_tri_local's
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
    for filename, index_name in _extra_benchmark_tri_files().items():
        try:
            rows = _fetch_niftyindices_tri_raw(index_name, start, end)
        except Exception as error:  # noqa: BLE001 (optional series: warn, keep the old snapshot)
            typer.echo(f"  warning: {index_name} not refreshed ({error}); keeping the old snapshot")
            continue
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
        typer.echo("refreshing benchmark raw files (TRI x7 + EW price)...")
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


@stocks_app.command("fetch-benchmarks")
def stocks_fetch_benchmarks(
    from_: str = typer.Option("2011-01-01", "--from", help="Start date (YYYY-MM-DD)."),
    skip_download: bool = typer.Option(
        False, "--skip-download", help="No network -- rebuild from the raw snapshots on disk."
    ),
    skip_catalog: bool = typer.Option(
        False, "--skip-catalog", help="Write the raw snapshots and the CSV only."
    ),
) -> None:
    """Fetch ONLY the comparison-only TRIs (Nifty Midcap 150, Smallcap 250, Midcap150 Momentum
    50, Nifty500 Momentum 50) and add them to data/stocks/benchmarks_weekly.csv and the shared
    catalog's stock_weekly_series. Touches no other column, series or table, so it is safe
    without the full `mbt stocks fetch` rebuild (which needs NSE bhavcopies)."""
    from datetime import date as date_cls

    from .stocks import adjust
    from .stocks.nse import atomic_write_bytes
    from .stocks.ui_data import REFERENCE_ONLY_COLUMNS

    start = date_cls.fromisoformat(from_)
    data_dir = _stocks_data_dir()
    bench_dir = data_dir / "raw" / "benchmarks"

    if not skip_download:
        bench_dir.mkdir(parents=True, exist_ok=True)
        for filename, index_name in _extra_benchmark_tri_files().items():
            rows = _fetch_niftyindices_tri_raw(index_name, start, date_cls.today())
            atomic_write_bytes(bench_dir / filename, json.dumps(rows).encode("utf-8"))
            typer.echo(f"  {index_name}: {len(rows)} daily rows")

    try:
        extra = adjust.merge_extra_benchmarks_csv(data_dir)
    except FileNotFoundError as error:
        typer.echo(f"{error} -- run `mbt stocks fetch` first.")
        raise typer.Exit(1) from None
    if extra.empty:
        typer.echo("No raw snapshots for the comparison TRIs -- run without --skip-download.")
        raise typer.Exit(1)
    for column, name in REFERENCE_ONLY_COLUMNS.items():
        if column in extra:
            series = extra[column].dropna()
            typer.echo(
                f"  {name}: {len(series)} weeks, {series.index[0]:%Y-%m-%d} .. "
                f"{series.index[-1]:%Y-%m-%d}"
            )
    typer.echo(f"wrote {data_dir / 'benchmarks_weekly.csv'}")

    if skip_catalog:
        return
    from trading_data.db import connect, data_root

    from . import db_migrate

    with connect(data_root()) as con:
        n_rows = db_migrate.import_extra_benchmarks(con, extra)
    typer.echo(f"catalog stock_weekly_series: {n_rows:,} rows written ({data_root()})")


@stocks_app.command("sync")
def stocks_sync(
    fallback_to_fyers: bool = typer.Option(
        True,
        "--fallback-to-fyers/--no-fallback-to-fyers",
        help="If the NSE fetch fails (e.g. Akamai bot-detection blocking it — see nse.py), "
        "fill just the missing week with a Fyers plain-price stopgap instead of leaving "
        "the data stale for another week.",
    ),
) -> None:
    """Incremental weekly refresh for Stock/Custom Index/Broad Momentum: `stocks fetch`
    (bhavcopy.download already skips already-cached sessions, so this is fast on a normal
    week) followed by `local migrate` (B4/A6). `stocks fetch` alone is NOT enough — once the
    shared database has been migrated once, `stock_dataset_from_db_or_none`/
    `daily_prices_from_db_or_none` keep serving that catalog's rows indefinitely, so a fetch
    that only touches data/stocks/*.csv never reaches a reader that prefers the database. Used
    by the Friday ~19:30 IST stock-ingest job (scripts/install-launchd.sh); safe to run by hand.
    """
    # Typer only resolves a command's `typer.Option(...)` defaults when invoked through its
    # CLI runner; calling the function directly (as here) gets the raw OptionInfo sentinel
    # instead of "2011-01-01" unless every parameter is passed explicitly.
    from .stocks.nse import NseError

    try:
        stocks_fetch(from_="2011-01-01", skip_download=False, accept_ca_diff=None)
        local_migrate()
        return
    except NseError as error:
        # Specifically NSE connectivity/bot-detection failures — never a bare `Exception`
        # here, so a real data-quality guard failure (dividend check, CA diff guard, a
        # malformed bhavcopy) still fails loudly as `typer.Exit` instead of being silently
        # papered over by an unrelated-looking Fyers stopgap.
        if not fallback_to_fyers:
            raise
        typer.echo(f"NSE fetch failed ({error}); trying Fyers fallback…")

    from .stocks.fyers_topup import run_fyers_topup, run_fyers_topup_total_market

    try:
        creds = fyers.resolve_credentials()
    except fyers.FyersCredentialsError as cred_error:
        typer.echo(f"Fyers fallback unavailable: {cred_error}")
        raise typer.Exit(1) from cred_error

    result = run_fyers_topup(creds)
    if result is None:
        typer.echo("Fyers fallback (Nifty 50): data was already current, nothing to do.")
    else:
        typer.echo(
            f"Fyers fallback (Nifty 50): filled week {result.week:%Y-%m-%d} for "
            f"{result.companies_updated} companies "
            f"(plain price, not total-return — a stopgap until the next real NSE sync)."
        )
        if result.companies_skipped:
            typer.echo(f"  skipped (no symbol or no fetchable price): {result.companies_skipped}")

    typer.echo("Fyers fallback (Total Market): this can take several minutes…")
    market_result = run_fyers_topup_total_market(creds, _categories_data_dir())
    if market_result is None:
        typer.echo("Fyers fallback (Total Market): data was already current, nothing to do.")
        return
    typer.echo(
        f"Fyers fallback (Total Market): filled through {market_result.through:%Y-%m-%d} for "
        f"{market_result.symbols_updated} symbols ({market_result.rows_written} rows), "
        f"tagged synthetic_close — a stopgap until the next real NSE sync."
    )
    if market_result.symbols_skipped:
        typer.echo(f"  skipped (no fetchable price): {len(market_result.symbols_skipped)} symbols")


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

search_app = typer.Typer(
    no_args_is_help=True,
    help="Broad Momentum parameter search: resumable parallel sweeps over a TOML space file.",
)
app.add_typer(search_app, name="search")


@search_app.command("run")
def search_run(
    space: Path = typer.Argument(..., help="Search-space TOML (see search_spaces/)."),
    out: Path = typer.Option(None, "--out", help="Results folder (default data/search/<name>)."),
    heavy: int = typer.Option(20, help="Distinct ranking combinations (the expensive ones)."),
    light: int = typer.Option(50, help="Runs per ranking combination."),
    seed: int = typer.Option(1, help="Sampling seed; same seed + space = same runs."),
    workers: int = typer.Option(2, help="Worker processes (~1 GB each, ~1.5 GB for all-liquid)."),
    limit_groups: int = typer.Option(None, help="Only the first N groups (smoke tests)."),
) -> None:
    """Run (or resume) a search. Re-running the same command skips runs already saved."""
    from . import search as sr

    spec = sr.load_space(space)
    out = out or DATA_DIR / "search" / spec.name
    sr.run_search(
        space,
        out,
        heavy_count=heavy,
        light_count=light,
        seed=seed,
        workers=workers,
        limit_groups=limit_groups,
        echo=typer.echo,
    )
    typer.echo(f"results in {out}")


@search_app.command("bias")
def search_bias(
    out: Path = typer.Argument(..., help="A results folder from `mbt search run`."),
    space: Path = typer.Option(..., "--space", help="The search-space TOML the folder came from."),
    seeds: int = typer.Option(5, help="Random-ranking placebo seeds per config."),
) -> None:
    """Try to break the best configs: random-ranking placebo, much stricter liquidity, removing the
    biggest winners, and shifted/cut date windows. Writes <out>/bias.json and prints a summary."""
    from . import bias

    report = bias.run_checks(out, space, seeds=seeds, echo=typer.echo)
    typer.echo("\n" + bias.render(report))
    typer.echo(f"saved {out / 'bias.json'}")


@search_app.command("robust")
def search_robust(
    out: Path = typer.Argument(..., help="A finished search's results folder (e.g. round2_A)."),
    space: Path = typer.Option(..., "--space", help="That search's space TOML (must be sealed)."),
    top: int = typer.Option(45, help="How many candidates to nudge."),
    workers: int = typer.Option(4, help="Worker processes (~1 GB each)."),
    dest: Path = typer.Option(None, "--dest", help="Where to write (default <out>/round3)."),
    ids_file: Path = typer.Option(
        None, "--ids-file", help="JSON list of run ids to nudge instead."
    ),
) -> None:
    """Round 3: nudge the best candidates (neighbouring parameters, other rebalance days, later
    starts) inside the tuning window and see whether their results hold. Resumable."""
    import json as _json

    from . import robust

    ids = _json.loads(ids_file.read_text()) if ids_file else None
    robust.run_round3(
        out, space, dest or out / "round3", top=top, workers=workers, ids=ids, echo=typer.echo
    )


@search_app.command("robust-report")
def search_robust_report(
    dest: Path = typer.Argument(..., help="The round3 folder written by `mbt search robust`."),
    show: int = typer.Option(15, help="Candidates to print."),
    dd_floor: float = typer.Option(-0.30, help="Depth a nudged version may not exceed."),
    uw_cap: float = typer.Option(None, help="Max weeks below a previous high (80% of nudges)."),
) -> None:
    """One verdict per candidate: how far its result strays when nudged, and who survives."""
    from . import robust

    frame = robust.load_robust(dest)
    if frame.empty:
        typer.echo("no results yet")
        raise typer.Exit(1)
    table = robust.verdicts(frame, dd_floor=dd_floor, uw_cap=uw_cap)
    typer.echo(
        f"{table.cid.nunique()} candidates; {int(table.survives.sum())} survive "
        f"({frame.error.notna().sum()} errored nudges of {len(frame)})"
    )
    typer.echo(table.head(show).round(3).to_string(index=False))


@search_app.command("final")
def search_final(
    out: Path = typer.Argument(..., help="The tuning search's results folder (e.g. round2_A)."),
    space: Path = typer.Option(..., "--space", help="That search's space TOML."),
    finalists: Path = typer.Option(..., "--finalists", help="JSON {label: run id} chosen BEFORE."),
    open_sealed: bool = typer.Option(False, "--open-sealed", help="Confirm: opens 2023+ for good."),
    workers: int = typer.Option(4, help="Worker processes (~1.5 GB each, strict-liquidity pass)."),
) -> None:
    """Round 4: the one-time out-of-sample test (2023+) of the finalists, with tax, a random-rank
    placebo and a stricter liquidity gate. One-way door: see final.py's docstring."""
    from . import final

    final.run_final(
        out, space, finalists, open_sealed=open_sealed, workers=workers, echo=typer.echo
    )


@search_app.command("final-report")
def search_final_report(
    out: Path = typer.Argument(..., help="The tuning search's results folder."),
    trials: int = typer.Option(20866, help="Total configs tried across all rounds (for the DSR)."),
) -> None:
    """Apply the pre-registered criteria to the Round 4 results."""
    import numpy as np

    from . import final
    from . import search as sr

    rows = final.load_final(out / "round4")
    if not rows:
        typer.echo("no Round 4 results yet")
        raise typer.Exit(1)
    results = sr.load_results(out)
    weekly_sr = (results["sharpe"].dropna() / np.sqrt(52)).to_numpy()
    table = final.evaluate(rows, weekly_sr, trials)
    typer.echo(table.round(3).T.to_string())
    passed = int(table.passes.sum())
    typer.echo(
        f"\n{passed} of {len(table)} finalists pass all four pre-registered criteria -> "
        f"{final.reading(passed, len(table))}"
    )


@search_app.command("rescore")
def search_rescore(
    out: Path = typer.Argument(..., help="A finished search's results folder (e.g. round2_A)."),
    space: Path = typer.Option(..., "--space", help="Space TOML for the FULL period (round5_A)."),
    min_cagr: float = typer.Option(0.20, help="Re-run candidates with at least this CAGR."),
    workers: int = typer.Option(4, help="Worker processes (~1 GB each)."),
    dest: Path = typer.Option(None, "--dest", help="Default <out>/round5."),
) -> None:
    """Re-run the best candidates over the full period and keep the weekly equity curve, so time
    under water and new-high behaviour can be judged. Resumable."""
    from . import rescore

    rescore.run_rescore(
        out, space, dest or out / "round5", min_cagr=min_cagr, workers=workers, echo=typer.echo
    )


@search_app.command("steady-select")
def search_steady_select(
    out: Path = typer.Argument(..., help="The tuning search's results folder (round2_A)."),
    top: int = typer.Option(40, help="Candidates to send to the nudge test."),
    track: str = typer.Option("strict", help="strict (pre-registered) or relaxed (post-hoc)."),
) -> None:
    """Apply the steady-highs selection rules (round5_criteria.json) to the full-period re-score."""
    import json as _json

    from . import rescore, steady

    df = rescore.load_rescored(out / "round5")
    if df.empty:
        typer.echo("no re-scored runs yet")
        raise typer.Exit(1)
    chosen, cap, counts = steady.select_candidates(df, top, relaxed=(track == "relaxed"))
    typer.echo(
        f"[{track}] {len(df)} re-scored; passing every filter at each cap: {counts}; "
        f"using U = {cap} weeks"
    )
    (out / "round5" / track).mkdir(parents=True, exist_ok=True)
    (out / "round5" / track / "candidates.json").write_text(
        _json.dumps({"cap_weeks": cap, "ids": list(chosen["id"])}, indent=1)
    )
    show = [
        "id",
        "cagr",
        "mdd",
        "turnover_x",
        steady.UW,
        "uw_recovery_weeks",
        "w1_cagr",
        "w1_newhigh",
        "w2_cagr",
        "w2_newhigh",
    ]
    typer.echo(chosen[show].head(15).round(3).to_string(index=False))


@search_app.command("steady-finalists")
def search_steady_finalists(
    out: Path = typer.Argument(..., help="The tuning search's results folder (round2_A)."),
    top: int = typer.Option(10, help="Finalists to keep."),
    track: str = typer.Option("strict", help="strict (pre-registered) or relaxed (post-hoc)."),
) -> None:
    """Top survivors of the duration-aware nudge test, by full-period CAGR -> finalists file."""
    import json as _json

    from . import rescore, robust

    meta = _json.loads((out / "round5" / track / "candidates.json").read_text())
    cap = meta["cap_weeks"]
    table = robust.verdicts(
        robust.load_robust(out / "round5" / track / "nudge"), dd_floor=-0.38, uw_cap=1.5 * cap
    )
    scored = rescore.load_rescored(out / "round5").set_index("id")
    table["cagr"] = table["cid"].map(scored["cagr"])
    alive = table[table.survives].sort_values("cagr", ascending=False).head(top)
    typer.echo(
        f"{int(table.survives.sum())} of {len(table)} survive the nudge test (U = {cap}, "
        f"nudges allowed {1.5 * cap:.0f} weeks)"
    )
    (out / "round5" / track / "finalists.json").write_text(
        _json.dumps({f"finalist_{i + 1}": cid for i, cid in enumerate(alive["cid"])}, indent=1)
    )
    typer.echo(
        alive[
            [
                "cid",
                "cagr",
                "base_mdd",
                "base_uw_weeks",
                "nudge_p25",
                "nudge_worst",
                "nudge_share_uw_ok",
            ]
        ]
        .round(3)
        .to_string(index=False)
    )


@search_app.command("steady-validate")
def search_steady_validate(
    out: Path = typer.Argument(..., help="The tuning search's results folder (round2_A)."),
    space: Path = typer.Option(..., "--space", help="search_spaces/round5_A.toml"),
    workers: int = typer.Option(3, help="Worker processes."),
    track: str = typer.Option("strict", help="strict (pre-registered) or relaxed (post-hoc)."),
) -> None:
    """Placebo, tax and stricter-liquidity checks for the finalists, over the full period."""
    import json as _json

    from . import steady

    finalists = _json.loads((out / "round5" / track / "finalists.json").read_text())
    steady.run_validation(
        out,
        space,
        finalists,
        out / "round5" / track / "validate",
        workers=workers,
        echo=typer.echo,
    )


@search_app.command("steady-report")
def search_steady_report(
    out: Path = typer.Argument(..., help="The tuning search's results folder (round2_A)."),
    trials: int = typer.Option(22000, help="Total configs tried across all rounds (DSR)."),
    track: str = typer.Option("strict", help="strict (pre-registered) or relaxed (post-hoc)."),
) -> None:
    """Winner / Finalist verdict for the steady-highs finalists."""
    import numpy as np

    from . import rescore, steady
    from . import search as sr

    rows = steady.load_validation(out / "round5" / track / "validate")
    if not rows:
        typer.echo("no validation results yet")
        raise typer.Exit(1)
    results = sr.load_results(out)
    weekly_sr = (results["sharpe"].dropna() / np.sqrt(52)).to_numpy()
    table = steady.evaluate(rows, rescore.load_rescored(out / "round5"), weekly_sr, trials)
    typer.echo(table.round(3).T.to_string())
    typer.echo(f"\n{int(table.winner.sum())} of {len(table)} are Winners")


@search_app.command("pit-rerun")
def search_pit_rerun(
    out: Path = typer.Argument(..., help="A finished search's results folder (arm A)."),
    space: Path = typer.Option(..., "--space", help="That search's space TOML."),
    top: int = typer.Option(50, help="How many of the best stored runs to re-run."),
    also: Path = typer.Option(None, "--also", help='More runs: JSON {"label": "run id"}.'),
    dest: Path = typer.Option(None, "--dest", help="Output file (default <out>/pit_rerun.jsonl)."),
) -> None:
    """Re-run the best configs unchanged on a point-in-time universe (each year's 750
    most-traded stocks) and print what the result loses. Resumable."""
    import json as _json

    from . import pit_rerun

    extra = _json.loads(also.read_text()) if also else {}
    dest = dest or out / "pit_rerun.jsonl"
    pit_rerun.run(space, out, pit_rerun.pick(out, top, extra), dest, echo=typer.echo)
    rows = pit_rerun.table(dest)
    for label in sorted(rows.get("as_searched", {})):
        cells = [
            f"{variant} {rows[variant][label]['cagr']:.1%}"
            for variant in pit_rerun.VARIANTS
            if label in rows.get(variant, {})
        ]
        typer.echo(f"{label}: " + ", ".join(cells))


@search_app.command("category-shuffle")
def search_category_shuffle(
    out: Path = typer.Argument(..., help="A finished search's results folder (arm A)."),
    space: Path = typer.Option(..., "--space", help="That search's space TOML."),
    picks: Path = typer.Option(..., "--picks", help='Runs to test: JSON {"label": "run id"}.'),
    shuffles: int = typer.Option(100, help="How many random dealings of stocks to categories."),
    dest: Path = typer.Option(
        None, "--dest", help="Output (default <out>/category_shuffle.jsonl)."
    ),
) -> None:
    """Each config with the stocks dealt out to the categories at random, against the same
    config on the real tags. Tells whether the categories themselves add anything. Resumable."""
    import json as _json

    from . import category_shuffle

    dest = dest or out / "category_shuffle.jsonl"
    category_shuffle.run(
        space, out, _json.loads(picks.read_text()), dest, shuffles=shuffles, echo=typer.echo
    )
    for label, row in category_shuffle.summary(dest).items():
        typer.echo(
            f"{label}: real {row['real']:.1%}; shuffled median {row['shuffled_median']:.1%}, "
            f"95th percentile {row['shuffled_p95']:.1%}, best {row['shuffled_max']:.1%}; "
            f"{row['beaten_by']} of {row['shuffles']} shuffles match or beat it"
        )


@search_app.command("score")
def search_score(
    out: Path = typer.Argument(..., help="A finished search's results folder."),
    space: Path = typer.Option(..., "--space", help="That search's space TOML."),
    dest: Path = typer.Option(None, "--dest", help="Output folder (default <out>/scored)."),
    workers: int = typer.Option(4, help="Worker processes (~1 GB each)."),
    universe: str = typer.Option(None, help="Score on another universe, e.g. turnover_rank."),
    tags: str = typer.Option(None, help="Category tags to use: curated or extended."),
    limit: int = typer.Option(None, help="Only the first N configs of each ranking (a trial run)."),
    max_rankings: int = typer.Option(None, help="Score at most this many rankings, then stop."),
) -> None:
    """Re-score every config of a finished search on all its rebalance phases and keep the
    weekly curves (BL-010 Phase 4), then report the probability of backtest overfitting.
    Resumable: a ranking already scored is skipped."""
    from . import method, reference_benchmarks

    dest = dest or out / "scored"
    runner = {}
    if universe:
        runner["universe_kind"] = universe
    if tags:
        runner["category_tags"] = tags
    method.score_search(
        space,
        out,
        dest,
        workers=workers,
        runner=runner,
        limit=limit,
        max_rankings=max_rankings,
        echo=typer.echo,
    )
    scores, curves = method.load_scores(dest)
    refs = reference_benchmarks.load_references()
    excess = method.excess_log_returns(curves, refs["Nifty200 Momentum 30 TRI"])
    result = method.pbo(excess.to_numpy())
    typer.echo(
        f"{len(scores)} configs scored; median CAGR {scores['cagr'].median():.1%}, "
        f"best {scores['cagr'].max():.1%}"
    )
    typer.echo(
        f"PBO {result['pbo']:.2f} over {result['splits']} splits of {result['configs']} configs "
        f"(kill above {method.PBO_KILL}); the in-sample best is below the benchmark out of "
        f"sample in {result['picked_oos_negative']:.0%} of splits; slope {result['slope']:.2f}"
    )


@search_app.command("choose")
def search_choose(
    out: Path = typer.Argument(..., help="A finished search's results folder."),
    scored: Path = typer.Option(None, "--scored", help="Scored curves (default <out>/scored_pit)."),
    dest: Path = typer.Option(None, "--dest", help="Report folder (default <out>/phase5)."),
) -> None:
    """BL-010 Phase 5: robustness over financial years, the walk-forward of the choice rule,
    the factor check and the choice per drawdown basket, as committed in criteria addendum 3.
    Reads stored curves only; writes report.json and report.md."""
    from . import bias, choose, db_read, method, phase5, reference_benchmarks

    scored = scored or out / "scored_pit"
    dest = dest or out / "phase5"
    scores, curves = method.load_scores(scored)
    facts = choose.config_facts(bias.load_records(out, set(curves.columns)))
    refs = reference_benchmarks.load_references()
    closes = db_read.weekly_closes_from_db_or_none()
    if closes is None:
        closes = pd.read_csv(DATA_DIR / "weekly_closes.csv", index_col=0, parse_dates=True)
    series = {
        name: refs[name] for name in (phase5.MOM30, phase5.NIFTY50, phase5.MIDCAP, phase5.SMALLCAP)
    }
    series[phase5.CASH] = closes["Cash (liquid fund)"]
    phase5.run(curves, scores, facts, series, dest, echo=typer.echo)


@search_app.command("ensemble")
def search_ensemble(
    out: Path = typer.Argument(..., help="A finished search's results folder."),
    scored: Path = typer.Option(None, "--scored", help="Scored curves (default <out>/scored_pit)."),
    dest: Path = typer.Option(None, "--dest", help="Report folder (default <out>/phase6)."),
) -> None:
    """BL-010 Phase 6 step 0: the ensemble criteria addendum 4 picks, after its own
    walk-forward. Reads stored curves only; writes ensemble.json and ensemble.md."""
    from . import bias, choose, method, phase5, phase6, reference_benchmarks

    scored = scored or out / "scored_pit"
    dest = dest or out / "phase6"
    _, curves = method.load_scores(scored)
    records = bias.load_records(out, set(curves.columns))
    facts = choose.config_facts(records)
    refs = reference_benchmarks.load_references()
    series = {name: refs[name] for name in (phase5.MOM30, phase5.MIDCAP, phase5.SMALLCAP)}
    phase6.run(curves, facts, records, series, dest, echo=typer.echo)


@search_app.command("fair-placebo")
def search_fair_placebo(
    out: Path = typer.Argument(..., help="A finished search's results folder."),
    space: Path = typer.Option(..., "--space", help="That search's space TOML."),
    picks: Path = typer.Option(..., "--picks", help='Runs to test: JSON {"label": "run id"}.'),
    seeds: int = typer.Option(100, help="Random rankings per config."),
    dest: Path = typer.Option(None, "--dest", help="Output (default <out>/fair_placebo.jsonl)."),
) -> None:
    """Each config against random rankings that change only every 13 weeks, so the baseline
    trades about as often as the real thing (BL-010 Phase 4). The config's own stock tilt is
    switched off in both, since it would re-order random picks by real momentum. Resumable."""
    import json as _json

    from . import method

    dest = dest or out / "fair_placebo.jsonl"
    method.fair_placebo(
        space, out, _json.loads(picks.read_text()), dest, seeds=seeds, echo=typer.echo
    )
    for label, row in method.placebo_summary(dest).items():
        typer.echo(
            f"{label}: real {row['real']:.1%} (turnover {row['real_turnover']:.1f}x); random "
            f"median {row['placebo_median']:.1%}, 95th percentile {row['placebo_p95']:.1%} "
            f"(turnover {row['placebo_turnover_median']:.1f}x); margin "
            f"{row['margin_over_p95'] * 100:+.1f} pts, {'passes' if row['passes'] else 'fails'}"
        )


@search_app.command("analyze")
def search_analyze(
    out: Path = typer.Argument(..., help="A results folder from `mbt search run`."),
    top: int = typer.Option(10, help="Rows per profile."),
    max_turnover: float = typer.Option(
        None, help="Reject runs above this one-way turnover (x/yr)."
    ),
) -> None:
    """Best runs per drawdown profile (aggressive / balanced <=1.5x / defensive <=1.0x the
    benchmark's own max drawdown), plus which searched parameters correlate with CAGR."""
    from . import search as sr

    df = sr.load_results(out)
    if df.empty:
        typer.echo("no results yet")
        raise typer.Exit(1)
    errors = df["error"].notna().sum()
    typer.echo(
        f"{len(df)} runs ({errors} errors); benchmark max drawdown "
        f"{df['bench_mdd'].dropna().iloc[0]:.1%}, CAGR {df['bench_cagr'].dropna().iloc[0]:.1%}"
    )
    if errors:
        typer.echo(df["error"].dropna().value_counts().head(3).to_string())
    show = ["cagr", "mdd", "calmar", "turnover_x", "buys_per_yr", "roll3y_worst", "roll3y_beat"]
    for name, table in sr.profile_tables(df, top=top, max_turnover=max_turnover).items():
        typer.echo(f"\n== {name}: {len(table)} shown ==")
        params = [c for c in table.columns if c.startswith(("p_", "h_"))]
        keep = [c for c in params if table[c].nunique() > 1 or len(table) == 1]
        typer.echo(table[show + keep].round(3).to_string(index=False))
    typer.echo("\n== |rank correlation| with CAGR ==")
    typer.echo(sr.importance(df).head(12).round(2).to_string())


def _categories_data_dir() -> Path:
    return DATA_DIR / "categories"


def _categories_curated_dir() -> Path:
    # The package's own committed curated/ dir (src/momentum_backtesting/categories/curated),
    # not a data/ path -- category_extras.csv is package data, checked into git.
    return Path(__file__).parent / "categories" / "curated"


journal_app = typer.Typer(
    no_args_is_help=True,
    help="The forward-signal journal (BL-024): every weekly signal as recorded, unchangeable.",
)
app.add_typer(journal_app, name="journal")


@journal_app.command("show")
def journal_show(
    week: str = typer.Option(None, help="Only this signal week (YYYY-MM-DD)."),
) -> None:
    """List journal entries, oldest first."""
    from trading_data.db import connect

    from . import forward_journal

    with connect() as con:
        rows = forward_journal.entries(con, week)
    if not rows:
        typer.echo("The journal is empty." if week is None else f"No entries for {week}.")
        return
    for row in rows:
        weights = json.loads(row["holdings_before"])
        top = ", ".join(
            f"{name} {weight:.0%}"
            for name, weight in sorted(weights.items(), key=lambda kv: -kv[1])
        )
        correction = f" (corrects #{row['supersedes']})" if row["supersedes"] else ""
        typer.echo(
            f"#{row['entry_id']} {row['week']} {row['run_kind']:<7} {row['config_name']}"
            f"{correction}\n    recorded {row['recorded_at']} · {row['code_commit'][:12]}"
            f" · held before: {top or 'nothing'}"
        )


@journal_app.command("check")
def journal_check(
    week: str = typer.Option(
        None, help="Signal week (YYYY-MM-DD); default the latest Friday on or before today."
    ),
    send: bool = typer.Option(False, help="Also send the summary to Telegram."),
) -> None:
    """After Friday's runs: did every favourite (and the benchmark) get recorded for the week,
    under the right week, and is the chain intact? Exits 1 when anything is missing or broken.
    Scheduled for Fridays 20:15 IST by the momentum-weekly-journal-check LaunchAgent."""
    from datetime import datetime

    from trading_data.db import connect

    from . import forward_journal, notify, runs_store
    from .stocks.ui_data import NIFTY200_MOMENTUM30_TRI
    from .weekly import week_ending_on_or_before

    target = week or week_ending_on_or_before(datetime.now(notify.IST).date())
    try:
        with connect() as con:
            result = forward_journal.check(
                con, target, runs_store.list_favorites(con), (NIFTY200_MOMENTUM30_TRI,)
            )
    except Exception as error:
        # e.g. the catalog still locked by a long 19:30 run: say so, never fail silently.
        message = notify.redact(f"{type(error).__name__}: {error}")
        typer.echo(f"journal check FAILED: {message}")
        if send:
            notify.send(
                notify.Notification(
                    "momentum-journal",
                    "error",
                    "Forward journal check could not run",
                    f"{message}\nRerun it: mbt journal check --send",
                )
            )
        raise typer.Exit(1) from error
    title, body = forward_journal.summary(result)
    typer.echo(f"{title}\n{body}")
    if send:
        notify.send(
            notify.Notification(
                "momentum-journal", "info" if result["ok"] else "warning", title, body
            )
        )
    if not result["ok"]:
        raise typer.Exit(1)


@journal_app.command("verify")
def journal_verify() -> None:
    """Check that no entry was changed, removed or reordered since it was recorded."""
    from trading_data.db import connect

    from . import forward_journal

    with connect() as con:
        problems = forward_journal.verify(con)
        chain = forward_journal.head(con)
    if problems:
        for problem in problems:
            typer.echo(f"FAIL {problem}")
        raise typer.Exit(1)
    if chain is None:
        typer.echo("OK: the journal is empty.")
    else:
        typer.echo(
            f"OK: {chain[0]} entries, chain intact; head {chain[1][:16]} "
            "(compare with the latest Telegram 'Forward journal' line)."
        )


audit_app = typer.Typer(
    no_args_is_help=True,
    help="Check a backtest against raw exchange data (BL-010): bundle a run's orders and "
    "claims, replay them independently, and study the replayed run.",
)
app.add_typer(audit_app, name="audit")


def _audit_runs(bundles: list[Path]) -> dict:
    """label__variant -> (bundle, market data, reconciling replay)."""
    import json as _json

    from .audit import replay as rp

    runs = {}
    for path in bundles:
        bundle = _json.loads(path.read_text())
        market = rp.market_for(bundle)
        runs[f"{bundle['label']}__{bundle['variant']}"] = (
            bundle,
            market,
            rp.replay(bundle, market),
        )
    return runs


@audit_app.command("bundle")
def audit_bundle(
    space: Path = typer.Argument(..., help="The search-space TOML the runs came from."),
    results: Path = typer.Argument(..., help="That search's results folder."),
    picks: Path = typer.Option(..., "--picks", help='JSON file: {"label": "run id", ...}.'),
    out: Path = typer.Option(None, "--out", help="Where to write (default data/audit/bundles)."),
    variant: str = typer.Option("as_searched", help="A name for this set of settings."),
    tax: bool = typer.Option(False, "--tax", help="Tax each sale (tax.TaxRules defaults)."),
    capital: float = typer.Option(None, help="Starting capital in rupees, not the space's."),
    signal_delay: int = typer.Option(None, help="Weeks from signal to trade, not the space's."),
    end: str = typer.Option(None, help="Last week of the run (YYYY-MM-DD), not the latest."),
) -> None:
    """Re-run stored search configs on the current code and write one audit bundle each: the
    run's orders, and what the backtest claims came of them."""
    import json as _json

    from .audit import bundle as bundle_mod
    from .tax import TaxRules

    override = {}
    if capital is not None:
        override["capital"] = capital
    if signal_delay is not None:
        override["signal_delay"] = signal_delay
    if end is not None:
        override["end"] = end
    bundle_mod.bundle_search_runs(
        space,
        results,
        _json.loads(picks.read_text()),
        out or DATA_DIR / "audit" / "bundles",
        variant=variant,
        tax=TaxRules() if tax else None,
        echo=typer.echo,
        **override,
    )


@audit_app.command("lookahead")
def audit_lookahead(
    space: Path = typer.Argument(..., help="The search-space TOML the runs came from."),
    results: Path = typer.Argument(..., help="That search's results folder."),
    picks: Path = typer.Option(..., "--picks", help='JSON file: {"label": "run id", ...}.'),
    cut: list[str] = typer.Option(..., help="A cut date, YYYY-MM-DD (repeat for several)."),
    out: Path = typer.Option(None, "--out", help="Where to write (default data/audit/lookahead)."),
) -> None:
    """Each run stopped at a cut date, twice: on the full database, and on a copy that holds
    nothing after that date. The orders and the equity curve must be the same. Exits 1 if any
    differ. Needs disk space for one copy of the database per cut date (removed afterwards)."""
    import json as _json
    import os
    import shutil
    import subprocess
    import sys
    import tempfile

    from trading_data.db import data_root

    from .audit import truncate

    out = out or DATA_DIR / "audit" / "lookahead"
    base = [sys.executable, "-m", "momentum_backtesting.cli", "audit", "bundle"]
    base += [str(space), str(results), "--picks", str(picks)]
    failures = 0
    for day in cut:
        whole_dir, cut_dir = out / f"whole_{day}", out / f"truncated_{day}"
        subprocess.run(
            [*base, "--end", day, "--variant", f"to_{day}", "--out", str(whole_dir)], check=True
        )
        with tempfile.TemporaryDirectory(prefix="mbt-cut-") as tmp:
            truncate.truncated_root(data_root(), Path(tmp), date.fromisoformat(day))
            env = {**os.environ, "TRADING_DATA_ROOT": tmp}
            subprocess.run(
                [*base, "--end", day, "--variant", f"to_{day}", "--out", str(cut_dir)],
                check=True,
                env=env,
            )
            shutil.rmtree(tmp, ignore_errors=True)
        for path in sorted(whole_dir.glob("*.json")):
            found = truncate.same_result(
                _json.loads(path.read_text()), _json.loads((cut_dir / path.name).read_text())
            )
            failures += bool(found)
            typer.echo(f"{day} {path.stem}: {'same' if not found else '; '.join(found)}")
    if failures:
        raise typer.Exit(1)


@audit_app.command("replay")
def audit_replay(
    bundles: list[Path] = typer.Argument(..., help="Bundle files from `mbt audit bundle`."),
    out: Path = typer.Option(None, "--out", help="Also save each report as JSON here."),
) -> None:
    """Rebuild each bundle's result from its orders and the raw daily bars, and compare it with
    what the backtest claimed. Exits 1 if any check fails."""
    import json as _json

    from .audit import replay as rp

    reports = [rp.run(path) for path in bundles]
    typer.echo("\n\n".join(rp.render(report) for report in reports))
    if out is not None:
        out.mkdir(parents=True, exist_ok=True)
        for report in reports:
            name = f"{report['label']}__{report['variant']}.json"
            (out / name).write_text(_json.dumps(report, indent=1, default=str))
    if not all(report["passed"] for report in reports):
        raise typer.Exit(1)


@audit_app.command("study")
def audit_study(
    bundles: list[Path] = typer.Argument(..., help="Bundle files from `mbt audit bundle`."),
    what: str = typer.Option(
        "all", help="contribution | jumps | realism | monday-open | all (comma-separated)."
    ),
    out: Path = typer.Option(None, "--out", help="Save each result as JSON here."),
    actions: Path = typer.Option(
        None, "--actions", help="Cached NSE corporate-action filings (ca_<year>.json files)."
    ),
) -> None:
    """Questions about a replayed run, answered from raw data: where the profit came from,
    which held days could be data artefacts, whether a real account could have placed the
    orders, and what filling at the next open instead of the close costs."""
    import json as _json

    from .audit import studies as st

    names = list(st.STUDIES) if what == "all" else [name.strip() for name in what.split(",")]
    unknown = sorted(set(names) - set(st.STUDIES))
    if unknown:
        raise typer.BadParameter(f"unknown study {unknown}; choose from {sorted(st.STUDIES)}")
    feed = None
    if "jumps" in names:
        feed = st.load_action_feed(actions or DATA_DIR / "stocks" / "raw" / "corporate_actions")
    for key, (bundle, market, mine) in _audit_runs(bundles).items():
        for name in names:
            result = st.STUDIES[name](bundle, market, mine, feed)
            typer.echo(f"{key} {name}: {st.headline(name, result)}")
            if out is not None:
                out.mkdir(parents=True, exist_ok=True)
                (out / f"{key}__{name}.json").write_text(_json.dumps(result, indent=1, default=str))


@audit_app.command("outside")
def audit_outside(
    bundles: list[Path] = typer.Argument(..., help="Bundle files (one variant of each run)."),
    primary: str = typer.Option(..., help="The run whose five largest contributors are checked."),
    also: list[str] = typer.Option(
        [], help="Another holding to check, as run:instrument:YYYY-MM-DD:why."
    ),
    day: list[str] = typer.Option([], help="A single day's move to check, as SYMBOL:YYYY-MM-DD."),
    out: Path = typer.Option(..., "--out", help="Folder for the worksheet (JSON and Markdown)."),
    actions: Path = typer.Option(None, "--actions", help="Cached NSE corporate-action filings."),
) -> None:
    """Check ten holdings, picked by rule before any outside price is fetched, against Yahoo
    Finance's daily history. Needs the network."""
    import json as _json

    from .audit import outside as ou
    from .audit import studies as st

    runs = {key.split("__")[0]: run for key, run in _audit_runs(bundles).items()}
    feed = st.load_action_feed(actions or DATA_DIR / "stocks" / "raw" / "corporate_actions")
    extra = []
    for item in also:
        run, name, when, why = item.split(":", 3)
        extra.append((run, name, date.fromisoformat(when), why))
    picked = ou.pick_sample(runs, feed, primary, extra)
    days = [(d.split(":")[0], date.fromisoformat(d.split(":")[1])) for d in day]
    checked = ou.check_sample(picked, runs, days)
    out.mkdir(parents=True, exist_ok=True)
    (out / "outside_check.json").write_text(_json.dumps(checked, indent=1, default=str))
    (out / "outside_check.md").write_text(ou.worksheet(checked) + "\n")
    typer.echo(ou.worksheet(checked))
    passed = sum(h["check"]["passed"] for h in checked["holdings"])
    typer.echo(f"\n{passed} of {len(checked['holdings'])} holdings pass")


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
            # Same as the API's default (`broad_every_week`): simulate the thin weeks too, or
            # this command silently skips them and disagrees with the dashboard.
            min_ranked=1,
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
    """Preview model buys/sells using live prices or the latest persisted close."""
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
    typer.echo(
        f"{plan['dataset']} rebalance preview at {plan['as_of']} using {plan['price_source']}"
    )
    typer.echo(f"Portfolio: ₹{portfolio_value:,.2f}; signal week {plan['signal_week']}")
    if not plan["rows"]:
        typer.echo("No weight changes are indicated.")
    for row in plan["rows"]:
        quantity = (
            f"~{row['indicative_quantity']} shares @ ₹{row['ltp']:,.2f}"
            if row["indicative_quantity"] is not None
            else "cash allocation"
            if row["asset"] in ("Idle cash", "Cash (liquid fund)")
            else "share quantity unavailable"
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
    only_dataset: list[str] = typer.Option(
        [],
        "--only-dataset",
        help="Only send to Telegram if the active favourite's dataset is one of these "
        "(repeatable). Used by the Friday stock-ingest job so its rerun doesn't resend an "
        "ETF favourite's signal; omit for the normal scheduled/manual run.",
    ),
) -> None:
    """The Friday signal: refresh prices, rank, and send the week's trades to Telegram.
    Since 2026-09-30 this reads/writes the shared local database (TRADING_DATA_ROOT) instead
    of Neon (`MOMENTUM_DATABASE_URL`, retired — see TODO.md 3.11.5); a fresh laptop with no
    `data/` yet gets it rebuilt from the database's `momentum_prices`, same as before.

    This is a thin wrapper around `api._execute_weekly_run` — the same orchestration the
    dashboard's manual trigger and the scheduled jobs all share, so the CLI, the API, and
    launchd can never drift against each other (they used to duplicate this loop)."""
    from trading_data.db import connect

    from . import api as api_module
    from . import local_store, notify

    if run not in ("preview", "final"):
        typer.echo("--run must be preview or final")
        raise typer.Exit(2)
    if not use_db:
        typer.echo(
            "note: --no-db no longer skips the shared database — favourites and signal "
            "history always live there now. Ignoring --no-db."
        )
    with connect() as conn:
        if not (DATA_DIR / "weekly_closes.csv").exists():
            typer.echo(f"pulled {local_store.pull_dir(conn, DATA_DIR)} rows from the database")
    if not (DATA_DIR / "weekly_closes.csv").exists():
        typer.echo("No history: run `mbt fetch` first.")
        raise typer.Exit(1)
    try:
        result = api_module._execute_weekly_run(
            api_module.WeeklyRunBody(
                run=run, send=send, only_if_active_dataset=only_dataset or None
            )
        )
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
    for strategy in result["strategies"]:
        if strategy["body"] is not None:
            typer.echo(f"\n[{strategy['name']}]\n{strategy['title']}\n{strategy['body']}")
        else:
            typer.echo(f"\n[{strategy['name']}] blocked: {strategy['blocked']}")
    if not result["sent_to_telegram"]:
        typer.echo(f"\n{result['title']}: {result['body']}")
    elif not any(s["active"] and s["body"] is not None for s in result["strategies"]):
        typer.echo(f"\nSent warning to Telegram: {result['title']}")
    journal = result["journal"]
    if journal["error"]:
        typer.echo(f"\nforward journal FAILED: {journal['error']}")
    else:
        recorded = ", ".join(journal["recorded"]) or "nothing new"
        typer.echo(f"\nforward journal: {recorded}")
        for note in journal["notes"]:
            typer.echo(f"  note: {note}")


@app.command()
def sources_check() -> None:
    """Can this machine reach every data source? (Run once from GitHub Actions before
    enabling the weekly schedule - some sites block datacenter IPs.)"""
    from datetime import timedelta

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
