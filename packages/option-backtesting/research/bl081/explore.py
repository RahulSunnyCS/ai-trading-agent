"""BL-081 block 2: exploratory pooled diagnostic of the pending strategies (registered 2026-10-10, Log).

    uv run --with pandas --with numpy --with duckdb python research/bl081/explore.py --set explore|confirm
    uv run --with pandas --with numpy --with duckdb python research/bl081/explore.py --leads

explore = 2024-10-09 -> 2026-10-08, both indices; confirm = NIFTY 2022-01-03 -> 2024-10-08. Unit = a day:
for (hour, variable, type, band) the day-mean P&L per strategy of the pending strategies is compared across
states (Welch t on day means, best vs worst state). Flag |t| >= 3 in explore; a lead needs the same sign and
|t| >= 2 in confirm. Also the unconditional P&L by type x band x year and the oracle stake of list A.
"""

from __future__ import annotations

import re
import subprocess
import sys
from pathlib import Path

import numpy as np
import pandas as pd

HERE = Path(__file__).parent
OUT = HERE / "out"
SETS = {
    "explore": ["--window-from", "2024-10-09"],
    "confirm": ["--nifty-only", "--early-results", str(HERE.parent / "bl071" / "results"),
                "--window-from", "2022-01-03", "--window-to", "2024-10-08"],
}
LIST_A = ["--weights", "5,34,33,23,0,5", "--fit-lookbacks", "5:30,21:25,63:25,126:20", "--family-key", "band"]
HOURS = {"1030": 630, "1130": 690, "1230": 750, "1330": 810}


def welch(a, b):
    a, b = np.asarray(a, float), np.asarray(b, float)
    if len(a) < 5 or len(b) < 5:
        return np.nan
    se = np.sqrt(a.var(ddof=1) / len(a) + b.var(ddof=1) / len(b))
    return float((a.mean() - b.mean()) / se) if se > 0 else np.nan


def run(which: str) -> None:
    sys.argv = ["rotate.py", "--basket", "DRB-6W3L2", *SETS[which]]
    sys.path.insert(0, str(HERE.parent / "bl057"))
    sys.path.insert(0, str(HERE))
    import rotate as R  # noqa: E402
    import state as S  # noqa: E402

    P, _f = R.load_all()
    names, days = list(P.columns), P.index
    Pv = P.to_numpy()
    day_s = np.array([d.strftime("%Y-%m-%d") for d in days])
    fam = [n.split("_")[1] for n in names]
    typ = np.array(["dir" if x in ("dir", "ditm1") else "buy" if x == "buy" else "wide" for x in fam])
    idx = np.array([n[0] for n in names])
    start = np.array([int(n.split("_")[2][:2]) * 60 + int(n.split("_")[2][2:]) for n in names])
    band = np.where(start <= 602, "A", np.where(start <= 722, "B", np.where(start <= 842, "C", "D")))
    year = np.array([d.year for d in days])

    # ---- A. unconditional: mean P&L per strategy-day by type x band x year (day-clustered t vs 0) ----
    rows = []
    for t in ("wide", "dir", "buy"):
        for b in "ABCD":
            cols = np.where((typ == t) & (band == b))[0]
            if not len(cols):
                continue
            dm = Pv[:, cols].mean(axis=1)  # day mean per strategy
            for y in sorted(set(year)) + ["all"]:
                m = dm if y == "all" else dm[year == y]
                rows.append(dict(type=t, band=b, year=y, n_days=len(m), mean_per_strategy_day=m.mean(),
                                 t_vs_0=m.mean() / (m.std(ddof=1) / np.sqrt(len(m))), win_pct=100 * (m > 0).mean()))
    uncond = pd.DataFrame(rows)
    uncond.to_csv(OUT / f"explore_{which}_uncond.csv", index=False)
    piv = uncond.pivot_table(index=["type", "band"], columns="year", values="mean_per_strategy_day")
    print(f"\n[{which}] A. mean P&L per strategy-day (₹, 1 lot as stored) by type x start band x year")
    print(piv.round(0).to_string())
    pt = uncond.pivot_table(index=["type", "band"], columns="year", values="t_vs_0")
    print("   day-clustered t vs 0:")
    print(pt.round(1).to_string())
    # by slot, pooled
    slot_rows = []
    for t in ("wide", "dir", "buy"):
        for s in sorted(set(start)):
            cols = np.where((typ == t) & (start == s))[0]
            if len(cols):
                dm = Pv[:, cols].mean(axis=1)
                slot_rows.append(dict(type=t, start=f"{s // 60:02d}:{s % 60:02d}", mean=dm.mean(),
                                      t=dm.mean() / (dm.std(ddof=1) / np.sqrt(len(dm)))))
    sl = pd.DataFrame(slot_rows).pivot(index="start", columns="type", values="mean")
    print(f"\n[{which}] A2. by start slot (mean ₹ per strategy-day, pooled over the set)")
    print(sl.round(0).T.to_string())

    # ---- B. conditional on the hourly state, pooled by type x band -----------------------------------
    raw = pd.read_csv(OUT / "state_raw.csv", dtype={"h": str})
    lab = S.labels(raw).set_index(["index", "h", "day"]).sort_index()
    rows = []
    for h, hm in HOURS.items():
        pend_band = {"B", "C", "D"} if hm < 722 else ({"C", "D"} if hm < 842 else {"D"})
        for var in S.ALL_LABELS:
            for L, und in (("N", "NIFTY"), ("S", "SENSEX")):
                if not (idx == L).any():
                    continue
                try:
                    s = lab.loc[(und, h)][var].reindex(day_s).to_numpy(object)
                except KeyError:
                    continue
                for t in ("wide", "dir", "buy"):
                    for b in sorted(pend_band):
                        cols = np.where((typ == t) & (band == b) & (idx == L) & (start >= hm + 15))[0]
                        if len(cols) < 2:
                            continue
                        dm = Pv[:, cols].mean(axis=1)
                        ok = np.array([x is not None and not (isinstance(x, float) and np.isnan(x)) for x in s])
                        states = sorted(set(s[ok]))
                        if len(states) < 2:
                            continue
                        means = {k: dm[ok & (s == k)] for k in states}
                        means = {k: v for k, v in means.items() if len(v) >= 10}
                        if len(means) < 2:
                            continue
                        best = max(means, key=lambda k: means[k].mean())
                        worst = min(means, key=lambda k: means[k].mean())
                        rows.append(dict(
                            h=h, var=var, index=und, type=t, band=b,
                            states=" | ".join(f"{k}:{v.mean():+.0f}(n{len(v)})" for k, v in means.items()),
                            best=best, worst=worst, spread=means[best].mean() - means[worst].mean(),
                            t=welch(means[best], means[worst]), n_days=int(ok.sum()),
                        ))
    cond = pd.DataFrame(rows)
    cond.to_csv(OUT / f"explore_{which}_cond.csv", index=False)
    print(f"\n[{which}] B. conditional cells: {len(cond)}; |t|>=3: {int((cond.t.abs() >= 3).sum())}; "
          f"|t|>=2: {int((cond.t.abs() >= 2).sum())}")
    pd.set_option("display.width", 250, "display.max_colwidth", 90)
    print(cond[cond.t.abs() >= 3].sort_values("t", ascending=False)[["h", "var", "index", "type", "band", "states", "spread", "t"]].to_string(index=False))

    # ---- C. list A's picks: the oracle stake and how the pending picks compare with their pool ------
    out = subprocess.run([sys.executable, str(HERE.parent / "bl057" / "rotate.py"), "--basket", "DRB-6W3L2",
                          *LIST_A, *SETS[which]], capture_output=True, text=True, cwd=HERE.parent.parent).stdout
    picks = pd.read_csv(Path(re.search(r"picks file: (.*)", out).group(1)), parse_dates=["day"]).set_index("day")
    name_ix = {n: i for i, n in enumerate(names)}
    rows = []
    for h, hm in HOURS.items():
        picked, pool_avg, best_same, pool_all = [], [], [], []
        for d, r in picks.iterrows():
            i = days.get_loc(d)
            core = [name_ix[x] for x in str(r.core_A).split(",") if x in name_ix]
            pend = [v for v in core if start[v] >= hm + 15]
            if not pend:
                continue
            for v in pend:
                same = np.where((typ == typ[v]) & (start >= hm + 15))[0]
                same_un = [u for u in same if u not in core]
                picked.append(Pv[i, v])
                pool_avg.append(Pv[i, same_un].mean())
                best_same.append(Pv[i, same_un].max())
                allp = [u for u in np.where((start >= hm + 15) & (typ != "buy"))[0] if u not in core]
                pool_all.append(Pv[i, allp].mean())
        picked, pool_avg, best_same, pool_all = map(np.array, (picked, pool_avg, best_same, pool_all))
        rows.append(dict(h=h, pending_picks=len(picked), picked_mean=picked.mean(), same_type_pool_mean=pool_avg.mean(),
                         any_type_pool_mean=pool_all.mean(), t_pick_vs_pool=welch(picked, pool_avg),
                         oracle_best_same_type=best_same.mean()))
    orc = pd.DataFrame(rows)
    orc.to_csv(OUT / f"explore_{which}_oracle.csv", index=False)
    print(f"\n[{which}] C. list A's pending picks vs their pool (₹ per strategy-day, 1 lot): is the 09:16 pick already above a random pending strategy?")
    print(orc.round(0).to_string(index=False))


def leads() -> None:
    e = pd.read_csv(OUT / "explore_explore_cond.csv", dtype={"h": str})
    c = pd.read_csv(OUT / "explore_confirm_cond.csv", dtype={"h": str})
    key = ["h", "var", "type", "band"]
    flag = e[(e.t.abs() >= 3) & (e["index"] == "NIFTY")]
    m = flag.merge(c[c["index"] == "NIFTY"], on=key, suffixes=("_x", "_c"))
    m["same_best"] = m.best_x == m.best_c
    m["lead"] = m.same_best & (m.t_c.abs() >= 2)
    pd.set_option("display.width", 250, "display.max_colwidth", 70)
    print("NIFTY cells flagged in exploration (|t|>=3) and what the 2022-24 confirmation set says (same best state and |t|>=2 = lead)")
    print(m[key + ["states_x", "t_x", "states_c", "t_c", "same_best", "lead"]].to_string(index=False))
    print(f"\nflagged {len(flag)} NIFTY cells (SENSEX has no confirmation data); leads: {int(m.lead.sum())}")
    m.to_csv(OUT / "explore_leads.csv", index=False)


if __name__ == "__main__":
    if "--leads" in sys.argv:
        leads()
    else:
        run(sys.argv[sys.argv.index("--set") + 1])
