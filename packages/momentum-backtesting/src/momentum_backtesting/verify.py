"""Restated-history check (BL-001 Phase 4, re-scoped 2026-10-22).

A new Friday's data is expected. What this catches is OLD history changing underneath a result:
a vendor restating a close, a re-run sync replacing bars, a corporate action added with an
ex-date in the past. `mbt verify history` fingerprints everything up to an anchor Friday (a fixed
date, so new weeks never trip it), stores that as the baseline, and on each later check names the
instruments whose history up to the same anchor no longer matches.

What it fingerprints, per instrument and calendar year (a row count and an order-independent hash
of every row, so an edited value that keeps the count still shows):

  price:<instrument>|<kind>   `momentum_prices` (ETFs, indexes, premiums, signal series)
  bars:<symbol>               the stock daily bars in the lake (open/high/low/close/volume/...)
  action:<symbol>             `corporate_actions` by ex-date
  table:<name>                the two stock-action review tables, by ex-date

It says WHICH instrument and the EARLIEST YEAR that moved. It does not re-run any strategy, so it
does not say whether a result moved; `scripts/result-baseline.py` does that. Read-only on the
shared database. Nothing is accepted automatically: a change stays a change until `--accept
--reason` re-baselines (and the reason is appended to a log).
"""

from __future__ import annotations

import json
import subprocess
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Any

import duckdb

BASELINE_FILE = "history_baseline.json"
LOG_FILE = "history_baseline_log.jsonl"
#: The default anchor is the last Friday at least this many days back, so the stopgap rows the
#: Fyers top-up writes for the newest week (replaced by the real sync) are never inside it.
ANCHOR_LAG_DAYS = 14
#: A clean check advances the anchor once it is this far behind the default one.
ADVANCE_AFTER_DAYS = 28
SCHEMA = 1

Fingerprint = dict[str, dict[str, list]]  # label -> year -> [rows, hash]


def default_anchor(today: date) -> date:
    """The last Friday on or before `today - ANCHOR_LAG_DAYS`."""
    day = today - timedelta(days=ANCHOR_LAG_DAYS)
    return day - timedelta(days=(day.weekday() - 4) % 7)


def _add(out: Fingerprint, label: str, year: Any, rows: int, digest: Any) -> None:
    out.setdefault(label, {})[str(int(year))] = [int(rows), str(digest)]


def fingerprint(anchor: date, root: Path | None = None, *, bars: bool = True) -> Fingerprint:
    """Everything up to and including `anchor`. `bars=False` skips the stock lake (tests)."""
    from . import db_read

    out: Fingerprint = {}
    with db_read.open_catalog(root, read_only=True) as con:
        for instrument, kind, year, rows, digest in con.execute(
            "SELECT instrument, kind, year(date), count(*), sum(hash(t))::VARCHAR "
            "FROM momentum_prices t WHERE date <= ? GROUP BY ALL",
            [anchor],
        ).fetchall():
            _add(out, f"price:{instrument}|{kind}", year, rows, digest)
        for symbol, year, rows, digest in con.execute(
            "SELECT symbol_at_ex, year(ex_date), count(*), sum(hash(t))::VARCHAR "
            "FROM corporate_actions t WHERE ex_date <= ? GROUP BY ALL",
            [anchor],
        ).fetchall():
            _add(out, f"action:{symbol}", year, rows, digest)
        for table in ("stock_action_candidates", "stock_action_reviews"):
            for year, rows, digest in con.execute(
                f"SELECT year(ex_date), count(*), sum(hash(t))::VARCHAR "  # noqa: S608
                f"FROM {table} t WHERE ex_date <= ? GROUP BY ALL",
                [anchor],
            ).fetchall():
                _add(out, f"table:{table}", year, rows, digest)
    if bars:
        with db_read.stock_bars(root) as mem:
            for symbol, year, rows, digest in mem.execute(
                "SELECT i.symbol, year(b.date), count(*), "
                "sum(hash(ROW(b.date, b.series, b.open, b.high, b.low, b.close, b.prevclose, "
                "b.volume, b.turnover, b.synthetic_close)))::VARCHAR "
                "FROM bars_1d_stock b JOIN instruments i USING (instrument_id) "
                "WHERE b.date <= ? GROUP BY ALL",
                [anchor],
            ).fetchall():
                _add(out, f"bars:{symbol}", year, rows, digest)
    return out


@dataclass
class Change:
    label: str
    first_year: int
    rows_before: int
    rows_after: int


@dataclass
class Diff:
    changed: list[Change] = field(default_factory=list)
    removed: list[str] = field(default_factory=list)
    added: list[str] = field(default_factory=list)

    @property
    def clean(self) -> bool:
        """Added history alone is information (a newly registered symbol), not a restatement."""
        return not self.changed and not self.removed


def diff(baseline: Fingerprint, current: Fingerprint) -> Diff:
    """What moved between two fingerprints taken at the same anchor."""
    out = Diff()
    for label, years in sorted(baseline.items()):
        now = current.get(label)
        if now is None:
            out.removed.append(label)
            continue
        moved = sorted(y for y in set(years) | set(now) if years.get(y) != now.get(y))
        if moved:
            out.changed.append(
                Change(
                    label,
                    int(moved[0]),
                    sum(v[0] for v in years.values()),
                    sum(v[0] for v in now.values()),
                )
            )
    out.added = sorted(set(current) - set(baseline))
    return out


def _commit() -> str | None:
    package = Path(__file__).resolve().parents[2]
    done = subprocess.run(
        ["git", "rev-parse", "HEAD"],
        cwd=package,
        capture_output=True,
        text=True,
        timeout=20,
        check=False,
    )
    return done.stdout.strip() or None


def baseline_path(state: Path) -> Path:
    return state / BASELINE_FILE


def load_baseline(state: Path) -> dict | None:
    path = baseline_path(state)
    if not path.exists():
        return None
    data = json.loads(path.read_text())
    if data.get("schema") != SCHEMA:
        # Returning None would record a new baseline over this one and lose any unaccepted change.
        raise ValueError(f"{path} has schema {data.get('schema')}, this code reads {SCHEMA}")
    return data


def save_baseline(
    state: Path, anchor: date, labels: Fingerprint, *, event: str, reason: str | None = None
) -> None:
    """Append the event to the log, then replace the baseline. The log goes first: a failed log
    write must not leave a new baseline nobody can account for."""
    state.mkdir(parents=True, exist_ok=True)
    now = datetime.now().astimezone().isoformat(timespec="seconds")
    record = {
        "schema": SCHEMA,
        "anchor": anchor.isoformat(),
        "created_at": now,
        "commit": _commit(),
        "duckdb": duckdb.__version__,
        "labels": labels,
    }
    entry = {
        "at": now,
        "event": event,
        "anchor": anchor.isoformat(),
        "reason": reason,
        "labels": len(labels),
        "commit": record["commit"],
    }
    with (state / LOG_FILE).open("a") as handle:
        handle.write(json.dumps(entry) + "\n")
    tmp = baseline_path(state).with_suffix(".tmp")
    tmp.write_text(json.dumps(record, separators=(",", ":")))
    tmp.replace(baseline_path(state))


@dataclass
class Outcome:
    status: str  # new_baseline | ok | changed | accepted
    anchor: date
    diff: Diff = field(default_factory=Diff)
    advanced_to: date | None = None


def run(
    state: Path,
    today: date,
    *,
    root: Path | None = None,
    accept: bool = False,
    reason: str | None = None,
    bars: bool = True,
) -> Outcome:
    """One check. No baseline: write one at the default anchor. Otherwise re-fingerprint at the
    BASELINE's anchor and diff. A clean check whose anchor is `ADVANCE_AFTER_DAYS` behind the
    default one moves the baseline forward (the old part was just verified, so only the weeks
    after it are new)."""
    target = default_anchor(today)
    stored = load_baseline(state)
    if stored is None:
        labels = fingerprint(target, root, bars=bars)
        save_baseline(state, target, labels, event="new_baseline")
        return Outcome("new_baseline", target)

    if stored.get("duckdb") != duckdb.__version__ and not accept:
        # DuckDB's hash() is not promised stable across versions: every label would look changed.
        raise ValueError(
            f"the baseline was made with DuckDB {stored.get('duckdb')}, this is "
            f"{duckdb.__version__}: re-baseline with --accept --reason"
        )
    anchor = date.fromisoformat(stored["anchor"])
    current = fingerprint(anchor, root, bars=bars)
    found = diff(stored["labels"], current)
    if accept:
        if not reason:
            raise ValueError("--accept needs --reason")
        save_baseline(state, anchor, current, event="accepted", reason=reason)
        return Outcome("accepted", anchor, found)
    if not found.clean:
        return Outcome("changed", anchor, found)
    if (target - anchor).days > ADVANCE_AFTER_DAYS:
        labels = fingerprint(target, root, bars=bars)
        save_baseline(state, target, labels, event="advanced")
        return Outcome("ok", anchor, found, advanced_to=target)
    return Outcome("ok", anchor, found)


def summary(outcome: Outcome, limit: int = 12) -> tuple[str, str]:
    """(title, body) for the console and the Telegram message."""
    day = outcome.anchor.strftime("%d %b %Y")
    if outcome.status == "new_baseline":
        return (
            f"History baseline recorded at {day}",
            "No earlier baseline existed. Later checks name any instrument whose history up to "
            "this date changes.",
        )
    if outcome.status == "accepted":
        return (
            f"History baseline accepted at {day}",
            f"{len(outcome.diff.changed)} changes taken.",
        )
    if outcome.status == "ok":
        extra = f" Baseline moved forward to {outcome.advanced_to}." if outcome.advanced_to else ""
        added = f" {len(outcome.diff.added)} new series have history (information only)."
        return (
            f"History up to {day} unchanged",
            "Every fingerprinted instrument matches its baseline." + extra + added,
        )
    d = outcome.diff
    lines = [
        f"History up to {day} has changed: {len(d.changed)} instruments moved, "
        f"{len(d.removed)} lost all history."
    ]
    for change in d.changed[:limit]:
        lines.append(
            f"• {change.label}: from {change.first_year} "
            f"({change.rows_before} rows then, {change.rows_after} now)"
        )
    if len(d.changed) > limit:
        lines.append(f"• … and {len(d.changed) - limit} more")
    lines.extend(f"• LOST {label}" for label in d.removed[:limit])
    lines.append(
        "Results that read these instruments may have moved. Look at the cause, then re-baseline "
        "with: mbt verify history --accept --reason '...'"
    )
    return (f"Restated history — up to {day}", "\n".join(lines))
