"""
Monthly copy of the whole data root to another disk (`tdata backup --to <dir>`).

Incremental: lake/, raw/, contract-notes/ (BL-168) and rotation/ are walked, and a file
the destination already has with the same size AND the same mtime is skipped. Most lake
and raw files never change once written, but some are rewritten in place (the yearly
`bars_1d` file grows, `lake/derived/` is rebuilt, a Fyers repair rewrites a day), and
contract-notes/ and rotation/ are rewritten often, at the same size as often as not, so
size alone is not enough. The catalog is always re-copied, after a CHECKPOINT.

Every copy is made safe for a bare exFAT disk that may be unplugged mid-run:
  - the source is stat'ed first; the bytes go to `<target>.<pid>.tmp`, which is fsynced,
    stamped with that FIRST stat's mtime, renamed onto the target, and the folder fsynced;
    a crash leaves a stray .tmp, never a full-size target with the right mtime and bad data;
  - the source is stat'ed again afterwards: if it moved during the copy (a writer's
    tmp + rename, or an append to rotation's journal.jsonl or store CSVs: a torn last line)
    it is copied again, up to MAX_TRIES times, and if it still moves the target is left
    with an mtime no source can have, so the next run copies it ("changed during backup");
  - a source that disappears mid-run (rotation's AlgoTest / Quantiply exports delete the
    previous export) is counted as "vanished" and the run goes on.

Never copied: lock files (`*.lock`: contract-notes' `run.lock`, rotation's `journal.lock`,
`.store.lock`, ...), `*.tmp` (half-written), and contract-notes' `raw/**/*.decrypted.pdf`
(rebuilt from the encrypted note and its password; the backup disk has no permissions).

Before contract-notes/ is copied, the backup waits (up to LOCK_WAIT_S) while its
`run.lock` names a live process, then goes on anyway and says so.
"""

from __future__ import annotations

import fcntl
import os
import shutil
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path

import duckdb

from .db import catalog_path

FOLDERS = ("lake", "raw", "contract-notes", "rotation")
MAX_TRIES = 3
LOCK_WAIT_S = 600.0
LOCK_POLL_S = 5.0
# mtimes are compared in 10 ms ticks: exFAT (the backup SSD) keeps modification times to
# 10 ms and truncates (checked on the owner's disk, 2026-10-27), APFS keeps nanoseconds.
# Truncating both sides to the tick compares them exactly on either destination, with no
# slack that could hide a same-size rewrite.
MTIME_TICK_NS = 10_000_000
# An mtime no source file has: a target stamped with it is copied again by the next run.
UNSTAMPED_NS = 0


@dataclass
class FolderCount:
    copied: int = 0
    skipped: int = 0
    changed: int = 0  # still changing after MAX_TRIES copies; copied again next run
    vanished: int = 0  # deleted at the source mid-run


@dataclass
class BackupReport:
    copied: int = 0
    skipped: int = 0
    changed: int = 0
    vanished: int = 0
    bytes_copied: int = 0
    # Per top-level folder; the catalog is in the totals only.
    folders: dict[str, FolderCount] = field(default_factory=dict)
    catalog_copied: bool = False
    notes: list[str] = field(default_factory=list)


def _excluded(root: Path, src: Path) -> bool:
    if src.suffix in (".lock", ".tmp"):
        return True
    rel = src.relative_to(root).parts
    return rel[:2] == ("contract-notes", "raw") and src.name.endswith(".decrypted.pdf")


def _same_tick(a_ns: int, b_ns: int) -> bool:
    return a_ns // MTIME_TICK_NS == b_ns // MTIME_TICK_NS


def _fsync_fd(fd: int) -> None:
    # macOS's fsync leaves the data in the drive's cache; F_FULLFSYNC flushes it.
    try:
        fcntl.fcntl(fd, fcntl.F_FULLFSYNC)
    except (AttributeError, OSError):
        os.fsync(fd)


def _fsync_dir(path: Path) -> None:
    try:
        fd = os.open(path, os.O_RDONLY)
    except OSError:
        return
    try:
        _fsync_fd(fd)
    except OSError:
        pass  # best effort: exFAT may refuse a directory fsync
    finally:
        os.close(fd)


def _write_atomically(src: Path, target: Path, st: os.stat_result) -> None:
    """Copy src's bytes onto target via a fsynced temporary stamped with `st`'s times."""
    target.parent.mkdir(parents=True, exist_ok=True)
    tmp = target.with_name(f"{target.name}.{os.getpid()}.tmp")
    try:
        shutil.copyfile(src, tmp)
        fd = os.open(tmp, os.O_RDONLY)
        try:
            _fsync_fd(fd)
        finally:
            os.close(fd)
        os.utime(tmp, ns=(st.st_atime_ns, st.st_mtime_ns))
        os.replace(tmp, target)
    finally:
        tmp.unlink(missing_ok=True)
    _fsync_dir(target.parent)


def _copy(src: Path, target: Path) -> tuple[str, int]:
    """("copied" | "changed", bytes). Raises FileNotFoundError if src is gone."""
    for _ in range(MAX_TRIES):
        st = src.stat()
        _write_atomically(src, target, st)
        after = src.stat()
        if (after.st_size, after.st_mtime_ns) == (st.st_size, st.st_mtime_ns):
            return "copied", st.st_size
    os.utime(target, ns=(st.st_atime_ns, UNSTAMPED_NS))
    return "changed", st.st_size


def _copy_counted(src: Path, target: Path, report: BackupReport, count: FolderCount) -> bool:
    """Copy and count; returns whether bytes were written."""
    try:
        outcome, size = _copy(src, target)
    except FileNotFoundError:
        if src.exists():
            raise  # not the source that went missing
        report.vanished += 1
        count.vanished += 1
        return False
    report.bytes_copied += size
    if outcome == "copied":
        report.copied += 1
        count.copied += 1
    else:
        report.changed += 1
        count.changed += 1
    return True


def _copy_folder(root: Path, dest: Path, sub: str, report: BackupReport) -> None:
    count = report.folders.setdefault(sub, FolderCount())
    for src in sorted((root / sub).rglob("*")):
        if _excluded(root, src):
            continue
        try:
            if not src.is_file():
                continue
            s = src.stat()
        except FileNotFoundError:
            report.vanished += 1
            count.vanished += 1
            continue
        target = dest / src.relative_to(root)
        try:
            t = target.stat()
        except FileNotFoundError:
            t = None
        if t is not None and t.st_size == s.st_size and _same_tick(t.st_mtime_ns, s.st_mtime_ns):
            report.skipped += 1
            count.skipped += 1
            continue
        _copy_counted(src, target, report, count)


def pid_alive(pid: int) -> bool:
    if pid <= 0:
        return False
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True  # exists, owned by someone else
    return True


def _wait_for_contract_notes_run(
    root: Path,
    report: BackupReport,
    *,
    wait_s: float,
    sleep: Callable[[float], None],
    clock: Callable[[], float],
    alive: Callable[[int], bool],
) -> None:
    lock = root / "contract-notes" / "run.lock"
    start = clock()
    waited = False
    while True:
        try:
            pid = int(lock.read_text().strip())
        except (FileNotFoundError, ValueError):
            break
        if not alive(pid):
            break
        if clock() - start >= wait_s:
            report.notes.append(
                f"contract-notes: a run (pid {pid}) still held run.lock after "
                f"{wait_s / 60:.0f} min; copied anyway (a file it was writing may be "
                "copied again next run)"
            )
            return
        waited = True
        sleep(LOCK_POLL_S)
    if waited:
        report.notes.append(
            f"contract-notes: waited {clock() - start:.0f} s for a contract-notes run to finish"
        )


def backup(
    root: Path,
    dest: Path,
    *,
    lock_wait_s: float = LOCK_WAIT_S,
    sleep: Callable[[float], None] = time.sleep,
    clock: Callable[[], float] = time.monotonic,
    alive: Callable[[int], bool] = pid_alive,
) -> BackupReport:
    if dest.resolve() == root.resolve() or root.resolve() in dest.resolve().parents:
        raise ValueError("backup destination must be outside the data root")
    report = BackupReport()
    for sub in FOLDERS:
        if sub == "contract-notes":
            _wait_for_contract_notes_run(
                root, report, wait_s=lock_wait_s, sleep=sleep, clock=clock, alive=alive
            )
        _copy_folder(root, dest, sub, report)

    catalog = catalog_path(root)
    if catalog.exists():
        con = duckdb.connect(str(catalog))
        try:
            con.execute("CHECKPOINT")
        finally:
            con.close()
        report.catalog_copied = _copy_counted(catalog, dest / catalog.name, report, FolderCount())
    return report
