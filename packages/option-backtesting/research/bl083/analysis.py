"""BL-083: why the triggers helped or not. Mechanism tables behind the Result section.

    uv run --with pandas --with numpy --with duckdb python research/bl083/analysis.py

Reads out/plan.pkl, out/event_rows.csv, results/sims.csv. For each (set, trigger): the index's realised range
and absolute move from the entry minute to 15:28 on event days against the placebo days; for each (trigger,
template): stop-out share and mean worst excursion, event against placebo; concentration of the gain; the
gain by half-year; T1 by level and direction.
"""

from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import pandas as pd

HERE = Path(__file__).parent
sys.path.insert(0, str(HERE.parent / "bl081"))
import state as S  # noqa: E402

S.START = "2020-09-01"
OUT = HERE / "out"


def main() -> None:
    pd.set_option("display.width", 220)
    plan = pd.read_pickle(OUT / "plan.pkl")
    rows = pd.read_csv(OUT / "event_rows.csv", dtype={"entry": str})
    sims = pd.read_csv(HERE / "results" / "sims.csv", dtype={"entry": str})
    sims = sims[~sims.stopped_by.astype(str).str.startswith("ERR")]
    info = {(r.underlying, r.day, r.template, r.entry): (r.net, r.worst_mtm, str(r.stopped_by) not in ("", "nan"))
            for r in sims.itertuples()}
    con = S._con()
    grids = {}
    for und in ("NIFTY", "SENSEX"):
        days, G = S.load_grid(con, und)
        grids[und] = ({d: i for i, d in enumerate(days)}, G)

    def fwd(und, day, entry):
        ix, G = grids[und]
        i = ix.get(day)
        if i is None:
            return None
        j = int(entry[:2]) * 60 + int(entry[3:]) - 555
        o = G["O"][i, j]
        rng = (G["H"][i, j:373].max() - G["L"][i, j:373].min()) / o
        mv = abs(G["C"][i, 373] / o - 1)
        return rng * 100, mv * 100

    rec = []
    for st, und, trig, day, entry, pdays in plan:
        e = fwd(und, day, entry)
        pl = [x for x in (fwd(und, d, entry) for d in pdays) if x]
        if e and len(pl) >= 10:
            rec.append(dict(set=st, trigger=trig, ev_range=e[0], pl_range=np.mean([x[0] for x in pl]),
                            ev_move=e[1], pl_move=np.mean([x[1] for x in pl])))
    f = pd.DataFrame(rec)
    print("=== A. the index after the entry minute: realised range and absolute move to 15:28 (% of spot), event vs placebo")
    t = f.groupby(["set", "trigger"]).agg(n=("ev_range", "size"), range_event=("ev_range", "mean"), range_placebo=("pl_range", "mean"),
                                          move_event=("ev_move", "mean"), move_placebo=("pl_move", "mean")).round(3)
    t["range_ratio"] = (t.range_event / t.range_placebo).round(2)
    print(t.to_string())

    srows = []
    for st, und, trig, day, entry, pdays in plan:
        for tpl in ("wide", "dir", "buy"):
            ev = info.get((und, day, tpl, entry))
            pl = [info[(und, d, tpl, entry)] for d in pdays if (und, d, tpl, entry) in info]
            if ev and len(pl) >= 10:
                srows.append(dict(set=st, trigger=trig, template=tpl, ev_stop=ev[2], pl_stop=np.mean([x[2] for x in pl]),
                                  ev_worst=ev[1], pl_worst=np.mean([x[1] for x in pl])))
    s = pd.DataFrame(srows)
    g = s.groupby(["set", "trigger", "template"]).agg(n=("ev_stop", "size"), stop_event=("ev_stop", "mean"), stop_placebo=("pl_stop", "mean"),
                                                      worst_event=("ev_worst", "mean"), worst_placebo=("pl_worst", "mean")).round(2)
    print("\n=== B. stop-out share (an overall stop-loss fired) and mean worst intraday excursion (₹ per lot), event vs placebo")
    print(g.loc[(slice(None), slice(None), ["dir", "buy", "wide"]), :].to_string())

    print("\n=== C. is the Dir gain broad or a few days? (explore and confirm; diff = event minus placebo, ₹ per lot)")
    for trig in ("T1", "T4"):
        for st in ("explore", "confirm"):
            d = rows[(rows.set == st) & (rows.trigger == trig) & (rows.template == "dir")]["diff"].sort_values(ascending=False)
            tot = d.sum()
            print(f"  {trig} {st}: n={len(d)} mean {d.mean():+.0f} median {d.median():+.0f} | share of events with diff>0 {100 * (d > 0).mean():.0f}% | "
                  f"top 5 events = {100 * d.head(5).sum() / tot:.0f}% of the total gain | mean without top 5: {d.iloc[5:].mean():+.0f}")

    print("\n=== D. the Dir gain by half-year (₹ per lot per event, n)")
    r = rows[(rows.template == "dir") & rows.trigger.isin(["T1", "T4"])].copy()
    r["half"] = r.day.str[:4] + np.where(r.day.str[5:7] <= "06", "H1", "H2")
    print(r.groupby(["trigger", "half"])["diff"].agg(["mean", "size"]).round(0).unstack(0).to_string())

    print("\n=== E. T1 by the level crossed and direction (explore, Dir, both indices)")
    ev = pd.read_csv(OUT / "triggers.csv", dtype={"entry": str})
    m = rows[(rows.set == "explore") & (rows.trigger == "T1") & (rows.template == "dir")].merge(
        ev[(ev.trigger == "T1")][["underlying", "day", "detail"]], on=["underlying", "day"], how="left")
    print(m.groupby("detail")["diff"].agg(["mean", "size"]).round(0).to_string())

    print("\n=== F. entry hour of the lead events (explore) and the Dir diff by hour band")
    r2 = rows[(rows.set == "explore") & (rows.template == "dir") & rows.trigger.isin(["T1", "T4"])].copy()
    r2["band"] = pd.cut(r2.entry.str[:2].astype(int) * 60 + r2.entry.str[3:].astype(int),
                        [630, 690, 750, 810, 900], labels=["10:31-11:30", "11:31-12:30", "12:31-13:30", "13:31-15:00"])
    print(r2.groupby(["trigger", "band"], observed=True)["diff"].agg(["mean", "size"]).round(0).unstack(0).to_string())


if __name__ == "__main__":
    main()
