"""The owner's fixed base reference (BL-058 amendment 2026-10-10).

The base is traded every day with no ranking: 2 x NIFTY Widesl OTM1 at 09:17 (the rotation variant
`N_wide_0917`) + 1 x NIFTY Dir ATM at 09:24 (`strategies/rotation_base/N_dir_atm_0924.yaml`), each
strategy at LOTS_PER lots. Its results are kept apart from the 298 variants (`rotation/base/`), so
the universe, its fingerprint and the morning pick never see them.

Per lot-day is the unit every comparison with the base uses: a list holds 6 lots, or 8 with the Buy
add-on, so totals would reward holding more. The base's per lot-day is (2 W + 1 D) / 3 for one-lot
results W and D; holding each strategy at 2 lots changes nothing there.
"""

from __future__ import annotations

import csv
from collections.abc import Callable
from datetime import date
from pathlib import Path

from ..data.reference.loader import default_reference_data
from ..fyers.daily import data_dir
from ..legwise.engine import simulate_day
from ..legwise.market import load_day
from ..legwise.schema import load_legwise
from . import store
from .lists import SIZING_DATE
from .variants import STRATEGIES_DIR

BASE_DIR = STRATEGIES_DIR.parent / "rotation_base"
DIR_NAME = "N_dir_atm_0924"
WIDE_NAME = "N_wide_0917"  # a rotation variant: its results are already stored nightly
N_WIDE, N_DIR = 2, 1
BASE_LOTS = N_WIDE + N_DIR  # one-lot strategies in the base


def base_dir(root: Path | None = None) -> Path:
    return store.rotation_dir(root) / "base"


def _path(root: Path | None) -> Path:
    return base_dir(root) / f"{DIR_NAME}.csv"


def read_column(name_or_path: str | Path, column: str = "gross", root: Path | None = None):
    """{day: value} of one stored column of a rotation variant (`name`) or the base file."""
    path = (
        Path(name_or_path)
        if isinstance(name_or_path, Path)
        else store.results_dir(root) / f"{name_or_path}.csv"
    )
    if not path.exists():
        return {}
    with path.open() as f:
        return {date.fromisoformat(r["day"]): float(r[column]) for r in csv.DictReader(f)}


def dir_days(root: Path | None = None) -> set[date]:
    return set(read_column(_path(root), "gross"))


def append_dir_result(row: dict, root: Path | None = None) -> bool:
    """One day of the Dir ATM 09:24 leg; a stored day is never rewritten (as for the variants)."""
    path = _path(root)
    path.parent.mkdir(parents=True, exist_ok=True)
    with store._write_lock(root):  # noqa: SLF001 - the one lock every rotation write shares
        if date.fromisoformat(str(row["day"])) in dir_days(root):
            return False
        new = not path.exists()
        with path.open("a", newline="") as f:
            w = csv.writer(f)
            if new:
                w.writerow(store.RESULT_COLUMNS)
            w.writerow([row.get(c, "") for c in store.RESULT_COLUMNS])
    return True


def base_days(root: Path | None = None) -> list[date]:
    """Weekdays on which both legs have a result: the days the base exists on."""
    both = set(read_column(WIDE_NAME, "gross", root)) & dir_days(root)
    return sorted(d for d in both if d.weekday() < 5)


def base_per_lot(root: Path | None = None, column: str = "gross") -> dict[date, float]:
    """{day: the base's P&L per lot} = (2 Widesl + 1 Dir) / 3, from one-lot results."""
    wide = read_column(WIDE_NAME, column, root)
    dirn = read_column(_path(root), column, root)
    return {
        d: (N_WIDE * wide[d] + N_DIR * dirn[d]) / BASE_LOTS
        for d in sorted(set(wide) & set(dirn))
        if d.weekday() < 5
    }


def score_days(
    days: list[date],
    root: Path | None = None,
    log: Callable[[str], None] = print,
) -> dict:
    """Simulate the Dir ATM 09:24 leg on each given day not yet stored. Only NIFTY is loaded: the
    base has no SENSEX leg. A day the lake cannot serve is skipped and reported, not zero-filled."""
    root = root or data_dir()
    out: dict = {"written": 0, "already": 0, "skipped": []}
    strategy = load_legwise(BASE_DIR / f"{DIR_NAME}.yaml")
    reference = default_reference_data()
    sizing = date.fromisoformat(SIZING_DATE)
    have = dir_days(root)
    for day in days:
        if day in have:
            out["already"] += 1
            continue
        try:
            loaded = load_day(root, "NIFTY", day)
            r = simulate_day(strategy, loaded, reference, sizing)
        except Exception as error:  # noqa: BLE001 - one bad day must not stop the rest
            out["skipped"].append(f"{day}: {type(error).__name__}: {error}")
            continue
        append_dir_result(
            {
                "day": day.isoformat(),
                "net": round(r.gross - r.costs, 2),
                "gross": round(r.gross, 2),
                "costs": round(r.costs, 2),
                "worst_mtm": round(r.worst_mtm, 2),
                "stopped_by": r.stopped_by or "",
                "n_trades": len(r.trades),
            },
            root,
        )
        out["written"] += 1
    first = f"; first: {out['skipped'][0]}" if out["skipped"] else ""
    log(
        f"base Dir ATM 09:24: {out['written']} written, {out['already']} already there, "
        f"{len(out['skipped'])} skipped{first}"
    )
    return out


def pending_days(root: Path | None = None) -> list[date]:
    """Days the Widesl leg has but the Dir leg lacks: what a nightly run or a backfill fills."""
    root = root or data_dir()
    return sorted(
        d for d in set(read_column(WIDE_NAME, "gross", root)) - dir_days(root) if d.weekday() < 5
    )
