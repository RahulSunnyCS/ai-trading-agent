"""BL-081 step 1: which hourly state variables carry pick-value, and at which hour (no engine runs).

    uv run --with pandas --with numpy --with duckdb python research/bl081/stage0.py --period P1|P2|P3
    uv run --with pandas --with numpy --with duckdb python research/bl081/stage0.py --combine

Rule as registered in backlog/BL-081-drb-hourly-checkpoints-and-no-trade.md (Phase 0): pick-value =
mean over selection days of the Spearman correlation, across the pending universe (variants that start
at least 15 minutes after the hour), between the day's state fit and its realised P&L; 20 label
permutations (seeds 0-19); a variable passes at an hour in a period if its value is > 0 and above all
20; it counts only if it passes at >= 2 of the 4 acted hours (10:30-13:30) in all three periods.
A day with no label for the variable is skipped; a day on which the fit has no variance counts as 0.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np
import pandas as pd

HERE = Path(__file__).parent
OUT = HERE / "out"
FIT_LB = "5:30,21:25,63:25,126:20"
PERIODS = {
    "P1": [],
    "P2": ["--window-from", "2024-10-09", "--window-to", "2025-08-29"],
    "P3": ["--nifty-only", "--early-results", str(HERE.parent / "bl071" / "results"),
           "--window-from", "2022-01-03", "--window-to", "2024-10-08"],
}
HOURS = {"1030": 630, "1130": 690, "1230": 750, "1330": 810, "1430": 870}
ACTED = ["1030", "1130", "1230", "1330"]
N_SHUF = 20


def _rank(x: np.ndarray) -> np.ndarray:
    _, inv, cnt = np.unique(x, return_inverse=True, return_counts=True)
    return (np.cumsum(cnt) - (cnt - 1) / 2)[inv]


def _spearman(ra: np.ndarray, rb: np.ndarray) -> float:
    a, b = ra - ra.mean(), rb - rb.mean()
    d = np.sqrt((a * a).sum() * (b * b).sum())
    return 0.0 if d == 0 else float((a * b).sum() / d)


def _fit(Pw: np.ndarray, Mw: np.ndarray, lookbacks) -> np.ndarray:
    """rotate.skewed_fit over the rows before the day (Pw/Mw = those rows, oldest first)."""
    num = np.zeros(Pw.shape[1])
    den = np.zeros(Pw.shape[1])
    for n, w in lookbacks:
        P, m = Pw[-n:], Mw[-n:]
        cnt = m.sum(axis=0)
        avg = np.where(cnt > 0, (P * m).sum(axis=0) / np.maximum(cnt, 1), 0.0)
        num += w * avg * (cnt > 0)
        den += w * (cnt > 0)
    return np.where(den > 0, num / np.maximum(den, 1e-12), 0.0)


def run_period(period: str) -> None:
    sys.argv = ["rotate.py", "--basket", "DRB-6W3L2", "--fit-lookbacks", FIT_LB, *PERIODS[period]]
    sys.path.insert(0, str(HERE.parent / "bl057"))
    sys.path.insert(0, str(HERE))
    import rotate as R  # noqa: E402
    import state as S  # noqa: E402

    P, f = R.load_all()
    names, days = list(P.columns), P.index
    Pv = P.to_numpy()
    W = R.WARMUP
    sel = np.arange(W, len(days))
    idx_letter = np.array([n[0] for n in names])
    fam = [n.split("_")[1] for n in names]
    typ = np.array(["dir" if x in ("dir", "ditm1") else "buy" if x == "buy" else "wide" for x in fam])
    start = np.array([int(n.split("_")[2][:2]) * 60 + int(n.split("_")[2][2:]) for n in names])
    band = np.where(start <= 12 * 60 + 2, "B", np.where(start <= 14 * 60 + 2, "C", "D"))
    day_s = np.array([d.strftime("%Y-%m-%d") for d in days])

    raw = pd.read_csv(OUT / "state_raw.csv", dtype={"h": str})
    lab = S.labels(raw)
    lab = lab.set_index(["index", "h", "day"])

    def label_matrix(var: str, h: str) -> np.ndarray:
        """days x variants of int codes (-1 = no label); a variant reads its own index's label."""
        codes = {}
        out = np.full((len(days), len(names)), -1, dtype=int)
        for L, und in (("N", "NIFTY"), ("S", "SENSEX")):
            cols = idx_letter == L
            if not cols.any():
                continue
            try:
                s = lab.loc[(und, h)][var].reindex(day_s)
            except KeyError:
                continue
            v = np.array([None if pd.isna(x) else x for x in s.to_numpy(object)], dtype=object)
            for k in sorted({x for x in v if x is not None}):
                codes.setdefault(k, len(codes))
            c = np.array([codes[x] if x is not None else -1 for x in v])
            out[:, cols] = c[:, None]
        return out

    # ---- calibration: weekday / DTE / VIX band over ALL variants, as rotate prints them -------------
    wd, vb, dte = R.day_inputs(f, names)
    calib = {"weekday": [], "dte": [], "vix": []}
    for i in sel:
        crit, _ = R.score_day(Pv, wd, vb, dte, i)
        today = _rank(Pv[i])
        for k in calib:
            calib[k].append(_spearman(_rank(crit[k]), today))
        if i == sel[3]:  # the local fit reproduces rotate's skewed_fit exactly
            match = (wd[:, None] == wd[i]).repeat(Pv.shape[1], axis=1)
            lo = max(0, i - max(n for n, _ in R.LOOKBACKS))
            assert np.allclose(R.skewed_fit(Pv, match, i), _fit(Pv[lo:i], match[lo:i], R.LOOKBACKS))
    calib = {k: float(np.mean(v)) for k, v in calib.items()}
    print(f"[{period}] calibration over {len(sel)} days (all variants):", {k: round(v, 3) for k, v in calib.items()})

    rows, detail = [], []
    maxlb = max(n for n, _ in R.LOOKBACKS)
    for h, hm in HOURS.items():
        pend = np.where(start >= hm + 15)[0]
        if len(pend) < 8:
            continue
        rankP = {int(i): _rank(Pv[i, pend]) for i in sel}
        for var in S.ALL_LABELS:
            code = label_matrix(var, h)[:, pend]
            has = (code >= 0).any()
            labelled = np.array([(code[i] >= 0).all() for i in sel])
            if not has or labelled.sum() < 20:
                rows.append(dict(period=period, h=h, var=var, n_days=int(labelled.sum()), real=np.nan,
                                 shuf_max=np.nan, shuf_mean=np.nan, shuf_min=np.nan, shift_max=np.nan, passes=False, passes_strict=False))
                continue
            vals, shifted = [], []
            for kind, s in [("real", -1), *[("perm", k) for k in range(N_SHUF)], *[("shift", k) for k in range(N_SHUF)]]:
                if kind == "real":
                    c = code
                elif kind == "perm":
                    c = code[np.random.default_rng(s).permutation(len(days))]
                else:  # circular shift: keeps the labels' own persistence, breaks their link to the P&L
                    off = int(np.random.default_rng(1000 + s).integers(21, len(days) - 21))
                    c = np.roll(code, off, axis=0)
                cors = []
                for i in sel:
                    if not (c[i] >= 0).all():
                        continue
                    lo = max(0, i - maxlb)
                    m = (c[lo:i] == c[i][None, :])
                    cors.append(_spearman(_rank(_fit(Pv[lo:i][:, pend], m, R.LOOKBACKS)), rankP[int(i)]))
                v = float(np.mean(cors)) if cors else np.nan
                (shifted if kind == "shift" else vals).append(v)
            real, sh, shf = vals[0], np.array(vals[1:]), np.array(shifted)
            rows.append(dict(period=period, h=h, var=var, n_days=int(labelled.sum()), real=real,
                             shuf_max=float(np.nanmax(sh)), shuf_mean=float(np.nanmean(sh)),
                             shuf_min=float(np.nanmin(sh)), shift_max=float(np.nanmax(shf)),
                             passes=bool(real > 0 and real > np.nanmax(sh)),
                             passes_strict=bool(real > 0 and real > np.nanmax(sh) and real > np.nanmax(shf))))
            # rupee view: mean pending P&L by (state, type, band) on the real labels
            for k in np.unique(code[code >= 0]):
                for t in ("wide", "dir", "buy"):
                    for b in ("B", "C", "D"):
                        cols = np.where((typ[pend] == t) & (band[pend] == b))[0]
                        if not len(cols):
                            continue
                        mask = (code[sel][:, cols] == k)
                        vals_ = Pv[sel][:, pend][:, cols]
                        n = int(mask.sum())
                        if n:
                            detail.append(dict(period=period, h=h, var=var, code=int(k), type=t, band=b,
                                               mean_pnl=float(vals_[mask].mean()), n_obs=n,
                                               n_days=int(mask.any(axis=1).sum())))
    pd.DataFrame(rows).to_csv(OUT / f"stage0_{period}.csv", index=False)
    pd.DataFrame(detail).to_csv(OUT / f"stage0_{period}_detail.csv", index=False)
    (OUT / f"stage0_{period}_calibration.json").write_text(json.dumps(calib))
    print(f"[{period}] done: {len(rows)} variable x hour rows, {int(sum(r['passes'] for r in rows))} pass, {int(sum(r['passes_strict'] for r in rows))} pass strict")


def combine() -> None:
    sys.path.insert(0, str(HERE))
    import state as S

    df = pd.concat([pd.read_csv(OUT / f"stage0_{p}.csv", dtype={"h": str}) for p in PERIODS])
    rows = []
    for var in S.ALL_LABELS:
        r = dict(var=var)
        have_all_periods = True
        for h in HOURS:
            cells = []
            for p in PERIODS:
                x = df[(df["var"] == var) & (df.h == h) & (df.period == p)]
                if x.empty or x.real.isna().all():
                    cells.append("n/a")
                    have_all_periods = False
                else:
                    x = x.iloc[0]
                    cells.append(f"{x.real:+.3f}{'**' if x.passes_strict else '*' if x.passes else ''}")
            r[h] = " / ".join(cells)
        passes = {h: all(
            (lambda x: (not x.empty) and bool(x.iloc[0].passes_strict))(df[(df["var"] == var) & (df.h == h) & (df.period == p)])
            for p in PERIODS) for h in ACTED}
        r["hours_passing_everywhere"] = ",".join(h for h, ok in passes.items() if ok) or "-"
        r["n_hours"] = sum(passes.values())
        r["counts"] = bool(sum(passes.values()) >= 2 and var not in S.SUPPORTING_ONLY and have_all_periods)
        r["mean_real"] = float(df[(df["var"] == var) & (df.h.isin(ACTED))].real.mean())
        rows.append(r)
    t = pd.DataFrame(rows).sort_values(["counts", "n_hours", "mean_real"], ascending=False)
    t.to_csv(OUT / "stage0_heatmap.csv", index=False)
    pd.set_option("display.width", 250, "display.max_colwidth", 60)
    print("pick-value P1 / P2 / P3 (* = above all 20 label permutations, ** = also above all 20 circular shifts); counts = passes at >=2 acted hours in every period\n")
    print(t.to_string(index=False, float_format=lambda x: f"{x:+.3f}"))
    print("\ncalibration:", {p: json.loads((OUT / f'stage0_{p}_calibration.json').read_text()) for p in PERIODS})


if __name__ == "__main__":
    if "--combine" in sys.argv:
        combine()
    else:
        run_period(sys.argv[sys.argv.index("--period") + 1])
