"""Steady highs: pick strategies whose equity curve keeps making new highs, even in weak markets.

The rules here are fixed in `round5_criteria.json`, written before any duration data was seen:

  1. Selection (from the full-period re-score, `rescore.py`):
       - max drawdown no deeper than -35%, turnover <= 3x, >= 10 buys a year
       - the longest stretch below a previous high is at most U weeks
         (U = 52; if fewer than 40 candidates remain it is relaxed to 65, 78, then 104 - nothing
         else is relaxed)
       - in EACH weak window (2017-2019 and 2024-latest): the window CAGR is at least the
         Nifty200 Momentum 30 TRI's over the same window, and at least 15% of the weeks set a new
         equity high
     ranked by full-period CAGR, top 40.
  2. The nudge test (`robust.py`) keeps those that survive being perturbed.
  3. Finalists: the top 10 survivors. A finalist is a *Winner* if all of:
       - each of the blocks 2017-19, 2020-22, 2023-26 has CAGR >= the Nifty200 Momentum 30 TRI's
       - the random-ranking placebo trails it by >= 8 percentage points (full period)
       - after-tax full-period CAGR >= the Nifty 50 TRI's + 5 percentage points

None of this has a clean hold-out: the weak 2024+ stretch is inside the period Round 4 opened.
"""

from __future__ import annotations

import dataclasses
import json
import multiprocessing as mp
import os
import time
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd

from . import bias, final, search
from . import tax as tax_mod
from .engine import IDLE

LADDER = (52, 65, 78, 104)
MIN_CANDIDATES = 40
HURDLE = "Nifty200 Momentum 30 TRI"
NIFTY = "Nifty 50 TRI"
PLACEBO_SEEDS = 3
UW = "uw_max_underwater_weeks"


# --- selection --------------------------------------------------------------------------------


def passes_filters(df: pd.DataFrame, cap_weeks: int, relaxed: bool = False) -> pd.Series:
    """Rows meeting every selection filter for a given longest-time-under-water cap.

    The strict track is the pre-registered one: each weak window's CAGR must match the Nifty200
    Momentum 30 TRI's. `relaxed` (a post-hoc second track, added after seeing that the strict one
    leaves only a handful of candidates) only asks each weak window to grow (> 0) - the new-high
    share, depth, turnover and time-under-water rules are unchanged."""
    ok = (df["mdd"] >= -0.35) & (df["turnover_x"] <= 3) & (df["buys_per_yr"] >= 10)
    ok &= df[UW] <= cap_weeks
    for w in ("w1", "w2"):
        ok &= (df[f"{w}_cagr"] > 0) if relaxed else (df[f"{w}_cagr"] >= df[f"hurdle_{w}|{HURDLE}"])
        ok &= df[f"{w}_newhigh"] >= 0.15
    return ok


def select_candidates(
    df: pd.DataFrame, top: int = 40, relaxed: bool = False
) -> tuple[pd.DataFrame, int, dict[int, int]]:
    """(chosen rows, the cap actually used, how many passed at each cap tried)."""
    counts: dict[int, int] = {}
    used = LADDER[-1]
    for cap in LADDER:
        counts[cap] = int(passes_filters(df, cap, relaxed).sum())
        if counts[cap] >= MIN_CANDIDATES:
            used = cap
            break
    chosen = df[passes_filters(df, used, relaxed)].sort_values("cagr", ascending=False).head(top)
    return chosen, used, counts


# --- validation of the finalists -------------------------------------------------------------


def validate_one(task: dict[str, Any]) -> dict[str, Any]:
    space = search.load_space(Path(task["space_path"]))
    rec = task["rec"]
    heavy, light = rec["heavy"], rec["light"]
    runner = bias.Runner(space)
    started = time.time()
    base = runner.base(heavy)
    out, ranking = runner.run(base, heavy, light)
    locks = runner.locks(ranking)
    eq, cash = out.result.equity, out.result.cash
    weekly = eq.pct_change()
    excess = weekly - cash.reindex(weekly.index).pct_change()
    row: dict[str, Any] = {
        "cid": rec["id"],
        "label": task["label"],
        "heavy": heavy,
        "light": light,
        "full": search.run_metrics(out.result, IDLE),
        "hurdles_full": runner.hurdles(eq),
        "weekly_excess": [round(float(x), 6) for x in excess.dropna()],
    }
    taxed, _ = runner.run(base, heavy, light, locks=locks, tax=tax_mod.TaxRules())
    row["full_after_tax"] = search.run_metrics(taxed.result, IDLE)
    placebo = []
    for seed in range(PLACEBO_SEEDS):
        fake = dataclasses.replace(base, global_ranks=bias.shuffled_ranks(base.global_ranks, seed))
        o, _ = runner.run(fake, heavy, light, locks=locks)
        placebo.append(search.run_metrics(o.result, IDLE))
    row["placebo"] = placebo
    strict = runner.base(heavy, **final.STRICT)
    o, _ = runner.run(strict, heavy, light)
    row["strict_liquidity"] = search.run_metrics(o.result, IDLE)
    row["secs"] = round(time.time() - started, 1)
    with (Path(task["out_dir"]) / f"steady-{os.getpid()}.jsonl").open("a") as sink:
        sink.write(json.dumps(row, default=float) + "\n")
    return {"label": task["label"], "cid": rec["id"], "secs": row["secs"]}


def run_validation(
    results_dir: Path,
    space_path: Path,
    finalists: dict[str, str],
    out_dir: Path,
    *,
    workers: int = 3,
    echo=print,
) -> None:
    records = bias.load_records(results_dir, set(finalists.values()))
    out_dir.mkdir(parents=True, exist_ok=True)
    seen = {
        json.loads(line)["cid"]
        for p in out_dir.glob("steady-*.jsonl")
        for line in p.read_text().splitlines()
        if line.startswith("{")
    }
    tasks = [
        {
            "space_path": str(Path(space_path).resolve()),
            "out_dir": str(out_dir),
            "rec": records[cid],
            "label": label,
        }
        for label, cid in finalists.items()
        if cid in records and cid not in seen
    ]
    echo(f"{len(finalists)} finalists, {len(seen)} already done, {len(tasks)} to run")
    with mp.get_context("spawn").Pool(workers, maxtasksperchild=1) as pool:
        for s in pool.imap_unordered(validate_one, tasks):
            echo(f"  {s['label']} ({s['cid']}): {s['secs']} s")


def load_validation(out_dir: Path) -> list[dict[str, Any]]:
    rows = []
    for path in sorted(Path(out_dir).glob("steady-*.jsonl")):
        rows += [json.loads(x) for x in path.read_text().splitlines() if x.startswith("{")]
    return rows


def evaluate(
    rows: list[dict[str, Any]], rescored: pd.DataFrame, trial_sharpes: np.ndarray, n_trials: int
) -> pd.DataFrame:
    """The Winner test from round5_criteria.json, plus the deflated Sharpe (reported only)."""
    by_id = rescored.set_index("id")
    out = []
    for r in rows:
        s = by_id.loc[r["cid"]]
        blocks = {b: (s[f"{b}_cagr"], s[f"hurdle_{b}|{HURDLE}"]) for b in ("b1", "b2", "b3")}
        v1 = all(c >= h for c, h in blocks.values())
        placebo = float(np.mean([p["cagr"] for p in r["placebo"]]))
        gap = r["full"]["cagr"] - placebo
        nifty = r["hurdles_full"].get(NIFTY, np.nan)
        after = r["full_after_tax"]["cagr"]
        dsr = final.deflated_sharpe(np.array(r["weekly_excess"]), trial_sharpes, n_trials)
        out.append(
            {
                "label": r["label"],
                "cid": r["cid"],
                "cagr": r["full"]["cagr"],
                "mdd": r["full"]["mdd"],
                "turnover": r["full"]["turnover_x"],
                "uw_weeks": r["full"][UW],
                "recovery_weeks": r["full"]["uw_recovery_weeks"],
                "w1_newhigh": s["w1_newhigh"],
                "w2_newhigh": s["w2_newhigh"],
                "b1": blocks["b1"][0],
                "b2": blocks["b2"][0],
                "b3": blocks["b3"][0],
                "b1_h": blocks["b1"][1],
                "b2_h": blocks["b2"][1],
                "b3_h": blocks["b3"][1],
                "placebo": placebo,
                "placebo_gap": gap,
                "cagr_after_tax": after,
                "nifty50_tri": nifty,
                "strict_liq_cagr": r["strict_liquidity"]["cagr"],
                "v1_no_block_lags": bool(v1),
                "v2_placebo_gap_8": bool(gap >= 0.08),
                "v3_aftertax_beats_nifty_by_5": bool(after >= nifty + 0.05),
                "winner": bool(v1 and gap >= 0.08 and after >= nifty + 0.05),
                "dsr": dsr["dsr"],
            }
        )
    return pd.DataFrame(out)
