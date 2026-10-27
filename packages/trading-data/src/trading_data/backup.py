"""
Monthly copy of the whole data root to another disk (`tdata backup --to <dir>`).

lake/ and raw/ files are immutable once written, so the copy is incremental:
a file already present at the destination with the same size is skipped. The
catalog is small and changes, so it is always re-copied — via a checkpoint +
plain file copy, done while this process holds the only connection.

contract-notes/ (BL-168) and rotation/ are rewritten in place (a contract-notes
day re-read, a manual entry edited, the rotation store and journal every evening),
often at the same size, so for them a file is skipped only when its size AND its
mtime match the destination's; `shutil.copy2` carries the mtime over, so the next
run skips it. Lock files and half-written temporaries are never copied.
"""

from __future__ import annotations

import shutil
from dataclasses import dataclass, field
from pathlib import Path

import duckdb

from .db import catalog_path

# Immutable once written: same size at the destination = already backed up.
IMMUTABLE_DIRS = ("lake", "raw")
# Rewritten in place: compared on size and mtime.
MUTABLE_DIRS = ("contract-notes", "rotation")
# exFAT keeps mtimes to 10 ms and FAT to 2 s, so a copy's mtime can differ from the
# source's by less than this without the file having changed.
MTIME_TOLERANCE_S = 2.0


@dataclass
class FolderCount:
    copied: int = 0
    skipped: int = 0


@dataclass
class BackupReport:
    copied: int = 0
    skipped: int = 0
    bytes_copied: int = 0
    # Per top-level folder (lake, raw, contract-notes, rotation); the catalog is in the
    # totals only.
    folders: dict[str, FolderCount] = field(default_factory=dict)
    catalog_copied: bool = False


def _is_lock_or_temp(path: Path) -> bool:
    """A lock (`run.lock`, `journal.lock`, `.store.lock`) or a temporary still being
    written (`<file>.<pid>.tmp`): meaningless, or half-written, in a copy."""
    return path.suffix in (".lock", ".tmp")


def _same_size_and_mtime(src: Path, target: Path) -> bool:
    s, t = src.stat(), target.stat()
    return s.st_size == t.st_size and abs(s.st_mtime - t.st_mtime) <= MTIME_TOLERANCE_S


def _copy_folder(root: Path, dest: Path, sub: str, report: BackupReport, *, mutable: bool) -> None:
    count = report.folders.setdefault(sub, FolderCount())
    for src in sorted((root / sub).rglob("*")):
        if not src.is_file():
            continue
        if mutable and _is_lock_or_temp(src):
            continue
        if not mutable and src.suffix == ".tmp":
            continue
        target = dest / src.relative_to(root)
        if target.exists() and (
            _same_size_and_mtime(src, target)
            if mutable
            else target.stat().st_size == src.stat().st_size
        ):
            report.skipped += 1
            count.skipped += 1
            continue
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src, target)
        report.copied += 1
        count.copied += 1
        report.bytes_copied += src.stat().st_size


def backup(root: Path, dest: Path) -> BackupReport:
    if dest.resolve() == root.resolve() or root.resolve() in dest.resolve().parents:
        raise ValueError("backup destination must be outside the data root")
    report = BackupReport()
    for sub in IMMUTABLE_DIRS:
        _copy_folder(root, dest, sub, report, mutable=False)
    for sub in MUTABLE_DIRS:
        _copy_folder(root, dest, sub, report, mutable=True)

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
        report.catalog_copied = True
    return report
