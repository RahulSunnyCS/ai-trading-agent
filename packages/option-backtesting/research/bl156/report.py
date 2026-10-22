"""BL-156: the registered read-outs of all eight reads and the lead table -> out/report.md, out/reads.csv.

    uv run python research/bl156/report.py
"""

from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent))
from events import GROUP_NAMES  # noqa: E402
from stats import holm, max_drawdown, one_sample_t, shuffle_p, welch_t  # noqa: E402

OUT = Path(__file__).resolve().parent / "out"
NAKED_MARGIN = 140_000
CONDOR_MARGIN = {"condor_otm4": 2 * 150 * 65 * 1.25, "condor_otm6": 2 * 250 * 65 * 1.25}

tests: list[dict] = []
lines: list[str] = []


def split(read: str, label: str, a: pd.Series, b: pd.Series, sign: str) -> None:
    a, b = a.dropna().to_numpy(), b.dropna().to_numpy()
    d = a.mean() - b.mean()
    t = welch_t(a, b)
    p = shuffle_p(a, b)
    lead = abs(t) >= 2 and (sign == "any" or (sign == "+" and d > 0) or (sign == "-" and d < 0))
    tests.append({"read": read, "test": label, "n_a": len(a), "n_b": len(b), "mean_a": a.mean(), "mean_b": b.mean(),
                  "D": d, "t": t, "p": p, "lead": lead})


def alone(read: str, label: str, x: pd.Series, extra: dict | None = None) -> None:
    x = x.dropna().to_numpy()
    t = one_sample_t(x)
    tests.append({"read": read, "test": label, "n_a": len(x), "n_b": 0, "mean_a": x.mean(), "mean_b": np.nan,
                  "D": x.mean(), "t": t, "p": np.nan, "lead": t >= 2, **(extra or {})})


def main() -> int:
    s = pd.read_csv(OUT / "states.csv")
    e = pd.read_csv(OUT / "engine_days.csv")
    o = pd.read_csv(OUT / "overnight.csv")
    piv = e.pivot(index="day", columns="strategy", values="net")
    piv.index = piv.index.astype(str)
    s["day"] = s["day"].astype(str)

    # 1. VRP
    for st in ("wide", "dir"):
        split("1 VRP", f"{st}: high vs low VRP tercile (gross)", s.loc[s.vrp_tercile == "high", f"gross_{st}"],
              s.loc[s.vrp_tercile == "low", f"gross_{st}"], "+")
    mech = s.groupby("vrp_tercile")["straddle_decay_pct"].agg(["mean", "median", "count"]).round(1)
    lines.append("Read 1 mechanism, 09:20 ATM straddle decay to 15:25 (% of its price) by VRP tercile:\n\n" + mech.to_markdown())

    # 2a skew state
    split("2a skew", "wide: high vs low skew tercile (gross)", s.loc[s.skew_1500_tercile == "high", "gross_wide"],
          s.loc[s.skew_1500_tercile == "low", "gross_wide"], "any")
    # 2b engine
    j = s.set_index("day")[["skew_1500_tercile"]].join(piv, how="inner")
    for terc in ("high", "low"):
        g = j[j.skew_1500_tercile == terc]
        for v in ("wide_pe_otm2", "wide_ce_otm2"):
            diff = g[v] - g["wide_sym"]
            t = one_sample_t(diff)  # paired: same days
            tests.append({"read": "2b skew", "test": f"{v} minus symmetric, {terc} skew (net, paired)", "n_a": len(diff),
                          "n_b": 0, "mean_a": g[v].mean(), "mean_b": g["wide_sym"].mean(), "D": diff.mean(), "t": t,
                          "p": np.nan, "lead": v == "wide_pe_otm2" and terc == "high" and t >= 2})

    # 3. PCR
    for st in ("wide", "dir"):
        split("3 PCR", f"{st}: high vs low PCR tercile (gross)", s.loc[s.pcr_tercile == "high", f"gross_{st}"],
              s.loc[s.pcr_tercile == "low", f"gross_{st}"], "any")

    # 4. overnight
    alone("4 overnight", "overnight ATM short straddle, net per night", o["net"],
          {"hit": (o.net > 0).mean(), "worst": o.net.min(), "maxdd": max_drawdown(o.net)})
    by_dte = o.groupby("dte")["net"].agg(["count", "mean", "median", "min"]).round(0)
    by_wd = o.groupby("weekday")["net"].agg(["count", "mean", "median", "min"]).round(0)
    sens = (o.straddle_in - o.straddle_open_next) * 65 - o.charges
    worst = o.nsmallest(5, "net")[["day", "next", "dte", "gap_pct", "net"]]
    lines.append("Read 4 overnight by days to expiry at entry (net ₹ per night):\n\n" + by_dte.to_markdown())
    lines.append("Read 4 by entry weekday:\n\n" + by_wd.to_markdown())
    lines.append(f"Read 4 sensitivity, exit at the 09:15 open instead of 09:24: mean net ₹{sens.mean():.0f} "
                 f"(t {one_sample_t(sens.dropna()):.2f}). Overnight gap: mean {o.gap_pct.mean():+.3f}%, "
                 f"sd {o.gap_pct.std():.2f}%, |gap| > 1% on {(o.gap_pct.abs() > 1).sum()} nights.\n\nWorst five nights:\n\n"
                 + worst.to_markdown(index=False))

    # 5. post-event
    split("5 event", "dir 10:02: RBI days vs other days (gross)", s.loc[s.ev_rbi, "gross_dir1002"],
          s.loc[~s.ev_rbi & ~s.ev_budget & ~s.ev_fed, "gross_dir1002"], "+")
    split("5 event", "dir 09:24: Fed mornings vs other days (gross)", s.loc[s.ev_fed, "gross_dir"],
          s.loc[~s.ev_rbi & ~s.ev_budget & ~s.ev_fed, "gross_dir"], "+")
    bud = s.loc[s.ev_budget, ["day", "gross_wide", "gross_dir", "gross_dir1002"]]
    lines.append("Read 5 budget days (listed, not tested; gross ₹ per lot):\n\n" + bud.to_markdown(index=False))

    # 6. condor
    rows = []
    for v in ("wide_sym", "condor_otm4", "condor_otm6"):
        x = piv[v].dropna()
        m = NAKED_MARGIN if v == "wide_sym" else CONDOR_MARGIN[v]
        rows.append({"strategy": v, "days": len(x), "mean_net": x.mean(), "t": one_sample_t(x), "hit": (x > 0).mean(),
                     "maxdd": max_drawdown(x), "margin": m, "net_per_day_on_margin_%": x.mean() / m * 100,
                     "maxdd_on_margin_%": max_drawdown(x) / m * 100, "two_year_net_on_margin_%": x.sum() / m * 100})
    cdf = pd.DataFrame(rows)
    naked = cdf.loc[cdf.strategy == "wide_sym", "net_per_day_on_margin_%"].iloc[0]
    for _, r in cdf[cdf.strategy != "wide_sym"].iterrows():
        tests.append({"read": "6 condor", "test": f"{r.strategy}: net, and return on margin vs naked", "n_a": r.days, "n_b": 0,
                      "mean_a": r.mean_net, "mean_b": piv["wide_sym"].mean(), "D": r.mean_net, "t": r.t, "p": np.nan,
                      "lead": r["net_per_day_on_margin_%"] >= 1.5 * naked and r.t >= 2})
    lines.append("Read 6 condor vs naked Widesl (net after charges; margin ASSUMED, see the item):\n\n" + cdf.round(3).to_markdown(index=False))

    # 7. ratio spreads
    rows = []
    for v in ("dir_base", "ratio_otm2", "ratio_otm3"):
        x = piv[v].dropna()
        rows.append({"strategy": v, "days": len(x), "mean_net": x.mean(), "t": one_sample_t(x), "hit": (x > 0).mean(),
                     "worst": x.min(), "maxdd": max_drawdown(x), "total": x.sum()})
        if v != "dir_base":
            alone("7 ratio", f"{v}: net per day", x)
    lines.append("Read 7 ratio spreads vs the base Dir (net after charges, one lot):\n\n" + pd.DataFrame(rows).round(2).to_markdown(index=False))

    # 8. skip calendar
    for g in GROUP_NAMES:
        for st in ("wide", "dir"):
            split("8 calendar", f"{st}: {g} vs rest (gross)", s.loc[s[f"grp_{g}"], f"gross_{st}"],
                  s.loc[~s[f"grp_{g}"], f"gross_{st}"], "-")
    # read 8's lead needs both strategies at D <= -500, t <= -2
    for g in GROUP_NAMES:
        both = [t for t in tests if t["read"] == "8 calendar" and t["test"].split(": ")[1].startswith(g + " ")]
        ok = all(t["D"] <= -500 and t["t"] <= -2 for t in both)
        for t in both:
            t["lead"] = ok

    df = pd.DataFrame(tests)
    df["p_holm"] = holm([p if p == p else np.nan for p in df["p"]])
    df.to_csv(OUT / "reads.csv", index=False)
    show = df[["read", "test", "n_a", "n_b", "mean_a", "mean_b", "D", "t", "p", "p_holm", "lead"]].round(
        {"mean_a": 0, "mean_b": 0, "D": 0, "t": 2, "p": 4, "p_holm": 3})
    text = "# BL-156 read-outs\n\n" + show.to_markdown(index=False) + "\n\n" + "\n\n".join(lines) + "\n"
    (OUT / "report.md").write_text(text)
    print(text)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
