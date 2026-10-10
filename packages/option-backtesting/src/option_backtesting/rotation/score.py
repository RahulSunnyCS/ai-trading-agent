"""The daily ranking, ported from research/bl057/rotate.py (`score_day`, `select_picks`).

Look-ahead: only rows before the target row are read; the target row contributes its own weekday,
VIX band and days to expiry. `scripts/rotation-parity.py` checks the picks against rotate.py's
`daily_picks_*.csv` for every selection day of each list.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from .lists import BUY_TOP, MIN_WIDE_N, N_BUY, N_CORE, RotationList
from .variants import is_buy, is_dir, is_wide, parts, underlying_of

VIX_BINS = [0, 10.5, 11.5, 13, 15, 18, 99]
VIX_LABELS = ["<10.5", "10.5-11.5", "11.5-13", "13-15", "15-18", "18+"]


def vix_band(vix_open: float | None) -> str:
    """The VIX band of a 09:15 open; bins are right-closed (a, b] as the research's pd.cut."""
    if vix_open is None or not np.isfinite(vix_open):
        return "unknown"
    for lo, hi, label in zip(VIX_BINS[:-1], VIX_BINS[1:], VIX_LABELS, strict=True):
        if lo < vix_open <= hi:
            return label
    return "unknown"


def dte_label(days: float | int | None) -> str:
    if days is None or (isinstance(days, float) and not np.isfinite(days)):
        return "unknown"
    d = int(days)
    return str(d) if d <= 6 else "7+"


def pct_rank(x: np.ndarray) -> np.ndarray:
    """rank / n with tied values sharing their average rank (pandas rank(pct=True, 'average'))."""
    x = np.asarray(x, dtype=float)
    order = np.argsort(x, kind="stable")
    _, start, counts = np.unique(x[order], return_index=True, return_counts=True)
    avg = start + (counts + 1) / 2
    ranks = np.empty(len(x))
    ranks[order] = np.repeat(avg, counts)
    return ranks / len(x)


def family_index(names: list[str]) -> np.ndarray:
    """Strategy type (Widesl incl. closest-premium, Dir, Buy) x start band (09:17-10:02,
    10:17-12:02, 12:17-14:02, 14:17-15:17), pooled across index and strike (BL-074)."""

    def band(tag: str) -> str:
        m = int(tag[:2]) * 60 + int(tag[2:])
        return "A" if m <= 602 else "B" if m <= 722 else "C" if m <= 842 else "D"

    keys = []
    for n in names:
        _, family, tag = parts(n)
        kind = "wide" if is_wide(n) else "dir" if is_dir(n) else family
        keys.append(f"{kind}_{band(tag)}")
    return np.unique(keys, return_inverse=True)[1]


def skewed_fit(
    P: np.ndarray, match: np.ndarray, i: int, lookbacks: tuple[tuple[int, float], ...]
) -> np.ndarray:
    """Average P&L on the days that match day i's attribute, per lookback window, blended by the
    lookback weights and renormalised over the windows that have a matching day."""
    num = np.zeros(P.shape[1])
    den = np.zeros(P.shape[1])
    for n, w in lookbacks:
        lo = max(0, i - n)
        m = match[lo:i]
        cnt = m.sum(axis=0)
        avg = np.where(cnt > 0, (P[lo:i] * m).sum(axis=0) / np.maximum(cnt, 1), 0.0)
        num += w * avg * (cnt > 0)
        den += w * (cnt > 0)
    return np.where(den > 0, num / np.maximum(den, 1e-12), 0.0)


def recent_score(P: np.ndarray, i: int) -> np.ndarray:
    return (2 / 3) * P[i - 5 : i].sum(axis=0) + (1 / 3) * P[i - 10 : i - 5].sum(axis=0)


@dataclass(frozen=True)
class Picks:
    core: list[str]
    buy: list[str]
    overridden: bool
    composite: dict[str, float]  # the composite of every picked variant


def composite(
    P: np.ndarray,
    weekday: np.ndarray,
    band: np.ndarray,
    dte: np.ndarray,
    names: list[str],
    lst: RotationList,
    family_idx: np.ndarray | None = None,
) -> np.ndarray:
    """The composite for the day at the last row of the inputs (index i = len - 1; its P row is
    never read). P: days x variants; weekday / band: one label per day; dte: days x variants."""
    i = P.shape[0] - 1
    w = lst.weights
    crit = {
        "recent": recent_score(P, i),
        "weekday": skewed_fit(
            P, (weekday[:, None] == weekday[i]).repeat(P.shape[1], axis=1), i, lst.lookbacks
        ),
        "dte": skewed_fit(P, dte == dte[i][None, :], i, lst.lookbacks),
        "vix": skewed_fit(
            P, (band[:, None] == band[i]).repeat(P.shape[1], axis=1), i, lst.lookbacks
        ),
    }
    if w.get("rfam"):
        idx = family_idx if family_idx is not None else family_index(names)
        crit["rfam"] = (np.bincount(idx, weights=crit["recent"]) / np.bincount(idx))[idx]
    return sum(
        w[k] * pct_rank(crit[k])
        for k in crit
        if w.get(k) or k in ("recent", "weekday", "dte", "vix")
    )


def select(comp: np.ndarray, names: list[str]) -> Picks:
    """Top N_CORE Widesl/Dir variants (the lowest-scoring Dir swapped for the next-best Widesl
    until at least MIN_WIDE_N are Widesl), plus the best Buy variant when it is in the overall
    top BUY_TOP."""
    wide = np.array([is_wide(n) for n in names])
    dir_ = np.array([is_dir(n) for n in names])
    buy_mask = np.array([is_buy(n) for n in names])
    pool = np.where(~buy_mask)[0]
    order = sorted(pool, key=lambda v: (-comp[v], names[v]))
    core = list(order[:N_CORE])
    overridden = False
    n_wide = int(wide[core].sum())
    if n_wide < MIN_WIDE_N:
        overridden = True
        spare = [v for v in order if wide[v] and v not in core]
        while n_wide < MIN_WIDE_N:
            drop = min((v for v in core if dir_[v]), key=lambda v: (comp[v], names[v]))
            core.remove(drop)
            core.append(spare.pop(0))
            n_wide += 1
    top = sorted(range(len(names)), key=lambda v: (-comp[v], names[v]))[:BUY_TOP]
    buy = [v for v in top if buy_mask[v]][:N_BUY]
    picked = core + buy
    return Picks(
        core=[names[v] for v in core],
        buy=[names[v] for v in buy],
        overridden=overridden,
        composite={names[v]: float(comp[v]) for v in picked},
    )


def dte_matrix(dte_n: np.ndarray, dte_s: np.ndarray, names: list[str]) -> np.ndarray:
    """days x variants: each variant uses its own index's days-to-expiry label."""
    nifty = np.array([underlying_of(n) == "NIFTY" for n in names])
    return np.where(nifty[None, :], dte_n[:, None], dte_s[:, None])
