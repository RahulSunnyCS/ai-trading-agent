"""`mbt serve` must leave the shared catalog free between requests.

DuckDB lets one process hold `catalog.duckdb`; another process cannot even read it meanwhile. On
2026-10-07 the running Momentum API held it long enough that `tdata` and `obt` (10 s lock wait)
failed, so the evening `obt daily` save could too. This starts the real API on the golden
fixture, issues the heaviest reads and, after each one, has a SEPARATE process open the catalog
for writing: it must get in at once (DuckDB fails immediately on a held lock), in under a second.

The lake also gets an unreadable 1-minute option file. Binding the 1-minute views reads every
file's footer, ~20-35 s with the catalog locked on the live lake; this package never queries
them, so any connection here that still binds them fails the request it serves.

Runs in a child process, like `harness.py`: the data folder is fixed when the package imports.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import time
from pathlib import Path

#: Opens the catalog read-write in a fresh process and prints how long that took.
PROBE = (
    "import sys, time, duckdb\n"
    "start = time.perf_counter()\n"
    "duckdb.connect(sys.argv[1]).close()\n"
    "print(time.perf_counter() - start)\n"
)
#: (method, path, body or scenario name) — the reads that touch the catalog or the stock lake.
REQUESTS = [
    ("GET", "/api/meta?dataset=etf", None),
    ("GET", "/api/meta?dataset=stock", None),
    ("GET", "/api/meta?dataset=custom_index", None),
    ("GET", "/api/meta?dataset=broad", None),
    ("POST", "/api/backtest", "stock_default"),
    ("POST", "/api/backtest", "custom_index_default"),
    ("POST", "/api/backtest", "broad_default"),
    ("JOB", "/api/backtest/jobs", "broad_gates_loosened_and_tilted"),
    ("GET", "/api/momentum-scores", None),
    ("GET", "/api/liquidity-preview", None),
    ("GET", "/api/weekly/status", None),
    ("GET", "/api/journal", None),
    ("GET", "/api/saved-runs?dataset=broad", None),
    ("GET", "/api/favorite-strategies", None),
    ("GET", "/api/stock-actions", None),
]


def _probe(catalog: Path) -> dict:
    done = subprocess.run(
        [sys.executable, "-c", PROBE, str(catalog)],
        capture_output=True,
        text=True,
        timeout=60,
        check=False,
    )
    if done.returncode != 0:
        return {"ok": False, "error": done.stderr.strip().splitlines()[-1:]}
    return {"ok": True, "seconds": float(done.stdout)}


def _child(out_file: Path) -> None:
    from fastapi.testclient import TestClient
    from harness import build_inputs, expand
    from scenarios import SCENARIOS

    from momentum_backtesting import api

    root = Path(os.environ["TRADING_DATA_ROOT"])
    build_inputs(root, Path(os.environ["MOMENTUM_DATA_DIR"]))
    corrupt = root / "lake/bars_1m/asset=option/underlying=NIFTY/date=2026-01-02/data.parquet"
    corrupt.parent.mkdir(parents=True, exist_ok=True)
    corrupt.write_bytes(b"not a parquet file")

    results = []
    with TestClient(api.create_app(), raise_server_exceptions=False) as client:
        for method, path, body in REQUESTS:
            if method == "GET":
                status = client.get(path).status_code
            else:
                request = expand(client, SCENARIOS[body])
                response = client.post(path, json=request)
                status = response.status_code
                if method == "JOB" and status == 202:
                    job_id = response.json()["job"]["id"]
                    deadline = time.monotonic() + 300
                    job = response.json()["job"]
                    while job["status"] in ("queued", "running") and time.monotonic() < deadline:
                        time.sleep(0.1)
                        job = client.get(f"{path}/{job_id}").json()["job"]
                    status = 200 if job["status"] == "done" else 500
                    # The circuit card reads daily bars from the lake when it is opened.
                    section = client.get(f"{path}/{job_id}/sections/circuit_exposure")
                    status = max(status, section.status_code if section.status_code >= 500 else 0)
            results.append(
                {
                    "request": f"{method} {path} {body or ''}".strip(),
                    "status": status,
                    **_probe(root / "catalog.duckdb"),
                }
            )
    out_file.write_text(json.dumps(results))


def run_requests() -> list[dict]:
    with tempfile.TemporaryDirectory(prefix="mbt-catalog-release-") as tmp:
        work = Path(tmp)
        env = {
            **os.environ,
            "TRADING_DATA_ROOT": str(work / "root"),
            "MOMENTUM_DATA_DIR": str(work / "data"),
            "PYTHONHASHSEED": "0",
        }
        for secret in ("DATABASE_URL", "FYERS_ACCESS_TOKEN", "FYERS_APP_ID"):
            env.pop(secret, None)
        done = subprocess.run(
            [sys.executable, str(Path(__file__)), str(work / "out.json")],
            env=env,
            capture_output=True,
            text=True,
            check=False,
        )
        if done.returncode != 0:
            raise RuntimeError(f"catalog release child failed:\n{done.stderr[-4000:]}")
        return json.loads((work / "out.json").read_text())


def test_the_api_never_holds_the_catalog_between_requests():
    results = run_requests()
    assert len(results) == len(REQUESTS)
    failed = [r for r in results if r["status"] >= 500]
    assert not failed, f"requests failed: {failed}"
    held = [r for r in results if not r["ok"] or r["seconds"] >= 1.0]
    assert not held, f"another process could not open the catalog for writing after: {held}"


if __name__ == "__main__":
    _child(Path(sys.argv[1]))
