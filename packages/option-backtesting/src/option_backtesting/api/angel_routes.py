"""`/legwise/angel/*`: the Angel One card on the dashboard's Broker logins page.

    GET  /legwise/angel/status   which credentials are set (names only), the masked client code,
                                 the last connection check, the last Angel One collection, and
                                 whether a check is running or cooling down
    POST /legwise/angel/test     ONE SmartAPI login now (`angelone/check.py`, source "manual"):
                                 200 {"result": {...}} whether the login worked or not; 409 while
                                 another check runs; 429 (+ Retry-After) during the cool-down

Nothing returned is a token, PIN, TOTP code or API key. Errors are `{"error": ...}` (what the
dashboard's api.ts reads), as in `favourites_routes.py`.
"""

from __future__ import annotations

from fastapi import APIRouter
from fastapi.responses import JSONResponse

from ..angelone import check

router = APIRouter(prefix="/legwise/angel")


@router.get("/status")
def angel_status() -> dict:
    return check.status()


@router.post("/test", response_model=None)
def angel_test() -> dict | JSONResponse:
    try:
        result = check.run_check("manual")
    except check.CheckRefused as refused:
        if refused.kind == "cooldown":
            return JSONResponse(
                status_code=429,
                content={"error": str(refused), "retry_after_s": refused.retry_after_s},
                headers={"Retry-After": str(refused.retry_after_s)},
            )
        return JSONResponse(status_code=409, content={"error": str(refused)})
    except (OSError, RuntimeError) as error:  # the data root is not mounted or not writable
        return JSONResponse(
            status_code=503,
            content={"error": f"the connection test could not be recorded: {error}"},
        )
    return {"result": result.as_dict()}
