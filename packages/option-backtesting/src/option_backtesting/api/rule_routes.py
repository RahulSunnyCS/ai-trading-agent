"""`/legwise/rules/*`: state a rule strategy, read it back, test it over the collected days
(BL-120).
The maths is `ruletest/`; nothing here computes a figure. A test is a background job (minutes the
first time a template is simulated), one at a time, and every test is written to the ledger.

    POST /legwise/rules/validate   {text}                         the spec checked and read back
    POST /legwise/rules/test       {text, periods, mode, tries}   start a test (403 while locked)
    GET  /legwise/rules/job                                      the running or last test's progress
    GET  /legwise/rules/tests                                    the ledger, newest first, count
    GET  /legwise/rules/tests/{id}                               one test's full result
    POST /legwise/rules/reveal     {spec_hash}                    open the confirmation period, once
    GET  /legwise/rules/periods                                  the learning / confirmation dates

The spec text is parsed with `yaml.safe_load` and validated; no path is ever taken from the client.
Errors come back as `{"error": ...}`.
"""

from __future__ import annotations

import os
import threading
import traceback
from dataclasses import dataclass, field
from typing import Any

from fastapi import APIRouter
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from ..ruletest import store, study
from ..ruletest.spec import SpecError, load_spec, read_back

router = APIRouter(prefix="/legwise/rules")
MAX_TEXT = 20_000


def _error(status: int, message: str) -> JSONResponse:
    return JSONResponse(status_code=status, content={"error": message})


class SpecBody(BaseModel):
    text: str = Field(max_length=MAX_TEXT)


class TestBody(SpecBody):
    periods: list[str] = Field(default_factory=lambda: ["learning"])
    mode: str = "locked"
    tries: int = Field(default=1, ge=1, le=500)


class RevealBody(BaseModel):
    spec_hash: str = Field(pattern=r"^[0-9a-f]{16}$")
    note: str = Field(default="", max_length=200)


def _root():
    from ..fyers.daily import data_dir

    return data_dir()


@router.post("/validate")
def validate(body: SpecBody) -> Any:
    try:
        rule = load_spec(body.text)
    except SpecError as error:
        return _error(422, str(error))
    return {
        "ok": True,
        "spec_hash": rule.spec_hash,
        "template_hash": rule.template_hash,
        "sides": list(rule.sides),
        "window": [rule.spec.window.from_, rule.spec.window.to],
        **read_back(rule),
    }


@router.get("/periods")
def periods() -> dict[str, Any]:
    return {
        "periods": {k: [a.isoformat(), b.isoformat()] for k, (a, b) in study.PERIODS.items()},
        "data_cutoff": study.DATA_CUTOFF.isoformat(),
        "min_event_days": study.MIN_EVENT_DAYS,
    }


@dataclass
class _Job:
    state: str = "idle"  # idle | running | done | failed
    spec_hash: str | None = None
    started: str | None = None
    finished: str | None = None
    test_id: str | None = None
    log: list[str] = field(default_factory=list)


_job = _Job()
_lock = threading.Lock()


def _run(rule, text: str, options: study.Options) -> None:
    try:
        result = study.run_test(_root(), rule, text, options)
        _job.test_id = result["id"]
        _job.state = "done"
    except Exception as error:  # surfaced to the page, never swallowed
        _job.log.append(f"failed: {error}")
        _job.log.append(traceback.format_exc(limit=3))
        _job.state = "failed"
    finally:
        _job.finished = store.now().isoformat(timespec="seconds")


@router.post("/test")
def start_test(body: TestBody) -> Any:
    try:
        rule = load_spec(body.text)
    except SpecError as error:
        return _error(422, str(error))
    if body.mode not in ("locked", "exploratory"):
        return _error(422, "mode must be locked or exploratory")
    if not body.periods or any(p not in study.PERIODS for p in body.periods):
        return _error(422, f"periods must come from {', '.join(study.PERIODS)}")
    try:
        for period in body.periods:
            study.check_allowed(_root(), rule, period, body.mode)
    except store.LockedError as error:
        return _error(403, str(error))
    except store.RuleTestError as error:
        return _error(422, str(error))
    with _lock:
        if _job.state == "running":
            return _error(409, "a test is already running")
        _job.state, _job.spec_hash, _job.test_id = "running", rule.spec_hash, None
        _job.started, _job.finished, _job.log = store.now().isoformat(timespec="seconds"), None, []
        options = study.Options(
            periods=tuple(body.periods),
            mode=body.mode,
            workers=int(os.environ.get("RULETEST_WORKERS", "4")),
            tries=body.tries,
            progress=_job.log.append,
        )
        threading.Thread(target=_run, args=(rule, body.text, options), daemon=True).start()
    return {"state": _job.state, "spec_hash": rule.spec_hash}


@router.get("/job")
def job() -> dict[str, Any]:
    return {
        "state": _job.state,
        "spec_hash": _job.spec_hash,
        "started": _job.started,
        "finished": _job.finished,
        "test_id": _job.test_id,
        "log": _job.log[-100:],
    }


@router.get("/tests")
def tests() -> dict[str, Any]:
    rows = store.ledger(_root())
    return {"tests": list(reversed(rows)), "counts": store.counts(rows)}


@router.get("/tests/{test_id}")
def test_result(test_id: str) -> Any:
    result = store.read_result(_root(), test_id)
    if result is None:
        return _error(404, "no such test")
    return result


@router.post("/reveal")
def reveal(body: RevealBody) -> Any:
    return {"revealed": store.reveal(_root(), body.spec_hash, body.note)}
