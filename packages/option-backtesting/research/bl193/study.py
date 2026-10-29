"""BL-193: every Core Widesl at a ₹3,000 overall stop instead of ₹2,500, standalone and in Adaptive.

    TRADING_DATA_ROOT=/Volumes/TradingData uv run python research/bl193/study.py

Needs results/ from run_batch.py (make_variants.py's 300 files). First the engine parity: every
unchanged copy (`-m25_`) equals the stored rotation result on every day. Then BL-191's replay
(`daylog.reconstruction` history, `pick.score_history` list C, 3 core picks, 1 lot each, net after
brokerage, the Buy add-on not counted, every day ranking on earlier days only) in four arms:

    K0   Core-298 as stored
    K1   Core-298 with each of the 150 Widesl columns replaced by its ₹3,000 version
    T0   Core-298 + T1-223 as stored
    T1K  the same with Core's 150 Widesl replaced

The rule is BL-193 Phase 0's. Output results/study.json, results/daily.json.
"""

from __future__ import annotations

import csv
import json
from datetime import date, timedelta
from pathlib import Path

import numpy as np

from option_backtesting.fyers.daily import data_dir
from option_backtesting.rotation import daylog, lot_plans, pick, readout, store, variants

HERE = Path(__file__).parent
RESULTS = HERE / "results"
SEED, RESAMPLES, BLOCK, LEVEL = 20261030, 2000, 5, 0.90
P1 = (date(2024, 10, 9), date(2025, 10, 8))
P2 = (date(2025, 10, 9), date(2026, 10, 9))
FORWARD_FROM = date(2026, 10, 12)


def m3k(name: str) -> str:
    index, family, slot = name.split("_")
    return f"{index}_{family}-m3k_{slot}"


def read_csv(name: str) -> dict[date, dict]:
    with (RESULTS / f"{name}.csv").open() as f:
        return {
            date.fromisoformat(r["day"]): {
                "net": float(r["net"]),
                "gross": float(r["gross"]),
                "n": int(float(r["n_trades"] or 0)),
                "stop": (r["stopped_by"] or "").lower().startswith("overall sl"),
            }
            for r in csv.DictReader(f)
        }


def previous_session(day: date, holidays: dict) -> date:
    d = day - timedelta(days=1)
    while not daylog.is_trading_day(d, holidays):
        d -= timedelta(days=1)
    return d


def engine_parity(root: Path, wide: list[str]) -> dict:
    days = differ = 0
    for name in wide:
        index, family, slot = name.split("_")
        mine = read_csv(f"{index}_{family}-m25_{slot}")
        ref = store.read_net(name, root)
        assert set(ref) <= set(mine), (name, sorted(set(ref) - set(mine))[:3])
        days += len(ref)
        differ += sum(abs(mine[d]["net"] - v) > 0.01 for d, v in ref.items())
    assert differ == 0, (days, differ)
    return {"variants": len(wide), "days": days, "differ": differ}


def run(rec, results, holidays, wide: list[str], extra: dict) -> dict[str, list[dict]]:
    """K / T arms on the same days; `rec` holds Core-298 + T1-223."""
    cols = list(rec.cols)
    core_set = set(variants.variant_names())
    swapped = [m3k(c) if c in wide else c for c in cols]
    vals3 = np.column_stack(
        [
            np.array([extra[m3k(c)][d]["net"] for d in rec.days]) if c in wide else rec.values[:, j]
            for j, c in enumerate(cols)
        ]
    )
    is_core = np.array([c in core_set for c in cols])
    arms = {
        "K0": (cols, rec.values, is_core),
        "K1": (swapped, vals3, is_core),
        "T0": (cols, rec.values, np.ones(len(cols), bool)),
        "T1K": (swapped, vals3, np.ones(len(cols), bool)),
    }
    out: dict[str, list[dict]] = {a: [] for a in arms}
    for i, day in enumerate(rec.days):
        if i < 63 or day.weekday() >= 5 or rec.days[i - 1] != previous_session(day, holidays):
            continue
        a = rec.attrs[day]
        dte = {"dte_n": a["dte_n"], "dte_s": a["dte_s"]}
        for arm, (names_all, values, mask) in arms.items():
            names = [n for n, k in zip(names_all, mask, strict=True) if k]
            hist = pick.History(
                rec.days[:i], names, values[:i][:, mask], rec.weekday[:i], rec.band[:i],
                rec.dte_n[:i], rec.dte_s[:i], "",
            )  # fmt: skip
            assert all(d < day for d in hist.days)
            core = pick.score_history(hist, day, float(a["vix_open"]), dte)["C"]["core"]
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
                    {
                        "day": day.isoformat(),
                        "net": net,
                        "picks": core,
                        "expiry": str(a["dte_n"]) == "0",
                        "expiry_s": str(a["dte_s"]) == "0",
                    }
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
    }  # fmt: skip


def window(rows: list[dict], lo: date, hi: date) -> list[dict]:
    return [r for r in rows if lo.isoformat() <= r["day"] <= hi.isoformat()]


def compare(series: dict, base: str, arm: str, lo: date, hi: date, decide: bool) -> dict:
    b_rows, a_rows = window(series[base], lo, hi), window(series[arm], lo, hi)
    assert [r["day"] for r in b_rows] == [r["day"] for r in a_rows]
    diff = np.array([r["net"] for r in a_rows]) - np.array([r["net"] for r in b_rows])
    mean, lower, upper = readout.block_bootstrap_mean(diff, RESAMPLES, BLOCK, SEED, LEVEL)
    bm, am = metrics(b_rows), metrics(a_rows)
    out = {
        "base": bm, "arm": am, "diff": {"mean": mean, "lower": lower, "upper": upper},
        "days_picks_differ": sum(
            {x.replace("-m3k_", "_") for x in r["picks"]} != set(s["picks"])
            for r, s in zip(a_rows, b_rows, strict=True)
        ),
    }  # fmt: skip
    if decide:
        dd_ok = am["max_drawdown"] <= 1.1 * bm["max_drawdown"]
        if mean >= 50 and lower > 0 and dd_ok:
            word = "adopt 3,000"
        elif mean < 0:
            word = "kill"
        else:
            word = "no clear gain"
        out.update({"drawdown_within_10pct": dd_ok, "verdict": word})
    return out


def standalone(wide: list[str], extra: dict, expiry: dict[str, dict[date, bool]]) -> dict:
    """Per family: the stored ₹2,500 (the -m25 copy, equal to it) against ₹3,000, every slot-day."""
    fams: dict[str, list[str]] = {}
    for n in wide:
        fams.setdefault(n.rsplit("_", 1)[0], []).append(n)
    out = {}
    for fam, names in sorted(fams.items()):
        exp = expiry[fam[0]]
        for label, keep in (
            ("all", lambda d: True),
            ("P1", lambda d: P1[0] <= d <= P1[1]),
            ("P2", lambda d: P2[0] <= d <= P2[1]),
            ("non_expiry", lambda d, exp=exp: d in exp and not exp[d]),
            ("expiry", lambda d, exp=exp: d in exp and exp[d]),
        ):
            a, b, sa, sb = [], [], 0, 0
            for n in names:
                index, family, slot = n.split("_")
                lo = extra[f"{index}_{family}-m25_{slot}"]
                hi = extra[m3k(n)]
                for d in lo:
                    if keep(d):
                        a.append(lo[d]["net"])
                        b.append(hi[d]["net"])
                        sa += lo[d]["stop"]
                        sb += hi[d]["stop"]
            x, y = np.array(a), np.array(b)
            out.setdefault(fam, {})[label] = {
                "n": int(x.size), "mean_2500": float(x.mean()), "mean_3000": float(y.mean()),
                "p5_2500": float(np.percentile(x, 5)), "p5_3000": float(np.percentile(y, 5)),
                "worst_2500": float(x.min()), "worst_3000": float(y.min()),
                "stops_2500": sa, "stops_3000": sb,
            }  # fmt: skip
    return out


def main() -> None:
    root = data_dir()
    core = list(variants.variant_names())
    wide = [n for n in core if variants.is_wide(n)]
    assert len(wide) == 150
    extra = {}
    for n in wide:
        index, family, slot = n.split("_")
        extra[m3k(n)] = read_csv(m3k(n))
        extra[f"{index}_{family}-m25_{slot}"] = read_csv(f"{index}_{family}-m25_{slot}")
    parity = engine_parity(root, wide)
    names = core + [n for n in variants.track_names("t1") if n not in core]
    rec = daylog.reconstruction(root, names)
    m3 = {k: v for k, v in extra.items() if "-m3k_" in k}
    series = run(rec, daylog._Results(root), daylog.holiday_names(), wide, m3)
    last = date.fromisoformat(series["K0"][-1]["day"])
    # each family's own index: NIFTY's expiry for N_, SENSEX's for S_ (replay days, from 2025-01-10)
    expiry = {
        "N": {date.fromisoformat(r["day"]): r["expiry"] for r in series["K0"]},
        "S": {date.fromisoformat(r["day"]): r["expiry_s"] for r in series["K0"]},
    }
    res: dict = {
        "window": [series["K0"][0]["day"], series["K0"][-1]["day"]],
        "engine_parity": parity,
    }
    for base, arm in (("K0", "K1"), ("T0", "T1K")):
        res[arm] = {
            "P2": compare(series, base, arm, *P2, decide=True),
            "P1": compare(series, base, arm, *P1, decide=False),
            "forward": compare(series, base, arm, FORWARD_FROM, last, decide=False),
            "all": compare(series, base, arm, date(2000, 1, 1), last, decide=False),
        }
    res["standalone"] = standalone(wide, extra, expiry)
    RESULTS.joinpath("study.json").write_text(json.dumps(res, indent=1, default=str))
    RESULTS.joinpath("daily.json").write_text(json.dumps(series, default=str))
    print(json.dumps({"window": res["window"], "engine_parity": parity}))
    for arm, base in (("K1", "Core"), ("T1K", "T1")):
        for key in ("P2", "P1", "forward", "all"):
            c = res[arm][key]
            b, a, d = c["base"], c["arm"], c["diff"]
            print(
                f"{base:4s} {key:7s} {b['days']:3d} days  base {b['mean']:6.0f}/day dd {b['max_drawdown']:7,.0f} p5 {b['p5_day']:7,.0f}"
                f" | 3k {a['mean']:6.0f}/day dd {a['max_drawdown']:7,.0f} p5 {a['p5_day']:7,.0f}"
                f" | diff {d['mean']:+5.0f} [{d['lower']:+.0f}, {d['upper']:+.0f}] picks differ {c['days_picks_differ']}"
                f"  {c.get('verdict', '')}"
            )
    for fam, rows in res["standalone"].items():
        s = rows["all"]
        print(
            f"{fam:7s} all: {s['mean_2500']:5.0f} -> {s['mean_3000']:5.0f}  p5 {s['p5_2500']:6.0f} -> {s['p5_3000']:6.0f}"
            f"  stops {s['stops_2500']} -> {s['stops_3000']}  | P2 {rows['P2']['mean_2500']:5.0f} -> {rows['P2']['mean_3000']:5.0f}"
            f"  | non-exp {rows['non_expiry']['mean_2500']:5.0f} -> {rows['non_expiry']['mean_3000']:5.0f}"
            f"  exp {rows['expiry']['mean_2500']:5.0f} -> {rows['expiry']['mean_3000']:5.0f}"
        )


if __name__ == "__main__":
    main()
