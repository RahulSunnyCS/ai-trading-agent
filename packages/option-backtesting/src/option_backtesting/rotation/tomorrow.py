"""The "tomorrow" part of the evening message: the strategies the 09:16 job would pick for the
next session if tonight's conditions stand, listed in full (`NextPicks`, `next_session_picks`).
Read-only.

`expected_picks` re-runs the 09:16 ranking on the stored results with the market's last close
standing in for the opening VIX, under the expiring-index rule (BL-122) for that session, for the
live list or for a parallel track's universe. Since BL-125 the message shows only those picks. The
chance of each pick, the likely changes, and the win-rate and mean tables (`build`, `Tomorrow`,
`conditions`: a historical frequency, not a forecast, most of it re-scored in-sample) are no longer
sent; the helpers are kept, tested, for the dashboard or a later message."""

from __future__ import annotations

from collections.abc import Callable, Iterable
from dataclasses import dataclass
from datetime import date, timedelta
from pathlib import Path

from . import daylog
from .lists import PUBLIC_KEYS

#: the lists shown: the public ones (Steady and Adaptive); the base is a separate column
LIST_KEYS = PUBLIC_KEYS
BASE_KEY = "base"
#: the first scored day of the recent history (63 days of warm-up after the store began)
HISTORY_FROM = date(2025, 1, 10)
MIN_SCENARIO = 0.05  # a change less likely than this is not worth a line
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
    next_best: dict[str, dict[str, str | None]] | None = None  # list -> {wide, dir}
    #: the index Adaptive is restricted to on that session (BL-122), or None
    expiry_only: str | None = None


@dataclass(frozen=True)
class Tomorrow:
    day: date
    weekday: str
    dte_n: str
    dte_s: str
    rows: list[tuple[str, int, dict[str, tuple[float, float]]]]  # label, days, {list: (win, avg)}
    recent: dict[str, float]  # list -> win rate of the last RECENT scored sessions
    sessions: int
    forward: int = 0  # of `sessions`, recorded forward (the rest were re-scored from history)
    base_days: int = 0  # sessions with a scored base figure
    expected: Expected | None = None


def next_session(day: date, holidays: dict[date, str] | None = None) -> date:
    """The next weekday after `day` that is not an exchange holiday."""
    holidays = daylog.holiday_names() if holidays is None else holidays
    d = day + timedelta(days=1)
    while not daylog.is_trading_day(d, holidays):
        d += timedelta(days=1)
    return d


def _scored(rows: Iterable[dict]) -> list[dict]:
    """Recorded-forward and re-scored days that have a figure for every list shown; a late
    recording is not a pick that was fixed before the open, so it is left out."""
    return [
        r
        for r in rows
        if r.get("source") in ("recorded", "reconstructed")
        and r.get("status") != "late"
        and all(_per_lot_day(r, k) is not None for k in LIST_KEYS)
    ]


def _per_lot_day(row: dict, key: str) -> float | None:
    block = (row.get("lists") or {}).get(key)
    return None if not block else block.get("per_lot_day")


def _win_avg(values: list[float]) -> tuple[float, float]:
    return sum(1 for v in values if v > 0) / len(values), sum(values) / len(values)


def _stats(
    rows: list[dict], base: dict[str, float] | None = None
) -> dict[str, tuple[float, float]]:
    """Win rate and mean ₹ per lot-day of each list over `rows`, plus the fixed base over the
    same days when `base` (day -> per-lot gross) has them."""
    out: dict[str, tuple[float, float]] = {}
    for key in LIST_KEYS:
        values = [v for v in (_per_lot_day(r, key) for r in rows) if v is not None]
        if values:
            out[key] = _win_avg(values)
    if base:
        values = [base[r["day"]] for r in rows if r["day"] in base]
        if values:
            out[BASE_KEY] = _win_avg(values)
    return out


def conditions(weekday: str, dte_n: str, dte_s: str) -> list[Condition]:
    """The rows: fixed in advance from what is known tonight, never picked by their results."""

    def dte(row: dict, index: str) -> str | None:
        return (row.get("dte") or {}).get(index)

    return [
        Condition("all days", lambda r: True),
        Condition(f"{weekday} sessions", lambda r: r.get("weekday") == weekday),
        Condition(
            f"NIFTY {dte_n} / SENSEX {dte_s} weekdays to expiry",
            lambda r: dte(r, "NIFTY") == dte_n and dte(r, "SENSEX") == dte_s,
        ),
    ]


def build(
    day: date,
    rows: list[dict],
    weekday: str,
    dte_n: str,
    dte_s: str,
    base: dict[str, float] | None = None,
) -> Tomorrow:
    """`rows` are daylog rows; only scored ones from before `day` are used. `base` maps a day
    ('YYYY-MM-DD') to the fixed base's gross per lot."""
    scored = [r for r in _scored(rows) if r["day"] < day.isoformat()]
    table: list[tuple[str, int, dict[str, tuple[float, float]]]] = []
    for cond in conditions(weekday, dte_n, dte_s):
        matched = [r for r in scored if cond.matches(r)]
        if len(matched) >= MIN_DAYS:
            table.append((cond.label, len(matched), _stats(matched, base)))
    tail = scored[-RECENT:]
    recent = {k: w for k, (w, _) in _stats(tail).items()} if len(tail) >= 5 else {}
    forward = sum(1 for r in scored if r.get("source") == "recorded")
    base_days = sum(1 for r in scored if base and r["day"] in base)
    return Tomorrow(day, weekday, dte_n, dte_s, table, recent, len(scored), forward, base_days)


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


def vix_transitions(root: Path, last_day: date | None = None) -> dict[str, dict[str, float]]:
    """P(open band of the next session | band of this session's close), from the stored days up
    to `last_day` (so a re-run for a past day never sees what came after it)."""
    from . import attrs as attrs_mod
    from . import store
    from .score import vix_band

    days = store.read_days(root)
    ordered = sorted(d for d in days if last_day is None or d <= last_day)
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
    day: date, root: Path, dte_n: str, dte_s: str, last_day: date, track: str | None = None
) -> Expected | None:
    """Re-run the 09:16 ranking for `day` from the stored results: with the market's last close
    standing in for tomorrow's opening conditions, and for each band the open could land in.
    `track` ranks over Core-298 plus that parallel track's variants, as `pick --track` does."""
    from . import attrs as attrs_mod
    from . import expiry, pick, score, store
    from .variants import track_names, variant_names

    dte = {"dte_n": dte_n, "dte_s": dte_s}
    # the rule the 09:16 job will apply to that session (BL-122), so every figure below is for
    # the picks it would actually record
    rule = expiry.rule_index(day, dte)
    vix = attrs_mod.vix_close_from_lake(root, last_day)
    if vix is None:  # no close in the lake: the last stored open is the next best
        vix = (store.read_days(root).get(last_day) or {}).get("vix_open")
        vix = float(vix) if vix not in (None, "") else None
    if vix is None:
        return None
    names = variant_names() + (track_names(track) if track else [])
    hist = pick.load_history(day, root, names)

    def picks_at(v: float) -> Picks:
        r = pick.score_history(hist, day, v, dte, expiry_only=rule)
        return {k: (r[k]["core"], r[k]["buy"]) for k in LIST_KEYS}

    order = list(score.VIX_LABELS)
    by_band = {}
    for lo, hi, label in zip(score.VIX_BINS[:-1], score.VIX_BINS[1:], order, strict=True):
        by_band[label] = picks_at((lo + hi) / 2 if hi < 1e6 else lo + 3)
    base_band = score.vix_band(vix)
    if base_band not in by_band:
        return None
    trans = vix_transitions(root, last_day).get(base_band) or {}
    weights = trans or {b: 1.0 if b == base_band else 0.0 for b in order}
    expected = build_expected(picks_at(vix), by_band, order, base_band, weights)
    options = {
        k: v
        for k, v in pick.next_best(hist, day, vix, dte, expiry_only=rule).items()
        if k in LIST_KEYS
    }
    return Expected(
        expected.picks,
        expected.likelihood,
        expected.same,
        expected.scenarios,
        options,
        rule,
    )


@dataclass(frozen=True)
class NextPicks:
    """What the 09:16 job would pick for the next session if tonight's conditions stand: the
    evening message lists these strategies in full (BL-125)."""

    day: date
    weekday: str
    core: list[str]
    buy: list[str]
    options: dict[str, str | None] | None
    #: the index Adaptive is restricted to on that session (BL-122), or None
    expiry_only: str | None
    #: {'NIFTY': '2', 'SENSEX': '4'}: weekdays to each index's expiry on that session
    dte: dict[str, str] | None = None


def next_session_picks(
    today: date, root: Path | None = None, track: str | None = None
) -> NextPicks | None:
    """Adaptive's expected picks for the session after `today` (`track`: that parallel track's
    universe), from the stored results; None when they cannot be worked out. The same ranking,
    VIX stand-in and expiry rule as the 09:16 job, via `expected_picks`."""
    from ..fyers.daily import data_dir
    from .live import calendar_dte_labels

    root = root or data_dir()
    nxt = next_session(today)
    labels = calendar_dte_labels(nxt)
    expected = expected_picks(nxt, root, labels["dte_n"], labels["dte_s"], today, track)
    if expected is None:
        return None
    key = LIST_KEYS[0]
    core, buy = expected.picks[key]
    return NextPicks(
        nxt,
        nxt.strftime("%a"),
        list(core),
        list(buy),
        (expected.next_best or {}).get(key),
        expected.expiry_only,
        {"NIFTY": labels["dte_n"], "SENSEX": labels["dte_s"]},
    )
