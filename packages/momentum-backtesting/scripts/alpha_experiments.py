"""Momentum alpha experiments on real local data (TODO 3.9.23, Step 1; Step 2 adds the reversal
sleeve in reversal_experiment.py).

Every variant is a fresh backtest started at each of 28 rolling 3-year windows (2017-01 to
2026-09, one every 13 weeks) plus the full / last-5y / last-3y windows, scored against its
dataset's baseline with `sweep.compare_rolling`, and given a deflated Sharpe ratio across all
variants tried on that dataset. A lever is only worth adopting if it `wins most` (better Sharpe
AND CAGR in over half the rolling windows), not because one full-sample number is higher.

Baselines:
- etf: the live job's strategy (`live_config.toml`: top 5 / exit 10, equal-weight 1/4/13/26/52,
  buffer + wait, 35% cap, 0.10% cost, ETF prices, Friday close).
- broad: Broad Momentum with the dashboard's defaults (pool 200/250, coverage 0.40, categories
  4/8, 2 picks, 15% stock cap, 30% category cap, Rs 20,000 price ceiling, buffer + wait, 0.10%).

Run from packages/momentum-backtesting:
    uv run python scripts/alpha_experiments.py [--dataset etf|broad|both] [--only LABEL,...]
Writes data/backtests/alpha_<dataset>_summary.csv and alpha_<dataset>_windows.csv.
"""

from __future__ import annotations

import argparse
import time
import tomllib
from collections.abc import Callable
from dataclasses import dataclass, field, replace
from pathlib import Path

import pandas as pd

from momentum_backtesting import api, levers, metrics, sweep, tranches
from momentum_backtesting.categories import broad
from momentum_backtesting.config import DATA_DIR
from momentum_backtesting.engine import Config, ranked_universe, run_backtest
from momentum_backtesting.fetch import load_universe
from momentum_backtesting.reference_benchmarks import compare
from momentum_backtesting.tax import TaxRules

END = "2026-09-25"  # last complete week of the data this study ran on
FIXED = {"full": "2017-01-01", "last5y": "2021-09-25", "last3y": "2023-09-25"}
OUT_DIR = DATA_DIR / "backtests"

RunWindow = Callable[[pd.Timestamp, pd.Timestamp], object]


@dataclass
class Variant:
    label: str
    run: RunWindow
    note: str = ""
    baseline: str = "base"  # what it is compared against
    fork_caveat: bool = False  # changes Broad category selection before `start` (TODO 3.9.18)


@dataclass
class Study:
    dataset: str
    variants: list[Variant] = field(default_factory=list)


def _ts(value) -> str:
    return str(pd.Timestamp(value).date())


class Memo:
    """Caches each baseline window run so overlays (vol target, dispersion) reuse it."""

    def __init__(self, run: RunWindow):
        self.run, self.cache = run, {}

    def __call__(self, start, end):
        key = (_ts(start), _ts(end))
        if key not in self.cache:
            self.cache[key] = self.run(start, end)
        return self.cache[key]


# --- ETF study ----------------------------------------------------------------------------------


@dataclass
class EtfContext:
    prices: pd.DataFrame
    includes: dict[str, str]
    classes: dict[str, str]
    live: Config
    fills: pd.DataFrame
    signal: pd.DataFrame  # index closes of the ranked names
    cache: dict = field(default_factory=dict)

    def runner(self, extra: dict | None = None, **kwargs) -> RunWindow:
        def run(start, end):
            config = replace(self.live, start=_ts(start), end=_ts(end), **(extra or {}))
            return run_backtest(
                self.prices, self.includes, config, self.classes, self.cache, self.fills, **kwargs
            )

        return run


def etf_context() -> EtfContext:
    prices = api.DATA.get()
    uni = {i.name: i for i in load_universe()}
    includes = {n: i.include for n, i in uni.items()}
    raw = tomllib.loads(Path("src/momentum_backtesting/live_config.toml").read_text())
    live = Config(
        **{
            k: (tuple(v) if isinstance(v, list) else v)
            for k, v in raw.items()
            if k in Config.__dataclass_fields__
        }
    )
    return EtfContext(
        prices=prices,
        includes=includes,
        classes={n: i.tax_class for n, i in uni.items()},
        live=live,
        fills=api.DATA.fills(live.track, live.execution).prices,
        signal=prices[ranked_universe(includes, live)],
    )


def etf_study() -> Study:
    ctx = etf_context()
    prices, includes, classes, live, fills, signal, cache = (
        ctx.prices,
        ctx.includes,
        ctx.classes,
        ctx.live,
        ctx.fills,
        ctx.signal,
        ctx.cache,
    )
    runner = ctx.runner

    base = Memo(runner())
    skip_ranks = levers.skip_month_ranks(signal, live)
    high52 = levers.high52_ranks(signal, live)
    tax_base = Memo(runner({"tax": TaxRules()}))

    def overlay(make):
        return lambda s, e: make(base(s, e))

    def tranche_blend(every):
        def run(start, end):
            config = replace(live, start=_ts(start), end=_ts(end))
            return tranches.run_backtest_tranches(
                prices,
                includes,
                config,
                every,
                tax_classes=classes,
                rank_cache=cache,
                trade_prices=fills,
            )

        return run

    return Study(
        "etf",
        [
            Variant("base", base, "live_config.toml"),
            Variant("1a weights 0,1,1,1,1", runner({"weights": (0, 1, 1, 1, 1)})),
            Variant("1b skip month (3-1/6-1/12-1)", runner(external_ranks=skip_ranks)),
            Variant(
                "2a vol target 15%",
                overlay(lambda r: levers.vol_target(r, 0.15)),
                "post-hoc; ignores tax on the extra trades",
            ),
            Variant(
                "2b vol target 20%",
                overlay(lambda r: levers.vol_target(r, 0.20)),
                "post-hoc; ignores tax on the extra trades",
            ),
            Variant(
                "3a 52w-high gate 85%",
                runner(no_buy=levers.below_high52_mask(signal, 0.85)),
            ),
            Variant("3b 52w-high blended rank", runner(external_ranks=high52)),
            Variant("4 smoothness gate (26w up-share)", runner(no_buy=levers.choppy_mask(signal))),
            Variant(
                "5a trend gate (Nifty < 40w avg)",
                runner(no_buy=levers.trend_gate_mask(signal, prices["Nifty 50"])),
            ),
            Variant(
                "5b breadth gate (<40% above 40w)",
                runner(no_buy=levers.breadth_gate_mask(signal)),
            ),
            Variant("6 base, after tax", tax_base, "tax on, the baseline for 6"),
            Variant(
                "6 tax-aware hold (band 3, 8w)",
                runner({"tax": TaxRules(), "tax_hold_band": 3, "tax_hold_weeks": 8}),
                baseline="6 base, after tax",
            ),
            Variant("7 entry make_room", runner({"entry": "make_room"})),
            Variant("8a high-vol exclusion (top 20%)", runner(no_buy=levers.high_vol_mask(signal))),
            Variant(
                "8b dispersion timing",
                overlay(lambda r: levers.dispersion_timing(r, signal)),
                "post-hoc; ignores tax on the extra trades",
            ),
            Variant("0b every 2 weeks (tranche blend)", tranche_blend(2)),
        ],
    )


# --- Broad Momentum study -----------------------------------------------------------------------


BROAD_DEFAULTS = dict(
    category_mode="on",
    pool_top_n=broad.DEFAULT_POOL_TOP_N,
    pool_exit_rank=broad.DEFAULT_POOL_EXIT_RANK,
    coverage_floor=broad.DEFAULT_COVERAGE_FLOOR,
    category_top_n=broad.DEFAULT_CATEGORY_TOP_N,
    category_exit_rank=broad.DEFAULT_CATEGORY_EXIT_RANK,
    picks_per_category=broad.DEFAULT_PICKS_PER_CATEGORY,
    max_position=broad.DEFAULT_MAX_POSITION,
    max_category=broad.DEFAULT_MAX_CATEGORY,
    max_stock_price=broad.DEFAULT_MAX_STOCK_PRICE,
    cost_pct=0.10,
)


def broad_ranking(weights=None) -> broad.UniverseRanking:
    return api.DATA.get_broad_ranking(
        lookbacks=(1, 4, 13, 26, 52),
        weights=weights,
        score="ranksum",
        voladj_skip_recent_month=True,
        pool_top_n=broad.DEFAULT_POOL_TOP_N,
        pool_exit_rank=broad.DEFAULT_POOL_EXIT_RANK,
    )


def broad_study() -> Study:
    outer = api.DATA.get()
    t = time.time()
    ranking = broad_ranking()
    print(f"broad ranking {time.time() - t:.0f}s", flush=True)
    stocks = ranking.prices

    def runner(rank=None, **kwargs) -> RunWindow:
        def run(start, end):
            return broad.run_broad_backtest(
                outer_prices=outer,
                stocks_data_dir=DATA_DIR / "stocks",
                categories_data_dir=DATA_DIR / "categories",
                curated_dir=api.CATEGORIES_CURATED_DIR,
                start=_ts(start),
                end=_ts(end),
                ranking=rank or ranking,
                **{**BROAD_DEFAULTS, **kwargs},
            ).result

        return run

    base = Memo(runner())

    def overlay(make):
        return lambda s, e: make(base(s, e))

    def tranche_blend(every):
        def run(start, end):
            def one(config):
                return runner(rebalance_every=every, rebalance_offset=config.rebalance_offset)(
                    start, end
                )

            return tranches.run_tranches(one, Config(), every)

        return run

    weighted: dict = {}

    def weights_run(start, end):
        if "r" not in weighted:
            weighted["r"] = broad_ranking((0, 1, 1, 1, 1))
        return runner(rank=weighted["r"], weights=(0, 1, 1, 1, 1))(start, end)

    return Study(
        "broad",
        [
            Variant("base", base, "dashboard Broad Momentum defaults"),
            Variant(
                "1a weights 0,1,1,1,1",
                weights_run,
                "changes the pool and category ranking",
                fork_caveat=True,
            ),
            Variant(
                "2a vol target 15%",
                overlay(lambda r: levers.vol_target(r, 0.15)),
                "post-hoc; ignores tax on the extra trades",
            ),
            Variant(
                "2b vol target 20%",
                overlay(lambda r: levers.vol_target(r, 0.20)),
                "post-hoc; ignores tax on the extra trades",
            ),
            Variant(
                "3a 52w-high gate 85%",
                runner(extra_no_buy=levers.below_high52_mask(stocks, 0.85)),
            ),
            Variant(
                "4 smoothness gate (26w up-share)",
                runner(extra_no_buy=levers.choppy_mask(stocks)),
            ),
            Variant(
                "5a trend gate (Nifty < 40w avg)",
                runner(extra_no_buy=levers.trend_gate_mask(stocks, outer["Nifty 50"])),
            ),
            Variant(
                "5b breadth gate (<40% above 40w)",
                runner(extra_no_buy=levers.breadth_gate_mask(stocks)),
            ),
            Variant("7 entry make_room", runner(entry="make_room")),
            Variant(
                "8a high-vol exclusion (top 20%)",
                runner(extra_no_buy=levers.high_vol_mask(stocks)),
            ),
            Variant(
                "8b dispersion timing",
                overlay(lambda r: levers.dispersion_timing(r, stocks)),
                "post-hoc; ignores tax on the extra trades",
            ),
            Variant("0b every 2 weeks (tranche blend)", tranche_blend(2)),
        ],
    )


# --- Running and reporting ----------------------------------------------------------------------


def evaluate(study: Study, only: set[str] | None) -> tuple[pd.DataFrame, pd.DataFrame]:
    refs = api.DATA.references()
    weeks = api.DATA.get().loc[FIXED["full"] : END].index
    windows = sweep.rolling_windows(weeks)
    per_window, fixed_rows, excess = {}, {}, {}
    keep = None
    if only:
        keep = set(only) | {v.baseline for v in study.variants if v.label in only}
    for variant in study.variants:
        if keep is not None and variant.label not in keep:
            continue
        t = time.time()
        per_window[variant.label] = sweep.rerun_windows(variant.run, windows, refs)
        row = {}
        for name, start in FIXED.items():
            result = variant.run(pd.Timestamp(start), pd.Timestamp(END))
            stats = metrics.curve_stats(result.equity, result.cash)
            row[f"{name} CAGR"] = stats["CAGR"]
            row[f"{name} Sharpe"] = stats["Sharpe"]
            row[f"{name} MaxDD"] = stats["max drawdown"]
            for line in compare(result.equity, refs):
                short = "TRI" if line["name"] == "Nifty 50 TRI" else "Mom30"
                row[f"{name} vs {short}"] = line["excess_cagr"]
            if name == "full":
                excess[variant.label] = sweep.weekly_excess(result)
                trades = getattr(result, "trades", pd.DataFrame())
                years = (result.equity.index[-1] - result.equity.index[0]).days / 365.25
                buys = (
                    int((trades["action"] == "BUY").sum())
                    if len(trades)
                    else sum(int((r.trades["action"] == "BUY").sum()) for r in result.tranches)
                    if hasattr(result, "tranches")
                    else 0
                )
                row["full buys/yr"] = buys / years
        row["note"] = variant.note
        row["fork caveat"] = variant.fork_caveat
        fixed_rows[variant.label] = row
        print(f"  {variant.label}: {time.time() - t:.0f}s", flush=True)

    trial_sharpes = [s.mean() / s.std() for s in (e.dropna() for e in excess.values())]
    summary = pd.DataFrame(fixed_rows).T
    for variant in study.variants:
        if variant.label not in per_window:
            continue
        cmp = sweep.compare_rolling(
            {variant.label: per_window[variant.label], "__base": per_window[variant.baseline]},
            "__base",
        ).loc[variant.label]
        for col in (
            "median CAGR",
            "CAGR win share",
            "Sharpe win share",
            "MaxDD win share",
            "median dCAGR",
            "worst dCAGR",
            "median dSharpe",
            "median dMaxDD",
            "wins most",
        ):
            summary.loc[variant.label, f"roll {col}"] = cmp[col]
        dsr = sweep.deflated_sharpe(excess[variant.label], trial_sharpes)
        summary.loc[variant.label, "DSR prob"] = dsr.probability
        summary.loc[variant.label, "baseline"] = variant.baseline
    windows_frame = pd.concat(per_window, names=["variant"])
    return summary, windows_frame


def high_vol_plateau(dataset: str) -> pd.DataFrame:
    """Robustness of lever 8a: does excluding high-volatility names from fresh buys work across
    a grid of (quantile, volatility window), or only at the one setting first tried?"""
    study = etf_study() if dataset == "etf" else broad_study()
    base = study.variants[0].run
    if dataset == "etf":
        ctx = etf_context()
        signal = ctx.signal

        def make(mask):
            return ctx.runner(no_buy=mask)

    else:
        outer = api.DATA.get()
        ranking = broad_ranking()
        signal = ranking.prices

        def make(mask):
            def run(start, end):
                return broad.run_broad_backtest(
                    outer_prices=outer,
                    stocks_data_dir=DATA_DIR / "stocks",
                    categories_data_dir=DATA_DIR / "categories",
                    curated_dir=api.CATEGORIES_CURATED_DIR,
                    start=_ts(start),
                    end=_ts(end),
                    ranking=ranking,
                    extra_no_buy=mask,
                    **BROAD_DEFAULTS,
                ).result

            return run

    refs = api.DATA.references()
    windows = sweep.rolling_windows(api.DATA.get().loc[FIXED["full"] : END].index)
    frames = {"base": sweep.rerun_windows(base, windows, refs)}
    fulls = {}
    for quantile in (0.6, 0.7, 0.8, 0.9):
        for weeks in (13, 26, 52):
            label = f"q{quantile} w{weeks}"
            run = make(levers.high_vol_mask(signal, weeks=weeks, quantile=quantile))
            frames[label] = sweep.rerun_windows(run, windows, refs)
            full = run(pd.Timestamp(FIXED["full"]), pd.Timestamp(END))
            fulls[label] = metrics.curve_stats(full.equity, full.cash)
            print(f"  {label}", flush=True)
    table = sweep.compare_rolling(frames, "base")
    for label, stats in fulls.items():
        table.loc[label, "full CAGR"] = stats["CAGR"]
        table.loc[label, "full Sharpe"] = stats["Sharpe"]
        table.loc[label, "full MaxDD"] = stats["max drawdown"]
    table.to_csv(OUT_DIR / f"alpha_{dataset}_highvol_plateau.csv")
    return table


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dataset", choices=["etf", "broad", "both"], default="both")
    parser.add_argument("--only", default="", help="semicolon-separated variant labels")
    parser.add_argument("--plateau", action="store_true", help="lever 8a robustness grid only")
    args = parser.parse_args()
    if args.plateau:
        pd.set_option("display.width", 250)
        for name in ("etf", "broad") if args.dataset == "both" else (args.dataset,):
            print(f"== {name} high-vol plateau", flush=True)
            cols = [
                "full CAGR",
                "full Sharpe",
                "full MaxDD",
                "median dCAGR",
                "CAGR win share",
                "Sharpe win share",
                "MaxDD win share",
                "wins most",
            ]
            print(high_vol_plateau(name)[cols].to_string(float_format=lambda v: f"{v:.3f}"))
        return
    only = {s.strip() for s in args.only.split(";") if s.strip()} or None
    pd.set_option("display.width", 250)
    pd.set_option("display.max_columns", 60)
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    for name in ("etf", "broad") if args.dataset == "both" else (args.dataset,):
        print(f"== {name}", flush=True)
        study = etf_study() if name == "etf" else broad_study()
        summary, windows = evaluate(study, only)
        suffix = "" if only is None else "_partial"
        summary.to_csv(OUT_DIR / f"alpha_{name}_summary{suffix}.csv")
        windows.to_csv(OUT_DIR / f"alpha_{name}_windows{suffix}.csv")
        cols = [
            "full CAGR",
            "full Sharpe",
            "full MaxDD",
            "last5y CAGR",
            "last3y CAGR",
            "full vs TRI",
            "full vs Mom30",
            "roll median dCAGR",
            "roll CAGR win share",
            "roll Sharpe win share",
            "roll MaxDD win share",
            "roll wins most",
            "DSR prob",
        ]
        shown = summary[[c for c in cols if c in summary]]
        print(shown.to_string(float_format=lambda v: f"{v:.3f}"))


if __name__ == "__main__":
    main()
