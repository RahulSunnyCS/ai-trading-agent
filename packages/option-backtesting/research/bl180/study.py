"""BL-180: the evening prediction against the 09:16 pick (pre-registered in the backlog item).

For every day D, list C's three core strategies are chosen twice from the SAME stored history
(through the previous session): once with the previous session's VIX close (what the evening
message uses) and once with D's 09:15 VIX open (what the 09:16 job uses). The day's outcome is the
net P&L of each set at one lot per strategy. Nothing here is tuned; every cut is fixed in the item.

    TRADING_DATA_ROOT=/Volumes/TradingData uv run python research/bl180/study.py [--out FILE]
"""

from __future__ import annotations

import argparse
import json
from datetime import date, timedelta

import numpy as np

from option_backtesting.fyers.daily import data_dir
from option_backtesting.rotation import attrs as attrs_mod
from option_backtesting.rotation import (
    daylog,
    journal,
    lot_plans,
    pick,
    readout,
    score,
    store,
    variants,
)

FIRST = date(2025, 1, 10)
SEED = 20261026
RESAMPLES = 2000
BLOCK = 5
LEVEL = 0.90
MARGIN = 150.0  # the pre-registered "good enough" band, rupees a day


def net_of(names: list[str], day: date, results: daylog._Results) -> float | None:
    total = 0.0
    for name in names:
        row = results.row(name, day)
        if row is None or row["n_trades"] is None:
            return None
        total += row["gross"] - lot_plans.brokerage(row["n_trades"])
    return total


def previous_session(day: date, holidays: dict) -> date:
    """The last exchange session before `day` (weekends and listed holidays skipped)."""
    d = day - timedelta(days=1)
    while not daylog.is_trading_day(d, holidays):
        d -= timedelta(days=1)
    return d


def by_half(rows: list[dict]) -> dict:
    """Mean difference, days and changed days per calendar half-year (descriptive)."""
    groups: dict[str, list[dict]] = {}
    for r in rows:
        groups.setdefault(f"{r['day'][:4]} H{1 if int(r['day'][5:7]) <= 6 else 2}", []).append(r)
    return {
        k: {
            "days": len(v),
            "changed": sum(not x["same_set"] for x in v),
            "diff_mean": float(np.mean([x["net_act"] - x["net_pred"] for x in v])),
            "pred_mean": float(np.mean([x["net_pred"] for x in v])),
            "act_mean": float(np.mean([x["net_act"] for x in v])),
        }
        for k, v in sorted(groups.items())
    }


def summarise(diff: np.ndarray) -> dict:
    mean, lo, hi = readout.block_bootstrap_mean(diff, RESAMPLES, BLOCK, SEED, LEVEL)
    return {"n": int(diff.size), "mean": mean, "lower": lo, "upper": hi}


def run(universe: str, min_history: int = 63) -> dict:
    root = data_dir()
    names = list(variants.variant_names())
    if universe == "t1":
        names += [n for n in variants.track_names("t1") if n not in names]
    rec = daylog.reconstruction(root, names)
    results = daylog._Results(root)
    # the registered rule needs 63 sessions of history; BL-180's addendum relaxes it to 21
    days = [d for i, d in enumerate(rec.days) if i >= min_history and d.weekday() < 5]
    if min_history == 63:
        days = [d for d in days if d >= FIRST]
    holidays = daylog.holiday_names()
    rows, dropped = [], {"no_vix_close": 0, "no_result": 0, "history_not_current": 0}
    for day in days:
        i = rec.days.index(day)
        if i == 0:
            continue
        prev = previous_session(day, holidays)
        if rec.days[i - 1] != prev:
            # the stored history stops short of the previous session (a data gap): the 09:16
            # job would fall back to the last collected day, but no evening prediction was made
            # from current history, so the pair cannot be compared
            dropped["history_not_current"] += 1
            continue
        a = rec.attrs[day]
        vix_open = float(a["vix_open"])
        vix_prev = attrs_mod.vix_close_from_lake(root, prev)
        if vix_prev is None:
            dropped["no_vix_close"] += 1
            continue
        hist = pick.History(
            rec.days[:i], rec.cols, rec.values[:i], rec.weekday[:i], rec.band[:i],
            rec.dte_n[:i], rec.dte_s[:i], "",
        )  # fmt: skip
        assert all(d < day for d in hist.days), f"history reaches {day}"
        dte = {"dte_n": a["dte_n"], "dte_s": a["dte_s"]}
        predicted = pick.score_history(hist, day, vix_prev, dte)["C"]["core"]
        actual = pick.score_history(hist, day, vix_open, dte)["C"]["core"]
        net_p, net_a = net_of(predicted, day, results), net_of(actual, day, results)
        if net_p is None or net_a is None:
            dropped["no_result"] += 1
            continue
        rows.append(
            {
                "day": day.isoformat(),
                "gap": vix_open - vix_prev,
                "band_pred": score.vix_band(vix_prev),
                "band_act": score.vix_band(vix_open),
                "same_set": set(predicted) == set(actual),
                "n_diff": 3 - len(set(predicted) & set(actual)),
                "net_pred": net_p,
                "net_act": net_a,
                "predicted": predicted,
                "actual": actual,
            }
        )
    p = np.array([r["net_pred"] for r in rows])
    ac = np.array([r["net_act"] for r in rows])
    diff = ac - p
    same = np.array([r["same_set"] for r in rows])
    band_same = np.array([r["band_pred"] == r["band_act"] for r in rows])
    gap = np.array([abs(r["gap"]) for r in rows])
    year = np.array([r["day"] < "2026-01-01" for r in rows])

    def arm(mask):
        if mask.sum() == 0:
            return None
        return {
            "days": int(mask.sum()),
            "pred_mean": float(p[mask].mean()), "act_mean": float(ac[mask].mean()),
            "pred_win": float((p[mask] > 0).mean()), "act_win": float((ac[mask] > 0).mean()),
            "diff_mean": float(diff[mask].mean()),
        }  # fmt: skip

    out = {
        "universe": universe,
        "window": [rows[0]["day"], rows[-1]["day"]],
        "days": len(rows),
        "dropped": dropped,
        "primary": summarise(diff),
        "halves": {
            "2025": summarise(diff[year]) if year.any() else None,
            "2026": summarise(diff[~year]) if (~year).any() else None,
        },
        "share_band_differs": float(1 - band_same.mean()),
        "share_same_picks": float(same.mean()),
        "mean_strategies_differing": float(np.mean([r["n_diff"] for r in rows])),
        "all_days": arm(np.ones(len(rows), bool)),
        "changed_days": arm(~same),
        "unchanged_days": arm(same),
        "by_gap": {
            "under_0.5": arm(gap < 0.5),
            "0.5_to_1": arm((gap >= 0.5) & (gap <= 1.0)),
            "over_1": arm(gap > 1.0),
        },
        "by_half_year": by_half(rows),
        "short_history": arm(np.array([r["day"] < FIRST.isoformat() for r in rows])),
        "registered_stretch": arm(np.array([r["day"] >= FIRST.isoformat() for r in rows])),
        "within_margin": bool(
            summarise(diff)["lower"] >= -MARGIN and summarise(diff)["upper"] <= MARGIN
        ),
        "rows": rows,
    }
    return out


def forward_check(core: dict) -> dict:
    """The live journal's recorded list-C core picks against what this script calls 'actual'."""
    root = data_dir()
    entries = journal.read(store.journal_path(root, None))
    by_day = {e["day"]: e for e in entries}
    mine = {r["day"]: r for r in core["rows"]}
    checked = []
    for day, e in sorted(by_day.items()):
        if day in mine:
            recorded = set(e["lists"]["C"]["core"]) if "lists" in e else None
            checked.append(
                {"day": day, "recorded_matches": recorded == set(mine[day]["actual"]) if recorded else None,
                 "net_pred": mine[day]["net_pred"], "net_act": mine[day]["net_act"], "same_set": mine[day]["same_set"]}
            )  # fmt: skip
    return {"days": checked}


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="research/bl180/results/study.json")
    ap.add_argument("--two-year", action="store_true", help="BL-180 addendum: 21-session minimum")
    args = ap.parse_args()
    if args.two_year:
        args.out = "research/bl180/results/study_2y.json"
    hist = 21 if args.two_year else 63
    out = {"core": run("core", hist), "t1": run("t1", hist)}
    if not args.two_year:
        out["forward"] = forward_check(out["core"])  # a broken check must fail the run, not hide
    import pathlib

    path = pathlib.Path(args.out)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(out, indent=1, default=str))
    for key in ("core", "t1"):
        r = out[key]
        print(key, r["window"], "days", r["days"], "dropped", r["dropped"])
        print(
            "  primary",
            {k: round(v, 1) if isinstance(v, float) else v for k, v in r["primary"].items()},
        )
        print(
            "  halves",
            {
                h: (
                    None
                    if v is None
                    else {k: round(x, 1) if isinstance(x, float) else x for k, x in v.items()}
                )
                for h, v in r["halves"].items()
            },
        )
        print(
            "  band differs",
            round(r["share_band_differs"], 3),
            "same picks",
            round(r["share_same_picks"], 3),
            "strategies differing",
            round(r["mean_strategies_differing"], 2),
            "within margin",
            r["within_margin"],
        )
        for name in (
            "all_days",
            "changed_days",
            "unchanged_days",
            "short_history",
            "registered_stretch",
        ):
            print("  ", name, r.get(name))
        print(
            "   by half-year",
            {
                k: (v["days"], v["changed"], round(v["diff_mean"], 1))
                for k, v in r["by_half_year"].items()
            },
        )
        print("   by_gap", r["by_gap"])
