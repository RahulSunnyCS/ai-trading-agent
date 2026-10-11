"""BL-083 phase 2: the override rule for the leads (owner's decision: the last two years decide).

    uv run --with pandas --with numpy --with duckdb python research/bl083/override.py [workers]

Leads: T1 -> Dir and T4 -> Dir. On an event day the earliest lead trigger (either index) fires a Dir on its
own index at the trigger entry minute and replaces the next not-yet-started core pick of the list (start >=
entry + 15 min), lots conserved (2 lots), skipped if the Widesl minimum would break or no pick is pending.
Controls: (a) random time = the same Dir on the same day and index at a random minute 10:31..14:00 (200 draws);
(b) random day = the same entry minute on a random non-event day of the set, replacing THAT day's own next
pending pick (200 draws).
Needs out/ck/prep_<set>_<list>.npz from `research/bl081/ck_prepare.py <set> <list>` for the four lists. Explore set decides,
confirmation (NIFTY 2022-24) is information. Writes out/override_<set>.csv.
"""

from __future__ import annotations

import csv
import sys
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

import numpy as np
import pandas as pd

HERE = Path(__file__).parent
CK = HERE.parent / "bl081" / "out" / "ck"  # prep_<set>_<list>.npz from research/bl081/ck_prepare.py
CLOSEST = {"p80", "p100", "p250", "p320", "p40", "p60", "p120", "p200"}
OUT = HERE / "out"
RES = HERE / "results" / "sims.csv"
sys.path.insert(0, str(HERE))
import simulate as SIM  # noqa: E402

LEADS = ("T1", "T4")
LISTS = ("A", "B", "C", "REF")
LOTS = 2
N_DRAWS = 200


class Env:
    """One (set, list): the list's daily picks, the results matrix and the plain daily P&L."""

    def __init__(self, st: str, lst: str):
        z = np.load(CK / f"prep_{st}_{lst}.npz")
        self.names = [str(n) for n in z["names"]]
        self.days = [str(d) for d in z["days"]]
        self.Pv, self.sel, self.core, self.buy = z["Pv"], z["sel"], z["core"], z["buy"]
        fam = [n.split("_")[1] for n in self.names]
        self.start = np.array([int(n.split("_")[2][:2]) * 60 + int(n.split("_")[2][2:]) for n in self.names])
        self.is_wide = np.array([f == "wide" or f in CLOSEST for f in fam])
        self.plain = np.array([LOTS * (self.Pv[i, c].sum() + (self.Pv[i, b] if b >= 0 else 0.0))
                               for i, c, b in zip(self.sel, self.core, self.buy, strict=True)])


def mm(hhmm: str) -> int:
    return int(hhmm[:2]) * 60 + int(hhmm[3:])


def load_sims() -> dict:
    s = pd.read_csv(RES, dtype={"entry": str})
    s = s[~s.stopped_by.astype(str).str.startswith("ERR")]
    return {(r.underlying, r.day, r.template, r.entry): r.net for r in s.itertuples()}


def overrides(env, ev: pd.DataFrame):
    """Per selection day: (underlying, entry, stamp) of the earliest lead event, or None."""
    by_day = {}
    for r in ev.itertuples():
        cur = by_day.get(r.day)
        if cur is None or r.stamp < cur[2]:
            by_day[r.day] = (r.underlying, r.entry, r.stamp)
    return by_day


def basket(env, k, und, entry, ov_net):
    """P&L of the day with the override, or None when it cannot be applied."""
    i = env.sel[k]
    core = [int(v) for v in env.core[k]]
    pend = [v for v in core if env.start[v] >= mm(entry) + 15]
    if not pend:
        return None
    out = min(pend, key=lambda v: env.start[v])
    rest = [v for v in core if v != out]
    wide = sum(env.is_wide[v] for v in rest)
    if wide < 2:  # the Dir is not Widesl; the minimum must hold without the replaced pick
        return None
    return env.plain[k] - LOTS * env.Pv[i, out] + LOTS * ov_net, LOTS * env.Pv[i, out]


def mdd(s):
    eq = np.cumsum(s)
    return float((eq - np.maximum.accumulate(np.maximum(eq, 0))).min())


def main() -> None:
    workers = int(sys.argv[1]) if len(sys.argv) > 1 else 4
    trig = pd.read_csv(OUT / "triggers.csv", dtype={"entry": str})
    trig = trig[trig.trigger.isin(LEADS)]
    rng = np.random.default_rng(83)
    plan_tasks: dict[tuple, set] = {}
    prepared = {}
    for st in ("explore", "confirm"):
        ev_all = trig[trig.set == st]
        for lst in LISTS:
            env = Env(st, lst)
            by_day = overrides(env, ev_all)
            days = [env.days[i] for i in env.sel]
            nonev = [d for d in days if d not in {r.day for r in ev_all.itertuples()}]
            rows = []
            for k, d in enumerate(days):
                if d not in by_day:
                    continue
                und, entry, stamp = by_day[d]
                rt = [f"{(555 + int(m)) // 60:02d}:{(555 + int(m)) % 60:02d}" for m in rng.integers(76, 286, N_DRAWS)]
                rd = list(rng.choice(nonev, N_DRAWS)) if nonev else []
                rows.append((k, d, und, entry, rt, rd))
                plan_tasks.setdefault((und, d), set()).add(("dir", entry))
                for e in rt:
                    plan_tasks.setdefault((und, d), set()).add(("dir", e))
                for d2 in rd:
                    plan_tasks.setdefault((und, d2), set()).add(("dir", entry))
            prepared[(st, lst)] = (env, rows)
    done = set(load_sims())
    tasks = [(u, d, sorted(k for k in ks if (u, d, k[0], k[1]) not in done)) for (u, d), ks in plan_tasks.items()]
    tasks = [t for t in tasks if t[2]]
    print(f"{sum(len(t[2]) for t in tasks)} simulations to run over {len(tasks)} index-days", flush=True)
    with open(RES, "a", newline="") as f, ProcessPoolExecutor(workers) as pool:
        w = csv.writer(f)
        for rows in pool.map(SIM.work, tasks, chunksize=4):
            w.writerows(rows)
    sims = load_sims()
    out = []
    for (st, lst), (env, rows) in prepared.items():
        n_ok, ov_sum, rep_sum = 0, 0.0, 0.0
        day_ix = {env.days[i]: k for k, i in enumerate(env.sel)}
        pnl = env.plain.copy()
        rt_tot = np.zeros(N_DRAWS)
        rd_tot = np.zeros(N_DRAWS)
        for k, d, und, entry, rt, rd in rows:
            net = sims.get((und, d, "dir", entry))
            b = basket(env, k, und, entry, net) if net is not None else None
            if b is None:
                continue
            n_ok += 1
            pnl[k] = b[0]
            ov_sum += LOTS * net
            rep_sum += b[1]
            for j in range(N_DRAWS):
                x = sims.get((und, d, "dir", rt[j]))
                bb = basket(env, k, und, rt[j], x) if x is not None else None
                rt_tot[j] += (bb[0] - env.plain[k]) if bb else 0.0
                if rd:
                    k2 = day_ix[rd[j]]  # the random day's own picks: its own next pending pick is replaced
                    x2 = sims.get((und, rd[j], "dir", entry))
                    bb2 = basket(env, k2, und, entry, x2) if x2 is not None else None
                    rd_tot[j] += (bb2[0] - env.plain[k2]) if bb2 else 0.0
        gain = pnl.sum() - env.plain.sum()
        out.append(dict(set=st, list=lst, events=len(rows), applied=n_ok, plain=env.plain.sum(), gross=pnl.sum(),
                        gain=gain, dd=mdd(pnl), plain_dd=mdd(env.plain), override_pnl=ov_sum, replaced_pnl=rep_sum,
                        rand_time_p90=float(np.percentile(rt_tot, 90)), rand_time_p50=float(np.percentile(rt_tot, 50)),
                        rand_day_p90=float(np.percentile(rd_tot, 90)), rand_day_p50=float(np.percentile(rd_tot, 50)),
                        win_plain=100 * (env.plain > 0).mean(), win=100 * (pnl > 0).mean()))
    t = pd.DataFrame(out)
    t["above_controls"] = (t.gain > t.rand_time_p90) & (t.gain > t.rand_day_p90)
    t.to_csv(OUT / "override.csv", index=False)
    pd.set_option("display.width", 250)
    print(t.round(0).to_string(index=False))


if __name__ == "__main__":
    main()
