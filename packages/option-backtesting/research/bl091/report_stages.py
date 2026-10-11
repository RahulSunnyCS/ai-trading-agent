"""BL-091: numbers behind the owner's Stage 1 / Stage 2 report (P2 + P3 only), to out/report_stages.json."""

from __future__ import annotations

import json
import math
from pathlib import Path

import numpy as np
import pandas as pd

HERE = Path(__file__).parent
OUT = HERE / "out"
LAB = {
    ("P2", "NIFTY"): "NIFTY 2025",
    ("P3", "NIFTY"): "NIFTY 2022–24",
    ("P2", "SENSEX"): "SENSEX 2025",
}
GROUPS = ["NIFTY 2025", "NIFTY 2022–24", "SENSEX 2025"]


def tstat(v: pd.Series) -> float:
    v = v.dropna()
    return (
        float("nan")
        if len(v) < 3 or v.std(ddof=1) == 0
        else float(v.mean() / (v.std(ddof=1) / math.sqrt(len(v))))
    )


def clean(x):
    if isinstance(x, float) and (math.isnan(x) or math.isinf(x)):
        return None
    if isinstance(x, (np.floating,)):
        return clean(float(x))
    if isinstance(x, (np.integer,)):
        return int(x)
    return x


def summary(df: pd.DataFrame, by: list[str]) -> list[dict]:
    g = df.groupby(by)
    out = g.agg(n=("net0", "size"), ev=("net0", "mean"), pl=("pl_net0", "mean"), diff=("diff0", "mean"),
                held=("held", "mean"), att=("attempts", "mean"), worst=("net0", "min"),
                med=("net0", "median"), win=("net0", lambda s: (s > 0).mean()), ev20=("net20", "mean")).reset_index()  # fmt: skip
    out["t"] = g.diff0.apply(tstat).to_numpy()
    return [{k: clean(v) for k, v in r.items()} for r in out.to_dict("records")]


def main() -> None:
    res: dict = {}
    s = pd.read_csv(OUT / "sustained.csv")
    d = pd.read_csv(OUT / "days.csv")
    d = d[d.status == "loaded"]
    h = s[s.held_min.notna()].merge(
        d[["period", "underlying", "day", "vix_open"]], on=["period", "underlying", "day"]
    )
    res["held"] = [{"g": LAB[(p, u)], "days": int(len(d[(d.period == p) & (d.underlying == u)])),
                    "spikes": int(len(s[(s.period == p) & (s.underlying == u)])),
                    "held": int(len(x)), "held_days": int(x.day.nunique()), "expiry": int((x.dte == 0).sum())}
                   for (p, u), x in h.groupby(["period", "underlying"])]  # fmt: skip
    # Stage 1a
    t = pd.read_csv(OUT / "stage1_events.csv")
    t["g"] = [LAB[(p, u)] for p, u in zip(t.period, t.underlying, strict=True)]
    prim = t[t.first_of_day]
    res["s1_counts"] = {g: int(prim[(prim.g == g)].event_day.nunique()) for g in GROUPS}
    res["s1_arms"] = summary(prim, ["g", "arm"])
    res["s1_all_spikes"] = []
    for g, x in t.groupby("g"):
        dm = x.groupby(["event_day", "arm"]).diff0.mean().reset_index()
        for arm, y in dm.groupby("arm"):
            res["s1_all_spikes"].append(
                {
                    "g": g,
                    "arm": arm,
                    "days": int(len(y)),
                    "diff": clean(y.diff0.mean()),
                    "t": clean(tstat(y.diff0)),
                }
            )
    res["s1_expiry"] = summary(prim.assign(expiry=prim.dte == 0), ["g", "expiry", "arm"])
    res["s1_cat2"] = summary(prim, ["g", "regime2", "cat2", "arm"])
    res["s1_cat3"] = summary(prim, ["g", "regime3", "cat3", "arm"])
    # Stage 1b
    e = pd.read_csv(OUT / "stage1b_entries.csv")
    b = pd.read_csv(OUT / "stage1b_events.csv")
    b["g"] = [LAB[(p, u)] for p, u in zip(b.period, b.underlying, strict=True)]
    bp = b[b.first_of_day]
    ef = e[e.first_of_day].copy()
    ef["g"] = [LAB[(p, u)] for p, u in zip(ef.period, ef.underlying, strict=True)]
    res["s1b_fire"] = [{"g": g, "events": int(len(x)), "rej": int(x.rej_min.notna().sum()), "brk": int(x.brk_min.notna().sum()),
                        "rej_delay": clean((x.rej_min - x.entry_min).median()), "brk_delay": clean((x.brk_min - x.entry_min).median()),
                        "levels": clean(x.n_levels.median()), "touches": clean(x.touches.median())}
                       for g, x in ef.groupby("g")]  # fmt: skip
    g = bp.groupby(["g", "kind", "arm"])
    tab = g.agg(n=("net0", "size"), ev=("net0", "mean"), pl=("pl_net0", "mean"), diff=("diff0", "mean"),
                held=("held", "mean"), ev20=("net20", "mean")).reset_index()  # fmt: skip
    tab["t"] = g.diff0.apply(tstat).to_numpy()
    res["s1b_arms"] = [{k: clean(v) for k, v in r.items()} for r in tab.to_dict("records")]
    bp = bp.merge(ef[["period", "underlying", "event_day", "episode_idx", "rej_level", "brk_level"]],
                  on=["period", "underlying", "event_day", "episode_idx"])  # fmt: skip
    bp["level"] = [
        (r if k == "rej" else br)
        for k, r, br in zip(bp.kind, bp.rej_level, bp.brk_level, strict=True)
    ]
    bp["family"] = bp.level.fillna("").str.replace(
        r"_(P|R1|R2|S1|S2|high|low|above|below|up|down|call|put)$", "", regex=True
    )
    fam = (
        bp[bp.arm == "D1_21"]
        .groupby(["kind", "family"])
        .agg(n=("net0", "size"), ev=("net0", "mean"), diff=("diff0", "mean"))
        .reset_index()
    )
    res["s1b_family"] = [{k: clean(v) for k, v in r.items()} for r in fam.to_dict("records")]
    # Stage 2 (if built)
    if (OUT / "stage2_candidates.csv").exists() and (OUT / "stage2_auc.csv").exists():
        c = pd.read_csv(OUT / "stage2_candidates.csv")
        c["g"] = [LAB[(p, u)] for p, u in zip(c.period, c.underlying, strict=True)]
        res["s2_labels"] = [{"g": g, "candidates": int(len(x)), "spikes": int(x.groupby(["day", "episode_idx"]).ngroups),
                             "true": clean(x.true_top.mean()), "a": clean(x.label_a.mean()), "b": clean(x.label_b.mean()),
                             "per_spike": clean(len(x) / x.groupby(["day", "episode_idx"]).ngroups)}
                            for g, x in c.groupby("g")]  # fmt: skip
        a = pd.read_csv(OUT / "stage2_auc.csv")
        res["s2_auc"] = [{k: clean(v) for k, v in r.items()} for r in a.to_dict("records")]
        # true-top share by candidate order (1st new high, 2nd, ...)
        c["order"] = c.groupby(["period", "underlying", "day", "episode_idx"]).cumcount() + 1
        c["ob"] = c.order.clip(upper=10)
        res["s2_by_order"] = [{"g": g, "order": int(o), "n": int(len(y)), "true": clean(y.true_top.mean())}
                              for (g, o), y in c.groupby(["g", "ob"])]  # fmt: skip
        if (OUT / "stage2_r1.json").exists():
            res["s2_r1"] = json.loads((OUT / "stage2_r1.json").read_text())
    (OUT / "report_stages.json").write_text(json.dumps(res, default=clean))
    print("wrote", OUT / "report_stages.json")


if __name__ == "__main__":
    main()
