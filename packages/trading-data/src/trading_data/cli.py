"""`tdata` — set up, inspect, back up the local research database."""

from __future__ import annotations

import os
import subprocess
from pathlib import Path

import typer

from . import quality, reference, vendor
from .backup import backup as run_backup
from .db import LAKE_VIEWS, catalog_path, check_mounted, connect, data_root

app = typer.Typer(no_args_is_help=True, add_completion=False)
ref_app = typer.Typer(no_args_is_help=True, help="Lot sizes, strike steps, calendars, margins.")
app.add_typer(ref_app, name="reference")
quality_app = typer.Typer(no_args_is_help=True, help="Per-day quality verdicts for the lake.")
app.add_typer(quality_app, name="quality")
vendor_app = typer.Typer(no_args_is_help=True, help="Load the vendor's history (BL-034).")
app.add_typer(vendor_app, name="vendor")


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
            has_date = "date" in con.execute(f"DESCRIBE {view}").df()["column_name"].tolist()
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


@app.command()
def mount() -> None:
    """Attach the disk image holding the data root (TRADING_DATA_IMAGE) unless it is
    already mounted. Safe to re-run; the login LaunchAgent runs it whenever a volume
    appears, so plugging the SSD in is enough."""
    root = data_root(require_mounted=False)
    try:
        check_mounted(root)
    except RuntimeError:
        pass
    else:
        typer.echo(f"{root}: mounted")
        return
    image = os.environ.get("TRADING_DATA_IMAGE", "").strip()
    if not image:
        typer.echo("TRADING_DATA_IMAGE is not set (see .env.example)", err=True)
        raise typer.Exit(1)
    if not Path(image).exists():
        typer.echo(f"{image} not found — is the SSD connected?", err=True)
        raise typer.Exit(1)
    subprocess.run(["hdiutil", "attach", image], check=True, capture_output=True)
    check_mounted(root)  # attached under another name ("TradingData 1") still fails here
    typer.echo(f"{root}: attached {image}")


@quality_app.command("rebuild")
def quality_rebuild(
    asset: str = typer.Option(None, help="option, future or index (default: all)."),
    name: str = typer.Option(None, help="One underlying / symbol, e.g. NIFTY."),
    days: str = typer.Option(None, help="Only days in A..B, e.g. 2026-09-01..2026-09-30."),
) -> None:
    """Re-judge lake partitions from the Parquet files and refresh `data_quality`."""
    if asset and asset not in quality.ASSETS:
        raise typer.BadParameter(f"asset must be one of {', '.join(quality.ASSETS)}")
    try:
        window = quality.parse_days(days) if days else None
    except ValueError as error:
        raise typer.BadParameter(str(error)) from error
    done = quality.rebuild(data_root(), asset=asset, name=name, days=window, log=typer.echo)
    typer.echo(
        f"rebuilt {sum(v for k, v in done.items() if '/' in k):,} day verdicts; "
        f"{done['no_spot_changes']} no_spot labels changed"
    )


@quality_app.command("status")
def quality_status() -> None:
    """Days, range and verdicts per (asset, name), with the reasons for exclusions."""
    with connect(data_root(), read_only=True) as con:
        rows = con.execute(
            "SELECT asset, name, count(*), min(trading_day), max(trading_day), "
            "count(*) FILTER (WHERE verdict = 'usable'), "
            "count(*) FILTER (WHERE verdict = 'excluded') "
            "FROM data_quality GROUP BY 1, 2 ORDER BY 1, 2"
        ).fetchall()
        reasons = con.execute(
            "SELECT asset, name, split_part(reason, ':', 1), count(*) FROM data_quality "
            "WHERE verdict = 'excluded' GROUP BY 1, 2, 3 ORDER BY 1, 2, 4 DESC"
        ).fetchall()
    if not rows:
        typer.echo("no verdicts yet — run `tdata quality rebuild`")
        return
    why: dict[tuple[str, str], list[str]] = {}
    for asset, name, reason, n in reasons:
        why.setdefault((asset, name), []).append(f"{reason} {n}")
    for asset, name, days, lo, hi, ok, bad in rows:
        line = f"{asset:<7} {name:<12} {days:>5} days  {lo} .. {hi}  usable {ok}  excluded {bad}"
        if bad:
            line += f"  ({', '.join(why[(asset, name)])})"
        typer.echo(line)


@vendor_app.command("import")
def vendor_import(
    from_: Path = typer.Option(
        ..., "--from", help="The staging set: <dir>/<index|stocks>/<unit>/*.parquet."
    ),
    unit: list[str] = typer.Option(
        None, "--unit", help="Only these units (repeatable), e.g. nifty."
    ),
    section: str = typer.Option("all", help="index, stocks or all."),
    days: str = typer.Option(None, help="Only days in A..B, e.g. 2024-10-01..2026-09-17."),
    force: bool = typer.Option(False, help="Rewrite days an earlier vendor import wrote."),
    dry_run: bool = typer.Option(False, help="List what would be imported and stop."),
) -> None:
    """Load the vendor's staged options history into the lake (BL-034). Resumable; the Fyers
    collector's days are never overwritten."""
    if section not in ("all", "index", "stocks"):
        raise typer.BadParameter("section must be index, stocks or all")
    try:
        window = quality.parse_days(days) if days else None
    except ValueError as error:
        raise typer.BadParameter(str(error)) from error
    units = vendor.list_units(from_.expanduser(), units=unit, section=section)
    if not units:
        typer.echo("nothing to import — no matching units with data", err=True)
        raise typer.Exit(1)
    root = data_root()
    typer.echo(f"{len(units)} units, {sum(u.rows for u in units):,} rows -> {root}")
    if dry_run:
        for u in units:
            typer.echo(f"  {u.section}/{u.folder}: {len(u.files)} files, {u.rows:,} rows")
        return
    for u in units:
        report = vendor.import_unit(root, u, days=window, force=force, log=typer.echo)
        excluded = ", ".join(f"{k} {v}" for k, v in sorted(report.excluded.items())) or "none"
        typer.echo(
            f"== {report.name}: {report.days_written} days written, "
            f"{report.days_skipped_existing} existing, {report.rows_written:,} rows; "
            f"chunks run {report.chunks_run}, skipped {report.chunks_skipped}; "
            f"unparsed rows {report.rows_unparsed}; excluded days: {excluded}"
        )


@vendor_app.command("import-index")
def vendor_import_index(
    csv: Path = typer.Argument(..., help="A Date,Open,High,Low,Close,Volume 1-minute CSV."),
    symbol: str = typer.Option(..., help="NIFTY, BANKNIFTY, SENSEX, INDIAVIX, ..."),
    days: str = typer.Option(None, help="Only days in A..B."),
    force: bool = typer.Option(False, help="Rewrite days an earlier vendor import wrote."),
) -> None:
    """Load an index spot (or India VIX) CSV as asset=index/symbol=<SYMBOL>."""
    try:
        window = quality.parse_days(days) if days else None
    except ValueError as error:
        raise typer.BadParameter(str(error)) from error
    report = vendor.import_index_csv(
        data_root(), csv.expanduser(), symbol, days=window, force=force, log=typer.echo
    )
    typer.echo(
        f"== {report.name}: {report.days_written} days written, "
        f"{report.days_skipped_existing} existing, {report.rows_written:,} rows"
    )
