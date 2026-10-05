"""Runs golden scenarios against the frozen fixture, in a process of its own (BL-001).

`config.DATA_DIR` and the data root are read when the package is imported, so they cannot be
swapped inside a test process that already imported it. The parent (`run_scenarios`) sets the
environment and starts this file as a script; the child builds a throwaway database from the
fixture, posts each scenario to the real API through FastAPI's test client, and writes what
came back.
"""

from __future__ import annotations

import gzip
import json
import math
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

GOLDEN = Path(__file__).resolve().parent
FIXTURE = GOLDEN / "fixture"
EXPECTED = GOLDEN / "expected"
#: Two numbers closer than this, relatively, are the same number (macOS vs Linux float noise).
REL_TOL = 1e-9
SIGNIFICANT_DIGITS = 10
#: Parts of a response that describe the run, not its result, and change by themselves.
VOLATILE_KEYS = frozenset({"elapsed_ms", "computed_at", "cache", "provenance"})


def normalise(value):
    """Floats to 10 significant digits (NaN and infinities as text), volatile keys dropped,
    each week's holdings in name order."""
    if isinstance(value, dict):
        return {k: normalise(v) for k, v in value.items() if k not in VOLATILE_KEYS}
    if isinstance(value, list):
        items = [normalise(v) for v in value]
        # A week's holdings are listed by weight, and equal weights tie-break on float noise
        # that differs between machines: list them by name instead.
        if items and all(isinstance(i, dict) and set(i) == {"asset", "share"} for i in items):
            items.sort(key=lambda i: i["asset"])
        return items
    if isinstance(value, float):
        if math.isnan(value) or math.isinf(value):
            return str(value)
        return float(f"{value:.{SIGNIFICANT_DIGITS}g}")
    return value


def build_inputs(root: Path, data_dir: Path, cutoff: str | None = None) -> None:
    """The fixture as a live database and data folder. `cutoff` (YYYY-MM-DD) leaves out every
    row after that day, as if the run were happening then: the look-ahead test's input."""
    import duckdb
    import pandas as pd
    from trading_data.db import connect

    date_columns = {
        "momentum_prices": "date",
        "stock_weekly_prices": "week",
        "stock_weekly_series": "week",
        "stock_membership_weekly": "week",
        "stock_action_candidates": "ex_date",
        "stock_action_reviews": "ex_date",
    }
    with connect(root) as con:
        for path in sorted((FIXTURE / "tables").glob("*.parquet")):
            where = ""
            if cutoff and path.stem in date_columns:
                where = f" WHERE {date_columns[path.stem]} <= DATE '{cutoff}'"
            con.execute(
                f"INSERT INTO {path.stem} BY NAME SELECT * FROM read_parquet('{path.as_posix()}')"
                + where
            )
    for source in sorted((FIXTURE / "lake").rglob("data.parquet")):
        target = root / "lake" / source.relative_to(FIXTURE / "lake")
        target.parent.mkdir(parents=True, exist_ok=True)
        if cutoff is None:
            shutil.copy2(source, target)
            continue
        kept = duckdb.sql(
            f"SELECT * FROM read_parquet('{source.as_posix()}') WHERE date <= DATE '{cutoff}'"
        ).df()
        if len(kept):
            kept.to_parquet(target, index=False)
    for source in sorted(p for p in (FIXTURE / "files").rglob("*") if p.is_file()):
        target = data_dir / source.relative_to(FIXTURE / "files")
        target.parent.mkdir(parents=True, exist_ok=True)
        if cutoff is None:
            shutil.copy2(source, target)
            continue
        frame = pd.read_csv(source)
        frame[pd.to_datetime(frame.iloc[:, 0]) <= pd.Timestamp(cutoff)].to_csv(target, index=False)


def _child(scenario_file: Path, out_file: Path) -> None:
    from fastapi.testclient import TestClient

    from momentum_backtesting import api

    cutoff = os.environ.get("GOLDEN_CUTOFF") or None
    build_inputs(
        Path(os.environ["TRADING_DATA_ROOT"]), Path(os.environ["MOMENTUM_DATA_DIR"]), cutoff
    )
    client = TestClient(api.create_app())
    results = {}
    for name, request in json.loads(scenario_file.read_text()).items():
        if "$meta" in request:  # "what a fresh dashboard run of this dataset shows"
            dataset = request["$meta"]
            meta = client.get("/api/meta", params={"dataset": dataset}).json()
            # The universe the dashboard sends for a fresh run of this dataset.
            universe = (
                ["broad_momentum"]
                if dataset == "broad"
                else [
                    item["name"]
                    for item in meta["instruments"]
                    if item["has_data"] and item["include"] != "optional"
                ]
            )
            request = {
                **meta["defaults"],
                "dataset": dataset,
                "universe": universe,
                **request.get("with", {}),
            }
        response = client.post("/api/backtest", json=request)
        detail = response.json().get("detail") if response.status_code == 422 else None
        if isinstance(detail, str) and detail.startswith("weekly closes are missing ["):
            # The trimmed fixture cannot price every category the full data can. Drop the ones
            # the API names and run on the rest; the request actually used is what is recorded.
            import ast

            missing = set(ast.literal_eval(detail[detail.index("[") : detail.rindex("]") + 1]))
            request = {**request, "universe": [n for n in request["universe"] if n not in missing]}
            response = client.post("/api/backtest", json=request)
        results[name] = {
            "request": request,
            "status": response.status_code,
            "response": normalise(response.json()),
        }
    out_file.write_text(json.dumps(results))


def run_scenarios(scenarios: dict[str, dict], cutoff: str | None = None) -> dict[str, dict]:
    """name -> {request, status, response} for each scenario, from a fresh process and a fresh
    database built from the fixture."""
    with tempfile.TemporaryDirectory(prefix="mbt-golden-") as tmp:
        work = Path(tmp)
        (work / "scenarios.json").write_text(json.dumps(scenarios))
        env = {
            **os.environ,
            "TRADING_DATA_ROOT": str(work / "root"),
            "MOMENTUM_DATA_DIR": str(work / "data"),
            "GOLDEN_CUTOFF": cutoff or "",
            "PYTHONHASHSEED": "0",
        }
        for secret in ("DATABASE_URL", "FYERS_ACCESS_TOKEN", "FYERS_APP_ID"):
            env.pop(secret, None)
        done = subprocess.run(
            [
                sys.executable,
                str(Path(__file__)),
                str(work / "scenarios.json"),
                str(work / "out.json"),
            ],
            env=env,
            capture_output=True,
            text=True,
            check=False,
        )
        if done.returncode != 0:
            raise RuntimeError(f"golden harness failed:\n{done.stderr[-4000:]}")
        return json.loads((work / "out.json").read_text())


def load_expected(name: str) -> dict | None:
    path = EXPECTED / f"{name}.json.gz"
    if not path.exists():
        return None
    with gzip.open(path, "rt", encoding="utf-8") as handle:
        return json.load(handle)


def write_expected(results: dict[str, dict]) -> None:
    """One gzipped file per scenario (the full response: several hundred KB as plain JSON), and
    `summary.json` with each scenario's headline figures, which git can show a diff of."""
    EXPECTED.mkdir(exist_ok=True)
    for stale in EXPECTED.glob("*.json.gz"):
        if stale.name.removesuffix(".json.gz") not in results:
            stale.unlink()
    for name, result in results.items():
        # mtime=0 and a fixed filename keep the bytes identical when the content is.
        with (
            open(EXPECTED / f"{name}.json.gz", "wb") as raw,
            gzip.GzipFile(filename="", mode="wb", fileobj=raw, mtime=0) as handle,
        ):
            handle.write(json.dumps(result, sort_keys=True).encode())
    summary = {
        name: {"status": result["status"], "kpis": result["response"].get("kpis")}
        for name, result in sorted(results.items())
    }
    (EXPECTED / "summary.json").write_text(json.dumps(summary, indent=1, sort_keys=True) + "\n")


def differences(expected, actual, path: str = "", limit: int = 40) -> list[str]:
    """Where two results differ, as readable lines: `kpis.cagr: 0.2458 -> 0.2461`."""
    out: list[str] = []

    def walk(old, new, where: str) -> None:
        if len(out) >= limit:
            return
        if isinstance(old, dict) and isinstance(new, dict):
            for key in sorted(set(old) | set(new)):
                if key not in new:
                    out.append(f"{where}{key}: removed")
                elif key not in old:
                    out.append(f"{where}{key}: added")
                else:
                    walk(old[key], new[key], f"{where}{key}.")
        elif isinstance(old, list) and isinstance(new, list):
            if len(old) != len(new):
                out.append(f"{where[:-1]}: {len(old)} items -> {len(new)}")
            for i, (a, b) in enumerate(zip(old, new, strict=False)):
                walk(a, b, f"{where}{i}.")
        elif (
            isinstance(old, (int, float))
            and isinstance(new, (int, float))
            and not (isinstance(old, bool) or isinstance(new, bool))
        ):
            if not math.isclose(old, new, rel_tol=REL_TOL, abs_tol=1e-9):
                out.append(f"{where[:-1]}: {old!r} -> {new!r}")
        elif old != new:
            out.append(f"{where[:-1]}: {old!r} -> {new!r}")

    walk(expected, actual, path)
    return out


if __name__ == "__main__":
    _child(Path(sys.argv[1]), Path(sys.argv[2]))
