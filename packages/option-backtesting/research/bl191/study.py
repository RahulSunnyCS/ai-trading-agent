"""BL-191: Adaptive over T1 without its SL150% NIFTY Widesl (`N_wide-t1s4`), or with it on expiry days only.

    TRADING_DATA_ROOT=/Volumes/TradingData uv run python research/bl191/study.py [--check]

The rotation's own reconstruction (`daylog.reconstruction`) supplies the stored history of Core-298
plus the 223 T1 variants, as BL-167 replays T1. For every day with 63 earlier sessions the ranking
(`pick.score_history`, the function the 09:16 job calls) picks list C's three core strategies from:

    t1      every column
    drop    every column but the 25 `N_wide-t1s4_*` ones (arm A)
    expiry  every column on a NIFTY expiry day (DTE label "0"); the 25 left out on any other day (arm B)

Outcome: net after brokerage, 1 lot a strategy, the Buy add-on not counted (as BL-167). Every rule
and metric is the one fixed in BL-191 Phase 0. Nothing in the repo's ranking code or stored results
is changed.
"""

from __future__ import annotations

import argparse
import json
import os
import pathlib
from datetime import date, timedelta

import numpy as np

from option_backtesting.fyers.daily import data_dir
from option_backtesting.rotation import daylog, lot_plans, pick, readout, variants

# BL-192 put the SL150% cap inside `pick.score_history` from 2026-10-30; the replay ranks T1 as
# registered (uncapped), so the cap is switched off for this process (amend*.py import this module).
os.environ["ROTATION_SL150_CAP_FROM"] = "off"
HERE = pathlib.Path(__file__).parent
SEED, RESAMPLES, BLOCK, LEVEL = 20261029, 2000, 5, 0.90
SETTING = "N_wide-t1s4_"
P1 = (date(2024, 10, 9), date(2025, 10, 8))
P2 = (date(2025, 10, 9), date(2026, 10, 9))
FORWARD_FROM = date(2026, 10, 12)
#: BL-167's T1 base over its window, re-derived here as the parity check
BL167 = {"window": (date(2025, 1, 10), date(2026, 10, 23)), "days": 431, "total": 653_498}
ARMS = ("t1", "drop", "expiry")


def previous_session(day: date, holidays: dict) -> date:
    d = day - timedelta(days=1)
    while not daylog.is_trading_day(d, holidays):
        d -= timedelta(days=1)
    return d


def family_of(name: str) -> str:
    if name.startswith(SETTING):
        return "SL150 Widesl"
    if variants.is_wide(name):
        return "Widesl"
    return {"dir": "ATM", "ditm1": "ITM1", "buy": "Buy"}.get(
        variants.base_family(name), variants.base_family(name)
    )


def run(rec, results, holidays) -> dict[str, list[dict]]:
    """List C's core picks per arm for every eligible day, with the day's net and NIFTY DTE."""
    cols = list(rec.cols)
    setting = np.array([c.startswith(SETTING) for c in cols])
    assert setting.sum() == 25, setting.sum()
    keep = {
        "t1": np.ones(len(cols), bool),
        "drop": ~setting,
    }
    out: dict[str, list[dict]] = {a: [] for a in ARMS}
    for i, day in enumerate(rec.days):
        if i < 63 or day.weekday() >= 5 or rec.days[i - 1] != previous_session(day, holidays):
            continue
        a = rec.attrs[day]
        expiry = str(a["dte_n"]) == "0"
        masks = {**keep, "expiry": keep["t1"] if expiry else keep["drop"]}
        for arm in ARMS:
            m = masks[arm]
            names = [c for c, k in zip(cols, m, strict=True) if k]
            hist = pick.History(
                rec.days[:i], names, rec.values[:i][:, m], rec.weekday[:i], rec.band[:i],
                rec.dte_n[:i], rec.dte_s[:i], "",
            )  # fmt: skip
            assert all(d < day for d in hist.days)
            core = pick.score_history(
                hist, day, float(a["vix_open"]), {"dte_n": a["dte_n"], "dte_s": a["dte_s"]}
            )["C"]["core"]
            net = 0.0
            for name in core:
                r = results.row(name, day)
                if r is None or r["n_trades"] is None:
                    net = None
                    break
                net += r["gross"] - lot_plans.brokerage(r["n_trades"])
            if net is not None:
                out[arm].append(
                    {"day": day.isoformat(), "net": net, "picks": core, "expiry": expiry}
                )
    return out


def metrics(rows: list[dict]) -> dict:
    net = np.array([r["net"] for r in rows])
    cum = np.cumsum(net)
    peak = np.maximum.accumulate(np.concatenate([[0.0], cum]))[1:]
    return {
        "days": int(net.size), "total": float(net.sum()), "mean": float(net.mean()),
        "win": float((net > 0).mean()), "p5_day": float(np.percentile(net, 5)),
        "worst_day": float(net.min()), "max_drawdown": float((peak - cum).max()),
        "days_below_6000": int((net < -6000).sum()),
    }  # fmt: skip


def interval(diff: np.ndarray) -> dict:
    mean, lo, hi = readout.block_bootstrap_mean(diff, RESAMPLES, BLOCK, SEED, LEVEL)
    return {"n": int(diff.size), "mean": mean, "lower": lo, "upper": hi}


def verdict(base: dict, arm: dict, diff: dict) -> dict:
    """The Phase 0 rule: return (mean >= -50 and upper >= 0), risk (drawdown or p5 day >= 10% better)."""
    ret = diff["mean"] >= -50 and diff["upper"] >= 0
    dd = arm["max_drawdown"] <= 0.9 * base["max_drawdown"]
    p5 = arm["p5_day"] >= base["p5_day"] + 0.1 * abs(base["p5_day"])  # 10% of its size better
    word = "pass" if ret and (dd or p5) else "kill" if not ret else "no difference"
    return {"return_ok": ret, "drawdown_10pct": dd, "p5_10pct": p5, "verdict": word}


def window(rows: list[dict], lo: date, hi: date, only_non_expiry: bool = False) -> list[dict]:
    return [
        r
        for r in rows
        if lo.isoformat() <= r["day"] <= hi.isoformat() and not (only_non_expiry and r["expiry"])
    ]


def compare(
    series: dict, lo: date, hi: date, only_non_expiry: bool = False, decide: bool = False
) -> dict:
    """Each arm against T1 over the window. Only P2 carries the registered verdict (`decide`).
    On non-expiry days alone arm B is arm A by construction, so only A is compared, and the
    drawdown is left out: over a subset of days it is not a drawdown any book had."""
    base = window(series["t1"], lo, hi, only_non_expiry)

    def figures(rows: list[dict]) -> dict:
        m = metrics(rows)
        if only_non_expiry:
            del m["max_drawdown"]
        return m

    out = {"t1": figures(base)}
    b = np.array([r["net"] for r in base])
    for arm in ("drop",) if only_non_expiry else ("drop", "expiry"):
        rows = window(series[arm], lo, hi, only_non_expiry)
        assert [r["day"] for r in rows] == [r["day"] for r in base]
        m = figures(rows)
        d = interval(np.array([r["net"] for r in rows]) - b)
        out[arm] = {"metrics": m, "diff": d}
        if decide:
            out[arm].update(verdict(out["t1"], m, d))
    return out


def setting_use(rows: list[dict]) -> dict:
    per_day = [sum(p.startswith(SETTING) for p in r["picks"]) for r in rows]
    return {
        "picks": int(sum(per_day)),
        "days_with_one": sum(n == 1 for n in per_day),
        "days_with_two_or_more": sum(n >= 2 for n in per_day),
        "on_expiry_days": sum(n for n, r in zip(per_day, rows, strict=True) if r["expiry"]),
        "core_picks": 3 * len(rows),
    }


def swaps(base: list[dict], arm: list[dict]) -> dict:
    """On days the picks differ: what leaves and what enters, by family."""
    left: dict[str, int] = {}
    came: dict[str, int] = {}
    for b, a in zip(base, arm, strict=True):
        for p in set(b["picks"]) - set(a["picks"]):
            left[family_of(p)] = left.get(family_of(p), 0) + 1
        for p in set(a["picks"]) - set(b["picks"]):
            came[family_of(p)] = came.get(family_of(p), 0) + 1
    assert sum(left.values()) == sum(came.values()), (left, came)
    return {"left": left, "entered": came, "days_differ": sum(
        set(b["picks"]) != set(a["picks"]) for b, a in zip(base, arm, strict=True))}  # fmt: skip


def main(check: bool, out_path: pathlib.Path) -> None:
    root = data_dir()
    core = list(variants.variant_names())
    names = core + [n for n in variants.track_names("t1") if n not in core]
    rec = daylog.reconstruction(root, names)
    series = run(rec, daylog._Results(root), daylog.holiday_names())
    if check:
        print(
            {a: len(v) for a, v in series.items()}, series["t1"][0]["day"], series["t1"][-1]["day"]
        )
        return
    lo, hi = BL167["window"]
    par = window(series["t1"], lo, hi)
    parity = {"days": len(par), "total": round(sum(r["net"] for r in par))}
    assert parity == {"days": BL167["days"], "total": BL167["total"]}, parity
    last = date.fromisoformat(series["t1"][-1]["day"])
    res = {
        "window": [series["t1"][0]["day"], series["t1"][-1]["day"]],
        "parity_bl167": parity,
        "P1": compare(series, *P1),
        "P2": compare(series, *P2, decide=True),
        "P2_non_expiry": compare(series, *P2, only_non_expiry=True),
        "forward": compare(series, FORWARD_FROM, last),
        "all": compare(series, date(2000, 1, 1), last),
        "setting_use": {
            p: setting_use(window(series["t1"], *w))
            for p, w in (("P1", P1), ("P2", P2), ("all", (date(2000, 1, 1), last)))
        },
        "swaps": {arm: swaps(series["t1"], series[arm]) for arm in ("drop", "expiry")},
        "worst_t1_days": [
            {
                "day": r["day"],
                "t1": round(r["net"]),
                "picks": r["picks"],
                **{
                    arm: round(next(x["net"] for x in series[arm] if x["day"] == r["day"]))
                    for arm in ("drop", "expiry")
                },
            }
            for r in sorted(series["t1"], key=lambda r: r["net"])[:5]
        ],  # fmt: skip
    }
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(res, indent=1, default=str))
    (out_path.parent / "daily.json").write_text(json.dumps(series, default=str))
    print(json.dumps({k: res[k] for k in ("window", "parity_bl167")}))
    for key in ("P1", "P2", "P2_non_expiry", "forward", "all"):
        t = res[key]["t1"]
        dd = f", dd {t['max_drawdown']:,.0f}" if "max_drawdown" in t else ""
        print(f"{key}: T1 {t['days']} days, mean {t['mean']:.0f}{dd}, p5 {t['p5_day']:,.0f}")
        for arm in ("drop", "expiry"):
            if arm not in res[key]:
                continue
            a = res[key][arm]
            m, d = a["metrics"], a["diff"]
            dd = f"  dd {m['max_drawdown']:,.0f}" if "max_drawdown" in m else ""
            print(
                f"  {arm:6s} mean {m['mean']:.0f}  diff {d['mean']:+.0f} [{d['lower']:+.0f}, {d['upper']:+.0f}]"
                f"{dd}  p5 {m['p5_day']:,.0f}  worst {m['worst_day']:,.0f}  -> {a.get('verdict', 'reported')}"
            )


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true")
    ap.add_argument("--out", default=str(HERE / "results" / "study.json"))
    args = ap.parse_args()
    main(args.check, pathlib.Path(args.out))
