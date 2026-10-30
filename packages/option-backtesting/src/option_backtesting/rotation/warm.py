"""Run a slow read in the background and wait for it only so long (BL-095).

The portfolio-stop routes replay hundreds of strategy-days the first time they are asked
(about 45 s for 116 days, minutes for a long window), longer than the Fastify proxy's 30 s upstream
timeout. `run_within` starts the work on a thread, waits up to `WAIT_SECONDS`, and either returns
the answer or says "still working" so the route can answer 202 and the page asks again. The work
carries on and fills the one-lot path cache, so the next ask is fast. Nothing here stores a result:
a repeat request while the first is still running joins it instead of starting another.
"""

from __future__ import annotations

import contextvars
import threading
from collections.abc import Callable, Hashable
from typing import Any

WAIT_SECONDS = 20.0  # under the proxy's 30 s

_lock = threading.Lock()
_jobs: dict[Hashable, _Job] = {}


class _Job:
    def __init__(self) -> None:
        self.done = threading.Event()
        self.result: Any = None
        self.error: BaseException | None = None


def run_within(key: Hashable, fn: Callable[[], Any], wait: float | None = None) -> tuple[bool, Any]:
    """`(True, result)` when `fn` finished within the wait (its exception is re-raised), else
    `(False, None)` while it keeps running. A call with a key already running joins that job.
    The work runs in a copy of the caller's context, so it reads the results at the caller's
    slippage (`store.slipped`), and a job is only joined by a caller reading at the same one."""
    from . import store

    key = (key, store.reading_slip())
    context = contextvars.copy_context()
    with _lock:
        job = _jobs.get(key)
        starter = job is None
        if job is None:
            job = _Job()
            _jobs[key] = job

    if starter:

        def work() -> None:
            try:
                job.result = fn()
            except BaseException as error:  # handed to whoever waits on it
                job.error = error
            finally:
                with _lock:
                    if _jobs.get(key) is job:
                        del _jobs[key]
                job.done.set()

        threading.Thread(
            target=context.run, args=(work,), daemon=True, name="portfolio-warm"
        ).start()

    if not job.done.wait(WAIT_SECONDS if wait is None else wait):
        return False, None
    if job.error is not None:
        raise job.error
    return True, job.result


def running() -> int:
    with _lock:
        return len(_jobs)
