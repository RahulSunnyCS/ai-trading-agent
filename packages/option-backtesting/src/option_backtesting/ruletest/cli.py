"""`obt rule …`: validate | test | reveal | ledger (BL-120)."""

from __future__ import annotations

import json
from pathlib import Path

import typer

from . import store
from .spec import SpecError, load_spec, read_back

rule_app = typer.Typer(
    no_args_is_help=True,
    help="Rule strategies: state a condition, read it back, test it over the collected days.",
)


def _load(path: Path):
    try:
        return load_spec(path.read_text())
    except (SpecError, OSError) as error:
        typer.echo(f"{path}: {error}", err=True)
        raise typer.Exit(1) from error


@rule_app.command()
def validate(path: Path = typer.Argument(..., help="A rule file (YAML).")) -> None:
    """Check a rule and read it back in plain words. Runs nothing."""
    rule = _load(path)
    back = read_back(rule)
    typer.echo(f"{rule.spec.id}  ({rule.spec_hash})")
    for sentence in back["sentences"]:
        typer.echo(f"  {sentence}")
    for definition in back["definitions"]:
        typer.echo(f"    where {definition}")


@rule_app.command()
def test(
    path: Path = typer.Argument(..., help="A rule file (YAML)."),
    period: str = typer.Option(
        "learning",
        "--period",
        help="learning (2024-10 to 2026-10), confirmation (2022-01 to 2024-10) or both.",
    ),
    open_all: bool = typer.Option(
        False,
        "--open-all",
        help="Open the confirmation period without a reveal; the result is labelled exploratory.",
    ),
    workers: int = typer.Option(4, "--workers"),
    tries: int = typer.Option(
        1, "--tries", help="How many variants this test stands for (a sweep of K counts K)."
    ),
    as_json: bool = typer.Option(False, "--json", help="Print the full result as JSON."),
) -> None:
    """Test a rule: events, placebo, random-time control, charges. Every test is counted."""
    from ..fyers.daily import data_dir
    from . import study

    rule = _load(path)
    periods = ("learning", "confirmation") if period == "both" else (period,)
    options = study.Options(
        periods=periods,
        mode="exploratory" if open_all else "locked",
        workers=workers,
        tries=tries,
        progress=lambda message: typer.echo(message, err=True),
    )
    try:
        result = study.run_test(data_dir(), rule, path.read_text(), options)
    except store.RuleTestError as error:
        typer.echo(str(error), err=True)
        raise typer.Exit(2) from error
    if as_json:
        typer.echo(json.dumps(result))
        return
    typer.echo(render(result))


def money(value: float | None) -> str:
    return "–" if value is None else f"₹{value:,.0f}"


def render(result: dict) -> str:
    lines = [
        f"{result['name']}  {result['spec_hash']}  ({result['label']}; mode {result['mode']})",
        f"test {result['counts']['week']} this week, {result['counts']['month']} this month. "
        f"{result['luck']}",
    ]
    seen = result.get("confirmation_seen_before") or []
    if seen:
        lines.append(
            f"The confirmation period was already seen by {len(seen)} earlier test"
            f"{'' if len(seen) == 1 else 's'} of this rule ({', '.join(seen)}): "
            "this is not a first look at it."
        )
    for period, p in result["periods"].items():
        lines.append("")
        lines.append(f"{period}  {p['from']} to {p['to']}")
        if not p.get("rows"):
            lines.append(f"  {p.get('message', 'no events')}")
            continue
        thin = "  (thin: under 40 event days, reported not judged)" if p["thin"] else ""
        lines.append(
            f"  events {p['events']} on {p['event_days']} days{thin}; net per trade "
            f"{money(p['net_mean'])} (gross {money(p['gross_mean'])}), wins {p['win_rate']:.0%}, "
            f"stopped {p['stopped_share']:.0%}"
        )
        pl = p["placebo"]
        if pl["diff_mean"] is not None:
            t = "n/a" if pl["diff_t"] is None else f"{pl['diff_t']:.2f}"
            lines.append(
                f"  placebo {money(pl['placebo_mean'])}; "
                f"event minus placebo {money(pl['diff_mean'])}, t {t}"
            )
        rt = p["random_time"]
        if rt.get("draws"):
            lines.append(
                f"  random time: mean {money(rt['mean'])}, 95th {money(rt['p95'])}; "
                f"the event mean sits at "
                f"the {rt['event_percentile']:.0%} point of {rt['draws']} draws"
            )
        slip = ", ".join(
            f"{pct}% → {money(v['net_mean'])}" for pct, v in p["slippage"].items() if v
        )
        if slip:
            lines.append(f"  slippage per fill: {slip}")
    return "\n".join(lines)


@rule_app.command()
def reveal(
    spec: str = typer.Argument(..., help="A rule file or its hash."),
    note: str = typer.Option("", "--note"),
) -> None:
    """Open the confirmation period for one rule, once. Logged; a changed rule is locked again."""
    from ..fyers.daily import data_dir

    if Path(spec).exists():
        spec = _load(Path(spec)).spec_hash
    row = store.reveal(data_dir(), spec, note)
    typer.echo(f"confirmation period open for {spec} (logged {row['at']})")


@rule_app.command()
def ledger(limit: int = typer.Option(20, "--limit")) -> None:
    """Every test run, newest last, with the running count."""
    from ..fyers.daily import data_dir

    rows = store.ledger(data_dir())
    c = store.counts(rows)
    typer.echo(f"{c['total']} tests ({c['week']} this week, {c['month']} this month)")
    for row in rows[-limit:]:
        parts = []
        for period, s in row.get("summary", {}).items():
            parts.append(
                f"{period}: {s.get('events')} events, net {money(s.get('net_mean'))}, "
                f"vs placebo t {'n/a' if s.get('diff_t') is None else format(s['diff_t'], '.2f')}"
            )
        typer.echo(
            f"  {row['at']}  {row['id']}  {row['name']}  [{row['mode']}]  " + "; ".join(parts)
        )
