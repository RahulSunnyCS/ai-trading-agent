"""Bias checks for Broad Momentum search results: is the edge momentum, or the universe?

Round 1 of a search finds configs that beat the passive benchmarks in-sample. Before any of them
is believed, each finalist is put through four checks that try to break it:

  placebo      Same universe, liquidity gate, category layer and engine, but the momentum ranks
               are replaced by random ones every week. If random "momentum" earns about what the
               config earns, the result is the universe (survivorship, small-cap drift), not the
               signal. Several seeds, reported as a range.
  liquidity    Rebuild the ranking with a much stricter tradeability gate (higher minimum
               turnover and price). Returns that vanish are returns from stocks nobody could trade.
  contributors Remove the stocks that made the most money (never allow them to be bought) and
               re-run. A strategy living off three lucky names collapses.
  windows      Shift the start date (2019, 2021) and cut the end (before 2023 only, so the sealed
               hold-out stays sealed), each against the total-return benchmarks over the same span.

Everything here is a re-run of `run_broad_backtest` with one thing changed, on configs already in
the results folder. Nothing is written back to the search results.
"""

from __future__ import annotations

import dataclasses
import json
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd

from . import metrics, reference_benchmarks, search
from .engine import IDLE

PLACEBO_SEEDS = 5
LIQUIDITY_VARIANTS = {
    "liq_5cr_p50": {"liq_min_turnover_cr": 5.0, "liq_min_price": 50.0},
    "liq_10cr_p100": {"liq_min_turnover_cr": 10.0, "liq_min_price": 100.0},
    "liq_25cr_p200": {"liq_min_turnover_cr": 25.0, "liq_min_price": 200.0},
}
REMOVE_TOP = (3, 5, 10)
WINDOWS = {
    "from_2019": {"start": "2019-01-01"},
    "from_2021": {"start": "2021-01-01"},
    "pre_2023": {"end": "2022-12-31"},  # stays inside the sealed hold-out's boundary
}


# --- picking finalists ----------------------------------------------------------------------


def pick_configs(df: pd.DataFrame) -> dict[str, str]:
    """label -> run id: the finalists plus a few ordinary runs as a reference for "typical"."""
    ok = df[df["error"].isna() & (df["turnover_x"] <= 3) & (df["buys_per_yr"] >= 10)]
    picks = {
        "top_cagr": ok.nlargest(1, "cagr").id.iloc[0],
        "best_cagr_dd23": ok[ok.mdd >= -0.23].nlargest(1, "cagr").id.iloc[0],
        "best_cagr_dd18": ok[ok.mdd >= -0.18].nlargest(1, "cagr").id.iloc[0],
        "best_calmar_cagr35": ok[ok.cagr >= 0.35].nlargest(1, "calmar").id.iloc[0],
    }
    for label, q in (("p90_typical", 0.9), ("median_typical", 0.5), ("p10_typical", 0.1)):
        target = ok.cagr.quantile(q)
        picks[label] = ok.iloc[(ok.cagr - target).abs().argsort().iloc[0]].id
    seen: set[str] = set()
    return {k: v for k, v in picks.items() if not (v in seen or seen.add(v))}


def load_records(out_dir: Path, ids: set[str]) -> dict[str, dict[str, Any]]:
    found: dict[str, dict[str, Any]] = {}
    for path in Path(out_dir).glob("results-*.jsonl"):
        for line in path.read_text().splitlines():
            try:
                rec = json.loads(line)
            except json.JSONDecodeError:
                continue
            if rec.get("id") in ids:
                found[rec["id"]] = rec
    return found


# --- building and running one configuration ---------------------------------------------------


class Runner:
    """Builds rankings and runs backtests for one space, with small caches."""

    def __init__(
        self,
        space: search.Space,
        *,
        universe_kind: str | None = None,
        category_tags: str | None = None,
    ) -> None:
        """`universe_kind` / `category_tags` run the space's configs on another universe or
        tag file than its arm names (BL-010 Phase 3: the same configs, point-in-time)."""
        from . import api

        self.api = api
        self.space = space
        self.universe_kind = universe_kind or search.ARMS[space.arm][0]
        self.category_tags = category_tags
        self.common = dict(
            outer_prices=api.DATA.get(),
            stocks_data_dir=api.DATA_DIR / "stocks",
            categories_data_dir=api.DATA_DIR / "categories",
        )
        self.refs = reference_benchmarks.load_references()
        self._tilt_cache: dict[tuple, Any] = {}

    def heavy_args(self, heavy: dict[str, Any], **override: Any) -> tuple[dict[str, Any], Any]:
        from .categories.liquidity import LiquidityConfig

        h = {**heavy, **override}
        lookbacks = tuple(h["lookbacks"])
        liquidity = LiquidityConfig(
            min_turnover_cr=h.get("liq_min_turnover_cr", 1.0),
            floor_ratio=h.get("liq_floor_ratio", 0.25),
            min_price=h.get("liq_min_price", 20.0),
            circuit=h.get("liq_circuit", True),
            circuit_run=h.get("liq_circuit_run", 3),
            max_circuit_days=h.get("liq_max_circuit_days"),
        )
        kwargs = dict(
            lookbacks=lookbacks,
            weights=search.weights_for(h.get("weight_scheme"), len(lookbacks)),
            score=h.get("score", "ranksum"),
            voladj_skip_recent_month=h.get("voladj_skip_recent_month", True),
        )
        return kwargs, liquidity

    def base(self, heavy: dict[str, Any], **override: Any):
        from .categories import broad

        kwargs, liquidity = self.heavy_args(heavy, **override)
        h = {**heavy, **override}
        return broad.compute_universe_base(
            **self.common,
            **kwargs,
            liquidity=liquidity,
            universe_kind=self.universe_kind,
            series_breaks=h.get("series_break_policy", "verified"),
        )

    def locks(self, ranking):
        from .categories import circuit_exposure as cx

        return cx.lock_masks(ranking.column_to_base_symbol, ranking.prices.index)

    def run(
        self,
        base,
        heavy: dict[str, Any],
        light: dict[str, Any],
        *,
        locks=None,
        extra_no_buy: pd.DataFrame | None = None,
        tax=None,
        curated_dir: Path | None = None,
        **window: Any,
    ):
        """One backtest on `base` (any UniverseBase, including a placebo one). `curated_dir`
        swaps the folder the category tags are read from (the label-shuffle placebo)."""
        from .categories import broad

        merged = {**self.space.fixed, **light, **window}
        pool = (merged.get("pool_top_n", 200), merged.get("pool_exit_rank", 250))
        ranking = broad.finish_universe_ranking(base, pool_top_n=pool[0], pool_exit_rank=pool[1])
        kwargs = search._split_light(self.space, merged)
        if self.category_tags is not None:
            kwargs["category_tags"] = self.category_tags
        if kwargs.pop("respect_circuits", False):
            kwargs["uc_locked"], kwargs["lc_locked"] = locks or self.locks(ranking)
        heavy_kwargs, _ = self.heavy_args(heavy)
        tilt = merged.get("stock_tilt", 0.0)
        if tilt > 0 and "stock_tilt_ranks" not in kwargs:
            # The tilted ranking depends only on the prices, the lookbacks and the tilt, and
            # costs two full ranking passes: keep it across the runs that share a base.
            from .engine import Config
            from .levers import grouped_momentum_ranks

            screen = merged.get("stock_tilt_screen_pct", 0.0)
            key = (id(base.full_frame), heavy_kwargs["lookbacks"], tilt, screen)
            if key not in self._tilt_cache:
                if len(self._tilt_cache) >= 4:
                    self._tilt_cache.pop(next(iter(self._tilt_cache)))
                self._tilt_cache[key] = grouped_momentum_ranks(
                    ranking.prices,
                    Config(lookbacks=heavy_kwargs["lookbacks"]),
                    tilt=tilt,
                    screen_top_pct=screen,
                )
            kwargs["stock_tilt_ranks"] = self._tilt_cache[key]
        outcome = broad.run_broad_backtest(
            **self.common,
            curated_dir=curated_dir or self.api.CATEGORIES_CURATED_DIR,
            **heavy_kwargs,
            pool_top_n=pool[0],
            pool_exit_rank=pool[1],
            ranking=ranking,
            extra_no_buy=extra_no_buy,
            tax=tax,
            **kwargs,
        )
        return outcome, ranking

    def hurdles(self, equity: pd.Series) -> dict[str, float]:
        out = {}
        # REFERENCES only: the extra comparison TRIs are loaded for criteria, not for this report.
        for name in reference_benchmarks.REFERENCES:
            if name not in self.refs:
                continue
            aligned = reference_benchmarks.aligned(self.refs[name], equity.index)
            if aligned is not None:
                out[name] = round(float(metrics.cagr(aligned)), 4)
        return out


def shuffled_ranks(ranks: pd.DataFrame, seed: int) -> pd.DataFrame:
    """Each week's ranks replaced by a random permutation over the names that had a rank."""
    rng = np.random.default_rng(seed)
    values = ranks.to_numpy(dtype=float).copy()
    for i in range(len(values)):
        idx = np.flatnonzero(~np.isnan(values[i]))
        values[i, idx] = rng.permutation(len(idx)) + 1
    return pd.DataFrame(values, index=ranks.index, columns=ranks.columns)


def profit_by_stock(outcome, ranking) -> pd.Series:
    """Realised profit per company (in portfolio units) from the SELL rows, summed across a
    stock's split segments. Positions still open at the end are not counted."""
    trades = outcome.result.trades
    sells = trades[trades["action"] == "SELL"]
    pnl = (sells["value"] - sells["entry_value"]).groupby(sells["asset"]).sum()
    base_symbol = ranking.column_to_base_symbol
    pnl.index = [base_symbol.get(a, a) for a in pnl.index]
    return pnl.groupby(level=0).sum().sort_values(ascending=False)


def block_mask(ranking, symbols: list[str]) -> pd.DataFrame:
    """Entry-only block on every column of the given companies, every week."""
    mask = pd.DataFrame(False, index=ranking.prices.index, columns=ranking.prices.columns)
    cols = [c for c, b in ranking.column_to_base_symbol.items() if b in set(symbols)]
    mask[[c for c in cols if c in mask.columns]] = True
    return mask


def _short(m: dict[str, float]) -> dict[str, float]:
    return {k: m[k] for k in ("cagr", "mdd", "calmar", "turnover_x") if k in m}


def check_config(runner: Runner, label: str, rec: dict[str, Any], seeds: int, echo) -> dict:
    heavy, light = rec["heavy"], rec["light"]
    result: dict[str, Any] = {"label": label, "id": rec["id"], "recorded": rec["metrics"]}

    base = runner.base(heavy)
    outcome, ranking = runner.run(base, heavy, light)
    locks = runner.locks(ranking)
    result["rerun"] = _short(search.run_metrics(outcome.result, IDLE))
    result["hurdles_full"] = runner.hurdles(outcome.result.equity)
    echo(
        f"  [{label}] rerun CAGR {result['rerun']['cagr']:.3f} (recorded {rec['metrics']['cagr']})"
    )

    # 1. random-ranking placebo
    placebo = []
    for seed in range(seeds):
        fake = dataclasses.replace(base, global_ranks=shuffled_ranks(base.global_ranks, seed))
        out, _ = runner.run(fake, heavy, light, locks=locks)
        placebo.append(_short(search.run_metrics(out.result, IDLE)))
    result["placebo"] = placebo
    echo(f"  [{label}] placebo CAGR {[round(p['cagr'], 3) for p in placebo]}")

    # 2. stricter tradeability
    result["liquidity"] = {}
    for name, override in LIQUIDITY_VARIANTS.items():
        strict = runner.base(heavy, **override)
        out, _ = runner.run(strict, heavy, light)
        result["liquidity"][name] = _short(search.run_metrics(out.result, IDLE))
    echo(
        f"  [{label}] liquidity CAGR "
        f"{ {k: round(v['cagr'], 3) for k, v in result['liquidity'].items()} }"
    )

    # 3. remove the biggest winners
    pnl = profit_by_stock(outcome, ranking)
    gains = pnl[pnl > 0]
    result["profit_concentration"] = {
        "top5_share_of_gains": round(float(gains.head(5).sum() / gains.sum()), 3),
        "top10_share_of_gains": round(float(gains.head(10).sum() / gains.sum()), 3),
        "top5": [str(s) for s in pnl.head(5).index],
    }
    result["without_top"] = {}
    for k in REMOVE_TOP:
        out, _ = runner.run(
            base,
            heavy,
            light,
            locks=locks,
            extra_no_buy=block_mask(ranking, list(pnl.head(k).index)),
        )
        result["without_top"][k] = _short(search.run_metrics(out.result, IDLE))
    echo(
        f"  [{label}] without top 3/5/10 CAGR "
        f"{[round(v['cagr'], 3) for v in result['without_top'].values()]}"
    )

    # 4. other windows, each against the total-return benchmarks over the same span
    result["windows"] = {}
    for name, window in WINDOWS.items():
        out, _ = runner.run(base, heavy, light, locks=locks, **window)
        result["windows"][name] = {
            **_short(search.run_metrics(out.result, IDLE)),
            "hurdles": runner.hurdles(out.result.equity),
        }
    return result


def run_checks(out_dir: Path, space_path: Path, *, seeds: int = PLACEBO_SEEDS, echo=print) -> dict:
    space = search.load_space(space_path)
    df = search.load_results(out_dir)
    picks = pick_configs(df)
    records = load_records(out_dir, set(picks.values()))
    runner = Runner(space)
    report = {"space": space.name, "arm": space.arm, "seeds": seeds, "configs": []}
    for label, run_id in picks.items():
        echo(f"{label} ({run_id})")
        report["configs"].append(check_config(runner, label, records[run_id], seeds, echo))
        (Path(out_dir) / "bias.json").write_text(json.dumps(report, indent=1, default=float))
    return report


def render(report: dict) -> str:
    """The report as plain text: one block per config, deltas against its own re-run."""
    lines = []
    for c in report["configs"]:
        base = c["rerun"]
        h = c["hurdles_full"]
        placebo = [p["cagr"] for p in c["placebo"]]
        lines += [
            f"== {c['label']}: CAGR {base['cagr']:.1%}, max drawdown {base['mdd']:.1%}, "
            f"turnover {base['turnover_x']:.2f}x",
            "   hurdles (same window): " + ", ".join(f"{k} {v:.1%}" for k, v in h.items()),
            f"   placebo (random ranks, {len(placebo)} seeds): CAGR {min(placebo):.1%} to "
            f"{max(placebo):.1%}, mean {np.mean(placebo):.1%}   -> real minus placebo mean "
            f"{base['cagr'] - np.mean(placebo):+.1%}",
        ]
        for name, m in c["liquidity"].items():
            lines.append(f"   {name:<14} CAGR {m['cagr']:.1%}  drawdown {m['mdd']:.1%}")
        conc = c["profit_concentration"]
        lines.append(
            f"   profit concentration: top-5 stocks = {conc['top5_share_of_gains']:.0%} of gains, "
            f"top-10 = {conc['top10_share_of_gains']:.0%}  ({', '.join(conc['top5'])})"
        )
        for k, m in c["without_top"].items():
            lines.append(
                f"   without top {k:<2} winners  CAGR {m['cagr']:.1%}  drawdown {m['mdd']:.1%}"
            )
        for name, m in c["windows"].items():
            hur = ", ".join(f"{k} {v:.1%}" for k, v in m["hurdles"].items())
            lines.append(
                f"   window {name:<10} CAGR {m['cagr']:.1%}  drawdown {m['mdd']:.1%}   [{hur}]"
            )
        lines.append("")
    return "\n".join(lines)
