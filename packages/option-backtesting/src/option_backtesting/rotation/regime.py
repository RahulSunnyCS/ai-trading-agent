"""Forward days against the research periods: what kind of market did the forward window test?
(BL-058 Phase 4, widget 7). Read-only over `rotation/days.csv`, the journal and the lake's 1-minute
index bars.

The forward test's read-out turns on a question the lists cannot answer: was the window like the
period their weights were chosen on, or like the one they were confirmed on? BL-071, BL-081 and
BL-083 each read differently by period because the periods are different markets (the expiry
weekdays swapped between P2 and P1, P1 had both tails of VIX). This module describes the markets,
nothing more:

* **Mix** per period: the share of sessions in each opening-VIX band, each index's days-to-expiry
  and each weekday; the VIX open and each index's day range as P10 / median / P90.
* **Distance** from the forward window to each period, per row: the total-variation distance
  (half the summed absolute difference of the shares: 0 is the same mix, 1 shares nothing), and
  which period is closer.

Nothing here tests anything. With 60 days the forward mix is itself noisy, so a distance is a
description of the window, not evidence about the lists; the page says so.

* **Forward** is the on-time journal entries' own recorded attributes (a late entry is not
  forward). A day's range comes from the lake and is read at request time, never stored: this
  module writes nothing, and `days.csv` is the nightly update's file.
* **P3** (2022-04-05 to 2024-10-08, NIFTY only) is not in the rotation store; its column is
  reported unavailable with the reason, never filled in.
"""

from __future__ import annotations

import threading
from datetime import date
from pathlib import Path

import duckdb
import numpy as np
from trading_data import lake

from ..fyers.daily import data_dir
from . import journal, store
from .matrix import NAMED
from .score import VIX_LABELS

UNDERLYINGS = ("NIFTY", "SENSEX")
DTE_ROWS = (("dte_n", "NIFTY"), ("dte_s", "SENSEX"))
WEEKDAYS = ("Mon", "Tue", "Wed", "Thu", "Fri")
DTE_KEYS = ("0", "1", "2", "3", "4+")
#: forward windows shorter than this are described but flagged thin
THIN_DAYS = 20
#: two distances closer than this are not called different
TIE = 0.05
P3_REASON = (
    "P3 (2022-04-05 to 2024-10-08, NIFTY only) is not in the rotation store, which starts "
    "2024-10-09: its results come from the research scripts and have not been imported."
)

ROWS: tuple[tuple[str, str, tuple[str, ...]], ...] = (
    ("vix_band", "Opening VIX band", (*VIX_LABELS, "unknown")),
    ("dte_n", "NIFTY days to expiry", (*DTE_KEYS, "unknown")),
    ("dte_s", "SENSEX days to expiry", (*DTE_KEYS, "unknown")),
    ("weekday", "Weekday", WEEKDAYS),
)

_range_lock = threading.Lock()
#: {(root, underlying): {day: ((mtime_ns, size), range)}}: a repaired file is re-read
_range_cache: dict[tuple[str, str], dict[date, tuple[tuple[int, int], float | None]]] = {}


def _dte_key(raw: object) -> str:
    """0..3 as themselves; 4 or more (including score.dte_label's '7+') as '4+'."""
    text = str(raw).strip() if raw is not None else ""
    digits = text[:-1] if text.endswith("+") else text
    if not digits.isdigit():
        return "unknown"
    return str(int(digits)) if int(digits) <= 3 and digits == text else "4+"


def _key(row: str, value: object) -> str:
    """The category a stored value belongs to; anything unreadable is 'unknown'. (The weekday is
    not read from text at all: a session's weekday is its date's.)"""
    text = str(value).strip() if value is not None else ""
    if row == "vix_band":
        return text if text in VIX_LABELS else "unknown"
    return _dte_key(value)


def _number(raw: object) -> float | None:
    try:
        v = float(raw)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return None
    return v if np.isfinite(v) else None


# --- the day range, read from the lake ----------------------------------------------------------


def _signature(path: Path) -> tuple[int, int] | None:
    try:
        st = path.stat()
    except OSError:
        return None
    return (st.st_mtime_ns, st.st_size)


def day_ranges(root: Path, underlying: str, days: set[date]) -> dict[date, float | None]:
    """(high - low) / open x 100 over each day's 1-minute index bars. A day without a bar file is
    absent; a file with no usable bars is None. Cached per process against the file's mtime and
    size, so a day repaired by a later `obt daily` is re-read; never written anywhere."""
    key = (str(root), underlying)
    sigs: dict[date, tuple[int, int]] = {}
    for d in days:
        sig = _signature(lake.bars_1m_path(root, "index", underlying, d))
        if sig is not None:
            sigs[d] = sig
    with _range_lock:
        have = _range_cache.setdefault(key, {})
        stale = sorted(d for d, sig in sigs.items() if d not in have or have[d][0] != sig)
    got: dict[date, float | None] = {}
    if stale:
        paths = {d: lake.bars_1m_path(root, "index", underlying, d) for d in stale}
        con = duckdb.connect()
        try:
            try:
                got = _read_ranges(con, list(paths.values()))
            except duckdb.Error:
                # one unreadable file (a torn write) must not blank every other day: read them
                # one at a time and call the bad one "no usable bars"
                for d, p in paths.items():
                    try:
                        got.update(_read_ranges(con, [p]))
                    except duckdb.Error:
                        got[d] = None
        finally:
            con.close()
        with _range_lock:
            for d in stale:
                have[d] = (sigs[d], got.get(d))
    with _range_lock:
        return {d: have[d][1] for d in sigs if d in have}


def _read_ranges(con: duckdb.DuckDBPyConnection, paths: list[Path]) -> dict[date, float | None]:
    rows = con.execute(
        "SELECT date, first(open ORDER BY ts), max(high), min(low) "
        "FROM read_parquet(?, hive_partitioning=true) GROUP BY date",
        [[str(p) for p in paths]],
    ).fetchall()
    return {
        d: round((hi - lo) / o * 100, 4) if o and hi is not None and lo is not None else None
        for d, o, hi, lo in rows
    }


# --- the periods --------------------------------------------------------------------------------


def _quantiles(values: list[float]) -> dict:
    if not values:
        return {"n": 0, "p10": None, "p50": None, "p90": None}
    a = np.asarray(values, dtype=float)
    p10, p50, p90 = (round(float(x), 2) for x in np.percentile(a, [10, 50, 90]))
    return {"n": len(values), "p10": p10, "p50": p50, "p90": p90}


def _period(
    pid: str,
    label: str,
    lo: date | None,
    hi: date | None,
    rows: dict[date, dict],
    ranges_by_index: dict[str, dict[date, float | None]],
) -> dict:
    """One period's mix from `rows` ({day: {weekday, vix_open, vix_band, dte_n, dte_s}})."""
    days = sorted(d for d in rows if d.weekday() < 5)
    mix = {}
    for key, _label, cats in ROWS:
        counts = dict.fromkeys(cats, 0)
        for d in days:
            k = d.strftime("%a") if key == "weekday" else _key(key, rows[d].get(key))
            counts[k if k in counts else cats[-1]] += 1
        mix[key] = {"categories": list(cats), "counts": [counts[c] for c in cats], "n": len(days)}
    vix = [v for d in days if (v := _number(rows[d].get("vix_open"))) is not None]
    ranges = {}
    for u in UNDERLYINGS:
        got = ranges_by_index[u]
        ranges[u] = _quantiles([v for d in days if (v := got.get(d)) is not None])
    return {
        "id": pid,
        "label": label,
        "status": "ok" if days else "empty",
        "reason": None if days else "no sessions in this window yet",
        "from": days[0].isoformat() if days else (lo.isoformat() if lo else None),
        "to": days[-1].isoformat() if days else (hi.isoformat() if hi else None),
        "n": len(days),
        "mix": mix,
        "vix_open": _quantiles(vix),
        "range": ranges,
    }


def _forward_rows(entries: list[dict]) -> dict[date, dict]:
    out: dict[date, dict] = {}
    for e in entries:
        if not e.get("before_first_entry"):
            continue
        d = date.fromisoformat(e["day"])
        dte = e.get("dte") or {}
        out[d] = {
            "weekday": e.get("weekday") or d.strftime("%a"),
            "vix_open": e.get("vix_open"),
            "vix_band": e.get("vix_band"),
            "dte_n": dte.get("NIFTY"),
            "dte_s": dte.get("SENSEX"),
        }
    return out


def tv_distance(a: list[int], b: list[int]) -> float | None:
    """Total-variation distance of two count vectors (as shares); None when either is empty."""
    na, nb = sum(a), sum(b)
    if na == 0 or nb == 0:
        return None
    return float(0.5 * sum(abs(x / na - y / nb) for x, y in zip(a, b, strict=True)))


def _distances(forward: dict, others: list[dict]) -> dict | None:
    if forward["n"] == 0:
        return None
    rows = []
    totals: dict[str, list[float]] = {o["id"]: [] for o in others}
    for key, label, _cats in ROWS:
        to: dict[str, float | None] = {}
        for o in others:
            d = tv_distance(forward["mix"][key]["counts"], o["mix"][key]["counts"])
            to[o["id"]] = None if d is None else round(d, 3)
            if d is not None:
                totals[o["id"]].append(d)
        rows.append({"key": key, "label": label, "to": to, "closer": _closer(to)})
    overall = {pid: (round(float(np.mean(v)), 3) if v else None) for pid, v in totals.items()}
    return {"rows": rows, "overall": overall, "closer": _closer(overall), "tie": TIE}


def _closer(to: dict[str, float | None]) -> str | None:
    have = {k: v for k, v in to.items() if v is not None}
    if len(have) < 2:
        return next(iter(have), None)
    best = sorted(have.items(), key=lambda kv: kv[1])
    return "neither" if best[1][1] - best[0][1] < TIE else best[0][0]


def build(root: Path | None = None) -> dict:
    """The page's whole answer: P1, P2, P3 (unavailable), the forward window, and the distances."""
    root = root or data_dir()
    attrs = store.read_days(root)
    entries = journal.read(store.journal_path(root))
    named = {
        pid: (lo, hi, label, {d: a for d, a in attrs.items() if lo <= d <= hi})
        for pid, (lo, hi, label) in NAMED.items()
    }
    forward_rows = _forward_rows(entries)
    # every period's days, read once per index
    wanted = {d for *_, rows in named.values() for d in rows} | set(forward_rows)
    ranges = {u: day_ranges(root, u, {d for d in wanted if d.weekday() < 5}) for u in UNDERLYINGS}
    periods = [
        _period(pid, label, lo, hi, rows, ranges) for pid, (lo, hi, label, rows) in named.items()
    ]
    periods.append(
        {
            "id": "P3",
            "label": "P3 · Apr 2022 to Oct 2024 (NIFTY)",
            "status": "unavailable",
            "reason": P3_REASON,
            "from": "2022-04-05",
            "to": "2024-10-08",
            "n": 0,
            "mix": None,
            "vix_open": None,
            "range": None,
        }
    )
    fwd = _period("forward", "Forward · recorded days", None, None, forward_rows, ranges)
    if fwd["status"] == "empty":
        fwd["reason"] = "No on-time entry has been recorded yet (the first is Mon 12 Oct, 09:16)."
    periods.append(fwd)
    research = [p for p in periods if p["status"] == "ok" and p["id"] != "forward"]
    return {
        "periods": periods,
        "rows": [{"key": k, "label": lab, "categories": list(c)} for k, lab, c in ROWS],
        "distances": _distances(fwd, research),
        "forward_days": fwd["n"],
        "thin_days": THIN_DAYS,
        "thin": fwd["n"] < THIN_DAYS,
        "range_definition": "(high − low) ÷ open × 100 over the session's 1-minute index bars",
        "basis": "sessions",
    }
