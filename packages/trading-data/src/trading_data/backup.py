"""
Monthly copy of the whole data root to another disk (`tdata backup --to <dir>`).

lake/ and raw/ files are immutable once written, so the copy is incremental:
a file already present at the destination with the same size is skipped. The
catalog is small and changes, so it is always re-copied — via a checkpoint +
plain file copy, done while this process holds the only connection.
"""

from __future__ import annotations

import shutil
from dataclasses import dataclass
from pathlib import Path

import duckdb

from .db import catalog_path


@dataclass
class BackupReport:
    copied: int = 0
    skipped: int = 0
    bytes_copied: int = 0


def backup(root: Path, dest: Path) -> BackupReport:
    if dest.resolve() == root.resolve() or root.resolve() in dest.resolve().parents:
        raise ValueError("backup destination must be outside the data root")
    report = BackupReport()
    for sub in ("lake", "raw"):
        for src in sorted((root / sub).rglob("*")):
            if not src.is_file() or src.suffix == ".tmp":
                continue
            target = dest / src.relative_to(root)
            if target.exists() and target.stat().st_size == src.stat().st_size:
                report.skipped += 1
                continue
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(src, target)
            report.copied += 1
            report.bytes_copied += src.stat().st_size

    catalog = catalog_path(root)
    if catalog.exists():
        con = duckdb.connect(str(catalog))
        try:
            con.execute("CHECKPOINT")
        finally:
            con.close()
        dest.mkdir(parents=True, exist_ok=True)
        shutil.copy2(catalog, dest / catalog.name)
        report.copied += 1
        report.bytes_copied += catalog.stat().st_size
    return report
