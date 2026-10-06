#!/usr/bin/env python3
"""Snapshot every backtest result on the LIVE data, then check later code gives the same (BL-005).

The goldens (tests/golden/, BL-001) prove a change keeps results on a frozen 2018-2025 slice of
the data. This is the same check on today's real data: all golden scenarios (every dataset and
setting) plus every saved favourite, each run through the real API. Use it around any change
meant to leave results alone - take the snapshot first, on the code before the change.

    uv run python scripts/result-baseline.py capture --data-dir <data> --out <dir>
    uv run python scripts/result-baseline.py compare --data-dir <data> --baseline <dir>
    uv run python scripts/result-baseline.py compare ... --via jobs   # through the job routes
    uv run python scripts/result-baseline.py compare ... --twice      # and time warm re-runs

`--data-dir` is the package's `data/` folder (MOMENTUM_DATA_DIR); a worktree has none of its
own, so point it at the main checkout's. The database is TRADING_DATA_ROOT as usual.

`compare` re-sends each recorded request and reports any difference with the goldens' rules
(10 significant digits, run-describing keys such as `elapsed_ms` ignored). It also reports
whether the data changed since the snapshot (row counts, newest dates, file sizes and times),
because a difference after a data refresh says nothing about the code. It prints the time
each run took then and now, which is the speed record for BL-005. Exits 1 on any difference.

Not covered: the rebalance preview (it prices against the current week and live quotes, so it
changes by itself) and the weekly signal run (it writes signals and the journal).
"""

from __future__ import annotations

import argparse
import gzip
import json
import os
import re
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path

PACKAGE_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PACKAGE_ROOT))

#: Folders under the data directory whose files a backtest reads (top level only).
DATA_FOLDERS = (".", "daily", "daily_etf", "categories", "stocks")


def _slug(name: str) -> str:
    return re.sub(r"[^A-Za-z0-9_.-]+", "_", name).strip("_")


def _git() -> dict:
    def run(*args: str) -> str:
        return subprocess.run(
            ["git", *args], cwd=PACKAGE_ROOT, capture_output=True, text=True, check=False
        ).stdout.strip()

    return {"commit": run("rev-parse", "HEAD"), "dirty": bool(run("status", "--porcelain"))}


def data_fingerprint(data_dir: Path) -> dict:
    """What the data looked like: per table its row count and a hash of every row (the same
    `db_read.table_fingerprints` the server's caches are keyed on); per input file its size and
    modification time. Content, not the catalog file's own timestamp, which moves on any write
    (a saved run, for one)."""
    from trading_data.db import data_root

    from momentum_backtesting import db_read

    root = data_root()
    tables = {
        name: [count, str(digest)] for name, count, digest in db_read.table_fingerprints(root)
    }
    files: dict[str, list] = {}
    folders = [data_dir / folder for folder in DATA_FOLDERS]
    folders.append(root / "lake" / "bars_1d" / "asset=stock")
    for folder in folders:
        if not folder.exists():
            continue
        paths = folder.rglob("*.parquet") if folder.name == "asset=stock" else folder.iterdir()
        for path in sorted(paths):
            if path.is_file() and not path.name.endswith(".log"):
                stat = path.stat()
                files[str(path)] = [stat.st_size, stat.st_mtime]
    return {"format": 2, "tables": tables, "files": files}


def _requests(client) -> dict[str, dict]:
    """Every golden scenario, expanded against the live defaults, and every saved favourite."""
    from trading_data.db import connect

    from momentum_backtesting import runs_store
    from tests.golden.harness import expand
    from tests.golden.scenarios import SCENARIOS

    requests = {f"golden:{name}": expand(client, scenario) for name, scenario in SCENARIOS.items()}
    with connect(read_only=True) as con:
        favourites = runs_store.list_favorites(con)
    for favourite in favourites:
        config = {k: v for k, v in favourite["config"].items() if k != "fresh"}
        key = f"favourite:{favourite['name']}"
        if key in requests:  # names are only unique within a dataset
            key = f"{key} ({config.get('dataset')}, {favourite['id'][:6]})"
        requests[key] = config
    return requests


def _run(client, request: dict, via: str) -> tuple[int, dict]:
    if via == "direct":
        response = client.post("/api/backtest", json=request)
        return response.status_code, response.json()
    started = client.post("/api/backtest/jobs", json=request)
    if started.status_code != 202:
        return started.status_code, started.json()
    job_id = started.json()["job"]["id"]
    while True:
        job = client.get(f"/api/backtest/jobs/{job_id}").json()["job"]
        if job["status"] == "done":
            return 200, job["result"]
        if job["status"] == "failed":
            return 500, {"job_error": job["error"]}
        time.sleep(0.05)


def _execute(requests: dict[str, dict], via: str) -> dict[str, dict]:
    from tests.golden.harness import missing_categories, normalise, without_universe

    client = _client()
    results = {}
    for name, request in requests.items():
        # Wall time is what a user waits; CPU time (this process, every thread) is the one other
        # work on the machine barely moves, so compare that when the machine is busy.
        began, cpu_began = time.perf_counter(), time.process_time()
        status, body = _run(client, request, via)
        if missing := missing_categories(status, body):
            # As the goldens do: some categories have no prices for this universe. Run on the
            # rest; the request actually used is what is recorded and re-sent by `compare`.
            request = without_universe(request, missing)
            began, cpu_began = time.perf_counter(), time.process_time()
            status, body = _run(client, request, via)
        seconds = round(time.perf_counter() - began, 2)
        cpu = round(time.process_time() - cpu_began, 2)
        results[name] = {
            "request": request,
            "status": status,
            "seconds": seconds,
            "cpu_seconds": cpu,
            "bytes": len(json.dumps(body)),
            "response": normalise(body),
        }
        print(f"  {name}: {status} in {seconds:.1f}s ({cpu:.1f}s CPU)", flush=True)
    return results


def _client():
    from fastapi.testclient import TestClient

    from momentum_backtesting import api

    return TestClient(api.create_app())


def capture(data_dir: Path, out: Path, via: str, only: list[str]) -> int:
    """A new snapshot, or with `only`, re-capture those runs into an existing one (refused if
    the data changed since it was taken)."""
    previous = None
    if only:
        previous = json.loads((out / "manifest.json").read_text())
        if moved := _data_changes(previous["data"], data_fingerprint(data_dir)):
            print("Refusing: the data changed since this snapshot was taken:")
            for line in moved[:10]:
                print(f"  {line}")
            return 1
    else:
        out.mkdir(parents=True, exist_ok=False)
    fingerprint = data_fingerprint(data_dir)
    requests = _requests(_client())
    if only:
        requests = {k: v for k, v in requests.items() if any(part in k for part in only)}
    print(f"Capturing {len(requests)} runs into {out}")
    results = _execute(requests, via)
    for name, result in results.items():
        with gzip.open(out / f"{_slug(name)}.json.gz", "wt", encoding="utf-8") as handle:
            json.dump(result, handle, sort_keys=True)
    manifest = {
        "created": datetime.now().isoformat(timespec="seconds"),
        "git": _git(),
        "via": via,
        "data_dir": str(data_dir),
        "data": fingerprint,
        "runs": {
            name: {
                "file": f"{_slug(name)}.json.gz",
                "status": r["status"],
                "seconds": r["seconds"],
                "cpu_seconds": r["cpu_seconds"],
                "bytes": r["bytes"],
                "kpis": (r["response"] or {}).get("kpis"),
            }
            for name, r in results.items()
        },
    }
    if previous:
        # Keep the snapshot's own data, commit and other runs; note what was re-captured.
        manifest = {
            **previous,
            "runs": {**previous["runs"], **manifest["runs"]},
            "recaptured": [
                *previous.get("recaptured", []),
                {"when": manifest["created"], "git": manifest["git"], "runs": sorted(results)},
            ],
        }
    (out / "manifest.json").write_text(json.dumps(manifest, indent=1, sort_keys=True) + "\n")
    failed = [name for name, r in results.items() if r["status"] != 200]
    print(f"Done: {len(results)} runs, {len(failed)} not 200 {failed or ''}")
    return 0


def _data_changes(before: dict, after: dict) -> list[str]:
    lines = []
    # Snapshots taken before row hashes were recorded (no "format") held [count, newest date]:
    # for those only the row count can be compared.
    exact = before.get("format") == after["format"]
    if not exact:
        lines.append("snapshot predates row hashes: only table row counts are compared")
    for table in sorted(set(before["tables"]) | set(after["tables"])):
        old, new = before["tables"].get(table), after["tables"].get(table)
        if not exact:
            if not (old and new):  # a table the old snapshot never recorded
                continue
            old, new = old[:1], new[:1]
        if old != new:
            lines.append(f"table {table}: {old} -> {new}")
    for path in sorted(set(before["files"]) | set(after["files"])):
        if before["files"].get(path) != after["files"].get(path):
            lines.append(f"file {path}: changed")
    return lines


def compare(data_dir: Path, baseline: Path, via: str, only: list[str], twice: bool) -> int:
    from tests.golden.harness import differences

    manifest = json.loads((baseline / "manifest.json").read_text())
    data_moved = _data_changes(manifest["data"], data_fingerprint(data_dir))
    if data_moved:
        print("DATA CHANGED since the snapshot, so a difference below may be the data, not code:")
        for line in data_moved[:20]:
            print(f"  {line}")
    else:
        print("Data unchanged since the snapshot.")
    expected = {}
    for name, entry in manifest["runs"].items():
        if only and not any(part in name for part in only):
            continue
        with gzip.open(baseline / entry["file"], "rt", encoding="utf-8") as handle:
            expected[name] = json.load(handle)
    print(f"Re-running {len(expected)} runs via {via} (snapshot: {manifest['git']['commit'][:9]})")
    requests = {name: e["request"] for name, e in expected.items()}
    passes = [_execute(requests, via)]
    if twice:
        print("Second pass (same process, identical requests: the server's caches are warm)")
        passes.append(_execute(requests, via))
    changed = 0
    again = f"{'again':>7} {'CPU':>6} " if twice else ""
    print(
        f"\n{'run':56} {'result':9} {'then':>7} {'CPU':>6} {'now':>7} {'CPU':>6} {again}"
        f"{'KB then':>8} {'KB now':>8}"
    )

    def cpu(entry: dict) -> str:  # snapshots taken before CPU time was recorded have none
        return f"{entry['cpu_seconds']:5.1f}s" if "cpu_seconds" in entry else f"{'-':>6}"

    for name, old in expected.items():
        diffs: list[str] = []
        for run in passes:  # every pass must match, cached or not
            diffs = diffs or differences(
                {"status": old["status"], "response": old["response"]},
                {"status": run[name]["status"], "response": run[name]["response"]},
            )
        changed += bool(diffs)
        new = passes[0][name]
        second = f"{passes[1][name]['seconds']:6.2f}s {cpu(passes[1][name])} " if twice else ""
        print(
            f"{name[:56]:56} {'DIFFERENT' if diffs else 'same':9} "
            f"{old['seconds']:6.1f}s {cpu(old)} {new['seconds']:6.1f}s {cpu(new)} {second}"
            f"{old['bytes'] / 1024:8.0f} {new['bytes'] / 1024:8.0f}"
        )
        for line in diffs[:10]:
            print(f"    {line}")
    then = sum(e["seconds"] for e in expected.values())
    totals = [sum(run[name]["seconds"] for name in expected) for run in passes]
    line = f"\nTotal time: then {then:.0f}s, now {totals[0]:.0f}s"
    print(line + (f", again {totals[1]:.1f}s" if twice else ""))
    print(f"{changed} of {len(expected)} runs differ from the snapshot.")
    return 1 if changed else 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    sub = parser.add_subparsers(dest="command", required=True)
    for command in ("capture", "compare"):
        p = sub.add_parser(command)
        p.add_argument("--data-dir", type=Path, default=os.environ.get("MOMENTUM_DATA_DIR"))
        p.add_argument("--via", choices=("direct", "jobs"), default="direct")
    sub.choices["capture"].add_argument("--out", type=Path, required=True)
    sub.choices["capture"].add_argument(
        "--only", action="append", default=[], help="re-capture just these runs into --out"
    )
    sub.choices["compare"].add_argument("--baseline", type=Path, required=True)
    sub.choices["compare"].add_argument(
        "--only", action="append", default=[], help="run names containing this text"
    )
    sub.choices["compare"].add_argument(
        "--twice", action="store_true", help="run everything again, to time warm re-runs"
    )
    args = parser.parse_args()
    data_dir = (args.data_dir or PACKAGE_ROOT / "data").expanduser().resolve()
    if not data_dir.exists():
        parser.error(f"no data folder at {data_dir}; pass --data-dir")
    # config.DATA_DIR is read when the package is imported, so set it before any import.
    os.environ["MOMENTUM_DATA_DIR"] = str(data_dir)
    if args.command == "capture":
        return capture(data_dir, args.out.expanduser().resolve(), args.via, args.only)
    return compare(data_dir, args.baseline.expanduser().resolve(), args.via, args.only, args.twice)


if __name__ == "__main__":
    sys.exit(main())
