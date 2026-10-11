"""BL-083 phase 1: the event study. Event P&L minus the time-matched placebo, per trigger x template x set.

    uv run --with pandas --with numpy python research/bl083/event_study.py

Read-out registered in backlog/BL-083-event-triggered-intraday-entries.md: a (trigger, template) is a lead if
the event-minus-placebo difference has |t| >= 3 in the exploration set and the same sign with |t| >= 2 in
the confirmation set (NIFTY 2022-24). t = mean of the per-day mean differences / its standard error (day-clustered).
"""

from __future__ import annotations

from pathlib import Path

import numpy as np
import pandas as pd

HERE = Path(__file__).parent
OUT = HERE / "out"


def main() -> None:
    plan = pd.read_pickle(OUT / "plan.pkl")
    ev = pd.read_csv(OUT / "triggers.csv", dtype={"entry": str}).set_index(["set", "underlying", "trigger", "day"])
    sims = pd.read_csv(HERE / "results" / "sims.csv", dtype={"entry": str})
    sims = sims[~sims.stopped_by.astype(str).str.startswith("ERR")]
    net = {(r.underlying, r.day, r.template, r.entry): r.net for r in sims.itertuples()}
    rows = []
    for st, und, trig, day, entry, pdays in plan:
        meta = ev.loc[(st, und, trig, day)]
        for t in ("wide", "dir", "buy"):
            e = net.get((und, day, t, entry))
            pl = [net[(und, d, t, entry)] for d in pdays if (und, d, t, entry) in net]
            if e is None or len(pl) < 10:
                continue
            rows.append(dict(set=st, underlying=und, trigger=trig, template=t, day=day, entry=entry,
                             event=e, placebo=float(np.mean(pl)), diff=e - float(np.mean(pl)),
                             expiry_day=bool(meta.expiry_day), fwd_spot=meta.fwd_spot, fwd_straddle=meta.fwd_straddle))
    d = pd.DataFrame(rows)
    d.to_csv(OUT / "event_rows.csv", index=False)

    def agg(g):
        n = len(g)
        dm = g.groupby("day")["diff"].mean()  # one observation per day: same-day events share their market
        sd = dm.std(ddof=1)
        return pd.Series(dict(n=n, days=len(dm), event=g.event.mean(), placebo=g.placebo.mean(), diff=g["diff"].mean(),
                              t=dm.mean() / (sd / np.sqrt(len(dm))) if len(dm) > 4 and sd > 0 else np.nan,
                              win_event=100 * (g.event > 0).mean(), win_placebo=100 * (g.placebo > 0).mean()))

    pd.set_option("display.width", 220)
    keys = ["set", "trigger", "template"]
    allr = d.groupby(keys).apply(agg, include_groups=False).reset_index()
    nif = d[(d.underlying == "NIFTY")].groupby(keys).apply(agg, include_groups=False).reset_index()
    print("=== event study: mean ₹ per lot, event vs time-matched placebo (explore = both indices; confirm = NIFTY 2022-24)")
    print(allr.round(1).to_string(index=False))
    print("\n=== NIFTY only (comparable with confirm)")
    print(nif.round(1).to_string(index=False))
    # leads
    ex = allr[allr.set == "explore"].set_index(["trigger", "template"])
    exn = nif[nif.set == "explore"].set_index(["trigger", "template"])
    cf = nif[nif.set == "confirm"].set_index(["trigger", "template"])
    lead = pd.DataFrame({"n_ex": ex.n, "diff_ex": ex["diff"], "t_ex": ex.t, "t_ex_nifty": exn.t,
                         "n_cf": cf.n, "diff_cf": cf["diff"], "t_cf": cf.t})
    lead["lead"] = (lead.t_ex.abs() >= 3) & (np.sign(lead.t_ex) == np.sign(lead.t_cf)) & (lead.t_cf.abs() >= 2)
    print("\n=== leads (|t_ex| >= 3, same sign, |t_cf| >= 2)")
    print(lead.round(2).to_string())
    lead.to_csv(OUT / "event_leads.csv")
    # expiry-day split and what the trigger catches
    print("\n=== expiry days vs other days (explore, both indices; diff = event - placebo, ₹ per lot)")
    ep = d[d.set == "explore"].groupby(["trigger", "template", "expiry_day"]).apply(agg, include_groups=False).reset_index()
    print(ep[["trigger", "template", "expiry_day", "n", "diff", "t"]].round(1).to_string(index=False))
    print("\n=== what each trigger catches (explore events): mean forward spot move to 15:28 and ATM straddle change")
    c = d[(d.set == "explore") & (d.template == "wide")].groupby("trigger").agg(
        n=("day", "size"), mean_abs_fwd_spot=("fwd_spot", lambda s: s.abs().mean() * 100),
        mean_fwd_spot=("fwd_spot", lambda s: s.mean() * 100), mean_fwd_straddle=("fwd_straddle", lambda s: s.mean() * 100))
    print(c.round(2).to_string())


if __name__ == "__main__":
    main()
