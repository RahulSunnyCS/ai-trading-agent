"""
Raw AlgoTest response storage — the tracked source of truth (see README's
"Data ingestion" section and DECISIONS.md).

One file per planned request (as produced by
`providers.algotest.plan_requests`), keyed by underlying/timeframe/data_kind/
strike_rule/leg and the [start_date, end_date] range actually requested.
Each file holds the verbatim MCP response alongside the request that
produced it, so `ingest.py` can rebuild Parquet deterministically and
`data_hash` (the reproducibility key) can be computed over these files
directly.
"""

from __future__ import annotations

import json
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

DEFAULT_RAW_DIR = Path(__file__).parent.parent.parent.parent / "data" / "raw" / "algotest"


def raw_path(base_dir: Path, request: dict[str, Any]) -> Path:
    """Deterministic file path for one planned request. `request` is one
    entry from `plan_requests()` (must include `raw_key`, `start_date`,
    `end_date`)."""
    rk = request["raw_key"]
    underlying = rk["underlying"]
    timeframe = rk["timeframe"]
    data_kind = rk["data_kind"]
    strike_rule = rk["strike_rule"] or "na"
    leg = rk["leg"] or "na"
    range_part = f"{request['start_date']}_{request['end_date']}"
    filename = f"{strike_rule}_{leg}__{range_part}.json"
    return base_dir / underlying / timeframe / data_kind / filename


def write_raw(
    base_dir: Path,
    request: dict[str, Any],
    response: dict[str, Any],
    *,
    provider: str = "algotest",
    fetched_at: datetime | None = None,
) -> Path:
    """Write one raw response manifest. Overwrites any existing file for the
    same request (re-running a backfill for the same range is expected to be
    idempotent at the raw layer — quality/ingest decide what to do with
    duplicate content)."""
    path = raw_path(base_dir, request)
    path.parent.mkdir(parents=True, exist_ok=True)
    manifest = {
        "request": {k: v for k, v in request.items() if k != "raw_key"},
        "fetched_at": (fetched_at or datetime.now(UTC)).isoformat(),
        "provider": provider,
        "response": response,
    }
    path.write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n")
    return path


def read_raw(path: Path) -> dict[str, Any]:
    with open(path) as f:
        return json.load(f)


def iter_raw_files(
    base_dir: Path,
    underlying: str,
    *,
    timeframe: str | None = None,
) -> list[Path]:
    """List every raw file for an underlying (optionally filtered to one
    timeframe), sorted for deterministic processing order."""
    root = base_dir / underlying
    if not root.exists():
        return []
    pattern = f"{timeframe}/**/*.json" if timeframe else "**/*.json"
    return sorted(root.glob(pattern))
