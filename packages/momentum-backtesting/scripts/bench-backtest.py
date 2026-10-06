#!/usr/bin/env python3
"""Time one backtest and say where the time goes (BL-005).

    uv run python scripts/bench-backtest.py                    # broad_default on the golden fixture
    uv run python scripts/bench-backtest.py --scenario etf_default --runs 5
    uv run python scripts/bench-backtest.py --live             # the real data in TRADING_DATA_ROOT
    uv run python scripts/bench-backtest.py --profile out.prof # cProfile of one warm run

By default it builds a throwaway database from the frozen golden fixture (the same data every
time, whatever else the machine's real data is doing), so two measurements are comparable. It
prints, for one scenario:

  cold    the first run in a fresh process: every cache empty
  warm    the same settings with only the whole-result cache cleared: what changing a slider by
          a little costs, with the rankings and loaded prices kept
  cached  an identical repeat: served from the result cache
  jobs    the background-job route, which returns the core result and then each heavy section
          as the dashboard fetches it, with the time each took
  stages  where the warm run spent its time: inclusive seconds per named function (a function
          that calls another is counted with it, so the rows add up to more than the run)

Wall time moves with whatever else the machine is doing: `cpu` (this process only) moves less.
Take the best of several `warm` runs, and compare numbers taken on the same machine. Results are
never compared here; that is what the goldens and `result-baseline.py` are for.
"""

from __future__ import annotations

import argparse
import cProfile
import os
import pstats
import sys
import tempfile
import time
from collections import defaultdict
from pathlib import Path

PACKAGE_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PACKAGE_ROOT))

#: (module path, function) timed for the `stages` table; each is wrapped only if it exists.
STAGES = [
    ("momentum_backtesting.api", "_run_broad"),
    ("momentum_backtesting.api", "_circuit_realism"),
    ("momentum_backtesting.engine", "run_backtest"),
    ("momentum_backtesting.categories.broad", "compute_universe_ranking"),
    ("momentum_backtesting.categories.broad", "build_effective_stock_ranks"),
    ("momentum_backtesting.categories.circuit_exposure", "circuit_exposure"),
    ("momentum_backtesting.analysis", "payload_parts"),
    ("momentum_backtesting.analysis", "rotations"),
    ("momentum_backtesting.analysis", "instrument_table"),
    ("momentum_backtesting.analysis", "latest_signal"),
    ("momentum_backtesting.analysis", "timeline"),
    ("momentum_backtesting.analysis", "closed_trades"),
]


def _instrument(spent: dict[str, list[float]]) -> None:
    import importlib

    for module_name, name in STAGES:
        module = importlib.import_module(module_name)
        real = getattr(module, name, None)
        if real is None:
            continue

        key = f"{module_name.rsplit('.', 1)[-1]}.{name}"

        def make(real=real, key=key):
            def timed(*args, **kwargs):
                began = time.perf_counter()
                try:
                    return real(*args, **kwargs)
                finally:
                    spent[key][0] += time.perf_counter() - began
                    spent[key][1] += 1

            return timed

        setattr(module, name, make())


def _timed(call):
    wall, cpu = time.perf_counter(), time.process_time()
    out = call()
    return out, time.perf_counter() - wall, time.process_time() - cpu


def _post(client, request: dict):
    from tests.golden.harness import missing_categories, without_universe

    response = client.post("/api/backtest", json=request)
    if missing := missing_categories(response.status_code, response.json()):
        # The trimmed fixture cannot price every category; as the goldens do, run on the rest.
        request.update(without_universe(request, missing))
        response = client.post("/api/backtest", json=request)
    assert response.status_code == 200, response.text[:300]
    return response


def _run_jobs(client, request: dict) -> None:
    started = client.post("/api/backtest/jobs", json=request)
    job_id = started.json()["job"]["id"]
    began = time.perf_counter()
    while True:
        job = client.get(f"/api/backtest/jobs/{job_id}").json()["job"]
        if job["status"] in ("done", "failed"):
            break
        time.sleep(0.02)
    core = time.perf_counter() - began
    assert job["status"] == "done", job.get("error")
    size = len(client.get(f"/api/backtest/jobs/{job_id}").content)
    print(f"  core result      {core:7.2f} s  {size / 1024:7.0f} KB")
    for name in job["result"].get("sections_available", []):
        began = time.perf_counter()
        response = client.get(f"/api/backtest/jobs/{job_id}/sections/{name}")
        print(
            f"  section {name:12} {time.perf_counter() - began:5.2f} s  "
            f"{len(response.content) / 1024:7.0f} KB"
        )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--scenario", default="broad_default", help="a golden scenario name")
    parser.add_argument("--runs", type=int, default=3, help="warm runs (the best is reported)")
    parser.add_argument("--live", action="store_true", help="the real data, not the fixture")
    parser.add_argument("--profile", type=Path, help="write a cProfile of one warm run here")
    args = parser.parse_args()

    with tempfile.TemporaryDirectory(prefix="mbt-bench-") as tmp:
        if not args.live:
            # config.DATA_DIR is read when the package is imported: set the environment first.
            root, data = Path(tmp) / "root", Path(tmp) / "data"
            os.environ["TRADING_DATA_ROOT"], os.environ["MOMENTUM_DATA_DIR"] = str(root), str(data)
            from tests.golden.harness import build_inputs

            data.mkdir(parents=True)
            build_inputs(root, data)
        from fastapi.testclient import TestClient

        from momentum_backtesting import api
        from tests.golden.harness import expand
        from tests.golden.scenarios import SCENARIOS

        if args.scenario not in SCENARIOS:
            parser.error(f"unknown scenario {args.scenario!r}; one of: {', '.join(SCENARIOS)}")
        spent: dict[str, list[float]] = defaultdict(lambda: [0.0, 0])
        _instrument(spent)
        client = TestClient(api.create_app())
        request = expand(client, SCENARIOS[args.scenario])
        where = "live data" if args.live else "golden fixture"
        print(f"{args.scenario} on the {where}, {request['dataset']} dataset\n")

        _, wall, cpu = _timed(lambda: _post(client, request))
        print(f"  cold    {wall:7.2f} s wall  {cpu:7.2f} s cpu")
        warm = []
        for _ in range(args.runs):
            api.DATA.result_cache.clear()
            spent.clear()
            response, wall, cpu = _timed(lambda: _post(client, request))
            warm.append((wall, cpu, response, {k: list(v) for k, v in spent.items()}))
        best = min(warm, key=lambda w: w[0])
        print(
            f"  warm    {best[0]:7.2f} s wall  {best[1]:7.2f} s cpu  "
            f"(best of {args.runs}; all: {', '.join(f'{w[0]:.2f}' for w in warm)})"
        )
        print(f"  size    {len(best[2].content) / 1024:7.0f} KB whole result")
        _, wall, cpu = _timed(lambda: _post(client, request))
        print(f"  cached  {wall:7.2f} s wall  {cpu:7.2f} s cpu")

        print("\njobs (the dashboard's route: core first, then each section as opened):")
        api.DATA.result_cache.clear()
        _run_jobs(client, request)

        print("\nstages of the best warm run (inclusive seconds, calls):")
        for key, (seconds, calls) in sorted(best[3].items(), key=lambda kv: -kv[1][0]):
            print(f"  {key:50} {seconds:7.2f} s  x{calls}")

        if args.profile:
            api.DATA.result_cache.clear()
            profiler = cProfile.Profile()
            profiler.runcall(lambda: _post(client, request))
            profiler.dump_stats(str(args.profile))
            print(f"\nprofile written to {args.profile}; top by cumulative time:")
            pstats.Stats(profiler).sort_stats("cumulative").print_stats(18)
    return 0


if __name__ == "__main__":
    sys.exit(main())
