"""Look-ahead check on whole requests, not search configs (BL-010 Phase 2 step 4, extended).

`mbt audit lookahead` re-runs stored search configs through the search's own runner. This module
instead takes a complete `BacktestRequest` (a saved favourite, a frozen config) and posts it to
the real API twice: once on the live database with `end` set to a cut date, and once on a copy of
the database that holds nothing after that date. The orders and the equity curve must be the same.

That reaches what the search runner does not: the point-in-time `turnover_rank` universe, which is
the dashboard's default and what every favourite uses, and the followed strategy as it is saved.
The golden look-ahead test cannot, because its fixture has too few stocks to build a turnover rank.

What a cut-off test cannot see is hindsight stored without a date (category tags, today's ETF
list). See `truncate.py`.
"""

from __future__ import annotations

import json
import math
import os
import subprocess
import sys
import tempfile
from datetime import date
from pathlib import Path
from typing import Any

from . import truncate

#: Parts of a response that carry the run's result. `comparisons` and `benchmarks` are left out:
#: they read reference files from the data folder, which a database cut does not touch.
RESULT_KEYS = (
    "kpis",
    "series",
    "trades",
    "rotations",
    "yearly",
    "open_positions",
    "companion",
)

#: Fields that honestly depend on later data (see tests/golden/test_lookahead.py).
NOT_COMPARED = {"price", "proxy", "proxy_trades"}

REL_TOL = 1e-9


def requests_from_catalog(names: list[str]) -> dict[str, dict]:
    """label -> request dict for saved favourites. `names` match a group's name (every member
    sleeve is returned, labelled `<group> #<n>`) or a single favourite's name, exactly."""
    from .. import db_read, runs_store

    found: dict[str, dict] = {}
    with db_read.read_catalog() as con:
        groups = runs_store.list_groups(con)
        favourites = runs_store.list_favorites(con, include_groups=False)
    for name in names:
        hits = False
        for group in groups:
            if group["name"] == name:
                hits = True
                for i, member in enumerate(group["members"], 1):
                    found[f"{name} #{i}"] = member["config"]
        for record in favourites:
            if record["name"] == name and not record.get("member_of"):
                hits = True
                found[name] = record["config"]
        if not hits:
            raise ValueError(f"no saved favourite or group named {name!r}")
    return found


def requests_from_frozen(frozen_path: Path, *, first: int | None = None) -> dict[str, dict]:
    """label -> request dict for the configs of a Phase 6 frozen record."""
    from .. import phase6

    frozen = json.loads(frozen_path.read_text())
    requests = phase6.favourite_requests(frozen)
    ids = [cfg["id"] for cfg in frozen["configs"]]
    pairs = list(zip(ids, requests, strict=True))
    return dict(pairs[:first] if first else pairs)


def _comparable(value: Any) -> Any:
    if isinstance(value, dict):
        return {k: _comparable(v) for k, v in value.items() if k not in NOT_COMPARED}
    if isinstance(value, list):
        items = [_comparable(v) for v in value]
        # A week's holdings are listed by weight, and equal weights tie-break on float noise:
        # list them by name instead (as tests/golden/harness.py does).
        if items and all(isinstance(i, dict) and set(i) == {"asset", "share"} for i in items):
            items.sort(key=lambda i: str(i["asset"]))
        return items
    return value


def differences(old: Any, new: Any, where: str = "", limit: int = 12) -> list[str]:
    """Where two payloads differ, as readable lines."""
    out: list[str] = []

    def walk(a: Any, b: Any, path: str) -> None:
        if len(out) >= limit:
            return
        if isinstance(a, dict) and isinstance(b, dict):
            for key in sorted(set(a) | set(b)):
                if key not in b:
                    out.append(f"{path}{key}: only in the full-database run")
                elif key not in a:
                    out.append(f"{path}{key}: only in the cut run")
                else:
                    walk(a[key], b[key], f"{path}{key}.")
        elif isinstance(a, list) and isinstance(b, list):
            if len(a) != len(b):
                out.append(f"{path[:-1]}: {len(a)} items against {len(b)}")
            for i, (x, y) in enumerate(zip(a, b, strict=False)):
                walk(x, y, f"{path}{i}.")
        elif (
            isinstance(a, (int, float))
            and isinstance(b, (int, float))
            and not isinstance(a, bool)
            and not isinstance(b, bool)
        ):
            if math.isnan(a) or math.isnan(b):
                # abs(nan - x) > tol is False, so NaN against a number must be caught here.
                if not (math.isnan(a) and math.isnan(b)):
                    out.append(f"{path[:-1]}: {a!r} against {b!r}")
            elif math.isinf(a) or math.isinf(b):
                if a != b:
                    out.append(f"{path[:-1]}: {a!r} against {b!r}")
            elif abs(a - b) > REL_TOL * max(abs(a), abs(b), 1e-12):
                out.append(f"{path[:-1]}: {a!r} against {b!r}")
        elif a != b:
            out.append(f"{path[:-1]}: {a!r} against {b!r}")

    walk(old, new, where)
    return out


def compare(whole: dict, cut: dict) -> list[str]:
    """Differences between two run outputs `{status, response}` over the result keys."""
    if whole["status"] != 200 or cut["status"] != 200:
        return [f"status {whole['status']} against {cut['status']}: {str(whole['response'])[:200]}"]
    found: list[str] = []
    for key in RESULT_KEYS:
        found += differences(
            _comparable(whole["response"].get(key)),
            _comparable(cut["response"].get(key)),
            f"{key}.",
        )
    return found


def _child(requests_file: Path, out_file: Path, end: str) -> None:
    """Post each request, with `end` set, to the real API and keep the result keys."""
    from fastapi.testclient import TestClient

    from momentum_backtesting import api

    client = TestClient(api.create_app())
    out = {}
    for label, request in json.loads(requests_file.read_text()).items():
        response = client.post("/api/backtest", json={**request, "end": end})
        body = response.json()
        out[label] = {
            "status": response.status_code,
            "response": {k: body.get(k) for k in RESULT_KEYS}
            if response.status_code == 200
            else body,
        }
    out_file.write_text(json.dumps(out))


def _run(requests_file: Path, out_file: Path, end: str, env: dict[str, str]) -> dict:
    done = subprocess.run(
        [
            sys.executable,
            "-m",
            "momentum_backtesting.audit.request_lookahead",
            str(requests_file),
            str(out_file),
            end,
        ],
        env=env,
        capture_output=True,
        text=True,
        check=False,
    )
    if done.returncode != 0:
        raise RuntimeError(f"run to {end} failed:\n{done.stderr[-3000:]}")
    return json.loads(out_file.read_text())


def check(
    requests: dict[str, dict], cuts: list[str], out_dir: Path, *, echo=print
) -> dict[str, dict[str, list[str]]]:
    """cut -> label -> differences ([] = the same). Never writes to the live database or data
    folder: both runs use a scratch data folder, and the cut run a copy of the database."""
    from trading_data.db import data_root

    other = sorted(label for label, req in requests.items() if req.get("dataset") != "broad")
    if other:
        # The scratch data folder holds no files, which the ETF, Stock and Custom Index datasets
        # may read; only Broad is known to run from the database alone.
        raise ValueError(f"only Broad requests are supported, not: {other}")
    out_dir.mkdir(parents=True, exist_ok=True)
    requests_file = out_dir / "requests.json"
    requests_file.write_text(json.dumps(requests, indent=1))
    report: dict[str, dict[str, list[str]]] = {}
    with tempfile.TemporaryDirectory(prefix="mbt-lookahead-data-") as scratch:
        base_env = {
            **os.environ,
            "MOMENTUM_DATA_DIR": scratch,
            "PYTHONHASHSEED": "0",
        }
        for secret in ("FYERS_ACCESS_TOKEN", "FYERS_APP_ID"):
            base_env.pop(secret, None)
        for day in cuts:
            whole = _run(requests_file, out_dir / f"whole_{day}.json", day, base_env)
            with tempfile.TemporaryDirectory(prefix="mbt-cut-") as tmp:
                truncate.truncated_root(data_root(), Path(tmp), date.fromisoformat(day))
                cut = _run(
                    requests_file,
                    out_dir / f"cut_{day}.json",
                    day,
                    {**base_env, "TRADING_DATA_ROOT": tmp},
                )
            report[day] = {}
            for label in requests:
                found = compare(whole[label], cut[label])
                report[day][label] = found
                kpis = (whole[label]["response"] or {}).get("kpis") or {}
                cagr = kpis.get("cagr") if isinstance(kpis, dict) else None
                echo(
                    f"{day} {label}: "
                    + ("same" if not found else "DIFFERENT: " + "; ".join(found[:4]))
                    + (f" (CAGR {cagr:.2%})" if isinstance(cagr, (int, float)) else "")
                )
    (out_dir / "report.json").write_text(json.dumps(report, indent=1))
    return report


if __name__ == "__main__":
    _child(Path(sys.argv[1]), Path(sys.argv[2]), sys.argv[3])
