"""Per-variant daily results and per-day attributes, as plain files under
TRADING_DATA_ROOT/rotation/ (not the catalog: it allows one writer, and `obt daily` must not wait
on this job).

    rotation/results/<variant>.csv   day,net,gross,costs,worst_mtm,stopped_by,n_trades
    rotation/days.csv                day,weekday,vix_open,vix_band,dte_n,dte_s
    rotation/journal.jsonl           the hash chain (journal.py)
"""

from __future__ import annotations

import csv
from dataclasses import dataclass
from datetime import date
from pathlib import Path

import numpy as np

from ..fyers.daily import data_dir

RESULT_COLUMNS = ["day", "net", "gross", "costs", "worst_mtm", "stopped_by", "n_trades"]
DAY_COLUMNS = ["day", "weekday", "vix_open", "vix_band", "dte_n", "dte_s"]


def rotation_dir(root: Path | None = None) -> Path:
    return (root or data_dir()) / "rotation"


def results_dir(root: Path | None = None) -> Path:
    return rotation_dir(root) / "results"


def days_path(root: Path | None = None) -> Path:
    return rotation_dir(root) / "days.csv"


def journal_path(root: Path | None = None) -> Path:
    return rotation_dir(root) / "journal.jsonl"


def read_net(name: str, root: Path | None = None) -> dict[date, float]:
    """{day: net P&L} of one variant."""
    path = results_dir(root) / f"{name}.csv"
    if not path.exists():
        return {}
    with path.open() as f:
        return {date.fromisoformat(r["day"]): float(r["net"]) for r in csv.DictReader(f)}


def result_days(name: str, root: Path | None = None) -> set[date]:
    return set(read_net(name, root))


def append_result(name: str, row: dict, root: Path | None = None) -> bool:
    """Append one day's result for a variant. Returns False (and writes nothing) when the day is
    already there: a stored day is never rewritten."""
    path = results_dir(root) / f"{name}.csv"
    path.parent.mkdir(parents=True, exist_ok=True)
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


def read_days(root: Path | None = None) -> dict[date, dict[str, str]]:
    path = days_path(root)
    if not path.exists():
        return {}
    with path.open() as f:
        return {date.fromisoformat(r["day"]): r for r in csv.DictReader(f)}


def append_day(row: dict, root: Path | None = None) -> bool:
    path = days_path(root)
    path.parent.mkdir(parents=True, exist_ok=True)
    if date.fromisoformat(str(row["day"])) in read_days(root):
        return False
    new = not path.exists()
    with path.open("a", newline="") as f:
        w = csv.writer(f)
        if new:
            w.writerow(DAY_COLUMNS)
        w.writerow([row.get(c, "") for c in DAY_COLUMNS])
    return True
