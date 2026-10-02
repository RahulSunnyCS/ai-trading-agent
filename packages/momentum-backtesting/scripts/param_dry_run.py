"""Parameter dry run on real local data (TODO 3.9.23, Step 3).

Fixes two baselines - the live ETF strategy (`live_config.toml`) and Broad Momentum's dashboard
defaults - and changes ONE parameter at a time across its documented range. Every variant runs
over the full / last-5y / last-3y windows and over 28 rolling 3-year windows (fresh start each),
and reports CAGR, Sharpe, max drawdown, buys a year, average weeks held, time in cash, and the
CAGR edge over Nifty 50 TRI and Nifty200 Momentum 30 TRI. Then it walks one real Friday end to
end: every ranked instrument's returns per window, rank per window, score, final rank, and what
was bought, held and sold that week with the trade log's own reason.

Rows marked `fork caveat` change Broad Momentum's category selection, which is computed over the
whole price history before `start` (TODO 3.9.18): their windows compare portfolios that had
already diverged, so read them as indicative only.

    uv run python scripts/param_dry_run.py [--dataset etf|broad|both] [--friday-only]

Writes data/backtests/param_dry_run_<dataset>.csv and param_dry_run_<dataset>_rolling.csv.
"""

from __future__ import annotations

import argparse
import sys
import time
from dataclasses import replace
from pathlib import Path

import pandas as pd

sys.path.insert(0, str(Path(__file__).parent))

import alpha_experiments as ax  # noqa: E402

from momentum_backtesting import api, levers, metrics, sweep, tranches  # noqa: E402
from momentum_backtesting.categories import broad  # noqa: E402
from momentum_backtesting.config import DATA_DIR  # noqa: E402
from momentum_backtesting.engine import Config  # noqa: E402
from momentum_backtesting.reference_benchmarks import compare  # noqa: E402
from momentum_backtesting.tax import TaxRules  # noqa: E402

# (parameter, value shown, Config overrides or run kwargs, fork caveat)
ETF_GRID = [
    ("baseline", "live_config.toml", {}, {}),
    ("top_n", 3, {"top_n": 3}, {}),
    ("top_n", 8, {"top_n": 8}, {}),
    ("exit_rank", 6, {"exit_rank": 6}, {}),
    ("exit_rank", 16, {"exit_rank": 16}, {}),
    ("max_position", 0.25, {"max_position": 0.25}, {}),
    ("max_position", 0.50, {"max_position": 0.50}, {}),
    ("max_position", "none", {"max_position": None}, {}),
    ("entry", "make_room", {"entry": "make_room"}, {}),
    ("weights", "0,1,1,1,1", {"weights": (0, 1, 1, 1, 1)}, {}),
    ("score", "voladj", {"score": "voladj"}, {}),
    ("score", "blend", {"score": "blend"}, {}),
    ("cost_model", "itemised", {"cost_model": "itemised"}, {}),
    ("signal_delay", 1, {"signal_delay": 1}, {}),
    ("execution", "mon_open", {"execution": "mon_open"}, {}),
    ("track", "index", {"track": "index"}, {}),
    ("rebalance", "monthly", {"rebalance": "monthly"}, {}),
    ("rebalance_every", "2 (phase 0)", {"rebalance_every": 2}, {}),
    ("rebalance_every", "2 (tranche blend)", {}, {"tranches": 2}),
    ("defensive", "filter", {"defensive": "filter"}, {}),
    ("momentum_sizing", True, {"momentum_sizing": True}, {}),
    ("tax", "on", {"tax": TaxRules()}, {}),
    (
        "tax_hold_band / weeks",
        "3 / 8 (tax on)",
        {"tax": TaxRules(), "tax_hold_band": 3, "tax_hold_weeks": 8},
        {},
    ),
    ("high-vol exclusion", "top 20%, 26w", {}, {"mask": "high_vol"}),
    ("52w-high gate", "85%", {}, {"mask": "high52"}),
]

BROAD_GRID = [
    ("baseline", "dashboard defaults", {}, False),
    ("min_ranked", "0 (engine default: skips thin weeks)", {"min_ranked": 0}, False),
    ("pool_top_n / exit", "100 / 150", {"pool_top_n": 100, "pool_exit_rank": 150}, True),
    ("pool_top_n / exit", "300 / 350", {"pool_top_n": 300, "pool_exit_rank": 350}, True),
    ("coverage_floor", 0.25, {"coverage_floor": 0.25}, True),
    ("coverage_floor", 0.60, {"coverage_floor": 0.60}, True),
    ("category_top_n / exit", "3 / 6", {"category_top_n": 3, "category_exit_rank": 6}, True),
    ("category_top_n / exit", "6 / 12", {"category_top_n": 6, "category_exit_rank": 12}, True),
    ("picks_per_category", 1, {"picks_per_category": 1}, False),
    ("picks_per_category", 3, {"picks_per_category": 3}, False),
    ("max_position", 0.10, {"max_position": 0.10}, False),
    ("max_position", 0.25, {"max_position": 0.25}, False),
    ("max_category", "none", {"max_category": None}, False),
    ("max_stock_price", "none", {"max_stock_price": None}, False),
    ("entry", "make_room", {"entry": "make_room"}, False),
    ("cost_model", "itemised", {"cost_model": "itemised"}, False),
    ("signal_delay", 1, {"signal_delay": 1}, False),
    ("rebalance", "monthly", {"rebalance": "monthly"}, False),
    ("rebalance_every", "2 (phase 0)", {"rebalance_every": 2}, False),
    ("rebalance_every", "2 (phase 1)", {"rebalance_every": 2, "rebalance_offset": 1}, False),
    ("rebalance_every", "2 (tranche blend)", {"__tranches": 2}, False),
    ("rebalance_every", "4 (tranche blend)", {"__tranches": 4}, False),
    ("score", "blend", {"score": "blend"}, True),
    ("weights", "0,1,1,1,1", {"weights": (0, 1, 1, 1, 1)}, True),
    ("momentum_sizing", True, {"momentum_sizing": True}, False),
    ("high-vol exclusion", "top 20%, 26w", {"__mask": "high_vol"}, False),
    ("52w-high gate", "85%", {"__mask": "high52"}, False),
]


def describe(result, refs) -> dict:
    stats = metrics.curve_stats(result.equity, result.cash)
    row = {
        "CAGR": stats["CAGR"],
        "Sharpe": stats["Sharpe"],
        "MaxDD": stats["max drawdown"],
    }
    years = (result.equity.index[-1] - result.equity.index[0]).days / 365.25
    if hasattr(result, "tranches"):
        row["buys/yr"] = result.buys_per_year()
    else:
        summary = metrics.summary(result)
        row["buys/yr"] = summary["buys"] / years
        row["avg weeks held"] = summary["avg weeks held"]
        row["time in cash"] = summary["time in cash/debt"]
    for line in compare(result.equity, refs):
        short = "TRI" if line["name"] == "Nifty 50 TRI" else "Mom30"
        row[f"vs {short}"] = line["excess_cagr"]
    return row


def etf_variants():
    ctx = ax.etf_context()
    masks = {
        "high_vol": levers.high_vol_mask(ctx.signal),
        "high52": levers.below_high52_mask(ctx.signal, 0.85),
    }
    out = []
    for parameter, value, overrides, special in ETF_GRID:
        if "tranches" in special:
            every = special["tranches"]

            def run(start, end, every=every):
                config = replace(ctx.live, start=ax._ts(start), end=ax._ts(end))
                return tranches.run_backtest_tranches(
                    ctx.prices,
                    ctx.includes,
                    config,
                    every,
                    tax_classes=ctx.classes,
                    rank_cache=ctx.cache,
                    trade_prices=ctx.fills,
                )

        elif "mask" in special:
            run = ctx.runner(no_buy=masks[special["mask"]])
        else:
            extra = dict(overrides)
            if extra.get("track") == "index" or extra.get("execution") == "mon_open":
                # these need their own fill table (index prices / Monday opens)
                track = extra.get("track", ctx.live.track)
                execution = extra.get("execution", ctx.live.execution)
                fills = api.DATA.fills(track, execution)
                local = ax.EtfContext(
                    ctx.prices,
                    ctx.includes,
                    ctx.classes,
                    ctx.live,
                    fills.prices if fills is not None else None,
                    ctx.signal,
                    ctx.cache,
                )
                run = local.runner(extra)
            else:
                run = ctx.runner(extra)
        out.append((parameter, value, run, False))
    return out


def broad_variants():
    outer = api.DATA.get()
    rankings: dict = {}

    def ranking_for(pool_top_n, pool_exit_rank, score, weights):
        key = (pool_top_n, pool_exit_rank, score, weights)
        if key not in rankings:
            rankings[key] = api.DATA.get_broad_ranking(
                lookbacks=(1, 4, 13, 26, 52),
                weights=weights,
                score=score,
                voladj_skip_recent_month=True,
                pool_top_n=pool_top_n,
                pool_exit_rank=pool_exit_rank,
            )
        return rankings[key]

    out = []
    for parameter, value, overrides, fork in BROAD_GRID:
        kwargs = {**ax.BROAD_DEFAULTS, **{k: v for k, v in overrides.items() if k[:2] != "__"}}
        phase = (kwargs.pop("rebalance_every", 1), kwargs.pop("rebalance_offset", 0))
        every = overrides.get("__tranches")
        mask_kind = overrides.get("__mask")

        def run(start, end, kwargs=kwargs, every=every, mask_kind=mask_kind, phase=phase):
            rank = ranking_for(
                kwargs["pool_top_n"],
                kwargs["pool_exit_rank"],
                kwargs.get("score", "ranksum"),
                kwargs.get("weights"),
            )
            extra = None
            if mask_kind == "high_vol":
                extra = levers.high_vol_mask(rank.prices)
            elif mask_kind == "high52":
                extra = levers.below_high52_mask(rank.prices, 0.85)

            def one(rebalance_every=1, rebalance_offset=0):
                return broad.run_broad_backtest(
                    outer_prices=outer,
                    stocks_data_dir=DATA_DIR / "stocks",
                    categories_data_dir=DATA_DIR / "categories",
                    curated_dir=api.CATEGORIES_CURATED_DIR,
                    start=ax._ts(start),
                    end=ax._ts(end),
                    ranking=rank,
                    extra_no_buy=extra,
                    rebalance_every=rebalance_every,
                    rebalance_offset=rebalance_offset,
                    **kwargs,
                ).result

            if every:
                return tranches.run_tranches(
                    lambda c: one(every, c.rebalance_offset), Config(), every
                )
            return one(*phase)

        out.append((parameter, value, run, fork))
    return out


def dry_run(dataset: str) -> pd.DataFrame:
    refs = api.DATA.references()
    windows = sweep.rolling_windows(api.DATA.get().loc[ax.FIXED["full"] : ax.END].index)
    variants = etf_variants() if dataset == "etf" else broad_variants()
    rows, rolling = [], {}
    for parameter, value, run, fork in variants:
        t = time.time()
        label = f"{parameter} = {value}"
        for window, start in ax.FIXED.items():
            result = run(pd.Timestamp(start), pd.Timestamp(ax.END))
            rows.append(
                {
                    "parameter": parameter,
                    "value": value,
                    "window": window,
                    "fork caveat": fork,
                    **describe(result, refs),
                }
            )
        rolling[label] = sweep.rerun_windows(run, windows, refs)
        print(f"  {label}: {time.time() - t:.0f}s", flush=True)
    table = pd.DataFrame(rows)
    baseline = next(iter(rolling))
    roll = sweep.compare_rolling(rolling, baseline)
    table.to_csv(ax.OUT_DIR / f"param_dry_run_{dataset}.csv", index=False)
    roll.to_csv(ax.OUT_DIR / f"param_dry_run_{dataset}_rolling.csv")
    return table, roll


def walk_friday() -> None:
    """One real Friday of the live ETF strategy, end to end."""
    ctx = ax.etf_context()
    run = ctx.runner()
    result = run(pd.Timestamp(ax.FIXED["full"]), pd.Timestamp(ax.END))
    trades = result.trades
    sells = trades[trades["action"] == "SELL"]
    week = sells["week"].max()
    print(f"\n== One real Friday: {week:%Y-%m-%d} (live ETF strategy, latest week with a sale)")
    lookbacks = ctx.live.lookbacks
    history = ctx.signal.loc[:week]
    returns = pd.DataFrame(
        {f"{k}w %": (history.iloc[-1] / history.iloc[-1 - k] - 1) * 100 for k in lookbacks}
    )
    eligible = history.iloc[-1 - max(lookbacks)].notna() & history.iloc[-1].notna()
    per_rank = pd.DataFrame(
        {
            f"{k}w rank": returns[f"{k}w %"].where(eligible).rank(ascending=False, method="min")
            for k in lookbacks
        }
    )
    weights = ctx.live.weights or (1.0,) * len(lookbacks)
    score = sum(w * per_rank[f"{k}w rank"] for k, w in zip(lookbacks, weights, strict=True))
    table = pd.concat([returns.round(1), per_rank], axis=1)
    table["score"] = score
    table["engine score"] = result.scores.loc[week].reindex(table.index)
    table["final rank"] = result.ranks.loc[week].reindex(table.index)
    held_before = {
        a for a, w in result.weights.shift(1).loc[week].items() if w > 1e-9 and a in table.index
    }
    this_week = trades[trades["week"] == week]
    action = {
        r.asset: f"{r.action}: {r.reason}" for r in this_week.itertuples() if r.asset in table.index
    }
    table["held before"] = [n in held_before for n in table.index]
    table["this week"] = [action.get(n, "HOLD" if n in held_before else "") for n in table.index]
    table = table.sort_values("final rank")
    pd.set_option("display.width", 250)
    pd.set_option("display.max_columns", 30)
    print(table.to_string())
    mismatch = (table["score"] - table["engine score"]).abs().max()
    print(f"(score rebuilt by hand vs engine's own score: max difference {mismatch:.6f})")
    print(
        f"Rules: buy the top {ctx.live.top_n}, sell once rank > {ctx.live.exit_rank}, "
        f"no holding above {ctx.live.max_position:.0%}, entry={ctx.live.entry}."
    )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dataset", choices=["etf", "broad", "both"], default="both")
    parser.add_argument("--friday-only", action="store_true")
    args = parser.parse_args()
    pd.set_option("display.width", 250)
    pd.set_option("display.max_columns", 40)
    if not args.friday_only:
        for name in ("etf", "broad") if args.dataset == "both" else (args.dataset,):
            print(f"== {name}", flush=True)
            table, roll = dry_run(name)
            full = table[table["window"] == "full"].set_index(["parameter", "value"])
            print(full.drop(columns=["window"]).to_string(float_format=lambda v: f"{v:.3f}"))
            cols = ["median dCAGR", "CAGR win share", "Sharpe win share", "MaxDD win share"]
            print(roll[[*cols, "wins most"]].to_string(float_format=lambda v: f"{v:.3f}"))
    walk_friday()


if __name__ == "__main__":
    main()
