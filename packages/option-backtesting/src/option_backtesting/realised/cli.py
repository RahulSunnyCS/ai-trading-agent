"""`obt realised …` (BL-168 Phase 4): the contract-notes store read as the owner's sheet.

summary | days | months | trips | day D: read-only, `--json` for the page's exact answer;
capital: the 15:50 reading (scheduler `contract-notes-capital`), the one command that writes."""

from __future__ import annotations

import json
from datetime import date, datetime
from zoneinfo import ZoneInfo

import typer

realised_app = typer.Typer(
    no_args_is_help=True, help="Realised results from the brokers' contract notes (BL-168)."
)
IST = ZoneInfo("Asia/Kolkata")


def _root():
    from ..fyers.auth import load_dotenv
    from ..fyers.daily import data_dir

    load_dotenv()
    return data_dir()


def _d(text: str | None) -> date | None:
    return date.fromisoformat(text) if text else None


def _inr(value) -> str:
    return "—" if value is None else f"₹{value:,.0f}"


FROM = typer.Option(None, "--from", help="First day, YYYY-MM-DD.")
TO = typer.Option(None, "--to", help="Last day, YYYY-MM-DD.")
ACCOUNT = typer.Option(None, "--account", help="One account, broker/id (algo fees left out).")
JSON = typer.Option(False, "--json", help="The JSON the page reads.")


@realised_app.command()
def summary(start: str = FROM, end: str = TO, account: str = ACCOUNT, as_json: bool = JSON) -> None:
    """Net, charges, drawdown, win days and the sheet's ratios (T, U, V, W, Z) at the last day."""
    from . import views

    out = views.summary(_root(), start=_d(start), end=_d(end), account=account)
    if as_json:
        typer.echo(json.dumps(out, default=str))
        return
    s, r = out["summary"], out["ratios"] or {}
    typer.echo(
        f"{s['first_day']} → {s['last_day']}: {s['sessions']} sessions, "
        f"{s['traded_sessions']} traded"
    )
    typer.echo(
        f"net {_inr(s['net'])} · charges {_inr(s['charges'])} (algo fees {_inr(s['algo_fees'])}) · "
        f"max drawdown {_inr(s['max_drawdown'])} · win days {s['win_pct']}%"
    )
    typer.echo(
        f"50-day avg {_inr(r.get('avg_profit_50'))} · "
        f"100-day avg {_inr(r.get('avg_profit_100'))} · "
        f"100-day charge {_inr(r.get('avg_charges_100'))} · "
        f"charge/profit {r.get('charge_profit_pct')}% · "
        f"profit/capital {r.get('profit_capital_bps')} bps"
    )
    for fy in out["fiscal_years"]:
        typer.echo(
            f"FY {fy['fy']}: {_inr(fy['profit'])} ({fy['pct']}% of capital), "
            f"{fy['sessions']} sessions"
        )
    for p in out["problems"]:
        typer.echo(f"  ! {p}")


@realised_app.command()
def days(start: str = FROM, end: str = TO, account: str = ACCOUNT, as_json: bool = JSON) -> None:
    """One row per session: net, charges, algo fees, cumulative, drawdown and the rolling ratios."""
    from . import views

    out = views.days(_root(), start=_d(start), end=_d(end), account=account)
    if as_json:
        typer.echo(json.dumps(out, default=str))
        return
    for r in out["days"]:
        typer.echo(
            f"{r['day']}  profit {_inr(r['profit']):>10}  charges {_inr(r['charges']):>8}  "
            f"to date {_inr(r['cumulative']):>10}  drawdown {_inr(r['drawdown']):>9}"
        )


@realised_app.command()
def months(start: str = FROM, end: str = TO, account: str = ACCOUNT, as_json: bool = JSON) -> None:
    """The sheet's monthly tab."""
    from . import views

    out = views.months(_root(), start=_d(start), end=_d(end), account=account)
    if as_json:
        typer.echo(json.dumps(out, default=str))
        return
    for m in out["months"]:
        typer.echo(f"{m['month']}  {_inr(m['profit']):>10}  {m['pct']}%  3m {m['avg3_pct']}")


@realised_app.command()
def trips(
    start: str = FROM,
    end: str = TO,
    account: str = ACCOUNT,
    extremes: bool = typer.Option(
        False, "--extremes", help="Add MAE / MFE from the lake (slower)."
    ),
    as_json: bool = JSON,
) -> None:
    """Round trips with their source; turnover by financial year."""
    from . import views

    out = views.trip_rows(_root(), start=_d(start), end=_d(end), account=account, extremes=extremes)
    if as_json:
        typer.echo(json.dumps(out, default=str))
        return
    for src, s in sorted(out["by_source"].items()):
        typer.echo(f"{src:14} {s['trips']:5} trips  net {_inr(s['net'])}  won {s['won']}")
    for fy, t in out["turnover"].items():
        typer.echo(f"FY {fy}: turnover {_inr(t['turnover'])}, {t['trips']} trips")
    typer.echo(f"notes by trades check: {out['coverage']}")


@realised_app.command()
def day(day_: str = typer.Argument(..., metavar="DAY"), as_json: bool = JSON) -> None:
    """One session: each account's line, the trips, the ledger, the inputs and the day's context."""
    from . import views

    out = views.day_detail(_root(), date.fromisoformat(day_))
    typer.echo(json.dumps(out, default=str, indent=None if as_json else 2))


@realised_app.command()
def capital(
    day_: str = typer.Option(None, "--day", help="YYYY-MM-DD; default today (IST)."),
) -> None:
    """After the close: Angel One's free margin, as the day's closing funds and the next
    session's capital (one guarded SmartAPI login). Finvasia is not read (see
    realised/capital.py). Exit 0 recorded, 1 not."""
    from .capital import read_angelone_capital, record_capital

    d = _d(day_) or datetime.now(IST).date()
    try:
        amount = read_angelone_capital()
        nxt = record_capital(_root(), d, "angelone", amount, "SmartAPI getRMS net at the close")
    except Exception as error:  # noqa: BLE001 - every failure is one line and exit 1
        typer.echo(f"Angel One capital not recorded: {str(error)[:200]}")
        raise typer.Exit(1) from None
    typer.echo(f"{d}: Angel One closing funds recorded, and {nxt}'s capital")
