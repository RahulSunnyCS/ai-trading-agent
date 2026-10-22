"""BL-152 Phase 2: run the registered grid on the learning period with the BL-120 tester.

Loads the NIFTY frame once and passes every variant through `study.run_test` (events, trend-matched
placebo and random-time controls, slippage, charges), so each variant is one ledger test (192 in
all). Resumable: a variant already in out/done.jsonl is never run again (a rerun would be another
try in the ledger). Writes, under out/ (git-ignored):

    done.jsonl     one line per finished variant: id, spec hash, test id, summary numbers
    nets/<id>.json the variant's event rows (day, side, entry, exit, net, gross)

    uv run python research/bl152/run_grid.py --only 2        # the timing pilot
    uv run python research/bl152/run_grid.py --workers 6     # the rest
    echo 10 > research/bl152/out/workers.txt                 # more cores from the next variant on
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from pathlib import Path

import numpy as np
import yaml

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from specs import CRITERIA, grid  # noqa: E402

OUT = HERE / "out"


def done_ids() -> set[str]:
    path = OUT / "done.jsonl"
    if not path.exists():
        return set()
    return {json.loads(line)["id"] for line in path.read_text().splitlines() if line.strip()}


def record(vid: str, result: dict) -> dict:
    """Write a finished variant's event rows and its done line; return the summary."""
    rows = result["periods"]["learning"].get("rows", [])
    keep = ("day", "side", "entry", "exit", "net", "gross", "stopped_by", "expiry_day")
    (OUT / "nets" / f"{vid}.json").write_text(
        json.dumps([{k2: r.get(k2) for k2 in keep} for r in rows])
    )
    line = summary(vid, result)
    with (OUT / "done.jsonl").open("a") as handle:
        handle.write(json.dumps(line, default=float) + "\n")
    return line


def recover(root: Path, finished: set[str]) -> list[str]:
    """Variants whose learning-period test is in the ledger but not in done.jsonl (a run cut off
    between the two writes) are taken from their stored result, never tested again: a second test
    would be a second ledger try for the same variant. Returns the ids recovered."""
    from option_backtesting.ruletest import store
    from option_backtesting.ruletest.spec import from_dict

    by_hash = {from_dict(rule).spec_hash: vid for vid, rule in grid()}
    got = []
    for row in store.ledger(root):
        vid = by_hash.get(row.get("spec_hash"))
        if vid is None or vid in finished or "learning" not in (row.get("periods") or []):
            continue
        result = store.read_result(root, str(row["id"]))
        if result is None:
            continue
        record(vid, result)
        finished.add(vid)
        got.append(vid)
    return got


def worker_count(default: int) -> int:
    """The worker count for the next variant: out/workers.txt when it holds a whole number, so a
    running grid can be given more (or fewer) cores without a restart."""
    try:
        return max(1, int((OUT / "workers.txt").read_text().strip()))
    except (OSError, ValueError):
        return default


def summary(vid: str, result: dict) -> dict:
    from option_backtesting.ruletest import study

    period = result["periods"]["learning"]
    rows = period.get("rows", [])
    nets = {r["day"]: r["net"] for r in rows}
    mean, t = study.day_t(nets)
    random_time = period.get("random_time") or {}
    placebo = period.get("placebo") or {}
    slip = period.get("slippage") or {}
    return {
        "id": vid,
        "spec_hash": result["spec_hash"],
        "test_id": result["id"],
        "events": period.get("events", 0),
        "thin": period.get("thin", True),
        "net_mean": None if not rows else mean,
        "net_t": t,
        "net_total": period.get("net_total"),
        "gross_mean": period.get("gross_mean"),
        "win_rate": period.get("win_rate"),
        "random_percentile": random_time.get("event_percentile"),
        "random_mean": random_time.get("mean"),
        "random_minutes_used": random_time.get("minutes_used"),
        "placebo_mean": placebo.get("placebo_mean"),
        "placebo_diff": placebo.get("diff_mean"),
        "placebo_events": placebo.get("events"),
        "slip_0_5": (slip.get("0.5") or {}).get("net_mean"),
        "slip_1": (slip.get("1") or {}).get("net_mean"),
        "by_side": period.get("by_side"),
        "by_expiry_day": period.get("by_expiry_day"),
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument(
        "--only", type=int, default=0, help="run at most this many not-yet-done variants"
    )
    ap.add_argument("--workers", type=int, default=6)
    args = ap.parse_args()

    from option_backtesting.ruletest import frame as F
    from option_backtesting.ruletest import study
    from option_backtesting.ruletest.spec import from_dict

    root = Path(os.environ["TRADING_DATA_ROOT"])
    (OUT / "nets").mkdir(parents=True, exist_ok=True)
    finished = done_ids()
    for vid in recover(root, finished):
        print(f"recovered from the ledger, not run again: {vid}", flush=True)
    todo = [(vid, rule) for vid, rule in grid() if vid not in finished]
    if args.only:
        todo = todo[: args.only]
    print(f"{len(finished)} done, running {len(todo)}", flush=True)
    if not todo:
        return 0
    end = study.PERIODS["learning"][1]
    t0 = time.time()
    frame = F.load_frame(root, CRITERIA["underlying"], end)
    print(f"frame: {frame.n} sessions in {time.time() - t0:.0f} s", flush=True)
    shown = None
    for k, (vid, rule) in enumerate(todo, 1):
        started = time.time()
        workers = worker_count(args.workers)  # out/workers.txt can change it between variants
        if workers != shown:
            print(f"workers: {workers}", flush=True)
            shown = workers
        text = yaml.safe_dump({"rule": rule}, sort_keys=False)
        compiled = from_dict(rule)
        options = study.Options(periods=("learning",), workers=workers)
        try:
            result = study.run_test(root, compiled, text, options, frame=frame)
        except Exception as error:  # noqa: BLE001 - recorded, the grid goes on
            line = {"id": vid, "error": f"{type(error).__name__}: {error}"[:300]}
            print(f"[{k}/{len(todo)}] {vid}: ERROR {line['error']}", flush=True)
            with (OUT / "errors.jsonl").open("a") as handle:
                handle.write(json.dumps(line) + "\n")
            continue
        line = record(vid, result)
        mean = line["net_mean"]
        print(
            f"[{k}/{len(todo)}] {vid}: {line['events']} events, "
            f"net/trade {'—' if mean is None or np.isnan(mean) else f'{mean:,.0f}'}, "
            f"{time.time() - started:.0f} s",
            flush=True,
        )
    return 0


if __name__ == "__main__":
    sys.exit(main())
