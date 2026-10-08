"""Alerts (BL-051 Phase 5): what needs the owner, computed from the checks the Telegram jobs
already run, for the dashboard's pop-up and bell (`GET /api/alerts`).

Nothing here is a record. An alert is *open* while its check fails and *resolved* when the check
passes again; the id (kind + subject) stays the same across polls so the browser can show a
pop-up at most once a day per alert. The only state is a small cache of what was open
(`alerts_state.json` in the state folder), which gives `opened_at` / `resolved_at`; losing it
loses only those two times.

Each kind is a pure function over the data its job already reads. `collect` gathers them, and a
source that cannot be read (a locked catalog) keeps that kind's previously open alerts instead of
resolving them.
"""

from __future__ import annotations

import json
import threading
from collections.abc import Callable
from contextlib import AbstractContextManager
from datetime import date, datetime, time, timedelta
from pathlib import Path
from typing import Any
from urllib.parse import quote

import duckdb

from .notify import IST

STATE_FILE = "alerts_state.json"
#: Resolved alerts kept, newest first, so the bell can say what just cleared.
KEEP_RESOLVED = 20
#: A resolved alert is listed as 'cleared recently' for this long.
RESOLVED_FOR = timedelta(days=2)

SEVERITY_ORDER = {"error": 0, "warning": 1, "info": 2}
KINDS = ("split", "data", "journal", "change", "rules")

#: A step is overdue this many minutes after its scheduled time (the This week timeline's window).
DUE_WINDOW_MINUTES = 15
#: The Friday times (IST) after which a dataset is expected for the week, and the journal checked.
DATA_DUE = {"etf": time(16, 45), "stock": time(19, 30)}
JOURNAL_DUE = time(21, 0)

_lock = threading.Lock()


def _alert(
    kind: str,
    subject: str,
    severity: str,
    title: str,
    detail: str,
    link: str,
    opened_at: str | None = None,
) -> dict[str, Any]:
    return {
        "id": f"{kind}:{subject}",
        "kind": kind,
        "severity": severity,
        "title": title,
        "detail": detail,
        "link": link,
        "opened_at": opened_at,
        "resolved_at": None,
    }


def _iso(value: str | None) -> str | None:
    """A catalog time ("2026-10-08T10:00:00+0000") as ISO 8601 with a colon in the offset, which
    every browser parses; None when it is not a time."""
    try:
        return datetime.fromisoformat(value).isoformat() if value else None
    except ValueError:
        return None


def order(alert: dict[str, Any]) -> tuple[int, str]:
    """Most severe first, then the one open longest."""
    return SEVERITY_ORDER.get(alert["severity"], 3), alert["opened_at"] or ""


def _friday_due(friday: str, at: time, now: datetime) -> bool:
    """Whether `now` is past a Friday step's time plus the grace window (any later day counts)."""
    day = date.fromisoformat(friday)
    due = datetime.combine(day, at, tzinfo=IST) + timedelta(minutes=DUE_WINDOW_MINUTES)
    return now >= due


# --- one function per kind -----------------------------------------------------------------------


def split_alerts(snapshot: dict[str, Any]) -> list[dict[str, Any]]:
    """Unclassified split/bonus candidates: `stock_actions.review_snapshot`'s items (the ones the
    This week page lists). Resolved by classifying the split."""
    out = []
    for item in snapshot.get("items", []):
        symbol, ex_date = item["symbol"], item["ex_date"]
        drop = 1 - item["close"] / item["previous_close"] if item["previous_close"] else 0.0
        out.append(
            _alert(
                "split",
                f"{symbol}:{ex_date}",
                "warning",
                f"{symbol} fell {round(drop * 100, 1)}% on {ex_date}: classify it",
                "No matching split or bonus filing was found. Until it is classified, no share "
                "adjustment is applied and its scores may be wrong.",
                f"/momentum/week?review={quote(symbol, safe='')}",
            )
        )
    return out


def data_alerts(
    status: dict[str, Any], headline_dataset: str | None, now: datetime
) -> list[dict[str, Any]]:
    """The headline favourite's data has not reached this week although its Friday run is past.
    `status` is `/api/weekly/status`; `headline_dataset` is the headline's dataset ('etf', or any
    stock-based one)."""
    if headline_dataset is None:
        return []
    key = "etf" if headline_dataset == "etf" else "stock"
    out = []
    for dataset in status.get("datasets", []):
        if dataset["key"] != key or dataset["ready"]:
            continue
        if not _friday_due(status["target_week"], DATA_DUE[key], now):
            continue
        through = dataset["through"]
        out.append(
            _alert(
                "data",
                f"{key}:{status['target_week']}",
                "error",
                f"{dataset['label']} not ready for this week",
                (
                    f"Data runs only through {through}; this week's signal needs "
                    f"{status['target_week']}."
                    if through
                    else "No data has been ingested."
                ),
                "/momentum/week?panel=run",
            )
        )
    return out


def journal_alerts(check: dict[str, Any] | None, now: datetime) -> list[dict[str, Any]]:
    """What `mbt journal check` reports once its 21:00 run is past: entries still missing for the
    week, or a broken chain. `check` is `forward_journal.check`'s result."""
    if check is None:
        return []
    out = []
    # An empty journal (a fresh install) has recorded nothing yet, so nothing is "missing".
    if check["chain"]["entries"] and _friday_due(check["week"], JOURNAL_DUE, now):
        missing = [item for item in check["items"] if item["status"] != "recorded"]
        if missing:
            out.append(
                _alert(
                    "journal",
                    f"missing:{check['week']}",
                    "error",
                    f"Journal: {len(missing)} of {check['expected']} entries missing for the "
                    f"week of {check['week']}",
                    ", ".join(f"{item['name']} ({item['run_kind']})" for item in missing),
                    "/momentum/journal",
                )
            )
    problems = check["chain"]["problems"]
    if problems:
        out.append(
            _alert(
                "journal",
                "chain",
                "error",
                "Journal chain is broken",
                "; ".join(problems[:3]),
                "/momentum/journal",
            )
        )
    return out


def change_alerts(
    changes: list[dict[str, Any]], strategies: Callable[[dict[str, Any]], tuple[str, str]]
) -> list[dict[str, Any]]:
    """Check / Not reproducible result changes nobody has marked reviewed
    (`runs_store.list_changes(unreviewed=True)`). `strategies(change)` gives the strategy's
    current (anchor run id, name) for the link and title. Resolved by "Mark reviewed"."""
    out = []
    for change in changes:
        anchor, name = strategies(change)
        not_reproducible = change["label"] == "not_reproducible"
        before, after = (change.get("kpis_before") or {}), (change.get("kpis_after") or {})
        move = (
            f" CAGR {before['cagr']:.1%} -> {after['cagr']:.1%}."
            if before.get("cagr") is not None and after.get("cagr") is not None
            else ""
        )
        out.append(
            _alert(
                "change",
                change["change_id"],
                "error" if not_reproducible else "warning",
                f"{name}: result moved ({'Not reproducible' if not_reproducible else 'Check'})",
                (
                    "Same code and data gave a different result."
                    if not_reproducible
                    else "The code changed and no accepted golden change explains the move."
                )
                + move,
                f"/momentum/saved?strategy={anchor}",
                _iso(change.get("created_at")),
            )
        )
    return out


def rules_alerts(report: dict[str, Any] | None) -> list[dict[str, Any]]:
    """Live-money rules the latest check says need you (`live_rules.load_last`): a breach, a
    blocked check, a money gate ready; or a check that ran on stale data. Resolved when the next
    check clears them."""
    if not report:
        return []
    week = report.get("week") or "unknown"
    out = []
    if report.get("stale"):
        out.append(
            _alert(
                "rules",
                f"stale:{report['stale']}",
                "error",
                "Live-rules check ran on stale data",
                f"Its numbers stop at {week}; this week's was expected ({report['stale']}).",
                "/momentum/week",
            )
        )
    for finding in report.get("findings", []):
        if not isinstance(finding, dict) or not finding.get("needs_you"):
            continue
        # One finding this version cannot read must not blank the whole kind (it would then be
        # "unchecked", and its old alerts kept for ever): skip it.
        rule, level, title = finding.get("rule"), finding.get("level"), finding.get("title")
        if not (rule and level and title):
            continue
        action = finding.get("action")
        out.append(
            _alert(
                "rules",
                f"{rule}:{level}:{week}",
                "info" if level == "ready" else "error",
                title,
                (finding.get("detail") or "") + (f" Your action: {action}" if action else ""),
                "/momentum/week",
            )
        )
    return out


# --- gathering -----------------------------------------------------------------------------------


def _headline_dataset(favourites: list[dict[str, Any]]) -> str | None:
    for favourite in favourites:
        if favourite.get("active"):
            return favourite["config"].get("dataset", "etf")
    return None


def _created_by(favourite: dict[str, Any], limit: datetime) -> bool:
    """Whether a favourite existed by `limit`; one with an unreadable time counts as existing."""
    try:
        return datetime.fromisoformat(favourite["created_at"]) <= limit
    except (KeyError, TypeError, ValueError):
        return True


def _catalog_alerts(con: duckdb.DuckDBPyConnection, now: datetime) -> dict[str, Any]:
    """The kinds read from the catalog, each `list` or the exception that stopped it."""
    from . import forward_journal, runs_store, stock_actions
    from .db_read import _has_table
    from .stocks.ui_data import NIFTY200_MOMENTUM30_TRI
    from .weekly import week_ending_on_or_before

    found: dict[str, Any] = {}

    def attempt(kind: str, build: Callable[[], list[dict[str, Any]]]) -> None:
        try:
            found[kind] = build()
        except duckdb.CatalogException:  # a table this release adds, not there yet: nothing to flag
            found[kind] = []
        except Exception as error:  # noqa: BLE001 - one kind failing must not hide the others
            found[kind] = error

    attempt("split", lambda: split_alerts(stock_actions.review_snapshot(con)))

    def journal() -> list[dict[str, Any]]:
        if not _has_table(con, forward_journal.TABLE):
            return []
        week = forward_journal.week_string(week_ending_on_or_before(now.astimezone(IST).date()))
        friday_end = datetime.combine(date.fromisoformat(week), JOURNAL_DUE, tzinfo=IST)
        favourites = [
            favourite
            for favourite in runs_store.list_favorites(con)
            if _created_by(favourite, friday_end)
        ]
        check = forward_journal.check(con, week, favourites, (NIFTY200_MOMENTUM30_TRI,))
        return journal_alerts(check, now)

    attempt("journal", journal)

    def changes() -> list[dict[str, Any]]:
        def strategy(change: dict[str, Any]) -> tuple[str, str]:
            anchor = runs_store._anchor(con, change["version_id"])
            if anchor is None:
                return change["anchor_run_id"], "A saved strategy"
            return anchor[0], anchor[1].get("name") or "A saved strategy"

        return change_alerts(runs_store.list_changes(con, unreviewed=True), strategy)

    attempt("change", changes)
    found["headline"] = None
    try:
        found["headline"] = _headline_dataset(runs_store.list_favorites(con, include_groups=True))
    except Exception as error:  # noqa: BLE001
        found["headline"] = error
    return found


def _state_path(state_dir: Path) -> Path:
    return state_dir / STATE_FILE


def _load_state(state_dir: Path) -> dict[str, Any]:
    try:
        state = json.loads(_state_path(state_dir).read_text())
        return {"open": dict(state.get("open", {})), "resolved": list(state.get("resolved", []))}
    except (OSError, ValueError, AttributeError):
        return {"open": {}, "resolved": []}


def _save_state(state_dir: Path, state: dict[str, Any]) -> None:
    path = _state_path(state_dir)
    tmp = path.with_suffix(".tmp")
    try:
        tmp.write_text(json.dumps(state, indent=1))
        tmp.replace(path)
    except OSError:
        pass  # the cache only gives opened_at / resolved_at; never fail a request over it


def collect(
    *,
    now: datetime,
    catalog: Callable[[], AbstractContextManager[duckdb.DuckDBPyConnection]],
    weekly_status: Callable[[date], dict[str, Any]],
    live_rules_report: Callable[[], dict[str, Any] | None],
    state_dir: Path,
) -> dict[str, Any]:
    """Every open alert (most severe first), the recently resolved ones, and the kinds that could
    not be checked this time (`unchecked`; their previously open alerts are kept)."""
    now = now.astimezone(IST)
    stamp = now.isoformat(timespec="seconds")
    found: dict[str, Any] = {}
    try:
        with catalog() as con:
            found.update(_catalog_alerts(con, now))
    except FileNotFoundError:  # no catalog yet: nothing to flag
        found.update({"split": [], "journal": [], "change": [], "headline": None})
    except Exception as error:  # noqa: BLE001 - a locked catalog
        found.update({"split": error, "journal": error, "change": error, "headline": error})
    head = found.pop("headline", None)
    if isinstance(head, BaseException):
        found["data"] = head
    elif head is None:  # no headline favourite: no data is waited for
        found["data"] = []
    else:
        try:
            found["data"] = data_alerts(weekly_status(now.date()), head, now)
        except Exception as error:  # noqa: BLE001 - e.g. no price data yet (HTTP 409)
            found["data"] = error
    try:
        found["rules"] = rules_alerts(live_rules_report())
    except Exception as error:  # noqa: BLE001
        found["rules"] = error

    with _lock:
        state = _load_state(state_dir)
        previous = state["open"]
        current: dict[str, dict[str, Any]] = {}
        unchecked = []
        for kind in KINDS:
            result = found.get(kind, [])
            if isinstance(result, BaseException):
                unchecked.append(kind)
                current.update({k: v for k, v in previous.items() if v["kind"] == kind})
                continue
            for alert in result:
                old = previous.get(alert["id"])
                alert["opened_at"] = (old or {}).get("opened_at") or alert["opened_at"] or stamp
                current[alert["id"]] = alert
        resolved = [
            {**alert, "resolved_at": stamp} for key, alert in previous.items() if key not in current
        ]
        reopened = set(current)
        kept = [r for r in state["resolved"] if r["id"] not in reopened]
        oldest = (now - RESOLVED_FOR).isoformat(timespec="seconds")
        recent = [r for r in resolved + kept if (r.get("resolved_at") or "") >= oldest]
        new_state = {"open": current, "resolved": recent[:KEEP_RESOLVED]}
        if new_state != state:  # a poll that changes nothing writes nothing
            _save_state(state_dir, new_state)
        state = new_state

    return {
        "checked_at": stamp,
        "alerts": sorted(state["open"].values(), key=order),
        "resolved": state["resolved"],
        "unchecked": unchecked,
    }
