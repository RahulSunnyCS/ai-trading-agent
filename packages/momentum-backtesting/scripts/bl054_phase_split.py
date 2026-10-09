"""BL-054 L2, measured: each rebalance Friday alone (one pot, Rs 5 lakh) against all Fridays at
once (the same money split equally), after tax. Report only; no pass rule.

    uv run python scripts/bl054_phase_split.py run      # single-Friday curves (resumable)
    uv run python scripts/bl054_phase_split.py report   # the comparison table

The split curves are the L1 grid's `baseline__tax` (each strategy's own cadence, every phase,
Rs 5 lakh divided across them)."""

from __future__ import annotations

import sys
from pathlib import Path

import pandas as pd

sys.path.insert(0, str(Path(__file__).parent))
import bl054_levers as b  # noqa: E402

OUT = b.OUT / "phase_split"


def run() -> None:
    from momentum_backtesting import bias, search
    from momentum_backtesting.tax import TaxRules

    OUT.mkdir(parents=True, exist_ok=True)
    space = search.load_space(b.SPACE)
    runner = bias.Runner(space, universe_kind="turnover_rank", category_tags="curated")
    for task in b.tasks():
        if task["offset"] is not None:
            continue  # the ensemble's sleeves already trade one Friday each
        dest = OUT / f"curves-{task['id']}.parquet"
        if dest.exists():
            continue
        base = runner.base(task["heavy"])
        light = {k: v for k, v in task["light"].items() if k != "rebalance_offset"}
        every = int(light["rebalance_every"])
        curves, locks = {}, None
        for offset in range(every):
            outcome, ranking = runner.run(
                base,
                task["heavy"],
                light,
                locks=locks,
                rebalance_offset=offset,
                capital=b.CAPITAL,
                end=b.END,
                tax=TaxRules(),
            )
            locks = locks or runner.locks(ranking)
            curves[f"phase{offset}"] = outcome.result.equity
        pd.DataFrame(curves).to_parquet(dest)
        print(task["id"], "done", flush=True)


def stats(curve: pd.Series, lo: str | None = None, hi: str | None = None) -> dict:
    from momentum_backtesting import choose

    c = curve.dropna()
    if lo:
        c = c.loc[(c.index >= pd.Timestamp(lo) - pd.Timedelta(days=7)) & (c.index <= hi)]
    return {
        "cagr": float(choose.cagr(c)),
        "mdd": float((c / c.cummax() - 1).min()),
        "ulcer": float(choose.ulcer(c.to_frame()).iloc[0]),
    }


def report() -> None:
    rows = []
    windows = {"full": (None, None), "FY2018-22": b.DEV, "FY2023-26": b.CONF}
    for cid, name in b.NAMES.items():
        path = OUT / f"curves-{cid}.parquet"
        if not path.exists():
            continue
        phases = pd.read_parquet(path)
        phases.index = pd.to_datetime(phases.index)
        split = pd.read_parquet(b.OUT / "l1" / f"curves-{cid}.parquet")["baseline__tax"]
        split.index = pd.to_datetime(split.index)
        for win, (lo, hi) in windows.items():
            one = pd.DataFrame({p: stats(phases[p], lo, hi) for p in phases}).T
            both = stats(split, lo, hi)
            rows.append(
                {
                    "strategy": name,
                    "window": win,
                    "fridays": len(phases.columns),
                    "split_cagr": both["cagr"],
                    "single_cagr_worst": one.cagr.min(),
                    "single_cagr_best": one.cagr.max(),
                    "split_mdd": both["mdd"],
                    "single_mdd_median": one.mdd.median(),
                    "single_mdd_worst": one.mdd.min(),
                    "split_ulcer": both["ulcer"],
                    "single_ulcer_median": one.ulcer.median(),
                    "single_ulcer_worst": one.ulcer.max(),
                }
            )
    table = pd.DataFrame(rows)
    table.to_csv(OUT / "phase_split.csv", index=False)
    pct = table.copy()
    for col in pct.columns[3:]:
        pct[col] = (pct[col] * 100).round(1)
    pd.set_option("display.width", 250)
    print(pct.to_string(index=False))
    print("\nMEDIAN OVER STRATEGIES")
    print(pct.groupby("window")[list(pct.columns[3:])].median().to_string())


if __name__ == "__main__":
    {"run": run, "report": report}[sys.argv[1]]()
