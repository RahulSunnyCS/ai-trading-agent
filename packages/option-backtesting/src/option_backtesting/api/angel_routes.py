"""`/legwise/angel/*`: the Angel One card on the dashboard's Broker logins page.

    GET  /legwise/angel/status   which settings are set (names only), the masked client code,
                                 the last check, the last Angel One collection, whether the guard's
                                 lock is held (and by a test or a collection), the cool-down and a
                                 hold after a refused login
    POST /legwise/angel/test     ONE SmartAPI login (`angelone/check.py`, source "manual"). Answers
                                 at once: 202 {"status": "started"} once the guard is passed and
                                 the lock taken (the login runs in a background thread; the card
                                 reads the result from the status), 409 while the lock is held,
                                 429 (+ Retry-After) during the cool-down or a hold. Quick, so a
                                 hosted dashboard never meets a gateway timeout.

Nothing returned is a token, PIN, TOTP code or API key. Errors are `{"error": ...}` (what the
dashboard's api.ts reads), as in `favourites_routes.py`.
"""

from __future__ import annotations

import threading

from fastapi import APIRouter
from fastapi.responses import JSONResponse

from ..angelone import check

router = APIRouter(prefix="/legwise/angel")


@router.get("/status")
def angel_status() -> dict:
    return check.status()


@router.post("/test", response_model=None)
def angel_test() -> JSONResponse:
    try:
        pending = check.begin("manual")
    except check.CheckRefused as refused:
        if refused.kind in ("cooldown", "held"):
            return JSONResponse(
                status_code=429,
                content={
                    "error": str(refused),
                    "kind": refused.kind,
                    "retry_after_s": refused.retry_after_s,
                },
                headers={"Retry-After": str(refused.retry_after_s)},
            )
        return JSONResponse(status_code=409, content={"error": str(refused), "kind": refused.kind})
    except (OSError, RuntimeError) as error:  # the data root is not mounted or not writable
        return JSONResponse(
            status_code=503,
            content={"error": f"the connection test could not be started: {error}"},
        )
    threading.Thread(target=pending.run_quietly, name="angel-test", daemon=True).start()
    return JSONResponse(
        status_code=202, content={"status": "started", "started_at": pending.started_at}
    )
