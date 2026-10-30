"""The stored results again after slippage (owner, 2026-10-30): beside every results file (Core-298,
a parallel track's, the fixed base's Dir leg) a copy, `store.slip_path`, holding each stored day
as it comes out with `pct` % slippage on every entry and exit (a sell filled lower, a buy back
higher). The dashboard's Rotation pages read it while their Slippage switch is on
(`store.slipped`); the ranking, the journal and the stored results never do.

A copied row is the stored row plus what slippage changes: each pick simulated again on the day's
bars with and without it, and the difference added to the stored net, gross and worst MTM, so a
day stored under an older engine moves only by the slippage. The stop and trade count are the
slipped run's own (a fill further away moves the stop with it). Like the stored results, a copied
day is never rewritten. `rotation update` (and the base's scoring) fill the copy for the day they
store; `obt rotation slippage-fill` fills every day not there yet.
"""

from __future__ import annotations

import csv
from collections.abc import Callable, Iterable
from datetime import date
from pathlib import Path

from ..fyers.daily import data_dir
from . import store

SLIP_PCT = 0.5
#: days simulated between writes (each write appends once to every file)
CHUNK_DAYS = 25


def result_files(root: Path) -> list[Path]:
    """Every stored results file: Core-298's, each parallel track's and the base's Dir leg."""
    from . import base
    from .variants import TRACK_DIRS

    folders = [store.results_dir(root), *(store.track_dir(t, root) / "results" for t in TRACK_DIRS)]
    folders.append(base.base_dir(root))
    return [p for d in folders if d.exists() for p in sorted(d.glob("*.csv"))]


def _rows(path: Path) -> dict[str, dict]:
    if not path.exists():
        return {}
    with path.open(newline="") as f:
        return {r["day"]: r for r in csv.DictReader(f) if r.get("day")}


def _spec_and_underlying(name: str):
    from ..legwise.schema import load_legwise
    from . import base
    from .portfolio import strategy_file
    from .variants import underlying_of

    underlying = base.UNDERLYING if name == base.DIR_NAME else underlying_of(name)
    return load_legwise(strategy_file(name)), underlying


def slipped_row(row: dict, spec, day_data, pct: float) -> dict:
    """The stored `row` after `pct` % slippage, from runs on the day's loaded bars."""
    from ..data.reference.loader import default_reference_data
    from ..legwise.engine import simulate_day
    from .lists import SIZING_DATE

    reference, sizing = default_reference_data(), date.fromisoformat(SIZING_DATE)
    slip = spec.model_copy(
        update={"execution": spec.execution.model_copy(update={"slippage_pct": pct})}
    )
    a = simulate_day(spec, day_data, reference, sizing)
    b = simulate_day(slip, day_data, reference, sizing)

    def moved(column: str, delta: float) -> float:
        return round(float(row[column]) + delta, 2)

    return {
        "day": row["day"],
        "net": moved("net", (b.gross - b.costs) - (a.gross - a.costs)),
        "gross": moved("gross", b.gross - a.gross),
        "costs": round(b.costs, 2),
        "worst_mtm": moved("worst_mtm", b.worst_mtm - a.worst_mtm)
        if row.get("worst_mtm") not in (None, "")
        else "",
        "stopped_by": b.stopped_by or "",
        "n_trades": len(b.trades),
    }


def _append(path: Path, rows: list[dict], root: Path) -> int:
    """Append the rows not in the copy yet (never rewriting one), in day order."""
    target = store.slip_path(path, SLIP_PCT)
    target.parent.mkdir(parents=True, exist_ok=True)
    with store._write_lock(root):  # noqa: SLF001 - the one lock every rotation write shares
        have = _rows(target)
        new = [r for r in sorted(rows, key=lambda r: r["day"]) if r["day"] not in have]
        if not new:
            return 0
        fresh = not target.exists()
        with target.open("a", newline="") as f:
            w = csv.writer(f)
            if fresh:
                w.writerow(store.RESULT_COLUMNS)
            for r in new:
                w.writerow([r.get(c, "") for c in store.RESULT_COLUMNS])
    return len(new)


def fill(
    root: Path | None = None,
    days: Iterable[date] | None = None,
    names: Iterable[str] | None = None,
    log: Callable[[str], None] = print,
) -> dict:
    """Copy every stored day missing from the slippage copies (only `days` / `names` when given).
    One day's bars are loaded once for all its files. Returns {'written', 'files', 'skipped'};
    a file whose strategy can no longer be read, or a day whose bars are gone, is skipped and
    named, never written as zero."""
    from ..legwise.market import load_day

    root = root or data_dir()
    want_days = {d.isoformat() for d in days} if days is not None else None
    want_names = set(names) if names is not None else None
    todo: dict[str, list[tuple[Path, dict]]] = {}
    out: dict = {"written": 0, "files": 0, "skipped": []}
    touched: set[Path] = set()
    for path in result_files(root):
        if want_names is not None and path.stem not in want_names:
            continue
        have = _rows(store.slip_path(path, SLIP_PCT))
        for day, row in _rows(path).items():
            if day not in have and (want_days is None or day in want_days):
                todo.setdefault(day, []).append((path, row))
    specs: dict[str, tuple] = {}
    pending: dict[Path, list[dict]] = {}

    def flush() -> None:  # one append per file per chunk of days: the disk is slow on small writes
        for path, rows in pending.items():
            written = _append(path, rows, root)
            out["written"] += written
            if written:
                touched.add(path)
        pending.clear()

    for i, day in enumerate(sorted(todo), 1):
        loaded: dict = {}
        for path, row in todo[day]:
            name = path.stem
            try:
                if name not in specs:
                    specs[name] = _spec_and_underlying(name)
                spec, underlying = specs[name]
                if underlying not in loaded:
                    try:
                        loaded[underlying] = load_day(root, underlying, date.fromisoformat(day))
                    except Exception as error:  # noqa: BLE001 - remembered: tried once a day
                        loaded[underlying] = error
                if isinstance(loaded[underlying], Exception):
                    raise loaded[underlying]
                pending.setdefault(path, []).append(
                    slipped_row(row, spec, loaded[underlying], SLIP_PCT)
                )
            except Exception as error:  # noqa: BLE001 - one bad file or day must not stop the rest
                out["skipped"].append(f"{name} {day}: {type(error).__name__}: {error}")
        if i % CHUNK_DAYS == 0:
            flush()
            log(f"  {day}: {i} of {len(todo)} days")
    flush()
    out["files"] = len(touched)
    log(
        f"slippage {SLIP_PCT:g}%: {out['written']} rows copied over {len(todo)} days, "
        f"{len(out['skipped'])} skipped"
    )
    return out
