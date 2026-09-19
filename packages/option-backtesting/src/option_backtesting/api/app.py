"""
The FastAPI service — loopback-only (bind 127.0.0.1), never exposed
publicly. The Fastify proxy (`apps/server/src/server/routes/backtest.ts`)
is the only public-facing surface in front of this; it applies access
gating, credit consumption, a body-size cap, and a timeout before ever
reaching here.
"""

from __future__ import annotations

from pathlib import Path

import uvicorn
from fastapi import FastAPI

from ..config import resolve_cache_dir, resolve_registry_db
from .routes import router


def create_app(cache_dir: Path | None = None, registry_db: Path | None = None) -> FastAPI:
    """Factory rather than a bare module-level app so tests can point a
    fresh instance at a temp cache/registry without touching real data.
    `cache_dir`/`registry_db` default to `BACKTEST_DATA_DIR`-derived paths
    (or the package's own defaults) read at call time, matching the CLI's
    own env-driven defaults."""
    app = FastAPI(title="option-backtesting", version="0.1.0")
    app.state.cache_dir = cache_dir or resolve_cache_dir()
    app.state.registry_db = registry_db or resolve_registry_db()
    app.include_router(router)
    return app


app = create_app()


def main() -> None:
    uvicorn.run(app, host="127.0.0.1", port=8000)


if __name__ == "__main__":
    main()
