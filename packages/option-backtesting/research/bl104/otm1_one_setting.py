"""BL-104 experiment (2026-10-15): NIFTY Widesl OTM1 — does one setting beat the template at most
entry times? Reads the stored Stage 1 day x cell series (after charges) for the W_N_* cohorts.

    uv run python research/bl104/otm1_one_setting.py            # the grid answer (7 slots)
    uv run python research/bl104/otm1_one_setting.py --tag <t>  # the same on another tag's series
    uv run python research/bl104/otm1_one_setting.py --days expiry   # NIFTY weekly expiry days only
    uv run python research/bl104/otm1_one_setting.py --days other    # every other weekday
"""

from __future__ import annotations

import argparse
import csv
import json
import sys
from datetime import date
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import grid  # noqa: E402
from robust import cscv_pbo  # noqa: E402

from option_backtesting.rotation.readout import block_bootstrap_mean, max_drawdown  # noqa: E402

CUT = date(2025, 10, 9)
DD_X, TAIL_X = 1.10, 1.25
SEED = 20261012
STRIKE = "OTM1"


def worst5(v: np.ndarray) -> float:
    return float(np.sort(v)[:5].sum())


def risk_ok(c: np.ndarray, t: np.ndarray) -> bool:
    return (
        max_drawdown(c) >= DD_X * max_drawdown(t)
        and c.min() >= TAIL_X * t.min()
        and worst5(c) >= TAIL_X * worst5(t)
    )


REFERENCE = HERE.parents[1] / "src" / "option_backtesting" / "data" / "reference"


def nifty_expiries() -> set[date]:
    """The NIFTY expiry dates the lake's option files list (holiday shifts included)."""
    with (REFERENCE / "expiries_observed.csv").open(newline="") as h:
        return {
            date.fromisoformat(r["expiry"]) for r in csv.DictReader(h) if r["underlying"] == "NIFTY"
        }


def load(tag: str, slots: tuple[str, ...], days_kind: str = "all"):
    """{slot: (days, labels, matrix)} for the W_N cohorts of a results tag; `days_kind` keeps all
    weekdays, only the NIFTY expiry days, or only the other days."""
    expiries = nifty_expiries() if days_kind != "all" else set()
    out = {}
    for slot in slots:
        cohort = f"W_N_{slot.replace(':', '')}"
        base = HERE / "results" / tag / "series" / cohort
        meta = json.loads(base.with_suffix(".json").read_text())
        m = np.load(base.with_suffix(".npy")).astype(float)
        days = [date.fromisoformat(d) for d in meta["days"]]
        keep = [
            i
            for i, d in enumerate(days)
            if d.weekday() < 5
            and (days_kind == "all" or (d in expiries) == (days_kind == "expiry"))
        ]
        out[slot] = ([days[i] for i in keep], meta["labels"], m[keep])
    return out


def candidates(labels: list[str], strikes: tuple[str, ...] = (STRIKE,)) -> list[dict]:
    """Cells with one of `strikes` and a day MTM stop; params decoded via grid.cells."""
    out = []
    for slot_cells in [grid.cells("W", "N", grid.SLOTS[0], with_template=False)]:
        for c in slot_cells:
            p = c.params
            if p["strike"] in strikes and p["mtm"] is not None:
                out.append(p)
    return out


def label_for(slot: str, params: dict | None) -> str:
    return grid.Cell("W", "N", slot, params).label


def evaluate(data, params_list, sel_mask_fn, chk_mask_fn):
    """For every candidate: per-slot gain / risk in the selection and check periods."""
    rows = []
    slots = list(data)
    for p in params_list:
        r = {
            "params": p,
            "sel_gain": [],
            "chk_gain": [],
            "chk_pass": 0,
            "chk_dd_x": [],
            "chk_wd_x": [],
            "chk_w5_x": [],
            "chk_diffs": [],
        }
        for slot in slots:
            days, labels, m = data[slot]
            col = {lab: i for i, lab in enumerate(labels)}
            c = m[:, col[label_for(slot, p)]]
            t = m[:, col[label_for(slot, None)]]
            d = np.array(days)
            s, k = sel_mask_fn(d), chk_mask_fn(d)
            r["sel_gain"].append(float((c[s] - t[s]).mean()))
            r["chk_gain"].append(float((c[k] - t[k]).mean()))
            r["chk_diffs"].append(c[k] - t[k])
            r["chk_pass"] += (c[k] - t[k]).mean() > 0 and risk_ok(c[k], t[k])
            r["chk_dd_x"].append(
                max_drawdown(c[k]) / max_drawdown(t[k]) if max_drawdown(t[k]) < 0 else float("nan")
            )
            r["chk_wd_x"].append(c[k].min() / t[k].min() if t[k].min() < 0 else float("nan"))
            r["chk_w5_x"].append(worst5(c[k]) / worst5(t[k]) if worst5(t[k]) < 0 else float("nan"))
        pooled = np.mean(r["chk_diffs"], axis=0)  # equal-weight over slots, per day
        r["chk_mean"] = float(pooled.mean())
        r["chk_lo"], r["chk_hi"] = block_bootstrap_mean(pooled)[1:]
        r["sel_mean"] = float(np.mean(r["sel_gain"]))
        rows.append(r)
    return rows


def luck_line(data, params_list, mask_fn, n=1000):
    """95th percentile of the best-of-N mean gain when each day's paired difference keeps its size
    but gets a random sign (the same flips for every candidate, so their correlation is kept)."""
    slots = list(data)
    diffs = []
    for p in params_list:
        per = []
        for slot in slots:
            days, labels, m = data[slot]
            col = {lab: i for i, lab in enumerate(labels)}
            d = np.array(days)
            k = mask_fn(d)
            per.append(m[k, col[label_for(slot, p)]] - m[k, col[label_for(slot, None)]])
        diffs.append(np.mean(per, axis=0))
    D = np.array(diffs)  # candidates x days
    rng = np.random.default_rng(SEED)
    best = []
    for _ in range(n):
        signs = rng.choice([-1.0, 1.0], size=D.shape[1])
        best.append((D * signs).mean(axis=1).max())
    return float(np.percentile(best, 95))


def neighbours(p: dict) -> list[dict]:
    out = []
    for axis, chains in grid.CHAINS["W"].items():
        if axis == "strike":
            continue
        for chain in chains:
            if p[axis] in chain:
                i = chain.index(p[axis])
                for j in (i - 1, i + 1):
                    if 0 <= j < len(chain) and (axis != "mtm" or chain[j] is not None):
                        out.append({**p, axis: chain[j]})
    return out


def pretty(p: dict) -> str:
    tr = "no trail" if p["trail"] is None else f"trail {p['trail'][0]}/{p['trail'][1]}"
    re = "no RE" if p["reentry"] is None else "RE cost×1"
    head = "" if p["strike"] == STRIKE else f"{p['strike']} "
    return f"{head}SL {p['sl']}%, {tr}, MTM ₹{p['mtm']:,}, exit {p['exit']}, {re}"


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--tag", default="stage1")
    ap.add_argument("--days", default="all", choices=("all", "expiry", "other"))
    ap.add_argument("--strikes", default=STRIKE, help="comma list, e.g. OTM1,OTM2,OTM3")
    args = ap.parse_args()
    data = load(args.tag, grid.SLOTS, args.days)
    labels = data[grid.SLOTS[0]][1]
    strikes = tuple(args.strikes.split(","))
    cands = candidates(labels, strikes)
    first = lambda d: d < CUT  # noqa: E731
    test = lambda d: d >= CUT  # noqa: E731
    stem = "otm1" if strikes == (STRIKE,) else "otm" + "-".join(x.removeprefix("OTM") for x in strikes)
    out_dir = HERE / "results" / (stem if args.days == "all" else f"{stem}_{args.days}")
    out_dir.mkdir(parents=True, exist_ok=True)
    print(
        f"{len(cands)} candidates ({','.join(strikes)}) with a day stop, {len(grid.SLOTS)} slots, days={args.days}: "
        f"{len(data[grid.SLOTS[0]][0])} per slot "
        f"({sum(d < CUT for d in data[grid.SLOTS[0]][0])} first year)\n"
    )
    for name, sel, chk in (
        ("select on FIRST year, check on TEST year", first, test),
        ("select on TEST year, check on FIRST year", test, first),
    ):
        rows = evaluate(data, cands, sel, chk)
        luck = luck_line(data, cands, chk)
        by_key = {json.dumps(r["params"], sort_keys=True, default=list): r for r in rows}
        for r in rows:
            nb = [
                by_key[json.dumps(q, sort_keys=True, default=list)]
                for q in neighbours(r["params"])
                if json.dumps(q, sort_keys=True, default=list) in by_key
            ]
            r["plateau"] = (
                bool(nb) and float(np.median([x["chk_mean"] for x in nb])) >= 0.7 * r["chk_mean"]
                if r["chk_mean"] > 0
                else False
            )
            r["luck_ok"] = r["chk_mean"] > luck
            r["verdict"] = r["chk_pass"] >= 5 and r["chk_lo"] > 0 and r["luck_ok"] and r["plateau"]
        rows.sort(key=lambda r: -r["sel_mean"])
        top = rows[:5]
        print(
            f"== {name} ==  luck line (best-of-{len(cands)} by chance, 95th pct): {luck:+.0f} per lot-day"
        )
        print(
            f"{'#':>2s} {'settings':48s}{'sel gain':>9s}{'chk gain':>9s}{'90% int':>16s}{'slots ok':>9s}{'DDx':>5s}{'worstx':>7s}{'w5x':>5s}{'plateau':>8s}{'luck':>5s}{'PASS':>5s}"
        )
        for i, r in enumerate(top, 1):
            print(
                f"{i:2d} {pretty(r['params']):48s}{r['sel_mean']:9.0f}{r['chk_mean']:9.0f}  [{r['chk_lo']:+5.0f}, {r['chk_hi']:+5.0f}]{r['chk_pass']:6d}/7 {np.nanmean(r['chk_dd_x']):5.2f}{np.nanmean(r['chk_wd_x']):7.2f}{np.nanmean(r['chk_w5_x']):5.2f}{str(r['plateau']):>8s}{str(r['luck_ok']):>5s}{str(r['verdict']):>5s}"
            )
        best = top[0]
        print(
            "   per-slot check-period gain of #1: "
            + "  ".join(f"{s} {g:+.0f}" for s, g in zip(grid.SLOTS, best["chk_gain"], strict=True))
        )
        winners = [r for r in rows if r["verdict"]]
        print(
            f"   candidates passing every condition: {len(winners)}"
            + (": " + "; ".join(pretty(w["params"]) for w in winners[:5]) if winners else "")
        )
        print()
        with (out_dir / f"ranked_{'first_to_test' if sel is first else 'test_to_first'}.csv").open(
            "w", newline=""
        ) as h:
            w = csv.writer(h)
            w.writerow(
                [
                    "settings",
                    "sel_mean",
                    "chk_mean",
                    "chk_lo90",
                    "chk_hi90",
                    "slots_pass",
                    "dd_x",
                    "worst_x",
                    "w5_x",
                    "plateau",
                    "luck_ok",
                    "verdict",
                    *[f"chk_{s}" for s in grid.SLOTS],
                ]
            )
            for r in rows:
                w.writerow(
                    [
                        pretty(r["params"]),
                        r["sel_mean"],
                        r["chk_mean"],
                        r["chk_lo"],
                        r["chk_hi"],
                        r["chk_pass"],
                        np.nanmean(r["chk_dd_x"]),
                        np.nanmean(r["chk_wd_x"]),
                        np.nanmean(r["chk_w5_x"]),
                        r["plateau"],
                        r["luck_ok"],
                        r["verdict"],
                        *r["chk_gain"],
                    ]
                )
    # descriptive only: every day of both years pooled (in-sample by construction, never a pass)
    allm = lambda d: np.ones(len(d), dtype=bool)  # noqa: E731
    pooled_rows = evaluate(data, cands, allm, allm)
    pooled_rows.sort(key=lambda r: -r["chk_mean"])
    print("== POOLED, both years (descriptive, in-sample) ==")
    for i, r in enumerate(pooled_rows[:5], 1):
        print(
            f"{i:2d} {pretty(r['params']):48s}{r['chk_mean']:+7.0f}  [{r['chk_lo']:+5.0f}, {r['chk_hi']:+5.0f}]"
            f"  slots>0 {sum(g > 0 for g in r['chk_gain'])}/7  risk-ok {r['chk_pass']}/7"
            f"  DDx {np.nanmean(r['chk_dd_x']):.2f} worstx {np.nanmean(r['chk_wd_x']):.2f}"
        )
    with (out_dir / "ranked_pooled.csv").open("w", newline="") as h:
        w = csv.writer(h)
        w.writerow(["settings", "mean_gain", "lo90", "hi90", "slots_pos", "slots_risk_ok", *[f"gain_{s}" for s in grid.SLOTS]])
        for r in pooled_rows:
            w.writerow([pretty(r["params"]), r["chk_mean"], r["chk_lo"], r["chk_hi"], sum(g > 0 for g in r["chk_gain"]), r["chk_pass"], *r["chk_gain"]])
    if len(strikes) > 1:
        print("best per strike, pooled (descriptive):")
        for k in strikes:
            r = next(x for x in pooled_rows if x["params"]["strike"] == k)
            print(f"   {pretty(r['params']):52s}{r['chk_mean']:+7.0f}  slots>0 {sum(g > 0 for g in r['chk_gain'])}/7  risk-ok {r['chk_pass']}/7")
    print()
    # PBO over the 216 at each slot (test year), 8 blocks
    pbos = []
    for slot in grid.SLOTS:
        days, labels, m = data[slot]
        col = {lab: i for i, lab in enumerate(labels)}
        k = np.array([d >= CUT for d in days])
        mat = np.column_stack([m[k, col[label_for(slot, p)]] for p in cands])
        pbos.append(cscv_pbo(mat, 8)[0])
    print(
        "PBO (8 blocks, test year) per slot: "
        + "  ".join(f"{s} {p:.2f}" for s, p in zip(grid.SLOTS, pbos, strict=True))
    )
    # the template itself and 'MTM none' cells, for the record
    tmpl = []
    for slot in grid.SLOTS:
        days, labels, m = data[slot]
        col = {lab: i for i, lab in enumerate(labels)}
        t = m[:, col[label_for(slot, None)]]
        d = np.array(days)
        tmpl.append((t[d < CUT].mean(), t[d >= CUT].mean()))
    print(
        "template net per lot-day, first year -> test year, per slot: "
        + "  ".join(f"{s} {a:.0f}->{b:.0f}" for s, (a, b) in zip(grid.SLOTS, tmpl, strict=True))
    )
    (out_dir / "params_top.json").write_text(
        json.dumps([r["params"] for r in rows[:3]], default=list)
    )


if __name__ == "__main__":
    main()
