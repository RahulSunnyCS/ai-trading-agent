"""
The evening routine behind `obt daily`: run every leg-wise strategy in a
folder over one collected day, save each result as JSON, and summarise the day
against everything saved so far.

Results live next to the market data, under `<FYERS_DATA_DIR>/results/legwise/
<date>/<strategy_id>.json`, each stamped with a hash of the strategy file that
produced it. The running totals only add up results whose hash matches the
strategy file as it is now — after a strategy edit, the old days are reported
as stale (re-run them with `obt daily --date ...` or `obt legwise run`), never
silently mixed with the new version's numbers.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from datetime import date
from pathlib import Path

from ..data.reference.loader import ReferenceData, default_reference_data
from ..notify import Notification
from .engine import DayResult, simulate_day
from .market import load_day, minute_label
from .schema import LegwiseStrategy, load_legwise


@dataclass(frozen=True)
class StrategyFile:
    path: Path
    strategy: LegwiseStrategy
    sha: str


def load_strategy_files(folder: Path) -> list[StrategyFile]:
    files = []
    for path in sorted(folder.glob("*.yaml")):
        sha = hashlib.sha256(path.read_bytes()).hexdigest()[:12]
        files.append(StrategyFile(path, load_legwise(path), sha))
    return files


def results_dir(root: Path) -> Path:
    return root / "results" / "legwise"


def _to_json(result: DayResult, file: StrategyFile) -> dict:
    return {
        "strategy_id": file.strategy.id,
        "strategy_sha": file.sha,
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


def run_day(
    day: date,
    root: Path,
    files: list[StrategyFile],
    reference: ReferenceData | None = None,
) -> list[dict]:
    """Simulate every strategy on `day` and save one JSON per strategy.
    A strategy whose underlying was not collected that day is skipped with a
    note rather than failing the whole evening."""
    reference = reference or default_reference_data()
    out_dir = results_dir(root) / day.isoformat()
    loaded: dict[str, object] = {}
    saved = []
    for file in files:
        underlying = file.strategy.underlying
        if underlying not in loaded:
            try:
                loaded[underlying] = load_day(root, underlying, day)
            except FileNotFoundError as error:
                loaded[underlying] = error
        data = loaded[underlying]
        if isinstance(data, FileNotFoundError):
            saved.append(
                {"strategy_id": file.strategy.id, "day": day.isoformat(), "skipped": str(data)}
            )
            continue
        record = _to_json(simulate_day(file.strategy, data, reference), file)  # type: ignore[arg-type]
        out_dir.mkdir(parents=True, exist_ok=True)
        (out_dir / f"{file.strategy.id}.json").write_text(json.dumps(record, indent=2))
        saved.append(record)
    return saved


def _trades(n: int) -> str:
    return f"{n} trade{'' if n == 1 else 's'}"


def load_history(root: Path) -> list[dict]:
    return [json.loads(p.read_text()) for p in sorted(results_dir(root).glob("*/*.json"))]


def summary(day: date, today: list[dict], history: list[dict], files: list[StrategyFile]) -> str:
    lines = [f"Leg-wise strategies — {day:%a %d %b %Y}"]
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
    return Notification(
        source="option-backtesting obt daily",
        severity="warn" if problems else "info",
        title=f"Options daily {day:%a %d %b}: {day_total:+,.0f}",
        body="\n".join(lines) if lines else "No strategies in strategies/legwise/.",
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
    )
