"""`obt heatmap build | show | list` (BL-094)."""

from __future__ import annotations

from datetime import date
from pathlib import Path

import typer

from . import grid, store, view

heatmap_app = typer.Typer(no_args_is_help=True, help="ATM short-straddle heatmap (BL-094).")


def _day(raw: str | None) -> date | None:
    return date.fromisoformat(raw) if raw else None


def lake_underlyings(root: Path) -> list[str]:
    base = root / "lake" / "bars_1m" / "asset=option"
    return sorted(p.name.split("=", 1)[1] for p in base.glob("underlying=*"))


@heatmap_app.command("build")
def build_cmd(
    underlying: list[str] = typer.Option(
        None, "--underlying", "-u", help="repeatable; default: every index"
    ),
    stocks: bool = typer.Option(False, "--stocks", help="every stock underlying in the lake"),
    from_: str | None = typer.Option(None, "--from"),
    to: str | None = typer.Option(None, "--to"),
    force: bool = typer.Option(False, "--force", help="recompute days already stored"),
) -> None:
    """Add the grid for every usable collected day (incremental)."""
    from ..fyers.daily import data_dir

    root = data_dir()
    names = list(underlying or [])
    if stocks:
        names += [n for n in lake_underlyings(root) if not grid.is_index(n) and n not in names]
    if not names:
        names = list(grid.INDEXES)
    for name in names:
        result = store.build(name, root, _day(from_), _day(to), force=force)
        typer.echo(
            f"{name:12s} +{result['added']} days, {result['total_days']} stored, "
            f"{len(result['skipped'])} left out"
        )


@heatmap_app.command("list")
def list_cmd() -> None:
    """Underlyings with a stored grid."""
    for row in store.available():
        typer.echo(
            f"{row['underlying']:12s} {row['kind']:6s} {row['expiry']:8s} "
            f"{row['first_day']} .. {row['last_day']}  {row['days']} days"
        )


def _fmt(cell: dict | None) -> str:
    return f"{cell['net']:9.0f}" if cell else f"{'-':>9}"


@heatmap_app.command("show")
def show_cmd(
    underlying: str = typer.Argument("NIFTY"),
    view_name: str = typer.Option("time_sl", "--view"),
    day: str | None = typer.Option(None, "--day"),
    from_: str | None = typer.Option(None, "--from"),
    to: str | None = typer.Option(None, "--to"),
    sl: int | None = typer.Option(None, "--sl"),
    time: str | None = typer.Option(None, "--time"),
    exit_time: str = typer.Option(grid.EXIT_TIME, "--exit"),
    metric: str = typer.Option("value", "--metric"),
) -> None:
    """Print one view as a table."""
    out = view.build_view(
        underlying,
        view_name,
        day=_day(day),
        start=_day(from_),
        end=_day(to),
        sl=sl,
        time=time,
        exit_time=exit_time,
        metric=metric,
    )
    head = "".join(f"{('NoSL' if c == grid.NO_SL else c)!s:>9}" for c in out["columns"])
    typer.echo(f"{out['underlying']} {out['view']} ({out['unit']})\n{'':>12}{head}{'TOTAL':>10}")
    for r, line, tot in zip(out["rows"], out["cells"], out["row_totals"], strict=True):
        typer.echo(f"{r:>12}{''.join(_fmt(c) for c in line)}{_fmt(tot)}")
    typer.echo(f"{'TOTAL':>12}{''.join(_fmt(c) for c in out['column_totals'])}{_fmt(out['total'])}")
