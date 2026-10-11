"""`obt rotation …`: update | pick | verify | show | readout | base (BL-058); triggers,
triggers-show (BL-083); corr, corr-list, corr-pick (BL-090)."""

from __future__ import annotations

from datetime import date, datetime
from zoneinfo import ZoneInfo

import typer

rotation_app = typer.Typer(
    no_args_is_help=True, help="The options rotation's forward paper journal (BL-058)."
)
IST = ZoneInfo("Asia/Kolkata")


def _day(text: str | None) -> date:
    return date.fromisoformat(text) if text else datetime.now(IST).date()


@rotation_app.command()
def update(
    day: str = typer.Option(None, "--day", help="YYYY-MM-DD; default: today (IST)."),
) -> None:
    """Run all 298 variants over one collected day and store the results (idempotent)."""
    from .update import default_day, update_day

    d = _day(day) if day else default_day()
    if d is None:
        typer.echo("nothing to update: the latest collected day is already stored")
        return
    r = update_day(d)
    if r["skipped"]:
        typer.echo(f"nothing written: {r['skipped']}", err=True)
        raise typer.Exit(2)
    if r["errors"]:
        for e in r["errors"][:10]:
            typer.echo(f"  {e}", err=True)
        raise typer.Exit(1)
    # BL-058 amendment: the owner's fixed base (its Dir ATM 09:24 leg). Isolated like the triggers.
    try:
        from . import base as base_mod

        base_mod.score_days(base_mod.pending_days(), log=typer.echo)
    except Exception as error:  # noqa: BLE001
        typer.echo(
            f"base scoring skipped ({type(error).__name__}: {error}); the update is stored",
            err=True,
        )
    # BL-083: score the day's intraday triggers. Isolated: a failure here never fails the update.
    try:
        from .triggers import score_pending

        score_pending(d, log=typer.echo)
    except Exception as error:  # noqa: BLE001
        typer.echo(
            f"trigger scoring skipped ({type(error).__name__}: {error}); the update is stored",
            err=True,
        )


@rotation_app.command()
def pick(
    day: str = typer.Option(None, "--day", help="YYYY-MM-DD; default: today (IST)."),
    vix_open: float = typer.Option(
        None, "--vix-open", help="Override the live 09:15 VIX open (testing)."
    ),
    dry_run: bool = typer.Option(False, "--dry-run", help="Score and print; write nothing."),
    telegram: bool = typer.Option(True, "--telegram/--no-telegram"),
) -> None:
    """Record today's picks for every list (before 09:17), hash-chained, and Telegram them."""
    from ..notify import Notification, send
    from .journal import AlreadyRecorded
    from .pick import PickError, record

    d = _day(day)

    def alert(title: str, body: str) -> None:
        if telegram and not dry_run:
            send(Notification(source="options-rotation", severity="error", title=title, body=body))

    try:
        r = record(d, vix_open=vix_open, dry_run=dry_run)
    except AlreadyRecorded as error:  # a retry after a success: the day has its entry
        typer.echo(f"already recorded: {error}")
        return
    except (PickError, ValueError) as error:
        typer.echo(f"not recorded: {error}", err=True)
        alert(f"Rotation pick NOT recorded for {d}", str(error))
        raise typer.Exit(2) from error
    except Exception as error:  # noqa: BLE001 - an unexpected failure must still alert and retry
        typer.echo(f"not recorded: {type(error).__name__}: {error}", err=True)
        alert(f"Rotation pick FAILED for {d}", f"{type(error).__name__}: {str(error)[:300]}")
        raise typer.Exit(2) from error
    typer.echo(r.text)
    if telegram and not dry_run:
        severity = "info" if r.entry["before_first_entry"] else "warn"
        send(
            Notification(
                source="options-rotation",
                severity=severity,
                title=f"Rotation picks {d}",
                body=r.text,
            )
        )


@rotation_app.command()
def base(
    backfill: bool = typer.Option(
        False, "--backfill", help="Score every day the Widesl leg has and the Dir leg lacks."
    ),
    start: str = typer.Option(None, "--from", help="First day to score (with --backfill)."),
    end: str = typer.Option(None, "--to", help="Last day to score (with --backfill)."),
) -> None:
    """The fixed base reference: score its Dir ATM 09:24 leg, or show its series (BL-058)."""
    from . import base as base_mod

    if backfill:
        days = base_mod.pending_days()
        if start:
            days = [d for d in days if d >= date.fromisoformat(start)]
        if end:
            days = [d for d in days if d <= date.fromisoformat(end)]
        r = base_mod.score_days(days, log=typer.echo)
        for line in r["skipped"][:10]:
            typer.echo(f"  skipped {line}", err=True)
        return
    series = base_mod.base_per_lot()
    if not series:
        typer.echo("no base days yet: run `obt rotation base --backfill`")
        return
    vals = list(series.values())
    typer.echo(
        f"base: {len(vals)} days {min(series)} .. {max(series)}, "
        f"₹{sum(vals) / len(vals):,.0f} per lot-day, cumulative per lot ₹{sum(vals):,.0f}"
    )


@rotation_app.command()
def readout(
    start: str = typer.Option(None, "--from", help="First forward day."),
    end: str = typer.Option(None, "--to", help="Last forward day."),
    as_json: bool = typer.Option(False, "--json", help="The full read-out as JSON."),
    first: int = typer.Option(
        None, "--first", help="Only the first N scored sessions (60 = the registered read-out)."
    ),
) -> None:
    """The registered 60-day read-out: per list, against REF, the base and random baskets."""
    import json

    from . import readout as ro

    r = ro.build(
        start=date.fromisoformat(start) if start else None,
        end=date.fromisoformat(end) if end else None,
        first_n=first,
    )
    typer.echo(json.dumps(r, indent=1) if as_json else ro.render(r))


@rotation_app.command()
def verify() -> None:
    """Re-compute the hash chain; exit 1 on any problem."""
    from . import journal, store

    path = store.journal_path()
    problems = journal.verify(path)
    n = len(journal.read(path))
    if problems:
        for p in problems:
            typer.echo(f"PROBLEM: {p}", err=True)
        raise typer.Exit(1)
    typer.echo(f"journal intact: {n} entries, head {journal.head(path)[:16]}")


@rotation_app.command()
def show(last: int = typer.Option(5, "--last", help="How many recent entries.")) -> None:
    """Print the recent entries and each list's P&L where the day is scored."""
    from . import journal, store
    from .lists import LOTS_PER
    from .variants import variant_names

    entries = journal.read(store.journal_path())[-last:]
    m = store.load_matrix(variant_names()) if entries else None
    for e in entries:
        typer.echo(
            f"{e['day']} {e['weekday']} VIX {e['vix_open']} ({e['vix_band']}) "
            f"chain {e['hash'][:10]}"
        )
        day = date.fromisoformat(e["day"])
        for key, p in e["lists"].items():
            picked = p["core"] + p["buy"]
            pnl = ""
            if m is not None and day in m.days:
                row = m.values[m.days.index(day)]
                pnl = f"  P&L {LOTS_PER * sum(row[m.names.index(n)] for n in picked):>9,.0f}"
            typer.echo(f"  {key:3s} {', '.join(picked)}{pnl}")


# --- how the strategies move together (BL-090) -----------------------------------------------

_SELECTORS_HELP = (
    "Strategies: a name, a glob (N_*_0917), all, slot:0917, family:wide|dir|buy|p80, "
    "index:N|S, kind:legwise|variant; a+b is both (slot:0917+index:N). Default slot:0917."
)


def _window(start: str | None, end: str | None) -> tuple[date | None, date | None]:
    try:
        return (
            date.fromisoformat(start) if start else None,
            date.fromisoformat(end) if end else None,
        )
    except ValueError as error:
        raise typer.BadParameter(str(error)) from error


def _load(selectors: list[str], include_stale: bool):
    from .series import SelectorError, load

    try:
        return load(selectors, include_stale=include_stale)
    except SelectorError as error:
        typer.echo(str(error), err=True)
        raise typer.Exit(2) from error


@rotation_app.command("corr-list")
def corr_list(
    kind: str = typer.Option(None, "--kind", help="variant | legwise"),
) -> None:
    """Every strategy that has daily results now, with its days and date range."""
    from .series import available

    rows = [a for a in available() if kind is None or a.kind == kind]
    if not rows:
        typer.echo("no strategy has results yet", err=True)
        raise typer.Exit(2)
    width = max(len(a.name) for a in rows)
    for a in rows:
        flag = "  STALE (file changed since)" if a.stale else ""
        typer.echo(
            f"{a.name:<{width}}  {a.kind:<8} {a.n_days:>4} days  {a.first} .. {a.last}{flag}"
        )
    typer.echo(f"{len(rows)} strategies")


@rotation_app.command()
def corr(
    selectors: list[str] = typer.Argument(None, help=_SELECTORS_HELP),
    start: str = typer.Option(None, "--from", help="First day, YYYY-MM-DD."),
    end: str = typer.Option(None, "--to", help="Last day, YYYY-MM-DD."),
    window: int = typer.Option(63, "--window", min=10, help="Trading days per rolling block."),
    include_stale: bool = typer.Option(False, "--include-stale"),
    min_days: int = typer.Option(
        40, "--min-days", min=3, help="Refuse fewer common days than this."
    ),
    json_path: str = typer.Option(None, "--json", help="Write the whole report as JSON."),
    csv_path: str = typer.Option(None, "--csv", help="Write one matrix as CSV."),
    matrix: str = typer.Option(
        "pearson", "--matrix", help="pearson | spearman | loss (for --csv)."
    ),
) -> None:
    """Correlation of the strategies' daily P&L, loss-day overlap, basket drawdown, drift."""
    import csv
    import json

    from ..analytics import correlation as c

    if matrix not in c.MEASURES:
        raise typer.BadParameter(f"--matrix must be one of {', '.join(c.MEASURES)}")
    a, b = _window(start, end)
    series = _load(selectors, include_stale)
    if len(series) < 2:
        typer.echo("need at least two strategies to correlate", err=True)
        raise typer.Exit(2)
    try:
        report = c.analyse(series, start=a, end=b, window=window, min_days=min_days)
    except ValueError as error:
        typer.echo(str(error), err=True)
        raise typer.Exit(2) from error
    typer.echo(c.render_text(report))
    if json_path:
        with open(json_path, "w") as f:
            json.dump(c.to_json(report), f)
        typer.echo(f"wrote {json_path}")
    if csv_path:
        with open(csv_path, "w", newline="") as f:
            csv.writer(f).writerows(c.to_csv_rows(report, matrix))
        typer.echo(f"wrote {csv_path}")


@rotation_app.command("corr-pick")
def corr_pick(
    selectors: list[str] = typer.Argument(None, help=_SELECTORS_HELP),
    k: int = typer.Option(3, "--k", min=1, help="Strategies wanted."),
    max_corr: float = typer.Option(0.6, "--max-corr", help="Keep one only if below this."),
    measure: str = typer.Option("pearson", "--measure", help="pearson | spearman | loss"),
    require: list[str] = typer.Option([], "--require", help="A name that must be in the basket."),
    start: str = typer.Option(None, "--from"),
    end: str = typer.Option(None, "--to"),
    include_stale: bool = typer.Option(False, "--include-stale"),
    min_days: int = typer.Option(40, "--min-days", min=3),
    json_path: str = typer.Option(None, "--json"),
) -> None:
    """A basket of k strategies none of which are alike (diagnostic; changes no list)."""
    import json

    from ..analytics import correlation as c

    if measure not in c.MEASURES:
        raise typer.BadParameter(f"--measure must be one of {', '.join(c.MEASURES)}")
    a, b = _window(start, end)
    series = _load(selectors, include_stale)
    names = {s.name for s in series}
    missing = [n for n in require if n not in names]
    if missing:
        typer.echo(f"--require not among the strategies chosen: {', '.join(missing)}", err=True)
        raise typer.Exit(2)
    try:
        report = c.analyse(series, start=a, end=b, min_days=min_days)
        basket = c.pick_diverse(report, k, max_corr, measure=measure, require=require)
    except ValueError as error:
        typer.echo(str(error), err=True)
        raise typer.Exit(2) from error
    typer.echo(
        f"{report.n_days} common days, {report.days[0]} to {report.days[-1]}; "
        f"{len(series)} candidates"
    )
    typer.echo(c.render_basket(basket))
    if json_path:
        with open(json_path, "w") as f:
            json.dump(c.basket_to_json(basket), f)
        typer.echo(f"wrote {json_path}")


@rotation_app.command()
def triggers(
    day: str = typer.Option(None, "--day", help="YYYY-MM-DD; default: today (IST)."),
) -> None:
    """Score one collected day's intraday triggers (BL-083): events and placebo simulations."""
    from .triggers import score_day

    r = score_day(_day(day), log=typer.echo)
    for s in r["skipped"]:
        typer.echo(f"skipped: {s}", err=True)


@rotation_app.command("triggers-show")
def triggers_show() -> None:
    """Event minus placebo per trigger and template over every scored day (BL-083, forward only)."""
    from .triggers import summary

    rows = summary()
    if not rows:
        typer.echo("no scored trigger events yet")
        return
    typer.echo(
        f"{'trigger':8s}{'template':9s}{'events':>7s}{'days':>6s}{'event':>9s}{'placebo':>9s}{'diff':>9s}{'t':>7s}"
    )
    for r in rows:
        t = "n/a" if r["t"] is None else f"{r['t']:.1f}"
        typer.echo(
            f"{r['trigger']:8s}{r['template']:9s}{r['events']:>7d}{r['days']:>6d}"
            f"{r['event']:>9,.0f}{r['placebo']:>9,.0f}{r['diff']:>9,.0f}{t:>7s}"
        )
