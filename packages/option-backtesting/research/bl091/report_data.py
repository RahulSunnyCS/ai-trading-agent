"""BL-091 Phase 1: the numbers behind the owner's report (descriptive cuts on P2 + P3 only)."""

import json
import sys
from datetime import date
from pathlib import Path

import pandas as pd

HERE = Path("research/bl091")
sys.path.insert(0, str(HERE))
from series import level, load_chain_day, rolling_straddle, splice

e = pd.read_csv(HERE / "out/episodes.csv")
d = pd.read_csv(HERE / "out/days.csv")
a = pd.read_csv(HERE / "results/r0_attempts.csv")
a = a[a.outcome != "ERR"]
G = ["period", "underlying"]
lab = {
    ("P2", "NIFTY"): "NIFTY 2025",
    ("P2", "SENSEX"): "SENSEX 2025",
    ("P3", "NIFTY"): "NIFTY 2022–24",
}
out = {}
dl = d[d.status == "loaded"]
out["coverage"] = [
    {
        "g": lab[k],
        "days": int(len(x)),
        "eps": int(len(e[(e.period == k[0]) & (e.underlying == k[1])])),
        "days_with": int((x.n_episodes > 0).sum()),
        "switches": float(x.n_switches.median()),
        "level": float(x.level_change.median()),
        "spliced": float(x.spliced_change.median()),
    }
    for k, x in dl.groupby(G)
]
# NIFTY thresholds
th = {}
for per in ("P2", "P3"):
    dd = dl[(dl.period == per) & (dl.underlying == "NIFTY")]
    mx = e[(e.period == per) & (e.underlying == "NIFTY")].groupby("day").rise.max()
    th[per] = {str(t): int((mx >= t).sum()) for t in (25, 40, 60, 100)} | {"days": int(len(dd))}
out["thresholds"] = th
# monthly NIFTY: share of loaded days with a 25-40 rise and with >=40
n = e[e.underlying == "NIFTY"].copy()
n["m"] = n.day.str[:7]
dn = dl[dl.underlying == "NIFTY"].copy()
dn["m"] = dn.day.str[:7]
mx = n.groupby("day").rise.max()
dn["mx"] = dn.day.map(mx)
mon = (
    dn.groupby("m")
    .agg(
        days=("day", "size"),
        r25=("mx", lambda s: int(((s >= 25) & (s < 40)).sum())),
        r40=("mx", lambda s: int((s >= 40).sum())),
    )
    .reset_index()
)
out["monthly"] = mon.to_dict("records")
# rise histogram NIFTY (all) and SENSEX
bins = list(range(25, 105, 5)) + [1e9]


def hist(x):
    c = pd.cut(x, bins, right=False).value_counts(sort=False)
    return [int(v) for v in c]


out["rise_hist"] = {
    "labels": [f"{b}" for b in bins[:-2]] + ["100+"],
    "nifty25": hist(n[n.period == "P2"].rise),
    "nifty24": hist(n[n.period == "P3"].rise),
    "sensex": hist(e[e.underlying == "SENSEX"].rise),
}
# trigger hour share & expiry share
th2 = {}
for k, x in e.groupby(G):
    h = x.trigger_hour.astype(int).value_counts().reindex(range(9, 16), fill_value=0)
    th2[lab[k]] = {
        "hours": [int(v) for v in h],
        "expiry": int((x.dte == 0).sum()),
        "n": int(len(x)),
    }
out["trigger_hours"] = th2
# decay timing (high half-hour) decayed episodes, share at/after 14:30
dec = e[e.outcome == "decayed"].copy()
dec["hh"] = (dec.high_min + 555) // 30 * 30
hh = {}
for k, x in dec.groupby(G):
    c = x.hh.value_counts().reindex(range(540, 931, 30), fill_value=0)
    hh[lab[k]] = [int(v) for v in c]
out["high_halfhour"] = {
    "labels": [f"{t // 60:02d}:{t % 60:02d}" for t in range(540, 931, 30)],
    "series": hh,
}
# outcome & path
out["outcome"] = {lab[k]: x.outcome.value_counts().to_dict() for k, x in e.groupby(G)}
out["path"] = {
    lab[k]: x[x.outcome == "decayed"].spot_path.value_counts().to_dict() for k, x in e.groupby(G)
}
# R0
key = G + ["day", "episode_idx"]
per_ep = (
    a.sort_values(key + ["attempt"])
    .groupby(key)
    .agg(
        attempts=("attempt", "max"),
        held=("outcome", lambda s: int((s == "HELD").any())),
        net0=("net0", "sum"),
        net20=("net20", "sum"),
        first_entry=("entry_min", "min"),
        last_exit=("exit_min", "max"),
    )
    .reset_index()
)
per_ep = per_ep.sort_values(key)
prev = per_ep.groupby(G + ["day"]).last_exit.transform(lambda s: s.cummax().shift())
per_ep["clean"] = ~(per_ep.first_entry <= prev)
per_ep = per_ep.merge(e[key + ["dte", "trigger_min", "rise"]], on=key, how="left")
r = {}
for k, x in a.groupby(G):
    by = x.groupby("attempt").outcome.agg(n="size", held=lambda s: int((s == "HELD").sum()))
    pe = per_ep[(per_ep.period == k[0]) & (per_ep.underlying == k[1])]
    c = pe[pe.clean]
    r[lab[k]] = {
        "held_rate": [round(h / nn, 3) for nn, h in zip(by.n, by.held)],
        "attempts_n": [int(v) for v in by.n],
        "attempt_dist": [
            int(v) for v in pe.attempts.value_counts().reindex(range(1, 6), fill_value=0)
        ],
        "stop_mean": round(float(x[x.outcome == "OVERALL_SL"].net0.mean()), 0),
        "held_mean": round(float(x[x.outcome == "HELD"].net0.mean()), 0),
        "held_median": round(float(x[x.outcome == "HELD"].net0.median()), 0),
        "clean_n": int(len(c)),
        "clean_mean": round(float(c.net0.mean()), 0),
        "clean_median": round(float(c.net0.median()), 0),
        "clean_mean20": round(float(c.net20.mean()), 0),
        "clean_pos": int((c.net0 > 0).sum()),
        "all_n": int(len(pe)),
        "no_held": int((pe.held == 0).sum()),
        "by_attempts_mean": [
            round(float(c[c.attempts == i].net0.mean()), 0) if (c.attempts == i).any() else None
            for i in range(1, 6)
        ],
        "by_attempts_n": [int((c.attempts == i).sum()) for i in range(1, 6)],
        "expiry_mean": round(float(c[c.dte == 0].net0.mean()), 0),
        "expiry_n": int((c.dte == 0).sum()),
        "nonexp_mean": round(float(c[c.dte > 0].net0.mean()), 0),
        "nonexp_n": int((c.dte > 0).sum()),
        "band": {
            bl: {"n": int(len(z)), "mean": round(float(z.net0.mean()), 0) if len(z) else None}
            for bl, z in (
                ("09:20–11:00", c[c.trigger_min < 105]),
                ("11:00–13:00", c[(c.trigger_min >= 105) & (c.trigger_min < 225)]),
                ("13:00–15:12", c[c.trigger_min >= 225]),
            )
        },
        "hist": [
            int(v)
            for v in pd.cut(
                c.net0, [-1e9, -3000, -2000, -1000, 0, 1000, 2000, 3000, 1e9], right=False
            ).value_counts(sort=False)
        ],
    }
out["r0"] = r
# example: SENSEX 2025-01-10 level vs spliced
root = Path("/Volumes/TradingData")
ch = load_chain_day(root, "SENSEX", date(2025, 1, 10))
ro = rolling_straddle(ch)
lv = level(ro)
sp = splice(ro, ch)
out["drift_example"] = {
    "level": [round(v, 2) for v in lv.x[5:374]],
    "spliced": [round(lv.x[5] + v, 2) for v in sp.x[5:374]],
}
# example NIFTY day: an episode with >=4 attempts that held
cand = per_ep[
    (per_ep.period == "P2")
    & (per_ep.underlying == "NIFTY")
    & (per_ep.attempts >= 4)
    & (per_ep.held == 1)
    & (per_ep.clean)
].sort_values("net0", ascending=False)
ex = cand.iloc[0]
ch = load_chain_day(root, "NIFTY", date.fromisoformat(ex.day))
ro = rolling_straddle(ch)
lv = level(ro)
ea = a[
    (a.period == "P2")
    & (a.underlying == "NIFTY")
    & (a.day == ex.day)
    & (a.episode_idx == ex.episode_idx)
]
ee = e[(e.period == "P2") & (e.underlying == "NIFTY") & (e.day == ex.day)]
out["example_day"] = {
    "day": ex.day,
    "dte": int(ex.dte),
    "series": [round(v, 2) for v in lv.x[5:374]],
    "spot": [round(v, 2) if v else None for v in ch.spot[5:374]],
    "episodes": ee[
        ["episode_idx", "start_min", "trigger_min", "high_min", "decay_min", "rise", "outcome"]
    ]
    .fillna(-1)
    .to_dict("records"),
    "attempts": ea[["attempt", "entry_min", "exit_min", "outcome", "net0"]].to_dict("records"),
    "net": round(float(ex.net0), 0),
}
json.dump(out, open(str(HERE / "out" / "report_data.json"), "w"), default=float)
print(
    json.dumps(
        {k: v for k, v in out.items() if k not in ("drift_example", "example_day", "monthly")},
        default=float,
    )[:6000]
)
print(out["example_day"]["day"], out["example_day"]["attempts"], out["example_day"]["episodes"])
print(out["monthly"][:3], len(out["monthly"]))
