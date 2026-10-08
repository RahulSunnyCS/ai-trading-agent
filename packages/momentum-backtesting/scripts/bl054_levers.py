"""BL-054: the pre-registered improvement levers (search_spaces/bl054_criteria.json).

    uv run python scripts/bl054_levers.py l1        # cadence x tax-hold, pre- and after-tax
    uv run python scripts/bl054_levers.py l4        # daily stop (needs the engine's daily stop)
    uv run python scripts/bl054_levers.py l5        # inverse-vol sizing
    uv run python scripts/bl054_levers.py report    # apply the committed rules

Curves per strategy go to data/search/round7_A/bl054/<lever>/curves-<id>.parquet, one column
per cell, named `<cell>__pre` and `<cell>__tax`. Resumable per strategy."""

from __future__ import annotations

import json
import multiprocessing as mp
import sys
import time
from pathlib import Path

import pandas as pd

PKG = Path(__file__).resolve().parent.parent
SPACE = PKG / "search_spaces" / "round7_A.toml"
CRITERIA = json.loads((PKG / "search_spaces" / "bl054_criteria.json").read_text())
NAMES = json.loads((PKG / "search_spaces" / "bl053_criteria.json").read_text())["strategies"][
    "configs"
]
FROZEN = json.loads((PKG / "search_spaces" / "bl010_phase6_frozen.json").read_text())
RESULTS = PKG / "data" / "search" / "round7_A"
OUT = RESULTS / "bl054"
END = CRITERIA["settings"]["end"]
CAPITAL = 500_000.0
DEV = ("2017-04-01", "2022-03-31")
CONF = ("2022-04-01", "2026-03-31")


def tasks() -> list[dict]:
    records = {}
    for path in RESULTS.glob("results-*.jsonl"):
        for line in path.read_text().splitlines():
            rec = json.loads(line)
            if rec["id"] in NAMES:
                records[rec["id"]] = rec
    out = [
        {"id": cid, "heavy": records[cid]["heavy"], "light": records[cid]["light"], "offset": None}
        for cid in NAMES
    ]
    out += [
        {
            "id": f"sleeve-{c['id']}",
            "heavy": c["heavy"],
            "light": c["light"],
            "offset": c["rebalance_offset"],
        }
        for c in FROZEN["configs"]
    ]
    return out


# --- cells per lever ---


def l1_cells(own_every: int) -> list[tuple[str, dict]]:
    out = [("baseline", {})]
    for every in (4, 6, 8, 13):
        if every != own_every:
            out.append((f"every{every}", {"rebalance_every": every}))
    for every in dict.fromkeys((own_every, 4, 6, 8, 13)):
        out.append(
            (
                f"every{every}_hold",
                {"rebalance_every": every, "tax_hold_band": 2, "tax_hold_weeks": 8},
            )
        )
    return out


def l4_cells(_: int) -> list[tuple[str, dict]]:
    """Addendum 1: buy stops off/15/20/25 x peak stops off/25/30, both-off excluded."""
    out = [("baseline", {})]
    for buy in (None, 0.15, 0.20, 0.25):
        for peak in (None, 0.25, 0.30):
            if buy is None and peak is None:
                continue
            key = f"b{round((buy or 0) * 100)}_p{round((peak or 0) * 100)}"
            out.append(
                (
                    key,
                    dict(
                        stop_from_buy=buy,
                        stop_from_peak=peak,
                        stop_proceeds="cash",
                        stop_delay=0,
                        stop_granularity="daily",
                    ),
                )
            )
    return out


def l5_cells(_: int) -> list[tuple[str, dict]]:
    return [("baseline", {}), ("inverse_vol", {"weight_by": "inverse_vol"})]


def l6_cells(_: int) -> list[tuple[str, dict]]:
    # `score` is a heavy key: run_one rebuilds the base ranking for this cell.
    return [("baseline", {}), ("residual", {"score": "residual"})]


LEVERS = {"l1": l1_cells, "l4": l4_cells, "l5": l5_cells, "l6": l6_cells}


def run_one(task: dict) -> dict:
    from momentum_backtesting import bias, search
    from momentum_backtesting.tax import TaxRules

    lever = task["lever"]
    dest = OUT / lever / f"curves-{task['id']}.parquet"
    if dest.exists():
        return {"id": task["id"], "lever": lever, "skipped": True}
    started = time.time()
    space = search.load_space(SPACE)
    runner = bias.Runner(space, universe_kind="turnover_rank", category_tags="curated")
    base = runner.base(task["heavy"])
    own_every = int(task["light"]["rebalance_every"])
    light0 = {k: v for k, v in task["light"].items() if k != "rebalance_offset"}
    locks, curves, counts = None, {}, {}
    for key, cell in LEVERS[lever](own_every):
        heavy_part = {k: v for k, v in cell.items() if k in search.HEAVY_KEYS}
        light = {**light0, **{k: v for k, v in cell.items() if k not in search.HEAVY_KEYS}}
        heavy = {**task["heavy"], **heavy_part}
        cell_base = runner.base(heavy) if heavy_part else base
        every = int(light.get("rebalance_every", own_every))
        offsets = list(range(every)) if task["offset"] is None else [task["offset"] % every]
        for taxed in (False, True):
            if "tax_hold_band" in cell and not taxed:
                continue  # inert pre-tax
            phases, count = [], 0
            for offset in offsets:
                outcome, ranking = runner.run(
                    cell_base,
                    heavy,
                    light,
                    locks=locks,
                    rebalance_offset=offset,
                    capital=CAPITAL / len(offsets),
                    end=END,
                    tax=TaxRules() if taxed else None,
                )
                locks = locks or runner.locks(ranking)
                phases.append(outcome.result.equity)
                trades = outcome.result.trades
                if not trades.empty:
                    count += int(trades["reason"].astype(str).str.startswith("stop").sum())
            name = f"{key}__{'tax' if taxed else 'pre'}"
            curves[name] = pd.concat(phases, axis=1).mean(axis=1)
            counts[name] = count
    dest.parent.mkdir(parents=True, exist_ok=True)
    pd.DataFrame(curves).astype("float64").to_parquet(dest)
    (OUT / lever / f"stops-{task['id']}.json").write_text(json.dumps(counts))
    return {"id": task["id"], "lever": lever, "secs": round(time.time() - started)}


def run(lever: str, workers: int = 4) -> None:
    todo = [{**t, "lever": lever} for t in tasks()]
    print(f"{lever}: {len(todo)} strategies, {workers} workers", flush=True)
    ctx = mp.get_context("spawn")
    with ctx.Pool(workers, maxtasksperchild=1) as pool:
        for done in pool.imap_unordered(run_one, todo):
            print(done, flush=True)


# --- the rules ---


def strategy_curves(lever: str) -> dict[str, pd.DataFrame]:
    from momentum_backtesting import choose

    out = {cid: pd.read_parquet(OUT / lever / f"curves-{cid}.parquet") for cid in NAMES}
    sleeves = {
        c["id"]: pd.read_parquet(OUT / lever / f"curves-sleeve-{c['id']}.parquet")
        for c in FROZEN["configs"]
    }
    ids = list(sleeves)
    keys = next(iter(sleeves.values())).columns
    out["ensemble"] = pd.DataFrame(
        {k: choose.ensemble_curve(pd.DataFrame({s: sleeves[s][k] for s in ids}), ids) for k in keys}
    )
    for frame in out.values():
        frame.index = pd.to_datetime(frame.index)
    return out


def window(frame: pd.DataFrame, lo: str, hi: str) -> pd.DataFrame:
    lo_ts = pd.Timestamp(lo) - pd.Timedelta(days=7)
    return frame.loc[(frame.index >= lo_ts) & (frame.index <= pd.Timestamp(hi))]


def metrics(curves: dict[str, pd.DataFrame], lo: str, hi: str) -> pd.DataFrame:
    from momentum_backtesting import choose
    from momentum_backtesting import reference_benchmarks as rb

    refs = rb.load_references()
    rows = []
    for name, frame in curves.items():
        frame = window(frame.dropna(how="all"), lo, hi)
        mom = refs[rb.NIFTY200_MOMENTUM30_TRI].reindex(frame.index).ffill()
        fys = [fy for fy in choose.complete_fys(frame.index) if lo[:4] < str(fy) <= hi[:4]]
        excess = choose.fy_excess(frame, mom, fys)
        third = excess.quantile(0.25, axis=0)
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


def judge(table: pd.DataFrame, lever: str) -> pd.DataFrame:
    rows = []
    for taxed in ("pre", "tax"):
        base = table[table.cell == f"baseline__{taxed}"].set_index("strategy")
        for key in sorted(
            {c for c in table.cell if c.endswith(f"__{taxed}") and not c.startswith("baseline")}
        ):
            cell = table[table.cell == key].set_index("strategy").loc[base.index]
            better = (cell.ulcer < base.ulcer) & (cell.max_drawdown > base.max_drawdown)
            dcagr = cell.cagr - base.cagr
            dulcer = cell.ulcer - base.ulcer
            row = {
                "cell": key,
                "less_pain": int(better.sum()),
                "cagr_not_lower": int((dcagr >= 0).sum()),
                "median_cagr_change": float(dcagr.median()),
                "median_ulcer_change": float(dulcer.median()),
                "median_mdd_change": float((cell.max_drawdown - base.max_drawdown).median()),
                "median_third_worst": float(cell.third_worst_fy.median()),
                "baseline_third_worst": float(base.third_worst_fy.median()),
                "baseline_cagr": float(base.cagr.median()),
            }
            if lever == "l1":
                row["passes"] = bool(
                    taxed == "tax"
                    and dcagr.median() >= 0.015
                    and dulcer.median() <= 0.01
                    and (dcagr >= 0).sum() >= 7
                )
            else:
                row["passes"] = bool(
                    taxed == "tax"
                    and better.sum() >= 7
                    and dcagr.median() >= -0.02
                    and cell.third_worst_fy.median() >= base.third_worst_fy.median()
                )
            rows.append(row)
    return pd.DataFrame(rows)


def report(lever: str) -> dict:
    curves = strategy_curves(lever)
    dev = judge(metrics(curves, *DEV), lever)
    conf = judge(metrics(curves, *CONF), lever)
    dev.to_csv(OUT / lever / "cells_dev.csv", index=False)
    conf.to_csv(OUT / lever / "cells_conf.csv", index=False)
    passing = dev[dev.passes].cell.tolist()
    confirmed = []
    for key in passing:
        c = conf[conf.cell == key].iloc[0]
        if lever == "l1":
            ok = c.median_cagr_change >= 0
        else:
            ok = c.less_pain >= 6 and c.median_cagr_change >= -0.02
        if ok:
            confirmed.append(key)
    result = {"lever": lever, "dev_pass": passing, "confirmed": confirmed}
    pd.set_option("display.width", 220)
    cols = [
        "cell",
        "less_pain",
        "cagr_not_lower",
        "median_cagr_change",
        "median_ulcer_change",
        "median_mdd_change",
        "median_third_worst",
        "baseline_third_worst",
        "passes",
    ]
    print("DEVELOPMENT FY2018-FY2022")
    print(dev[cols].round(4).to_string(index=False))
    print("CONFIRMATION FY2023-FY2026")
    print(conf[cols].round(4).to_string(index=False))
    print(json.dumps(result))
    return result


if __name__ == "__main__":
    if sys.argv[1] == "report":
        report(sys.argv[2])
    else:
        run(sys.argv[1])
