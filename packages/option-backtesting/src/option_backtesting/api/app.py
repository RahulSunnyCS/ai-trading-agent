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
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from starlette.middleware.gzip import GZipMiddleware

from ..config import resolve_cache_dir
from ..data.cache import InvalidUnderlyingError
from .correlation_routes import router as correlation_router
from .legwise_routes import router as legwise_router
from .rotation_shadow_routes import router as rotation_shadow_router
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
    # Backtest results and day curves are large JSON; small bodies are not worth compressing.
    app.add_middleware(GZipMiddleware, minimum_size=1000)

    @app.exception_handler(InvalidUnderlyingError)
    async def _invalid_underlying(_request: Request, exc: InvalidUnderlyingError) -> JSONResponse:
        return JSONResponse(status_code=400, content={"detail": str(exc)})

    app.include_router(router)
    app.include_router(legwise_router)
    app.include_router(correlation_router)
    app.include_router(rotation_shadow_router)
    return app


def main() -> None:
    from ..fyers.auth import load_dotenv

    # Before create_app: BACKTEST_DATA_DIR (read by resolve_cache_dir), TRADING_DATA_ROOT etc.
    # may live only in the repo .env when started outside dev-stack (`bun run py:api`). No
    # module-level app, so importing this module never resolves config before the .env loads.
    load_dotenv()
    uvicorn.run(create_app(), host="127.0.0.1", port=8000)


if __name__ == "__main__":
    main()
