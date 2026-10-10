"""Why a list picked what it picked: the ranking rebuilt, criterion by criterion (BL-058 widgets).

The journal stores each list's picks and their composites, not the 298-wide breakdown. This module
REBUILDS the breakdown for any day with at least `WARMUP` earlier days of stored results, from the
same inputs and the same helpers the morning ranking uses (`score.recent_score`, `score.skewed_fit`,
`score.pct_rank`, `score.composite`, `score.select`), and checks it against the journal entry when
there is one. Nothing here writes anything, and nothing here is read by the ranking: the picks a
list records are `pick.record`'s, never this module's.

    snapshot = load_snapshot(root)          # results (net + gross), day attributes, journal
    explain(snapshot, day, "A", top=10)     # the JSON the dashboard's "Why this pick?" shows

Look-ahead: the rebuilt ranking for day D reads only result rows strictly before D plus D's own
weekday, VIX band and days to expiry, exactly as `pick.score_history` does. A day that is in the
journal uses the entry's recorded attributes; any other day uses `rotation/days.csv`.

The decomposition is checked at run time: the criteria it rebuilds must sum to
`score.composite`'s output (an internal consistency check, raised as `ExplainError`), and the
picks it reports are `score.select`'s. For a journal day the composites of the picked variants
are compared with the recorded ones to four decimals, and the digest of the rebuilt history with
the entry's `inputs_sha` (it differs when results for earlier days were repaired after the entry
was written).
"""

from __future__ import annotations

import csv
import hashlib
from collections.abc import Callable, Sequence
from dataclasses import dataclass, field
from datetime import date, timedelta
from pathlib import Path
from typing import Any

import numpy as np

from ..data.reference.loader import default_reference_data
from . import journal, store
from .lists import BUY_TOP, LISTS, LOTS_PER, MIN_WIDE_N, N_BUY, N_CORE, WARMUP, RotationList
from .score import (
    VIX_LABELS,
    dte_matrix,
    family_index,
    pct_rank,
    recent_score,
    select,
    skewed_fit,
)
from .score import composite as score_composite
from .variants import is_buy, is_dir, is_wide, parts, underlying_of, variant_names

#: the criteria of the composite, in the order the widgets show them
CRITERIA: tuple[str, ...] = ("recent", "weekday", "dte", "vix", "rfam")
CRITERION_LABEL = {
    "recent": "Recent score",
    "weekday": "Weekday fit",
    "dte": "Days-to-expiry fit",
    "vix": "VIX-band fit",
    "rfam": "Family-band recent",
}
#: composites are compared with the journal's to this many decimals
JOURNAL_DECIMALS = 4
_TOLERANCE = 1e-9


class ExplainError(ValueError):
    """The question cannot be answered; `code` says why (the API maps it to a status)."""

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


# ---------------------------------------------------------------------------
# What is on disk
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class Snapshot:
    """Everything read from `rotation/` once: results by day and variant (net, as the ranking
    reads, and gross, as the widgets show), the day attributes and the journal."""

    names: list[str]
    days: list[date]  # ascending; every weekday all variants have a result for
    net: np.ndarray  # days x variants
    gross: np.ndarray  # days x variants (NaN where a stored gross is blank)
    attrs: dict[date, dict[str, str]]
    entries: dict[str, dict]  # journal entries by ISO day (as read, whether or not the chain holds)
    journal_error: str | None = None  # the journal could not be read at all
    #: problems `journal.verify` found (a broken link, an edited entry, a torn line); [] = intact
    chain_problems: tuple[str, ...] = ()
    #: per-result memo for the heavier computations, cleared with the snapshot
    memo: dict = field(default_factory=dict, compare=False, repr=False)

    @property
    def chain_intact(self) -> bool:
        return not self.chain_problems

    def trusted_entries(self) -> dict[str, dict]:
        """The entries a statistic may count: none when the hash chain is broken or unreadable (an
        entry that cannot be shown to be unedited is not a forward observation)."""
        return self.entries if self.chain_intact else {}

    def chain(self) -> dict:
        """The journal's state as the widgets show it."""
        return {
            "intact": self.chain_intact,
            "problems": list(self.chain_problems[:3]),
            "error": self.journal_error,
        }


def _read_net_gross(name: str, root: Path) -> dict[date, tuple[float, float]]:
    path = store.results_dir(root) / f"{name}.csv"
    if not path.exists():
        return {}
    out: dict[date, tuple[float, float]] = {}
    with path.open() as f:
        for r in csv.DictReader(f):
            try:
                net = float(r["net"])
            except (TypeError, ValueError):
                continue  # a row with no net is not a result (missing is never zero)
            try:
                gross = float(r["gross"])
            except (TypeError, ValueError, KeyError):
                gross = float("nan")
            out[date.fromisoformat(r["day"])] = (net, gross)
    return out


def load_snapshot(root: Path, names: Sequence[str] | None = None) -> Snapshot:
    """Read the stored results of every variant (the days they ALL have, Monday to Friday: the
    definition `store.load_matrix` uses), `days.csv` and the journal. Read-only."""
    names = list(names or variant_names())
    if not names:
        raise ExplainError("no_universe", "no variant strategy files found")
    series = [_read_net_gross(n, root) for n in names]
    common = set(series[0])
    for s in series[1:]:
        common &= set(s)
    days = sorted(d for d in common if d.weekday() < 5)
    net = np.array([[s[d][0] for s in series] for d in days], dtype=float).reshape(
        len(days), len(names)
    )
    gross = np.array([[s[d][1] for s in series] for d in days], dtype=float).reshape(
        len(days), len(names)
    )
    entries: dict[str, dict] = {}
    error = None
    path = store.journal_path(root)
    try:
        entries = {e["day"]: e for e in journal.read(path)}
    except journal.JournalCorrupt as exc:
        error = str(exc)
    problems = tuple(journal.verify(path))
    return Snapshot(names, days, net, gross, store.read_days(root), entries, error, problems)


# ---------------------------------------------------------------------------
# One day's inputs
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class DayContext:
    day: date
    weekday: str
    band: str
    dte_n: str
    dte_s: str
    vix_open: float | None
    source: str  # "journal" | "days.csv"


def _day_context(snap: Snapshot, day: date) -> DayContext:
    entry = snap.entries.get(day.isoformat())
    if entry is not None:
        dte = entry.get("dte") or {}
        return DayContext(
            day,
            str(entry["weekday"]),
            str(entry["vix_band"]),
            str(dte.get("NIFTY", "unknown")),
            str(dte.get("SENSEX", "unknown")),
            entry.get("vix_open"),
            "journal",
        )
    a = snap.attrs.get(day)
    if a is None:
        raise ExplainError(
            "no_day",
            f"{day} has no recorded entry and no day attributes (weekday, VIX band, days to "
            "expiry): it cannot be explained until the day is recorded or collected",
        )
    vix = a.get("vix_open")
    return DayContext(
        day,
        a["weekday"],
        a["vix_band"],
        a["dte_n"],
        a["dte_s"],
        float(vix) if vix not in (None, "") else None,
        "days.csv",
    )


def _history_rows(snap: Snapshot, day: date) -> list[int]:
    """Row indexes of the days strictly before `day` that have attributes (as `load_history`)."""
    return [i for i, d in enumerate(snap.days) if d < day and d in snap.attrs]


def history_digest(snap: Snapshot, rows: Sequence[int]) -> str:
    """The digest `pick.load_history` computes for the same rows (a test holds them equal)."""
    h = hashlib.sha256()
    for i in rows:
        d = snap.days[i]
        a = snap.attrs[d]
        h.update(
            f"{d}|{a['weekday']}|{a['vix_band']}|{a['dte_n']}|{a['dte_s']}|".encode()
            + ",".join(f"{v:.2f}" for v in snap.net[i]).encode()
            + b"\n"
        )
    return h.hexdigest()


def explainable_days(snap: Snapshot) -> list[date]:
    """Days a list could be explained for from the stored history alone: a journal day, or a day
    with attributes and at least WARMUP earlier days of results that have attributes."""
    with_attrs = [d for d in snap.days if d in snap.attrs]
    out = {d for d in with_attrs[WARMUP:]}
    out |= {date.fromisoformat(k) for k in snap.entries}
    return sorted(d for d in out if d.weekday() < 5)


# ---------------------------------------------------------------------------
# The ranking, criterion by criterion
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class Ranking:
    names: list[str]
    crit: dict[str, np.ndarray]  # raw criterion values, one per variant
    pct: dict[str, np.ndarray]  # percentile of each (rank / n, 1.0 is best)
    contrib: dict[str, np.ndarray]  # weight x percentile
    comp: np.ndarray  # the composite, = sum of contrib
    windows: dict[str, dict[str, np.ndarray]]  # fit criterion -> {"cnt": n x V, "avg": n x V}


def _fit_windows(
    P: np.ndarray, match: np.ndarray, i: int, lookbacks: tuple[tuple[int, float], ...]
) -> dict[str, np.ndarray]:
    """Per lookback window: matching days and their mean P&L, for every variant: the pieces
    `score.skewed_fit` blends (same slicing, same `cnt > 0` rule)."""
    cnts, avgs = [], []
    for n, _ in lookbacks:
        lo = max(0, i - n)
        m = match[lo:i]
        cnt = m.sum(axis=0)
        avg = np.where(cnt > 0, (P[lo:i] * m).sum(axis=0) / np.maximum(cnt, 1), 0.0)
        cnts.append(cnt)
        avgs.append(avg)
    return {"cnt": np.array(cnts), "avg": np.array(avgs)}


def rank_day(
    P: np.ndarray,
    weekday: np.ndarray,
    band: np.ndarray,
    dte: np.ndarray,
    names: list[str],
    lst: RotationList,
    family_idx: np.ndarray,
    check: bool = True,
) -> Ranking:
    """The ranking for the day at the last row of the inputs (its P row is never read), with each
    criterion kept apart. `check` asserts the pieces add up to `score.composite`."""
    i = P.shape[0] - 1
    w = lst.weights
    width = P.shape[1]
    crit = {
        "recent": recent_score(P, i),
        "weekday": skewed_fit(
            P, (weekday[:, None] == weekday[i]).repeat(width, axis=1), i, lst.lookbacks
        ),
        "dte": skewed_fit(P, dte == dte[i][None, :], i, lst.lookbacks),
        "vix": skewed_fit(P, (band[:, None] == band[i]).repeat(width, axis=1), i, lst.lookbacks),
    }
    matches = {
        "weekday": (weekday[:, None] == weekday[i]).repeat(width, axis=1),
        "dte": dte == dte[i][None, :],
        "vix": (band[:, None] == band[i]).repeat(width, axis=1),
    }
    windows = {k: _fit_windows(P, m, i, lst.lookbacks) for k, m in matches.items()}
    crit["rfam"] = (np.bincount(family_idx, weights=crit["recent"]) / np.bincount(family_idx))[
        family_idx
    ]
    pct = {k: pct_rank(crit[k]) for k in CRITERIA}
    weights = {k: float(w.get(k, 0.0)) for k in CRITERIA}
    contrib = {k: weights[k] * pct[k] for k in CRITERIA}
    comp = sum(contrib.values())
    if check:
        want = score_composite(P, weekday, band, dte, names, lst, family_idx)
        if not np.allclose(comp, want, rtol=0, atol=_TOLERANCE):
            raise ExplainError(
                "decomposition",
                "the rebuilt criteria do not add up to score.composite: the ranking changed "
                "and explain.py must follow it",
            )
    return Ranking(names, crit, pct, contrib, np.asarray(comp), windows)


def order_by_composite(comp: np.ndarray, names: Sequence[str]) -> list[int]:
    """Best first, ties by name: the order `score.select` uses."""
    return sorted(range(len(names)), key=lambda v: (-comp[v], names[v]))


def kind_of(name: str) -> str:
    return "wide" if is_wide(name) else "dir" if is_dir(name) else "buy"


def variant_label(name: str) -> dict[str, Any]:
    index, family, tag = parts(name)
    return {
        "variant": name,
        "index": underlying_of(name),
        "family": family,
        "kind": kind_of(name),
        "slot": f"{tag[:2]}:{tag[2:]}",
    }


# ---------------------------------------------------------------------------
# The explanation
# ---------------------------------------------------------------------------


def _round(x: float, n: int = 4) -> float:
    return round(float(x), n)


def _row(
    r: Ranking,
    v: int,
    rank: int,
    pool_rank: int | None,
    lst: RotationList,
    role: str | None,
    detail: bool,
    family_names: list[str] | None = None,
) -> dict:
    name = r.names[v]
    criteria: dict[str, Any] = {}
    for k in CRITERIA:
        entry: dict[str, Any] = {
            "value": _round(r.crit[k][v], 2),
            "pct": _round(r.pct[k][v]),
            "weight": float(lst.weights.get(k, 0.0)),
            "contribution": _round(r.contrib[k][v]),
        }
        if detail and k in r.windows:
            w = r.windows[k]
            wins = []
            den = sum(wt for j, (_, wt) in enumerate(lst.lookbacks) if w["cnt"][j][v] > 0)
            for j, (n, wt) in enumerate(lst.lookbacks):
                cnt = int(w["cnt"][j][v])
                avg = float(w["avg"][j][v])
                wins.append(
                    {
                        "lookback": n,
                        "weight": wt,
                        "matching_days": cnt,
                        "mean": _round(avg, 2) if cnt else None,
                        # this window's part of the fit value (the fit is renormalised over the
                        # windows that have a matching day)
                        "part": _round(wt * avg / den, 2) if cnt and den > 0 else 0.0,
                    }
                )
            entry["windows"] = wins
            entry["matching_days"] = max((x["matching_days"] for x in wins), default=0)
        if k == "rfam" and family_names:
            entry["group"] = family_names[v]  # the family band whose recent scores are averaged
        criteria[k] = entry
    return {
        **variant_label(name),
        "role": role,
        "rank": rank,
        "pool_rank": pool_rank,
        "composite": _round(r.comp[v]),
        "criteria": criteria,
        "family_band": family_names[v] if family_names else None,
    }


def _family_band_names(names: list[str]) -> list[str]:
    """A readable name for the family band each variant belongs to ('wide 09:17-10:02' ...).

    The groups ARE `score.family_index`'s (nothing is re-derived here): each group is named by the
    strategy kind of its members and the first and last start time among them, so the label cannot
    drift from the grouping the ranking averages over."""
    group = family_index(names)
    members: dict[int, list[str]] = {}
    for name, g in zip(names, group, strict=True):
        members.setdefault(int(g), []).append(name)
    label: dict[int, str] = {}
    for g, group_names in members.items():
        slots = sorted(parts(n)[2] for n in group_names)
        kinds = "/".join(sorted({kind_of(n) for n in group_names}))
        label[g] = f"{kinds} {slots[0][:2]}:{slots[0][2:]}-{slots[-1][:2]}:{slots[-1][2:]}"
    return [label[int(g)] for g in group]


def _ref(r: Ranking, v: int, rank: int, pool_rank: int | None = None) -> dict:
    """A variant named in a sentence: its rank among all variants (what the Buy test counts) and
    its rank among the non-Buy pool (what the core and the Widesl minimum count; None for Buy)."""
    return {
        **variant_label(r.names[v]),
        "rank": rank,
        "pool_rank": pool_rank,
        "composite": _round(r.comp[v]),
    }


def _boundary(r: Ranking, order: list[int], picks, lst: RotationList) -> dict:
    names = r.names
    comp = r.comp
    rank_of = {v: k + 1 for k, v in enumerate(order)}
    wide = np.array([is_wide(n) for n in names])
    dir_ = np.array([is_dir(n) for n in names])
    buy_mask = np.array([is_buy(n) for n in names])
    pool = [v for v in order if not buy_mask[v]]
    pool_rank_of = {v: k + 1 for k, v in enumerate(pool)}
    idx = {n: v for v, n in enumerate(names)}
    core = [idx[n] for n in picks.core]

    def ref(v: int) -> dict:
        return _ref(r, v, rank_of[v], pool_rank_of.get(v))

    unconstrained = pool[:N_CORE]
    # the swaps, replayed the way `score.select` makes them
    swaps = []
    work = list(unconstrained)
    spare = [v for v in pool if wide[v] and v not in work]
    n_wide = int(wide[work].sum())
    while n_wide < MIN_WIDE_N and spare:
        drop = min((v for v in work if dir_[v]), key=lambda v: (comp[v], names[v]), default=None)
        if drop is None:
            break
        add = spare.pop(0)
        work.remove(drop)
        work.append(add)
        n_wide += 1
        swaps.append({"dropped": ref(drop), "added": ref(add)})
    if set(work) != set(core):
        raise ExplainError("decomposition", "the replayed Widesl minimum differs from score.select")

    weakest = min(core, key=lambda v: (comp[v], names[v]))
    excluded = [v for v in pool if v not in core]
    nearest = []
    for v in excluded[:3]:
        row = ref(v)
        row["gap"] = _round(comp[weakest] - comp[v])
        # an alternative that outscored a pick and was left out by the Widesl minimum
        row["kept_out_by"] = "widesl_minimum" if v in unconstrained and v not in core else None
        nearest.append(row)

    top10 = order[:BUY_TOP]
    buys = [v for v in order if buy_mask[v]]
    best_buy = buys[0] if buys else None
    picked_buy = [idx[n] for n in picks.buy]
    buy_info: dict[str, Any] = {
        "top": BUY_TOP,
        "size": N_BUY,
        "qualified": bool(picked_buy),
        "picked": [ref(v) for v in picked_buy],
        "best_buy": ref(best_buy) if best_buy is not None else None,
        "tenth_composite": _round(comp[top10[-1]]) if len(top10) >= BUY_TOP else None,
        "gap_to_top": None,
    }
    if best_buy is not None and len(top10) >= BUY_TOP and not picked_buy:
        buy_info["gap_to_top"] = _round(comp[top10[-1]] - comp[best_buy])
    return {
        "n_core": N_CORE,
        "min_wide": MIN_WIDE_N,
        "override": {
            "fired": bool(swaps),
            "wide_in_unconstrained": int(wide[unconstrained].sum()),
            "swaps": swaps,
        },
        "unconstrained_core": [ref(v) for v in unconstrained],
        "weakest_pick": ref(weakest),
        "best_excluded": nearest[0] if nearest else None,
        "nearest_excluded": nearest,
        "buy": buy_info,
    }


def _compare_with_entry(
    entry: dict, key: str, picks, comp_by_name: dict[str, float], rebuilt_digest: str, names: list
) -> dict:
    """How the rebuilt ranking compares with what the journal recorded for this list.

    `comp_by_name` holds the rebuilt composite of EVERY variant, so a recorded pick that the
    rebuild no longer picks still has a rebuilt composite to compare with: `max_abs_diff` is always
    a finite number (None only when the entry recorded no composite). A recorded name outside the
    rebuilt universe is listed in `missing_in_rebuild` and counts as a mismatch."""
    from .pick import universe_fingerprint

    rec = (entry.get("lists") or {}).get(key)
    out: dict[str, Any] = {
        "source": "recorded",
        "matches": False,
        "max_abs_diff": None,
        "picks_equal": None,
        "overridden_equal": None,
        "missing_in_rebuild": [],
        "inputs_sha_recorded": entry.get("inputs_sha"),
        "inputs_sha_rebuilt": rebuilt_digest,
        "inputs_match": None,
        "universe_match": None,
    }
    if entry.get("inputs_sha"):
        out["inputs_match"] = entry["inputs_sha"] == rebuilt_digest
    fingerprint = entry.get("universe")
    if fingerprint:
        out["universe_match"] = fingerprint == universe_fingerprint(list(names))
    if rec is None:
        out["note"] = f"the entry has no list {key}"
        return out
    out["picks_equal"] = set(rec.get("core", [])) == set(picks.core) and set(
        rec.get("buy", [])
    ) == set(picks.buy)
    out["overridden_equal"] = bool(rec.get("overridden")) == bool(picks.overridden)
    diffs = []
    for name, recorded in (rec.get("composite") or {}).items():
        mine = comp_by_name.get(name)
        if mine is None:
            out["missing_in_rebuild"].append(name)
        else:
            diffs.append(abs(round(mine, JOURNAL_DECIMALS) - recorded))
    out["max_abs_diff"] = float(max(diffs)) if diffs else None
    out["matches"] = bool(
        out["picks_equal"]
        and out["overridden_equal"]
        and diffs
        and not out["missing_in_rebuild"]
        and out["max_abs_diff"] <= _TOLERANCE
    )
    return out


def missing_trading_days(
    last: date, day: date, is_trading: Callable[[date], bool] | None = None
) -> list[date]:
    """Trading days strictly between `last` and `day`, by the exchange calendar (a Thursday and
    Friday holiday is not a gap in the results)."""
    check = is_trading or default_reference_data().is_trading_day
    out: list[date] = []
    d = last + timedelta(days=1)
    while d < day:
        if check(d):
            out.append(d)
        d += timedelta(days=1)
    return out


def explain(snap: Snapshot, day: date, list_key: str, top: int = 10) -> dict:
    """The "Why this pick?" payload for `list_key` on `day`. Raises ExplainError."""
    if list_key not in LISTS:
        raise ExplainError("bad_list", f"list must be one of {', '.join(LISTS)}")
    lst = LISTS[list_key]
    ctx = _day_context(snap, day)
    rows = _history_rows(snap, day)
    if len(rows) < WARMUP:
        raise ExplainError(
            "short_history",
            f"only {len(rows)} earlier days of results before {day}; a list needs {WARMUP}",
        )
    names = snap.names
    values = snap.net[rows]
    hist_days = [snap.days[i] for i in rows]
    weekday = np.array([*(snap.attrs[d]["weekday"] for d in hist_days), ctx.weekday])
    band = np.array([*(snap.attrs[d]["vix_band"] for d in hist_days), ctx.band])
    dn = np.array([*(snap.attrs[d]["dte_n"] for d in hist_days), ctx.dte_n])
    ds = np.array([*(snap.attrs[d]["dte_s"] for d in hist_days), ctx.dte_s])
    Pv = np.vstack([values, np.zeros((1, len(names)))])
    dmat = dte_matrix(dn, ds, names)
    fam = family_index(names)
    r = rank_day(Pv, weekday, band, dmat, names, lst, fam)
    picks = select(r.comp, names)
    digest = history_digest(snap, rows)

    order = order_by_composite(r.comp, names)
    rank_of = {v: k + 1 for k, v in enumerate(order)}
    pool_rank_of = {}
    for k, v in enumerate(v for v in order if not is_buy(names[v])):
        pool_rank_of[v] = k + 1
    idx = {n: v for v, n in enumerate(names)}
    fam_names = _family_band_names(names)

    boundary = _boundary(r, order, picks, lst)
    swapped_in = {s["added"]["variant"] for s in boundary["override"]["swaps"]}

    def role(name: str) -> str:
        if name in picks.buy:
            return "buy"
        if name in swapped_in:
            return "core_override"
        return "core" if name in picks.core else "other"

    picked_names = [*picks.core, *picks.buy]
    pick_rows = [
        _row(
            r,
            idx[n],
            rank_of[idx[n]],
            pool_rank_of.get(idx[n]),
            lst,
            role(n),
            True,
            fam_names,
        )
        for n in picked_names
    ]
    # the best-ranked rows beside the picks: what the picks beat, and the Buy that qualified or not
    top = max(0, min(int(top), 50))
    shown = [v for v in order if names[v] not in picked_names][:top]
    top_rows = [
        _row(r, v, rank_of[v], pool_rank_of.get(v), lst, "other", True, fam_names) for v in shown
    ]

    comp_by_name = {n: float(r.comp[v]) for n, v in idx.items()}
    recorded_picks: list[dict] = []
    entry = snap.entries.get(day.isoformat())
    if entry is not None:
        recon = _compare_with_entry(entry, list_key, picks, comp_by_name, digest, names)
        provenance = {
            "source": "recorded",
            "recorded_at": entry.get("recorded_at"),
            "before_first_entry": entry.get("before_first_entry"),
            "hash": entry.get("hash"),
            "commit": entry.get("commit"),
            "vix_source": entry.get("vix_source"),
            "dte_source": entry.get("dte_source"),
        }
        # what the entry itself says, kept apart from the rebuild
        rec = (entry.get("lists") or {}).get(list_key) or {}
        recorded = {
            "core": rec.get("core", []),
            "buy": rec.get("buy", []),
            "overridden": rec.get("overridden"),
            "composite": rec.get("composite", {}),
        }
        # the picks that were actually written down, each with the rebuild's view of it (its rank
        # and composite now, and its breakdown), so a rebuild that differs still shows the record
        for kind, listed in (("core", recorded["core"]), ("buy", recorded["buy"])):
            for name in listed:
                v = idx.get(name)
                recorded_picks.append(
                    {
                        "variant": name,
                        "role": kind,
                        "recorded_composite": recorded["composite"].get(name),
                        "rebuilt_composite": _round(r.comp[v]) if v is not None else None,
                        "rebuilt_rank": rank_of[v] if v is not None else None,
                        "rebuilt_pool_rank": pool_rank_of.get(v) if v is not None else None,
                        "rebuilt_pick": name in picked_names,
                        "row": _row(
                            r,
                            v,
                            rank_of[v],
                            pool_rank_of.get(v),
                            lst,
                            f"recorded_{kind}",
                            True,
                            fam_names,
                        )
                        if v is not None
                        else None,
                    }
                )
    else:
        recon = {
            "source": "reconstructed",
            "matches": None,
            "max_abs_diff": None,
            "picks_equal": None,
            "overridden_equal": None,
            "inputs_sha_recorded": None,
            "inputs_sha_rebuilt": digest,
            "inputs_match": None,
            "universe_match": None,
        }
        provenance = {"source": "reconstructed"}
        recorded = None

    warnings = []
    gaps = missing_trading_days(hist_days[-1], day)
    if gaps:
        shown_gaps = ", ".join(d.isoformat() for d in gaps[:3]) + (" ..." if len(gaps) > 3 else "")
        warnings.append(
            f"the stored results end {hist_days[-1]} and there is none for the "
            f"{len(gaps)} trading day(s) in between ({shown_gaps})"
        )
    if snap.journal_error:
        warnings.append(f"the journal could not be read: {snap.journal_error}")
    elif not snap.chain_intact:
        warnings.append(
            "the journal's hash chain is broken, so entries are not trusted: "
            + "; ".join(snap.chain_problems[:2])
        )
    if ctx.vix_open is None and ctx.band == "unknown":
        warnings.append("the 09:15 VIX open is unknown for this day; its VIX band is 'unknown'")

    scored = None
    if day in set(snap.days):
        j = snap.days.index(day)
        scored = {
            "n": int((~np.isnan(snap.gross[j])).sum()),
            "picked_gross": {
                n: _round(snap.gross[j][idx[n]], 2)
                for n in picked_names
                if not np.isnan(snap.gross[j][idx[n]])
            },
        }

    return {
        "day": day.isoformat(),
        "list": list_key,
        "list_info": {
            "name": lst.name,
            "description": lst.description,
            "weights": {k: float(lst.weights.get(k, 0.0)) for k in CRITERIA},
            "lookbacks": [{"days": n, "weight": wt} for n, wt in lst.lookbacks],
            "n_core": N_CORE,
            "lots_per_strategy": LOTS_PER,
        },
        "criteria": [{"key": k, "label": CRITERION_LABEL[k]} for k in CRITERIA],
        "context": {
            "weekday": ctx.weekday,
            "vix_open": ctx.vix_open,
            "vix_band": ctx.band,
            "dte": {"NIFTY": ctx.dte_n, "SENSEX": ctx.dte_s},
            "source": ctx.source,
        },
        "history": {
            "days": len(rows),
            "from": hist_days[0].isoformat(),
            "to": hist_days[-1].isoformat(),
            "digest": digest[:12],
        },
        "n_variants": len(names),
        "reconstruction": recon,
        "provenance": provenance,
        "recorded": recorded,
        "recorded_picks": recorded_picks,
        "chain": snap.chain(),
        "picks": pick_rows,
        "top": top_rows,
        "boundary": boundary,
        "scored": scored,
        "warnings": warnings,
        "vix_bands": VIX_LABELS,
    }


def explain_range(snap: Snapshot) -> dict:
    """What a day picker can offer: the explainable days, which are journal days, and the default
    (the latest recorded day, else the latest reconstructable one)."""
    days = explainable_days(snap)
    recorded = sorted(snap.trusted_entries())
    default = None
    if recorded:
        default = recorded[-1]
    elif days:
        default = days[-1].isoformat()
    return {
        "days": [d.isoformat() for d in days],
        "recorded": recorded,
        "first": days[0].isoformat() if days else None,
        "last": days[-1].isoformat() if days else None,
        "default": default,
        "results_through": snap.days[-1].isoformat() if snap.days else None,
        "journal_error": snap.journal_error,
        "chain": snap.chain(),
    }
