"""The Rotation pages' Slippage switch (owner, 2026-10-30): `?slippage=0.5` on a GET under
`/legwise/rotation` or `/legwise/correlation` reads every stored result for that request from its
0.5% slippage copy (`rotation.store.slipped`, `rotation.slip_store`); absent or `0` reads them as
stored. Any other value is a 422. Display only: the routes that explain the ranking or compare live
fills with paper (`EXCLUDED`) always read the stored figures and ignore the parameter.

A pure ASGI middleware, so the read slippage (a context variable) is set around the whole request,
sync routes included (their thread pool runs with a copy of the request's context).
"""

from __future__ import annotations

from urllib.parse import parse_qs

from starlette.responses import JSONResponse
from starlette.types import ASGIApp, Receive, Scope, Send

from ..rotation import store

PREFIXES = ("/legwise/rotation", "/legwise/correlation")
EXCLUDED = ("/legwise/rotation/explain", "/legwise/rotation/ic", "/legwise/rotation/live")


def applies(path: str) -> bool:
    def under(prefix: str) -> bool:
        return path == prefix or path.startswith(prefix + "/")

    return any(under(p) for p in PREFIXES) and not any(under(p) for p in EXCLUDED)


def parse(query_string: bytes) -> float | str:
    """The requested slippage, or the error message for a bad value."""
    values = parse_qs(query_string.decode("latin-1")).get("slippage", [])
    if not values:
        return 0.0
    choices = ", ".join(f"{c:g}" for c in store.SLIP_CHOICES)
    try:
        pct = float(values[-1])
    except ValueError:
        return f"slippage must be one of {choices}"
    return pct if pct in store.SLIP_CHOICES else f"slippage must be one of {choices}"


class SlippageMiddleware:
    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http" or not applies(scope.get("path", "")):
            await self.app(scope, receive, send)
            return
        pct = parse(scope.get("query_string", b""))
        if isinstance(pct, str):
            await JSONResponse(status_code=422, content={"error": pct})(scope, receive, send)
            return
        with store.slipped(pct):
            await self.app(scope, receive, send)
