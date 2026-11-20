"""`obt nse ...` — NSE's public end-of-day F&O files (BL-226 Phase 1)."""

from __future__ import annotations

import json
from datetime import date, datetime

import typer

nse_app = typer.Typer(no_args_is_help=True, help="NSE's daily F&O bhavcopy and ban list (BL-226).")


@nse_app.command("fo-fetch")
def fo_fetch(
    from_: str = typer.Option("2019-01-01", "--from", help="First session (YYYY-MM-DD)."),
    to: str = typer.Option("", "--to", help="Last session (default today)."),
    weekends: bool = typer.Option(False, "--weekends", help="Also try Saturdays and Sundays."),
    bans: bool = typer.Option(True, "--bans/--no-bans", help="Also fetch each day's ban list."),
    interval: float = typer.Option(1.0, "--interval", help="Seconds between requests."),
) -> None:
    """Fetch the daily F&O bhavcopy (and ban list) into raw/nse/ and lake/eod/fo_bhavcopy/;
    resumable: settled days are skipped. Exit 2 when a request failed other than with a 404."""
    from ..fyers.daily import data_dir
    from .fo_bhavcopy import Http, fetch

    end = date.fromisoformat(to) if to else datetime.now().date()
    result = fetch(
        data_dir(),
        date.fromisoformat(from_),
        end,
        http=Http(min_interval_s=interval),
        weekends=weekends,
        bans=bans,
        log=typer.echo,
    )
    typer.echo(json.dumps(result, indent=2))
    if result["stopped"]:
        raise typer.Exit(2)


@nse_app.command("fno-build")
def fno_build() -> None:
    """Rebuild the F&O stock list, spells, lot sizes and ban days from the stored files."""
    from ..fyers.daily import data_dir
    from .fno_universe import build

    typer.echo(json.dumps(build(data_dir()), indent=2))


@nse_app.command("fno-report")
def fno_report(
    full: bool = typer.Option(False, "--full", help="List every entry and exit."),
) -> None:
    """Stocks on the list per month, entries and exits, lot checks and ban days."""
    from ..fyers.daily import data_dir
    from .fno_universe import report

    r = report(data_dir())
    if not full:
        r["entries"] = f"{len(r['entries'])} (--full lists them)"
        r["exits"] = f"{len(r['exits'])} (--full lists them)"
    typer.echo(json.dumps(r, indent=2, default=str))
