"""BL-167: ITM2 added to the Adaptive ranking universe (Core-298 and Core-298 + T1).

    TRADING_DATA_ROOT=/Volumes/TradingData uv run python research/bl167/study.py [--check]

The rotation's own reconstruction (`daylog.reconstruction`) supplies the stored history; the 50 ITM2
Dir variants (25 start times x NIFTY and SENSEX, from research/bl166/results) are appended as
extra columns named `<N|S>_ditm2_<HHMM>`, and the ranking (`pick.score_history`, the function the
09:16 job calls) picks list C's three core strategies from the extended universe for every day with
63 earlier sessions. ITM2 is classed as a Dir variant (`score.is_dir` is widened for this run only,
as production would), so the Widesl minimum and the family-band criterion treat it like ITM1.
Nothing in the repo's ranking code or stored results is changed. Arms: the baseline universe, plus
ITM2 at the common 3,000 stop, plus ITM2 at BL-166's matched 4,000 stop. Outcome: net after charges,
1 lot a strategy. Every metric is the one fixed in BL-167 Phase 0.
"""

from __future__ import annotations

import argparse
import csv
import json
import pathlib
from datetime import date, timedelta

import numpy as np

from option_backtesting.fyers.daily import data_dir
from option_backtesting.rotation import daylog, lot_plans, pick, readout, score, variants

HERE = pathlib.Path(__file__).parent
BL166 = HERE.parent / "bl166" / "results"
SEED, RESAMPLES, BLOCK, LEVEL = 20261026, 2000, 5, 0.90
SLOTS = [
    s
    for s in (f"{h:02d}{m:02d}" for h in range(9, 16) for m in (2, 17, 32, 47))
    if "0917" <= s <= "1517"
]
HALF_SPLIT = date(2026, 1, 1)


def _is_dir(name: str) -> bool:
    return variants.base_family(name) in ("dir", "ditm1", "ditm2")


FAMILY = {"dir": "ATM", "ditm1": "ITM1", "ditm2": "ITM2", "buy": "Buy"}


def family_of(name: str) -> str:
    base = variants.base_family(name)
    return "Widesl" if variants.is_wide(name) else FAMILY.get(base, base)


def composition(base_rows: list[dict], arm_rows: list[dict]) -> dict:
    """Core-pick shares by family in each universe, and what leaves and enters on days the picks
    change: `replaced[f]` = dropped picks of family f over all baseline picks of f."""

    def count(rows):
        out: dict[str, int] = {}
        for r in rows:
            for p in r["picks"]:
                out[family_of(p)] = out.get(family_of(p), 0) + 1
        return out

    dropped: dict[str, int] = {}
    added: dict[str, int] = {}
    for b, a in zip(base_rows, arm_rows, strict=True):
        for p in set(b["picks"]) - set(a["picks"]):
            dropped[family_of(p)] = dropped.get(family_of(p), 0) + 1
        for p in set(a["picks"]) - set(b["picks"]):
            added[family_of(p)] = added.get(family_of(p), 0) + 1
    base_n, arm_n = count(base_rows), count(arm_rows)
    return {
        "base_picks": base_n, "arm_picks": arm_n, "dropped": dropped, "added": added,
        "replaced_share": {f: dropped.get(f, 0) / base_n[f] for f in base_n},
    }  # fmt: skip


def previous_session(day: date, holidays: dict) -> date:
    d = day - timedelta(days=1)
    while not daylog.is_trading_day(d, holidays):
        d -= timedelta(days=1)
    return d


def itm2_columns(stop: int, days: list[date]) -> tuple[list[str], np.ndarray, dict]:
    """The ITM2 variants as (names, values aligned to `days`, {name: {day: (gross, n_trades)}})."""
    names, cols, rows = [], [], {}
    for letter in ("N", "S"):
        for slot in SLOTS:
            name = f"{letter}_ditm2_{slot}"
            src = BL166 / f"{letter}_ditm2_s{stop}_{slot}.csv"
            with src.open() as f:
                by_day = {date.fromisoformat(r["day"]): r for r in csv.DictReader(f)}
            col = []
            for d in days:
                r = by_day.get(d)
                if r is None:
                    raise SystemExit(f"{name} has no row on {d}: the matrix cannot be extended")
                col.append(float(r["net"]))  # a day with no trade is a stored 0, as in the rotation
            names.append(name)
            cols.append(col)
            rows[name] = {
                d: (float(r["gross"]), int(float(r["n_trades"]))) for d, r in by_day.items()
            }
    return names, np.array(cols).T, rows


def run_arm(rec, results, extra, holidays) -> list[dict]:
    """List C's core picks for every eligible day from the (possibly extended) matrix."""
    cols, values, extra_rows = extra
    out = []
    for i, day in enumerate(rec.days):
        if i < 63 or day.weekday() >= 5 or rec.days[i - 1] != previous_session(day, holidays):
            continue
        a = rec.attrs[day]
        hist = pick.History(
            rec.days[:i], cols, values[:i], rec.weekday[:i], rec.band[:i], rec.dte_n[:i], rec.dte_s[:i], ""
        )  # fmt: skip
        assert all(d < day for d in hist.days)
        core = pick.score_history(
            hist, day, float(a["vix_open"]), {"dte_n": a["dte_n"], "dte_s": a["dte_s"]}
        )["C"]["core"]
        net = 0.0
        for name in core:
            if name in extra_rows:
                gross, n = extra_rows[name][day]
            else:
                r = results.row(name, day)
                if r is None or r["n_trades"] is None:
                    net = None
                    break
                gross, n = r["gross"], r["n_trades"]
            net += gross - lot_plans.brokerage(n)
        if net is not None:
            out.append({"day": day.isoformat(), "net": net, "picks": core})
    return out


def metrics(rows: list[dict]) -> dict:
    net = np.array([r["net"] for r in rows])
    cum = np.cumsum(net)
    peak = np.maximum.accumulate(np.concatenate([[0.0], cum]))[1:]
    return {
        "days": int(net.size), "total": float(net.sum()), "mean": float(net.mean()),
        "win": float((net > 0).mean()), "worst_day": float(net.min()),
        "max_drawdown": float((peak - cum).max()), "sharpe_day": float(net.mean() / net.std()),
    }  # fmt: skip


def interval(diff: np.ndarray) -> dict:
    mean, lo, hi = readout.block_bootstrap_mean(diff, RESAMPLES, BLOCK, SEED, LEVEL)
    return {"n": int(diff.size), "mean": mean, "lower": lo, "upper": hi}


def study(universe: str, check: bool) -> dict:
    root = data_dir()
    core = list(variants.variant_names())
    names = core + (
        [n for n in variants.track_names("t1") if n not in core] if universe == "t1" else []
    )
    rec = daylog.reconstruction(root, names)
    results = daylog._Results(root)
    holidays = daylog.holiday_names()
    base = (names := list(rec.cols), rec.values, {})
    arms = {"base": base}
    for stop in (3000, 4000):
        add, vals, rows = itm2_columns(stop, rec.days)
        arms[f"itm2_{stop}"] = (names + add, np.hstack([rec.values, vals]), rows)
    series = {k: run_arm(rec, results, v, holidays) for k, v in arms.items()}
    if check:
        return {k: len(v) for k, v in series.items()}
    days = [r["day"] for r in series["base"]]
    out = {"universe": universe, "window": [days[0], days[-1]], "days": len(days), "arms": {}}
    b = np.array([r["net"] for r in series["base"]])
    for key in ("itm2_3000", "itm2_4000"):
        rows = series[key]
        assert [r["day"] for r in rows] == days
        n = np.array([r["net"] for r in rows])
        half = np.array([r["day"] < HALF_SPLIT.isoformat() for r in rows])
        picked = [(p, r["day"]) for r in rows for p in r["picks"] if "_ditm2_" in p]
        changed = [
            i for i in range(len(rows)) if set(rows[i]["picks"]) != set(series["base"][i]["picks"])
        ]
        out["arms"][key] = {
            "metrics": metrics(rows), "base_metrics": metrics(series["base"]),
            "diff": interval(n - b),
            "diff_2025": interval((n - b)[half]), "diff_2026": interval((n - b)[~half]),
            "diff_hold": interval((n - b)[np.array([r["day"] >= "2025-10-09" for r in rows])]),
            "metrics_hold": metrics([r for r in rows if r["day"] >= "2025-10-09"]),
            "base_metrics_hold": metrics([r for r in series["base"] if r["day"] >= "2025-10-09"]),
            "days_picks_differ": len(changed), "itm2_picks": len(picked),
            "itm2_picks_by_index": {x: sum(1 for p, _ in picked if p.startswith(x)) for x in "NS"},
            "core_picks": 3 * len(rows),
            "composition": composition(series["base"], rows),
        }  # fmt: skip
    return out


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true")
    ap.add_argument("--out", default=str(HERE / "results" / "study.json"))
    args = ap.parse_args()
    score.is_dir = _is_dir  # ITM2 is a Dir variant for this run only
    res = {u: study(u, args.check) for u in ("core", "t1")}
    if args.check:
        print("rows per arm:", res)
    else:
        pathlib.Path(args.out).parent.mkdir(parents=True, exist_ok=True)
        pathlib.Path(args.out).write_text(json.dumps(res, indent=1, default=str))
        for u, r in res.items():
            print(u, r["window"], r["days"], "days")
            for k, a in r["arms"].items():
                m, bm, d = a["metrics"], a["base_metrics"], a["diff"]
                print(
                    f"  {k}: total {m['total']:,.0f} vs {bm['total']:,.0f}, dd {m['max_drawdown']:,.0f} vs {bm['max_drawdown']:,.0f}, "
                    f"diff {d['mean']:+.0f}/day [{d['lower']:+.0f}, {d['upper']:+.0f}], picks differ {a['days_picks_differ']}, "
                    f"ITM2 picks {a['itm2_picks']}/{a['core_picks']}"
                )
