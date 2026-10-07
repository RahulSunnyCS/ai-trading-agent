"""
The evening routine behind `obt daily`: run every leg-wise strategy in a
folder over one collected day, save each result in the trading-data catalog
(legwise/store.py), and summarise the day against everything saved so far.

Each result is tied to the strategy VERSION that produced it (a hash of the
validated spec). The running totals only add up results from the version each
file has now — after a strategy edit, older days are reported as stale (re-run
them with `obt legwise rerun`), never silently mixed with the new numbers.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from datetime import date
from pathlib import Path

from trading_data import derived, quality
from trading_data.db import connect

from ..data.reference.loader import (
    MissingReferenceData,
    ReferenceData,
    default_reference_data,
)
from ..fyers.daily import VIX_NAME
from ..notify import Notification
from . import store
from .engine import simulate_day
from .market import load_day
from .schema import LegwiseStrategy, load_legwise


@dataclass(frozen=True)
class StrategyFile:
    path: Path
    strategy: LegwiseStrategy
    sha: str  # store.spec_hash of the validated strategy


def load_strategy_files(folder: Path) -> list[StrategyFile]:
    files = []
    for path in sorted(folder.glob("*.yaml")):
        strategy = load_legwise(path)
        files.append(StrategyFile(path, strategy, store.spec_hash(strategy)))
    return files


def run_day(
    day: date,
    root: Path,
    files: list[StrategyFile],
    reference: ReferenceData | None = None,
) -> list[dict]:
    """Simulate every strategy on `day` and save each result to the catalog (replacing
    any earlier result for the same version and day). A strategy whose underlying was
    not collected that day is skipped with a note rather than failing the evening."""
    reference = reference or default_reference_data()
    loaded: dict[str, object] = {}
    records: list[dict] = []
    results = []
    for file in files:
        underlying = file.strategy.underlying
        if underlying not in loaded:
            excluded = quality.excluded_days(root, "option", underlying) or {}
            if day in excluded:
                loaded[underlying] = f"excluded by data_quality: {excluded[day]}"
            else:
                try:
                    loaded[underlying] = load_day(root, underlying, day)
                except FileNotFoundError as error:
                    loaded[underlying] = str(error)
        data = loaded[underlying]
        if isinstance(data, str):
            records.append(
                {"strategy_id": file.strategy.id, "day": day.isoformat(), "skipped": data}
            )
            continue
        try:
            result = simulate_day(file.strategy, data, reference)  # type: ignore[arg-type]
        except MissingReferenceData as error:
            records.append(
                {"strategy_id": file.strategy.id, "day": day.isoformat(), "skipped": str(error)}
            )
            continue
        results.append((file.strategy, result))
        records.append(store.record(result, file.strategy))
    if results:
        with connect(root) as con:
            for strategy, result in results:
                store.save_daily(con, strategy, result)
    return records


@dataclass
class DayCheck:
    """What the evening top-up found about the day's data: lines for the summary, and whether
    anything needs attention (a missing or excluded day, a step that failed)."""

    lines: list[str]
    problems: bool


def refresh_day(
    root: Path, day: date, underlyings: list[str], log: Callable[[str], None] = print
) -> DayCheck:
    """After collection (BL-034 Phase 4): judge the day in data_quality (which also rewrites
    the lock-free verdict file the strategies read), build its derived tables and iv_daily, and
    describe the result. Never raises: a failed step becomes a problem line, so the evening
    summary is still sent."""
    lines: list[str] = []
    problems = False
    try:
        quality.judge_day(root, day, [*underlyings, VIX_NAME])
    except Exception as error:  # noqa: BLE001 — reported, not fatal
        busy = "lock" in str(error).lower()
        lines.append(
            ("quality check skipped — the catalog stayed busy" if busy else
             f"quality check failed: {error}")
            + f"; run: tdata quality rebuild --days {day}..{day}"
        )  # fmt: skip
        problems = True
    verdicts = quality.day_verdicts(root, day)
    usable = []
    for u in underlyings:
        verdict = verdicts.get(u)
        if verdict is None:
            lines.append(f"{u}: no option data for {day:%d %b}")
            problems = True
        elif verdict[0] == "excluded":
            lines.append(f"{u}: day excluded ({verdict[1]})")
            problems = True
        else:
            usable.append(u)
    names = tuple(u for u in derived.DEFAULT_UNDERLYINGS if u in usable)
    try:
        derived.rebuild(root, names, days=(day, day), log=log)
    except Exception as error:  # noqa: BLE001
        lines.append(f"derived tables failed: {error}")
        problems = True
        names = ()
    for u in names:
        iv = derived.iv_for_day(root, u, day)
        if iv is None:
            lines.append(f"{u}: derived tables not built for {day:%d %b}")
            problems = True
            continue
        lines.append(f"{u} {_iv_line(iv)}")
    if usable:
        lines.insert(0, f"data usable: {', '.join(usable)}")
    return DayCheck(lines, problems)


def _iv_line(iv: dict) -> str:
    def pct(value: float | None) -> str:
        return "n/a" if value is None else f"{value:.0%}"

    def vol(value: float | None) -> str:
        return "n/a" if value is None else f"{value:.1%}"

    vix = iv.get("vix_close")
    return (
        f"IV 7d {vol(iv.get('iv_7d_1500'))} ({pct(iv.get('iv_7d_pct_1y'))} of the last year), "
        f"VIX {'n/a' if vix is None else f'{vix:.2f}'} ({pct(iv.get('vix_pct_1y'))})"
    )


def load_history(root: Path) -> list[dict]:
    try:
        with connect(root, read_only=True) as con:
            return store.load_daily(con)
    except FileNotFoundError:  # no catalog yet
        return []


def _trades(n: int) -> str:
    return f"{n} trade{'' if n == 1 else 's'}"


def summary(
    day: date,
    today: list[dict],
    history: list[dict],
    files: list[StrategyFile],
    check: DayCheck | None = None,
) -> str:
    lines = [f"Leg-wise strategies — {day:%a %d %b %Y}"]
    if check is not None and check.lines:
        lines += ["", "Data", *(f"  {line}" for line in check.lines)]
    for file in files:
        sid = file.strategy.id
        rec = next((r for r in today if r["strategy_id"] == sid), None)
        mine = [h for h in history if h["strategy_id"] == sid]
        current = [h for h in mine if h.get("strategy_sha") == file.sha]
        stale = len(mine) - len(current)
        total = sum(h["net"] for h in current)
        wins = sum(1 for h in current if h["net"] > 0)
        lines.append("")
        lines.append(f"{sid}")
        if rec is None:
            lines.append("  today: not run")
        elif "skipped" in rec:
            lines.append(f"  today: skipped — {rec['skipped']}")
        else:
            stop = f"  ({rec['stopped_by']})" if rec["stopped_by"] else ""
            lines.append(f"  today: {rec['net']:+,.0f}  over {_trades(len(rec['trades']))}{stop}")
            for t in rec["trades"]:
                lines.append(
                    f"    {t['leg']:<3} {t['contract']:<22} {t['entry']} @ {t['entry_price']:.2f}"
                    f" -> {t['exit'] or '--:--'} @ {t['exit_price'] or 0:.2f} {t['reason']:<14}"
                    f" {t['pnl']:+,.0f}"
                )
            for note in rec["notes"]:
                lines.append(f"    note: {note}")
        lines.append(
            f"  so far: {total:+,.0f} over {len(current)} days ({wins} up)"
            + (
                f" — {stale} older day(s) ran an earlier version of this file, not counted"
                if stale
                else ""
            )
        )
    return "\n".join(lines)


def telegram_summary(
    day: date,
    today: list[dict],
    history: list[dict],
    files: list[StrategyFile],
    collection_errors: int = 0,
    check: DayCheck | None = None,
) -> Notification:
    """The evening message: one line per strategy (today's net, trades, what
    stopped it, and the running total over results from the current version of
    its file). `warn` when anything was skipped or collection had errors."""
    lines = []
    day_total = 0.0
    problems = collection_errors > 0
    for file in files:
        sid = file.strategy.id
        rec = next((r for r in today if r["strategy_id"] == sid), None)
        current = [
            h for h in history if h["strategy_id"] == sid and h.get("strategy_sha") == file.sha
        ]
        so_far = sum(h["net"] for h in current)
        if rec is None or "skipped" in rec:
            problems = True
            lines.append(f"• {sid}: skipped — {rec['skipped'] if rec else 'not run'}")
            continue
        day_total += rec["net"]
        detail = _trades(len(rec["trades"]))
        if rec["stopped_by"]:
            detail += f", {rec['stopped_by']}"
        lines.append(
            f"• {sid}: {rec['net']:+,.0f} ({detail})\n"
            f"   so far {so_far:+,.0f} over {len(current)} days"
        )
    if collection_errors:
        lines.append(f"\n{collection_errors} symbol(s) failed to download — see the run log.")
    if check is not None and check.lines:
        lines.append("\n" + "\n".join(check.lines))
        problems = problems or check.problems
    return Notification(
        source="option-backtesting obt daily",
        severity="warn" if problems else "info",
        title=f"Options daily {day:%a %d %b}: {day_total:+,.0f}",
        body="\n".join(lines) if lines else "No strategies in strategies/legwise/.",
        type="options.daily",
    )


def telegram_failure(day: date, reason: str) -> Notification:
    login = "token" in reason.lower() or "login" in reason.lower()
    return Notification(
        source="option-backtesting obt daily",
        severity="action_required" if login else "error",
        title=f"Options daily {day:%a %d %b} did not run",
        body=reason
        + (
            "\n\nLog in, then run it again the SAME evening — contracts expiring today "
            "cannot be downloaded tomorrow."
            if login
            else ""
        ),
        type="options.problem",
    )
