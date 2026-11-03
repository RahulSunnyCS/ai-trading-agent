"""BL-191 Amendment 3: no SL150% Widesl (`N_wide-t1s4`) on a non-expiry day, as a filter (arm D0).

    TRADING_DATA_ROOT=/Volumes/TradingData uv run python research/bl191/amend3.py

Amendment 2's replay (amend2.py) with a cap of zero on non-expiry NIFTY days: list C's composite over
every T1 column, never recomputed; on a non-expiry day every `N_wide-t1s4_*` leaves the candidate
pool and `score.select` picks again when the core held one or more. Compared with T1 (deciding), and
with D2 (amend2_daily.json) and Phase 0's arm B (daily.json `expiry`). Output results/amend3.json.
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


def none_of_it(comp: np.ndarray, names: list[str], core: list[str]) -> list[str]:
    if not any(n.startswith(study.SETTING) for n in core):
        return core
    keep = [v for v, n in enumerate(names) if not n.startswith(study.SETTING)]
    return select(np.asarray(comp)[keep], [names[v] for v in keep]).core


def run(rec, results, holidays) -> list[dict]:
    cols = list(rec.cols)
    out = []
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
        comp, names, core = next(
            (c, list(n), p.core)
            for k, n, c, p in pick._rank(hist, day, float(a["vix_open"]), dte)
            if k == "C"
        )
        picks = core if expiry else none_of_it(comp, names, core)
        net = 0.0
        for name in picks:
            r = results.row(name, day)
            if r is None or r["n_trades"] is None:
                net = None
                break
            net += r["gross"] - lot_plans.brokerage(r["n_trades"])
        if net is not None:
            out.append({"day": day.isoformat(), "net": net, "picks": picks, "expiry": expiry})
    return out


def main() -> None:
    root = data_dir()
    core = list(variants.variant_names())
    names = core + [n for n in variants.track_names("t1") if n not in core]
    rec = daylog.reconstruction(root, names)
    d0 = run(rec, daylog._Results(root), daylog.holiday_names())
    t1 = json.loads((RESULTS / "daily.json").read_text())
    d2 = json.loads((RESULTS / "amend2_daily.json").read_text())["d2"]
    others = {"T1": t1["t1"], "D2": d2, "B": t1["expiry"]}
    for rows in others.values():
        assert [r["day"] for r in rows] == [r["day"] for r in d0]
    last = date.fromisoformat(d0[-1]["day"])
    res: dict = {"window": [d0[0]["day"], d0[-1]["day"]]}
    for key, (lo, hi) in (
        ("P2", study.P2), ("P1", study.P1), ("forward", (study.FORWARD_FROM, last)),
        ("all", (date(2000, 1, 1), last)),
    ):  # fmt: skip
        mine = study.window(d0, lo, hi)
        n = np.array([r["net"] for r in mine])
        block = {"d0": study.metrics(mine)}
        for name, rows in others.items():
            w = study.window(rows, lo, hi)
            b = np.array([r["net"] for r in w])
            block[f"vs_{name}"] = study.interval(n - b)
            block[name] = study.metrics(w)
        base = np.array([r["net"] for r in study.window(others["T1"], lo, hi)])
        changed = n != base
        block["days_changed"] = int(changed.sum())
        block["mean_diff_on_changed"] = float((n - base)[changed].mean()) if changed.any() else None
        if key == "P2":
            block.update(study.verdict(block["T1"], block["d0"], block["vs_T1"]))
        res[key] = block
    RESULTS.joinpath("amend3.json").write_text(json.dumps(res, indent=1, default=str))
    for key in ("P2", "P1", "forward", "all"):
        b = res[key]
        m = b["d0"]
        print(
            f"{key:7s} D0 mean {m['mean']:.0f} dd {m['max_drawdown']:,.0f} p5 {m['p5_day']:,.0f}"
            + "".join(
                f" | vs {o} {b['vs_' + o]['mean']:+.0f} [{b['vs_' + o]['lower']:+.0f}, {b['vs_' + o]['upper']:+.0f}]"
                for o in ("T1", "D2", "B")
            )
            + f" | changed {b['days_changed']} (mean {b['mean_diff_on_changed'] or 0:+.0f})  {b.get('verdict', '')}"
        )


if __name__ == "__main__":
    main()
