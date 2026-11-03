"""BL-185 selection (Phase 3): T1's recipe on the selection year only.

For each underlying x cohort x stratum (expiry days / other days) the Stage B metrics become tensors
over (slot, strike, leg SL, trail, re-entry, overall stop, exit). A cell-config at a slot passes the
gates when it entered on >= 95 % of the stratum's days, net > 0, Calmar >= 1, profit factor >= 1.05
and overall-stop days <= 30 %. Its robust score at a slot is min(own Martin, median Martin of its +-1
step neighbours) and needs at least half of its neighbours to pass. A band's winner is the cell-config
with the best mean robust score over the band's slots, passing the gates (slot breadth) on >= 70 % of
them, positive in >= 2 of the 3 half-year pieces of S on average, and not on RE COST x2 (BL-009
parity open). One winner per (underlying, cohort, mode, band, stratum), later run at every slot of its
half. `mode half`: morning bands A, B with exits 11:30..13:00, afternoon bands C, D at 15:28;
`mode whole`: every band at 15:28 (the control arm).

    uv run python research/common/two_session/select.py [--out winners.json]
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np

HERE = Path(__file__).parent
sys.path.insert(0, str(HERE.parent))
sys.path.insert(0, str(HERE))
import grid  # noqa: E402
import stage_b as sb  # noqa: E402

M = {m: i for i, m in enumerate(sb.METRICS)}
EXIT_IDX = {e: i for i, e in enumerate(sb.EXITS_AM)}  # 11:30, 12:00, 12:30, 13:00, 15:28
STOP_IDX = {s: i for i, s in enumerate(sb.STOPS)}  # None, 500 ... 4000
EARLY = (0, 1, 2, 3)
BANDS = {"morning": ("A", "B"), "afternoon": ("C", "D")}


def adjacency(n: int, chains: tuple[tuple[int, ...], ...]) -> tuple[np.ndarray, np.ndarray]:
    lo = np.full(n, -1)
    hi = np.full(n, -1)
    for ch in chains:
        for a, b in zip(ch[:-1], ch[1:], strict=True):
            hi[a], lo[b] = b, a
    return lo, hi


def neighbours(x: np.ndarray, axis: int, lo: np.ndarray, hi: np.ndarray) -> list[np.ndarray]:
    out = []
    for idx in (lo, hi):
        t = np.take(x, np.clip(idx, 0, None), axis=axis)
        shape = [1] * x.ndim
        shape[axis] = len(idx)
        out.append(np.where((idx >= 0).reshape(shape), t, np.nan))
    return out


def tensors(u: str, co: str, k: int) -> tuple[dict, list[str]]:
    """{metric: array (slots, strike, sl, trail, re, stop, exit)} for stratum k, NaN where absent."""
    ax = grid.AXES[co]
    shape = (
        len(grid.SLOTS),
        len(ax["strike"]),
        len(ax["leg_sl"]),
        len(ax["trail"]),
        len(ax["reentry"]),
        len(sb.STOPS),
        len(sb.EXITS_AM),
    )
    T = {m: np.full(shape, np.nan) for m in sb.METRICS}
    missing = []
    for si, slot in enumerate(grid.SLOTS):
        f = sb.OUT / f"{u}_{co}_{slot}.npz"
        if not f.exists():
            missing.append(slot)
            continue
        z = np.load(f)
        v = z["metrics"][:, :, k, :].reshape(
            shape[1], shape[2], shape[3], shape[4], -1, len(sb.METRICS)
        )
        for ci, (e, st) in enumerate(zip(z["exits"], z["stops"], strict=True)):
            ei, sj = EXIT_IDX[str(e)], STOP_IDX[None if int(st) < 0 else int(st)]
            for m, mi in M.items():
                T[m][si, :, :, :, :, sj, ei] = v[:, :, :, :, ci, mi]
    return T, missing


def gates(T: dict) -> np.ndarray:
    with np.errstate(invalid="ignore"):
        g = (
            (T["entered"] >= 0.95)
            & (T["net"] > 0)
            & (T["calmar"] >= 1.0)
            & (T["pf"] >= 1.05)
            & (T["stopdays"] <= 0.30)
        )
    return g & np.isfinite(T["martin"])


def robust(T: dict) -> tuple[np.ndarray, np.ndarray]:
    """(per-slot robust Martin, pass flag incl. the neighbour rule), shape of a tensor."""
    g = gates(T)
    mart = np.where(np.isfinite(T["martin"]), T["martin"], np.nan)
    chains = {
        1: tuple(tuple(grid.STRIKES.index(x) for x in ch) for ch in grid.CHAINS["strike"]),
        2: (tuple(range(len(grid.AXES["W"]["leg_sl"]))),),
        3: None,
        4: None,
        5: (tuple(range(1, len(sb.STOPS))) + (0,),),  # 500 ... 4000, then none (the loosest)
        6: (EARLY,),
    }
    stack_m, stack_g = [], []
    for axis in range(1, 7):
        n = mart.shape[axis]
        ch = chains[axis] if chains[axis] is not None else (tuple(range(n)),)
        lo, hi = adjacency(n, ch)
        stack_m += neighbours(mart, axis, lo, hi)
        stack_g += neighbours(np.where(g, 1.0, 0.0), axis, lo, hi)
    nm = np.stack(stack_m)
    ng = np.stack(stack_g)
    valid = ~np.isnan(nm)
    with np.errstate(invalid="ignore", all="ignore"):
        med = np.nanmedian(nm, axis=0)
        frac = np.nansum(ng, axis=0) / np.maximum(valid.sum(0), 1)
        rob = np.fmin(mart, med)
        ok = g & (frac >= 0.5) & (valid.sum(0) > 0)
    return np.where(ok, rob, np.nan), ok


def winners_for(u: str, co: str, k: int, mode: str) -> tuple[list[dict], list[str]]:
    T, missing = tensors(u, co, k)
    rob, ok = robust(T)
    ban_ok = np.ones(rob.shape, dtype=bool)
    if co == "D":
        ban_ok[:, :, :, :, 2, :, :] = False  # RE COST x2: parity unverified, not a winner
    out = []
    plan = []
    if mode == "half":
        plan = [("morning", b, EARLY) for b in BANDS["morning"]] + [
            ("afternoon", b, (4,)) for b in BANDS["afternoon"]
        ]
    else:
        plan = [("whole", b, (4,)) for b in ("A", "B", "C", "D")]
    for half, band, exits in plan:
        sl = [i for i, s in enumerate(grid.SLOTS) if grid.BAND[s] == band]
        if any(grid.SLOTS[i] in missing for i in sl):
            out.append(
                {
                    "underlying": u,
                    "cohort": co,
                    "mode": mode,
                    "half": half,
                    "band": band,
                    "stratum": ("expiry", "other")[k - 1],
                    "winner": None,
                    "why": f"slots missing: {[grid.SLOTS[i] for i in sl if grid.SLOTS[i] in missing]}",
                }
            )
            continue
        e_mask = np.zeros(rob.shape[-1], dtype=bool)
        e_mask[list(exits)] = True
        r = np.where(e_mask[None, None, None, None, None, None, :] & ban_ok, rob, np.nan)[sl]
        valid_share = np.mean(~np.isnan(r), axis=0)
        score = np.nanmean(np.where(np.isnan(r), np.nan, r), axis=0)
        pieces = np.nanmean(T["pos_pieces"][sl], axis=0)
        with np.errstate(invalid="ignore"):
            elig = (valid_share >= 0.70) & (pieces >= 2.0) & ~np.isnan(score)
        cand = np.where(elig, score, -np.inf)
        if not np.isfinite(cand).any():
            out.append(
                {
                    "underlying": u,
                    "cohort": co,
                    "mode": mode,
                    "half": half,
                    "band": band,
                    "stratum": ("expiry", "other")[k - 1],
                    "winner": None,
                    "why": "no cell passes the gates, breadth and half-year rules",
                }
            )
            continue
        order = np.argsort(cand, axis=None)[::-1][:5]
        top = []
        for flat in order:
            if not np.isfinite(cand.flat[flat]):
                break
            i = np.unravel_index(flat, cand.shape)
            ax = grid.AXES[co]
            cell_k = int(
                np.ravel_multi_index(
                    i[:4],
                    (len(ax["strike"]), len(ax["leg_sl"]), len(ax["trail"]), len(ax["reentry"])),
                )
            )
            cell = grid.cells(co)[cell_k]
            net = np.nanmean(T["net"][sl][(slice(None),) + i])
            top.append({
                "cell": cell.cid, "strike": cell.strike, "leg_sl": cell.leg_sl, "trail": cell.trail, "reentry": cell.reentry,
                "stop": None if i[4] == 0 else sb.STOPS[i[4]], "exit": sb.EXITS_AM[i[5]],
                "score": float(cand.flat[flat]), "valid_share": float(valid_share[i]), "pieces": float(pieces[i]),
                "net_per_lot_day": float(net),
            })  # fmt: skip
        out.append(
            {
                "underlying": u,
                "cohort": co,
                "mode": mode,
                "half": half,
                "band": band,
                "stratum": ("expiry", "other")[k - 1],
                "winner": top[0],
                "runners_up": top[1:],
            }
        )
    return out, missing


def main() -> None:
    out = (
        Path(sys.argv[sys.argv.index("--out") + 1])
        if "--out" in sys.argv
        else HERE.parents[1] / "bl185" / "winners.json"
    )
    res = []
    for u in grid.UNDERLYINGS:
        for co in grid.AXES:
            for k in (1, 2):
                for mode in ("half", "whole"):
                    w, _ = winners_for(u, co, k, mode)
                    res += w
    out.write_text(json.dumps(res, indent=1, default=str))
    for r in res:
        w = r["winner"]
        line = f"{r['underlying']:6s} {r['cohort']} {r['mode']:5s} {r['half']:9s} band {r['band']} {r['stratum']:6s} "
        print(
            line
            + (
                f"{w['cell']} {w['strike']} SL{w['leg_sl']} tr{w['trail']} re{w['reentry']} stop {w['stop']} exit {w['exit']} score {w['score']:.1f} net {w['net_per_lot_day']:+.0f}"
                if w
                else f"-- {r['why']}"
            )
        )


if __name__ == "__main__":
    main()
