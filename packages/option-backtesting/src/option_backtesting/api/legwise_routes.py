"""
Leg-wise strategy routes for the dashboard's "Options Lab" tab: build and save
AlgoTest-style strategies, backtest them over the collected Fyers 1-minute
days, browse the saved daily results, and start the evening `obt daily` run.

Errors come back as `{"error": ...}` (what the dashboard's api.ts reads), not
FastAPI's `{"detail": ...}`.

Strategy names are an allow-listed slug checked BEFORE any path is built, so a
client can never write or read outside `strategies/legwise/` (same rule as
presets.py). Files are written with `yaml.safe_dump` of the validated model —
never the client's raw text.
"""

from __future__ import annotations

import hashlib
import re
import threading
import traceback
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import yaml
from fastapi import APIRouter
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field, ValidationError
from trading_data.db import connect

from ..fyers.daily import UNDERLYINGS, data_dir
from ..legwise import store
from ..legwise.daily import (
    load_history,
    load_strategy_files,
    run_day,
    telegram_failure,
    telegram_summary,
)
from ..legwise.engine import DayResult, simulate_day
from ..legwise.market import available_days, load_day, minute_label
from ..legwise.schema import LegwiseStrategy
from ..presets import STRATEGIES_DIR

LEGWISE_DIR = STRATEGIES_DIR / "legwise"
_NAME_RE = re.compile(r"^[a-z0-9_]{1,64}$")
_IST = timezone(timedelta(hours=5, minutes=30))

router = APIRouter(prefix="/legwise")


def _error(status: int, message: str) -> JSONResponse:
    return JSONResponse(status_code=status, content={"error": message})


def _validation_messages(error: ValidationError) -> list[str]:
    return [
        f"{'.'.join(str(p) for p in e['loc']) or 'strategy'}: {e['msg']}" for e in error.errors()
    ]


def _strategy_path(name: str) -> Path | None:
    return LEGWISE_DIR / f"{name}.yaml" if _NAME_RE.match(name) else None


def _dump(strategy: LegwiseStrategy) -> str:
    return yaml.safe_dump(
        {"strategy": strategy.model_dump(mode="json", exclude_none=True)}, sort_keys=False
    )


def _day_json(result: DayResult) -> dict[str, Any]:
    return {
        "day": result.day.isoformat(),
        "gross": round(result.gross, 2),
        "costs": round(result.costs, 2),
        "net": round(result.net, 2),
        "worst_mtm": round(result.worst_mtm, 2),
        "best_mtm": round(result.best_mtm, 2),
        "stopped_by": result.stopped_by,
        "notes": result.notes,
        "trades": [
            {
                "leg": t.leg_id,
                "contract": t.describe(),
                "entry": minute_label(t.entry_min),
                "entry_price": round(t.entry_price, 2),
                "exit": minute_label(t.exit_min) if t.exit_min is not None else None,
                "exit_price": round(t.exit_price, 2) if t.exit_price is not None else None,
                "reason": t.exit_reason,
                "pnl": round(t.pnl, 2),
            }
            for t in result.trades
        ],
    }


# ---------------------------------------------------------------------------
# Strategies
# ---------------------------------------------------------------------------


@router.get("/strategies")
def list_strategies() -> list[dict[str, Any]]:
    out = []
    for file in load_strategy_files(LEGWISE_DIR):
        out.append(
            {
                "name": file.path.stem,
                "sha": file.sha,
                "strategy": file.strategy.model_dump(mode="json", exclude_none=True),
            }
        )
    return out


class StrategyBody(BaseModel):
    strategy: dict[str, Any]


@router.post("/validate")
def validate(body: StrategyBody) -> dict[str, Any]:
    try:
        LegwiseStrategy.model_validate(body.strategy)
    except ValidationError as error:
        return {"valid": False, "errors": _validation_messages(error)}
    return {"valid": True, "errors": []}


@router.put("/strategies/{name}")
def save_strategy(name: str, body: StrategyBody) -> Any:
    path = _strategy_path(name)
    if path is None:
        return _error(422, "name must be 1-64 characters of a-z, 0-9 and _")
    try:
        strategy = LegwiseStrategy.model_validate(body.strategy)
    except ValidationError as error:
        return _error(422, "; ".join(_validation_messages(error)))
    text = _dump(strategy)
    LEGWISE_DIR.mkdir(parents=True, exist_ok=True)
    path.write_text(text)
    return {"name": name, "sha": hashlib.sha256(text.encode()).hexdigest()[:12]}


# ---------------------------------------------------------------------------
# Data + ad-hoc backtest
# ---------------------------------------------------------------------------


@router.get("/data")
def data_status() -> dict[str, Any]:
    from ..fyers.auth import FyersCredentialsError, resolve_credentials

    root = data_dir()
    try:
        creds = resolve_credentials()
        token = {"ok": True, "source": creds.source, "expires_at": creds.expires_at}
    except FyersCredentialsError as error:
        token = {"ok": False, "message": str(error)}
    return {
        "data_dir": str(root),  # TRADING_DATA_ROOT
        "days": {u: [d.isoformat() for d in available_days(root, u)] for u in UNDERLYINGS},
        "token": token,
    }


class BacktestBody(BaseModel):
    strategy: dict[str, Any]
    from_: str | None = Field(default=None, alias="from")
    to: str | None = None


@router.post("/backtest")
def backtest(body: BacktestBody) -> Any:
    try:
        strategy = LegwiseStrategy.model_validate(body.strategy)
    except ValidationError as error:
        return _error(422, "; ".join(_validation_messages(error)))
    start = date.fromisoformat(body.from_) if body.from_ else None
    end = date.fromisoformat(body.to) if body.to else None
    root = data_dir()
    results = [
        simulate_day(strategy, load_day(root, strategy.underlying, day))
        for day in available_days(root, strategy.underlying)
        if not ((start and day < start) or (end and day > end))
    ]
    if not results:
        return _error(404, f"no collected {strategy.underlying} days in that range")
    # Kept as an `adhoc` run: every builder experiment stays queryable with the exact
    # settings that produced it.
    with connect(root) as con:
        run_id = store.save_adhoc(con, strategy, results, {"from": body.from_, "to": body.to})
    return {"strategy_id": strategy.id, "run_id": run_id, "days": [_day_json(r) for r in results]}


# ---------------------------------------------------------------------------
# Saved daily results
# ---------------------------------------------------------------------------


@router.get("/results")
def results() -> dict[str, Any]:
    files = load_strategy_files(LEGWISE_DIR)
    current = {f.strategy.id: f.sha for f in files}
    rows = []
    for record in load_history(data_dir()):
        sid = record.get("strategy_id")
        rows.append({**record, "current": current.get(sid) == record.get("strategy_sha")})
    return {
        "strategies": [{"id": f.strategy.id, "name": f.path.stem, "sha": f.sha} for f in files],
        "results": rows,
        "results_dir": f"{data_dir()}/catalog.duckdb",
    }


# ---------------------------------------------------------------------------
# The evening run, as a background job (collection takes minutes)
# ---------------------------------------------------------------------------


@dataclass
class _Job:
    state: str = "idle"  # idle | running | done | failed
    day: str | None = None
    started: str | None = None
    finished: str | None = None
    log: list[str] = field(default_factory=list)


_job = _Job()
_job_lock = threading.Lock()


class DailyBody(BaseModel):
    date: str | None = None
    fetch: bool = True
    telegram: bool = True


def _run_daily(day: date, fetch: bool, telegram: bool) -> None:
    from ..notify import send

    def log(line: str) -> None:
        _job.log.append(line)

    try:
        root = data_dir()
        errors = 0
        if fetch:
            from ..fyers.auth import resolve_credentials
            from ..fyers.client import FyersClient
            from ..fyers.daily import collect_day

            client = FyersClient(resolve_credentials())
            manifest = collect_day(client, day, list(UNDERLYINGS), root, log=log)
            errors = sum(len(v.get("errors", [])) for v in manifest.values() if isinstance(v, dict))
            log(f"collected: {client.calls} requests, {errors} errors")
        files = load_strategy_files(LEGWISE_DIR)
        saved = run_day(day, root, files)
        for rec in saved:
            if "skipped" in rec:
                log(f"{rec['strategy_id']}: skipped — {rec['skipped']}")
            else:
                log(f"{rec['strategy_id']}: {rec['net']:+,.0f}")
        if telegram:
            summary = telegram_summary(day, saved, load_history(root), files, errors)
            delivered, _ = send(summary)
            log("telegram: sent" if delivered else "telegram: not sent (not configured?)")
        _job.state = "done"
    except Exception as error:  # surfaced to the UI, never swallowed
        log(f"failed: {error}")
        log(traceback.format_exc(limit=3))
        if telegram:
            send(telegram_failure(day, str(error)))
        _job.state = "failed"
    finally:
        _job.finished = datetime.now(_IST).isoformat(timespec="seconds")


@router.post("/daily")
def start_daily(body: DailyBody) -> Any:
    from ..cli import _last_closed_session

    day = date.fromisoformat(body.date) if body.date else _last_closed_session(datetime.now(_IST))
    with _job_lock:
        if _job.state == "running":
            return _error(409, f"a run for {_job.day} is already in progress")
        _job.state, _job.day, _job.log = "running", day.isoformat(), []
        _job.started = datetime.now(_IST).isoformat(timespec="seconds")
        _job.finished = None
        threading.Thread(
            target=_run_daily, args=(day, body.fetch, body.telegram), daemon=True
        ).start()
    return {"state": _job.state, "day": _job.day}


@router.get("/daily")
def daily_job() -> dict[str, Any]:
    return {
        "state": _job.state,
        "day": _job.day,
        "started": _job.started,
        "finished": _job.finished,
        "log": _job.log[-200:],
    }
