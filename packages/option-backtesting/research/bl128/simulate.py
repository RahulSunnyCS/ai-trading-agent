"""BL-128 Phase 1: simulate the 450 new cell-slot strategies (and Core S_p250_0917 / S_p320_0917 for
the parity check) over every day Core's `S_p250` results exist, with the code path
`obt rotation update` uses (`legwise.engine.simulate_day` on `legwise.market.load_day`, the same
reference data and sizing date, the same row layout). Reads the lake and the live results; writes
only under results/.

    TRADING_DATA_ROOT=/Volumes/TradingData uv run python research/bl128/simulate.py [--workers 6]

Per-day output (resumable): results/sim/<day>.json = {variant: stored-row}. `assemble` then writes
results/rotation/results/<variant>.csv for the new variants, in the live store's column layout.
"""

from __future__ import annotations

import argparse
import csv
import json
import time
from concurrent.futures import ProcessPoolExecutor
from datetime import date
from pathlib import Path

from common import CORE_BASE, CORE_DIR, PARITY, RESULTS, UNDERLYING, VARIANTS, core_slots, new_names

from option_backtesting.data.reference.loader import default_reference_data
from option_backtesting.fyers.daily import data_dir
from option_backtesting.legwise.engine import simulate_day
from option_backtesting.legwise.market import load_day
from option_backtesting.legwise.schema import load_legwise
from option_backtesting.rotation import store
from option_backtesting.rotation.attrs import excluded_map
from option_backtesting.rotation.lists import SIZING_DATE

SIM = RESULTS / "sim"
SIM_PARITY = RESULTS / "sim_parity"
_STRATS: dict = {}


def path_of(name: str) -> Path:
    return CORE_DIR / f"{name}.yaml" if name in PARITY else VARIANTS / f"{name}.yaml"


def scored_days(root: Path) -> list[date]:
    """Every day all 25 Core S_p250 variants have a stored result: the days to simulate."""
    sets = [store.result_days(f"{CORE_BASE}_{s}", root) for s in core_slots()]
    common = set.intersection(*sets)
    union = set.union(*sets)
    assert common == union, f"Core S_p250 variants disagree on days: {len(union - common)}"
    return sorted(common)


def one_day(args: tuple[str, str, bool]) -> tuple[str, int]:
    root, day_text, parity_only = args
    day = date.fromisoformat(day_text)
    out_path = (SIM_PARITY if parity_only else SIM) / f"{day_text}.json"
    if out_path.exists():
        return day_text, 0
    root_p = Path(root)
    data = load_day(root_p, UNDERLYING, day)
    reference = default_reference_data()
    sizing = date.fromisoformat(SIZING_DATE)
    rows = {}
    for name in PARITY if parity_only else [*PARITY, *new_names()]:
        if name not in _STRATS:
            _STRATS[name] = load_legwise(path_of(name))
        r = simulate_day(_STRATS[name], data, reference, sizing)
        rows[name] = {
            "day": day_text,
            "net": round(r.gross - r.costs, 2),
            "gross": round(r.gross, 2),
            "costs": round(r.costs, 2),
            "worst_mtm": round(r.worst_mtm, 2),
            "stopped_by": r.stopped_by or "",
            "n_trades": len(r.trades),
        }
    tmp = out_path.with_suffix(".tmp")
    tmp.write_text(json.dumps(rows))
    tmp.rename(out_path)
    return day_text, len(rows)


def assemble(days: list[date], parity_only: bool = False) -> None:
    out_dir = RESULTS / "rotation" / "results"
    out_dir.mkdir(parents=True, exist_ok=True)
    names = PARITY if parity_only else [*PARITY, *new_names()]
    per_name: dict[str, list[dict]] = {n: [] for n in names}
    for d in days:
        rows = json.loads(
            ((SIM_PARITY if parity_only else SIM) / f"{d.isoformat()}.json").read_text()
        )
        for n, r in rows.items():
            per_name[n].append(r)
    for n, rows in per_name.items():
        folder = out_dir if n not in PARITY else RESULTS / "parity_core"
        folder.mkdir(parents=True, exist_ok=True)
        with (folder / f"{n}.csv").open("w", newline="") as f:
            w = csv.writer(f)
            w.writerow(store.RESULT_COLUMNS)
            for r in rows:
                w.writerow([r.get(c, "") for c in store.RESULT_COLUMNS])


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--workers", type=int, default=6)
    ap.add_argument("--parity-only", action="store_true", help="only the two Core parity files")
    ap.add_argument("--limit", type=int, default=0, help="first N days only (timing)")
    args = ap.parse_args()
    root = data_dir()
    SIM.mkdir(parents=True, exist_ok=True)
    SIM_PARITY.mkdir(parents=True, exist_ok=True)
    days = scored_days(root)
    excl = excluded_map(root)
    bad = [d for d in days if d in excl[UNDERLYING]]
    assert not bad, f"scored days that data_quality excludes for SENSEX: {bad[:3]}"
    print(f"{len(days)} days {days[0]} -> {days[-1]}; root {root}", flush=True)
    todo = days[: args.limit] if args.limit else days
    t0 = time.time()
    done = 0
    with ProcessPoolExecutor(args.workers) as pool:
        for day_text, _n in pool.map(
            one_day, [(str(root), d.isoformat(), args.parity_only) for d in todo]
        ):
            done += 1
            if done % 10 == 0 or done == len(todo):
                print(f"{done}/{len(todo)} {day_text} elapsed {time.time() - t0:.0f}s", flush=True)
    if not args.limit:
        assemble(days, args.parity_only)
        print("assembled", flush=True)


if __name__ == "__main__":
    main()
