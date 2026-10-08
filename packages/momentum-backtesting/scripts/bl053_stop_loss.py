"""BL-053: the pre-registered stop-loss grid (search_spaces/bl053_criteria.json).

    uv run python scripts/bl053_stop_loss.py run      # every strategy x cell, resumable
    uv run python scripts/bl053_stop_loss.py report   # apply the committed rule

Each strategy's curves go to data/search/round7_A/bl053/curves-<id>.parquet (one column per
cell), and its stop counts to stops-<id>.json. The rule is read from the criteria file, never
restated here except as the column names it needs."""

from __future__ import annotations

import itertools
import json
import multiprocessing as mp
import sys
import time
from pathlib import Path

import pandas as pd

PKG = Path(__file__).resolve().parent.parent
SPACE = PKG / "search_spaces" / "round7_A.toml"
CRITERIA = json.loads((PKG / "search_spaces" / "bl053_criteria.json").read_text())
FROZEN = json.loads((PKG / "search_spaces" / "bl010_phase6_frozen.json").read_text())
RESULTS = PKG / "data" / "search" / "round7_A"
OUT = RESULTS / "bl053"
END = CRITERIA["settings"]["end"]
BASELINE = "baseline"


def cells() -> list[tuple[str, dict]]:
    grid = CRITERIA["grid"]
    out = [(BASELINE, {})]
    for buy, peak, proceeds, delay in itertools.product(
        grid["stop_from_buy"], grid["stop_from_peak"], grid["stop_proceeds"], grid["stop_delay"]
    ):
        if buy is None and peak is None:
            continue
        key = f"b{round((buy or 0) * 100)}_p{round((peak or 0) * 100)}_{proceeds}_d{delay}"
        out.append(
            (
                key,
                dict(
                    stop_from_buy=buy,
                    stop_from_peak=peak,
                    stop_proceeds=proceeds,
                    stop_delay=delay,
                ),
            )
        )
    return out


def tasks() -> list[dict]:
    records = {}
    for path in RESULTS.glob("results-*.jsonl"):
        for line in path.read_text().splitlines():
            rec = json.loads(line)
            if rec["id"] in CRITERIA["strategies"]["configs"]:
                records[rec["id"]] = rec
    out = []
    for cid in CRITERIA["strategies"]["configs"]:
        rec = records[cid]
        every = int(rec["light"]["rebalance_every"])
        out.append(
            {"id": cid, "heavy": rec["heavy"], "light": rec["light"], "offsets": list(range(every))}
        )
    for cfg in FROZEN["configs"]:  # sleeves: one phase each, the frozen one
        out.append(
            {
                "id": f"sleeve-{cfg['id']}",
                "heavy": cfg["heavy"],
                "light": cfg["light"],
                "offsets": [cfg["rebalance_offset"]],
            }
        )
    return out


def run_one(task: dict) -> dict:
    from momentum_backtesting import bias, search

    dest = OUT / f"curves-{task['id']}.parquet"
    if dest.exists():
        return {"id": task["id"], "skipped": True}
    started = time.time()
    space = search.load_space(SPACE)
    runner = bias.Runner(space, universe_kind="turnover_rank", category_tags="curated")
    base = runner.base(task["heavy"])
    capital = float(space.fixed.get("capital", 1_000_000.0))
    offsets = task["offsets"]
    locks, curves, stops = None, {}, {}
    for key, stop in cells():
        light = {k: v for k, v in task["light"].items() if k != "rebalance_offset"}
        light.update(stop)
        phases, count = [], 0
        for offset in offsets:
            outcome, ranking = runner.run(
                base,
                task["heavy"],
                light,
                locks=locks,
                rebalance_offset=offset,
                capital=capital / len(offsets),
                end=END,
            )
            locks = locks or runner.locks(ranking)
            phases.append(outcome.result.equity)
            trades = outcome.result.trades
            if not trades.empty:
                count += int(trades["reason"].astype(str).str.startswith("stop").sum())
        curves[key] = pd.concat(phases, axis=1).mean(axis=1)
        stops[key] = count
    pd.DataFrame(curves).astype("float64").to_parquet(dest)
    (OUT / f"stops-{task['id']}.json").write_text(json.dumps(stops))
    return {"id": task["id"], "secs": round(time.time() - started)}


def run(workers: int = 4) -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    todo = tasks()
    print(f"{len(todo)} strategies x {len(cells())} cells, {workers} workers", flush=True)
    ctx = mp.get_context("spawn")
    with ctx.Pool(workers, maxtasksperchild=1) as pool:
        for done in pool.imap_unordered(run_one, todo):
            print(done, flush=True)


# --- the rule ------------------------------------------------------------------------------------


def strategy_curves() -> dict[str, pd.DataFrame]:
    from momentum_backtesting import choose

    out = {}
    for cid in CRITERIA["strategies"]["configs"]:
        out[cid] = pd.read_parquet(OUT / f"curves-{cid}.parquet")
    sleeves = {
        cfg["id"]: pd.read_parquet(OUT / f"curves-sleeve-{cfg['id']}.parquet")
        for cfg in FROZEN["configs"]
    }
    keys = next(iter(sleeves.values())).columns
    ids = list(sleeves)
    out["ensemble"] = pd.DataFrame(
        {
            key: choose.ensemble_curve(pd.DataFrame({s: sleeves[s][key] for s in ids}), ids)
            for key in keys
        }
    )
    return out


def metrics(curves: dict[str, pd.DataFrame]) -> pd.DataFrame:
    from momentum_backtesting import choose
    from momentum_backtesting import reference_benchmarks as rb

    refs = rb.load_references()
    rows = []
    for name, frame in curves.items():
        frame = frame.dropna(how="all")
        mom = refs[rb.NIFTY200_MOMENTUM30_TRI].reindex(frame.index).ffill()
        fys = [fy for fy in choose.complete_fys(frame.index) if 2018 <= fy <= 2026]
        third = choose.lower_bound(choose.fy_excess(frame, mom, fys))
        dd = (frame / frame.cummax() - 1).min()
        for key in frame.columns:
            rows.append(
                {
                    "strategy": name,
                    "cell": key,
                    "cagr": float(choose.cagr(frame[key])),
                    "max_drawdown": float(dd[key]),
                    "ulcer": float(choose.ulcer(frame[[key]]).iloc[0]),
                    "third_worst_fy": float(third[key]),
                }
            )
    return pd.DataFrame(rows)


def judge(table: pd.DataFrame) -> pd.DataFrame:
    base = table[table.cell == BASELINE].set_index("strategy")
    n = base.shape[0]
    rows = []
    for key in sorted(set(table.cell) - {BASELINE}):
        cell = table[table.cell == key].set_index("strategy").loc[base.index]
        better = (cell.ulcer < base.ulcer) & (cell.max_drawdown > base.max_drawdown)
        dcagr = cell.cagr - base.cagr
        rows.append(
            {
                "cell": key,
                "risk_better": int(better.sum()),
                "median_cagr_change": float(dcagr.median()),
                "median_third_worst": float(cell.third_worst_fy.median()),
                "baseline_median_third_worst": float(base.third_worst_fy.median()),
                "median_ulcer_change": float((cell.ulcer - base.ulcer).median()),
                "median_mdd_change": float((cell.max_drawdown - base.max_drawdown).median()),
                "a": bool(better.sum() >= 7),
                "b": bool(dcagr.median() >= -0.02),
                "c": bool(cell.third_worst_fy.median() >= base.third_worst_fy.median()),
                "strategies": n,
            }
        )
    out = pd.DataFrame(rows)
    out["passes_this_delay"] = out.a & out.b & out.c
    out["pair"] = out.cell.str.replace(r"_d\d$", "", regex=True)
    both = out.groupby("pair").passes_this_delay.all()
    out["passes"] = out.pair.map(both)
    return out


def report() -> None:
    table = metrics(strategy_curves())
    table.to_csv(OUT / "metrics.csv", index=False)
    verdicts = judge(table)
    verdicts.to_csv(OUT / "cells.csv", index=False)
    passing = sorted(verdicts[verdicts.passes].pair.unique())
    n = len(passing)
    rule = CRITERIA["verdict"]
    verdict = "helps" if n >= 10 else ("inconclusive" if n else "kill")
    result = {"cells_passing": n, "of": 30, "verdict": verdict, "passing": passing, "rule": rule}
    (OUT / "result.json").write_text(json.dumps(result, indent=1))
    pd.set_option("display.width", 220)
    print(json.dumps(result, indent=1))
    show = verdicts.sort_values(["pair", "cell"])[
        [
            "cell",
            "risk_better",
            "median_cagr_change",
            "median_ulcer_change",
            "median_mdd_change",
            "median_third_worst",
            "a",
            "b",
            "c",
            "passes",
        ]
    ]
    print(show.to_string(index=False))
    print("baseline median third-worst FY", verdicts.baseline_median_third_worst.iloc[0])


# --- report-only check: the ensemble's sleeves replayed at the next open ------------------------


def monday(cell_keys: list[str]) -> None:
    """Bundles for each sleeve under the baseline and each named cell (delay 0), then the audit
    replay's Monday-open study on them (criteria `monday_open_check`)."""
    import subprocess

    from momentum_backtesting import bias, search
    from momentum_backtesting.audit.bundle import build_bundle
    from momentum_backtesting.engine import CASH

    wanted = dict(cells())
    keys = [BASELINE, *cell_keys]
    dest = OUT / "monday"
    dest.mkdir(parents=True, exist_ok=True)
    space = search.load_space(SPACE)
    runner = bias.Runner(space, universe_kind="turnover_rank", category_tags="curated")
    paths = []
    for cfg in FROZEN["configs"]:
        base = runner.base(cfg["heavy"])
        light = {k: v for k, v in cfg["light"].items() if k != "rebalance_offset"}
        for key in keys:
            path = dest / f"{cfg['id']}-{key}__monday.json"
            paths.append(path)
            if path.exists():
                continue
            outcome, ranking = runner.run(
                base,
                cfg["heavy"],
                {**light, **wanted[key]},
                rebalance_offset=cfg["rebalance_offset"],
                end=END,
            )
            prices = ranking.prices.ffill()
            prices[CASH] = runner.common["outer_prices"].reindex(prices.index)[CASH]
            bundle = build_bundle(
                outcome.result,
                prices=prices,
                column_to_base_symbol=ranking.column_to_base_symbol,
                events=ranking.events,
                label=f"{cfg['id']}-{key}",
                run_id=cfg["id"],
                variant="monday",
            )
            path.write_text(json.dumps(bundle, indent=1, default=str))
            print("bundle", path.name, flush=True)
    subprocess.run(
        [
            "uv",
            "run",
            "mbt",
            "audit",
            "study",
            *map(str, paths),
            "--what",
            "monday-open",
            "--out",
            str(dest / "studies"),
        ],
        check=True,
    )


if __name__ == "__main__":
    if sys.argv[1] == "monday":
        monday(sys.argv[2:])
    else:
        {"run": run, "report": report}[sys.argv[1]]()
