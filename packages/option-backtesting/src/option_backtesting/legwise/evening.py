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

import contextlib
import os
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import date
from pathlib import Path

from ..angelone.auth import AngelCredentialsError, AngelNetworkError
from ..angelone.client import AngelRateLimited
from ..fyers.auth import FyersCredentialsError
from ..fyers.daily import DEFAULT_MAX_EXTRA, DEFAULT_PREMIUM_FLOOR, UNDERLYINGS, data_dir
from . import source as day_source
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


def collect_detailed(
    day: date,
    underlyings: list[str],
    *,
    premium_floor: float = DEFAULT_PREMIUM_FLOOR,
    max_extra: int = DEFAULT_MAX_EXTRA,
    force: bool = False,
    log: Log = print,
    source: str = "fyers",
    merge_existing: bool = False,
) -> tuple[int, dict]:
    """Collect one day; return the per-symbol error count. A token problem raises
    FyersCredentialsError (Angel One's login error subclasses it) for the caller to report.
    `source` is "fyers" or "angelone" (BL-079): the same collector, a different client."""
    from trading_data import lake

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
    with contextlib.ExitStack() as stack:
        if source == "angelone":
            from ..angelone import check
            from ..angelone.client import MIN_INTERVAL_S, AngelClient

            # The login and the whole collection under the Angel One guard's lock, so a
            # connection test cannot log in on the same account while this session is in use.
            client = AngelClient(
                stack.enter_context(check.session()),
                min_interval_s=_min_interval(MIN_INTERVAL_S, log),
            )
        elif source == "fyers":
            from ..fyers.auth import resolve_credentials
            from ..fyers.client import FyersClient

            client = FyersClient(resolve_credentials())
        else:
            raise ValueError(f"unknown source {source!r}")
        manifest = collect_day(
            client,
            day,
            underlyings,
            root,
            premium_floor=premium_floor,
            max_extra=max_extra,
            force=force,
            log=log,
            source=source,
            merge_existing=merge_existing,
        )
    errors = sum(len(v.get("errors", [])) for v in manifest.values() if isinstance(v, dict))
    log(f"done: {client.calls} requests, {errors} errors -> {root}")
    if source == "angelone":
        log(rate_line(client.stats()))
    return errors, manifest


def _min_interval(default: float, log: Log) -> float:
    """ANGELONE_MIN_INTERVAL_S: the gap between candle requests. A blank, non-numeric or
    non-positive value would crash the run or remove the pacing, so it falls back to the default."""
    raw = os.environ.get("ANGELONE_MIN_INTERVAL_S", "").strip()
    if not raw:
        return default
    try:
        value = float(raw)
    except ValueError:
        value = 0.0
    if not value > 0:
        log(f"ANGELONE_MIN_INTERVAL_S={raw!r} is not a positive number; using {default:g} s")
        return default
    return value


def rate_line(stats: dict) -> str:
    """One log line of what a run asked of Angel One, for reading its real limits off the logs."""
    line = f"Angel One: {stats['requests']} requests, {stats['rate_limited_answers']} refused"
    if stats["rate_limited_answers"]:
        first = stats["first_limit"] or {}
        line += (
            f", {stats['rate_wait_s']:g} s waited; the first refusal came at request "
            f"{first.get('call')} ({first.get('last_60s')} in the last minute, "
            f"{first.get('last_hour')} in the last hour)"
        )
    return line


def collect(day: date, underlyings: list[str], **kwargs) -> int:
    """`collect_detailed` returning only the error count (the CLI's and the API's contract)."""
    return collect_detailed(day, underlyings, **kwargs)[0]


@dataclass(frozen=True)
class Collection:
    errors: int
    source: str  # "fyers" | "angelone" | "none" (collection not asked for)
    fallback_reason: str | None = None
    details: dict = field(default_factory=dict)
    repaired: list[date] = field(default_factory=list)
    notes: list[str] = field(default_factory=list)  # lines for the summary and the Telegram body


def collect_with_fallback(
    day: date,
    underlyings: list[str],
    *,
    premium_floor: float = DEFAULT_PREMIUM_FLOOR,
    max_extra: int = DEFAULT_MAX_EXTRA,
    force: bool = False,
    log: Log = print,
    repair_window_days: int = 7,
) -> Collection:
    """Fyers when its token works, Angel One when it does not (BL-079).

    A Fyers token that is missing, expired or rejected raises FyersCredentialsError before any
    bar is written, and the same day is then collected from Angel One. When Fyers does work, any
    recent day that came from Angel One is repaired from it (`repair_from_fyers`)."""
    common = {"premium_floor": premium_floor, "max_extra": max_extra, "log": log}
    try:
        errors, details = collect_detailed(day, underlyings, force=force, source="fyers", **common)
    except FyersCredentialsError as error:
        reason = str(error)[:160]
        log(f"Fyers is not available ({reason}); collecting from Angel One instead")
        _alert_fallback(day, reason, log)
        try:
            errors, details = collect_detailed(
                day, underlyings, force=force, source="angelone", **common
            )
        except (AngelCredentialsError, AngelNetworkError, AngelRateLimited) as fallback:
            # Keep the Fyers reason: logging in to Fyers is the fix the owner can make, and the
            # alert only says so when the message names the Fyers login.
            raise type(fallback)(
                f"Fyers login needed ({reason}); Angel One fallback also failed: {fallback}"
            ) from fallback
        flags = details.get("flags") or {}
        notes = [
            f"Collected from Angel One: no Fyers login ({reason}).",
            *day_source.describe(flags),
            "Log in to Fyers: still-listed contracts are re-collected from it on the next run.",
        ]
        return Collection(errors, "angelone", reason, details, [], notes)
    repaired = repair_from_fyers(
        day,
        underlyings,
        window_days=repair_window_days,
        log=log,
        **{k: common[k] for k in ("premium_floor", "max_extra")},
    )
    notes = (
        [
            f"Repaired from Fyers: {', '.join(f'{d:%a %d %b}' for d in repaired)}.",
            "Rotation results stored for those days before the repair are not re-scored "
            "(they were computed from the Angel One bars).",
        ]
        if repaired
        else []
    )
    return Collection(errors, "fyers", None, details, repaired, notes)


def _alert_fallback(day: date, reason: str, log: Log) -> None:
    """Say so at once: a missing Fyers login is the fix the owner can make, and the Angel One
    fallback is the slow, rate-limited path (2026-11-16: found out at 16:35, from a failed
    result)."""
    from ..notify import Notification, send

    # once a day: the evening job retries and the owner reruns by hand, each finding Fyers still out
    marker = data_dir() / "angelone" / f"fallback-alert-{day.isoformat()}.sent"
    if marker.exists():
        return
    try:
        delivered, _ = send(
            Notification(
                source="obt daily",
                severity="warn",
                title=f"Fyers is not logged in: collecting {day:%a %d %b} from Angel One",
                body=(
                    f"{reason}\nLog in to Fyers from the dashboard's Broker logins; the next run "
                    "repairs still-listed contracts from it."
                ),
            )
        )
        if delivered:
            marker.parent.mkdir(parents=True, exist_ok=True)
            marker.touch()
    except Exception as error:  # noqa: BLE001 - an alert that cannot be sent must not stop the day
        log(f"fallback alert not sent: {error}")


def repair_from_fyers(
    day: date,
    underlyings: list[str],
    *,
    premium_floor: float = DEFAULT_PREMIUM_FLOOR,
    max_extra: int = DEFAULT_MAX_EXTRA,
    window_days: int = 7,
    log: Log = print,
) -> list[date]:
    """Re-collect, from Fyers, the recent days that came from Angel One. Contracts that have
    expired since stay as they were (`merge_existing`). Returns the days repaired; a Fyers
    failure part-way leaves the rest for the next run and never fails the evening."""
    root = data_dir()
    todo = day_source.recent_angel_days(root, day, window_days)
    done: list[date] = []
    for d in todo:
        try:
            collect_detailed(
                d,
                underlyings,
                premium_floor=premium_floor,
                max_extra=max_extra,
                force=True,
                source="fyers",
                merge_existing=True,
                log=log,
            )
        except FyersCredentialsError as error:
            log(f"repair of {d} skipped: {error}")
            break
        except Exception as error:  # noqa: BLE001 - a repair must not fail the evening
            log(f"repair of {d} failed: {error}")
            continue
        done.append(d)
        log(f"repaired {d} from Fyers")
    return done


@dataclass(frozen=True)
class EveningResult:
    records: list[dict]
    collection_errors: int
    telegram_sent: bool | None  # None when Telegram was not asked for


def update_heatmap(root: Path, days: list[date], underlyings: list[str], log: Log) -> None:
    """BL-094: add the day's straddle-heatmap grid for each index. Isolated like the other
    side tables: a failure is logged and never fails the evening."""
    from ..heatmap import grid, store

    for name in underlyings:
        if not grid.is_index(name):
            continue
        try:
            for d in days:
                store.build(name, root, d, d, force=True)  # a repaired day's bars changed
        except Exception as error:  # noqa: BLE001 - the heatmap is not the evening's product
            log(f"heatmap {name}: skipped ({error})")


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
    collection = (
        collect_with_fallback(day, underlyings, log=log) if fetch else Collection(0, "none")
    )
    errors = collection.errors
    root = data_dir()
    # judge the day and build its derived tables first: the strategies skip an excluded day,
    # and the summary reports both (BL-034 Phase 4)
    check = refresh_day(root, day, underlyings, log=log)
    today = run_day(day, root, files)
    for repaired_day in collection.repaired:  # re-judge and re-run what the repair rewrote
        refresh_day(root, repaired_day, underlyings, log=log)
        if repaired_day != day:
            run_day(repaired_day, root, files)
    update_heatmap(root, [day, *[d for d in collection.repaired if d != day]], underlyings, log)
    history = load_history(root)
    log("")
    log(summary(day, today, history, files, check, collection.notes))
    sent = None
    if telegram:
        sent, _ = send(
            telegram_summary(
                day,
                today,
                history,
                files,
                errors,
                check,
                collection.notes,
                warn=collection.source == "angelone",
            )
        )
        log("telegram: sent" if sent else "telegram: not sent")
    return EveningResult(today, errors, sent)
