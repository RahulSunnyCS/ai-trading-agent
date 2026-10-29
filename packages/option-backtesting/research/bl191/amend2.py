"""BL-191 Amendment 2: at most one SL150% Widesl (`N_wide-t1s4`) a day in T1's picks.

    TRADING_DATA_ROOT=/Volumes/TradingData uv run python research/bl191/amend2.py

The replay of study.py. For each day list C's composite is computed over every T1 column, as the
09:16 job does (`pick._rank`), and never recomputed. The cap is a filter of that ranking, the way
BL-122's `expiry.filter_picks` works: when the selected core holds two or more `N_wide-t1s4_*`, the
one with the highest composite stays, the others leave the candidate pool, and `score.select` picks
again from the rest. Arms:

    t1   no cap (equals study.py's T1 arm, checked)
    d1   the cap on every day (primary)
    d2   the cap on non-expiry NIFTY days only

Outcome and rule as Phase 0 (study.py's helpers). Output results/amend2.json, amend2_daily.json.
"""

from __future__ import annotations

import json
import sys
from datetime import date
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).parent))
import study  # noqa: E402  (this item's own replay helpers)

from option_backtesting.fyers.daily import data_dir  # noqa: E402
from option_backtesting.rotation import daylog, lot_plans, pick, variants  # noqa: E402
from option_backtesting.rotation.score import select  # noqa: E402

RESULTS = Path(__file__).parent / "results"
ARMS = ("t1", "d1", "d2")


def capped(comp: np.ndarray, names: list[str], core: list[str]) -> list[str]:
    """The core picks with at most one `N_wide-t1s4`: the best-ranked stays, the rest leave the pool."""
    mine = [n for n in core if n.startswith(study.SETTING)]
    if len(mine) < 2:
        return core
    by_name = {n: v for v, n in enumerate(names)}
    best = max(mine, key=lambda n: (comp[by_name[n]], n))
    keep = [v for v, n in enumerate(names) if not n.startswith(study.SETTING) or n == best]
    sub = select(np.asarray(comp)[keep], [names[v] for v in keep])
    assert sum(n.startswith(study.SETTING) for n in sub.core) <= 1
    return sub.core


def run(rec, results, holidays) -> dict[str, list[dict]]:
    cols = list(rec.cols)
    out: dict[str, list[dict]] = {a: [] for a in ARMS}
    for i, day in enumerate(rec.days):
        if i < 63 or day.weekday() >= 5 or rec.days[i - 1] != study.previous_session(day, holidays):
            continue
        a = rec.attrs[day]
        expiry = str(a["dte_n"]) == "0"
        hist = pick.History(
            rec.days[:i], cols, rec.values[:i], rec.weekday[:i], rec.band[:i],
            rec.dte_n[:i], rec.dte_s[:i], "",
        )  # fmt: skip
        assert all(d < day for d in hist.days)
        dte = {"dte_n": a["dte_n"], "dte_s": a["dte_s"]}
        comp, names, base = next(
            (c, list(n), p.core)
            for k, n, c, p in pick._rank(hist, day, float(a["vix_open"]), dte)
            if k == "C"
        )
        assert base == pick.score_history(hist, day, float(a["vix_open"]), dte)["C"]["core"]
        picks = {
            "t1": base,
            "d1": capped(comp, names, base),
            "d2": base if expiry else capped(comp, names, base),
        }
        for arm in ARMS:
            net = 0.0
            for name in picks[arm]:
                r = results.row(name, day)
                if r is None or r["n_trades"] is None:
                    net = None
                    break
                net += r["gross"] - lot_plans.brokerage(r["n_trades"])
            if net is not None:
                out[arm].append(
                    {"day": day.isoformat(), "net": net, "picks": picks[arm], "expiry": expiry}
                )
    return out


def compare(series: dict, c2: list[dict], lo: date, hi: date, decide: bool = False) -> dict:
    base = study.window(series["t1"], lo, hi)
    b = np.array([r["net"] for r in base])
    c = np.array([r["net"] for r in study.window(c2, lo, hi)])
    assert c.size == b.size
    out = {"t1": study.metrics(base), "c2": study.metrics(study.window(c2, lo, hi))}
    for arm in ("d1", "d2"):
        rows = study.window(series[arm], lo, hi)
        assert [r["day"] for r in rows] == [r["day"] for r in base]
        n = np.array([r["net"] for r in rows])
        changed = n != b
        m = study.metrics(rows)
        out[arm] = {
            "metrics": m,
            "diff": study.interval(n - b),
            "diff_vs_c2": study.interval(n - c),
            "days_changed": int(changed.sum()),
            "mean_diff_on_changed_days": float((n - b)[changed].mean()) if changed.any() else None,
        }
        if decide:
            out[arm].update(study.verdict(out["t1"], m, out[arm]["diff"]))
    return out


def main() -> None:
    root = data_dir()
    core = list(variants.variant_names())
    names = core + [n for n in variants.track_names("t1") if n not in core]
    rec = daylog.reconstruction(root, names)
    series = run(rec, daylog._Results(root), daylog.holiday_names())
    first = json.loads((RESULTS / "daily.json").read_text())["t1"]
    assert [(r["day"], round(r["net"], 2)) for r in first] == [
        (r["day"], round(r["net"], 2)) for r in series["t1"]
    ], "the T1 arm differs from study.py's"
    c2 = json.loads((RESULTS / "amend1_daily.json").read_text())["c2"]
    last = date.fromisoformat(series["t1"][-1]["day"])
    every = (date(2000, 1, 1), last)
    res = {
        "window": [series["t1"][0]["day"], series["t1"][-1]["day"]],
        "P1": compare(series, c2, *study.P1),
        "P2": compare(series, c2, *study.P2, decide=True),
        "forward": compare(series, c2, study.FORWARD_FROM, last),
        "all": compare(series, c2, *every),
        "changed_days": [
            {
                "day": t["day"],
                "expiry": t["expiry"],
                "t1": round(t["net"]),
                "t1_picks": t["picks"],
                "d1": round(d["net"]),
                "d1_picks": d["picks"],
            }
            for t, d in zip(series["t1"], series["d1"], strict=True)
            if t["picks"] != d["picks"]
        ],  # fmt: skip
    }
    RESULTS.joinpath("amend2.json").write_text(json.dumps(res, indent=1, default=str))
    RESULTS.joinpath("amend2_daily.json").write_text(json.dumps(series, default=str))
    print(json.dumps({"window": res["window"]}))
    for key in ("P1", "P2", "forward", "all"):
        t = res[key]["t1"]
        print(
            f"{key}: T1 {t['days']} days, mean {t['mean']:.0f}, dd {t['max_drawdown']:,.0f}, p5 {t['p5_day']:,.0f}"
        )
        for arm in ("d1", "d2"):
            a = res[key][arm]
            m, d, v = a["metrics"], a["diff"], a["diff_vs_c2"]
            print(
                f"  {arm} mean {m['mean']:.0f}  vs T1 {d['mean']:+.0f} [{d['lower']:+.0f}, {d['upper']:+.0f}]"
                f"  vs C2 {v['mean']:+.0f}  dd {m['max_drawdown']:,.0f}  p5 {m['p5_day']:,.0f}"
                f"  worst {m['worst_day']:,.0f}  changed {a['days_changed']} days"
                f" (mean {a['mean_diff_on_changed_days'] or 0:+.0f})  -> {a.get('verdict', 'reported')}"
            )
    for row in res["changed_days"]:
        print(
            row["day"],
            "expiry" if row["expiry"] else "",
            row["t1"],
            "->",
            row["d1"],
            row["d1_picks"],
        )


if __name__ == "__main__":
    main()
