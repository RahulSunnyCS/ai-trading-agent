"""The Family pulse: "is morning short-premium working right now?" (BL-058 Phase 4, widget 11).

Twelve cells, the ones the family-band criterion pools: {Widesl incl. closest-premium, Dir incl.
Dir ITM1, Buy} x start band {09:17-10:02, 10:17-12:02, 12:17-14:02, 14:17-15:17}, across both
indices and every strike. The grouping is `score.family_index`'s, and a run-time check refuses to
answer if this module's cell keys ever stop being the same partition.

Read-only over `rotation/`; nothing here writes and nothing here is read by the ranking.

Where each number comes from, so none of it is computed twice:

* **The cell means** are `matrix.pool_mask` + `matrix.summarise` over the matrix's cached cube, the
  very call a Strategy Matrix cell makes, with the last N sessions that match the pooled variants
  (`Item(windowed=True)`) or a named period. A cell mean therefore equals the matrix pooled over
  the same variants and days (a test holds them equal). Gross per ONE lot of one strategy, a mean
  of the pooled variant-days; nothing is ever summed across variants.
* **"Ranking sees"** is the criterion value the next 09:16 pick will use: `score.recent_score` of
  the stored NET results (the ranking's input; equal to gross while `costs` is zero), averaged by
  `score.family_index` exactly as `score.composite` builds `crit["rfam"]`, then ranked 1-12 among
  the cells. It is the number Why this pick shows as "Family-band recent". The pick percentile-
  ranks it among all 298 variants; the 12-cell rank here is the same ordering of the same values.
* **Picks** are what the journal recorded (hash-chain intact; a late entry is shown and counted
  nowhere). Before the first entry, picks are RECONSTRUCTED by `daylog.reconstruction`, which calls
  `pick.score_history`, and are always labelled so; the two are never added together.

Honest by construction: windows with no stored result are `missing` with a reason, never zero; a
weekend special session is left out as in the matrix; sessions (not variant-days) are the sample,
because variants on one date are not independent.
"""

from __future__ import annotations

from collections.abc import Callable
from datetime import date, timedelta
from typing import Any

import numpy as np

from . import matrix as mx
from .explain import Snapshot
from .lists import LISTS, WARMUP
from .score import family_index, recent_score
from .variants import is_dir, is_wide, parts

KINDS = ("wide", "dir", "buy")
BANDS = ("A", "B", "C", "D")
KIND_LABEL = {"wide": "Widesl", "dir": "Dir", "buy": "Buy"}
BAND_LABEL = {
    "A": "09:17-10:02",
    "B": "10:17-12:02",
    "C": "12:17-14:02",
    "D": "14:17-15:17",
}
#: the Strategy Matrix's family filter alias for each kind (Widesl includes closest-premium and
#: Dir includes Dir ITM1, exactly the criterion's grouping)
MATRIX_FAMILY = {"wide": "widesl", "dir": "dirs", "buy": "buy"}
WINDOWS = mx.PULSE_WINDOWS  # (5, 21, 63)
ROLL = 21  # the sparkline's and the flag's rolling window
SPARK_SESSIONS = 126
MIN_FLAG_WINDOWS = 20  # fewer rolling windows in P1 than this: no P10-P90 to speak of
SHARE_SESSIONS = 21
RANK_OF = len(KINDS) * len(BANDS)
INDEX_CHOICES = {"both": "both", "nifty": "N", "n": "N", "sensex": "S", "s": "S"}


class PulseError(ValueError):
    """A request the pulse cannot answer; the message is for the user."""


# --- the cells --------------------------------------------------------------------------------


def band_of(tag: str) -> str:
    """The start band of an HHMM tag: the same cut-offs `score.family_index` uses."""
    m = int(tag[:2]) * 60 + int(tag[2:])
    return "A" if m <= 602 else "B" if m <= 722 else "C" if m <= 842 else "D"


def cell_of(name: str) -> str:
    """'wide_A', 'dir_C', 'buy_D': the family-band cell of a variant name."""
    _, family, tag = parts(name)
    kind = "wide" if is_wide(name) else "dir" if is_dir(name) else family
    return f"{kind}_{band_of(tag)}"


def cell_keys() -> list[str]:
    return [f"{k}_{b}" for k in KINDS for b in BANDS]


def _cell_meta(key: str) -> dict[str, Any]:
    kind, band = key.split("_")
    return {
        "key": key,
        "kind": kind,
        "band": band,
        "label": f"{KIND_LABEL[kind]} {BAND_LABEL[band]}",
        "kind_label": KIND_LABEL[kind],
        "band_label": BAND_LABEL[band],
    }


def check_grouping(names: list[str]) -> dict[int, str]:
    """{score.family_index group: cell key}, refusing to go on when the two groupings differ."""
    group = family_index(names)
    out: dict[int, str] = {}
    for name, g in zip(names, group, strict=True):
        key = cell_of(name)
        if out.setdefault(int(g), key) != key:
            raise PulseError(
                f"the family grouping drifted: {name} is {key} here but shares a ranking group "
                f"with {out[int(g)]}; pulse.py must follow score.family_index"
            )
    if len(set(out.values())) != len(out):
        raise PulseError("the family grouping drifted: two ranking groups share one cell key")
    return out


# --- the ranking's view -----------------------------------------------------------------------


def ranking_sees(snap: Snapshot, as_of: date) -> dict[str, Any]:
    """{cell: criterion value} and the competition rank 1-12, for the pick whose history is every
    stored session up to and including `as_of` (what Why this pick calls "Family-band recent")."""
    rows = [i for i, d in enumerate(snap.days) if d <= as_of and d in snap.attrs]
    if len(rows) < WARMUP:
        return {
            "available": False,
            "reason": (
                f"the ranking needs {WARMUP} stored sessions with day attributes and has "
                f"{len(rows)} up to {as_of}"
            ),
            "history_days": len(rows),
            "cells": {},
        }
    names = snap.names
    groups = check_grouping(names)
    values = snap.net[rows]
    P = np.vstack([values, np.zeros((1, len(names)))])  # the target row is never read
    recent = recent_score(P, len(rows))
    fam = family_index(names)
    value = np.bincount(fam, weights=recent) / np.bincount(fam)
    by_cell = {groups[g]: float(value[g]) for g in groups}
    ordered = sorted(by_cell.values(), reverse=True)
    cells = {
        key: {
            "value": round(v, 2),
            # competition rank: a tie shares its rank, nobody is placed above an equal value
            "rank": 1 + sum(1 for o in ordered if o > v),
            "of": len(by_cell),
        }
        for key, v in by_cell.items()
    }
    return {
        "available": True,
        "reason": None,
        "history_days": len(rows),
        "history_to": snap.days[rows[-1]].isoformat(),
        "cells": cells,
    }


# --- the windows ------------------------------------------------------------------------------


def _round(x: float | None, nd: int = 2) -> float | None:
    return None if x is None or not np.isfinite(x) else round(float(x), nd)


def _stat(ctx: mx.Ctx, vmask: np.ndarray, items: tuple[mx.Item, ...], forward: set[int]) -> dict:
    """One figure box: the pooled mean, its sessions and variants, how many sessions are forward."""
    pl = mx.pool_mask(ctx, vmask, items)
    s = mx.summarise(ctx, pl)
    if s["nv"] == 0:
        reason = "no stored result in this window" if s["pre"] == 0 else "removed by the filters"
        return {"st": "missing", "reason": reason, "avg": None, "n": 0, "nv": 0, "variants": 0}
    kept = pl.post.any(axis=0)
    ordinals = ctx.cube.ordinal[pl.ti[kept]]
    return {
        "st": "ok",
        "avg": _round(s["avg"], 2),
        "n": int(s["n"]),
        "nv": int(s["nv"]),
        "variants": int(pl.post.any(axis=1).sum()),
        "first": ctx.cube.days[int(pl.ti[kept][0])].isoformat(),
        "last": ctx.cube.days[int(pl.ti[kept][-1])].isoformat(),
        "forward": int(sum(1 for o in ordinals if int(o) in forward)),
    }


def rolling_means(G: np.ndarray, vmask: np.ndarray, tmask: np.ndarray, size: int = ROLL):
    """(session positions, rolling mean) over the sessions the pooled variants have a value on:
    the mean of the variant-days in each `size`-session window. Windows start once `size` sessions
    exist; a session no pooled variant has a value on is not a session of this cell."""
    cols = np.flatnonzero(tmask)
    sub = G[np.ix_(np.flatnonzero(vmask), cols)]
    have = ~np.isnan(sub)
    keep = have.any(axis=0)
    cols, sub, have = cols[keep], sub[:, keep], have[:, keep]
    if cols.size < size:
        return cols, np.array([])
    total = np.where(have, sub, 0.0).sum(axis=0)
    count = have.sum(axis=0).astype(float)
    cs = np.concatenate([[0.0], np.cumsum(total)])
    cn = np.concatenate([[0.0], np.cumsum(count)])
    s = cs[size:] - cs[:-size]
    n = cn[size:] - cn[:-size]
    return cols, s / n


def _spark_and_flag(
    cube: mx.Cube, vmask: np.ndarray, as_of: date, p1: tuple[date, date], last21: float | None
) -> tuple[dict, dict]:
    upto = cube.ordinal <= as_of.toordinal()
    cols, means = rolling_means(cube.G, vmask, upto)
    spark_days: list[str] = []
    spark_vals: list[float | None] = []
    if means.size:
        end_cols = cols[ROLL - 1 :]
        end_cols, means_s = end_cols[-SPARK_SESSIONS:], means[-SPARK_SESSIONS:]
        spark_days = [cube.days[int(c)].isoformat() for c in end_cols]
        spark_vals = [_round(float(v), 2) for v in means_s]
    lo, hi = p1
    in_p1 = (cube.ordinal >= lo.toordinal()) & (cube.ordinal <= min(hi, as_of).toordinal())
    _, p1_means = rolling_means(cube.G, vmask, in_p1)
    p1_all = cube.G[np.ix_(np.flatnonzero(vmask), np.flatnonzero(in_p1))]
    p1_all = p1_all[~np.isnan(p1_all)]
    p1_mean = _round(float(p1_all.mean())) if p1_all.size else None
    spark = {"days": spark_days, "values": spark_vals, "p1_mean": p1_mean}
    flag: dict[str, Any] = {"state": "unknown", "windows": int(p1_means.size)}
    if last21 is None:
        flag["reason"] = "no last-21 mean to compare"
    elif p1_means.size < MIN_FLAG_WINDOWS:
        flag["reason"] = (
            f"only {p1_means.size} rolling-{ROLL} windows in P1 (the rule needs {MIN_FLAG_WINDOWS})"
        )
    else:
        p10, p90 = (float(x) for x in np.percentile(p1_means, [10, 90]))
        flag.update(
            p10=_round(p10),
            p90=_round(p90),
            last21=_round(last21),
            state="above" if last21 > p90 else "below" if last21 < p10 else "inside",
        )
    return spark, flag


# --- picks ------------------------------------------------------------------------------------


def _listed(entry_lists: dict, key: str) -> list[dict]:
    p = (entry_lists or {}).get(key) or {}
    return [
        *({"variant": n, "role": "core"} for n in p.get("core", [])),
        *({"variant": n, "role": "buy"} for n in p.get("buy", [])),
    ]


def _share(per_session: list[dict[str, list[str]]], key: str) -> dict:
    """The focus list's picks over a set of sessions, by cell: core picks land in a cell (a share of
    all core picks), a Buy add-on is counted apart (a session count), because the Buy is not a core
    pick and its cells would otherwise read 0 by construction."""
    n = len(per_session)
    core_total = sum(len(s["core"]) for s in per_session)
    cells: dict[str, dict] = {}
    for k in cell_keys():
        in_core = sum(1 for s in per_session for v in s["core"] if cell_of(v) == k)
        buy_days = sum(1 for s in per_session if any(cell_of(v) == k for v in s["buy"]))
        cells[k] = {
            "core": in_core,
            # a Buy cell has no core picks by construction: its figure is `buy_days`
            "share": (
                _round(in_core / core_total, 4) if core_total and not k.startswith("buy_") else None
            ),
            "buy_days": buy_days,
        }
    return {"sessions": n, "core_total": core_total, "list": key, "cells": cells}


def _recorded_sessions(snap: Snapshot, as_of: date, key: str) -> tuple[list[dict], list[str]]:
    sessions, days = [], []
    for day_s, e in sorted(snap.trusted_entries().items()):
        d = date.fromisoformat(day_s)
        if d > as_of or d.weekday() >= 5 or e.get("before_first_entry") is not True:
            continue
        lst = (e.get("lists") or {}).get(key) or {}
        sessions.append({"core": list(lst.get("core", [])), "buy": list(lst.get("buy", []))})
        days.append(day_s)
    return sessions[-SHARE_SESSIONS:], days[-SHARE_SESSIONS:]


def _next_trading_day(after: date, is_trading: Callable[[date], bool]) -> date | None:
    d = after + timedelta(days=1)
    for _ in range(14):
        if d.weekday() < 5 and is_trading(d):
            return d
        d += timedelta(days=1)
    return None


# --- the pulse --------------------------------------------------------------------------------


def parse_index(raw: str | None) -> str:
    code = INDEX_CHOICES.get((raw or "both").strip().lower())
    if code is None:
        raise PulseError("index must be NIFTY, SENSEX or both")
    return code


def compute(
    cube: mx.Cube,
    snap: Snapshot,
    *,
    as_of: date | None = None,
    list_id: str = "A",
    index: str = "both",
    picks_fn: Callable[[date], dict | None] | None = None,
    reconstructable: Callable[[], list[date]] | None = None,
    is_trading: Callable[[date], bool] | None = None,
) -> dict:
    """The pulse as of one session (default: the latest stored one).

    `picks_fn(day)` gives the reconstructed `{list: {core, buy, ...}}` for a day the rule can be
    re-run for and `reconstructable()` lists those days (both from `daylog.reconstruction`); without
    them there are no reconstructed picks. `is_trading(day)` names the next pick's day."""
    if list_id not in LISTS:
        raise PulseError(f"list must be one of {', '.join(LISTS)}")
    if index not in ("both", "N", "S"):
        raise PulseError("index must be NIFTY, SENSEX or both")
    if cube.n_variants == 0 or not cube.days:
        return {
            "available": False,
            "reason": "no strategy has stored results yet",
            "basis": "gross",
        }
    stored = [d for d in cube.days]
    if as_of is None:
        eff = stored[-1]
    else:
        before = [d for d in stored if d <= as_of]
        if not before:
            raise PulseError(
                f"no stored session on or before {as_of}; the store starts {stored[0]}"
            )
        eff = before[-1]
    ordinal = eff.toordinal()
    upto = cube.ordinal <= ordinal

    src = mx.perf_source(cube)
    forward_days = {
        date.fromisoformat(k).toordinal()
        for k, e in snap.trusted_entries().items()
        if e.get("before_first_entry") is True and date.fromisoformat(k).weekday() < 5
    }
    base_ctx = mx.Ctx(cube, src, upto, np.ones(len(cube.days), dtype=bool), mx.Filters(), 1)
    p1_lo, p1_hi, p1_label = mx.NAMED["P1"]
    p2_lo, p2_hi, p2_label = mx.NAMED["P2"]

    def period_ctx(lo: date, hi: date) -> mx.Ctx:
        sel = mx.PeriodSel("period", "", lo, min(hi, eff))
        return mx.Ctx(cube, src, sel.mask(cube.ordinal), base_ctx.t_cond, mx.Filters(), 1)

    p1_ctx, p2_ctx = period_ctx(p1_lo, p1_hi), period_ctx(p2_lo, p2_hi)
    cell_by_variant = np.array([cell_of(n) for n in cube.names])
    sub_index = np.ones(cube.n_variants, dtype=bool) if index == "both" else cube.index == index

    rank = ranking_sees(snap, eff)
    chain = snap.chain()

    # which lists picked where: the entry for the next pick when recorded, else the latest entry
    is_trading_fn = is_trading or (lambda d: d.weekday() < 5)
    next_day = _next_trading_day(eff, is_trading_fn)
    entries = snap.trusted_entries()
    picks_block: dict[str, Any] = {"source": None, "day": None, "late": False, "lists": {}}
    chosen: str | None = None
    if next_day is not None and next_day.isoformat() in entries:
        chosen = next_day.isoformat()
    else:
        past = [k for k in entries if date.fromisoformat(k) <= eff]
        chosen = max(past) if past else None
    if chosen is not None:
        e = entries[chosen]
        picks_block = {
            "source": "recorded",
            "day": chosen,
            "late": e.get("before_first_entry") is not True,
            "lists": {k: _listed(e.get("lists") or {}, k) for k in LISTS},
        }
    elif picks_fn is not None and reconstructable is not None:
        days = [d for d in reconstructable() if d <= eff]
        got = picks_fn(days[-1]) if days else None
        if got is not None:
            picks_block = {
                "source": "reconstructed",
                "day": days[-1].isoformat(),
                "late": False,
                "lists": {k: _listed(got, k) for k in LISTS},
            }
    by_cell_chips: dict[str, list[dict]] = {k: [] for k in cell_keys()}
    for lk, picked in picks_block["lists"].items():
        for p in picked:
            by_cell_chips.setdefault(cell_of(p["variant"]), []).append({"list": lk, **p})

    # the focus list's share of picks
    rec_sessions, rec_days = _recorded_sessions(snap, eff, list_id)
    share_recorded = _share(rec_sessions, list_id) if rec_sessions else None
    if share_recorded is not None:
        share_recorded["from"], share_recorded["to"] = rec_days[0], rec_days[-1]
    share_recon = None
    if picks_fn is not None and reconstructable is not None:
        days = [d for d in reconstructable() if d <= eff][-SHARE_SESSIONS:]
        got_all = [(d, picks_fn(d)) for d in days]
        sess = [
            {"core": list(g[list_id]["core"]), "buy": list(g[list_id]["buy"])}
            for _, g in got_all
            if g is not None
        ]
        if sess:
            share_recon = _share(sess, list_id)
            share_recon["from"], share_recon["to"] = days[0].isoformat(), days[-1].isoformat()

    cells: list[dict] = []
    for key in cell_keys():
        meta = _cell_meta(key)
        in_cell = cell_by_variant == key
        vmask = in_cell & sub_index
        slots = sorted({str(s) for s in cube.slot[in_cell]})
        cell: dict[str, Any] = {**meta, "slots": slots, "variants": int(vmask.sum())}
        if not in_cell.any():
            cell.update(st="na", reason="no variant of this strategy kind starts in this band")
            cells.append(cell)
            continue
        if not vmask.any():
            cell.update(st="na", reason="this index has no variant in this cell")
            cells.append(cell)
            continue
        windows = {
            str(n): _stat(
                base_ctx,
                vmask,
                (mx.Item(str(n), f"Last {n}", windowed=True, window=n),),
                forward_days,
            )
            for n in WINDOWS
        }
        p1 = _stat(p1_ctx, vmask, (), forward_days)
        p2 = _stat(p2_ctx, vmask, (), forward_days)
        last21 = windows["21"]["avg"]
        spark, flag = _spark_and_flag(cube, vmask, eff, (p1_lo, p1_hi), last21)
        r = rank["cells"].get(key)
        fam = MATRIX_FAMILY[meta["kind"]]
        cell.update(
            st="ok",
            windows=windows,
            p1=p1,
            p2=p2,
            spark=spark,
            flag=flag,
            rank=r,
            chips=by_cell_chips.get(key, []),
            share={
                "recorded": (share_recorded or {}).get("cells", {}).get(key),
                "reconstructed": (share_recon or {}).get("cells", {}).get(key),
            },
            matrix={
                "view": "pulse",
                "family": fam,
                "slot": ",".join(slots),
                "index": None if index == "both" else {"N": "NIFTY", "S": "SENSEX"}[index],
            },
        )
        cells.append(cell)

    on_time = sorted(
        k
        for k, e in entries.items()
        if e.get("before_first_entry") is True and date.fromisoformat(k).weekday() < 5
    )
    late = sorted(k for k, e in entries.items() if e.get("before_first_entry") is not True)
    return {
        "available": True,
        "basis": "gross",
        "as_of": eff.isoformat(),
        "as_of_requested": as_of.isoformat() if as_of else None,
        "store": {
            "first": stored[0].isoformat(),
            "last": stored[-1].isoformat(),
            "sessions": len(stored),
            "weekend_excluded": [d.isoformat() for d in cube.weekend_days],
        },
        "next_pick_day": next_day.isoformat() if next_day else None,
        "list": list_id,
        "index": {"both": "both", "N": "NIFTY", "S": "SENSEX"}[index],
        "windows": list(WINDOWS),
        "periods": {
            "P1": {"label": p1_label, "from": p1_lo.isoformat(), "to": min(p1_hi, eff).isoformat()},
            "P2": {"label": p2_label, "from": p2_lo.isoformat(), "to": min(p2_hi, eff).isoformat()},
        },
        "rank": {
            "available": rank["available"],
            "reason": rank["reason"],
            "history_days": rank["history_days"],
            "history_to": rank.get("history_to"),
            "of": RANK_OF,
            "basis": "net",
            "for": next_day.isoformat() if next_day else None,
            "weights": {k: float(lst.weights.get("rfam", 0.0)) for k, lst in LISTS.items()},
        },
        "picks": picks_block,
        "share": {
            "list": list_id,
            "sessions": SHARE_SESSIONS,
            "recorded": (
                {k: v for k, v in share_recorded.items() if k != "cells"}
                if share_recorded
                else None
            ),
            "reconstructed": (
                {k: v for k, v in share_recon.items() if k != "cells"} if share_recon else None
            ),
        },
        "journal": {
            "entries": len(snap.entries),
            "on_time": len(on_time),
            "late": late,
            "chain": chain,
        },
        "flag_rule": (
            f"A cell is flagged when its last-21 mean sits outside the P10 to P90 of its own "
            f"rolling-{ROLL}-session means in P1 (windows entirely inside P1; at least "
            f"{MIN_FLAG_WINDOWS} of them)."
        ),
        "cells": cells,
    }
