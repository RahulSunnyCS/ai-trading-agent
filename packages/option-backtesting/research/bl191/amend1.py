"""BL-191 Amendment 1: on non-expiry days, a 115% Widesl at a ₹3,000 stop in place of `N_wide-t1s4`.

    TRADING_DATA_ROOT=/Volumes/TradingData uv run python research/bl191/amend1.py

Needs results/ from run_batch.py (the 100 variants of make_variants.py). First the engine parity:
the unchanged copies `N_wide-pbase_*` / `N_wide-ps4_*` must equal the stored `N_wide_*` /
`N_wide-t1s4_*` on every day. Then the replay of study.py, with the C1 / C2 columns appended to the
matrix and these arms (every day ranks on earlier days only):

    t1      Core-298 + T1, the new columns left out (equals study.py's T1 arm, checked)
    expiry  arm B of Phase 0: `N_wide-t1s4` only on NIFTY expiry days, nothing in its place
    c1      expiry day: T1; any other day: `N_wide-t1s4` out, `N_wide-c1_*` in
    c2      the same with `N_wide-c2_*`

Outcome and rule as Phase 0 (study.py's helpers). Output results/amend1.json and amend1_daily.json.
"""

from __future__ import annotations

import csv
import json
import sys
from datetime import date
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).parent))
import study  # noqa: E402  (this item's own replay helpers)

from option_backtesting.fyers.daily import data_dir  # noqa: E402
from option_backtesting.rotation import daylog, lot_plans, pick, store, variants  # noqa: E402

HERE = Path(__file__).parent
RESULTS = HERE / "results"
SLOTS = [s for s in (f"{h:02d}{m:02d}" for h in range(9, 16) for m in (2, 17, 32, 47)) if "0917" <= s <= "1517"]  # fmt: skip
NEW = ("c1", "c2")
ARMS = ("t1", "expiry", "c1", "c2")


def read_csv(name: str) -> dict[date, dict]:
    with (RESULTS / f"{name}.csv").open() as f:
        return {
            date.fromisoformat(r["day"]): {
                "net": float(r["net"]),
                "gross": float(r["gross"]),
                "n": int(float(r["n_trades"] or 0)),
            }
            for r in csv.DictReader(f)
        }


def engine_parity(root: Path) -> dict:
    """Unchanged copies run here against the stored rotation results: every day, net to the paisa."""
    out = {}
    for copy, stored in (("pbase", "N_wide_"), ("ps4", "N_wide-t1s4_")):
        days = diffs = 0
        for slot in SLOTS:
            mine = read_csv(f"N_wide-{copy}_{slot}")
            ref = store.read_net(f"{stored}{slot}", root)
            common = set(mine) & set(ref)
            assert set(ref) <= set(mine), (copy, slot, sorted(set(ref) - set(mine))[:3])
            days += len(common)
            diffs += sum(abs(mine[d]["net"] - ref[d]) > 0.01 for d in common)
        out[copy] = {"days": days, "differ": diffs}
        assert diffs == 0, out
    return out


def run(rec, results, holidays, extra: dict[str, dict[date, dict]]) -> dict[str, list[dict]]:
    cols = list(rec.cols)
    new_names = [f"N_wide-{k}_{s}" for k in NEW for s in SLOTS]
    try:
        new_vals = np.array([[extra[n][d]["net"] for n in new_names] for d in rec.days])
    except KeyError as error:
        raise SystemExit(f"a new variant has no row on a reconstruction day: {error}") from error
    all_cols = cols + new_names
    values = np.hstack([rec.values, new_vals])
    orig = np.array([True] * len(cols) + [False] * len(new_names))
    s4 = np.array([c.startswith(study.SETTING) for c in all_cols])
    assert s4.sum() == 25
    new = {k: np.array([c.startswith(f"N_wide-{k}_") for c in all_cols]) for k in NEW}
    out: dict[str, list[dict]] = {a: [] for a in ARMS}
    for i, day in enumerate(rec.days):
        if i < 63 or day.weekday() >= 5 or rec.days[i - 1] != study.previous_session(day, holidays):
            continue
        a = rec.attrs[day]
        expiry = str(a["dte_n"]) == "0"
        masks = {
            "t1": orig,
            "expiry": orig if expiry else orig & ~s4,
            **{k: orig if expiry else (orig & ~s4) | new[k] for k in NEW},
        }
        for arm in ARMS:
            m = masks[arm]
            names = [c for c, k in zip(all_cols, m, strict=True) if k]
            hist = pick.History(
                rec.days[:i], names, values[:i][:, m], rec.weekday[:i], rec.band[:i],
                rec.dte_n[:i], rec.dte_s[:i], "",
            )  # fmt: skip
            assert all(d < day for d in hist.days)
            core = pick.score_history(
                hist, day, float(a["vix_open"]), {"dte_n": a["dte_n"], "dte_s": a["dte_s"]}
            )["C"]["core"]
            net = 0.0
            for name in core:
                if name in extra:
                    r = extra[name][day]
                    gross, n = r["gross"], r["n"]
                else:
                    r = results.row(name, day)
                    if r is None or r["n_trades"] is None:
                        net = None
                        break
                    gross, n = r["gross"], r["n_trades"]
                net += gross - lot_plans.brokerage(n)
            if net is not None:
                out[arm].append(
                    {"day": day.isoformat(), "net": net, "picks": core, "expiry": expiry}
                )
    return out


def compare(series: dict, lo: date, hi: date, decide: bool = False) -> dict:
    base = study.window(series["t1"], lo, hi)
    b = np.array([r["net"] for r in base])
    bb = np.array([r["net"] for r in study.window(series["expiry"], lo, hi)])
    out = {
        "t1": study.metrics(base),
        "expiry": study.metrics(study.window(series["expiry"], lo, hi)),
    }
    for arm in NEW:
        rows = study.window(series[arm], lo, hi)
        assert [r["day"] for r in rows] == [r["day"] for r in base]
        n = np.array([r["net"] for r in rows])
        m = study.metrics(rows)
        out[arm] = {
            "metrics": m,
            "diff": study.interval(n - b),
            "diff_vs_B": study.interval(n - bb),
        }
        if decide:
            out[arm].update(study.verdict(out["t1"], m, out[arm]["diff"]))
    return out


def use(rows: list[dict], prefix: str) -> dict:
    per = [(sum(p.startswith(prefix) for p in r["picks"]), r) for r in rows if not r["expiry"]]
    two = [r for n, r in per if n >= 2]
    return {
        "picks_non_expiry": sum(n for n, _ in per),
        "non_expiry_days": len(per),
        "days_with_two_or_more": len(two),
        "mean_on_those_days": float(np.mean([r["net"] for r in two])) if two else None,
    }


def main() -> None:
    root = data_dir()
    extra = {
        f"N_wide-{k}_{s}": read_csv(f"N_wide-{k}_{s}")
        for k in (*NEW, "pbase", "ps4")
        for s in SLOTS
    }
    parity = engine_parity(root)
    core = list(variants.variant_names())
    names = core + [n for n in variants.track_names("t1") if n not in core]
    rec = daylog.reconstruction(root, names)
    series = run(rec, daylog._Results(root), daylog.holiday_names(), extra)
    first = json.loads((RESULTS / "daily.json").read_text())["t1"]
    assert [(r["day"], round(r["net"], 2)) for r in first] == [
        (r["day"], round(r["net"], 2)) for r in series["t1"]
    ], "the T1 arm differs from study.py's"
    last = date.fromisoformat(series["t1"][-1]["day"])
    every = (date(2000, 1, 1), last)
    res = {
        "window": [series["t1"][0]["day"], series["t1"][-1]["day"]],
        "engine_parity": parity,
        "P1": compare(series, *study.P1),
        "P2": compare(series, *study.P2, decide=True),
        "forward": compare(series, study.FORWARD_FROM, last),
        "all": compare(series, *every),
        "use": {
            arm: {
                p: use(study.window(series[arm], *w), prefix)
                for p, w in (("P2", study.P2), ("all", every))
            }
            for arm, prefix in (("t1", study.SETTING), ("c1", "N_wide-c1_"), ("c2", "N_wide-c2_"))
        },
    }
    RESULTS.joinpath("amend1.json").write_text(json.dumps(res, indent=1, default=str))
    RESULTS.joinpath("amend1_daily.json").write_text(json.dumps(series, default=str))
    print(json.dumps({"window": res["window"], "engine_parity": parity}))
    for key in ("P1", "P2", "forward", "all"):
        t, e = res[key]["t1"], res[key]["expiry"]
        print(
            f"{key}: T1 {t['days']} days, mean {t['mean']:.0f}, dd {t['max_drawdown']:,.0f}, p5 {t['p5_day']:,.0f}"
            f" | B mean {e['mean']:.0f}, dd {e['max_drawdown']:,.0f}, p5 {e['p5_day']:,.0f}"
        )
        for arm in NEW:
            a = res[key][arm]
            m, d, v = a["metrics"], a["diff"], a["diff_vs_B"]
            print(
                f"  {arm} mean {m['mean']:.0f}  vs T1 {d['mean']:+.0f} [{d['lower']:+.0f}, {d['upper']:+.0f}]"
                f"  vs B {v['mean']:+.0f} [{v['lower']:+.0f}, {v['upper']:+.0f}]  dd {m['max_drawdown']:,.0f}"
                f"  p5 {m['p5_day']:,.0f}  worst {m['worst_day']:,.0f}  -> {a.get('verdict', 'reported')}"
            )
    print(json.dumps(res["use"]))


if __name__ == "__main__":
    main()
