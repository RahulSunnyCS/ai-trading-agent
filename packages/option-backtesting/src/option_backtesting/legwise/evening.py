"""
One evening run, shared by `obt daily` (the scheduler) and the dashboard's
`POST /legwise/daily` job, so the two can no longer drift: collect the day's
1-minute data, judge it in data_quality and build its derived tables
(`refresh_day`), run every leg-wise strategy on it, save the results, log the
summary and send it to Telegram.

Errors propagate: the caller decides what a failure means (the CLI exits 1, the
API marks its job failed). Neither sends the failure message from here.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from datetime import date
from pathlib import Path

from ..fyers.daily import DEFAULT_MAX_EXTRA, DEFAULT_PREMIUM_FLOOR, UNDERLYINGS, data_dir
from .daily import (
    load_history,
    load_strategy_files,
    refresh_day,
    run_day,
    summary,
    telegram_summary,
)

Log = Callable[[str], None]


class UnknownUnderlying(ValueError):
    pass


def check_underlyings(names: list[str]) -> None:
    unknown = [u for u in names if u not in UNDERLYINGS]
    if unknown:
        raise UnknownUnderlying(f"unknown underlyings {unknown}; known: {sorted(UNDERLYINGS)}")


def collect(
    day: date,
    underlyings: list[str],
    *,
    premium_floor: float = DEFAULT_PREMIUM_FLOOR,
    max_extra: int = DEFAULT_MAX_EXTRA,
    force: bool = False,
    log: Log = print,
) -> int:
    """Collect one day; return the per-symbol error count. A token problem raises
    FyersCredentialsError for the caller to report."""
    from trading_data import lake

    from ..fyers.auth import resolve_credentials
    from ..fyers.client import FyersClient
    from ..fyers.daily import collect_day

    check_underlyings(underlyings)
    root = data_dir()
    # Only worth saying when something will actually be downloaded: a re-run over an
    # already-collected day (the usual after-midnight case) fetches nothing.
    to_fetch = force or any(
        not lake.bars_1m_path(root, "option", u, day).exists() for u in underlyings
    )
    if day < date.today() and to_fetch:
        log(
            "warning: the symbol master only lists live contracts - anything that expired "
            f"between {day} and today is missing from this run."
        )
    client = FyersClient(resolve_credentials())
    manifest = collect_day(
        client,
        day,
        underlyings,
        root,
        premium_floor=premium_floor,
        max_extra=max_extra,
        force=force,
        log=log,
    )
    errors = sum(len(v.get("errors", [])) for v in manifest.values() if isinstance(v, dict))
    log(f"done: {client.calls} requests, {errors} errors -> {root}")
    return errors


@dataclass(frozen=True)
class EveningResult:
    records: list[dict]
    collection_errors: int
    telegram_sent: bool | None  # None when Telegram was not asked for


def run_daily(
    day: date,
    underlyings: list[str],
    strategies_dir: Path,
    *,
    fetch: bool = True,
    telegram: bool = True,
    log: Log = print,
) -> EveningResult:
    """The whole evening routine for one trading day (see the module docstring)."""
    from ..notify import send

    check_underlyings(underlyings)
    files = load_strategy_files(strategies_dir)
    log(f"{day}: {len(files)} strategies from {strategies_dir}")
    errors = collect(day, underlyings, log=log) if fetch else 0
    root = data_dir()
    # judge the day and build its derived tables first: the strategies skip an excluded day,
    # and the summary reports both (BL-034 Phase 4)
    check = refresh_day(root, day, underlyings, log=log)
    today = run_day(day, root, files)
    history = load_history(root)
    log("")
    log(summary(day, today, history, files, check))
    sent = None
    if telegram:
        sent, _ = send(telegram_summary(day, today, history, files, errors, check))
        log("telegram: sent" if sent else "telegram: not sent")
    return EveningResult(today, errors, sent)
