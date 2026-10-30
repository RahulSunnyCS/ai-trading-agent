"""Per-variant daily results and per-day attributes, as plain files under
TRADING_DATA_ROOT/rotation/ (not the catalog: it allows one writer, and `obt daily` must not wait
on this job).

    rotation/results/<variant>.csv   day,net,gross,costs,worst_mtm,stopped_by,n_trades
    rotation/results/slip-0.5/<variant>.csv   the same after 0.5% slippage on every fill
        (`slip_store`; one beside every results folder: a track's and the base's too)
    rotation/days.csv                day,weekday,vix_open,vix_band,dte_n,dte_s
    rotation/journal.jsonl           the hash chain (journal.py)
"""

from __future__ import annotations

import csv
import fcntl
from collections.abc import Iterator
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass
from datetime import date
from pathlib import Path

import numpy as np

from ..fyers.daily import data_dir
from .dte import from_calendar_label

RESULT_COLUMNS = ["day", "net", "gross", "costs", "worst_mtm", "stopped_by", "n_trades"]
DAY_COLUMNS = ["day", "weekday", "vix_open", "vix_band", "dte_n", "dte_s"]

#: the slippage (% of price, every entry and exit) the results are read at: 0 reads them as
#: stored; otherwise every reader of a results file reads its `slip_path` copy instead (owner,
#: 2026-10-30: the dashboard's Rotation pages, display only). Set per request with `slipped`;
#: the ranking never reads it (`pick`, `explain` and `live_compare` read with `slipped(0)`).
_SLIP: ContextVar[float] = ContextVar("rotation_slippage", default=0.0)
#: the slippages a copy is kept for
SLIP_CHOICES = (0.0, 0.5)


@contextmanager
def slipped(pct: float) -> Iterator[None]:
    """Read every results file at `pct` % slippage inside the block (0: as stored)."""
    if pct not in SLIP_CHOICES:
        raise ValueError(f"slippage must be one of {', '.join(f'{c:g}' for c in SLIP_CHOICES)}")
    token = _SLIP.set(pct)
    try:
        yield
    finally:
        _SLIP.reset(token)


def reading_slip() -> float:
    return _SLIP.get()


def slip_path(path: Path, pct: float) -> Path:
    """A results file's copy at `pct` % slippage: `<folder>/slip-<pct>/<same name>`."""
    return path.parent / f"slip-{pct:g}" / path.name


def read_path(path: Path) -> Path:
    """The file a reader opens for the stored results file `path`: its slippage copy while
    `slipped` is in force, else `path` itself. A copy that is missing reads as no results (never
    silently as the unslipped figures)."""
    pct = _SLIP.get()
    return slip_path(path, pct) if pct else path


def rotation_dir(root: Path | None = None) -> Path:
    return (root or data_dir()) / "rotation"


def results_dir(root: Path | None = None) -> Path:
    return rotation_dir(root) / "results"


def days_path(root: Path | None = None) -> Path:
    return rotation_dir(root) / "days.csv"


def journal_path(root: Path | None = None, track: str | None = None) -> Path:
    """The live journal, or a parallel track's own (never the same file)."""
    if track:
        return track_dir(track, root) / "journal.jsonl"
    return rotation_dir(root) / "journal.jsonl"


def track_dir(track: str, root: Path | None = None) -> Path:
    """A parallel track's own folder: its extra variants' results and its journal. The live
    results folder never holds them; the Strategy Matrix reads them only with `universe=t1`."""
    return rotation_dir(root) / f"track_{track}"


def result_path(name: str, root: Path | None = None) -> Path:
    """Where a variant's results live: the live folder for Core-298, its track's for the rest."""
    from .variants import track_of

    track = track_of(name)
    folder = track_dir(track, root) / "results" if track else results_dir(root)
    return folder / f"{name}.csv"


@contextmanager
def _write_lock(root: Path | None) -> Iterator[None]:
    """One exclusive lock for every write to rotation/results and days.csv: the check for an
    existing day and the append are one step, so two runs cannot both add the same day."""
    directory = rotation_dir(root)
    directory.mkdir(parents=True, exist_ok=True)
    with open(directory / ".store.lock", "w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        yield


def read_net(name: str, root: Path | None = None) -> dict[date, float]:
    """{day: net P&L} of one variant (at the slippage `slipped` is reading at)."""
    path = read_path(result_path(name, root))
    if not path.exists():
        return {}
    with path.open() as f:
        return {date.fromisoformat(r["day"]): float(r["net"]) for r in csv.DictReader(f)}


def result_days(name: str, root: Path | None = None) -> set[date]:
    return set(read_net(name, root))


def append_result(name: str, row: dict, root: Path | None = None) -> bool:
    """Append one day's result for a variant. Returns False (and writes nothing) when the day is
    already there: a stored day is never rewritten."""
    path = result_path(name, root)
    path.parent.mkdir(parents=True, exist_ok=True)
    with _write_lock(root), slipped(0.0):
        if str(row["day"]) in {d.isoformat() for d in read_net(name, root)}:
            return False
        new = not path.exists()
        with path.open("a", newline="") as f:
            w = csv.writer(f)
            if new:
                w.writerow(RESULT_COLUMNS)
            w.writerow([row.get(c, "") for c in RESULT_COLUMNS])
    return True


@dataclass(frozen=True)
class Matrix:
    days: list[date]  # ascending
    names: list[str]
    values: np.ndarray  # len(days) x len(names), net P&L


def load_matrix(names: list[str], root: Path | None = None, through: date | None = None) -> Matrix:
    """Net P&L by day and variant: the days every variant has, Monday to Friday only (the research
    dropped a day a variant lacks and every weekend session, e.g. the Budget Sunday)."""
    series = [read_net(n, root) for n in names]
    common = set(series[0]) if series else set()
    for s in series[1:]:
        common &= set(s)
    days = sorted(d for d in common if d.weekday() < 5 and (through is None or d <= through))
    values = np.array([[s[d] for s in series] for d in days], dtype=float).reshape(
        len(days), len(names)
    )
    return Matrix(days, list(names), values)


def read_days(root: Path | None = None, basis: str = "weekdays") -> dict[date, dict[str, str]]:
    """The stored day attributes. The file keeps calendar-day DTE labels as they were written;
    they are returned on the weekday basis (BL-109), so every reader agrees with the live label.
    `basis="calendar"` returns them as written: only for checking an entry recorded before the
    change, and for research that must stay on the calendar-day definition."""
    path = days_path(root)
    if not path.exists():
        return {}
    out: dict[date, dict[str, str]] = {}
    with path.open() as f:
        for r in csv.DictReader(f):
            day = date.fromisoformat(r["day"])
            for key in ("dte_n", "dte_s") if basis == "weekdays" else ():
                if key in r:
                    r[key] = from_calendar_label(r[key], day)
            out[day] = r
    return out


def append_day(row: dict, root: Path | None = None) -> bool:
    path = days_path(root)
    path.parent.mkdir(parents=True, exist_ok=True)
    with _write_lock(root):
        if date.fromisoformat(str(row["day"])) in read_days(root):
            return False
        new = not path.exists()
        with path.open("a", newline="") as f:
            w = csv.writer(f)
            if new:
                w.writerow(DAY_COLUMNS)
            w.writerow([row.get(c, "") for c in DAY_COLUMNS])
    return True
