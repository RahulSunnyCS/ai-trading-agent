"""The daily decision-to-result log: for each trading day, what the lists picked at 09:16 and what
those picks then did (BL-058 Phase 4, the "Daily log" of the Options Lab rotation workspace).

Read-only. Nothing here writes to the journal, the stored results, the day attributes or a list;
the owner's placement record is a separate file (`placements.py`). A figure that the ranking code
computes (the picks, whether the Widesl minimum overrode rank, whether a Buy qualified) is READ from
the journal entry; the reconstructed rows for days before the journal began call the very same
`pick.score_history` the 09:16 job calls, so the two cannot differ by construction (a test checks
that they agree on a day recorded the normal way).

Two kinds of row, never mixed up:

* **recorded**: a journal entry (hash-chained, written at 09:16). A `late` one (written after
  09:17) is shown but is not forward and is left out of every forward counter.
* **reconstructed**: a research-history day before the journal began, re-scored afterwards with
  the stored results of the days before it and that day's VIX open, weekday and days to expiry
  from `days.csv`. Describes what the rule WOULD have picked; the weights were chosen on this
  history, so it is not evidence of an edge.

A trading day with no entry is `not_recorded` and is listed, never zero-filled. A pick with no
stored result is `waiting` and says which; the list's gross is only given when every pick has one.
Gross basis (the stored `costs` column is zero). A list holds `lots_per_strategy` lots in each
strategy (2), so its totals are for 6 lots, or 8 with the Buy add-on, and are only compared across
lists per lot-day.
"""

from __future__ import annotations

import csv
import math
import threading
from bisect import bisect_left
from dataclasses import dataclass, field
from datetime import date, datetime, time, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

import numpy as np

from ..data.reference.loader import REFERENCE_DIR, default_reference_data
from ..fyers.daily import data_dir
from . import journal, pick, placements, store
from .lists import LISTS, LOTS_PER, WARMUP
from .variants import UNDERLYING, is_buy, is_dir, is_wide, parts, variant_names

IST = ZoneInfo("Asia/Kolkata")

#: The first trading day the journal was registered to record (BL-058 Phase 0b).
REGISTERED_FIRST_DAY = date(2026, 10, 12)
RECORD_TIME = "09:16"
SOURCES = ("recorded", "reconstructed", "all")
#: A reconstructed window with no `from` is this many calendar days back from `to`.
RECON_DEFAULT_DAYS = 180
STOP_FLAGS = ("sl", "target")


def now_ist() -> datetime:
    return datetime.now(IST)


# --- reading the stored results --------------------------------------------------------------


def _number(text: str | None) -> float | None:
    try:
        value = float(text) if text not in (None, "") else math.nan
    except ValueError:
        return None
    return value if math.isfinite(value) else None


def read_rows(name: str, root: Path) -> dict[date, dict]:
    """{day: {gross, worst_mtm, stopped_by, n_trades}} of one variant's stored results. A row that
    does not parse is left out (a missing day is never read as zero)."""
    path = store.results_dir(root) / f"{name}.csv"
    if not path.exists():
        return {}
    out: dict[date, dict] = {}
    with path.open(newline="") as f:
        for r in csv.DictReader(f):
            try:
                day = date.fromisoformat(r["day"])
            except (KeyError, ValueError):
                continue
            gross = _number(r.get("gross"))
            if gross is None:
                continue
            worst = _number(r.get("worst_mtm"))
            n_trades = _number(r.get("n_trades"))
            out[day] = {
                "gross": round(gross, 2),
                "worst_mtm": None if worst is None else round(worst, 2),
                "stopped_by": (r.get("stopped_by") or "").strip(),
                "n_trades": None if n_trades is None else int(n_trades),
            }
    return out


class _Results:
    """The variants' result rows, each file read once per request."""

    def __init__(self, root: Path) -> None:
        self.root = root
        self._rows: dict[str, dict[date, dict]] = {}

    def row(self, name: str, day: date) -> dict | None:
        if name not in self._rows:
            self._rows[name] = read_rows(name, self.root)
        return self._rows[name].get(day)


def stop_kind(stopped_by: str) -> str | None:
    """`overall SL at 14:46` -> "sl", `overall target at 11:02` -> "target"."""
    text = stopped_by.lower()
    if text.startswith("overall sl"):
        return "sl"
    if text.startswith("overall target"):
        return "target"
    return "sl" if text else None  # an unknown reason still means the strategy was stopped


# --- the picks, described ---------------------------------------------------------------------


def start_band(tag: str) -> str:
    """The start-time band the family-band criterion pools by (score.family_index): A 09:17-10:02,
    B 10:17-12:02, C 12:17-14:02, D 14:17-15:17."""
    m = int(tag[:2]) * 60 + int(tag[2:])
    return "A" if m <= 602 else "B" if m <= 722 else "C" if m <= 842 else "D"


def describe_pick(name: str) -> dict:
    try:
        letter, family, tag = parts(name)
        index = UNDERLYING[letter]
        start = f"{tag[:2]}:{tag[2:]}"
        band = start_band(tag)
    except (ValueError, KeyError):
        return {
            "name": name,
            "index": None,
            "family": None,
            "kind": None,
            "start": None,
            "band": None,
        }
    kind = "buy" if is_buy(name) else "dir" if is_dir(name) else "wide" if is_wide(name) else None
    return {
        "name": name,
        "index": index,
        "family": family,
        "kind": kind,
        "start": start,
        "band": band,
    }


def _result_view(r: dict | None) -> dict | None:
    if r is None:
        return None
    return {
        "gross": r["gross"],
        "worst_mtm": r["worst_mtm"],
        "stopped_by": r["stopped_by"],
        "stop": stop_kind(r["stopped_by"]),
        "n_trades": r["n_trades"],
    }


def list_block(day: date, picked: dict, results: _Results, lots_per: int = LOTS_PER) -> dict:
    """One list's day: the picks with their one-lot outcomes, and the list's gross when every pick
    has a stored result (2 lots a strategy by default; per lot-day is the gross over its lots)."""
    composite = picked.get("composite") or {}
    picks = []
    for role, names in (("core", picked.get("core") or []), ("buy", picked.get("buy") or [])):
        for n in names:
            c = composite.get(n)
            picks.append(
                {
                    **describe_pick(n),
                    "role": role,
                    "composite": None if c is None else round(float(c), 4),
                    "result": _result_view(results.row(n, day)),
                }
            )
    missing = [p["name"] for p in picks if p["result"] is None]
    scored = bool(picks) and not missing
    core_bands = [p["band"] for p in picks if p["role"] == "core"]
    total = round(sum(p["result"]["gross"] for p in picks), 2) if scored else None
    return {
        "picks": picks,
        "overridden": bool(picked.get("overridden", False)),
        "buy_qualified": any(p["role"] == "buy" for p in picks),
        "lots": lots_per * len(picks),
        "scored": scored,
        "missing": missing,
        # the list's gross for lots_per lots in each strategy, and per lot-day (the comparison unit)
        "gross": None if total is None else round(lots_per * total, 2),
        "per_lot_day": None if total is None else round(total / len(picks), 2),
        "stops": sum(1 for p in picks if p["result"] and p["result"]["stop"] == "sl"),
        "targets": sum(1 for p in picks if p["result"] and p["result"]["stop"] == "target"),
        "shared_start_band": len(core_bands) >= 2 and len(set(core_bands)) == 1,
    }


def _basket(block: dict) -> tuple[str, ...]:
    return tuple(sorted(p["name"] for p in block["picks"]))


def identical_groups(lists: dict[str, dict]) -> list[list[str]]:
    """The lists grouped by identical baskets, in list order: [["A", "C"], ["B"], ["REF"]]."""
    groups: dict[tuple[str, ...], list[str]] = {}
    for key, block in lists.items():
        groups.setdefault(_basket(block), []).append(key)
    return list(groups.values())


# --- the trading calendar ---------------------------------------------------------------------


def holiday_names() -> dict[date, str]:
    """{day: name} of the reference calendar's exchange holidays."""
    path = REFERENCE_DIR / "holidays.csv"
    out: dict[date, str] = {}
    if not path.exists():
        return out
    with path.open(newline="") as f:
        for r in csv.DictReader(f):
            try:
                out[date.fromisoformat(r["date"])] = (r.get("description") or "").strip()
            except (KeyError, ValueError):
                continue
    return out


def is_trading_day(d: date, holidays: dict[date, str] | None = None) -> bool:
    if d.weekday() >= 5:
        return False
    if holidays is not None:
        return d not in holidays
    return default_reference_data().is_trading_day(d)


# --- the reconstruction of days before the journal --------------------------------------------


@dataclass
class _Recon:
    """The stored results and day attributes as arrays, and the picks the rule gives each day
    from the rows before it: exactly `pick.score_history`, the function the 09:16 job calls."""

    signature: tuple
    days: list[date]
    cols: list[str]
    values: np.ndarray
    attrs: dict[date, dict[str, str]]
    weekday: list[str]
    band: list[str]
    dte_n: list[str]
    dte_s: list[str]
    #: why nothing could be reconstructed (a result file that does not parse), else None
    error: str | None = None
    memo: dict[date, dict | None] = field(default_factory=dict)

    def reconstructable(self, day: date) -> bool:
        return day.weekday() < 5 and day in self.attrs and bisect_left(self.days, day) >= WARMUP

    def days_available(self) -> list[date]:
        return sorted(d for d in self.attrs if self.reconstructable(d))

    def picks(self, day: date) -> dict | None:
        if day in self.memo:
            return self.memo[day]
        out = None
        if self.reconstructable(day):
            i = bisect_left(self.days, day)
            a = self.attrs[day]
            hist = pick.History(
                self.days[:i],
                self.cols,
                self.values[:i],
                self.weekday[:i],
                self.band[:i],
                self.dte_n[:i],
                self.dte_s[:i],
                "",
            )
            out = pick.score_history(
                hist, day, _number(a.get("vix_open")), {"dte_n": a["dte_n"], "dte_s": a["dte_s"]}
            )
        self.memo[day] = out
        return out


_recon_lock = threading.Lock()
_recon_cache: dict[tuple, _Recon] = {}


def _signature(root: Path, names: list[str]) -> tuple:
    days = store.days_path(root)
    results = store.results_dir(root)
    newest, count = 0, 0
    if results.exists():
        for n in names:
            try:
                st = (results / f"{n}.csv").stat()
            except OSError:
                continue
            newest = max(newest, st.st_mtime_ns)
            count += 1
    try:
        d = days.stat()
        day_sig = (d.st_mtime_ns, d.st_size)
    except OSError:
        day_sig = (0, 0)
    return (str(root), len(names), count, newest, day_sig)


def reconstruction(root: Path, names: list[str] | None = None) -> _Recon:
    names = names if names is not None else variant_names()
    sig = _signature(root, names)
    with _recon_lock:
        cached = _recon_cache.get(sig)
        if cached is not None:
            return cached
        for stale in [k for k in _recon_cache if k[0] == str(root)]:
            del _recon_cache[stale]
        try:
            matrix = store.load_matrix(names, root)
            attrs = store.read_days(root)
        except (ValueError, KeyError) as error:
            # a stored file with a row that does not parse: the recorded rows do not need the
            # matrix, so say why there is no reconstruction rather than failing the whole log
            empty = np.zeros((0, 0))
            rec = _Recon(
                sig, [], [], empty, {}, [], [], [], [], error=f"{type(error).__name__}: {error}"
            )
            _recon_cache[sig] = rec
            return rec
        keep = [i for i, d in enumerate(matrix.days) if d in attrs]
        days = [matrix.days[i] for i in keep]
        values = matrix.values[keep] if keep else matrix.values[:0]
        rec = _Recon(
            sig,
            days,
            list(matrix.names),
            values,
            attrs,
            [attrs[d]["weekday"] for d in days],
            [attrs[d]["vix_band"] for d in days],
            [attrs[d]["dte_n"] for d in days],
            [attrs[d]["dte_s"] for d in days],
        )
        _recon_cache[sig] = rec
        return rec


# --- rows -------------------------------------------------------------------------------------


def _trim(names: list[str], n: int = 4) -> str:
    return ", ".join(names[:n]) + ("..." if len(names) > n else "")


def _waiting_detail(day: date, lists: dict[str, dict], attrs: dict[date, dict]) -> str:
    lacking = sorted({n for b in lists.values() for n in b["missing"]})
    if day not in attrs and attrs and day < max(attrs):
        return (
            "this day has no stored results and later days do: it was not collected, or data "
            "quality excluded it, so it will not be scored"
        )
    if day not in attrs:
        return "the nightly update has not stored this day yet"
    return f"no result yet for {_trim(lacking)}"


def _status_counts_note(on_time: bool, recorded_time: str | None) -> str:
    if on_time:
        return ""
    return (
        f"recorded at {recorded_time} IST, after {pick.FIRST_ENTRY:%H:%M}: not a forward entry, "
        "left out of every forward counter"
    )


def _row_common(day: date, lists: dict[str, dict]) -> dict:
    groups = identical_groups(lists) if lists else []
    return {
        "day": day.isoformat(),
        "weekday": day.strftime("%a"),
        "lists": lists,
        "all_identical": (len(groups) == 1 and len(lists) > 1) if lists else None,
        "groups": groups,
        "scored": bool(lists) and all(b["scored"] for b in lists.values()),
    }


def recorded_row(
    entry: dict,
    position: int,
    results: _Results,
    attrs: dict[date, dict],
    placement_now: dict[tuple[str, str], dict],
    prev_hash: str,
) -> dict:
    day = date.fromisoformat(entry["day"])
    lots_per = int(entry.get("lots_per_strategy") or LOTS_PER)
    lists = {
        key: list_block(day, picked, results, lots_per)
        for key, picked in (entry.get("lists") or {}).items()
    }
    row = _row_common(day, lists)
    at = entry.get("recorded_at") or ""
    on_time = bool(entry.get("before_first_entry", False))
    dte = entry.get("dte") or {}
    time_text = at[11:19] if len(at) >= 19 else None
    if not on_time:
        status, detail = "late", _status_counts_note(on_time, time_text)
    elif not row["scored"]:
        status, detail = "waiting", _waiting_detail(day, lists, attrs)
    else:
        status, detail = "scored", ""
    chain_ok = (
        entry.get("prev") == prev_hash
        and bool(entry.get("hash"))
        and journal.entry_hash(entry) == entry.get("hash")
    )
    return {
        **row,
        "source": "recorded",
        "status": status,
        "status_detail": detail,
        "collected": day in attrs,
        "vix": {
            "open": _number(entry.get("vix_open")),
            "band": entry.get("vix_band"),
            "source": entry.get("vix_source") or None,
        },
        "dte": {
            "NIFTY": dte.get("NIFTY"),
            "SENSEX": dte.get("SENSEX"),
            "source": entry.get("dte_source") or None,
        },
        "recorded": {
            "at": at or None,
            "time": time_text,
            "on_time": on_time,
            "commit": entry.get("commit"),
            "hash": entry.get("hash"),
            "hash_short": (entry.get("hash") or "")[:12],
            "prev_short": (entry.get("prev") or "")[:12],
            "position": position,
            "chain_ok": chain_ok,
        },
        "placement": {
            k: placement_now[(entry["day"], k)] for k in lists if (entry["day"], k) in placement_now
        },
    }


def reconstructed_row(day: date, rec: _Recon, results: _Results) -> dict | None:
    picked = rec.picks(day)
    if picked is None:
        return None
    a = rec.attrs[day]
    lists = {key: list_block(day, p, results) for key, p in picked.items()}
    row = _row_common(day, lists)
    lacking = sorted({n for b in lists.values() for n in b["missing"]})
    scored = row["scored"]
    return {
        **row,
        "source": "reconstructed",
        "status": "scored" if scored else "waiting",
        "status_detail": "" if scored else f"no result for {_trim(lacking)}",
        "collected": True,
        "vix": {"open": _number(a.get("vix_open")), "band": a.get("vix_band"), "source": "history"},
        "dte": {"NIFTY": a.get("dte_n"), "SENSEX": a.get("dte_s"), "source": "history"},
        "recorded": None,
        "placement": {},
    }


def missing_row(day: date, attrs: dict[date, dict], today: date) -> dict:
    collected = day in attrs
    if collected:
        why = (
            "no journal entry for this trading day (the 09:16 job did not record: the VIX open "
            "could not be read, or the job did not run)"
        )
    elif day == today:
        why = "no journal entry yet, and the entry window (09:17) has passed"
    else:
        why = (
            "no journal entry and no collected data for this day: either the 09:16 job did not "
            "run, or the exchange was shut and the holiday list does not have the day"
        )
    return {
        **_row_common(day, {}),
        "source": "missing",
        "status": "not_recorded",
        "status_detail": why,
        "collected": collected,
        "vix": None,
        "dte": None,
        "recorded": None,
        "placement": {},
    }


# --- counters ---------------------------------------------------------------------------------


def counters(rows: list[dict]) -> dict:
    """What the rows say about how the rule behaves, over forward (on-time, recorded) days or over
    reconstructed days: how often a Buy qualified and the Widesl minimum overrode rank per list, how
    often the lists agreed, how often a stop fired. A late entry is counted only as late."""
    keys = list(LISTS)
    counted = [
        r for r in rows if r["source"] in ("recorded", "reconstructed") and r["status"] != "late"
    ]
    out = {
        "days": len(counted),
        "late": sum(1 for r in rows if r["status"] == "late"),
        "scored": sum(1 for r in counted if r["status"] == "scored"),
        "waiting": sum(1 for r in counted if r["status"] == "waiting"),
        "not_recorded": sum(1 for r in rows if r["status"] == "not_recorded"),
        "buy_qualified": {k: 0 for k in keys},
        "widesl_minimum_applied": {k: 0 for k in keys},
        "start_band_shared": {k: 0 for k in keys},
        "all_lists_identical": 0,
        "lists_differ": 0,
        "days_with_stop": 0,
        "days_with_target": 0,
    }
    for r in counted:
        for k in keys:
            block = r["lists"].get(k)
            if block is None:
                continue
            out["buy_qualified"][k] += int(block["buy_qualified"])
            out["widesl_minimum_applied"][k] += int(block["overridden"])
            out["start_band_shared"][k] += int(block["shared_start_band"])
        if r["all_identical"] is True:
            out["all_lists_identical"] += 1
        elif r["all_identical"] is False:
            out["lists_differ"] += 1
        if any(b["stops"] for b in r["lists"].values()):
            out["days_with_stop"] += 1
        if any(b["targets"] for b in r["lists"].values()):
            out["days_with_target"] += 1
    return out


# --- the log ----------------------------------------------------------------------------------


def _registered() -> dict:
    return {
        "first_day": REGISTERED_FIRST_DAY.isoformat(),
        "record_time": RECORD_TIME,
        "cutoff_time": f"{pick.FIRST_ENTRY:%H:%M}",
        "lots_per_strategy": LOTS_PER,
        "lists": [{"key": k, "description": v.description} for k, v in LISTS.items()],
    }


def _chain(path: Path, entries: list[dict]) -> dict:
    problems = journal.verify(path)
    return {
        "entries": len(entries),
        "intact": not problems,
        "problems": problems[:5],
        "head": (entries[-1]["hash"][:12] if entries else None),
    }


def expected_missing_days(
    entries: list[dict], today: date, now_time: time, holidays: dict[date, str]
) -> list[date]:
    """Trading days from the registered first day to today with no journal entry. Today counts only
    once the 09:17 entry window has passed."""
    have = {e["day"] for e in entries}
    out = []
    d = REGISTERED_FIRST_DAY
    while d <= today:
        due = d < today or now_time >= pick.FIRST_ENTRY
        if due and is_trading_day(d, holidays) and d.isoformat() not in have:
            out.append(d)
        d += timedelta(days=1)
    return out


def build_log(
    root: Path | None = None,
    start: date | None = None,
    end: date | None = None,
    source: str = "recorded",
    now: datetime | None = None,
    names: list[str] | None = None,
) -> dict:
    """The log over [start, end] (inclusive; None = open). Raises journal.JournalCorrupt when the
    journal cannot be read: showing a partial journal as the whole record would be worse."""
    if source not in SOURCES:
        raise ValueError(f"source must be one of {', '.join(SOURCES)}")
    root = root or data_dir()
    now = (now or now_ist()).astimezone(IST)
    today = now.date()
    path = store.journal_path(root)
    entries = journal.read(path)
    attrs = store.read_days(root)
    holidays = holiday_names()
    results = _Results(root)
    placement_now = placements.current(placements.read(root).rows)

    def within(d: date, lo: date | None) -> bool:
        return (lo is None or d >= lo) and (end is None or d <= end)

    rows: list[dict] = []
    if source in ("recorded", "all"):
        prev = journal.GENESIS
        for n, e in enumerate(entries, 1):
            d = date.fromisoformat(e["day"])
            if within(d, start):
                rows.append(recorded_row(e, n, results, attrs, placement_now, prev))
            prev = e.get("hash", "")
        for d in expected_missing_days(entries, today, now.time(), holidays):
            if within(d, start):
                rows.append(missing_row(d, attrs, today))

    cut = min(
        REGISTERED_FIRST_DAY,
        min((date.fromisoformat(e["day"]) for e in entries), default=REGISTERED_FIRST_DAY),
    )
    rec = reconstruction(root, names)
    available = [d for d in rec.days_available() if d < cut]
    recon_info = {
        "error": rec.error,
        "available": len(available),
        "first": available[0].isoformat() if available else None,
        "last": available[-1].isoformat() if available else None,
    }
    if source in ("reconstructed", "all"):
        recon_start = start or (
            (end or min(today, cut - timedelta(days=1))) - timedelta(days=RECON_DEFAULT_DAYS)
        )
        for d in available:
            if within(d, recon_start):
                row = reconstructed_row(d, rec, results)
                if row is not None:
                    rows.append(row)

    rows.sort(key=lambda r: r["day"])
    in_window = [d for d in holidays if (start is None or d >= start) and (end is None or d <= end)]
    by_source = {
        "recorded": [r for r in rows if r["source"] in ("recorded", "missing")],
        "reconstructed": [r for r in rows if r["source"] == "reconstructed"],
    }
    return {
        "as_of": now.isoformat(timespec="seconds"),
        "today": today.isoformat(),
        "entry_window_open": now.time() < pick.FIRST_ENTRY,
        "source": source,
        "from": start.isoformat() if start else None,
        "to": end.isoformat() if end else None,
        "registered": _registered(),
        "chain": _chain(path, entries),
        "journal_entries": len(entries),
        "last_collected_day": max(attrs).isoformat() if attrs else None,
        "reconstructable": recon_info,
        "holidays": [{"day": d.isoformat(), "name": holidays[d]} for d in sorted(in_window)],
        "rows": rows,
        "counters": {k: counters(v) for k, v in by_source.items()},
        "placement_skipped_lines": placements.read(root).skipped,
        "basis": "gross",
    }


def _rescore(entry: dict, root: Path, names: list[str] | None) -> dict:
    """Re-run the ranking on the stored results the entry saw (the same `load_history` and
    `score_history` calls the 09:16 job makes) and say whether it gives the entry's picks."""
    day = date.fromisoformat(entry["day"])
    try:
        hist = pick.load_history(day, root, names if names is not None else variant_names())
    except pick.PickError as error:
        return {"checked": False, "note": str(error)}
    vix = _number(entry.get("vix_open"))
    dte = entry.get("dte") or {}
    again = pick.score_history(
        hist, day, vix, {"dte_n": dte.get("NIFTY"), "dte_s": dte.get("SENSEX")}
    )
    differs = [
        k
        for k, p in (entry.get("lists") or {}).items()
        if again.get(k, {}).get("core") != p.get("core")
        or again.get(k, {}).get("buy") != p.get("buy")
        or again.get(k, {}).get("overridden") != p.get("overridden")
    ]
    return {
        "checked": True,
        "same_inputs": hist.digest == entry.get("inputs_sha"),
        "same_picks": not differs,
        "differs": differs,
    }


def build_day(
    day: date,
    root: Path | None = None,
    now: datetime | None = None,
    names: list[str] | None = None,
) -> dict | None:
    """One day in full, or None when neither the journal nor the research history covers it."""
    root = root or data_dir()
    now = (now or now_ist()).astimezone(IST)
    today = now.date()
    path = store.journal_path(root)
    entries = journal.read(path)
    attrs = store.read_days(root)
    results = _Results(root)
    read = placements.read(root)
    placement_now = placements.current(read.rows)
    iso = day.isoformat()
    history = [r for r in read.rows if r["day"] == iso]
    holidays = holiday_names()

    row: dict | None = None
    extra: dict = {}
    for n, e in enumerate(entries, 1):
        if e.get("day") == iso:
            prev = entries[n - 2]["hash"] if n > 1 else journal.GENESIS
            row = recorded_row(e, n, results, attrs, placement_now, prev)
            extra = {
                "entry": {
                    "universe": e.get("universe"),
                    "inputs_sha": e.get("inputs_sha"),
                    "inputs_days": e.get("inputs_days"),
                    "lots_per_strategy": e.get("lots_per_strategy"),
                    "version": e.get("v"),
                    "prev": e.get("prev"),
                    "hash": e.get("hash"),
                },
                "rescore": _rescore(e, root, names),
            }
            break
    if row is None and day in expected_missing_days(entries, today, now.time(), holidays):
        row = missing_row(day, attrs, today)
    if row is None:
        first = min((date.fromisoformat(e["day"]) for e in entries), default=REGISTERED_FIRST_DAY)
        if day < min(first, REGISTERED_FIRST_DAY):
            row = reconstructed_row(day, reconstruction(root, names), results)
    if row is None:
        return None
    lists_info = {
        k: {"description": LISTS[k].description, "weights": LISTS[k].weights}
        for k in row["lists"]
        if k in LISTS
    }
    return {
        **row,
        **extra,
        "list_info": lists_info,
        "placement_history": history,
        "journal_intact": not journal.verify(path),
        "basis": "gross",
    }
