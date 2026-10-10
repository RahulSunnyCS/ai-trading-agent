"""Selection drift: is a list quietly turning into one family, one index or one start time?
(BL-058 Phase 4, widget 9). Read-only over the journal and the stored results through the daily
log (`rotation/history.py`).

The rule ranks all 298 variants every morning and keeps three. Nothing in it says the three must
be spread across families, indexes or the day; a list can drift toward, say, NIFTY Widesl at the
open for weeks without any single pick looking odd. This module counts what the list held.

* **Picks, not P&L.** Only the core picks (3 a day; the Buy add-on is counted in its own rows) are
  counted, by family (Widesl / Dir), index, strike method and start band. A day counts when the
  list has a pick for it: recorded (on time) or re-scored from the results before it. A late entry
  is not forward and is left out.
* **The yardstick is the list's own past.** A share over the last 21 sessions is flagged when it
  falls outside the 10th-90th percentile of that list's own rolling 21-session shares over P1
  (3 Dec 2025 to 8 Oct 2026, re-scored). Not a fixed number of points: what the list has always
  done is not flagged.
* **Descriptive.** The history is the period the weights were chosen on, so the band is where the
  rule's own picks sat in a market it was fitted to. A flag asks the owner to look; nothing is
  changed by it.

Nothing here writes a file.
"""

from __future__ import annotations

from collections import Counter
from dataclasses import dataclass
from datetime import date
from pathlib import Path

import numpy as np

from ..fyers.daily import data_dir
from . import history
from .history import BAND_LABEL
from .lists import LISTS
from .matrix import NAMED

KEYS = tuple(LISTS)
SHORT = 21
LONG = 63
#: the band the last SHORT sessions are compared with
BAND = (10, 90)
#: fewer rolling windows than this and a percentile band is not worth drawing
MIN_WINDOWS = 10

STRIKE_LABEL = {
    "wide": "Widesl OTM1",
    "premium": "Widesl closest premium",
    "dir": "Dir ATM",
    "ditm1": "Dir ITM1",
}
INDEX_LABEL = {"NIFTY": "NIFTY", "SENSEX": "SENSEX"}
KIND_LABEL = {"wide": "Widesl", "dir": "Dir"}

DIMENSIONS: tuple[tuple[str, str, tuple[tuple[str, str], ...]], ...] = (
    ("kind", "Family", tuple(KIND_LABEL.items())),
    ("index", "Index", tuple(INDEX_LABEL.items())),
    ("strike", "Strike method", tuple(STRIKE_LABEL.items())),
    ("band", "Start band", tuple(BAND_LABEL.items())),
)


class DriftError(Exception):
    def __init__(self, status: int, message: str) -> None:
        super().__init__(message)
        self.status = status


@dataclass
class Day:
    day: date
    source: str
    names: list[str]  # core picks
    cats: dict[str, list[str]]  # dimension -> the category of each core pick
    overridden: bool
    buy_qualified: bool
    shared_band: bool


def _strike(p: dict) -> str | None:
    fam = p.get("family")
    if fam in ("wide", "dir", "ditm1"):
        return fam
    if fam in ("p80", "p100", "p250", "p320"):
        return "premium"
    return None


def _days(rows: list[dict], key: str) -> list[Day]:
    out: list[Day] = []
    for r in rows:
        if r["source"] == "missing" or (r["source"] == "recorded" and r.get("status") == "late"):
            continue
        block = (r.get("lists") or {}).get(key)
        if not block:
            continue
        core = [p for p in block["picks"] if p.get("role") == "core"]
        if not core:
            continue
        out.append(
            Day(
                day=date.fromisoformat(r["day"]),
                source=r["source"],
                names=[p["name"] for p in core],
                cats={
                    "kind": [p.get("kind") or "" for p in core],
                    "index": [p.get("index") or "" for p in core],
                    "strike": [_strike(p) or "" for p in core],
                    "band": [p.get("band") or "" for p in core],
                },
                overridden=bool(block.get("overridden")),
                buy_qualified=bool(block.get("buy_qualified")),
                shared_band=bool(block.get("shared_start_band")),
            )
        )
    out.sort(key=lambda d: d.day)
    return out


def _counts(days: list[Day], dim: str, cats: list[str]) -> list[int]:
    c: Counter[str] = Counter()
    for d in days:
        c.update(d.cats[dim])
    return [c.get(k, 0) for k in cats]


def _shares(counts: list[int]) -> list[float]:
    total = sum(counts)
    return [round(v / total, 4) if total else 0.0 for v in counts]


def _rolling_shares(days: list[Day], dim: str, cats: list[str], size: int) -> np.ndarray:
    """(windows x categories) shares over every run of `size` consecutive sessions."""
    n = len(days)
    if n < size:
        return np.zeros((0, len(cats)))
    onehot = np.zeros((n, len(cats)))
    for i, d in enumerate(days):
        for k in d.cats[dim]:
            if k in cats:
                onehot[i, cats.index(k)] += 1
    csum = np.vstack([np.zeros(len(cats)), np.cumsum(onehot, axis=0)])
    win = csum[size:] - csum[:-size]
    tot = win.sum(axis=1, keepdims=True)
    return np.divide(win, tot, out=np.zeros_like(win), where=tot > 0)


def _band(arr: np.ndarray) -> list[dict | None]:
    if arr.shape[0] < MIN_WINDOWS:
        return [None] * arr.shape[1]
    lo = np.percentile(arr, BAND[0], axis=0)
    hi = np.percentile(arr, BAND[1], axis=0)
    return [
        {"p10": round(float(a), 4), "p90": round(float(b), 4)} for a, b in zip(lo, hi, strict=True)
    ]


def _span(days: list[Day]) -> dict:
    return {
        "from": days[0].day.isoformat() if days else None,
        "to": days[-1].day.isoformat() if days else None,
        "n_days": len(days),
        "recorded": sum(1 for d in days if d.source == "recorded"),
        "reconstructed": sum(1 for d in days if d.source == "reconstructed"),
    }


def _flag(value: float, band: dict | None) -> str | None:
    if band is None:
        return None
    if value > band["p90"] + 1e-9:
        return "above"
    if value < band["p10"] - 1e-9:
        return "below"
    return None


# --- the concentration measures --------------------------------------------------------------


def _distinct(days: list[Day]) -> int:
    return len({n for d in days for n in d.names})


def _top(days: list[Day]) -> tuple[str | None, int]:
    c = Counter(n for d in days for n in d.names)
    if not c:
        return None, 0
    name, count = sorted(c.items(), key=lambda kv: (-kv[1], kv[0]))[0]
    return name, count


MEASURES: tuple[tuple[str, str, str], ...] = (
    ("distinct", "Distinct variants picked", "How many different variants were picked at all."),
    ("most_picked", "Most-picked variant", "Times the single most-picked variant was held."),
    (
        "same_band",
        "Days all three in one start band",
        "Sessions whose core picks all start in one band.",
    ),
    (
        "widesl_min",
        "Days the Widesl minimum applied",
        "A Dir pick was replaced to keep two Widesl.",
    ),
    ("buy", "Days a Buy qualified", "A Buy variant ranked in the overall top 10."),
)


def _measure(key: str, days: list[Day]) -> float:
    if key == "distinct":
        return float(_distinct(days))
    if key == "most_picked":
        return float(_top(days)[1])
    if key == "same_band":
        return float(sum(1 for d in days if d.shared_band))
    if key == "widesl_min":
        return float(sum(1 for d in days if d.overridden))
    return float(sum(1 for d in days if d.buy_qualified))


def build(key: str, root: Path | None = None) -> dict:
    if key not in KEYS:
        raise DriftError(422, f"list must be one of {', '.join(KEYS)}")
    root = root or data_dir()
    log = history.daily_log(root, "recent")
    days = _days(log["rows"], key)
    p1_lo, p1_hi = NAMED["P1"][0], NAMED["P1"][1]
    hist = [d for d in days if p1_lo <= d.day <= p1_hi]
    last63, last21 = days[-LONG:], days[-SHORT:]
    enough_hist = len(hist) >= SHORT + MIN_WINDOWS - 1

    dimensions = []
    for dim, label, cats in DIMENSIONS:
        keys = [k for k, _ in cats]
        rolling = _rolling_shares(hist, dim, keys, SHORT)
        band = _band(rolling)
        windows = {
            "history": _counts(hist, dim, keys),
            "last63": _counts(last63, dim, keys),
            "last21": _counts(last21, dim, keys),
        }
        shares = {k: _shares(v) for k, v in windows.items()}
        flags = []
        for i, (ck, cl) in enumerate(cats):
            f = _flag(shares["last21"][i], band[i]) if len(last21) >= SHORT else None
            if f:
                flags.append(
                    {
                        "category": ck,
                        "label": cl,
                        "direction": f,
                        "share": shares["last21"][i],
                        "p10": band[i]["p10"],  # type: ignore[index]
                        "p90": band[i]["p90"],  # type: ignore[index]
                    }
                )
        dimensions.append(
            {
                "key": dim,
                "label": label,
                "categories": [{"key": k, "label": lab} for k, lab in cats],
                "counts": windows,
                "shares": shares,
                "band": band,
                "flags": flags,
            }
        )

    concentration = []
    n_windows = max(len(hist) - SHORT + 1, 0)
    for mkey, mlabel, note in MEASURES:
        values = [_measure(mkey, hist[i : i + SHORT]) for i in range(n_windows)]
        arr = np.array(values, dtype=float)
        band = (
            {
                "p10": round(float(np.percentile(arr, BAND[0])), 2),
                "p90": round(float(np.percentile(arr, BAND[1])), 2),
            }
            if len(values) >= MIN_WINDOWS
            else None
        )
        now = _measure(mkey, last21) if len(last21) >= SHORT else None
        top_name = _top(last21)[0] if mkey == "most_picked" else None
        concentration.append(
            {
                "key": mkey,
                "label": mlabel,
                "note": note,
                "last21": now,
                "name": top_name,
                "band": band,
                "flag": None if now is None else _flag(now, band),
            }
        )

    return {
        "list": key,
        "windows": {"history": _span(hist), "last63": _span(last63), "last21": _span(last21)},
        "rolling_windows": n_windows,
        "short": SHORT,
        "long": LONG,
        "enough": len(last21) >= SHORT and enough_hist,
        "band_percentiles": list(BAND),
        "dimensions": dimensions,
        "concentration": concentration,
        "flags": sum(len(d["flags"]) for d in dimensions)
        + sum(1 for c in concentration if c["flag"]),
        "basis": "picks",
        "in_sample": True,
        "history_label": NAMED["P1"][2],
    }
