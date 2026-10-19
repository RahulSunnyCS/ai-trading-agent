"""`obt rotation …`: update | pick | verify | show | readout | base (BL-058); triggers,
triggers-show (BL-083); corr, corr-list, corr-pick (BL-090); update / pick --track t1 and
track-readout (the T1 parallel track); lot-plans (BL-135); algotest-export (BL-137)."""

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
    track: str = typer.Option(
        None, "--track", help="A parallel track (t1): run only its extra variants."
    ),
    backfill: bool = typer.Option(
        False,
        "--backfill",
        help="With --track: kept for clarity; a track update always fills every missing day.",
    ),
    soft_fail: bool = typer.Option(
        False,
        "--soft-fail",
        help="With --track: on failure Telegram an alert and exit 0, so a scheduled chain is not "
        "failed and retried for it (the evening run; the 21:00 job remains the catch-up).",
    ),
) -> None:
    """Run all 298 variants over one collected day and store the results (idempotent)."""
    from .update import default_day, update_day, update_track
    from .variants import TRACK_DIRS

    if (backfill or soft_fail) and not track:
        typer.echo("--backfill and --soft-fail need --track", err=True)
        raise typer.Exit(2)
    if track:
        if track not in TRACK_DIRS:
            typer.echo(f"unknown track {track!r} (known: {', '.join(TRACK_DIRS)})", err=True)
            raise typer.Exit(2)
        # A parallel track's extra variants only: every day Core-298 has stored that the track
        # lacks (so a missed evening is filled the next time, never silently dropped), no base or
        # trigger scoring, never the live results or days.csv.
        problems: list[str] = []

        def err(message: str) -> None:
            problems.append(message)
            typer.echo(message, err=True)

        try:
            tried, failed = update_track(track, _day(day) if day else None, log=typer.echo, err=err)
        except Exception as error:  # noqa: BLE001 - reported below, like a failed day
            if not soft_fail:
                raise
            err(f"{type(error).__name__}: {error}")
            tried, failed = 1, 1
        if not tried:
            typer.echo(f"{track}: nothing to update (every Core-298 day is stored)")
            return
        if failed:
            if soft_fail:
                from ..notify import Notification, send

                send(
                    Notification(
                        source="options-rotation",
                        severity="error",
                        title=f"{track.upper()} TRACK update failed ({failed} day(s))",
                        body="\n".join(problems)[:1500]
                        + f"\nThe live results are stored. Fix, then: obt rotation update --track "
                        f"{track} (the 21:00 job retries it).",
                    )
                )
                typer.echo(f"{track}: {failed} day(s) failed; alerted, exiting 0 (--soft-fail)")
                return
            raise typer.Exit(2)
        return

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
    track: str = typer.Option(
        None, "--track", help="A parallel track (t1): its own journal, private Telegram only."
    ),
    with_t1: bool = typer.Option(
        False,
        "--with-t1",
        help="Also record the T1 track and send ONE message with both (the 09:16 job). "
        "Adaptive is never held back by T1.",
    ),
) -> None:
    """Record today's picks for every list (before 09:17), hash-chained, and Telegram them."""
    from .deliver import pick_and_send
    from .variants import TRACK_DIRS

    if track and track not in TRACK_DIRS:
        typer.echo(f"unknown track {track!r} (known: {', '.join(TRACK_DIRS)})", err=True)
        raise typer.Exit(2)
    if track and with_t1:
        typer.echo("--with-t1 and --track are different modes: use one", err=True)
        raise typer.Exit(2)
    code = pick_and_send(
        _day(day),
        vix_open=vix_open,
        dry_run=dry_run,
        telegram=telegram,
        track=track,
        with_t1=with_t1,
        echo=typer.echo,
        err=lambda message: typer.echo(message, err=True),
    )
    if code:
        raise typer.Exit(code)


@rotation_app.command("track-readout")
def track_readout(
    track: str = typer.Option("t1", "--track", help="The parallel track."),
) -> None:
    """A parallel track's Adaptive against the live Adaptive over the forward days (read-only)."""
    from .track import build, render

    typer.echo(render(build(track)))


@rotation_app.command("lot-plans")
def lot_plans_cmd(
    book: str = typer.Option("core", "--book", help="core (live Adaptive) or t1 (the T1 track)."),
    as_json: bool = typer.Option(False, "--json", help="The whole response as JSON."),
    last: int = typer.Option(10, "--last", help="Daily rows to print."),
) -> None:
    """As picked, Dir Boost and Duo for one book, forward from 2026-10-19 (BL-135, read-only)."""
    import json

    from .lot_plans import BOOKS, build, render

    if book not in BOOKS:
        raise typer.BadParameter(f"--book must be one of {', '.join(BOOKS)}")
    r = build(book)
    typer.echo(json.dumps(r, indent=2, default=str) if as_json else render(r, last))


@rotation_app.command("algotest-export")
def algotest_export(
    day: str | None = typer.Option(None, "--day", help="The session; default: today (IST)."),
    book: str = typer.Option("t1", "--book", help="t1 (the T1 track) or core (live Adaptive)."),
    preview: bool = typer.Option(
        False, "--preview", help="The expected picks for that session, not the recorded ones."
    ),
    next_session: bool = typer.Option(
        False, "--next", help="The session after --day (default today): its expected picks."
    ),
    variants: str | None = typer.Option(
        None, "--variants", help="Comma-separated variant ids instead of the day's picks."
    ),
    out: str | None = typer.Option(
        None, "--out", help="Folder; default TRADING_DATA_ROOT/rotation/algotest/<day>/<book>."
    ),
    wait: int = typer.Option(
        0, "--wait", help="Seconds to wait for the day's recorded entry (the 09:16 jobs)."
    ),
) -> None:
    """The day's Adaptive picks as AlgoTest .algtst files plus a zip (BL-137; uploads nothing)."""
    from pathlib import Path

    from ..legwise.algtst import Unmappable
    from . import algtst_export as ax
    from . import store

    if book not in ax.BOOKS:
        raise typer.BadParameter(f"--book must be one of {', '.join(ax.BOOKS)}")
    d = _day(day)
    if next_session:
        from .tomorrow import next_session as following

        d, preview = following(d), True
    if variants:
        names = [v.strip() for v in variants.split(",") if v.strip()]
        picks = ax.DayPicks(d, book, "given", names, [])
    elif preview:
        picks = ax.preview_picks(d, book)
        if picks is None:
            typer.echo(f"no expected picks for {d}: results do not reach the session before it")
            raise typer.Exit(2)
    else:
        import time

        picks = ax.recorded_picks(d, book)
        deadline = time.monotonic() + wait
        while picks is None and time.monotonic() < deadline:
            time.sleep(2)
            picks = ax.recorded_picks(d, book)
        if picks is None:
            typer.echo(f"no recorded {book} entry for {d} (09:16); --preview: the expected picks")
            raise typer.Exit(2)
    try:
        exports = ax.build(picks)
    except (Unmappable, FileNotFoundError) as error:
        typer.echo(f"not exported: {error}")
        raise typer.Exit(1) from error
    folder = Path(out) if out else store.rotation_dir() / "algotest" / d.isoformat() / book
    try:
        zip_path = ax.write(picks, exports, folder)
    except FileExistsError as error:
        typer.echo(f"not exported: {error}")
        raise typer.Exit(1) from error
    if not out:  # the uploader (BL-137) reads the newest default export through this pointer
        ax.write_latest(store.rotation_dir() / "algotest", picks, folder)
    typer.echo(ax.render(picks, exports, zip_path))


@rotation_app.command()
def result(
    day: str = typer.Option(None, "--day", help="YYYY-MM-DD; default: today (IST)."),
    telegram: bool = typer.Option(True, "--telegram/--no-telegram"),
    force: bool = typer.Option(False, "--force", help="Resend even if this result was sent."),
    tomorrow: bool = typer.Option(
        True, "--tomorrow/--no-tomorrow", help="Add tomorrow's strategies in full."
    ),
    wait_until: str = typer.Option(
        None,
        "--wait-until",
        help="HH:MM IST. While T1's results are incomplete before this time, send nothing and "
        "exit 2 (the scheduler retries); after it, send without T1 and deliver T1 later. "
        "Default: no waiting.",
    ),
    not_before: str = typer.Option(
        None,
        "--not-before",
        help="HH:MM IST. Earlier than this, send nothing and exit 0 (the scheduled result job "
        "sends). The evening run's last step, so a late retry still sends that evening.",
    ),
    soft_fail: bool = typer.Option(
        False,
        "--soft-fail",
        help="Never exit non-zero: report and alert instead, so a scheduled chain is not failed "
        "and retried for it (the evening run; the 21:00 job runs the result again).",
    ),
) -> None:
    """Send the completed day's net paper gain for Adaptive and the T1 track, and tomorrow's
    strategies. Idempotent: markers stop a retry sending twice, and a T1 result that was not
    ready follows on its own the next time this runs."""
    from datetime import time

    from .deliver import send_alert, send_result

    until = time.fromisoformat(wait_until) if wait_until else None
    earliest = time.fromisoformat(not_before) if not_before else None
    d = _day(day)
    try:
        code = send_result(
            d,
            telegram=telegram,
            force=force,
            with_tomorrow=tomorrow,
            wait_until=until,
            not_before=earliest,
            echo=typer.echo,
            err=lambda message: typer.echo(message, err=True),
        )
    except Exception as error:  # noqa: BLE001 - reported below
        if not soft_fail:
            raise
        typer.echo(f"result failed: {type(error).__name__}: {error}", err=True)
        code = 1
    if code and soft_fail:
        if telegram:
            send_alert(
                f"Rotation result for {d}: not everything was sent (exit {code})",
                "Already-sent parts are never sent again; what is missing is retried by the 16:00 "
                "result job's retries and the 21:00 job, or run `obt rotation result` by hand.",
            )
        typer.echo(f"result not sent (exit {code}); alerted, exiting 0 (--soft-fail)")
        return
    if code:
        raise typer.Exit(code)


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


@rotation_app.command("portfolio-warm")
def portfolio_warm(
    start: str = typer.Option(None, "--from", help="First day (default: the whole history)."),
    end: str = typer.Option(None, "--to", help="Last day (default: the latest)."),
) -> None:
    """Replay every list-day's baskets once so the Rotation page's portfolio stop is fast the
    first time you open it (BL-095). Read-only: it fills a disposable cache under
    ~/.cache/ai-trading-agent/portfolio-paths and changes no stored result."""
    import time

    from . import portfolio_log

    lo = date.fromisoformat(start) if start else None
    hi = date.fromisoformat(end) if end else None
    for source in ("reconstructed", "recorded"):
        t0 = time.monotonic()
        out = portfolio_log.days(lo, hi, None, None, source)
        n = sum(t["n"] for t in out["totals"].values())
        typer.echo(
            f"{source}: {len(out['rows'])} days, {n} list-days replayed "
            f"({len(out['errors'])} could not be) in {time.monotonic() - t0:.0f} s"
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
def verify(
    track: str = typer.Option(None, "--track", help="A parallel track's journal (t1)."),
) -> None:
    """Re-compute the hash chain (the live journal, or a track's); exit 1 on any problem."""
    from . import journal, store
    from .variants import TRACK_DIRS

    if track and track not in TRACK_DIRS:
        typer.echo(f"unknown track {track!r} (known: {', '.join(TRACK_DIRS)})", err=True)
        raise typer.Exit(2)
    path = store.journal_path(None, track)
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
            + (f"  expiry rule: {e['expiry_only']} only (Adaptive)" if e.get("expiry_only") else "")
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
    "index:N|S, kind:legwise|variant; a+b is both (slot:0917+index:N). A rotation list is "
    "list:A|B|C|REF (Steady, Calendar, Adaptive, Baseline; built from the journal, about 8 s). "
    "Default slot:0917."
)


def _window(start: str | None, end: str | None) -> tuple[date | None, date | None]:
    try:
        return (
            date.fromisoformat(start) if start else None,
            date.fromisoformat(end) if end else None,
        )
    except ValueError as error:
        raise typer.BadParameter(str(error)) from error


def _reconstructed(series, report) -> dict[str, int]:
    """Per rotation list: how many of the compared days were re-scored from history."""
    days = set(report.days)
    return {s.name: len(days & s.reconstructed) for s in series if s.kind == "list"}


def _list_notes(series, report) -> list[str]:
    """What a mixed comparison must say: the basis of a list's figures, and its re-scored days."""
    counts = _reconstructed(series, report)
    if not counts:
        return []
    out = [
        "Lists are gross per lot-day (the average one-lot gross of the picks); strategies are "
        "net per lot after costs. The header above says net."
    ]
    for name, n in counts.items():
        if n:
            out.append(
                f"{name}: {n} of {report.n_days} compared days were re-scored from history, "
                "not recorded forward."
            )
    return out


def _load(selectors: list[str], include_stale: bool):
    from . import journal
    from .series import SelectorError, load

    try:
        return load(selectors, include_stale=include_stale)
    except journal.JournalCorrupt as error:
        typer.echo(f"the rotation journal cannot be read: {error}", err=True)
        raise typer.Exit(2) from error
    except SelectorError as error:
        typer.echo(str(error), err=True)
        raise typer.Exit(2) from error


@rotation_app.command("corr-list")
def corr_list(
    kind: str = typer.Option(None, "--kind", help="variant | legwise | list"),
) -> None:
    """Every strategy that has daily results now, with its days and date range."""
    from .series import available, lists_available

    rows = [a for a in available() if kind is None or a.kind == kind]
    if kind == "list":  # built from the journal, so only when asked for
        rows = lists_available()
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
    notes = _list_notes(series, report)
    for line in notes:
        typer.echo(line)
    if json_path:
        with open(json_path, "w") as f:
            json.dump({**c.to_json(report), "reconstructed": _reconstructed(series, report)}, f)
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
