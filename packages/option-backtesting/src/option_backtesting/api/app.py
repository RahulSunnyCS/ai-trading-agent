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

from ..config import resolve_cache_dir
from .legwise_routes import router as legwise_router
from .routes import router


def create_app(cache_dir: Path | None = None) -> FastAPI:
    """Factory rather than a bare module-level app so tests can point a
    fresh instance at a temp cache without touching the real committed one.
    `cache_dir` defaults to the `BACKTEST_DATA_DIR`-derived path (or the
    package's own default) read at call time, matching the CLI's own
    env-driven default. The run registry has no path to inject here any
    more — it lives in the shared `trading_data` catalog, rooted at
    `TRADING_DATA_ROOT` (tests isolate this via an autouse fixture, see
    tests/conftest.py)."""
    app = FastAPI(title="option-backtesting", version="0.1.0")
    app.state.cache_dir = cache_dir or resolve_cache_dir()
    app.include_router(router)
    app.include_router(legwise_router)
    return app


app = create_app()


def main() -> None:
    from ..fyers.auth import load_dotenv

    load_dotenv()  # TRADING_DATA_ROOT etc. when started outside dev-stack (`bun run py:api`)
    uvicorn.run(app, host="127.0.0.1", port=8000)


if __name__ == "__main__":
    main()
