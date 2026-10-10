"""The Strategy Matrix: where the rotation's strategy variants make or lose money, by start time,
date and market condition, with the journal's recorded picks laid over it (read-only).

Everything is read from files the nightly job already wrote and this module never writes:

    rotation/results/<variant>.csv   day,net,gross,costs,worst_mtm,stopped_by,n_trades
    rotation/days.csv                day,weekday,vix_open,vix_band,dte_n,dte_s
    rotation/journal.jsonl           the hash chain: the recorded picks of A / B / C / REF

Honest by construction:

* **Gross per one-lot strategy-day.** One variant file is one lot of one strategy. The figures
  are gross (the `costs` column is zero today) and are never scaled to a list's two lots.
* **Alternatives are not a portfolio.** A cell pools variant-days as a mean, a rate or a worst
  value; nothing is ever summed across variants, start times or families.
* **Sessions, not variant-days, are the sample.** Many variants on one date are not independent;
  `n` counts distinct sessions, `nv` the variant-days pooled. A cell under `min_n` sessions is
  flagged `thin`, never hidden.
* **Missing is never zero.** A cell is `ok`, `missing` (no stored result), `excluded` (results
  exist but the filters removed them), `na` (the strategy does not exist, e.g. Buy at 15:17). A
  period whose data is not in the store is `unavailable`. A genuine zero is `ok` with value 0.
* **Selections are what the journal recorded.** The overlay never reconstructs a pick: a day
  with no entry has no overlay, and a late entry (`before_first_entry` false) is excluded from
  the selection statistics (it is shown, flagged, on the date view only).
"""

from __future__ import annotations

import csv
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import date
from pathlib import Path
from typing import Any

import numpy as np
import yaml

from . import journal, store
from .lists import LISTS
from .score import VIX_LABELS
from .variants import CLOSEST, STRATEGIES_DIR, strategy_path

# --- vocabulary ---------------------------------------------------------------------------

VIEWS = ("family_slot", "date_slot", "dte_slot", "vix_family", "weekday_family", "pulse")
METRICS = ("avg", "win_rate", "stop_rate", "worst", "selection")
BASES = ("all", "selected")
PERIOD_IDS = ("P1", "P2", "P3", "forward", "custom")
INDEX_NAMES = {"N": "NIFTY", "S": "SENSEX"}
FAMILY_ORDER = ("wide", *CLOSEST, "dir", "ditm1", "buy")
WEEKDAYS = ("Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun")
DTE_ORDER = ("0", "1", "2", "3", "4", "5", "6", "7+", "unknown")
BAND_ORDER = (*VIX_LABELS, "unknown")
PULSE_WINDOWS = (5, 21, 63)
DEFAULT_MIN_N = 20
LIST_IDS = tuple(LISTS)  # A, B, C, REF

#: family-group aliases a caller may pass instead of exact tags
FAMILY_ALIASES = {
    "widesl": ("wide", *CLOSEST),  # every Widesl, closest-premium ones included
    "dirs": ("dir", "ditm1"),
}

METRIC_INFO: dict[str, dict[str, str]] = {
    "avg": {
        "label": "Average gross per one-lot strategy-day",
        "unit": "inr",
        "scale": "diverging",
        "aggregation": "mean of the gross P&L of the pooled variant-days (one lot each)",
    },
    "win_rate": {
        "label": "Win rate",
        "unit": "fraction",
        "scale": "sequential",
        "aggregation": "share of the pooled variant-days with gross above zero",
    },
    "stop_rate": {
        "label": "Stop-hit rate",
        "unit": "fraction",
        "scale": "sequential",
        "aggregation": "share of the pooled variant-days that ended on the overall stop-loss",
    },
    "worst": {
        "label": "Worst strategy-day",
        "unit": "inr",
        "scale": "diverging",
        "aggregation": "the lowest gross P&L of any one pooled variant-day (not a drawdown)",
    },
    "selection": {
        "label": "Selection frequency",
        "unit": "fraction",
        "scale": "sequential",
        "aggregation": (
            "picks / selection opportunities: of the recorded, on-time entry days (times the "
            "variants pooled), the share on which the chosen list picked the variant"
        ),
    },
}

NOTES = [
    "Gross per one-lot strategy-day: one lot of one strategy, before brokerage and charges. A "
    "list trades two lots a strategy; its figures are not these.",
    "Alternative settings are not a portfolio: no row or column is summed. A summary is a mean "
    "of the pooled strategy-days, labelled as such.",
    "n counts distinct sessions; many variants on one date are not independent observations.",
    "A cell with fewer sessions than the minimum is flagged thin, not hidden.",
    "A strong cell describes where money was made; it is not a rule to change a registered list.",
]


class MatrixError(ValueError):
    """A request the matrix cannot answer; the message is for the user."""


# --- the data -----------------------------------------------------------------------------


@dataclass
class Cube:
    """Every stored variant-day as arrays. NaN in `G` is "no result stored" (never zero)."""

    names: list[str]
    index: np.ndarray  # "N" | "S" per variant
    family: np.ndarray
    slot: np.ndarray  # "0917"
    days: list[date]
    ordinal: np.ndarray  # days as ordinals
    G: np.ndarray  # V x D gross per one lot
    WORST: np.ndarray  # V x D worst_mtm
    STOP: np.ndarray  # V x D bool: stopped_by non-empty
    STOPTXT: np.ndarray  # V x D object: the stopped_by text
    weekday: np.ndarray  # D
    band: np.ndarray  # D (VIX band, "unknown" when absent)
    dte_n: np.ndarray  # D
    dte_s: np.ndarray  # D
    has_attrs: np.ndarray  # D bool: the day is in days.csv

    @property
    def n_variants(self) -> int:
        return len(self.names)


def _float(text: str | None) -> float:
    try:
        return float(text) if text not in (None, "") else float("nan")
    except ValueError:
        return float("nan")


def _split_name(name: str) -> tuple[str, str, str] | None:
    bits = name.split("_")
    if (
        len(bits) != 3
        or bits[0] not in INDEX_NAMES
        or not (len(bits[2]) == 4 and bits[2].isdigit())
    ):
        return None
    return bits[0], bits[1], bits[2]


def _signature(root: Path) -> tuple:
    out: list[tuple] = []
    results = store.results_dir(root)
    paths = sorted(results.glob("*.csv")) if results.exists() else []
    for p in [*paths, store.days_path(root)]:
        try:
            st = p.stat()
            out.append((p.name, st.st_mtime_ns, st.st_size))
        except OSError:
            out.append((p.name, 0, 0))
    return tuple(out)


_CUBE_CACHE: dict[str, Any] = {"key": None, "cube": None}


def load_cube(root: Path | None = None) -> Cube:
    """The stored results as a Cube. Cached on the files' size and mtime, so the nightly write is
    seen on the next request and nothing is re-read otherwise."""
    from ..fyers.daily import data_dir

    root = root or data_dir()
    key = (str(root), _signature(root))
    if _CUBE_CACHE["key"] == key and _CUBE_CACHE["cube"] is not None:
        return _CUBE_CACHE["cube"]
    cube = _read_cube(root)
    _CUBE_CACHE.update(key=key, cube=cube)
    return cube


def _read_cube(root: Path) -> Cube:
    results = store.results_dir(root)
    rows: dict[str, dict[date, tuple[float, float, str]]] = {}
    for path in sorted(results.glob("*.csv")) if results.exists() else []:
        if _split_name(path.stem) is None:
            continue
        by_day: dict[date, tuple[float, float, str]] = {}
        with path.open(newline="") as f:
            for r in csv.DictReader(f):
                try:
                    d = date.fromisoformat(r["day"])
                except (KeyError, ValueError):
                    continue
                by_day[d] = (
                    _float(r.get("gross")),
                    _float(r.get("worst_mtm")),
                    (r.get("stopped_by") or "").strip(),
                )
        if by_day:
            rows[path.stem] = by_day
    names = sorted(rows)
    days = sorted({d for by_day in rows.values() for d in by_day})
    pos = {d: i for i, d in enumerate(days)}
    G = np.full((len(names), len(days)), np.nan)
    W = np.full((len(names), len(days)), np.nan)
    S = np.zeros((len(names), len(days)), dtype=bool)
    T = np.full((len(names), len(days)), "", dtype=object)
    for v, name in enumerate(names):
        for d, (g, w, s) in rows[name].items():
            c = pos[d]
            G[v, c], W[v, c], S[v, c], T[v, c] = g, w, bool(s), s
    attrs = store.read_days(root)
    parts = [_split_name(n) for n in names]
    unknown = "unknown"

    def attr(key: str) -> np.ndarray:
        return np.array([(attrs.get(d) or {}).get(key) or unknown for d in days], dtype=str)

    return Cube(
        names=names,
        index=np.array([p[0] for p in parts if p], dtype=str),
        family=np.array([p[1] for p in parts if p], dtype=str),
        slot=np.array([p[2] for p in parts if p], dtype=str),
        days=days,
        ordinal=np.array([d.toordinal() for d in days], dtype=np.int64),
        G=G,
        WORST=W,
        STOP=S,
        STOPTXT=T,
        weekday=np.array([d.strftime("%a") for d in days], dtype=str),
        band=attr("vix_band"),
        dte_n=attr("dte_n"),
        dte_s=attr("dte_s"),
        has_attrs=np.array([d in attrs for d in days], dtype=bool),
    )


@dataclass
class Journal:
    """The recorded entries, split into on-time (forward) and late. Never reconstructed."""

    available: bool = False
    reason: str | None = None
    entries: dict[date, dict] = field(default_factory=dict)  # every entry by day
    forward: list[date] = field(default_factory=list)  # on-time entries, ascending
    late: list[date] = field(default_factory=list)

    def picks(self, day: date, list_id: str) -> list[str]:
        p = ((self.entries.get(day) or {}).get("lists") or {}).get(list_id) or {}
        return [*p.get("core", []), *p.get("buy", [])]


def load_journal(root: Path | None = None) -> Journal:
    from ..fyers.daily import data_dir

    root = root or data_dir()
    try:
        entries = journal.read(store.journal_path(root))
    except journal.JournalCorrupt as error:
        return Journal(False, f"the journal cannot be read: {error}")
    if not entries:
        return Journal(False, "no entry has been recorded yet (the first is Monday 12 Oct 2026)")
    out = Journal(True)
    for e in entries:
        try:
            d = date.fromisoformat(e["day"])
        except (KeyError, ValueError):
            continue
        out.entries[d] = e
        (out.forward if e.get("before_first_entry") is True else out.late).append(d)
    out.forward.sort()
    out.late.sort()
    return out


# --- periods ------------------------------------------------------------------------------

_P3_REASON = (
    "P3 (2022-04-05 to 2024-10-08, NIFTY only) is not in the rotation store, which starts "
    "2024-10-09: its results come from the research scripts and have not been imported."
)

NAMED = {
    "P1": (date(2025, 12, 3), date(2026, 10, 8), "P1 · Dec 2025 to Oct 2026"),
    "P2": (date(2025, 1, 10), date(2025, 8, 29), "P2 · Jan to Aug 2025"),
}


@dataclass(frozen=True)
class PeriodSel:
    id: str
    label: str
    lo: date | None = None
    hi: date | None = None
    explicit: frozenset[date] | None = None
    status: str = "ok"  # ok | unavailable
    reason: str | None = None

    def mask(self, ordinal: np.ndarray) -> np.ndarray:
        if self.explicit is not None:
            return np.isin(ordinal, [d.toordinal() for d in self.explicit])
        m = np.ones(len(ordinal), dtype=bool)
        if self.lo is not None:
            m &= ordinal >= self.lo.toordinal()
        if self.hi is not None:
            m &= ordinal <= self.hi.toordinal()
        return m


def resolve_period(
    pid: str, jr: Journal, lo: date | None = None, hi: date | None = None
) -> PeriodSel:
    if pid in NAMED:
        a, b, label = NAMED[pid]
        return PeriodSel(pid, label, a, b)
    if pid == "P3":
        return PeriodSel(
            "P3",
            "P3 · Apr 2022 to Oct 2024",
            date(2022, 4, 5),
            date(2024, 10, 8),
            status="unavailable",
            reason=_P3_REASON,
        )
    if pid == "forward":
        if not jr.available or not jr.forward:
            return PeriodSel(
                "forward",
                "Forward · recorded days",
                explicit=frozenset(),
                status="unavailable",
                reason=jr.reason or "no on-time entry has been recorded yet",
            )
        return PeriodSel(
            "forward",
            "Forward · recorded days",
            jr.forward[0],
            jr.forward[-1],
            frozenset(jr.forward),
        )
    if pid == "custom":
        return PeriodSel("custom", f"Custom · {lo or 'start'} to {hi or 'latest'}", lo, hi)
    raise MatrixError(f"period must be one of {', '.join(PERIOD_IDS)}")


# --- filters ------------------------------------------------------------------------------


@dataclass(frozen=True)
class Filters:
    index: str = "both"  # N | S | both
    families: tuple[str, ...] | None = None
    slots: tuple[str, ...] | None = None
    weekdays: tuple[str, ...] | None = None
    dte: tuple[str, ...] | None = None
    vix_bands: tuple[str, ...] | None = None


def _tokens(raw: str | None) -> list[str]:
    # a "+" in a query string arrives as a space ("7+" -> "7 "): put it back
    return [t.lstrip().replace(" ", "+") for t in (raw or "").split(",") if t.strip()]


def parse_filters(
    index: str | None = None,
    family: str | None = None,
    slot: str | None = None,
    weekday: str | None = None,
    dte: str | None = None,
    vix_band: str | None = None,
) -> Filters:
    word = (index or "both").strip()
    idx = {"nifty": "N", "n": "N", "sensex": "S", "s": "S", "both": "both", "": "both"}.get(
        word.lower()
    )
    if idx is None:
        raise MatrixError("index must be NIFTY, SENSEX or both")
    fams: list[str] = []
    for t in _tokens(family):
        if t == "all":
            fams = []
            break
        if t in FAMILY_ALIASES:
            fams.extend(FAMILY_ALIASES[t])
        elif t.isalnum():
            fams.append(t)
        else:
            raise MatrixError(f"unknown family {t!r}")
    slots = [s.replace(":", "") for s in _tokens(slot)]
    for s in slots:
        if not (len(s) == 4 and s.isdigit()):
            raise MatrixError(f"start time {s!r} must be HHMM")
    wds = [w.capitalize() for w in _tokens(weekday)]
    for w in wds:
        if w not in WEEKDAYS:
            raise MatrixError(f"weekday {w!r} must be one of {', '.join(WEEKDAYS)}")
    dtes = _tokens(dte)
    for x in dtes:
        if x not in DTE_ORDER:
            raise MatrixError(f"dte {x!r} must be one of {', '.join(DTE_ORDER)}")
    bands = _tokens(vix_band)
    for b in bands:
        if b not in BAND_ORDER:
            raise MatrixError(f"vix_band {b!r} must be one of {', '.join(BAND_ORDER)}")
    return Filters(
        idx,
        tuple(dict.fromkeys(fams)) or None,
        tuple(slots) or None,
        tuple(wds) or None,
        tuple(dtes) or None,
        tuple(bands) or None,
    )


def effective_filters(view: str, f: Filters) -> Filters:
    """The date and DTE views are about one kind of strategy, so an unset index means NIFTY and an
    unset family means Widesl (the research's anchor family). The response echoes the result."""
    if view in ("date_slot", "dte_slot"):
        f = Filters(
            "N" if f.index == "both" else f.index,
            f.families or ("wide",),
            f.slots,
            f.weekdays,
            f.dte,
            f.vix_bands,
        )
    if view == "date_slot" and len(f.families or ()) != 1:
        raise MatrixError("the date view needs one family (one strategy kind): pick one")
    return f


def filters_echo(f: Filters) -> dict:
    return {
        "index": {"N": "NIFTY", "S": "SENSEX", "both": "both"}[f.index],
        "family": list(f.families) if f.families else None,
        "slot": list(f.slots) if f.slots else None,
        "weekday": list(f.weekdays) if f.weekdays else None,
        "dte": list(f.dte) if f.dte else None,
        "vix_band": list(f.vix_bands) if f.vix_bands else None,
    }


# --- labels -------------------------------------------------------------------------------


def slot_label(tag: str) -> str:
    return f"{tag[:2]}:{tag[2:]}" if len(tag) == 4 else tag


_SETTINGS_CACHE: dict[tuple[str, str], dict] = {}


def variant_settings(name: str, directory: Path | None = None) -> dict:
    """What a variant file says (entry, strike, stops), for the cell drawer. {} when unreadable."""
    key = (str(directory or STRATEGIES_DIR), name)
    if key in _SETTINGS_CACHE:
        return _SETTINGS_CACHE[key]
    out: dict = {}
    try:
        text = strategy_path(name, directory).read_text()
        spec = (yaml.safe_load(text) or {}).get("strategy", {})
        legs = spec.get("legs") or []
        leg = legs[0] if legs else {}
        strike = leg.get("strike") or {}
        stop = leg.get("stop_loss") or {}
        out = {
            "id": spec.get("id"),
            "underlying": spec.get("underlying"),
            "entry": spec.get("entry_time"),
            "exit": spec.get("exit_time"),
            "position": leg.get("position"),
            "legs": len(legs),
            "strike": strike.get("strike_type")
            or (
                f"closest premium {strike['closest_premium']}"
                if "closest_premium" in strike
                else None
            ),
            "leg_stop_percent": stop.get("percent"),
            "trail": leg.get("trail_sl"),
            "reentry": leg.get("reentry_on_sl"),
            "overall_stop_inr": (spec.get("overall") or {}).get("stop_loss_inr"),
            "square_off": spec.get("square_off"),
        }
    except (OSError, yaml.YAMLError, AttributeError, TypeError):
        out = {}
    _SETTINGS_CACHE[key] = out
    return out


def family_label(index: str, tag: str, directory: Path | None = None) -> str:
    """ "NIFTY Widesl OTM1": the strike comes from the strategy file, so a label never claims a
    setting the file does not have."""
    u = INDEX_NAMES.get(index, index)
    strike = variant_settings(f"{index}_{tag}_0917", directory).get("strike")
    if tag.startswith("p") and tag[1:].isdigit():
        return f"{u} Widesl, premium {tag[1:]}"
    kind = {"wide": "Widesl", "dir": "Dir", "ditm1": "Dir", "buy": "Buy"}.get(tag)
    if kind is None:
        return f"{u} {tag}"
    return f"{u} {kind}" + (f" {strike}" if strike else "")


# --- sources: one matrix + its validity + its time axis -----------------------------------


@dataclass
class TimeAxis:
    days: list[date]
    ordinal: np.ndarray
    weekday: np.ndarray
    band: np.ndarray
    dte_n: np.ndarray
    dte_s: np.ndarray

    def __len__(self) -> int:
        return len(self.days)

    @classmethod
    def of_days(cls, days: list[date]) -> TimeAxis:
        """An axis that carries dates only (the date view's rows)."""
        blank = np.full(len(days), "", dtype=str)
        return cls(
            days,
            np.array([d.toordinal() for d in days], dtype=np.int64),
            np.array([d.strftime("%a") for d in days], dtype=str),
            blank,
            blank,
            blank,
        )


@dataclass
class Source:
    axis: TimeAxis
    M: np.ndarray  # V x T values pooled (gross, or the 0/1 pick indicator)
    valid: np.ndarray  # V x T bool: there is a value to pool
    STOP: np.ndarray | None = None
    kind: str = "perf"  # perf | selection


def perf_source(cube: Cube) -> Source:
    axis = TimeAxis(cube.days, cube.ordinal, cube.weekday, cube.band, cube.dte_n, cube.dte_s)
    return Source(axis, cube.G, ~np.isnan(cube.G), cube.STOP, "perf")


def selection_source(cube: Cube, jr: Journal, list_id: str) -> Source:
    """Pick indicator per variant over the recorded, on-time entry days: 1 if the list picked it.
    Eligibility needs no result: a recorded day is an opportunity whether or not it is scored."""
    days = jr.forward
    entries = [jr.entries[d] for d in days]
    unknown = "unknown"
    axis = TimeAxis(
        days,
        np.array([d.toordinal() for d in days], dtype=np.int64),
        np.array(
            [e.get("weekday") or d.strftime("%a") for d, e in zip(days, entries, strict=True)],
            dtype=str,
        ),
        np.array([e.get("vix_band") or unknown for e in entries], dtype=str),
        np.array([str((e.get("dte") or {}).get("NIFTY") or unknown) for e in entries], dtype=str),
        np.array([str((e.get("dte") or {}).get("SENSEX") or unknown) for e in entries], dtype=str),
    )
    pos = {n: i for i, n in enumerate(cube.names)}
    M = np.zeros((cube.n_variants, len(days)))
    for j, d in enumerate(days):
        for name in jr.picks(d, list_id):
            if name in pos:
                M[pos[name], j] = 1.0
    return Source(axis, M, np.ones_like(M, dtype=bool), None, "selection")


def pick_matrix(cube: Cube, jr: Journal, list_id: str) -> np.ndarray:
    """V x D bool on the results axis: the list picked the variant that (on-time, recorded) day."""
    out = np.zeros((cube.n_variants, len(cube.days)), dtype=bool)
    pos = {n: i for i, n in enumerate(cube.names)}
    col = {d: i for i, d in enumerate(cube.days)}
    for d in jr.forward:
        c = col.get(d)
        if c is None:
            continue
        for name in jr.picks(d, list_id):
            if name in pos:
                out[pos[name], c] = True
    return out


# --- items: the rows and columns of a view -------------------------------------------------


@dataclass
class Item:
    key: str
    label: str
    v: np.ndarray | None = None  # variant mask
    tfn: Callable[[TimeAxis], np.ndarray] | None = None  # time mask
    dte: str | None = None  # own-index days-to-expiry label (variant x time)
    windowed: bool = False  # keep the last `window` sessions the pooled variants have results on
    window: int | None = None  # None with windowed = every session
    meta: dict = field(default_factory=dict)


def _base_variants(cube: Cube, f: Filters) -> np.ndarray:
    m = np.ones(cube.n_variants, dtype=bool)
    if f.index != "both":
        m &= cube.index == f.index
    if f.families:
        m &= np.isin(cube.family, f.families)
    if f.slots:
        m &= np.isin(cube.slot, f.slots)
    return m


def _family_pairs(cube: Cube, base_v: np.ndarray) -> list[tuple[str, str]]:
    pairs = {
        (str(i), str(fam)) for i, fam in zip(cube.index[base_v], cube.family[base_v], strict=True)
    }

    def order(p: tuple[str, str]) -> tuple[int, int, str]:
        f = FAMILY_ORDER.index(p[1]) if p[1] in FAMILY_ORDER else 99
        return (0 if p[0] == "N" else 1, f, p[1])

    return sorted(pairs, key=order)


def _family_item(cube: Cube, index: str, fam: str, directory: Path | None) -> Item:
    return Item(
        f"{index}:{fam}",
        family_label(index, fam, directory),
        (cube.index == index) & (cube.family == fam),
        meta={"index": INDEX_NAMES[index], "family": fam},
    )


def _slot_items(cube: Cube, base_v: np.ndarray) -> list[Item]:
    slots = sorted({str(s) for s in cube.slot[base_v]})
    return [Item(s, slot_label(s), cube.slot == s, meta={"slot": s}) for s in slots]


def _attr_item(prefix: str, key: str, label: str, attr: str) -> Item:
    return Item(key, label, tfn=lambda ax: getattr(ax, attr) == key, meta={prefix: key})


def _on_day(ordinal: int) -> Callable[[TimeAxis], np.ndarray]:
    return lambda ax: ax.ordinal == ordinal


def _window_item(n: int | None) -> Item:
    return Item(
        "all" if n is None else str(n),
        "All stored days" if n is None else f"Last {n} sessions",
        windowed=True,
        window=n,
        meta={"window": n},
    )


def build_axes(
    cube: Cube,
    view: str,
    f: Filters,
    *,
    dates: list[date] | None = None,
    as_of: date | None = None,
    directory: Path | None = None,
) -> tuple[list[Item], list[Item], np.ndarray]:
    """(rows, cols, base_v) of a view. `f` is already the effective filters. Axes depend on the
    store and the filters, never on the period, so two periods compared share identical axes."""
    base_v = _base_variants(cube, f)
    if view == "family_slot":
        rows = [_family_item(cube, i, fam, directory) for i, fam in _family_pairs(cube, base_v)]
        return rows, _slot_items(cube, base_v), base_v
    if view == "date_slot":
        rows = [
            Item(
                d.isoformat(),
                f"{d.isoformat()} {d.strftime('%a')}",
                tfn=_on_day(d.toordinal()),
                meta={"date": d.isoformat(), "weekday": d.strftime("%a")},
            )
            for d in (dates or [])
        ]
        return rows, _slot_items(cube, base_v), base_v
    if view == "dte_slot":
        present = set(cube.dte_n.tolist()) | set(cube.dte_s.tolist())
        rows = [
            Item(
                lab,
                f"{lab} days to expiry" if lab != "unknown" else "DTE unknown",
                dte=lab,
                meta={"dte": lab},
            )
            for lab in DTE_ORDER
            if lab in present
        ]
        return rows, _slot_items(cube, base_v), base_v
    fam_cols = [_family_item(cube, i, fam, directory) for i, fam in _family_pairs(cube, base_v)]
    if view == "vix_family":
        present = set(cube.band.tolist())
        rows = [
            _attr_item("vix_band", lab, lab if lab != "unknown" else "VIX unknown", "band")
            for lab in BAND_ORDER
            if lab != "unknown" or lab in present
        ]
        return rows, fam_cols, base_v
    if view == "weekday_family":
        present = set(cube.weekday.tolist())
        return (
            [_attr_item("weekday", w, w, "weekday") for w in WEEKDAYS if w in present],
            fam_cols,
            base_v,
        )
    if view == "pulse":
        cols = [*(_window_item(n) for n in PULSE_WINDOWS), _window_item(None)]
        return fam_cols, cols, base_v
    raise MatrixError(f"view must be one of {', '.join(VIEWS)}")


# --- pooling ------------------------------------------------------------------------------


@dataclass
class Ctx:
    """What one matrix is computed from: the source, the period and the conditions."""

    cube: Cube
    src: Source
    t_period: np.ndarray
    t_cond: np.ndarray
    f: Filters
    min_n: int
    basis_mask: np.ndarray | None = None  # V x T bool, "selected only"
    overlay: dict[str, np.ndarray] | None = None  # list -> V x T bool (perf axis)
    rec_cols: np.ndarray | None = None  # T bool: a recorded on-time entry day


def _cond_mask(axis: TimeAxis, f: Filters) -> np.ndarray:
    m = np.ones(len(axis), dtype=bool)
    if f.weekdays:
        m &= np.isin(axis.weekday, f.weekdays)
    if f.vix_bands:
        m &= np.isin(axis.band, f.vix_bands)
    return m


def _round(x: float | None, nd: int = 2) -> float | None:
    return None if x is None or not np.isfinite(x) else round(float(x), nd)


def pool(ctx: Ctx, vmask: np.ndarray, items: tuple[Item, ...]) -> dict:
    """Pool the variant-days at the intersection of `vmask`, the period and the items' day / DTE
    masks. `pre` is how many existed before the conditions, `nv` after, `n` distinct sessions."""
    src = ctx.src
    tm = ctx.t_period.copy()
    for it in items:
        if it.tfn is not None:
            tm &= it.tfn(src.axis)
    vi, ti = np.flatnonzero(vmask), np.flatnonzero(tm)
    if vi.size == 0 or ti.size == 0:
        return {"pre": 0, "nv": 0, "n": 0}
    ix = np.ix_(vi, ti)
    pre = src.valid[ix]
    for it in items:
        if it.windowed and it.window is not None:
            # the last N sessions these variants have a value on, not the last N calendar rows
            have = np.flatnonzero(pre.any(axis=0))
            keep = np.zeros(ti.size, dtype=bool)
            keep[have[-it.window :]] = True
            pre = pre & keep[None, :]
    post = pre & ctx.t_cond[ti][None, :]
    wanted = [it.dte for it in items if it.dte is not None]
    if wanted or ctx.f.dte:
        # each variant's own index days-to-expiry on each day (NIFTY variants: dte_n, SENSEX: dte_s)
        nifty = (ctx.cube.index[vi] == "N")[:, None]
        own = np.where(nifty, src.axis.dte_n[ti][None, :], src.axis.dte_s[ti][None, :])
        for w in wanted:
            post &= own == w
        if ctx.f.dte:
            post &= np.isin(own, ctx.f.dte)
    if ctx.basis_mask is not None:
        post &= ctx.basis_mask[ix]
    out: dict[str, Any] = {"pre": int(pre.sum()), "nv": int(post.sum())}
    out["n"] = int(post.any(axis=0).sum()) if out["nv"] else 0
    if out["nv"] == 0:
        return out
    vals = src.M[ix][post]
    if src.kind == "selection":
        out["sel"] = float(vals.mean())
        return out
    stop = src.STOP[ix][post] if src.STOP is not None else np.zeros(vals.shape, dtype=bool)
    out.update(
        avg=float(vals.mean()),
        win_rate=float((vals > 0).mean()),
        stop_rate=float(stop.mean()),
        worst=float(vals.min()),
    )
    if ctx.overlay is not None and ctx.rec_cols is not None:
        rec = ctx.rec_cols[ti][None, :] & post
        out["rec"] = int(rec.sum())
        out["by"] = {k: int((m[ix] & rec).sum()) for k, m in ctx.overlay.items()}
    return out


def cell_dict(
    stats: dict,
    metric: str,
    min_n: int,
    *,
    observation: bool = False,
    reason_missing: str = "no stored result",
    excluded_reason: str = "removed by the filters",
) -> dict:
    """One cell as the API returns it. `v` is the chosen metric; `n` distinct sessions, `nv`
    variant-days; `m` every metric (for the tooltip); `st` is omitted when the cell is ok."""
    if stats["nv"] == 0:
        if stats["pre"] > 0:
            return {"st": "excluded", "reason": excluded_reason, "n": 0, "nv": 0}
        return {"st": "missing", "reason": reason_missing, "n": 0, "nv": 0}
    key = "sel" if metric == "selection" else metric
    digits = 2 if metric in ("avg", "worst") else 4
    c: dict[str, Any] = {"v": _round(stats.get(key), digits), "n": stats["n"], "nv": stats["nv"]}
    if "avg" in stats:
        c["m"] = {"avg": _round(stats["avg"], 2), "stop_rate": _round(stats["stop_rate"], 4)}
        if not observation:
            c["m"].update(win_rate=_round(stats["win_rate"], 4), worst=_round(stats["worst"], 2))
    if not observation and stats["n"] < min_n:
        c["thin"] = True
    if stats.get("by") and any(stats["by"].values()):
        c["sel"] = {k: v for k, v in stats["by"].items() if v}
        c["rec"] = stats.get("rec", 0)
    return c


NA_CELL = {"st": "na", "reason": "this strategy does not exist here"}


def _scale(cells: list[dict], kind: str, percentile: float | None = None) -> dict:
    vals = [c["v"] for c in cells if c.get("v") is not None and not c.get("thin")]
    if not vals:
        vals = [c["v"] for c in cells if c.get("v") is not None]
    if not vals:
        return {"kind": kind, "min": 0.0, "max": 0.0, "limit": 0.0, "clipped": False}
    if kind == "diverging":
        a = np.abs(np.array(vals, dtype=float))
        limit = float(np.percentile(a, percentile)) if percentile else float(a.max())
        return {
            "kind": kind,
            "min": -limit,
            "max": limit,
            "limit": limit,
            "clipped": bool(percentile),
        }
    top = float(max(vals))
    return {"kind": kind, "min": 0.0, "max": top, "limit": top, "clipped": False}


def _excluded_reason(ctx: Ctx) -> str:
    parts = []
    if ctx.f.weekdays:
        parts.append("weekday")
    if ctx.f.vix_bands:
        parts.append("VIX band")
    if ctx.f.dte:
        parts.append("days-to-expiry")
    if ctx.basis_mask is not None:
        parts.append("selected-only")
    return "removed by the " + (" / ".join(parts) if parts else "filters") + " filter"


def _union(items: list[Item]) -> np.ndarray | None:
    masks = [i.v for i in items]
    if not masks or any(m is None for m in masks):
        return None
    return np.logical_or.reduce(masks)


def matrix_for(
    ctx: Ctx,
    view: str,
    metric: str,
    rows: list[Item],
    cols: list[Item],
    base_v: np.ndarray,
) -> dict:
    """One period's matrix: cells (rows x cols), row and column summaries (means, not sums)."""
    observation = view == "date_slot"
    pulse = view == "pulse"
    miss = (
        "no recorded entry in this period"
        if ctx.src.kind == "selection"
        else "no stored result in this period"
    )
    why = _excluded_reason(ctx)

    def make(vm: np.ndarray, items: tuple[Item, ...], obs: bool) -> dict:
        if not vm.any():
            return dict(NA_CELL)
        return cell_dict(
            pool(ctx, vm, items),
            metric,
            ctx.min_n,
            observation=obs,
            reason_missing=miss,
            excluded_reason=why,
        )

    cells: list[list[dict]] = []
    flat: list[dict] = []
    for r in rows:
        line = []
        for c in cols:
            vm = base_v.copy()
            for it in (r, c):
                if it.v is not None:
                    vm &= it.v
            cell = make(vm, (r, c), observation)
            line.append(cell)
            flat.append(cell)
        cells.append(line)

    def summary(one: Item, others: list[Item]) -> dict:
        vm = base_v.copy()
        if one.v is not None:
            vm &= one.v
        u = _union(others)
        if u is not None:
            vm &= u
        return make(vm, (one,), False)

    return {
        "cells": cells,
        # a pulse's windows overlap, so a row pooled across them would count a session twice
        "row_summary": None if pulse else [summary(r, cols) for r in rows],
        "col_summary": None if pulse else [summary(c, rows) for c in cols],
        "flat": flat,
    }


# --- the public entry points --------------------------------------------------------------


def period_meta(cube: Cube, jr: Journal, p: PeriodSel) -> dict:
    sessions = None
    waiting = None
    if p.status == "ok" and cube.n_variants:
        m = p.mask(cube.ordinal)
        scored = (~np.isnan(cube.G[:, m])).any(axis=0)
        sessions = int(scored.sum())
        if p.id == "forward":
            have = {cube.days[i] for i in np.flatnonzero(m)[scored]}
            waiting = [d.isoformat() for d in jr.forward if d not in have]
    return {
        "id": p.id,
        "label": p.label,
        "from": p.lo.isoformat() if p.lo else None,
        "to": p.hi.isoformat() if p.hi else None,
        "status": p.status,
        "reason": p.reason,
        "sessions": sessions,
        "waiting_on_results": waiting,
    }


def overlay_info(jr: Journal, cube: Cube) -> dict:
    scored = (
        {cube.days[i] for i in np.flatnonzero((~np.isnan(cube.G)).any(axis=0))}
        if cube.n_variants
        else set()
    )
    return {
        "source": "recorded",
        "available": jr.available,
        "reason": None if jr.available else jr.reason,
        "entries": len(jr.entries),
        "on_time": len(jr.forward),
        "late": [d.isoformat() for d in jr.late],
        "scored": sum(1 for d in jr.forward if d in scored),
        "waiting_on_results": [d.isoformat() for d in jr.forward if d not in scored],
        "lists": list(LIST_IDS),
        "reconstructed": (
            "Reconstructed picks are not shown: the overlay is what the journal recorded at "
            "09:16. Days before the first entry have no overlay."
        ),
    }


def meta_for(cube: Cube, jr: Journal) -> dict:
    present = sorted({(str(i), str(f)) for i, f in zip(cube.index, cube.family, strict=True)})
    order = {
        p: (p[0] != "N", FAMILY_ORDER.index(p[1]) if p[1] in FAMILY_ORDER else 99) for p in present
    }
    return {
        "views": list(VIEWS),
        "metrics": {
            k: {"label": v["label"], "unit": v["unit"], "scale": v["scale"]}
            for k, v in METRIC_INFO.items()
        },
        "slots": sorted({str(s) for s in cube.slot}),
        "families": [
            {"index": INDEX_NAMES[i], "family": f, "key": f"{i}:{f}", "label": family_label(i, f)}
            for i, f in sorted(present, key=lambda p: order[p])
        ],
        "weekdays": [w for w in WEEKDAYS if w in set(cube.weekday.tolist())],
        "dte": [x for x in DTE_ORDER if x in set(cube.dte_n.tolist()) | set(cube.dte_s.tolist())],
        "vix_bands": list(BAND_ORDER),
        "store": {
            "variants": cube.n_variants,
            "first": cube.days[0].isoformat() if cube.days else None,
            "last": cube.days[-1].isoformat() if cube.days else None,
            "sessions": len(cube.days),
            "days_without_attributes": [
                d.isoformat() for d, ok in zip(cube.days, cube.has_attrs, strict=True) if not ok
            ],
        },
        "lists": {k: lst.description for k, lst in LISTS.items()},
        "journal": {
            "available": jr.available,
            "reason": jr.reason,
            "on_time": len(jr.forward),
            "late": len(jr.late),
        },
    }


def _validate(view, metric, basis, list_id, min_n):
    if view not in VIEWS:
        raise MatrixError(f"view must be one of {', '.join(VIEWS)}")
    if metric not in METRICS:
        raise MatrixError(f"metric must be one of {', '.join(METRICS)}")
    if basis not in BASES:
        raise MatrixError(f"basis must be one of {', '.join(BASES)}")
    if list_id is not None and list_id not in LISTS:
        raise MatrixError(f"list must be one of {', '.join(LIST_IDS)}")
    if min_n < 1:
        raise MatrixError("min_n must be at least 1")
    if metric == "selection" and list_id is None:
        raise MatrixError("selection frequency needs a list (A, B, C or REF)")
    if basis == "selected" and list_id is None:
        raise MatrixError("selected-only needs a list (A, B, C or REF)")
    if basis == "selected" and metric == "selection":
        raise MatrixError("selection frequency is already about the picks; use All opportunities")


def _date_rows(cube: Cube, jr: Journal, p: PeriodSel) -> list[date]:
    """The dates of the period that have a stored result or a recorded entry."""
    if p.status != "ok":
        return []
    have = {d for d, ok in zip(cube.days, p.mask(cube.ordinal), strict=True) if ok}
    if p.id == "forward":
        have |= set(jr.forward)
    return sorted(have)


def _as_of(view: str, hi: date | None, cube: Cube) -> date | None:
    if view != "pulse":
        return None
    return hi or (cube.days[-1] if cube.days else None)


def compute(
    cube: Cube,
    jr: Journal,
    *,
    view: str,
    metric: str = "avg",
    period: str = "P1",
    compare: tuple[str, str] | None = None,
    lo: date | None = None,
    hi: date | None = None,
    filters: Filters | None = None,
    min_n: int = DEFAULT_MIN_N,
    list_id: str | None = None,
    basis: str = "all",
    directory: Path | None = None,
) -> dict:
    """The matrix response: per period a grid of cells over shared axes, one colour scale and,
    for a comparison, the difference."""
    _validate(view, metric, basis, list_id, min_n)
    if compare and view in ("pulse", "date_slot"):
        raise MatrixError(
            "the pulse is as of one day" if view == "pulse" else "dates differ between periods"
        )
    if compare and (len(compare) != 2 or compare[0] == compare[1]):
        raise MatrixError("compare takes two different periods, e.g. P1,P2")
    if cube.n_variants == 0:
        return {
            "available": False,
            "reason": "no strategy has stored results yet",
            "meta": meta_for(cube, jr),
        }
    f = effective_filters(view, filters or Filters())
    periods = [resolve_period(p, jr, lo, hi) for p in (compare or (period,))]
    info = METRIC_INFO[metric]

    overlay = rec_cols = None
    sel_masks: dict[str, np.ndarray] = {}
    if jr.available and jr.forward:
        sel_masks = {k: pick_matrix(cube, jr, k) for k in LIST_IDS}
        overlay, rec_cols = sel_masks, np.isin(cube.days, jr.forward)

    as_of = _as_of(view, hi, cube)
    dates = _date_rows(cube, jr, periods[0]) if view == "date_slot" else None
    rows, cols, base_v = build_axes(cube, view, f, dates=dates, as_of=as_of, directory=directory)
    perf = perf_source(cube)

    matrices: list[dict] = []
    for p in periods:
        if p.status != "ok":
            matrices.append({"period": p.id, "status": "unavailable", "reason": p.reason})
            continue
        if metric == "selection":
            if not (jr.available and jr.forward):
                reason = jr.reason or "no on-time entry has been recorded yet"
                matrices.append({"period": p.id, "status": "unavailable", "reason": reason})
                continue
            src = selection_source(cube, jr, list_id or "A")
            ctx = Ctx(
                cube, src, _t_period(view, p, src.axis, as_of), _cond_mask(src.axis, f), f, min_n
            )
            sessions = int(ctx.t_period.sum())
        else:
            t_period = _t_period(view, p, perf.axis, as_of)
            basis_mask = None
            if basis == "selected":
                basis_mask = sel_masks.get(
                    list_id or "A", np.zeros((cube.n_variants, len(cube.days)), dtype=bool)
                )
            ctx = Ctx(
                cube,
                perf,
                t_period,
                _cond_mask(perf.axis, f),
                f,
                min_n,
                basis_mask,
                overlay,
                rec_cols,
            )
            sessions = int((perf.valid[base_v][:, t_period]).any(axis=0).sum())
        built = matrix_for(ctx, view, metric, rows, cols, base_v)
        matrices.append(
            {"period": p.id, "status": "ok", "reason": None, "sessions": sessions, **built}
        )

    ok = [m for m in matrices if m["status"] == "ok"]
    flat = [c for m in ok for c in m["flat"]]
    scale = _scale(flat, info["scale"], 95.0 if view == "date_slot" else None) if ok else None
    for m in matrices:
        m.pop("flat", None)

    return {
        "available": True,
        "view": view,
        "metric": metric,
        "basis": basis,
        "list": list_id,
        "unit": info["unit"],
        "metric_label": info["label"],
        "aggregation": info["aggregation"],
        "selection_denominator": (
            "picks / selection opportunities: recorded on-time entry days x the variants a cell "
            "pools. A one-variant cell is the share of recorded days the list picked it. Late "
            "entries are excluded."
            if metric == "selection"
            else None
        ),
        "filters": filters_echo(f),
        "min_n": min_n,
        "rows": [{"key": r.key, "label": r.label, **r.meta} for r in rows],
        "cols": [{"key": c.key, "label": c.label, **c.meta} for c in cols],
        "periods": [period_meta(cube, jr, p) for p in periods],
        "matrices": matrices,
        "scale": scale,
        "difference": _difference(matrices, info["unit"]) if compare else None,
        "overlay": overlay_info(jr, cube),
        "date_picks": _date_picks(jr, rows, cols, base_v, cube) if view == "date_slot" else None,
        "as_of": as_of.isoformat() if as_of else None,
        "meta": meta_for(cube, jr),
        "all_periods": [
            period_meta(cube, jr, resolve_period(p, jr, lo, hi))
            for p in ("P1", "P2", "P3", "forward")
        ],
        "notes": NOTES,
    }


def _t_period(view: str, p: PeriodSel, axis: TimeAxis, as_of: date | None) -> np.ndarray:
    """Which of the axis' days the matrix reads. The pulse is as of one day, whatever the period."""
    if view == "pulse":
        return axis.ordinal <= (as_of.toordinal() if as_of else 10**9)
    return p.mask(axis.ordinal)


def _difference(matrices: list[dict], unit: str) -> dict:
    a, b = matrices
    if a["status"] != "ok" or b["status"] != "ok":
        bad = a if a["status"] != "ok" else b
        return {"status": "unavailable", "reason": bad.get("reason")}
    cells: list[list[dict]] = []
    flat: list[dict] = []
    for ra, rb in zip(a["cells"], b["cells"], strict=True):
        line = []
        for ca, cb in zip(ra, rb, strict=True):
            if ca.get("v") is None or cb.get("v") is None:
                both_na = ca.get("st") == "na" and cb.get("st") == "na"
                d: dict[str, Any] = (
                    dict(NA_CELL)
                    if both_na
                    else {"st": "missing", "reason": "one of the periods has no value here"}
                )
            else:
                d = {
                    "v": _round(ca["v"] - cb["v"], 4 if unit == "fraction" else 2),
                    "n": [ca["n"], cb["n"]],
                    "nv": [ca["nv"], cb["nv"]],
                }
                if ca.get("thin") or cb.get("thin"):
                    d["thin"] = True
            line.append(d)
            flat.append(d)
        cells.append(line)
    return {
        "status": "ok",
        "minuend": a["period"],
        "subtrahend": b["period"],
        "cells": cells,
        "scale": _scale(flat, "diverging"),
        "unit": unit,
        "note": "the first period minus the second, per-lot averages, so unequal lengths compare",
    }


def _date_picks(
    jr: Journal, rows: list[Item], cols: list[Item], base_v: np.ndarray, cube: Cube
) -> dict:
    """{date: {"late": bool, "cells": {slot: [lists]}}} for the dates with a recorded entry: the
    lists that picked the variant at each start time (the date view's overlay)."""
    by_name: dict[str, str] = {}
    for c in cols:
        vm = base_v & c.v if c.v is not None else base_v
        for i in np.flatnonzero(vm):
            by_name[cube.names[int(i)]] = c.key
    out: dict[str, Any] = {}
    for r in rows:
        d = date.fromisoformat(r.key)
        if d not in jr.entries:
            continue
        cells: dict[str, list[str]] = {}
        for k in LIST_IDS:
            for name in jr.picks(d, k):
                if name in by_name:
                    cells.setdefault(by_name[name], []).append(k)
        out[r.key] = {"late": d in jr.late, "cells": cells}
    return out


# --- the cell drill-down ------------------------------------------------------------------


def drill(
    cube: Cube,
    jr: Journal,
    *,
    view: str,
    row: str,
    col: str,
    period: str = "P1",
    lo: date | None = None,
    hi: date | None = None,
    filters: Filters | None = None,
    list_id: str | None = None,
    basis: str = "all",
    directory: Path | None = None,
) -> dict:
    """The daily values behind one cell: per session the mean gross of the variants the cell
    pools (the value itself for a one-strategy cell), the running total of those, the
    contributing variants with their settings, and the sessions the lists recorded a pick in."""
    _validate(view, "avg", basis, list_id, DEFAULT_MIN_N)
    if cube.n_variants == 0:
        raise MatrixError("no strategy has stored results yet")
    f = effective_filters(view, filters or Filters())
    p = resolve_period(period, jr, lo, hi)
    if p.status != "ok":
        raise MatrixError(p.reason or "that period is not available")
    perf = perf_source(cube)
    as_of = _as_of(view, hi, cube)
    dates = _date_rows(cube, jr, p) if view == "date_slot" else None
    rows, cols, base_v = build_axes(cube, view, f, dates=dates, as_of=as_of, directory=directory)
    r = next((x for x in rows if x.key == row), None)
    c = next((x for x in cols if x.key == col), None)
    if r is None or c is None:
        raise MatrixError("that cell is not in this view")
    vm = base_v.copy()
    for it in (r, c):
        if it.v is not None:
            vm &= it.v
    if not vm.any():
        raise MatrixError("this strategy does not exist here")
    tm = _t_period(view, p, perf.axis, as_of) & _cond_mask(perf.axis, f)
    for it in (r, c):
        if it.tfn is not None:
            tm &= it.tfn(perf.axis)
    vi, ti = np.flatnonzero(vm), np.flatnonzero(tm)
    ix = np.ix_(vi, ti)
    valid = perf.valid[ix].copy()
    nifty = (cube.index[vi] == "N")[:, None]
    own = np.where(nifty, cube.dte_n[ti][None, :], cube.dte_s[ti][None, :])
    for it in (r, c):
        if it.dte is not None:
            valid &= own == it.dte
    if f.dte:
        valid &= np.isin(own, f.dte)
    picks = {k: pick_matrix(cube, jr, k) for k in LIST_IDS} if jr.available and jr.forward else {}
    if basis == "selected":
        valid &= picks[list_id][ix] if list_id in picks else False
    G = cube.G[ix]

    daily: list[dict] = []
    curve: list[dict] = []
    cum = peak = max_dd = 0.0
    for k, ci in enumerate(ti):
        ok = np.flatnonzero(valid[:, k])
        if ok.size == 0:
            continue
        vals = G[ok, k]
        cum += float(vals.mean())
        peak = max(peak, cum)
        max_dd = min(max_dd, cum - peak)
        d = cube.days[int(ci)]
        variant_rows = vi[ok]
        stopped = [
            cube.STOPTXT[int(v), int(ci)] for v in variant_rows if cube.STOP[int(v), int(ci)]
        ]
        item: dict[str, Any] = {
            "day": d.isoformat(),
            "weekday": d.strftime("%a"),
            "gross": _round(float(vals.mean()), 2),
            "n_variants": int(vals.size),
            "n_stopped": len(stopped),
        }
        if vals.size == 1:
            item["stopped_by"] = stopped[0] if stopped else ""
            item["worst_mtm"] = _round(float(cube.WORST[int(variant_rows[0]), int(ci)]), 2)
        who = [k2 for k2, pm in picks.items() if pm[variant_rows, int(ci)].any()]
        if who:
            item["picked_by"] = who
        daily.append(item)
        curve.append({"day": d.isoformat(), "cum": _round(cum, 2)})

    all_vals = G[valid]
    stats: dict[str, Any] = {"sessions": len(daily), "variant_days": int(valid.sum())}
    if all_vals.size:
        per_day = np.array([x["gross"] for x in daily], dtype=float)
        stats.update(
            avg=_round(float(all_vals.mean()), 2),
            win_rate=_round(float((all_vals > 0).mean()), 4),
            stop_rate=_round(float(cube.STOP[ix][valid].mean()), 4),
            worst=_round(float(all_vals.min()), 2),
            best=_round(float(all_vals.max()), 2),
            median_day=_round(float(np.median(per_day)), 2),
            # the sessions the single worst / best strategy-day fell on (not the daily mean)
            worst_day=cube.days[
                int(ti[np.unravel_index(np.argmin(np.where(valid, G, np.inf)), G.shape)[1]])
            ].isoformat(),
            best_day=cube.days[
                int(ti[np.unravel_index(np.argmax(np.where(valid, G, -np.inf)), G.shape)[1]])
            ].isoformat(),
            cumulative=_round(cum, 2),
            max_drawdown=_round(max_dd, 2),
        )
    variants = []
    for j, v in enumerate(vi):
        if not valid[j].any():
            continue
        g = G[j][valid[j]]
        entry: dict[str, Any] = {
            "name": cube.names[int(v)],
            "n": int(g.size),
            "avg": _round(float(g.mean()), 2),
            "win_rate": _round(float((g > 0).mean()), 4),
            "worst": _round(float(g.min()), 2),
        }
        if vi.size <= 8:
            entry["settings"] = variant_settings(cube.names[int(v)], directory)
        variants.append(entry)
        if len(variants) >= 60:
            break
    return {
        "view": view,
        "row": {"key": r.key, "label": r.label},
        "col": {"key": c.key, "label": c.label},
        "period": p.id,
        "period_label": p.label,
        "basis": basis,
        "list": list_id,
        "pooling": (
            "one strategy: each value is its gross for one lot"
            if vi.size == 1
            else f"a mean of up to {int(vi.size)} strategies a day, one lot each; the running "
            "total adds those daily means over time and is not a basket"
        ),
        "stats": stats,
        "days": daily,
        "cumulative": curve,
        "variants": variants,
        "variants_total": int(vi.size),
        "overlay": overlay_info(jr, cube),
    }
