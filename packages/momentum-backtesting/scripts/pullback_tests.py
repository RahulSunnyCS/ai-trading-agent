"""Pullback in a strong uptrend: validation (TODO 3.9.31).

The spec is docs/momentum-pullback-tests.md. Builds on 3.9.23 (Broad, every week simulated, is
the corrected baseline; a one-week signal delay and every-2-weeks cadence already win, likely
through the same short-term reversal) and the 3.9.30 hint (being above the 10-week average
predicted slightly LOWER 13-52 week returns). Nothing here changes engine.py or any shipped
default; every new lever lives in levers.py (dist_from_high, long_term_strength,
long_term_strong_mask, pullback_flags, pullback_no_buy_mask, pullback_turn_no_buy_mask,
pullback_ranks, cap_rank_during_pullback, plus the extracted rank_to_pct), covered by their own
unit tests in tests/test_levers.py.

Reuses, by import, rather than reimplementing:
- scripts/alpha_experiments.py: `Study`/`Variant`/`Memo`/`evaluate` (the rolling-window scorer:
  28 windows + full/5y/3y, `sweep.compare_rolling`, `sweep.deflated_sharpe`), `broad_ranking`,
  `BROAD_DEFAULTS` (which sets `min_ranked=1` - the corrected Broad baseline).
- scripts/breadth_regime_tests.py: `run_broad_outcome`, `load_outer_prices`,
  `block_bootstrap_means`, `BOOTSTRAP_BLOCK`/`BOOTSTRAP_REPS`/`SEED`.
- scripts/overextension_trim_tests.py: `FIRST_HALF_END`, `build_stock` (the point-in-time
  Nifty 50 stock layer, for P2's cross-check).
- scripts/volume_turnover_tests.py: `history_ok`, `stages` (the Stage-2 1% slope rule - "trend
  intact"), `forward_returns`, `flag_coefficient`, `bootstrap_ci`, `build_universe` (Broad's
  qualifying pool mask).

P2b (`forward_max_drawdown`, `forward_volatility`, `p2b_predictive_weekly`, all local to this
script, not levers.py - they are measurement helpers for the predictive test, not a trading
lever) is exploratory, added to the spec after seeing P2 fail: does a PB name still protect on
the downside (shallower forward drawdown / lower forward volatility) even though it does not
predict a better forward return? PB only, run as part of `p2`.

Run from packages/momentum-backtesting:
    uv run python scripts/pullback_tests.py p1   # settings-only variants (cheap; checkpoint)
    uv run python scripts/pullback_tests.py p2   # predictive test + p2b (checkpoint; decides p4)
    uv run python scripts/pullback_tests.py p3   # exit-side hold
    uv run python scripts/pullback_tests.py p4   # entry ranking (only meaningful if p2 passes)
    uv run python scripts/pullback_tests.py p5   # stacking check against the cadence fix
    uv run python scripts/pullback_tests.py all  # p1..p5 in order
Writes CSVs to data/backtests/pullback/ (gitignored).
"""

from __future__ import annotations

import argparse
import sys
import time
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent))
import alpha_experiments as alpha  # noqa: E402
import breadth_regime_tests as brt  # noqa: E402
import overextension_trim_tests as ott  # noqa: E402
import volume_turnover_tests as vtt  # noqa: E402

from momentum_backtesting import levers, metrics  # noqa: E402
from momentum_backtesting.categories import broad  # noqa: E402
from momentum_backtesting.config import DATA_DIR  # noqa: E402
from momentum_backtesting.engine import Config  # noqa: E402

OUT_DIR = DATA_DIR / "backtests" / "pullback"
END = alpha.END  # last complete week this study ran on, same as alpha_experiments
FIRST_HALF_END = ott.FIRST_HALF_END  # "2021-12-31"

# Pullback definitions (fixed before the run; docs/momentum-pullback-tests.md "Definitions")
LT_LOOKBACKS = (13, 26, 52)
LT_TOP_PCT = 0.20  # LT-strong: top 20% of the qualifying pool
PB_LOW, PB_HIGH = -0.20, -0.05  # 5% to 20% below the 13-week high
PREDICTIVE_HORIZONS = (1, 4, 13, 26)
PASS_HORIZONS = (4, 13)
MIN_NAMES_EACH_SIDE = 3  # the spec's "at least 3 names on each side"

# Known full-sample MaxDD of the plain ("base") Broad run per mode, from p1_{mode}_summary.csv -
# a sanity anchor `run_p5` checks itself against, so building the cadence-alone baseline in the
# wrong mode (as happened once: "on" built for an "off" variant, understating MaxDD by ~20pt and
# giving a false 0% MaxDD win share) fails loudly instead of silently.
_MODE_BASE_MAXDD = {"on": -0.20392, "off": -0.40385}


def _ts(value) -> str:
    return str(pd.Timestamp(value).date())


def out_dir() -> Path:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    return OUT_DIR


# ---------------------------------------------------------------------------------------------
# Shared Broad setup
# ---------------------------------------------------------------------------------------------


def broad_runner(mode: str, ranking: broad.UniverseRanking, **extra):
    """A `Variant.run`-shaped closure: Broad, every week simulated (`BROAD_DEFAULTS`), the
    given `ranking`, `mode` ("on" = dashboard defaults, category selection; "off" = direct
    pool rank, top 10 / exit 20 - the spec's "secondary" setting)."""
    outer = alpha.api.DATA.get()
    base_kwargs = dict(alpha.BROAD_DEFAULTS)
    if mode == "off":
        base_kwargs["category_mode"] = "off"
        base_kwargs["max_category"] = None  # api.py passes no category cap in OFF mode
        base_kwargs["off_top_n"] = 10
        base_kwargs["off_exit_rank"] = 20

    def run(start, end):
        return broad.run_broad_backtest(
            outer_prices=outer,
            stocks_data_dir=DATA_DIR / "stocks",
            categories_data_dir=DATA_DIR / "categories",
            curated_dir=alpha.api.CATEGORIES_CURATED_DIR,
            start=_ts(start),
            end=_ts(end),
            ranking=ranking,
            **{**base_kwargs, **extra},
        ).result

    return run


def skip_month_broad_ranking() -> broad.UniverseRanking:
    """A `UniverseRanking` built from `levers.skip_month_ranks` instead of the plain ranksum -
    P1c, "never run on Broad before". Reuses Step 2's own pool-membership/dense-rank plumbing
    (`broad._compute_pool_membership`/`broad._dense_rank`) rather than duplicating it; only the
    one `engine.compute_ranks` call `compute_universe_ranking` makes is swapped out, same as
    that function's own docstring says a cached-ranking caller may do."""
    from momentum_backtesting.categories import compose
    from momentum_backtesting.categories.broad import ATOMIC_NAMES, UniverseRanking

    outer = alpha.api.DATA.get()
    universe = broad.load_stock_universe_frame(
        stocks_data_dir=DATA_DIR / "stocks", categories_data_dir=DATA_DIR / "categories"
    )
    frame = universe.frame
    atomics = outer.reindex(frame.index)[list(ATOMIC_NAMES)]
    full_frame = pd.concat([frame, atomics], axis=1)
    weeks = list(full_frame.index)

    config = Config(lookbacks=(1, 4, 13, 26, 52), universe=tuple(full_frame.columns))
    global_ranks, _ = levers.skip_month_ranks(full_frame, config)

    pool_membership = broad._compute_pool_membership(
        global_ranks[list(frame.columns)],
        universe.stock_membership,
        weeks,
        top_n=broad.DEFAULT_POOL_TOP_N,
        exit_rank=broad.DEFAULT_POOL_EXIT_RANK,
    )
    stock_pool_ranks = broad._dense_rank(global_ranks[list(frame.columns)].where(pool_membership))
    combined_eligible = pd.DataFrame(False, index=weeks, columns=full_frame.columns)
    combined_eligible[list(frame.columns)] = pool_membership
    for name in ATOMIC_NAMES:
        combined_eligible[name] = full_frame[name].notna()
    combined_pool_ranks = broad._dense_rank(global_ranks.where(combined_eligible))
    _ = compose  # imported for symmetry with compute_universe_ranking; not otherwise needed here

    return UniverseRanking(
        prices=full_frame,
        weeks=weeks,
        global_ranks=global_ranks,
        pool_membership=pool_membership,
        stock_pool_ranks=stock_pool_ranks,
        combined_pool_ranks=combined_pool_ranks,
        column_to_base_symbol=universe.column_to_base_symbol,
        events=universe.events,
        stale_columns=universe.stale_columns,
        missing_symbols=universe.missing_symbols,
    )


def p1_study(mode: str) -> alpha.Study:
    """P1's three settings-only variants, on one Broad mode ("on" or "off")."""
    base_ranking = alpha.broad_ranking()
    base_run = alpha.Memo(broad_runner(mode, base_ranking))

    weights_a = alpha.broad_ranking((1, 0, 1, 1, 1))
    weights_b = alpha.broad_ranking((0, 0, 1, 1, 1))
    skip_month = skip_month_broad_ranking()

    return alpha.Study(
        f"pullback_p1_{mode}",
        [
            alpha.Variant("base", base_run, "dashboard Broad Momentum defaults"),
            alpha.Variant(
                "p1a weights 1,0,1,1,1",
                broad_runner(mode, weights_a, weights=(1, 0, 1, 1, 1)),
                "drop the 4-week lookback",
                fork_caveat=True,
            ),
            alpha.Variant(
                "p1b weights 0,0,1,1,1",
                broad_runner(mode, weights_b, weights=(0, 0, 1, 1, 1)),
                "drop the 1-week and 4-week lookbacks",
                fork_caveat=True,
            ),
            alpha.Variant(
                "p1c skip-month ranking",
                broad_runner(mode, skip_month),
                "3-1/6-1/12-1 month windows (levers.skip_month_ranks); never run on Broad before",
                fork_caveat=True,
            ),
        ],
    )


def run_p1(only: set[str] | None = None) -> dict[str, pd.DataFrame]:
    results = {}
    for mode in ("on", "off"):
        print(f"\n=== P1, category mode {mode} ===", flush=True)
        study = p1_study(mode)
        summary, windows = alpha.evaluate(study, only)
        print(summary.to_string())
        summary.to_csv(out_dir() / f"p1_{mode}_summary.csv")
        windows.to_csv(out_dir() / f"p1_{mode}_windows.csv")
        results[mode] = summary
    return results


# ---------------------------------------------------------------------------------------------
# P2: does the pullback state predict returns?
# ---------------------------------------------------------------------------------------------


def broad_pool_frames() -> tuple[pd.DataFrame, pd.DataFrame, pd.DataFrame]:
    """(prices, pool membership mask, LT percentile) on Broad's qualifying pool, the whole
    available history (no start/end restriction - P2 is a measurement, not a backtest)."""
    ranking = alpha.broad_ranking()
    u = vtt.build_universe(ranking)
    lt = levers.long_term_strength(u.prices, LT_LOOKBACKS, eligible=u.pool)
    return u.prices, u.pool, lt


def p2_flags(prices: pd.DataFrame, pool: pd.DataFrame, lt: pd.DataFrame):
    """LT-strong (within the pool), Stage (the 1% slope rule, `vtt.stages`), PB and PBR."""
    strong = levers.long_term_strong_mask(lt.where(pool), LT_TOP_PCT)
    ok = vtt.history_ok(prices)
    stage, _weeks_in = vtt.stages(prices, ok)
    dist13 = levers.dist_from_high(prices)
    pb, pbr = levers.pullback_flags(prices, strong, stage, dist13, low=PB_LOW, high=PB_HIGH)
    return strong, pb, pbr


def _predictive_weekly(
    pool: pd.DataFrame, lt: pd.DataFrame, flag: pd.DataFrame, fwd: dict[int, pd.DataFrame]
) -> pd.DataFrame:
    """Per week: `flag_coefficient` of each `fwd[h]` on LT (percentile-rank control) and the
    0/1 `flag`, within LT-strong names (the flag is only ever 1 for a name already in the
    pool; LT itself is the control for every pool name so the regression has the same control
    population `flag_coefficient` expects). Shared by `predictive_weekly` (P2, forward return)
    and `p2b_predictive_weekly` (P2b, forward drawdown/volatility)."""
    rows = {}
    for week in pool.index:
        names = pool.columns[pool.loc[week].to_numpy(dtype=bool)]
        if len(names) < vtt.MIN_NAMES:
            continue
        x = flag.loc[week, names]
        ctrl = pd.DataFrame({"LT": lt.loc[week, names]})
        on = int((x == 1).sum())
        if on < MIN_NAMES_EACH_SIDE or len(names) - on < MIN_NAMES_EACH_SIDE:
            continue
        row = {"n": len(names), "n_flagged": on}
        for h, f in fwd.items():
            row[f"coef_{h}"] = vtt.flag_coefficient(f.loc[week, names], ctrl, x)
        rows[week] = row
    return pd.DataFrame.from_dict(rows, orient="index")


def predictive_weekly(
    prices: pd.DataFrame,
    pool: pd.DataFrame,
    lt: pd.DataFrame,
    flag: pd.DataFrame,
    stale: dict | None = None,
) -> pd.DataFrame:
    """P2: per week, `flag_coefficient` of the forward return on LT and the 0/1 `flag`, for
    each of `PREDICTIVE_HORIZONS` - within LT-strong names."""
    fwd = {h: vtt.forward_returns(prices, h, stale) for h in PREDICTIVE_HORIZONS}
    return _predictive_weekly(pool, lt, flag, fwd)


def forward_max_drawdown(prices: pd.DataFrame, horizon: int) -> pd.DataFrame:
    """Worst peak-to-trough decline over the next `horizon` weeks, anchored forward from t (the
    running peak starts at P[t] and only ever rises across t+1..t+horizon) - the standard
    rolling max-drawdown definition, just forward-looking instead of backward. Always <= 0;
    0 means the price never dipped below today's level anywhere in the window. NaN once the
    window runs past the end of the series (`prices.shift(-horizon)` has nothing to compare)."""
    running_max = prices.copy()
    dd = pd.DataFrame(0.0, index=prices.index, columns=prices.columns)
    for k in range(1, horizon + 1):
        shifted = prices.shift(-k)
        running_max = np.maximum(running_max, shifted)
        dd = np.minimum(dd, shifted / running_max - 1)
    incomplete = prices.shift(-horizon).isna() | prices.isna()
    return dd.mask(incomplete)


def forward_volatility(prices: pd.DataFrame, horizon: int) -> pd.DataFrame:
    """Population stdev of the `horizon` weekly returns from t+1 to t+horizon. NaN if any of
    those returns is missing (an incomplete window, same cutoff as `forward_max_drawdown`)."""
    rets = prices.pct_change(1)
    stacked = np.stack([rets.shift(-k).to_numpy() for k in range(1, horizon + 1)], axis=0)
    vol = np.nanstd(stacked, axis=0, ddof=0)
    vol = np.where(np.isnan(stacked).any(axis=0), np.nan, vol)
    return pd.DataFrame(vol, index=prices.index, columns=prices.columns)


P2B_HORIZONS = (4, 13)


def p2b_predictive_weekly(
    pool: pd.DataFrame, lt: pd.DataFrame, pb: pd.DataFrame, fwd: dict[int, pd.DataFrame]
) -> pd.DataFrame:
    """P2b (exploratory, added to the spec and run after seeing P2 fail its return test): does
    PB protect on the downside even though it does not predict a better forward return? `fwd`
    must already be signed so that positive = "PB names fell less" - `forward_max_drawdown`
    as-is (less negative is shallower), or the negative of `forward_volatility` (lower raw vol
    is calmer, so its negative is "positive = fell less" on the same convention). PB only, not
    PBR - the spec's own choice, since PBR's much smaller sample already failed P2 outright."""
    return _predictive_weekly(pool, lt, pb, fwd)


def summarise_predictive(weekly: pd.DataFrame, calendar: pd.DatetimeIndex) -> pd.DataFrame:
    """Mean, 4-week block CI, both halves, and the same with 2020 excluded - the spec's own
    pass inputs, same shape as `vtt.v2_summary`."""
    w = weekly.reindex(calendar)
    years = calendar.year
    first = calendar <= pd.Timestamp(FIRST_HALF_END)
    rows = []
    for h in PREDICTIVE_HORIZONS:
        col = f"coef_{h}"
        if col not in w.columns:
            continue
        x = w[col]
        for variant, mask in (("all years", np.ones(len(x), bool)), ("ex 2020", years != 2020)):
            sel = x[mask]
            lo, hi = vtt.bootstrap_ci(x, mask, brt.BOOTSTRAP_BLOCK)
            rows.append(
                {
                    "horizon": h,
                    "variant": variant,
                    "weeks": int(sel.notna().sum()),
                    "mean": float(sel.mean()),
                    "lo": lo,
                    "hi": hi,
                    "2017-2021": float(x[mask & first].mean()),
                    "2022+": float(x[mask & ~first].mean()),
                    "names_per_week": float(w["n"][mask].mean()),
                    "flagged_per_week": float(w["n_flagged"][mask].mean()),
                }
            )
    return pd.DataFrame(rows)


def p2_pass(table: pd.DataFrame) -> bool:
    """The spec's pass rule: positive, interval excludes zero, at both 4 and 13 weeks, in both
    halves, with and without 2020. (The Nifty 50 same-sign cross-check is reported separately,
    not folded into this boolean - the spec only asks that its sign be reported.)"""
    allyrs = table[table["variant"] == "all years"].set_index("horizon")
    ex2020 = table[table["variant"] == "ex 2020"].set_index("horizon")
    for h in PASS_HORIZONS:
        if h not in allyrs.index:
            return False
        r = allyrs.loc[h]
        if not (r["lo"] > 0):
            return False
        if not (r["2017-2021"] > 0 and r["2022+"] > 0):
            return False
        if h in ex2020.index and not (ex2020.loc[h, "mean"] > 0):
            return False
    return True


def nifty50_cross_check() -> dict:
    """The point-in-time Nifty 50 stock layer (no survivorship bias), top 30% by LT (the
    universe is only ~50 names, so a 20% band would leave too few flagged names most weeks).
    Reports the sign only, even if not significant - the spec's own instruction."""
    stock = ott._stock_dataset()
    prices = stock.prices[[c for c in stock.companies if c in stock.prices.columns]]
    last_week = stock.membership.index[-1]
    pool = stock.membership.reindex(columns=prices.columns).fillna(False).astype(bool)
    pool = pool.reindex(index=prices.index).fillna(False)
    lt = levers.long_term_strength(prices, LT_LOOKBACKS, eligible=pool)
    strong = levers.long_term_strong_mask(lt.where(pool), 0.30)
    ok = vtt.history_ok(prices)
    stage, _ = vtt.stages(prices, ok)
    dist13 = levers.dist_from_high(prices)
    pb, pbr = levers.pullback_flags(prices, strong, stage, dist13, low=PB_LOW, high=PB_HIGH)
    out = {"last_week": _ts(last_week), "n_pool": int(pool.loc[last_week].sum())}
    for name, flag in (("PB", pb), ("PBR", pbr)):
        weekly = predictive_weekly(prices, pool, lt, flag)
        if weekly.empty:
            out[name] = {"sign": None, "weeks": 0}
            continue
        signs = {}
        for h in PASS_HORIZONS:
            col = f"coef_{h}"
            if col in weekly.columns and weekly[col].notna().any():
                signs[h] = float(np.sign(weekly[col].mean()))
        out[name] = {"sign": signs, "weeks": int(len(weekly))}
    return out


def run_p2() -> dict:
    print("\n=== P2: does the pullback state predict returns? ===", flush=True)
    prices, pool, lt = broad_pool_frames()
    strong, pb, pbr = p2_flags(prices, pool, lt)
    calendar = prices.loc[alpha.FIXED["full"] : END].index

    reports = {}
    for name, flag in (("PB", pb), ("PBR", pbr)):
        weekly = predictive_weekly(prices, pool, lt.where(strong), flag.where(strong))
        summary = summarise_predictive(weekly, calendar)
        summary.to_csv(out_dir() / f"p2_{name.lower()}_summary.csv", index=False)
        weekly.to_csv(out_dir() / f"p2_{name.lower()}_weekly.csv")
        passed = p2_pass(summary)
        print(f"\n--- {name} ---")
        print(summary.to_string(index=False))
        print(f"{name} pass: {passed}")
        reports[name] = {"summary": summary, "pass": passed}

    print("\n--- Nifty 50 point-in-time cross-check ---")
    cross = nifty50_cross_check()
    print(cross)
    reports["nifty50_cross_check"] = cross

    print("\n--- P2b (exploratory): does PB protect on the downside? ---")
    strong_pb = pb.where(strong)
    strong_lt = lt.where(strong)
    metrics_fwd = {
        "drawdown": {h: forward_max_drawdown(prices, h) for h in P2B_HORIZONS},
        "volatility": {h: -forward_volatility(prices, h) for h in P2B_HORIZONS},
    }
    for metric, fwd in metrics_fwd.items():
        weekly = p2b_predictive_weekly(pool, strong_lt, strong_pb, fwd)
        summary = summarise_predictive(weekly, calendar)
        summary.to_csv(out_dir() / f"p2b_{metric}_summary.csv", index=False)
        weekly.to_csv(out_dir() / f"p2b_{metric}_weekly.csv")
        passed = p2_pass(summary)
        print(f"\n--- P2b {metric} ---")
        print(summary.to_string(index=False))
        print(f"P2b {metric} pass: {passed}")
        reports[f"p2b_{metric}"] = {"summary": summary, "pass": passed}
    return reports


# ---------------------------------------------------------------------------------------------
# P3: exit side - hold through a small pullback
# ---------------------------------------------------------------------------------------------


def p3_study() -> alpha.Study:
    """Category mode off, through custom ranks (the spec's own wording): a held name's rank is
    capped at `exit_rank` while it is in PB state, so it is not sold while the pullback lasts
    but is never a fresh buy for that reason (`levers.cap_rank_during_pullback` - static, needs
    no simulation-time holdings, see that function's own docstring)."""
    ranking = alpha.broad_ranking()
    prices, pool, lt = broad_pool_frames()
    strong, pb, pbr = p2_flags(prices, pool, lt)
    exit_rank = 20  # the spec's "secondary" off-mode setting (top 10 / exit 20)

    def capped_run(flag: pd.DataFrame):
        def run(start, end):
            ranks = ranking.stock_pool_ranks
            # build_off_mode_ranks derives its own scores as -stock_pool_ranks, so only the
            # rank table itself needs to carry the cap through.
            capped = levers.cap_rank_during_pullback(ranks, flag.reindex_like(ranks), exit_rank)
            capped_ranking = broad.UniverseRanking(
                prices=ranking.prices,
                weeks=ranking.weeks,
                global_ranks=ranking.global_ranks,
                pool_membership=ranking.pool_membership,
                stock_pool_ranks=capped,
                combined_pool_ranks=ranking.combined_pool_ranks,
                column_to_base_symbol=ranking.column_to_base_symbol,
                events=ranking.events,
                stale_columns=ranking.stale_columns,
                missing_symbols=ranking.missing_symbols,
            )
            return broad_runner("off", capped_ranking)(start, end)

        return run

    return alpha.Study(
        "pullback_p3",
        [
            alpha.Variant("base", alpha.Memo(broad_runner("off", ranking))),
            alpha.Variant("p3 hold through PB", capped_run(pb), "cap the rank at exit_rank in PB"),
            alpha.Variant(
                "p3 hold through PBR", capped_run(pbr), "cap the rank at exit_rank in PBR"
            ),
        ],
    )


def run_p3(only: set[str] | None = None) -> pd.DataFrame:
    print("\n=== P3: exit side - hold through a small pullback ===", flush=True)
    summary, windows = alpha.evaluate(p3_study(), only)
    print(summary.to_string())
    summary.to_csv(out_dir() / "p3_summary.csv")
    windows.to_csv(out_dir() / "p3_windows.csv")
    return summary


# ---------------------------------------------------------------------------------------------
# P4: entry ranking (only meaningful if P2 passes)
# ---------------------------------------------------------------------------------------------


def p4_study() -> alpha.Study:
    """`levers.pullback_ranks` through `run_broad_backtest`'s `stock_tilt_ranks` hook (the
    existing re-order-what-the-funnel-already-picked mechanism `stock_tilt`/`grouped_momentum_
    ranks` already uses for TODO 3.9.23's follow-up - see that parameter's own comment in
    broad.py for why `stock_tilt_ranks` is the right hook to reuse rather than inventing a
    second one). `stock_tilt` is set to a nominal 1.0 only to enter that branch; the actual
    tilt strength is "baked into" the ranks `pullback_ranks` already produced, so what
    `stock_tilt` is set to beyond "> 0" has no further effect. Note (reported, not hidden):
    that branch also always ORs in `fresh_52w_low_mask`, on top of `extra_no_buy`'s own
    `pullback_no_buy_mask`/`pullback_turn_no_buy_mask` - see `pullback_ranks`'s docstring."""
    ranking = alpha.broad_ranking()
    prices, pool, lt = broad_pool_frames()
    strong, _pb, _pbr = p2_flags(prices, pool, lt)
    stage, _ = vtt.stages(prices, vtt.history_ok(prices))
    dist13 = levers.dist_from_high(prices)
    ret1 = prices.pct_change(1)

    def tilted_run(tilt: float, require_turn: bool):
        pb_ranks, _ = levers.pullback_ranks(prices, lt, strong, tilt=tilt)
        no_buy = (
            levers.pullback_turn_no_buy_mask(stage, dist13, ret1)
            if require_turn
            else levers.pullback_no_buy_mask(stage, dist13)
        )

        no_buy_full = no_buy.reindex(index=ranking.prices.index, columns=ranking.prices.columns)

        def run(start, end):
            return broad_runner(
                "on",
                ranking,
                stock_tilt=1.0,
                stock_tilt_ranks=(pb_ranks, -pb_ranks),
                extra_no_buy=no_buy_full,
            )(start, end)

        return run

    base_run = alpha.Memo(broad_runner("on", ranking))
    variants = [alpha.Variant("base", base_run)]
    for tilt in (0.3, 0.5):
        variants.append(
            alpha.Variant(f"p4 tilt {tilt}", tilted_run(tilt, False), "pullback_ranks, no turn req")
        )
        variants.append(
            alpha.Variant(
                f"p4 tilt {tilt} + turn", tilted_run(tilt, True), "pullback_ranks, turned-up no_buy"
            )
        )
    return alpha.Study("pullback_p4", variants)


def run_p4(only: set[str] | None = None) -> pd.DataFrame:
    print("\n=== P4: entry ranking ===", flush=True)
    summary, windows = alpha.evaluate(p4_study(), only)
    print(summary.to_string())
    summary.to_csv(out_dir() / "p4_summary.csv")
    windows.to_csv(out_dir() / "p4_windows.csv")
    return summary


# ---------------------------------------------------------------------------------------------
# P5: does it stack with the cadence fix?
# ---------------------------------------------------------------------------------------------


def run_p5(make_run, label: str, mode: str, every: int = 2) -> dict:
    """For a passing P1/P3/P4 variant, rerun it on the every-`every`-weeks N-tranche blend and
    compare with that blend alone. If the gain disappears, the two levers are the same effect.

    `mode` must be the SAME category mode ("on" or "off") the passing variant itself used -
    the cadence-alone baseline is built in that mode too, or the comparison is meaningless
    (mode off always has a much deeper drawdown than mode on; building the wrong mode's
    baseline previously produced a false 0% MaxDD win share that was actually just the mode
    gap, not a stacking result). A runtime assertion below checks the baseline's plain
    full-sample MaxDD against the known value for that mode (`_MODE_BASE_MAXDD`) and fails
    loudly rather than silently if the wrong mode was built.

    `make_run(rebalance_every=..., rebalance_offset=...) -> RunWindow` must accept those two
    keywords and thread them into the same `run_broad_backtest` call its P1/P3/P4 variant
    uses, exactly like `broad_runner(mode, ranking, **extra)` already does - pass e.g.
    `lambda **kw: broad_runner("off", ranking, weights=(1, 0, 1, 1, 1), **kw)` for a passing P1
    weights variant, or a closure built the same way over a P3/P4 ranking - always the same
    `mode` string passed to this function."""
    from momentum_backtesting import tranches

    print(
        f"\n=== P5: does '{label}' stack with the every-{every}-weeks cadence fix, mode {mode}? ==="
    )
    ranking = alpha.broad_ranking()

    base_check = broad_runner(mode, ranking)(pd.Timestamp(alpha.FIXED["full"]), pd.Timestamp(END))
    base_maxdd = metrics.curve_stats(base_check.equity, base_check.cash)["max drawdown"]
    expected = _MODE_BASE_MAXDD[mode]
    if abs(base_maxdd - expected) > 0.01:
        raise AssertionError(
            f"run_p5(mode={mode!r}): cadence-alone baseline's plain full-sample MaxDD "
            f"({base_maxdd:.4f}) does not match the known mode-{mode} base ({expected:.4f}) - "
            "the cadence-alone baseline was probably built in the wrong mode."
        )

    def blend_of(run_window) -> alpha.RunWindow:
        def run(start, end):
            return tranches.run_tranches(
                lambda cfg: run_window(
                    rebalance_every=every, rebalance_offset=cfg.rebalance_offset
                )(start, end),
                Config(),
                every,
            )

        return run

    cadence_alone = alpha.Memo(blend_of(lambda **kw: broad_runner(mode, ranking, **kw)))
    stacked = blend_of(make_run)

    study = alpha.Study(
        f"pullback_p5_{label}",
        [
            alpha.Variant("cadence alone", cadence_alone, baseline="cadence alone"),
            alpha.Variant(
                f"{label} + cadence",
                stacked,
                "stacked on the every-K blend",
                baseline="cadence alone",
            ),
        ],
    )
    summary, windows = alpha.evaluate(study, None)
    print(summary.to_string())
    safe_label = label.replace(" ", "_").replace("/", "_")
    summary.to_csv(out_dir() / f"p5_{safe_label}_summary.csv")
    windows.to_csv(out_dir() / f"p5_{safe_label}_windows.csv")
    return {"summary": summary, "windows": windows}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("stage", choices=["p1", "p2", "p3", "p4", "p5", "all"])
    parser.add_argument("--only", default="", help="comma-separated variant labels (p1/p3/p4)")
    args = parser.parse_args()
    only = set(args.only.split(",")) if args.only else None

    t = time.time()
    if args.stage in ("p1", "all"):
        run_p1(only)
    if args.stage in ("p2", "all"):
        run_p2()
    if args.stage in ("p3", "all"):
        run_p3(only)
    if args.stage in ("p4", "all"):
        run_p4(only)
    if args.stage == "p5":
        print("p5 needs a specific passing variant - call run_p5() directly from a session.")
    print(f"\ndone in {time.time() - t:.0f}s", flush=True)


if __name__ == "__main__":
    main()
