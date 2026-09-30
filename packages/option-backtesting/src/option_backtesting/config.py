"""
Shared env-driven default path for the Parquet bar cache — both the FastAPI
service (api/app.py) and the MCP server (mcp/server.py) need the same
`BACKTEST_DATA_DIR`-derived resolution, so it lives here once rather than
being duplicated in each entry point.

The run registry moved to the shared `trading_data` catalog (2026-09-30,
see `engine/registry.py`'s module docstring) — it no longer has a path to
resolve here, only a `TRADING_DATA_ROOT`-rooted `connect()`.
"""

from __future__ import annotations

import os
from pathlib import Path

from .data.ingest import DEFAULT_CACHE_DIR


def resolve_cache_dir() -> Path:
    data_dir = os.environ.get("BACKTEST_DATA_DIR")
    return Path(data_dir) / "cache" if data_dir else DEFAULT_CACHE_DIR
