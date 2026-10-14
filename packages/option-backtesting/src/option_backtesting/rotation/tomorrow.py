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

#: the lists shown: Steady (A) and Adaptive (C); Calendar is left out of the tomorrow section
LIST_KEYS = ("A", "C")
#: the first scored day of the recent history (63 days of warm-up after the store began)
HISTORY_FROM = date(2025, 1, 10)
MIN_DAYS = 10  # a condition with fewer days than this is not shown
THIN_DAYS = 30  # fewer than this is flagged
RECENT = 21  # sessions in the "recent form" line


@dataclass(frozen=True)
class Condition:
    label: str
    matches: Callable[[dict], bool]


Picks = dict[str, tuple[list[str], list[str]]]  # list -> (core, buy)


@dataclass(frozen=True)
class Scenario:
    """A way tomorrow's opening conditions could differ from tonight's close, and what changes."""

    label: str  # "calmer open" | "more volatile open"
    probability: float
    changes: dict[str, tuple[list[str], list[str]]]  # list -> (added, dropped)


@dataclass(frozen=True)
class Expected:
    """The picks the 09:16 job would record tomorrow if the conditions at tonight's close hold,
    how likely each pick is across the plausible openings, and the probable changes."""

    picks: Picks
    likelihood: dict[str, dict[str, float]]  # list -> strategy -> probability it is picked
    same: float  # probability the opening leaves the picks as they are
    scenarios: list[Scenario]


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
    expected: Expected | None = None


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


def _flat(picks: tuple[list[str], list[str]]) -> list[str]:
    return [*picks[0], *picks[1]]


def build_expected(
    base: Picks,
    by_band: dict[str, Picks],
    order: list[str],
    base_band: str,
    weights: dict[str, float],
) -> Expected:
    """`by_band`: the picks for each opening band; `weights`: P(open band | close band)."""
    total = sum(weights.get(b, 0.0) for b in order) or 1.0
    w = {b: weights.get(b, 0.0) / total for b in order}
    likelihood = {
        k: {n: sum(w[b] for b in order if n in _flat(by_band[b][k])) for n in _flat(base[k])}
        for k in base
    }
    same = sum(w[b] for b in order if all(_flat(by_band[b][k]) == _flat(base[k]) for k in base))
    pos = order.index(base_band) if base_band in order else 0
    groups: dict[tuple, dict] = {}
    for i, b in enumerate(order):
        if all(_flat(by_band[b][k]) == _flat(base[k]) for k in base) or w[b] <= 0:
            continue
        label = "calmer open" if i < pos else "more volatile open"
        key = (label, tuple((k, tuple(_flat(by_band[b][k]))) for k in sorted(base)))
        g = groups.setdefault(key, {"label": label, "p": 0.0, "picks": by_band[b]})
        g["p"] += w[b]
    scenarios = []
    for g in sorted(groups.values(), key=lambda x: -x["p"]):
        changes = {}
        for k in base:
            now, then = _flat(g["picks"][k]), _flat(base[k])
            changes[k] = ([n for n in now if n not in then], [n for n in then if n not in now])
        scenarios.append(Scenario(g["label"], g["p"], changes))
    return Expected(base, likelihood, same, scenarios)


def vix_transitions(root: Path) -> dict[str, dict[str, float]]:
    """P(open band of the next session | band of this session's close), from the stored days."""
    from . import attrs as attrs_mod
    from . import store
    from .score import vix_band

    days = store.read_days(root)
    ordered = sorted(days)
    counts: dict[str, dict[str, int]] = {}
    for prev, nxt in zip(ordered, ordered[1:], strict=False):
        close = attrs_mod.vix_close_from_lake(root, prev)
        open_band = days[nxt].get("vix_band")
        if close is None or not open_band or open_band == "unknown":
            continue
        row = counts.setdefault(vix_band(close), {})
        row[open_band] = row.get(open_band, 0) + 1
    out: dict[str, dict[str, float]] = {}
    for frm, row in counts.items():
        n = sum(row.values())
        out[frm] = {to: c / n for to, c in row.items()} if n >= 20 else {}
    return out


def expected_picks(
    day: date, root: Path, dte_n: str, dte_s: str, last_day: date
) -> Expected | None:
    """Re-run the 09:16 ranking for `day` from the stored results: with the market's last close
    standing in for tomorrow's opening conditions, and for each band the open could land in."""
    from . import attrs as attrs_mod
    from . import pick, score, store
    from .variants import variant_names

    vix = attrs_mod.vix_close_from_lake(root, last_day)
    if vix is None:  # no close in the lake: the last stored open is the next best
        vix = (store.read_days(root).get(last_day) or {}).get("vix_open")
        vix = float(vix) if vix not in (None, "") else None
    if vix is None:
        return None
    hist = pick.load_history(day, root, variant_names())
    dte = {"dte_n": dte_n, "dte_s": dte_s}

    def picks_at(v: float) -> Picks:
        r = pick.score_history(hist, day, v, dte)
        return {k: (r[k]["core"], r[k]["buy"]) for k in LIST_KEYS}

    order = list(score.VIX_LABELS)
    by_band = {}
    for lo, hi, label in zip(score.VIX_BINS[:-1], score.VIX_BINS[1:], order, strict=True):
        by_band[label] = picks_at((lo + hi) / 2 if hi < 1e6 else lo + 3)
    base_band = score.vix_band(vix)
    if base_band not in by_band:
        return None
    trans = vix_transitions(root).get(base_band) or {}
    weights = trans or {b: 1.0 if b == base_band else 0.0 for b in order}
    return build_expected(picks_at(vix), by_band, order, base_band, weights)


def for_next_session(today: date, root: Path | None = None) -> Tomorrow:
    """The section for the session after `today`, from the stored history."""
    from ..fyers.daily import data_dir
    from .live import calendar_dte_labels

    root = root or data_dir()
    nxt = next_session(today)
    labels = calendar_dte_labels(nxt)
    log = daylog.build_log(root, start=HISTORY_FROM, source="all")
    section = build(nxt, log["rows"], nxt.strftime("%a"), labels["dte_n"], labels["dte_s"])
    try:
        expected = expected_picks(nxt, root, labels["dte_n"], labels["dte_s"], today)
    except Exception:  # noqa: BLE001 - the base rates still go out without the picks
        expected = None
    return Tomorrow(**{**section.__dict__, "expected": expected})


def render(t: Tomorrow) -> str:
    lines = [f"Tomorrow {t.day} ({t.weekday}): NIFTY {t.dte_n} / SENSEX {t.dte_s} days to expiry"]
    e = t.expected
    if e is not None:
        lines.append("Expected picks if the conditions at the close stay the same:")
        for key in LIST_KEYS:
            core, buy = e.picks[key]
            names = [f"{n} ({100 * e.likelihood[key].get(n, 0):.0f}%)" for n in [*core, *buy]]
            lines.append(f"  {DISPLAY_NAMES[key]}: {', '.join(names)}")
        if e.scenarios:
            lines.append("Probable changes if the opening conditions shift:")
            for sc in e.scenarios[:3]:
                grouped: dict[tuple, list[str]] = {}
                for key in LIST_KEYS:
                    added, dropped = sc.changes[key]
                    if added or dropped:
                        grouped.setdefault((tuple(added), tuple(dropped)), []).append(
                            DISPLAY_NAMES[key]
                        )
                parts = [
                    " and ".join(who)
                    + " "
                    + " ".join([*(f"+{n}" for n in a_), *(f"-{n}" for n in d_)])
                    for (a_, d_), who in grouped.items()
                ]
                lines.append(f"  {sc.label} (~{100 * sc.probability:.0f}%): " + "; ".join(parts))
        lines.append("The final picks are recorded at 09:16.")
    lines.append(f"History: {t.sessions} sessions · win rate and average ₹ per lot-day, gross")
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
    lines.append("Historical frequency, not a forecast; the opening conditions are not known yet.")
    return "\n".join(lines)
