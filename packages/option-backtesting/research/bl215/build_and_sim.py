"""BL-215 Phase 2b: every distinct setting `select_all.py` kept, built at all 25 entry times and simulated over
every stored NIFTY session from 2021-11-01, into a SEPARATE rotation root (`_bl215`: symlinks to the lake,
quality and catalog, a copy of `_bl214`'s Core-NIFTY results and days, and its own `track_t1/results/`).
Names are `N_<base>-t1s<id>_<HHMM>` so the picker reads them as a track's variants (the T1 convention); the strategy
files are written under results/generated/rotation_t1/ and `variants.TRACK_DIRS['t1']` is pointed there, so the
frozen `strategies/rotation_t1/` is never touched. Written as BL-214's backfill does (same rows, same slippage copy);
a stored day is never rewritten, so the run is resumable.

    TRADING_DATA_ROOT=/Volumes/TradingData/_bl215 uv run python research/bl215/build_and_sim.py \
        --selected research/bl215/selected.json [--workers 5] [--plan]
"""

from __future__ import annotations

import argparse
import csv
import json
import os
import sys
import time
from datetime import date
from multiprocessing import Pool
from pathlib import Path

import yaml

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "bl104"))
import grid  # noqa: E402

from option_backtesting.data.reference.loader import MissingReferenceData, default_reference_data  # noqa: E402
from option_backtesting.legwise.engine import simulate_day  # noqa: E402
from option_backtesting.legwise.market import load_day  # noqa: E402
from option_backtesting.legwise.schema import LegwiseStrategy, load_legwise  # noqa: E402
from option_backtesting.rotation import attrs, slip_store, store, variants  # noqa: E402
from option_backtesting.rotation.lists import SIZING_DATE  # noqa: E402
from option_backtesting.rotation.score import dte_label  # noqa: E402

ROOT = Path(os.environ.get("TRADING_DATA_ROOT", ""))
GEN = HERE / "results" / "generated" / "rotation_t1"
ALL25 = [f"{h:02d}:{m:02d}" for h in range(9, 16) for m in (2, 17, 32, 47) if (9, 17) <= (h, m) <= (15, 17)]
START = date(2021, 11, 1)
SRC_ROOT = Path("/Volumes/TradingData/_bl214")


class OldDays:
    """As BL-214's: a contract expiring before `lot_sizes.csv` begins falls back to the sizing date's lot."""

    def __init__(self, ref, sizing: date):
        self._ref, self._sizing = ref, sizing

    def __getattr__(self, name):
        return getattr(self._ref, name)

    def lot_size(self, underlying: str, expiry: date) -> int:
        try:
            return self._ref.lot_size(underlying, expiry)
        except MissingReferenceData:
            return self._ref.lot_size(underlying, self._sizing)


def patch_loader() -> None:
    from option_backtesting.data.reference import loader
    from option_backtesting.rotation import base as base_mod

    original = loader.default_reference_data
    if getattr(original, "_bl215", False):
        return
    sizing = date.fromisoformat(SIZING_DATE)

    def patched():
        return OldDays(original(), sizing)

    patched._bl215 = True  # type: ignore[attr-defined]
    loader.default_reference_data = patched
    base_mod.default_reference_data = patched


def sig(w: dict) -> str:
    return json.dumps([w["fam"], w["index"], w["params"]], sort_keys=True, default=list)


def base_token(w: dict) -> str:
    if w["fam"] == "W":
        return "wide" if w["family"] == "N_wide" else f"p{int(round(float(w['params']['strike'])))}"
    if w["fam"] == "D":
        return "ditm1" if w["family"].endswith("ditm1") else "dir"
    return "buy"


def settings(selected: dict) -> dict[str, dict]:
    """sig -> {id, base, fam, index, params}; ids in order of first appearance, from 101."""
    out: dict[str, dict] = {}
    for key in sorted(selected, key=lambda k: (selected[k]["length"], selected[k]["fold"])):
        for w in selected[key]["settings"]:
            s = sig(w)
            if s not in out:
                out[s] = {"id": 101 + len(out), "base": base_token(w), "fam": w["fam"], "index": w["index"],
                          "params": w["params"], "family": w["family"]}
    return out


def build_all(sett: dict[str, dict]) -> dict[str, LegwiseStrategy]:
    GEN.mkdir(parents=True, exist_ok=True)
    specs: dict[str, LegwiseStrategy] = {}
    for s in sett.values():
        params = {k: tuple(v) if isinstance(v, list) else v for k, v in s["params"].items()}
        for slot in ALL25:
            name = f"{s['index']}_{s['base']}-t1s{s['id']}_{slot.replace(':', '')}"
            try:
                st = grid.build(grid.Cell(s["fam"], s["index"], slot, params))
            except (ValueError, FileNotFoundError):
                continue  # e.g. Buy has no 15:17 file, or a range ending after the exit
            st = st.model_copy(deep=True)
            st.id = name
            path = GEN / f"{name}.yaml"
            if not path.exists():
                path.write_text(yaml.safe_dump({"strategy": st.model_dump(mode="json", exclude_none=True)},
                                               sort_keys=False, allow_unicode=True))
            assert load_legwise(path).model_dump() == st.model_dump(), path
            specs[name] = st
    return specs


_SPECS: dict[str, LegwiseStrategy] = {}


def init(specs: dict[str, LegwiseStrategy]) -> None:
    global _SPECS
    _SPECS = specs
    variants.TRACK_DIRS["t1"] = GEN
    patch_loader()


def one_day(day_s: str) -> dict:
    day = date.fromisoformat(day_s)
    t0 = time.time()
    out = {"day": day_s, "written": 0, "already": 0, "errors": [], "seconds": 0.0}
    try:
        loaded = load_day(ROOT, "NIFTY", day)
    except FileNotFoundError as error:
        out["errors"].append(f"load: {error}")
        return out
    sizing = date.fromisoformat(SIZING_DATE)
    reference = OldDays(default_reference_data(), sizing)
    todo = []
    for name, spec in _SPECS.items():
        if day in store.result_days(name, ROOT):
            out["already"] += 1
            todo.append(name)
            continue
        try:
            r = simulate_day(spec, loaded, reference, sizing)
        except Exception as error:  # noqa: BLE001 - counted, not hidden
            out["errors"].append(f"{name}: {type(error).__name__}: {error}")
            continue
        store.append_result(name, {"day": day_s, "net": round(r.gross - r.costs, 2), "gross": round(r.gross, 2),
                                   "costs": round(r.costs, 2), "worst_mtm": round(r.worst_mtm, 2),
                                   "stopped_by": r.stopped_by or "", "n_trades": len(r.trades)}, ROOT)
        out["written"] += 1
        todo.append(name)
    try:
        slip_store.fill(ROOT, days=[day], names=todo, log=lambda _m: None)
    except Exception as error:  # noqa: BLE001
        out["errors"].append(f"slippage copy: {type(error).__name__}: {error}")
    out["seconds"] = round(time.time() - t0, 1)
    return out


def days_to_run(start: date = START) -> list[str]:
    with (ROOT / "rotation" / "days.csv").open(newline="") as h:
        ds = sorted({r["day"] for r in csv.DictReader(h) if date.fromisoformat(r["day"]) >= start
                     and date.fromisoformat(r["day"]).weekday() < 5})
    return ds


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--selected", type=Path, required=True)
    ap.add_argument("--workers", type=int, default=5)
    ap.add_argument("--plan", action="store_true")
    ap.add_argument("--limit-days", type=int, default=0)
    ap.add_argument("--from", dest="start", default=START.isoformat(), help="first session to simulate (smoke runs)")
    a = ap.parse_args()
    if not ROOT.name.startswith("_bl215"):
        print(f"refusing: TRADING_DATA_ROOT must be the _bl215 root, got {ROOT}", file=sys.stderr)
        return 2
    selected = json.loads(a.selected.read_text())
    sett = settings(selected)
    specs = build_all(sett)
    days = days_to_run(date.fromisoformat(a.start))
    if a.limit_days:
        days = days[: a.limit_days]
    print(f"{len(sett)} distinct settings -> {len(specs)} variants; {len(days)} days", flush=True)
    (HERE / "results").mkdir(exist_ok=True)
    (HERE / "results" / "settings_ids.json").write_text(json.dumps(sett, indent=1, default=list))
    if a.plan:
        return 0
    failed, done, t0 = 0, 0, time.time()
    with Pool(a.workers, initializer=init, initargs=(specs,)) as pool:
        for r in pool.imap(one_day, days):
            done += 1
            failed += bool(r["errors"])
            print(f"{r['day']}: {r['written']} written, {r['already']} already, {len(r['errors'])} errors, "
                  f"{r['seconds']}s | {done}/{len(days)} elapsed {time.time() - t0:,.0f}s", flush=True)
            for e in r["errors"][:3]:
                print("   ", e, flush=True)
    print(f"finished: {done} days, {failed} with errors, {time.time() - t0:,.0f}s")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
