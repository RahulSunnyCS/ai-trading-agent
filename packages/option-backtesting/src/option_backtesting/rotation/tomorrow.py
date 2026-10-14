"""The "tomorrow" section of the evening result message: how the three public strategies have done
on days like the next session, from the stored history. Read-only.

It is a historical frequency, not a forecast. The next session's weekday and days to expiry are
known tonight; its gap, opening range and VIX are not, and none of those separated winning from
losing days in the study behind this, so they are left out. Every figure is a one-lot gross
per-lot-day basket result (what the research log holds), over the days since `HISTORY_FROM`."""

from __future__ import annotations

from collections.abc import Callable, Iterable
from dataclasses import dataclass
from datetime import date, timedelta
from pathlib import Path

from . import daylog
from .lists import DISPLAY_NAMES

LIST_KEYS = ("A", "B", "C")
#: the first scored day of the recent history (63 days of warm-up after the store began)
HISTORY_FROM = date(2025, 1, 10)
MIN_DAYS = 10  # a condition with fewer days than this is not shown
THIN_DAYS = 30  # fewer than this is flagged
RECENT = 21  # sessions in the "recent form" line


@dataclass(frozen=True)
class Condition:
    label: str
    matches: Callable[[dict], bool]


@dataclass(frozen=True)
class Tomorrow:
    day: date
    weekday: str
    dte_n: str
    dte_s: str
    source: str
    rows: list[tuple[str, int, dict[str, tuple[float, float]]]]  # label, days, {list: (win, avg)}
    recent: dict[str, float]  # list -> win rate of the last RECENT scored sessions
    sessions: int


def next_session(day: date, holidays: dict[date, str] | None = None) -> date:
    """The next weekday after `day` that is not an exchange holiday."""
    holidays = daylog.holiday_names() if holidays is None else holidays
    d = day + timedelta(days=1)
    while not daylog.is_trading_day(d, holidays):
        d += timedelta(days=1)
    return d


def _scored(rows: Iterable[dict]) -> list[dict]:
    return [r for r in rows if r.get("scored") and r.get("source") in ("recorded", "reconstructed")]


def _per_lot_day(row: dict, key: str) -> float | None:
    block = (row.get("lists") or {}).get(key)
    return None if not block else block.get("per_lot_day")


def _stats(rows: list[dict]) -> dict[str, tuple[float, float]]:
    out: dict[str, tuple[float, float]] = {}
    for key in LIST_KEYS:
        values = [v for v in (_per_lot_day(r, key) for r in rows) if v is not None]
        if values:
            out[key] = (sum(1 for v in values if v > 0) / len(values), sum(values) / len(values))
    return out


def conditions(weekday: str, dte_n: str, dte_s: str) -> list[Condition]:
    """The conditions that describe the next session and are known tonight."""

    def dte(row: dict, index: str) -> str | None:
        return (row.get("dte") or {}).get(index)

    out = [
        Condition("all days", lambda r: True),
        Condition(f"{weekday} sessions", lambda r: r.get("weekday") == weekday),
    ]
    if dte_s == "0":
        out.append(Condition("SENSEX expiry day", lambda r: dte(r, "SENSEX") == "0"))
        out.append(
            Condition(
                f"{weekday} and SENSEX expiry day",
                lambda r: r.get("weekday") == weekday and dte(r, "SENSEX") == "0",
            )
        )
    if dte_n == "0":
        out.append(Condition("NIFTY expiry day", lambda r: dte(r, "NIFTY") == "0"))
    if dte_n != "0" and dte_s != "0":
        out.append(
            Condition(
                f"NIFTY {dte_n} / SENSEX {dte_s} days to expiry",
                lambda r: dte(r, "NIFTY") == dte_n and dte(r, "SENSEX") == dte_s,
            )
        )
    return out


def build(
    day: date,
    rows: list[dict],
    weekday: str,
    dte_n: str,
    dte_s: str,
    source: str = "calendar",
) -> Tomorrow:
    """`rows` are daylog rows from before `day`; only scored ones are used."""
    scored = [r for r in _scored(rows) if r["day"] < day.isoformat()]
    table: list[tuple[str, int, dict[str, tuple[float, float]]]] = []
    for cond in conditions(weekday, dte_n, dte_s):
        matched = [r for r in scored if cond.matches(r)]
        if len(matched) >= MIN_DAYS:
            table.append((cond.label, len(matched), _stats(matched)))
    tail = scored[-RECENT:]
    recent = {k: w for k, (w, _) in _stats(tail).items()} if len(tail) >= 5 else {}
    return Tomorrow(day, weekday, dte_n, dte_s, source, table, recent, len(scored))


def for_next_session(today: date, root: Path | None = None) -> Tomorrow:
    """The section for the session after `today`, from the stored history."""
    from .live import calendar_dte_labels

    nxt = next_session(today)
    labels = calendar_dte_labels(nxt)
    log = daylog.build_log(root, start=HISTORY_FROM, source="all")
    return build(nxt, log["rows"], nxt.strftime("%a"), labels["dte_n"], labels["dte_s"])


def render(t: Tomorrow) -> str:
    lines = [
        f"Tomorrow {t.day} ({t.weekday}): NIFTY {t.dte_n} / SENSEX {t.dte_s} days to expiry",
        f"History: {t.sessions} sessions · win rate and average ₹ per lot-day, gross",
    ]
    for label, n, stats in t.rows:
        flag = " (thin)" if n < THIN_DAYS else ""
        cells = "  ".join(
            f"{DISPLAY_NAMES[k]} {100 * stats[k][0]:.0f}% {stats[k][1]:+,.0f}"
            for k in LIST_KEYS
            if k in stats
        )
        lines.append(f"  {label} ({n}d{flag}): {cells}")
    if t.recent:
        cells = ", ".join(f"{DISPLAY_NAMES[k]} {100 * w:.0f}%" for k, w in t.recent.items())
        lines.append(f"  Last {RECENT} sessions' win rate: {cells}")
    lines.append("Historical frequency, not a forecast; gap, opening range and VIX are unknown.")
    return "\n".join(lines)
