"""Round 4: the one-time out-of-sample test of the finalists.

The tuning rounds ran on 2017 -> 2022-12-31 only. This opens the sealed period (2023 -> latest) for
a short list of finalists chosen *from the tuning window alone*, against criteria written down
before it was opened (`round4_criteria.json`). It is a one-way door: looking at the sealed data
and then changing the finalists or the criteria would turn it back into tuning, so this refuses to
run without `--open-sealed`, and writes `UNSEALED.json` (who/when/which configs) the first time.

Per finalist it reports:
  in-sample    2017 -> 2022 pre-tax and after-tax CAGR (the number the search saw)
  out-of-sample 2023 -> latest, pre-tax and after-tax, with the total-return benchmarks over the
               same window
  placebo      the same config on random momentum ranks, out of sample
  liquidity    a much stricter tradeability gate, out of sample (reported, not pass/fail)
  full period  2017 -> latest, pre-tax and after-tax
  deflated Sharpe  how likely the in-sample Sharpe is to beat the best of ~N random trials
"""

from __future__ import annotations

import dataclasses
import json
import math
import multiprocessing as mp
import os
import time
from datetime import datetime
from pathlib import Path
from statistics import NormalDist
from typing import Any

import numpy as np
import pandas as pd

from . import bias, search
from . import tax as tax_mod
from .engine import IDLE

OOS = {"start": "2023-01-01", "end": None}
FULL = {"start": "2017-01-01", "end": None}
STRICT = {"liq_min_turnover_cr": 10.0, "liq_min_price": 100.0}
PLACEBO_SEEDS = 3
EULER_GAMMA = 0.5772156649


# --- deflated Sharpe ratio -------------------------------------------------------------------


def deflated_sharpe(
    weekly_excess: np.ndarray, trial_sharpes: np.ndarray, n_trials: int
) -> dict[str, float]:
    """Bailey & Lopez de Prado's deflated Sharpe ratio, in weekly units.

    `trial_sharpes` are the weekly Sharpe ratios of the other configs tried (their spread says how
    much a lucky draw is worth); `n_trials` is how many configs were tried in total. Returns the
    probability that the true Sharpe is above what the best of that many random trials would show.
    """
    r = np.asarray(weekly_excess, dtype=float)
    r = r[~np.isnan(r)]
    t = len(r)
    sr = r.mean() / r.std(ddof=1)
    z = (r - r.mean()) / r.std(ddof=1)
    skew, kurt = float((z**3).mean()), float((z**4).mean())
    var = float(np.nanvar(trial_sharpes, ddof=1))
    nd = NormalDist()
    sr0 = math.sqrt(var) * (
        (1 - EULER_GAMMA) * nd.inv_cdf(1 - 1 / n_trials)
        + EULER_GAMMA * nd.inv_cdf(1 - 1 / (n_trials * math.e))
    )
    denom = math.sqrt(max(1 - skew * sr + (kurt - 1) / 4 * sr**2, 1e-12))
    dsr = nd.cdf((sr - sr0) * math.sqrt(t - 1) / denom)
    return {
        "sharpe_week": float(sr),
        "sr0_week": sr0,
        "dsr": float(dsr),
        "weeks": t,
        "skew": skew,
        "kurtosis": kurt,
    }


# --- running ---------------------------------------------------------------------------------


def _slim(result, extra: dict[str, Any] | None = None) -> dict[str, Any]:
    m = search.run_metrics(result, IDLE)
    return {**m, **(extra or {})}


def run_finalist(task: dict[str, Any]) -> dict[str, Any]:
    space = search.load_space(Path(task["space_path"]))
    rec = task["rec"]
    heavy, light = rec["heavy"], rec["light"]
    runner = bias.Runner(space)
    started = time.time()
    base = runner.base(heavy)
    out_in, ranking = runner.run(base, heavy, light)
    locks = runner.locks(ranking)
    tax = tax_mod.TaxRules()
    row: dict[str, Any] = {"cid": rec["id"], "label": task["label"], "heavy": heavy, "light": light}

    weekly = out_in.result.equity.pct_change()
    excess = weekly - out_in.result.cash.reindex(weekly.index).pct_change()
    row["insample"] = _slim(out_in.result)
    row["insample_weekly_excess"] = [round(float(x), 6) for x in excess.dropna()]
    taxed, _ = runner.run(base, heavy, light, locks=locks, tax=tax)
    row["insample_after_tax"] = _slim(taxed.result)

    oos, _ = runner.run(base, heavy, light, locks=locks, **OOS)
    row["oos"] = _slim(oos.result)
    row["oos_hurdles"] = runner.hurdles(oos.result.equity)
    oos_tax, _ = runner.run(base, heavy, light, locks=locks, tax=tax, **OOS)
    row["oos_after_tax"] = _slim(oos_tax.result)

    placebo = []
    for seed in range(PLACEBO_SEEDS):
        fake = dataclasses.replace(base, global_ranks=bias.shuffled_ranks(base.global_ranks, seed))
        out, _ = runner.run(fake, heavy, light, locks=locks, **OOS)
        placebo.append(_slim(out.result))
    row["oos_placebo"] = placebo

    strict = runner.base(heavy, **STRICT)
    out, _ = runner.run(strict, heavy, light, **OOS)
    row["oos_strict_liquidity"] = _slim(out.result)

    full, _ = runner.run(base, heavy, light, locks=locks, **FULL)
    row["full"] = _slim(full.result)
    full_tax, _ = runner.run(base, heavy, light, locks=locks, tax=tax, **FULL)
    row["full_after_tax"] = _slim(full_tax.result)
    row["secs"] = round(time.time() - started, 1)
    out_path = Path(task["out_dir"]) / f"final-{os.getpid()}.jsonl"
    with out_path.open("a") as sink:
        sink.write(json.dumps(row, default=float) + "\n")
    return {"cid": rec["id"], "label": task["label"], "secs": row["secs"]}


def run_final(
    results_dir: Path,
    space_path: Path,
    finalists_file: Path,
    *,
    open_sealed: bool,
    workers: int = 4,
    echo=print,
) -> None:
    results_dir = Path(results_dir)
    if not open_sealed:
        raise SystemExit(
            "This opens the sealed 2023+ period for the finalists in "
            f"{finalists_file}. Re-run with --open-sealed to confirm."
        )
    finalists: dict[str, str] = json.loads(Path(finalists_file).read_text())
    criteria = results_dir / "round4_criteria.json"
    if not criteria.exists():
        raise SystemExit(f"{criteria} must exist (written BEFORE opening the sealed period).")
    marker = results_dir / "UNSEALED.json"
    if not marker.exists():
        marker.write_text(
            json.dumps(
                {
                    "opened_at": datetime.now().astimezone().isoformat(timespec="seconds"),
                    "finalists": finalists,
                    "criteria_file": criteria.name,
                },
                indent=1,
            )
        )
        echo(f"OPENING THE SEALED PERIOD (first time) - recorded in {marker.name}")
    records = bias.load_records(results_dir, set(finalists.values()))
    out_dir = results_dir / "round4"
    out_dir.mkdir(exist_ok=True)
    seen = {
        json.loads(line)["cid"]
        for p in out_dir.glob("final-*.jsonl")
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
    ctx = mp.get_context("spawn")
    with ctx.Pool(workers, maxtasksperchild=1) as pool:
        for summary in pool.imap_unordered(run_finalist, tasks):
            echo(f"  {summary['label']} ({summary['cid']}): {summary['secs']} s")


# --- verdicts --------------------------------------------------------------------------------


def load_final(out_dir: Path) -> list[dict[str, Any]]:
    rows = []
    for path in sorted(Path(out_dir).glob("final-*.jsonl")):
        rows += [json.loads(line) for line in path.read_text().splitlines() if line.startswith("{")]
    return rows


def evaluate(rows: list[dict[str, Any]], trial_sharpes: np.ndarray, n_trials: int) -> pd.DataFrame:
    """Apply the pre-registered criteria (see round4_criteria.json) and the deflated Sharpe."""
    out = []
    for r in rows:
        h = r["oos_hurdles"]
        mom = h.get("Nifty200 Momentum 30 TRI", np.nan)
        nifty = h.get("Nifty 50 TRI", np.nan)
        oos, taxed = r["oos"], r["oos_after_tax"]
        placebo = float(np.mean([p["cagr"] for p in r["oos_placebo"]]))
        c1 = oos["cagr"] >= mom + 0.03
        c2 = oos["mdd"] >= -0.30
        c3 = oos["cagr"] - placebo >= 0.08
        c4 = taxed["cagr"] > nifty
        dsr = deflated_sharpe(np.array(r["insample_weekly_excess"]), trial_sharpes, n_trials)
        out.append(
            {
                "label": r["label"],
                "cid": r["cid"],
                "in_cagr": r["insample"]["cagr"],
                "in_cagr_tax": r["insample_after_tax"]["cagr"],
                "oos_cagr": oos["cagr"],
                "oos_mdd": oos["mdd"],
                "oos_turnover": oos["turnover_x"],
                "oos_cagr_tax": taxed["cagr"],
                "mom30_tri": mom,
                "nifty50_tri": nifty,
                "placebo_cagr": placebo,
                "oos_strict_liq": r["oos_strict_liquidity"]["cagr"],
                "full_cagr_tax": r["full_after_tax"]["cagr"],
                "c1_beats_mom30_by_3": bool(c1),
                "c2_dd_ok": bool(c2),
                "c3_placebo_gap_8": bool(c3),
                "c4_aftertax_beats_nifty": bool(c4),
                "passes": bool(c1 and c2 and c3 and c4),
                "dsr": dsr["dsr"],
            }
        )
    return pd.DataFrame(out)


def reading(passes: int, total: int) -> str:
    """The pre-registered interpretation (round4_criteria.json), scaled to the finalist count."""
    share = passes / total if total else 0.0
    if share <= 0.2:
        return "the in-sample edge did not generalise"
    if share <= 0.6:
        return "partial: some real edge, expect well below in-sample numbers"
    return "edge generalises on this window (still only one window)"
