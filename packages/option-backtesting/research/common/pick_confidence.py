"""BL-210's absolute confidence of a basket, shared by BL-210 (the basket) and BL-212 (the Dir
pick alone): a blend of win rate and rupees per lot on the days the ranking's own criteria match,
in list C's lookback windows, weighted as the list weights its criteria (rfam dropped).

    conf = basket_confidence(P, idx, i, weekday, band, dmat, LISTS["C"])
    conf["confidence"]  # 0-100

`P` is the net matrix (days x variants) whose rows strictly before `i` are the history; `idx` the
columns of the basket's members; `weekday` / `band` are one label per day INCLUDING day i (the
day's own attributes) and `dmat` the days x variants days-to-expiry labels, likewise.
"""

from __future__ import annotations

import numpy as np

SCALE = 3000.0  # rupees per basket-day that read 0 (-) and 100 (+): fixed in BL-210 Phase 0
CRITERIA = ("recent", "weekday", "dte", "vix")


def blend(b: np.ndarray, scale: float = SCALE) -> tuple[float, float, float]:
    """(win %, rupee score, c) of a basket series on matched days."""
    win = 100.0 * float((b > 0).mean())
    rup = float(np.clip(50.0 + 50.0 * b.mean() / scale, 0.0, 100.0))
    return win, rup, (win + rup) / 2.0


def basket_confidence(
    P: np.ndarray,
    idx: list[int],
    i: int,
    weekday: np.ndarray,
    band: np.ndarray,
    dmat: np.ndarray,
    lst,
    scale: float = SCALE,
) -> dict:
    """C(D) for the day at row i from the basket's own days in the list's windows."""
    hist = P[:i]  # rows strictly before i
    b = hist[:, idx].sum(axis=1)  # the basket's series
    out: dict = {}
    crit: dict[str, float] = {}
    # recent: the last 10 days, 2/3 on the last 5, 1/3 on the 5 before (as score.recent_score)
    if i >= 10:
        w5, r5, c5 = blend(b[i - 5 : i], scale)
        w10, r10, c10 = blend(b[i - 10 : i - 5], scale)
        crit["recent"] = (2 / 3) * c5 + (1 / 3) * c10
        out["recent"] = {
            "win": round((2 / 3) * w5 + (1 / 3) * w10, 1),
            "rupee": round((2 / 3) * r5 + (1 / 3) * r10, 1),
            "days": 10,
        }
    # the fit criteria: matched days per lookback window, blended by the lookback weights and
    # renormalised over the windows with a matching day (as score.skewed_fit)
    matches = {
        "weekday": weekday[:i] == weekday[i],
        "vix": band[:i] == band[i],
        # dte: every member's own label matches the day's (a NIFTY pick dte_n, a SENSEX pick dte_s)
        "dte": np.all(dmat[:i][:, idx] == dmat[i][idx][None, :], axis=1),
    }
    for k, m in matches.items():
        num = den = 0.0
        wins = rups = 0.0
        n_days = 0
        for n, w in lst.lookbacks:
            lo = max(0, i - n)
            mm = m[lo:i]
            if not mm.any():
                continue
            win, rup, c = blend(b[lo:i][mm], scale)
            num += w * c
            wins += w * win
            rups += w * rup
            den += w
            n_days = max(n_days, int(mm.sum()))
        if den > 0:
            crit[k] = num / den
            out[k] = {"win": round(wins / den, 1), "rupee": round(rups / den, 1), "days": n_days}
    weights = {k: lst.weights[k] for k in CRITERIA if k in crit}
    total = sum(weights.values())
    c = sum(weights[k] / total * crit[k] for k in weights) if total else float("nan")
    out["confidence"] = round(float(c), 2)
    out["criteria"] = {k: round(v, 2) for k, v in crit.items()}
    return out
