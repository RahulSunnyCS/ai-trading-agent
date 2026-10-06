"""Round 3: do the best configs survive being nudged?

A search ranks thousands of configs on one sample. The winners are partly lucky, and luck does not
survive small changes: move `coverage_floor` by 0.03, start a month later, shift which Friday the
portfolio rebalances on, and a lucky config's result moves a lot, while a config sitting on a real
plateau barely changes. This module takes the best candidates from a finished search, re-runs each
one with its parameters nudged one at a time, and reports how much the result moves.

The nudges (per candidate) come from the search's own space file, so every searched dimension
is nudged and no table needs updating when a space changes (BL-010 F13):

  a number   one step either way, a tenth of its searched range (coverage_floor in [0, 0.3]
             moves by 0.03; pool_top_n in [30, 350] by 32), clipped to the range
  a choice   the neighbouring values when the choices are numbers (max_position 0.25 -> 0.2,
             0.35), every other value when they are not (score, lookbacks, entry)
  a band     pool/category/off bands move the exit rank and keep the top; moving the top
             keeps the band, so the hysteresis width never changes by accident
  offset     every other rebalance_offset of the cycle (which Friday it trades on)
  start      a later start date (2017-07, 2018-01, 2018-07, 2019-01)

A nudge the arm cannot run (`search.feasible`) is skipped. The kind of a nudge is the name of
the dimension it moved.

Results append to `<out>/robust-<pid>.jsonl`. `report` turns them into one verdict per candidate.
"""

from __future__ import annotations

import json
import multiprocessing as mp
import os
import time
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd

from . import bias, search
from .engine import IDLE

START_SHIFTS = ("2017-07-01", "2018-01-01", "2018-07-01", "2019-01-01")
#: A band dimension -> (the top it is measured from, the exit rank it sets).
BANDS = {
    "pool_band": ("pool_top_n", "pool_exit_rank"),
    "category_band": ("category_top_n", "category_exit_rank"),
    "off_band": ("off_top_n", "off_exit_rank"),
}
TOPS = {top: (band, exit_) for band, (top, exit_) in BANDS.items()}
#: Kinds that are not a change to the config itself.
NOT_PARAMETERS = ("base", "offset", "start")


# --- choosing candidates --------------------------------------------------------------------


def pick_candidates(df: pd.DataFrame, top: int = 45) -> pd.DataFrame:
    """A mix of the best-by-CAGR, the most robust-by-rolling-window and the lowest-drawdown runs,
    de-duplicated. Only runs with sensible turnover and activity are considered."""
    ok = df[df["error"].isna() & (df["turnover_x"] <= 3) & (df["buys_per_yr"] >= 10)]
    share = max(top // 9, 1)
    groups = [
        ok[ok.mdd >= -0.26].nlargest(share * 4, "cagr"),
        ok[(ok.cagr >= 0.26) & (ok.mdd >= -0.26)].nlargest(share * 4, "roll3y_worst"),
        ok[ok.mdd >= -0.20].nlargest(share * 1, "cagr"),
    ]
    picked = pd.concat(groups).drop_duplicates("id")
    return picked.head(top)


# --- the nudges -----------------------------------------------------------------------------


def _same(a: Any, b: Any) -> bool:
    as_tuple = lambda v: tuple(v) if isinstance(v, list | tuple) else v  # noqa: E731
    return as_tuple(a) == as_tuple(b)


def _neighbours(dim: search.Dim, value: Any) -> list[Any]:
    """The values one step away from `value` along `dim`."""
    if dim.kind == "choice":
        values = list(dim.values)
        at = next((i for i, v in enumerate(values) if _same(v, value)), None)
        if at is None:
            return []
        ordered = all(v is None or isinstance(v, int | float) for v in values)
        if ordered:
            return [values[j] for j in (at - 1, at + 1) if 0 <= j < len(values)]
        return [v for j, v in enumerate(values) if j != at]
    lo, hi = dim.values
    step = (hi - lo) / 10
    if dim.kind == "int":
        step = max(1, round(step))
    candidates = [min(max(value + sign * step, lo), hi) for sign in (-1, 1)]
    if dim.kind == "float":
        candidates = [round(v, 4) for v in candidates]
    return [v for v in dict.fromkeys(candidates) if not _same(v, value)]


_ABSENT = object()  # a dimension the stored run does not carry (None is a real value: no cap)


def _current(dim_name: str, heavy: dict, light: dict, fixed: dict) -> Any:
    """A dimension's value in a stored run (bands are stored as the exit rank they set)."""
    if dim_name in BANDS:
        top, exit_ = BANDS[dim_name]
        if top in light and exit_ in light:
            return light[exit_] - light[top]
        return _ABSENT
    for source in (light, heavy, fixed):
        if dim_name in source:
            return source[dim_name]
    return _ABSENT


def nudges(rec: dict[str, Any], space: search.Space) -> list[dict[str, Any]]:
    """[{kind, label, heavy, light, window}] - every one-step neighbour of the stored run along
    each dimension the space searched, plus the other rebalance phases and later starts. The
    base config itself is never included."""
    heavy, light = rec["heavy"], rec["light"]
    fixed = space.fixed
    out: list[dict[str, Any]] = []

    def add(kind: str, label: str, *, heavy_edit=None, light_edit=None, window=None) -> None:
        new_light = {**light, **(light_edit or {})}
        new_heavy = {**heavy, **(heavy_edit or {})}
        if (new_light, new_heavy, window) == (light, heavy, None):
            return
        if not search.feasible(space.arm, {**fixed, **new_light}):
            return
        out.append(
            {
                "kind": kind,
                "label": label,
                "heavy": new_heavy,
                "light": new_light,
                "window": window or {},
            }
        )

    for dim in space.heavy:
        value = heavy.get(dim.name, fixed.get(dim.name))
        for new in _neighbours(dim, value):
            add(dim.name, f"{dim.name} {new}", heavy_edit={dim.name: new})

    every = light.get("rebalance_every", fixed.get("rebalance_every", 1))
    for dim in space.light:
        if dim.name == "rebalance_offset_raw":
            continue  # the phases are nudged together below
        value = _current(dim.name, heavy, light, fixed)
        if value is _ABSENT:
            continue
        for new in _neighbours(dim, value):
            if dim.name in BANDS:
                top, exit_ = BANDS[dim.name]
                edit = {exit_: light[top] + new}
            elif dim.name in TOPS:
                band_name, exit_ = TOPS[dim.name]
                band = light.get(exit_, new) - light[dim.name]
                edit = {dim.name: new, exit_: new + band}
            elif dim.name == "rebalance_every":
                edit = {dim.name: new, "rebalance_offset": light.get("rebalance_offset", 0) % new}
            else:
                edit = {dim.name: new}
            add(dim.name, f"{dim.name} {new}", light_edit=edit)

    offset = light.get("rebalance_offset", 0)
    for new in range(every):
        if new != offset:
            add("offset", f"offset {new} of {every}", light_edit={"rebalance_offset": new})

    for start in START_SHIFTS:
        add("start", f"start {start}", window={"start": start})
    return out


# --- running --------------------------------------------------------------------------------


def _heavy_key(heavy: dict[str, Any]) -> str:
    return json.dumps(heavy, sort_keys=True, default=list)


def run_candidate(task: dict[str, Any]) -> dict[str, Any]:
    """One candidate: its base run plus every nudge. Runs in a worker process."""
    space = search.load_space(Path(task["space_path"]))
    rec = task["rec"]
    runner = bias.Runner(space)
    sealed = space.sealed_from
    started = time.time()
    plan = [
        {
            "kind": "base",
            "label": "base",
            "heavy": rec["heavy"],
            "light": rec["light"],
            "window": {},
        }
    ]
    plan += nudges(rec, space)
    bases: dict[str, Any] = {}
    locks: dict[str, Any] = {}
    out_path = Path(task["out_dir"]) / f"robust-{os.getpid()}.jsonl"
    done = errors = 0
    with out_path.open("a", buffering=1) as sink:
        for item in plan:
            row = {
                "cid": rec["id"],
                "kind": item["kind"],
                "label": item["label"],
                "window": item["window"],
                "light": item["light"],
                "heavy": item["heavy"],
            }
            try:
                end = item["window"].get("end") or space.fixed.get("end")
                if sealed and not (end and str(end) < str(sealed)):
                    raise ValueError("refusing to run past the sealed date")
                key = _heavy_key(item["heavy"])
                if key not in bases:
                    if len(bases) >= 2:  # a ranking is ~1 GB: keep at most two alive
                        drop = next(k for k in bases if k != _heavy_key(rec["heavy"]))
                        bases.pop(drop), locks.pop(drop, None)
                    bases[key] = runner.base(item["heavy"])
                outcome, ranking = runner.run(
                    bases[key], item["heavy"], item["light"], locks=locks.get(key), **item["window"]
                )
                if key not in locks:
                    locks[key] = runner.locks(ranking)
                row["metrics"] = search.run_metrics(outcome.result, IDLE)
                row["hurdles"] = runner.hurdles(outcome.result.equity)
                done += 1
            except Exception as error:  # noqa: BLE001 - recorded, never fatal
                row["error"] = f"{type(error).__name__}: {error}"[:300]
                errors += 1
            sink.write(json.dumps(row, default=float) + "\n")
    return {
        "cid": rec["id"],
        "done": done,
        "errors": errors,
        "secs": round(time.time() - started, 1),
    }


def run_round3(
    results_dir: Path,
    space_path: Path,
    out_dir: Path,
    *,
    top: int = 45,
    workers: int = 4,
    ids: list[str] | None = None,
    echo=print,
) -> None:
    df = search.load_results(results_dir)
    candidates = df[df["id"].isin(ids)] if ids is not None else pick_candidates(df, top)
    records = bias.load_records(results_dir, set(candidates["id"]))
    out_dir.mkdir(parents=True, exist_ok=True)
    seen = {
        json.loads(line)["cid"]
        for p in out_dir.glob("robust-*.jsonl")
        for line in p.read_text().splitlines()
        if line.strip().startswith("{")
    }
    tasks = [
        {"space_path": str(Path(space_path).resolve()), "out_dir": str(out_dir), "rec": records[i]}
        for i in candidates["id"]
        if i in records and i not in seen
    ]
    echo(
        f"{len(candidates)} candidates, {len(seen)} already done, {len(tasks)} to run, "
        f"{workers} worker(s)"
    )
    if not tasks:
        return
    ctx = mp.get_context("spawn")
    started = time.time()
    with ctx.Pool(workers, maxtasksperchild=1) as pool:
        for i, summary in enumerate(pool.imap_unordered(run_candidate, tasks), 1):
            echo(
                f"  candidate {i}/{len(tasks)} ({summary['cid']}): {summary['done']} ok, "
                f"{summary['errors']} errors, {summary['secs']} s "
                f"(elapsed {time.time() - started:.0f} s)"
            )


# --- verdicts -------------------------------------------------------------------------------


def load_robust(out_dir: Path) -> pd.DataFrame:
    rows = []
    for path in sorted(Path(out_dir).glob("robust-*.jsonl")):
        for line in path.read_text().splitlines():
            try:
                rec = json.loads(line)
            except json.JSONDecodeError:
                continue
            m = rec.get("metrics") or {}
            hurdle = (rec.get("hurdles") or {}).get("Nifty200 Momentum 30 TRI")
            rows.append(
                {
                    "cid": rec["cid"],
                    "kind": rec["kind"],
                    "label": rec["label"],
                    "error": rec.get("error"),
                    "cagr": m.get("cagr"),
                    "mdd": m.get("mdd"),
                    "turnover_x": m.get("turnover_x"),
                    "roll3y_worst": m.get("roll3y_worst"),
                    "uw_weeks": m.get("uw_max_underwater_weeks"),
                    "hurdle": hurdle,
                }
            )
    return pd.DataFrame(rows)


def verdicts(
    frame: pd.DataFrame, *, dd_floor: float = -0.30, uw_cap: float | None = None
) -> pd.DataFrame:
    """One row per candidate: its own result and how far the nudged versions stray.

    `dd_floor` is the depth a nudged version may not exceed (default -30%). `uw_cap`, when given,
    adds a time-under-water rule: at least 80% of nudged versions must spend no more than
    `uw_cap` weeks below a previous high."""
    ok = frame[frame["error"].isna() & frame["cagr"].notna()].copy()
    ok["excess"] = ok["cagr"] - ok["hurdle"]
    if "uw_weeks" not in ok:
        ok["uw_weeks"] = np.nan
    rows = []
    for cid, g in ok.groupby("cid"):
        base = g[g.kind == "base"]
        if base.empty:
            continue
        b = base.iloc[0]
        near = g[~g.kind.isin(NOT_PARAMETERS)]
        offsets = g[g.kind == "offset"]
        starts = g[g.kind == "start"]
        both = pd.concat([near, offsets])
        rows.append(
            {
                "cid": cid,
                "base_cagr": b.cagr,
                "base_mdd": b.mdd,
                "base_turnover": b.turnover_x,
                "n_nudges": len(both),
                "nudge_p25": both.cagr.quantile(0.25) if len(both) else np.nan,
                "nudge_median": both.cagr.median() if len(both) else np.nan,
                "nudge_worst": both.cagr.min() if len(both) else np.nan,
                "nudge_share_beat_hurdle": (both.excess > 0).mean() if len(both) else np.nan,
                "nudge_share_dd_ok": (both.mdd >= dd_floor).mean() if len(both) else np.nan,
                "nudge_share_uw_ok": (both.uw_weeks <= uw_cap).mean()
                if (uw_cap is not None and len(both))
                else np.nan,
                "base_uw_weeks": b.uw_weeks,
                "offset_spread": (offsets.cagr.max() - offsets.cagr.min())
                if len(offsets)
                else np.nan,
                "start_worst_excess": starts.excess.min() if len(starts) else np.nan,
                "start_worst_cagr": starts.cagr.min() if len(starts) else np.nan,
            }
        )
    out = pd.DataFrame(rows)
    if out.empty:
        return out
    out["survives"] = (
        (out.nudge_share_beat_hurdle >= 0.8)
        & (out.nudge_share_dd_ok >= 0.9)
        & (out.start_worst_excess > 0)
        & (out.nudge_worst > 0.12)
    )
    if uw_cap is not None:
        out["survives"] = out["survives"] & (out.nudge_share_uw_ok >= 0.8)
    return out.sort_values("nudge_p25", ascending=False).reset_index(drop=True)
