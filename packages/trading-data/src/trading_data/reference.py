"""
Reference data (lot sizes, strike steps, expiry rules, holidays, margins).

The catalog is the MASTER copy (owner decision, 2026-09-30). The CSVs in
packages/option-backtesting/src/option_backtesting/data/reference/ are EXPORTED
from it, because two readers still consume files: the TypeScript
packages/market-reference (read at runtime by apps/server — the NIFTY lot-size
gotcha in technical.md) and option-backtesting's ReferenceData loader.
`export_csvs` reproduces the committed files byte for byte, and `check` fails
when the two have drifted — edit the catalog, then export, never the CSV alone.
"""

from __future__ import annotations

import csv
import io
from dataclasses import dataclass
from pathlib import Path

import duckdb

REPO_ROOT = Path(__file__).resolve().parents[4]
REFERENCE_DIR = (
    REPO_ROOT
    / "packages"
    / "option-backtesting"
    / "src"
    / "option_backtesting"
    / "data"
    / "reference"
)


@dataclass(frozen=True)
class RefTable:
    table: str
    csv_name: str
    columns: tuple[str, ...]
    order_by: str
    #: columns written always-quoted (holidays' descriptions are, in the committed file)
    quoted: tuple[str, ...] = ()


TABLES = (
    RefTable(
        "ref_lot_sizes", "lot_sizes.csv", ("underlying", "lot_size", "effective_date"), "rowid"
    ),
    RefTable(
        "ref_strike_steps", "strike_step.csv", ("underlying", "step", "effective_date"), "rowid"
    ),
    RefTable(
        "ref_expiry_rules",
        "expiry_calendar.csv",
        ("underlying", "cadence", "weekday", "effective_date"),
        "rowid",
    ),
    RefTable(
        "ref_holidays", "holidays.csv", ("date", "description"), "rowid", quoted=("description",)
    ),
    RefTable(
        "ref_margins", "margin.csv", ("underlying", "strategy_type", "month", "margin_inr"), "rowid"
    ),
)


def _fmt(value: object) -> str:
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    return str(value)


def render_csv(con: duckdb.DuckDBPyConnection, t: RefTable) -> str:
    rows = con.execute(
        f"SELECT {', '.join(t.columns)} FROM {t.table} ORDER BY {t.order_by}"
    ).fetchall()
    out = [",".join(t.columns)]
    for row in rows:
        cells = []
        for col, value in zip(t.columns, row, strict=True):
            text = _fmt(value)
            cells.append(f'"{text}"' if col in t.quoted else text)
        out.append(",".join(cells))
    return "\n".join(out) + "\n"


def import_csvs(con: duckdb.DuckDBPyConnection, folder: Path = REFERENCE_DIR) -> dict[str, int]:
    """Replace every reference table with the CSVs' contents (one transaction)."""
    counts = {}
    con.execute("BEGIN")
    try:
        for t in TABLES:
            with (folder / t.csv_name).open(newline="") as fh:
                rows = list(csv.DictReader(fh))
            con.execute(f"DELETE FROM {t.table}")
            placeholders = ", ".join("?" for _ in t.columns)
            con.executemany(
                f"INSERT INTO {t.table} ({', '.join(t.columns)}) VALUES ({placeholders})",
                [[r[c] for c in t.columns] for r in rows],
            )
            counts[t.table] = len(rows)
        con.execute("COMMIT")
    except Exception:
        con.execute("ROLLBACK")
        raise
    return counts


def export_csvs(con: duckdb.DuckDBPyConnection, folder: Path = REFERENCE_DIR) -> list[Path]:
    written = []
    for t in TABLES:
        path = folder / t.csv_name
        text = render_csv(con, t)
        if not path.exists() or path.read_text() != text:
            path.write_text(text)
            written.append(path)
    return written


def check(con: duckdb.DuckDBPyConnection, folder: Path = REFERENCE_DIR) -> list[str]:
    """Names of CSVs whose content differs from the catalog (empty = in sync)."""
    drift = []
    for t in TABLES:
        path = folder / t.csv_name
        if not path.exists() or path.read_text() != render_csv(con, t):
            drift.append(t.csv_name)
    return drift


def diff_preview(con: duckdb.DuckDBPyConnection, name: str, folder: Path = REFERENCE_DIR) -> str:
    t = next(t for t in TABLES if t.csv_name == name)
    import difflib

    old = (folder / name).read_text().splitlines(keepends=True) if (folder / name).exists() else []
    new = io.StringIO(render_csv(con, t)).readlines()
    return "".join(difflib.unified_diff(old, new, f"{name} (file)", f"{name} (catalog)"))
