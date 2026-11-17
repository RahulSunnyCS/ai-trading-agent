"""BL-233: the favourite groups with and without a 70%-above-the-200-day-EMA exit.

Pre-registered in backlog/BL-233-ema-extension-exit.md (Phase 0), committed before this ran. Every
sleeve of the 12 favourite groups in search_spaces/bl233_favourites.json (the 2026-11-16 snapshot)
runs through the same Broad path the API uses, in five arms (A none, B sell at 0.70, C trim at
0.70, D sell at 0.50, E sell at 1.00), each after tax and pre-tax. Curves land in
<MOMENTUM_DATA_DIR>/search/bl233/curves/<sleeve>.parquet, resumable per sleeve. From a worktree,
point MOMENTUM_DATA_DIR at the main checkout's data/.

    uv run python scripts/bl233_extension_exit.py run [--workers 3]
    uv run python scripts/bl233_extension_exit.py analyse     # -> search_spaces/bl233_result.json
"""

from __future__ import annotations

import argparse
import json
import multiprocessing as mp
import time
from pathlib import Path

import numpy as np
import pandas as pd

from momentum_backtesting.config import DATA_DIR

PKG = Path(__file__).resolve().parents[1]
SNAPSHOT = PKG / "search_spaces" / "bl233_favourites.json"
OUT = DATA_DIR / "search" / "bl233"
RESULT = PKG / "search_spaces" / "bl233_result.json"
ARMS = {
    "A": None,
    "B": (0.70, "sell"),
    "C": (0.70, "trim"),
    "D": (0.50, "sell"),
    "E": (1.00, "sell"),
}
TESTED = ("B", "C")
HALVES = (("2017-01-01", "2021-12-31"), ("2022-01-01", None))
HEADLINE = "b2e4bcdc"


def groups() -> list[dict]:
    favs = json.loads(SNAPSHOT.read_text())
    by_id = {f["id"]: f for f in favs}
    out = []
    for f in favs:
        if f.get("group"):
            out.append({**f, "sleeves": [by_id[m] for m in f["group"]]})
    return out


def run_sleeve(sleeve: dict) -> dict:
    from momentum_backtesting import api
    from momentum_backtesting.tax import TaxRules

    dest = OUT / "curves" / f"{sleeve['id']}.parquet"
    if dest.exists():
        return {"id": sleeve["id"], "skipped": True}
    started = time.time()
    req = api.BacktestRequest(**sleeve["config"])
    ranking = api._broad_ranking(req)
    curves, counts = {}, {}
    for arm, rule in ARMS.items():
        for taxed in (True, False):
            level, action = rule if rule else (None, "sell")
            outcome = api._run_broad(
                req,
                ranking,
                api.DATA.get(),
                tax=TaxRules() if taxed else None,
                extension_exit=level,
                extension_action=action,
            )
            name = f"{arm}__{'tax' if taxed else 'pre'}"
            curves[name] = outcome.result.equity
            trades = outcome.result.trades
            hit = trades["reason"].astype(str).str.startswith("extension") if len(trades) else []
            counts[name] = int(np.sum(hit))
    dest.parent.mkdir(parents=True, exist_ok=True)
    pd.DataFrame(curves).astype("float64").to_parquet(dest)
    (OUT / "curves" / f"{sleeve['id']}.counts.json").write_text(json.dumps(counts))
    return {"id": sleeve["id"], "name": sleeve["name"], "secs": round(time.time() - started)}


def run(workers: int) -> None:
    sleeves = {s["id"]: s for g in groups() for s in g["sleeves"]}
    todo = [s for s in sleeves.values() if not (OUT / "curves" / f"{s['id']}.parquet").exists()]
    print(f"{len(sleeves)} sleeves, {len(todo)} to run, {workers} workers", flush=True)
    ctx = mp.get_context("spawn")
    with ctx.Pool(workers, maxtasksperchild=1) as pool:
        for done in pool.imap_unordered(run_sleeve, todo):
            print(done, flush=True)


def stats(eq: pd.Series, start: str | None = None, end: str | None = None) -> dict:
    eq = eq.dropna()
    if start or end:
        eq = eq.loc[start:end]
    eq = eq / eq.iloc[0]
    years = (eq.index[-1] - eq.index[0]).days / 365.25
    dd = eq / eq.cummax() - 1
    return {
        "cagr": float(eq.iloc[-1] ** (1 / years) - 1),
        "max_dd": float(dd.min()),
        "ulcer": float(np.sqrt((dd**2).mean())),
    }


def analyse() -> None:
    rows = {}
    for g in groups():
        frames, counts = [], {}
        for s in g["sleeves"]:
            frames.append(pd.read_parquet(OUT / "curves" / f"{s['id']}.parquet"))
            for k, v in json.loads((OUT / "curves" / f"{s['id']}.counts.json").read_text()).items():
                counts[k] = counts.get(k, 0) + v
        cols = frames[0].columns
        curve = {c: pd.concat([f[c] for f in frames], axis=1).ffill().mean(axis=1) for c in cols}
        row = {"name": g["name"], "status": g["status"], "sleeves": len(frames), "arms": {}}
        for c, eq in curve.items():
            row["arms"][c] = {
                **stats(eq),
                "halves": [stats(eq, a, b)["cagr"] for a, b in HALVES],
                "actions": counts[c],
            }
        row["first"], row["last"] = (
            str(curve["A__tax"].index[0].date()),
            str(curve["A__tax"].index[-1].date()),
        )
        rows[g["id"]] = row

    out: dict = {"groups": rows, "verdict": {}}
    for basis in ("tax", "pre"):
        for arm in ("B", "C", "D", "E"):
            d_cagr, d_dd, d_ulcer, d_h = [], [], [], [[], []]
            for r in rows.values():
                a, x = r["arms"][f"A__{basis}"], r["arms"][f"{arm}__{basis}"]
                d_cagr.append(100 * (x["cagr"] - a["cagr"]))
                d_dd.append(100 * (x["max_dd"] - a["max_dd"]))
                d_ulcer.append(100 * (x["ulcer"] - a["ulcer"]))
                for h in (0, 1):
                    d_h[h].append(100 * (x["halves"][h] - a["halves"][h]))
            head = rows[next(k for k in rows if k.startswith(HEADLINE))]["arms"]
            head_cagr = 100 * (head[f"{arm}__{basis}"]["cagr"] - head[f"A__{basis}"]["cagr"])
            med = {
                "cagr": float(np.median(d_cagr)),
                "max_dd": float(np.median(d_dd)),
                "ulcer": float(np.median(d_ulcer)),
                "halves": [float(np.median(h)) for h in d_h],
                "headline_cagr": head_cagr,
                "groups_shallower": int(sum(v > 0 for v in d_dd)),
                "groups_cagr_up": int(sum(v > 0 for v in d_cagr)),
            }
            rule1 = (med["max_dd"] >= 1.0 and med["cagr"] >= -0.3) or (
                med["cagr"] >= 0.5 and med["max_dd"] >= -1.0
            )
            helps = rule1 and head_cagr >= -0.5 and min(med["halves"]) >= -0.5
            tested = arm in TESTED and basis == "tax"
            med["verdict"] = ("helps" if helps else "killed") if tested else "-"
            out["verdict"][f"{arm}__{basis}"] = med
    RESULT.write_text(json.dumps(out, indent=2) + "\n")
    for k, v in out["verdict"].items():
        print(k, {m: (round(x, 2) if isinstance(x, float) else x) for m, x in v.items()})


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("what", choices=("run", "analyse"))
    p.add_argument("--workers", type=int, default=3)
    args = p.parse_args()
    run(args.workers) if args.what == "run" else analyse()
