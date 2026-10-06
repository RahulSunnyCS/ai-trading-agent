"""`tdata` — set up, inspect, back up the local research database."""

from __future__ import annotations

from pathlib import Path

import typer

from . import reference
from .backup import backup as run_backup
from .db import LAKE_VIEWS, catalog_path, connect, data_root

app = typer.Typer(no_args_is_help=True, add_completion=False)
ref_app = typer.Typer(no_args_is_help=True, help="Lot sizes, strike steps, calendars, margins.")
app.add_typer(ref_app, name="reference")


def _size(path: Path) -> int:
    return sum(p.stat().st_size for p in path.rglob("*") if p.is_file()) if path.exists() else 0


def _mb(n: int) -> str:
    return f"{n / 1_000_000:,.1f} MB"


@app.command()
def init() -> None:
    """Create the data root and catalog (or apply pending migrations). On a fresh
    catalog, also loads the reference data from the committed CSVs."""
    root = data_root()
    with connect(root) as con:  # migrates, and loads reference data into a new catalog
        applied = [r[0] for r in con.execute("SELECT version FROM schema_migrations").fetchall()]
        counts = {
            t.table: con.execute(f"SELECT count(*) FROM {t.table}").fetchone()[0]
            for t in reference.TABLES
        }
    typer.echo(f"reference data: {counts}")
    typer.echo(f"catalog: {catalog_path(root)} (migrations: {', '.join(applied)})")


@app.command()
def status() -> None:
    """Where the data lives, what is in it, and how big it is."""
    root = data_root()
    typer.echo(f"data root: {root}  (TRADING_DATA_ROOT to move it)")
    if not catalog_path(root).exists():
        typer.echo("no catalog yet — run `tdata init`")
        raise typer.Exit(1)
    typer.echo(
        f"size: catalog {_mb(catalog_path(root).stat().st_size)}, "
        f"lake {_mb(_size(root / 'lake'))}, raw {_mb(_size(root / 'raw'))}"
    )
    with connect(root, read_only=True) as con:
        for asset, n in con.execute(
            "SELECT asset_class, count(*) FROM instruments GROUP BY 1 ORDER BY 1"
        ).fetchall():
            typer.echo(f"instruments: {asset:<8} {n:>8,}")
        for view in LAKE_VIEWS:
            n = con.execute(f"SELECT count(*) FROM {view}").fetchone()[0]
            if n == 0:
                continue
            # fetchall, not .df(): pandas/numpy are not dependencies of this package
            has_date = "date" in [r[0] for r in con.execute(f"DESCRIBE {view}").fetchall()]
            if has_date:
                days, lo, hi = con.execute(
                    f"SELECT count(DISTINCT date), min(date), max(date) FROM {view}"
                ).fetchone()
                typer.echo(f"{view:<15} {n:>12,} rows over {days} days ({lo} .. {hi})")
            else:
                typer.echo(f"{view:<15} {n:>12,} rows")
        # Every other catalog table with rows in it — generic, so a new migration's
        # tables (e.g. momentum's companies/corporate_actions) show up with no
        # changes needed here.
        skip = {"schema_migrations", *[t.table for t in reference.TABLES]}
        tables = [
            r[0]
            for r in con.execute(
                "SELECT table_name FROM information_schema.tables WHERE table_schema = 'main' "
                "ORDER BY 1"
            ).fetchall()
            if r[0] not in skip
        ]
        for table in tables:
            n = con.execute(f"SELECT count(*) FROM {table}").fetchone()[0]
            if n:
                typer.echo(f"{table:<20} {n:>10,} rows")
        runs = con.execute(
            "SELECT status, count(*) FROM ingest_runs GROUP BY 1 ORDER BY 1"
        ).fetchall()
        typer.echo(f"ingest runs: {dict(runs) or 'none'}")
        drift = reference.check(con)
        typer.echo(
            "reference CSVs: in sync with the catalog"
            if not drift
            else f"reference CSVs OUT OF SYNC: {drift} — run `tdata reference export`"
        )


@ref_app.command("export")
def reference_export() -> None:
    """Write the reference CSVs (read by market-reference and ReferenceData) from the catalog."""
    with connect() as con:
        written = reference.export_csvs(con)
    typer.echo("\n".join(f"wrote {p}" for p in written) or "already in sync")


@ref_app.command("check")
def reference_check() -> None:
    """Exit 1 if any reference CSV differs from the catalog (shows the diff)."""
    with connect(read_only=True) as con:
        drift = reference.check(con)
        for name in drift:
            typer.echo(reference.diff_preview(con, name))
    if drift:
        raise typer.Exit(1)
    typer.echo("in sync")


@ref_app.command("sql")
def reference_sql(statement: str) -> None:
    """Run one SQL statement against the catalog (e.g. an INSERT into ref_lot_sizes),
    then export the CSVs. The way to change reference data now that the catalog is master."""
    with connect() as con:
        con.execute(statement)
        written = reference.export_csvs(con)
    typer.echo("\n".join(f"wrote {p}" for p in written) or "no CSV changed")


@app.command()
def backup(
    to: Path = typer.Option(..., "--to", help="Destination folder on the other disk."),
) -> None:
    """Copy the data root to another disk. Lake/raw files are copied only if new; the
    catalog is always re-copied. Meant to run monthly."""
    root = data_root()
    report = run_backup(root, to.expanduser())
    typer.echo(
        f"backup to {to}: {report.copied} files copied ({_mb(report.bytes_copied)}), "
        f"{report.skipped} already there"
    )
