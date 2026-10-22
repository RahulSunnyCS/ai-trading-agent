"""BL-155 step 1: on the heatmap's short ATM straddles (exit 15:15, entries 11:15 .. 14:45), does the
morning-type stop (quiet 100 %, normal 80 %, wide 60 %) beat fixed 60 / 80 / 100 % and the reversed
rule after charges, and shuffled day labels? Rules: backlog/BL-155-stop-by-morning-type.md, Phase 0.

    TRADING_DATA_ROOT=/Volumes/TradingData uv run --with pandas --with pyarrow python research/bl155/step1_heatmap.py

Read-only; writes out/step1_result.json and out/step1_days.csv.
"""

from __future__ import annotations

import json
import sys
from datetime import date
from pathlib import Path

import numpy as np
import pandas as pd

from option_backtesting.data.reference.loader import default_reference_data
from option_backtesting.heatmap.store import path_for

sys.path.insert(0, str(Path(__file__).parent))
import morning as M  # noqa: E402

OUT = Path(__file__).parent / "out"
ENTRIES = ["11:15", "11:45", "12:15", "12:45", "13:15", "13:45", "14:15", "14:45"]
EXIT = "15:15"
SLS = (60, 80, 100)
POLICIES = {
    "rule": {"quiet": 100, "normal": 80, "wide": 60},
    "reversed": {"quiet": 60, "normal": 80, "wide": 100},
    "fixed_60": dict.fromkeys(("quiet", "normal", "wide"), 60),
    "fixed_80": dict.fromkeys(("quiet", "normal", "wide"), 80),
    "fixed_100": dict.fromkeys(("quiet", "normal", "wide"), 100),
}
COMPARATORS = ("reversed", "fixed_60", "fixed_80", "fixed_100")
PERIODS = {
    "decide": ("NIFTY", "2025-01-01", "2026-10-21"),
    "report_nifty_2022_24": ("NIFTY", "2022-01-03", "2024-12-31"),
    "report_sensex": ("SENSEX", "2024-10-01", "2026-10-21"),
}
BLOCK, RESAMPLES, SHUFFLES, SEED = 5, 2000, 1000, 20261022


def day_values(index: str) -> tuple[pd.DataFrame, pd.DataFrame]:
    """(net, gross): day x SL, the mean over the 8 entries of ₹ per lot. Days missing an entry are
    dropped."""
    hm = pd.read_parquet(path_for(index))
    hm = hm[(hm.exit == EXIT) & hm.time.isin(ENTRIES) & hm.sl.isin(SLS)].copy()
    lot = default_reference_data().lot_size(index, date.today())  # the heatmap's own convention
    hm["day"] = hm.day.astype(str)
    gross = (hm.ce_pts + hm.pe_pts) * lot
    charges = [
        M.short_leg_charges(index, d, lot, ce, ce - cp)
        + M.short_leg_charges(index, d, lot, pe, pe - pp)
        for d, ce, cp, pe, pp in zip(
            hm.day, hm.ce_entry, hm.ce_pts, hm.pe_entry, hm.pe_pts, strict=True
        )
    ]
    hm["net"] = gross - np.array(charges)
    hm["gross"] = gross
    full = hm.groupby(["day", "sl"]).time.nunique()
    keep = full[full == len(ENTRIES)].reset_index()[["day", "sl"]]
    hm = hm.merge(keep, on=["day", "sl"])
    net = hm.pivot_table(index="day", columns="sl", values="net", aggfunc="mean")
    gross = hm.pivot_table(index="day", columns="sl", values="gross", aggfunc="mean")
    return net.dropna(), gross.dropna()


def policy_series(vals: pd.DataFrame, types: pd.Series, policy: dict[str, int]) -> np.ndarray:
    sl = types.map(policy).to_numpy()
    cols = {s: k for k, s in enumerate(vals.columns)}
    return vals.to_numpy()[np.arange(len(vals)), [cols[s] for s in sl]]


def block_lb(diff: np.ndarray, rng) -> float:
    n = len(diff)
    means = np.empty(RESAMPLES)
    for r in range(RESAMPLES):
        starts = rng.integers(0, n - BLOCK + 1, size=int(np.ceil(n / BLOCK)))
        ix = (starts[:, None] + np.arange(BLOCK)).reshape(-1)[:n]
        means[r] = diff[ix].mean()
    return float(np.quantile(means, 0.05))


def judge(net: pd.DataFrame, gross: pd.DataFrame, types: pd.Series, rng) -> dict:
    out: dict = {"n_days": len(net), "types": types.value_counts().to_dict()}
    series = {k: policy_series(net, types, p) for k, p in POLICIES.items()}
    out["mean_net"] = {k: float(v.mean()) for k, v in series.items()}
    out["mean_gross"] = {
        k: float(policy_series(gross, types, p).mean()) for k, p in POLICIES.items()
    }
    out["by_type_mean_net"] = {
        t: {str(s): float(net.loc[(types == t).to_numpy(), s].mean()) for s in net.columns}
        for t in ("quiet", "normal", "wide")
    }
    out["vs"] = {}
    for c in COMPARATORS:
        d = series["rule"] - series[c]
        out["vs"][c] = {"mean": float(d.mean()), "lb90": block_lb(d, rng)}
    shuffled = np.array(
        [
            policy_series(
                net, pd.Series(rng.permutation(types.to_numpy())), POLICIES["rule"]
            ).mean()
            for _ in range(SHUFFLES)
        ]
    )
    out["shuffle_p95"] = float(np.quantile(shuffled, 0.95))
    out["pass"] = bool(
        all(v["lb90"] > 0 for v in out["vs"].values())
        and out["mean_net"]["rule"] > out["shuffle_p95"]
    )
    return out


def main() -> None:
    OUT.mkdir(exist_ok=True)
    rng = np.random.default_rng(SEED)
    result, frames, cache = {}, [], {}
    for label, (index, start, end) in PERIODS.items():
        if index not in cache:
            mt = M.morning_types(M.minute_bars(index)).set_index("day")
            cache[index] = (mt, *day_values(index))
        mt, net, gross = cache[index]
        days = [
            d
            for d in net.index
            if start <= d <= end and d in mt.index and mt.loc[d, "type"] is not None
        ]
        types = mt.loc[days, "type"].reset_index(drop=True)
        result[label] = judge(net.loc[days], gross.loc[days], types, rng)
        result[label].update(index=index, start=start, end=end)
        f = net.loc[days].copy()
        f["type"], f["R"], f["period"] = types.to_numpy(), mt.loc[days, "R"].to_numpy(), label
        frames.append(f)
        r = result[label]
        print(f"\n{label} ({index} {start} -> {end}): {r['n_days']} days {r['types']}")
        print(
            "  mean net ₹/lot-day: " + ", ".join(f"{k} {v:+.0f}" for k, v in r["mean_net"].items())
        )
        for t, row in r["by_type_mean_net"].items():
            print(f"  {t:6s} by SL: " + ", ".join(f"{s}% {v:+.0f}" for s, v in row.items()))
        print(
            "  rule minus: "
            + ", ".join(f"{c} {v['mean']:+.0f} (lb90 {v['lb90']:+.0f})" for c, v in r["vs"].items())
        )
        print(f"  shuffle P95 {r['shuffle_p95']:+.0f} -> {'PASS' if r['pass'] else 'fail'}")
    pd.concat(frames).to_csv(OUT / "step1_days.csv")
    (OUT / "step1_result.json").write_text(json.dumps(result, indent=2))
    print(
        f"\nSTEP 1 (decides on {PERIODS['decide']}): {'PASS' if result['decide']['pass'] else 'FAIL'}"
    )


if __name__ == "__main__":
    main()
