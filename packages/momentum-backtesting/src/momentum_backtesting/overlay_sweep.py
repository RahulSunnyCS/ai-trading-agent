"""BL-229: run a grid of Options overlay settings overnight (`mbt overlay-sweep run grid.json`).

A grid is `{"name", "base": {settings}, "axes": {setting: [values]}}`; the axis `strategy` takes
`{"favourite_id": ...}` or `{"custom": {...}}` items (a label is kept for the table). Every
combination runs through `overlay_runs.run_request`; one JSON line per run is appended to the
sweep's folder (`<data>/overlay-sweeps/<name>/results-w<k>.jsonl`, one file per worker), with
the settings, the whole book, the train and test windows (`split` in the base) and the skip
counts, never the trades. Runs already in the folder are skipped, so a stopped sweep resumes.
Workers take whole strategies, so each strategy is re-run on F&O stocks once per worker.
"""

from __future__ import annotations

import hashlib
import itertools
import json
import multiprocessing as mp
import os
import time
import traceback
from pathlib import Path
from typing import Any

SWEEPS_DIR_NAME = "overlay-sweeps"
#: The run's figures a sweep keeps (the rest of the response is the page's).
KEEP_BOOK = ("total_rs", "total", "cagr", "max_dd", "before_tax_rs", "tax_rs", "costs_rs",
             "weekly_90", "went_below_zero")  # fmt: skip


def sweeps_dir() -> Path:
    from .config import DATA_DIR

    return DATA_DIR / SWEEPS_DIR_NAME


def run_id(body: dict[str, Any]) -> str:
    return hashlib.sha1(json.dumps(body, sort_keys=True, default=str).encode()).hexdigest()[:16]


def expand(grid: dict[str, Any]) -> list[dict[str, Any]]:
    """Every combination of the axes over the base, as request bodies with `_label` (the
    strategy's name in the table) and `_id`."""
    base = dict(grid.get("base") or {})
    axes = grid.get("axes") or {}
    names = list(axes)
    out = []
    for values in itertools.product(*(axes[n] for n in names)):
        body = dict(base)
        label = None
        for name, value in zip(names, values, strict=True):
            if name == "strategy":
                value = dict(value)
                label = value.pop("label", None)
                body.update(value)
            elif name == "bundle":  # several settings that go together, e.g. stop + target
                body.update(value)
            else:
                body[name] = value
        if body.get("direction") in ("puts", "mirror"):
            body.pop("favourite_id", None)
            body.pop("custom", None)
            label = None
        body["_label"] = label or ("—" if body.get("direction") in ("puts", "mirror") else "?")
        key = {k: v for k, v in body.items() if not k.startswith("_")}
        body["_id"] = run_id(key)
        out.append(body)
    unique = {b["_id"]: b for b in out}  # puts / mirror runs collapse across strategies
    return list(unique.values())


def done_ids(folder: Path) -> set[str]:
    ids = set()
    for path in folder.glob("results-w*.jsonl"):
        for line in path.read_text().splitlines():
            try:
                ids.add(json.loads(line)["id"])
            except (ValueError, KeyError):
                continue
    return ids


def summary_row(body: dict[str, Any], result: dict[str, Any], secs: float) -> dict[str, Any]:
    settings = {k: v for k, v in body.items() if not k.startswith("_")}
    book = {k: result["book"].get(k) for k in KEEP_BOOK}
    stats = result.get("stats") or {}
    booking = result.get("booking")
    return {
        "id": body["_id"],
        "label": body.get("_label"),
        "settings": settings,
        "book": book,
        "shares": result.get("shares"),
        "nifty": result.get("nifty"),
        "windows": result.get("windows"),
        "stats": {
            k: stats.get(k)
            for k in (
                "trades",
                "win_rate",
                "payoff",
                "weeks_won",
                "top5pct_share",
                "net_without_top5pct_rs",
            )
        },  # fmt: skip
        "min_capital": result.get("min_capital", {}).get("suggested_rs"),
        "booking": None
        if booking is None
        else {
            k: booking.get(k) for k in ("out_rs", "in_rs", "taken_rs", "account_end_rs")
        },  # fmt: skip
        "counts": result.get("counts"),
        "secs": round(secs, 1),
    }


def _worker(k: int, bodies: list[dict[str, Any]], folder: str) -> None:
    from . import overlay_runs

    out = Path(folder) / f"results-w{k}.jsonl"
    for body in bodies:
        t0 = time.time()
        request = {key: v for key, v in body.items() if not key.startswith("_")}
        try:
            result = overlay_runs.run_request(request)
            row = summary_row(body, result, time.time() - t0)
        except Exception as error:  # noqa: BLE001 - recorded, the sweep goes on
            row = {"id": body["_id"], "label": body.get("_label"),
                   "settings": request, "error": f"{type(error).__name__}: {error}"[:500],
                   "trace": traceback.format_exc()[-1500:]}  # fmt: skip
        overlay_runs._CACHE.clear()  # results are large; a sweep never asks twice
        with out.open("a") as f:
            f.write(json.dumps(row, default=str) + "\n")
            f.flush()
            os.fsync(f.fileno())


def run(grid_path: Path, workers: int = 3) -> dict[str, Any]:
    grid = json.loads(Path(grid_path).read_text())
    name = grid["name"]
    folder = sweeps_dir() / name
    folder.mkdir(parents=True, exist_ok=True)
    (folder / "grid.json").write_text(json.dumps(grid, indent=1))
    bodies = expand(grid)
    done = done_ids(folder)
    todo = [b for b in bodies if b["_id"] not in done]
    # whole strategies to a worker, the biggest groups first, so each is re-run once
    groups: dict[str, list] = {}
    for b in todo:
        key = json.dumps({k: b.get(k) for k in ("favourite_id", "custom")}, sort_keys=True)
        groups.setdefault(key, []).append(b)
    shares: list[list] = [[] for _ in range(max(1, workers))]
    for group in sorted(groups.values(), key=len, reverse=True):
        min(shares, key=len).extend(group)
    status = {"name": name, "total": len(bodies), "done_before": len(done), "todo": len(todo),
              "workers": workers, "started": time.strftime("%Y-%m-%d %H:%M:%S"),
              "pid": os.getpid()}  # fmt: skip
    (folder / "status.json").write_text(json.dumps(status, indent=1))
    ctx = mp.get_context("spawn")
    procs = [ctx.Process(target=_worker, args=(k, share, str(folder)))
             for k, share in enumerate(shares) if share]  # fmt: skip
    for p in procs:
        p.start()
    for p in procs:
        p.join()
    status["finished"] = time.strftime("%Y-%m-%d %H:%M:%S")
    status["done"] = len(done_ids(folder))
    (folder / "status.json").write_text(json.dumps(status, indent=1))
    return status


def list_sweeps() -> list[dict[str, Any]]:
    root = sweeps_dir()
    if not root.exists():
        return []
    out = []
    for folder in sorted(root.iterdir()):
        status_path = folder / "status.json"
        if not status_path.exists():
            continue
        status = json.loads(status_path.read_text())
        status["done"] = len(done_ids(folder))
        status["running"] = "finished" not in status and _alive(status.get("pid"))
        out.append(status)
    return out


def _alive(pid: int | None) -> bool:
    if not pid:
        return False
    try:
        os.kill(int(pid), 0)
    except OSError:
        return False
    return True


def read_sweep(name: str) -> list[dict[str, Any]]:
    folder = sweeps_dir() / name
    if not folder.is_dir() or "/" in name or name.startswith("."):
        raise LookupError(f"No sweep named {name!r}.")
    rows = []
    for path in sorted(folder.glob("results-w*.jsonl")):
        for line in path.read_text().splitlines():
            try:
                rows.append(json.loads(line))
            except ValueError:
                continue
    return rows
