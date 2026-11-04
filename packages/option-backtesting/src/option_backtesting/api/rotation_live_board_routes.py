"""`/legwise/rotation/live-board`: the Rotation page's Live board card (BL-203). The figures are
`rotation/live_board.py`'s; nothing here computes one.

    GET  /legwise/rotation/live-board          today's snapshot (else the newest), whether a
                                               refresh is running, the last error, the loop's
                                               next refresh
    POST /legwise/rotation/live-board/refresh  refresh now. With the 5-minute loop running it is
                                               asked (202 {"status": "requested"}), so no second
                                               login is made; before the day's picks are recorded
                                               (the 09:16 entry) nothing is read and no login is
                                               made (202 {"status": "no_picks"}, the card's note
                                               says so); else ONE guarded Angel One login runs
                                               the refresh in a background thread (202
                                               {"status": "started"}), 409 while the login guard's
                                               lock is held, 429 (+ Retry-After) in its cool-down
                                               or a hold after a refused login

Nothing returned is a token, PIN or key. Errors are `{"error": ...}`, as in `angel_routes.py`.
"""

from __future__ import annotations

import sys
import threading

from fastapi import APIRouter
from fastapi.responses import JSONResponse

from ..angelone import check
from ..angelone.auth import AngelCredentialsError
from ..rotation import live_board

router = APIRouter(prefix="/legwise/rotation/live-board")


@router.get("")
def get_board() -> dict:
    return live_board.read_board()


def _run(pending: check.Pending) -> None:
    """The background refresh: the login, then the refresh under the same lock."""
    try:
        result, session, _ = pending.attempt()
        if session is None:
            live_board.record_error(f"Angel One login failed: {result.message}")
            return
        live_board.refresh(session, by="button", log=lambda _m: None)
    except AngelCredentialsError as error:  # refresh() re-raises it unrecorded, for the loop
        live_board.record_error(str(error))
    except Exception as error:  # noqa: BLE001 - recorded by refresh(); nothing above a thread
        print(f"live board refresh failed: {type(error).__name__}: {error}", file=sys.stderr)
    finally:
        pending.release()


@router.post("/refresh", response_model=None)
def post_refresh() -> JSONResponse:
    if live_board.loop_status()["running"]:
        live_board.request_refresh()
        return JSONResponse(status_code=202, content={"status": "requested"})
    # Picks first, login second (as the loop's Board.refresh does): a Refresh pressed before the
    # 09:16 entry would otherwise spend an Angel One login on nothing, counting toward the day's
    # logins and able to collide with the 08:15 AlgoTest broker login (2026-11-04).
    day = live_board.now_ist().date()
    if not live_board.todays_picks(day):
        live_board.note_no_picks(day)
        return JSONResponse(status_code=202, content={"status": "no_picks", "day": day.isoformat()})
    try:
        pending = check.begin("live-board")
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
            status_code=503, content={"error": f"the refresh could not be started: {error}"}
        )
    live_board.mark_refreshing(by="button")
    threading.Thread(target=_run, args=(pending,), name="live-board", daemon=True).start()
    return JSONResponse(
        status_code=202, content={"status": "started", "started_at": pending.started_at}
    )
