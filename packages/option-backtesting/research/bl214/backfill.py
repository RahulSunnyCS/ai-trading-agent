"""BL-214 Phase 2-3: the NIFTY variants (Core-298's 149 and the T1 track's NIFTY extras) run over lake
days before the rotation store begins, into a SEPARATE rotation root (never the live store).

    TRADING_DATA_ROOT=/Volumes/TradingData/_bl214 uv run python research/bl214/backfill.py \
        --from 2021-08-02 --to 2024-10-08 [--workers N] [--limit-days K]

`_bl214` holds symlinks to the lake, the data-quality snapshot and the catalog, and its own
`rotation/`. Written as `update_day` does it (same rows, same files, same slippage copy), except that
only NIFTY is loaded: SENSEX has no usable option days before 2025, so `dte_s` is stored `unknown`
and the expiry-only rule (BL-122) is vacuous, as it is for a NIFTY-only universe. A stored day is
never rewritten, so the run is resumable. Reads the lake, writes only under the root given."""

from __future__ import annotations

import argparse
import os
import sys
import time
from datetime import date, timedelta
from multiprocessing import Pool
from pathlib import Path

from trading_data import lake, quality

from option_backtesting.data.reference.loader import MissingReferenceData, default_reference_data
from option_backtesting.legwise.engine import simulate_day
from option_backtesting.legwise.market import load_day
from option_backtesting.legwise.schema import load_legwise
from option_backtesting.rotation import attrs, slip_store, store
from option_backtesting.rotation.lists import SIZING_DATE
from option_backtesting.rotation.score import dte_label
from option_backtesting.rotation.variants import strategy_path, track_names, variant_names

ROOT = Path(os.environ.get("TRADING_DATA_ROOT", ""))
LAKE_DAYS = 1000


class OldDays:
    """The reference data with one addition for days before `lot_sizes.csv` begins (2024-10): a contract
    expiring earlier has no lot-size row, and the engine looks that row up for every contract (a check
    against the symbol master, which has no entry before the Fyers collector) even under `lot_sizing:
    current`, whose lot is the sizing date's. The lookup falls back to the sizing date's lot, so the sizing
    used is unchanged; strategies with `lot_sizing: historical` are refused (none is in these folders).
    Everything else is the packaged reference data as it is."""

    def __init__(self, ref, sizing: date):
        self._ref, self._sizing = ref, sizing

    def __getattr__(self, name):
        return getattr(self._ref, name)

    def lot_size(self, underlying: str, expiry: date) -> int:
        try:
            return self._ref.lot_size(underlying, expiry)
        except MissingReferenceData:
            return self._ref.lot_size(underlying, self._sizing)


def _patch_loader() -> None:
    """`slip_store` builds its own reference data inside `slipped_row`; give it the same fallback."""
    from option_backtesting.data.reference import loader

    original = loader.default_reference_data
    sizing = date.fromisoformat(SIZING_DATE)
    if getattr(original, "_bl214", False):
        return

    def patched():
        return OldDays(original(), sizing)

    patched._bl214 = True  # type: ignore[attr-defined]
    loader.default_reference_data = patched
    from option_backtesting.rotation import base as base_mod

    base_mod.default_reference_data = patched  # base.py bound the name at import


def names() -> list[str]:
    return [n for n in [*variant_names(), *track_names("t1")] if n.startswith("N_")]


def candidate_days(root: Path, start: date, end: date) -> tuple[list[date], dict[str, int]]:
    """Weekdays in [start, end] with NIFTY option, NIFTY index and India VIX bars that
    data_quality does not exclude; the rest are counted by reason."""
    excluded = quality.excluded_days(root, "option", "NIFTY") or {}
    days: list[date] = []
    why = {"weekend": 0, "no option file": 0, "no index file": 0, "no vix file": 0, "excluded": 0}
    d = start
    while d <= end:
        if d.weekday() >= 5:
            why["weekend"] += 0  # not counted: weekends have no session
        elif not lake.bars_1m_path(root, "option", "NIFTY", d).exists():
            why["no option file"] += 1  # a holiday has none
        elif not lake.bars_1m_path(root, "index", "NIFTY", d).exists():
            why["no index file"] += 1
        elif not lake.bars_1m_path(root, "index", attrs.VIX_NAME, d).exists():
            why["no vix file"] += 1
        elif d in excluded:
            why["excluded"] += 1
        else:
            days.append(d)
        d += timedelta(days=1)
    return days, why


def one_day(args: tuple[str, str]) -> dict:
    root_s, day_s = args
    root, day = Path(root_s), date.fromisoformat(day_s)
    _patch_loader()
    t0 = time.time()
    out = {"day": day_s, "written": 0, "already": 0, "errors": [], "seconds": 0.0}
    try:
        loaded = {"NIFTY": load_day(root, "NIFTY", day)}
    except FileNotFoundError as error:
        out["errors"].append(f"load: {error}")
        return out
    sizing = date.fromisoformat(SIZING_DATE)
    reference = OldDays(default_reference_data(), sizing)
    todo = names()
    for name in todo:
        if day in store.result_days(name, root):
            out["already"] += 1
            continue
        try:
            spec = load_legwise(strategy_path(name))
            if spec.execution.lot_sizing == "historical":
                raise MissingReferenceData(
                    f"{name}: historical lot sizing needs the lot-size history"
                )
            r = simulate_day(spec, loaded["NIFTY"], reference, sizing)
        except MissingReferenceData as error:
            out["errors"].append(f"{name}: reference: {error}")
            continue
        except Exception as error:  # noqa: BLE001 - a variant that cannot run is counted, not hidden
            out["errors"].append(f"{name}: {type(error).__name__}: {error}")
            continue
        store.append_result(
            name,
            {
                "day": day_s,
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
    row = attrs.day_attributes(root, day)
    row["dte_s"] = dte_label(None)  # no SENSEX universe here: BL-214 Phase 0
    store.append_day(row, root)
    try:
        slip_store.fill(root, days=[day], names=todo, log=lambda _m: None)
    except Exception as error:  # noqa: BLE001
        out["errors"].append(f"slippage copy: {type(error).__name__}: {error}")
    out["seconds"] = round(time.time() - t0, 1)
    return out


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--from", dest="start", required=True)
    p.add_argument("--to", dest="end", required=True)
    p.add_argument("--workers", type=int, default=1)
    p.add_argument("--limit-days", type=int, default=0)
    p.add_argument("--plan", action="store_true", help="list the days and counts, run nothing")
    a = p.parse_args()
    root = ROOT
    if root.name != "_bl214":
        print(f"refusing: TRADING_DATA_ROOT must be the _bl214 root, got {root}", file=sys.stderr)
        return 2
    days, why = candidate_days(root, date.fromisoformat(a.start), date.fromisoformat(a.end))
    todo = days[: a.limit_days] if a.limit_days else days
    print(f"{len(days)} days to run ({len(names())} variants each); left out: {why}", flush=True)
    if a.plan:
        return 0
    failed = 0
    t0 = time.time()
    jobs = [(str(root), d.isoformat()) for d in todo]
    done = 0
    with Pool(a.workers) as pool:
        for r in pool.imap(one_day, jobs):
            done += 1
            failed += bool(r["errors"])
            print(
                f"{r['day']}: {r['written']} written, {r['already']} already, "
                f"{len(r['errors'])} errors, {r['seconds']}s | {done}/{len(jobs)} "
                f"elapsed {time.time() - t0:,.0f}s",
                flush=True,
            )
            for e in r["errors"][:3]:
                print(f"   {e}", flush=True)
    print(f"finished: {done} days, {failed} with errors, {time.time() - t0:,.0f}s")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
