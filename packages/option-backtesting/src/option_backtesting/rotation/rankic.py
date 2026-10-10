"""Does the morning ranking predict the day's results? The daily rank correlation (BL-058 widgets).

For each day, each list: the Spearman rank correlation between the morning composite over all the
variants and that day's realised gross per variant, the same for each criterion on its own, and the
mean gross per lot of the 30 best-ranked variants minus the 30 worst. ONE value per day, never
pooled across days; the running mean carries a 95% band of mean +- 1.96 s / sqrt(n).

This is the statistic `research/bl057/rotate.py` prints for its own criteria and BL-081 step 1 used
as its calibration (`RESEARCH_REFERENCE`). The ranking is rebuilt with `explain.rank_day`, the same
helpers the morning ranking uses, from the results before each day plus that day's own weekday, VIX
band and days to expiry. It needs `WARMUP` earlier days of results, like the picks do.

Two modes. `forward` takes the days the journal recorded before the first entry time and that have
results: the registered test, empty until the first scored day. `research` takes any window of days
that have results (default the last 63): the same numbers on history, labelled so, so the chart is
useful before there are forward days. A late entry (`before_first_entry` false) is shown and never
counted as forward. Missing is never zero: a day with no result for a variant leaves that variant
out of that day's correlation, and a day with nothing to correlate is null.
"""

from __future__ import annotations

import math
from datetime import date
from typing import Any

import numpy as np

from .explain import CRITERIA, Snapshot, rank_day
from .lists import LISTS, WARMUP
from .score import dte_matrix, family_index, pct_rank, select
from .variants import variant_names

SPREAD_N = 30  # the best / worst this many variants by composite
MIN_VARIANTS = 30  # fewer variants with a result than this: no correlation that day
DEFAULT_WINDOW = 63
Z95 = 1.96

#: BL-081 step 1's calibration of the judging code (list A, period P1, the 248 original variants,
#: mean over selection days of the daily Spearman). Reference values, not a target: the journal's
#: universe has 298 variants.
RESEARCH_REFERENCE: dict[str, Any] = {
    "list": "A",
    "from": "2025-12-03",
    "to": "2026-10-08",
    "variants": 248,
    "source": "BL-081 step 1 (period P1)",
    "values": {
        "weekday": 0.036,
        "dte": 0.028,
        "vix": 0.041,
        "recent": 0.062,
        "composite": 0.048,
    },
}


def spearman(x: np.ndarray, y: np.ndarray) -> float | None:
    """Rank correlation with tied values sharing their average rank; None when it is undefined
    (fewer than MIN_VARIANTS pairs, or one side constant)."""
    ok = ~(np.isnan(x) | np.isnan(y))
    if int(ok.sum()) < MIN_VARIANTS:
        return None
    a, b = pct_rank(x[ok]), pct_rank(y[ok])
    a, b = a - a.mean(), b - b.mean()
    den = math.sqrt(float((a * a).sum() * (b * b).sum()))
    return float((a * b).sum() / den) if den > 0 else None


def spread(comp: np.ndarray, gross: np.ndarray, names: list[str]) -> dict[str, float | None]:
    """Mean gross per lot of the SPREAD_N best by composite minus the SPREAD_N worst."""
    keep = [v for v in range(len(names)) if not np.isnan(gross[v])]
    if len(keep) < 2 * SPREAD_N:
        return {"top": None, "bottom": None, "spread": None}
    order = sorted(keep, key=lambda v: (-comp[v], names[v]))
    top = float(np.mean([gross[v] for v in order[:SPREAD_N]]))
    bottom = float(np.mean([gross[v] for v in order[-SPREAD_N:]]))
    return {"top": top, "bottom": bottom, "spread": top - bottom}


def summarise(values: list[float | None]) -> dict[str, Any]:
    """Count, mean, standard deviation, standard error and the 95% band of the non-null values."""
    xs = np.array([v for v in values if v is not None], dtype=float)
    n = int(len(xs))
    if n == 0:
        return {"n": 0, "mean": None, "sd": None, "se": None, "lo": None, "hi": None, "pos": None}
    mean = float(xs.mean())
    pos = float((xs > 0).mean())
    if n < 2:
        return {"n": n, "mean": mean, "sd": None, "se": None, "lo": None, "hi": None, "pos": pos}
    sd = float(xs.std(ddof=1))
    se = sd / math.sqrt(n)
    return {
        "n": n,
        "mean": mean,
        "sd": sd,
        "se": se,
        "lo": mean - Z95 * se,
        "hi": mean + Z95 * se,
        "pos": pos,
    }


def _prepared(snap: Snapshot, key: str) -> dict:
    """The arrays every day of one list is scored from, built once per snapshot."""
    memo_key = ("rankic-prep", key)
    if memo_key in snap.memo:
        return snap.memo[memo_key]
    rows = [i for i, d in enumerate(snap.days) if d in snap.attrs]
    days = [snap.days[i] for i in rows]
    attrs = [snap.attrs[d] for d in days]
    prep = {
        "rows": rows,
        "days": days,
        "net": snap.net[rows],
        "gross": snap.gross[rows],
        "weekday": np.array([a["weekday"] for a in attrs]),
        "band": np.array([a["vix_band"] for a in attrs]),
        "dmat": dte_matrix(
            np.array([a["dte_n"] for a in attrs]),
            np.array([a["dte_s"] for a in attrs]),
            snap.names,
        ),
        "fam": family_index(snap.names),
    }
    snap.memo[memo_key] = prep
    return prep


def _kind(entry: dict | None) -> str:
    if entry is None:
        return "research"
    return "forward" if entry.get("before_first_entry") else "late"


def day_row(snap: Snapshot, key: str, position: int) -> dict[str, Any]:
    """One day's rank correlations: `position` indexes the days that have results and attributes."""
    prep = _prepared(snap, key)
    names = snap.names
    day: date = prep["days"][position]
    entry = snap.entries.get(day.isoformat())
    weekday, band = prep["weekday"][: position + 1].copy(), prep["band"][: position + 1].copy()
    dmat = prep["dmat"][: position + 1].copy()
    if entry is not None:
        # the day itself is scored on what the 09:16 entry recorded
        weekday[-1] = entry["weekday"]
        band[-1] = entry["vix_band"]
        dte = entry.get("dte") or {}
        dmat[-1] = dte_matrix(
            np.array([str(dte.get("NIFTY", "unknown"))]),
            np.array([str(dte.get("SENSEX", "unknown"))]),
            names,
        )[0]
    r = rank_day(
        prep["net"][: position + 1], weekday, band, dmat, names, LISTS[key], prep["fam"], False
    )
    gross = prep["gross"][position]
    row: dict[str, Any] = {
        "day": day.isoformat(),
        "kind": _kind(entry),
        "composite": spearman(r.comp, gross),
        "n": int((~np.isnan(gross)).sum()),
    }
    for k in CRITERIA:
        row[k] = spearman(r.crit[k], gross)
    sp = spread(r.comp, gross, names)
    row["top"], row["bottom"], row["spread"] = sp["top"], sp["bottom"], sp["spread"]
    row["matches_entry"] = None
    if entry is not None:
        rec = (entry.get("lists") or {}).get(key)
        if rec is not None:
            picks = select(r.comp, names)
            idx = {n: v for v, n in enumerate(names)}
            same = set(picks.core) == set(rec.get("core", [])) and set(picks.buy) == set(
                rec.get("buy", [])
            )
            diff = max(
                (
                    abs(round(float(r.comp[idx[n]]), 4) - c)
                    for n, c in (rec.get("composite") or {}).items()
                    if n in idx
                ),
                default=0.0,
            )
            row["matches_entry"] = bool(same and diff <= 1e-9)
    return row


def _round(x: float | None, n: int = 4) -> float | None:
    return None if x is None else round(float(x), n)


def _clean(row: dict) -> dict:
    out = dict(row)
    for k in (*CRITERIA, "composite"):
        out[k] = _round(out[k])
    for k in ("top", "bottom", "spread"):
        out[k] = _round(out[k], 2)
    return out


def status(snap: Snapshot) -> dict[str, Any]:
    """Where the journal stands, so an empty forward view can say why it is empty."""
    entries = list(snap.entries.values())
    scored = {d.isoformat() for d in snap.days}
    forward = [e for e in entries if e.get("before_first_entry")]
    return {
        "entries": len(entries),
        "forward": len(forward),
        "late": len(entries) - len(forward),
        "forward_scored": sum(1 for e in forward if e["day"] in scored),
        "forward_waiting": sorted(e["day"] for e in forward if e["day"] not in scored),
        "results_through": snap.days[-1].isoformat() if snap.days else None,
    }


def analyse(
    snap: Snapshot,
    key: str,
    mode: str = "forward",
    start: date | None = None,
    end: date | None = None,
) -> dict[str, Any]:
    if key not in LISTS:
        raise ValueError(f"list must be one of {', '.join(LISTS)}")
    if mode not in ("forward", "research"):
        raise ValueError("mode must be forward or research")
    memo_key = ("rankic", key, mode, start, end)
    if memo_key in snap.memo:
        return snap.memo[memo_key]
    prep = _prepared(snap, key)
    days: list[date] = prep["days"]
    positions = list(range(WARMUP, len(days)))  # the days with WARMUP earlier days of results
    reason = None
    if mode == "forward":
        chosen = [
            p
            for p in positions
            if (e := snap.entries.get(days[p].isoformat())) is not None
            and e.get("before_first_entry")
            and (start is None or days[p] >= start)
            and (end is None or days[p] <= end)
        ]
        if not chosen:
            st = status(snap)
            if st["entries"] == 0:
                reason = "No journal entry yet: the first is recorded at 09:16 on a trading day."
            elif st["forward"] == 0:
                reason = (
                    f"{st['entries']} entr{'y' if st['entries'] == 1 else 'ies'} recorded, all "
                    "after 09:17: late entries are not forward days."
                )
            else:
                reason = (
                    f"{st['forward']} forward entr{'y' if st['forward'] == 1 else 'ies'} "
                    "recorded, none scored yet: the nightly update stores a day's results "
                    "in the evening."
                )
    else:
        inside = [
            p
            for p in positions
            if (start is None or days[p] >= start) and (end is None or days[p] <= end)
        ]
        chosen = inside if (start or end) else inside[-DEFAULT_WINDOW:]
        if not chosen:
            reason = (
                f"No day in the window has {WARMUP} earlier days of results "
                f"(results run {days[0]} to {days[-1]})."
                if days
                else "No stored results yet."
            )
    rows = [_clean(day_row(snap, key, p)) for p in chosen]
    summary = {k: summarise([r[k] for r in rows]) for k in (*CRITERIA, "composite", "spread")}
    running = []
    seen: list[float | None] = []
    for r in rows:
        seen.append(r["composite"])
        s = summarise(seen)
        running.append(
            {"day": r["day"], "n": s["n"], "mean": s["mean"], "lo": s["lo"], "hi": s["hi"]}
        )
    reference = RESEARCH_REFERENCE if key == RESEARCH_REFERENCE["list"] else None
    out = {
        "list": key,
        "mode": mode,
        "from": rows[0]["day"] if rows else None,
        "to": rows[-1]["day"] if rows else None,
        "n_days": len(rows),
        "n_variants": len(snap.names),
        "days": rows,
        "running": running,
        "summary": summary,
        "reference": reference,
        "status": status(snap),
        "reason": reason,
        "warmup": WARMUP,
        "spread_n": SPREAD_N,
        "counts": {
            "forward": sum(1 for r in rows if r["kind"] == "forward"),
            "late": sum(1 for r in rows if r["kind"] == "late"),
            "research": sum(1 for r in rows if r["kind"] == "research"),
            "mismatch": sum(1 for r in rows if r["matches_entry"] is False),
        },
    }
    snap.memo[memo_key] = out
    return out


def universe_names(include_ditm1: bool = True) -> list[str]:
    """The 298 (or, for the BL-081 calibration, the 248 original) variant names."""
    return [n for n in variant_names() if include_ditm1 or "_ditm1_" not in n]
