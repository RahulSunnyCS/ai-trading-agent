"""
Shared env-driven default paths — both the FastAPI service (api/app.py) and
the MCP server (mcp/server.py) need the same `BACKTEST_DATA_DIR`-derived
resolution for the Parquet cache and the run registry, so it lives here
once rather than being duplicated in each entry point.
"""

from __future__ import annotations

import os
from pathlib import Path

from .data.ingest import DEFAULT_CACHE_DIR
from .engine.registry import DEFAULT_REGISTRY_DB


def resolve_cache_dir() -> Path:
    data_dir = os.environ.get("BACKTEST_DATA_DIR")
    return Path(data_dir) / "cache" if data_dir else DEFAULT_CACHE_DIR


def resolve_registry_db() -> Path:
    data_dir = os.environ.get("BACKTEST_DATA_DIR")
    return Path(data_dir) / "registry.sqlite" if data_dir else DEFAULT_REGISTRY_DB
