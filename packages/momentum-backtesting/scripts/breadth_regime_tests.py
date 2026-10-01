"""Breadth and trend regime tests for the momentum strategy (TODO.md 3.9.24).

The spec is docs/momentum-breadth-regime-tests.md. In short:

- T0: bucket every week by Total Market breadth (B10) and compare the strategy's forward returns
  per bucket, with a 4-week block bootstrap interval.
- T1: 21 exposure overlays (S0-S5) applied post hoc to ONE unchanged backtest's weekly returns.
- T2: the owner's literal rule through the engine's own `mass_exit_throttle` hook.

Run from packages/momentum-backtesting:

    uv run python scripts/breadth_regime_tests.py t0      # breadth + strategies + T0 table
    uv run python scripts/breadth_regime_tests.py t1      # T1 overlays + T2 engine runs

`t1` reuses the strategy series `t0` saved (rerun `t0` after a data refresh). Everything is
written to data/backtests/regime/ (gitignored). engine.py is used, never changed.

No lookahead: every input at week t uses closes up to and including t only (rolling windows,
expanding medians), and an overlay's w[t] is applied to the return from t to t+1.
"""

from __future__ import annotations

import argparse
import math
from dataclasses import replace
from pathlib import Path

import numpy as np
import pandas as pd

WEEKS_PER_YEAR = 52
MIN_ELIGIBLE = 100
MIN_HOLD_WEEKS = 2
BOOTSTRAP_REPS = 2000
BOOTSTRAP_BLOCK = 4
SEED = 20261001

# Named episodes: (label, first week, last week). The drawdown is measured inside the window,
# from the window's own running peak.
EPISODES = (
    ("2018 small/mid-cap fall", "2018-01-01", "2019-06-30"),
    ("2020 COVID crash and rebound", "2020-01-01", "2020-12-31"),
    ("2022", "2021-10-01", "2022-12-31"),
)


# ---------------------------------------------------------------------------------------------
# Inputs (pure functions - unit-tested in tests/test_breadth_regime.py)
# ---------------------------------------------------------------------------------------------


def breadth(
    prices: pd.DataFrame, members: pd.DataFrame, window: int
) -> tuple[pd.Series, pd.Series]:
    """(percent above the `window`-week average, eligible count) per week.

    A name counts in week t only if it is a member that week AND its last `window` weekly closes
    (t included) are all present - the full average history. The average at t uses closes up to
    t only, so nothing here looks ahead."""
    members = members.reindex(index=prices.index, columns=prices.columns).fillna(False).astype(bool)
    average = prices.rolling(window, min_periods=window).mean()
    eligible = members & average.notna() & prices.notna()
    above = (prices > average) & eligible
    count = eligible.sum(axis=1)
    pct = 100.0 * above.sum(axis=1) / count.where(count > 0)
    return pct.rename(f"B{window}"), count.rename(f"eligible{window}")


def trend_flag(close: pd.Series, window: int = 40, slope_lag: int = 4) -> pd.Series:
    """True when the close is above its `window`-week average and that average is higher than
    `slope_lag` weeks ago. False (not NaN) while the history is too short."""
    average = close.rolling(window, min_periods=window).mean()
    flag = (close > average) & (average > average.shift(slope_lag))
    return flag.fillna(False).astype(bool).rename("T")


def apply_hold(target: pd.Series, min_hold: int = MIN_HOLD_WEEKS) -> pd.Series:
    """Hysteresis: once the exposure changes, keep the new value for at least `min_hold` weeks
    before allowing the next change. The first week starts at the target value."""
    values = target.to_numpy(dtype=float)
    out = np.empty_like(values)
    current = values[0]
    since = min_hold  # the starting state may change at once
    for i, wanted in enumerate(values):
        if not math.isclose(wanted, current) and since >= min_hold:
            current = wanted
            since = 0
        out[i] = current
        since += 1
    return pd.Series(out, index=target.index, name=target.name)


def overlay_returns(
    strategy_ret: pd.Series, cash_ret: pd.Series, w: pd.Series, cost_pct: float
) -> pd.DataFrame:
    """r[t+1] = w[t] r_s[t+1] + (1 - w[t]) r_c[t+1] - cost[t], cost[t] = |w[t] - w[t-1]| * 2 *
    cost_pct / 100. Returns a frame indexed like the inputs with columns ret, cost, exposure
    (the w that earned that week's return). The week before the first is treated as w = 1."""
    w = w.reindex(strategy_ret.index).astype(float)
    cost = (w - w.shift(1).fillna(1.0)).abs() * 2 * cost_pct / 100
    applied = w.shift(1)
    applied_cost = cost.shift(1)
    ret = applied * strategy_ret + (1 - applied) * cash_ret - applied_cost
    frame = pd.DataFrame({"ret": ret, "cost": applied_cost, "exposure": applied})
    return frame.iloc[1:]


def equity_from(ret: pd.Series) -> pd.Series:
    """Equity at 1.0 the week before the first return."""
    start = ret.index[0] - pd.Timedelta(weeks=1)
    return pd.concat([pd.Series([1.0], index=[start]), (1 + ret).cumprod()])


def metrics_from_returns(ret: pd.Series, cash_ret: pd.Series) -> dict[str, float]:
    equity = equity_from(ret)
    years = (equity.index[-1] - equity.index[0]).days / 365.25
    cagr = equity.iloc[-1] ** (1 / years) - 1
    excess = ret - cash_ret.reindex(ret.index)
    sharpe = excess.mean() / excess.std() * math.sqrt(WEEKS_PER_YEAR)
    max_dd = (equity / equity.cummax() - 1).min()
    return {
        "CAGR": cagr,
        "Sharpe": sharpe,
        "max_dd": max_dd,
        "Calmar": cagr / abs(max_dd) if max_dd < 0 else float("nan"),
    }


def episodes(mask: pd.Series) -> int:
    """Number of separate runs of consecutive True weeks."""
    m = mask.fillna(False).astype(bool).to_numpy()
    return int(m[0]) + int(((~m[:-1]) & m[1:]).sum()) if len(m) else 0


def block_bootstrap_means(
    values: np.ndarray,
    masks: dict[str, np.ndarray],
    reps: int = BOOTSTRAP_REPS,
    block: int = BOOTSTRAP_BLOCK,
    seed: int = SEED,
) -> dict[str, np.ndarray]:
    """Circular block bootstrap of the mean of `values` inside each mask. Labels stay attached
    to their week, so autocorrelation and regime persistence survive the resampling."""
    rng = np.random.default_rng(seed)
    n = len(values)
    starts = rng.integers(0, n, size=(reps, -(-n // block)))
    idx = (starts[:, :, None] + np.arange(block)[None, None, :]).reshape(reps, -1)[:, :n] % n
    sampled = values[idx]
    out = {}
    for name, mask in masks.items():
        m = mask[idx]
        with np.errstate(invalid="ignore", divide="ignore"):
            out[name] = (sampled * m).sum(axis=1) / m.sum(axis=1)
    return out


# ---------------------------------------------------------------------------------------------
# Data and strategies
# ---------------------------------------------------------------------------------------------


def out_dir() -> Path:
    from momentum_backtesting.config import DATA_DIR

    path = DATA_DIR / "backtests" / "regime"
    path.mkdir(parents=True, exist_ok=True)
    return path


def load_outer_prices() -> pd.DataFrame:
    """Weekly closes the same way the API reads them: the shared database first, CSV fallback."""
    from momentum_backtesting import db_read
    from momentum_backtesting.config import DATA_DIR

    from_db = db_read.weekly_closes_from_db_or_none()
    if from_db is not None:
        return from_db
    return pd.read_csv(DATA_DIR / "weekly_closes.csv", index_col=0, parse_dates=True)


def compute_breadth_frame(outer: pd.DataFrame) -> tuple[pd.DataFrame, pd.DataFrame]:
    """Weekly breadth table (Total Market) and the Nifty 50 stock-layer cross-check table."""
    from momentum_backtesting.categories import broad
    from momentum_backtesting.config import DATA_DIR
    from momentum_backtesting.engine import BENCHMARK

    universe = broad.load_stock_universe_frame(
        stocks_data_dir=DATA_DIR / "stocks", categories_data_dir=DATA_DIR / "categories"
    )
    b10, n10 = breadth(universe.frame, universe.stock_membership, 10)
    b40, n40 = breadth(universe.frame, universe.stock_membership, 40)
    b10 = b10.where(n10 >= MIN_ELIGIBLE)
    b40 = b40.where(n40 >= MIN_ELIGIBLE)
    nifty = outer[BENCHMARK].dropna()
    table = pd.DataFrame({"B10": b10, "B40": b40, "eligible10": n10, "eligible40": n40})
    table["dB"] = table["B10"] - table["B10"].shift(4)
    table = table.join(nifty.rename("nifty"), how="left")
    table["T"] = trend_flag(nifty).reindex(table.index)
    table = table[table.index >= nifty.index[0]]

    # Cross-check on the survivorship-free Nifty 50 layer: point-in-time membership, and the
    # same layer with TODAY's members applied to every week (what constant-current membership
    # does to the Total Market numbers above).
    # Read straight from the files `mbt stocks fetch` writes (price, not total return, to match
    # the Total Market frame): only prices and membership are needed here.
    stock_dir = DATA_DIR / "stocks"
    px_all = pd.read_csv(stock_dir / "nifty50_weekly_price.csv", index_col=0, parse_dates=True)
    pit_all = pd.read_csv(
        stock_dir / "nifty50_membership_weekly.csv", index_col=0, parse_dates=True
    )
    companies = [c for c in pit_all.columns if c in px_all.columns]
    px = px_all[companies]
    pit = pit_all[companies].reindex(px.index).fillna(False).astype(bool)
    current = pit.iloc[-1]
    constant = pd.DataFrame(
        np.repeat(current.to_numpy()[None, :], len(pit), axis=0), index=pit.index, columns=companies
    )
    n50_pit, n50_pit_n = breadth(px, pit, 10)
    n50_const, n50_const_n = breadth(px, constant, 10)
    cross = pd.DataFrame(
        {
            "TM_B10": table["B10"],
            "N50_B10_pit": n50_pit,
            "N50_pit_eligible": n50_pit_n,
            "N50_B10_today_members": n50_const,
            "N50_today_eligible": n50_const_n,
        }
    )
    return table, cross


def run_etf_base():
    from momentum_backtesting.config import DATA_DIR
    from momentum_backtesting.engine import run_backtest
    from momentum_backtesting.fetch import load_universe
    from momentum_backtesting.trade_prices import build_trade_prices
    from momentum_backtesting.weekly import load_live_config

    config = load_live_config().config
    prices = load_outer_prices()
    universe = load_universe()
    includes = {i.name: i.include for i in universe}
    fills = build_trade_prices(prices, config.track, config.execution, universe, DATA_DIR)
    trade_prices = fills.prices if fills is not None else None

    def run(cfg, mass_exit_weeks=None):
        return run_backtest(
            prices, includes, cfg, trade_prices=trade_prices, mass_exit_weeks=mass_exit_weeks
        )

    valuation = prices if trade_prices is None else trade_prices.reindex(prices.index)
    return config, run, valuation


def run_broad_base():
    """Shipped Broad Momentum defaults: (result, rerun function, valuation prices)."""
    outcome, run, prices, _ = run_broad_outcome()
    return outcome.result, run, prices


def run_broad_outcome(**overrides):
    """Broad Momentum with the shipped UI defaults plus `overrides` (any `run_broad_backtest`
    keyword). Returns (outcome, rerun function, valuation prices, over-price-ceiling mask)."""
    from momentum_backtesting import engine
    from momentum_backtesting.categories import broad
    from momentum_backtesting.config import DATA_DIR

    outer = load_outer_prices()
    curated = Path(broad.__file__).parent / "curated"
    kwargs = {
        "max_position": broad.DEFAULT_MAX_POSITION,
        "max_category": broad.DEFAULT_MAX_CATEGORY,
        "max_stock_price": broad.DEFAULT_MAX_STOCK_PRICE,
        **overrides,
    }
    if kwargs.get("category_mode", "on") == "off":
        kwargs["max_category"] = None  # api.py passes no category cap in OFF mode
    outcome = broad.run_broad_backtest(
        outer_prices=outer,
        stocks_data_dir=DATA_DIR / "stocks",
        categories_data_dir=DATA_DIR / "categories",
        curated_dir=curated,
        **kwargs,
    )
    base = outcome.result
    # Rebuild exactly the inputs run_broad_backtest handed the engine, so T2 can rerun the same
    # backtest with only the mass-exit throttle switched on (run_broad_backtest only accepts its
    # own category-layer trigger, not an external week list).
    prices = outcome.ranking.prices.copy()
    prices[engine.CASH] = outer.reindex(prices.index)[engine.CASH]
    prices[base.config.benchmark] = outer.reindex(prices.index)[base.config.benchmark]
    effective = outcome.effective
    groups = effective.groups.reindex(prices.index) if effective.groups is not None else None
    over = broad.price_ceiling_mask(outcome.ranking.prices, kwargs["max_stock_price"])
    includes = {c: "core" for c in prices.columns}
    ranks = (effective.ranks.reindex(prices.index), effective.scores.reindex(prices.index))

    def run(cfg, mass_exit_weeks=None):
        return engine.run_backtest(
            prices,
            includes,
            cfg,
            external_ranks=ranks,
            mass_exit_weeks=mass_exit_weeks,
            groups=groups,
            no_buy=over.reindex(prices.index) if over is not None else None,
        )

    return outcome, run, prices, over


STRATEGIES = {"etf": "ETF (live_config.toml)", "broad": "Broad Momentum (shipped defaults)"}


def weekly_marks(
    equity: pd.Series,
    weights: pd.DataFrame,
    prices: pd.DataFrame,
    cash_col: str,
    idle_col: str,
) -> pd.DataFrame:
    """Fill the weeks `engine.run_backtest` skipped with a mark-to-market of what was held.

    The engine drops a week entirely when fewer than `top_n` names are ranked (its `enough`
    gate). Shipped Broad Momentum hits this in about 38% of weeks. Nothing trades in a skipped
    week, so the portfolio is the last kept week's post-trade weights, carried at constant units:
    value[t] = equity[k] * sum_i weights[k, i] * price_i[t] / price_i[k]. The idle column is
    priced as the liquid fund. Kept weeks keep the engine's own equity unchanged."""
    calendar = prices.index[(prices.index >= equity.index[0]) & (prices.index <= equity.index[-1])]
    px = prices.ffill()
    marked = equity.reindex(calendar).astype(float)
    kept = set(equity.index)
    last = calendar[0]
    for week in calendar:
        if week in kept:
            last = week
            continue
        held = weights.loc[last]
        held = held[held.abs() > 1e-12]
        cols = [cash_col if c == idle_col else c for c in held.index]
        rel = px.loc[week, cols].to_numpy() / px.loc[last, cols].to_numpy()
        marked[week] = equity[last] * float((held.to_numpy() * rel).sum())
    cash = px[cash_col].reindex(calendar)
    return pd.DataFrame(
        {"equity": marked, "cash": cash / cash.iloc[0], "engine_week": calendar.isin(kept)},
        index=calendar,
    )


def mark_check(result, prices: pd.DataFrame) -> float:
    """Largest gap between the carried-forward mark and the engine's own equity at the kept week
    that ends each skipped run (costs and that week's trades explain a small residual)."""
    from momentum_backtesting.engine import CASH, IDLE

    eq = result.equity
    px = prices.ffill()
    worst = 0.0
    for prev, week in zip(eq.index[:-1], eq.index[1:], strict=True):
        held = result.weights.loc[prev]
        held = held[held.abs() > 1e-12]
        cols = [CASH if c == IDLE else c for c in held.index]
        rel = px.loc[week, cols].to_numpy() / px.loc[prev, cols].to_numpy()
        implied = eq[prev] * float((held.to_numpy() * rel).sum())
        worst = max(worst, abs(implied / eq[week] - 1))
    return worst


def strategy_series(result, prices: pd.DataFrame) -> pd.DataFrame:
    from momentum_backtesting.engine import CASH, IDLE

    return weekly_marks(result.equity, result.weights, prices, CASH, IDLE)


# ---------------------------------------------------------------------------------------------
# T0
# ---------------------------------------------------------------------------------------------


def t0_buckets(b: pd.DataFrame) -> dict[str, pd.Series]:
    b10, db = b["B10"], b["dB"]
    known = b10.notna()
    return {
        "all weeks": known,
        "euphoria B10>=70": b10 >= 70,
        "euphoria B10>=80": b10 >= 80,
        "middle 30<B10<70": (b10 > 30) & (b10 < 70),
        "washout B10<=30": b10 <= 30,
        "washout B10<=20": b10 <= 20,
        "euphoria>=70 & dB<0": (b10 >= 70) & (db < 0),
        "euphoria>=70 & dB>=0": (b10 >= 70) & (db >= 0),
        "euphoria>=80 & dB<0": (b10 >= 80) & (db < 0),
        "euphoria>=80 & dB>=0": (b10 >= 80) & (db >= 0),
        "washout<=30 & dB>0": (b10 <= 30) & (db > 0),
        "washout<=30 & dB<=0": (b10 <= 30) & (db <= 0),
        "washout<=20 & dB>0": (b10 <= 20) & (db > 0),
        "washout<=20 & dB<=0": (b10 <= 20) & (db <= 0),
    }


def t0_table(series: pd.DataFrame, b: pd.DataFrame, label: str) -> pd.DataFrame:
    eq = series["equity"]
    nifty = b["nifty"].reindex(eq.index)
    fwd = pd.DataFrame(
        {
            "strat_1w": eq.shift(-1) / eq - 1,
            "nifty_1w": nifty.shift(-1) / nifty - 1,
            "strat_4w": eq.shift(-4) / eq - 1,
            "nifty_4w": nifty.shift(-4) / nifty - 1,
        }
    )
    fwd["excess_1w"] = fwd["strat_1w"] - fwd["nifty_1w"]
    fwd["excess_4w"] = fwd["strat_4w"] - fwd["nifty_4w"]
    regimes = b.reindex(eq.index)
    buckets = {k: v.reindex(eq.index).fillna(False) for k, v in t0_buckets(regimes).items()}

    rows = {name: {"weeks": int(m.sum()), "episodes": episodes(m)} for name, m in buckets.items()}
    for col in ("strat_1w", "nifty_1w", "excess_1w", "strat_4w", "nifty_4w", "excess_4w"):
        valid = fwd[col].notna() & buckets["all weeks"]
        values = fwd[col].where(valid, 0.0).to_numpy()
        masks = {k: (m & valid).to_numpy() for k, m in buckets.items()}
        boot = block_bootstrap_means(values, masks)
        overall = fwd[col][valid].mean()
        for name, m in masks.items():
            mean = fwd[col][m].mean() if m.any() else float("nan")
            lo, hi = np.nanpercentile(boot[name], [2.5, 97.5]) if m.any() else (np.nan, np.nan)
            rows[name][col] = mean
            if col.startswith(("strat", "excess")):
                rows[name][f"{col}_lo"] = lo
                rows[name][f"{col}_hi"] = hi
                rows[name][f"{col}_excludes_all"] = bool(m.any() and (lo > overall or hi < overall))
    table = pd.DataFrame.from_dict(rows, orient="index")
    table.insert(0, "strategy", label)
    return table


def print_t0(table: pd.DataFrame) -> None:
    def pct(x):
        return "" if pd.isna(x) else f"{100 * x:+.2f}"

    def ci(row, col):
        star = "*" if row[f"{col}_excludes_all"] else " "
        return f"{pct(row[col]):>6} [{pct(row[col + '_lo']):>6},{pct(row[col + '_hi']):>6}]{star}"

    for strategy, sub in table.groupby("strategy", sort=False):
        print(f"\n=== T0: {strategy} (weekly returns in %, 95% block-bootstrap CI) ===")
        print(
            f"{'bucket':24} {'wks':>4} {'eps':>4}  {'strat next 1w':>24}  {'nifty':>6}  "
            f"{'excess 1w':>24}  {'strat next 4w':>24}  {'excess 4w':>24}"
        )
        for name, row in sub.iterrows():
            print(
                f"{name:24} {row['weeks']:>4} {row['episodes']:>4}  {ci(row, 'strat_1w')}  "
                f"{pct(row['nifty_1w']):>6}  {ci(row, 'excess_1w')}  {ci(row, 'strat_4w')}  "
                f"{ci(row, 'excess_4w')}"
            )
    print("\n* = the bucket's 95% interval excludes the all-weeks mean")


# ---------------------------------------------------------------------------------------------
# T1 / T2
# ---------------------------------------------------------------------------------------------


def scenario_targets(b: pd.DataFrame, series: pd.DataFrame) -> dict[str, pd.Series]:
    """Raw (pre-hysteresis) exposure targets w[t] for all 21 T1 runs."""
    idx = series.index
    b10 = b["B10"].reindex(idx)
    db = b["dB"].reindex(idx)
    trend = b["T"].reindex(idx).fillna(False).astype(bool)
    one = pd.Series(1.0, index=idx)
    out = {"S0": one}
    for hi in (70, 80):
        for x in (0.8, 0.6):
            out[f"S1 hi={hi} x={x}"] = one.where(~(b10 < hi), x)  # NaN breadth stays at 1
    for hi in (70, 80):
        for d in (5, 10):
            for x in (0.8, 0.6):
                out[f"S2 hi={hi} d={d} x={x}"] = one.where(~((b10 >= hi) & (db < -d)), x)
    for lo in (20, 30):
        for x in (0.5, 0.8):
            out[f"S3a lo={lo} x={x}"] = one.where(~(b10 <= lo), x)
    s4 = one.where(trend, 0.5)
    for lo in (20, 30):
        out[f"S3b lo={lo}"] = s4.where(~((b10 <= lo) & (db > 0)), 1.0)
    out["S4 trend"] = s4
    ret = series["equity"].pct_change()
    vol = ret.rolling(26, min_periods=26).std()
    typical = vol.expanding(min_periods=26).median()
    out["S5 vol target"] = (typical / vol).clip(upper=1.0).fillna(1.0)
    return out


def windows(index: pd.DatetimeIndex) -> list[tuple[str, pd.Timestamp, pd.Timestamp]]:
    last = index[-1]
    out = [
        ("full", index[0], last),
        ("last 5y", last - pd.DateOffset(years=5), last),
        ("last 3y", last - pd.DateOffset(years=3), last),
    ]
    start = index[0]
    while start + pd.DateOffset(years=3) <= last:
        out.append((f"roll {start:%Y-%m}", start, start + pd.DateOffset(years=3)))
        start = start + pd.DateOffset(months=3)
    return out


def episode_dd(equity: pd.Series, start: str, end: str) -> float:
    seg = equity.loc[start:end]
    return float((seg / seg.cummax() - 1).min())


def evaluate(
    name: str,
    ret: pd.Series,
    cash_ret: pd.Series,
    exposure: pd.Series,
    cost: pd.Series | None,
    switches: int,
    base_windows: dict[str, dict] | None,
    nifty_trough: pd.Timestamp,
) -> tuple[dict, dict[str, dict]]:
    per_window = {}
    for label, lo, hi in windows(ret.index):
        seg = ret.loc[lo:hi]
        per_window[label] = metrics_from_returns(seg, cash_ret)
    full = per_window["full"]
    equity = equity_from(ret)
    years = (equity.index[-1] - equity.index[0]).days / 365.25
    row = {
        "run": name,
        **{f"full {k}": v for k, v in full.items()},
        **{f"5y {k}": v for k, v in per_window["last 5y"].items()},
        **{f"3y {k}": v for k, v in per_window["last 3y"].items()},
        "avg exposure": float(exposure.mean()),
        "switches/yr": switches / years,
        "exposure turnover/yr": float(exposure.diff().abs().sum() / years),
        "switching cost total": float(cost.sum()) if cost is not None else float("nan"),
    }
    rolling = [k for k in per_window if k.startswith("roll ")]
    if base_windows is not None:
        sharpe_ok = [per_window[k]["Sharpe"] >= base_windows[k]["Sharpe"] - 1e-12 for k in rolling]
        dd_ok = [per_window[k]["max_dd"] > base_windows[k]["max_dd"] + 1e-12 for k in rolling]
        row["roll3y share Sharpe>=S0"] = float(np.mean(sharpe_ok))
        row["roll3y share DD shallower than S0"] = float(np.mean(dd_ok))
    row["rolling windows"] = len(rolling)
    for label, start, end in EPISODES:
        row[f"DD {label}"] = episode_dd(equity, start, end)
    after = exposure.loc[nifty_trough:]
    back = after.index[after >= 0.99]  # 99%: an engine run's own idle cash is rarely exactly 0
    row["2020 weeks trough->100%"] = (
        int(after.index.get_loc(back[0])) if len(back) else float("nan")
    )
    return row, per_window


def count_switches(w: pd.Series) -> int:
    return int((w.diff().abs() > 1e-9).sum())


def run_t1_t2(series_by_strategy: dict[str, pd.DataFrame], b: pd.DataFrame, t0: pd.DataFrame):
    from momentum_backtesting.engine import IDLE

    rows = []
    park_evidence = []
    nifty = b["nifty"].dropna()
    nifty_trough = nifty.loc["2020-01-01":"2020-12-31"].idxmin()
    for key, label in STRATEGIES.items():
        series = series_by_strategy[key]
        strat_ret = series["equity"].pct_change().iloc[1:]
        cash_ret = series["cash"].pct_change().iloc[1:]
        targets = scenario_targets(b, series)
        cost_pct = 0.10
        base_windows = None
        exposures = {}
        for name, target in targets.items():
            w = apply_hold(target)
            ov = overlay_returns(
                series["equity"].pct_change(), series["cash"].pct_change(), w, cost_pct
            )
            exposures[name] = w
            # Exposure as decided each week (w[t]), so the 2020 lag counts from the trough week.
            row, per_window = evaluate(
                name,
                ov["ret"],
                cash_ret,
                w.loc[ov.index[0] :],
                ov["cost"],
                count_switches(w),
                base_windows,
                nifty_trough,
            )
            if name == "S0":
                base_windows = per_window
                row, _ = evaluate(
                    name,
                    ov["ret"],
                    cash_ret,
                    w.loc[ov.index[0] :],
                    ov["cost"],
                    0,
                    base_windows,
                    nifty_trough,
                )
            row["strategy"] = label
            row["test"] = "T1"
            rows.append(row)
        # Sanity: S0 must reproduce the strategy itself.
        s0 = equity_from(strat_ret)
        assert abs(s0.iloc[-1] - series["equity"].iloc[-1] / series["equity"].iloc[0]) < 1e-9

        # Correlation of each overlay's exposure with the two comparators (decision rule 5).
        for row in rows:
            if row["strategy"] != label:
                continue
            w = exposures[row["run"]]
            for comp in ("S4 trend", "S5 vol target"):
                c = exposures[comp]
                row[f"exposure corr {comp.split()[0]}"] = (
                    float(w.corr(c)) if w.std() > 0 and c.std() > 0 else float("nan")
                )

        # T2: the owner's literal rule through the engine hook.
        if key == "etf":
            config, run, valuation = run_etf_base()
        else:
            base, run, valuation = run_broad_base()
            config = base.config
        flagged = frozenset(b.index[~b["T"].fillna(False).astype(bool)])
        for f in (0.1, 0.3):
            cfg = replace(config, mass_exit_throttle=True, mass_exit_throttle_fraction=f)
            result = run(cfg, mass_exit_weeks=flagged)
            marked = strategy_series(result, valuation)
            ret = marked["equity"].pct_change().iloc[1:]
            c_ret = marked["cash"].pct_change().iloc[1:]
            idle_cols = [c for c in result.weights.columns if c == IDLE]
            idle = result.weights[idle_cols].sum(axis=1) if idle_cols else 0 * ret
            exposure = (1 - idle).reindex(series.index).ffill()
            trades = result.trades
            park = trades[
                (trades["action"] == "PARK")
                & trades["reason"].str.contains("fresh capital deployed", na=False)
            ]
            unpark = trades[trades["action"] == "UNPARK"]
            row, _ = evaluate(
                f"T2 throttle f={f}",
                ret,
                c_ret,
                exposure.loc[ret.index[0] :],
                None,
                len(park),
                base_windows,
                nifty_trough,
            )
            row["strategy"] = label
            row["test"] = "T2"
            row["flagged weeks"] = len(flagged & set(result.equity.index))
            row["mass-exit PARK rows"] = len(park)
            row["UNPARK rows"] = len(unpark)
            row["max idle share"] = float(idle.max()) if len(idle_cols) else 0.0
            row["mean idle share in flagged weeks"] = (
                float(idle[idle.index.isin(flagged)].mean()) if len(idle_cols) else 0.0
            )
            rows.append(row)
            ev = trades[trades["action"].isin(["PARK", "UNPARK"])].copy()
            ev["strategy"] = label
            ev["run"] = f"f={f}"
            ev["T_flagged"] = ev["week"].isin(flagged)
            park_evidence.append(
                ev[["strategy", "run", "week", "action", "reason", "value", "T_flagged"]]
            )

    table = pd.DataFrame(rows)
    table = add_decision_rule(table, t0)
    return table, pd.concat(park_evidence, ignore_index=True)


def family_bucket(run: str) -> tuple[str | None, str]:
    """The T0 bucket a scenario's rule 1 is judged on."""
    parts = dict(p.split("=") for p in run.split()[1:] if "=" in p)
    if run.startswith("S1 "):
        return f"euphoria B10>={parts['hi']}", "strat"
    if run.startswith("S2 "):
        return f"euphoria>={parts['hi']} & dB<0", "strat"
    if run.startswith("S3a "):
        return f"washout B10<={parts['lo']}", "strat"
    if run.startswith("S3b "):
        return f"washout<={parts['lo']} & dB>0", "strat"
    return None, ""


def add_decision_rule(table: pd.DataFrame, t0: pd.DataFrame) -> pd.DataFrame:
    out = []
    for label, sub in table.groupby("strategy", sort=False):
        sub = sub.copy()
        s0 = sub[sub["run"] == "S0"].iloc[0]
        s4 = sub[sub["run"] == "S4 trend"].iloc[0]
        s5 = sub[sub["run"] == "S5 vol target"].iloc[0]
        t0s = t0[t0["strategy"] == label]
        dd_cols = [f"DD {e[0]}" for e in EPISODES]
        r1, r2, r3, r4, r5, ok = [], [], [], [], [], []
        for _, row in sub.iterrows():
            bucket, _ = family_bucket(row["run"])
            if bucket is None:
                rule1 = None
            else:
                t = t0s.loc[bucket]
                rule1 = bool(
                    (t["strat_1w_excludes_all"] or t["strat_4w_excludes_all"])
                    and t["episodes"] >= 3
                )
            rule2 = row.get("roll3y share Sharpe>=S0", np.nan) >= 2 / 3
            rule3 = sum(row[c] > s0[c] + 1e-12 for c in dd_cols) >= 2
            rule4 = row["full CAGR"] >= s0["full CAGR"] - 0.02
            beats = row["full Sharpe"] >= max(s4["full Sharpe"], s5["full Sharpe"]) - 1e-12
            different = all(
                abs(row.get(f"exposure corr {c}", 1.0)) < 0.5
                for c in ("S4", "S5")
                if not pd.isna(row.get(f"exposure corr {c}", np.nan))
            )
            rule5 = bool(beats or different)
            r1.append(rule1)
            r2.append(bool(rule2))
            r3.append(bool(rule3))
            r4.append(bool(rule4))
            r5.append(rule5)
            is_candidate = row["run"].startswith(("S1", "S2", "S3"))
            ok.append(bool(is_candidate and rule1 and rule2 and rule3 and rule4 and rule5))
        sub["rule1 T0 regime matters"] = r1
        sub["rule2 Sharpe>=S0 in 2/3 windows"] = r2
        sub["rule3 shallower DD in 2 of 3 episodes"] = r3
        sub["rule4 CAGR cost <=2pts"] = r4
        sub["rule5 beats or differs from S4,S5"] = r5
        sub["passes all"] = ok
        out.append(sub)
    return pd.concat(out)


# ---------------------------------------------------------------------------------------------
# Entry points
# ---------------------------------------------------------------------------------------------


def stage_t0() -> None:
    folder = out_dir()
    outer = load_outer_prices()
    print("computing breadth ...", flush=True)
    b, cross = compute_breadth_frame(outer)
    b.to_csv(folder / "breadth_weekly.csv", index_label="week")
    cross.to_csv(folder / "breadth_crosscheck_nifty50.csv", index_label="week")

    print("running ETF base backtest ...", flush=True)
    config, run, etf_px = run_etf_base()
    etf_result = run(config)
    etf = strategy_series(etf_result, etf_px)
    print("running Broad Momentum base backtest ...", flush=True)
    broad_base, _, broad_px = run_broad_base()
    broad_s = strategy_series(broad_base, broad_px)
    for name, res, px, s in (
        ("ETF", etf_result, etf_px, etf),
        ("Broad", broad_base, broad_px, broad_s),
    ):
        print(
            f"{name}: {len(res.equity)} engine weeks, {int((~s['engine_week']).sum())} skipped "
            f"weeks marked to market; worst kept-week mark error {mark_check(res, px):.3%}"
        )
    etf.to_csv(folder / "strategy_etf.csv", index_label="week")
    broad_s.to_csv(folder / "strategy_broad.csv", index_label="week")

    t0 = pd.concat([t0_table(etf, b, STRATEGIES["etf"]), t0_table(broad_s, b, STRATEGIES["broad"])])
    t0.to_csv(folder / "t0_table.csv", index_label="bucket")

    span = b.loc[etf.index[0] :]
    print(
        f"\nbreadth weeks with B10: {span['B10'].notna().sum()} of {len(span)} "
        f"(from {span['B10'].first_valid_index():%Y-%m-%d}); "
        f"eligible10 min/median {span['eligible10'].min()}/{span['eligible10'].median():.0f}; "
        f"eligible40 min/median {span['eligible40'].min()}/{span['eligible40'].median():.0f}"
    )
    print(
        f"strategy weeks without breadth: ETF "
        f"{b['B10'].reindex(etf.index).isna().sum()}, Broad "
        f"{b['B10'].reindex(broad_s.index).isna().sum()}"
    )
    c = cross.loc[etf.index[0] :].dropna(subset=["TM_B10", "N50_B10_pit"])
    print("\n=== B10 cross-check (from strategy start) ===")
    for col in ("N50_B10_pit", "N50_B10_today_members"):
        diff = c["TM_B10"] - c[col]
        print(
            f"TM vs {col}: corr {c['TM_B10'].corr(c[col]):.3f}, mean diff {diff.mean():+.1f}, "
            f"mean |diff| {diff.abs().mean():.1f}, regime agreement (70/30) "
            f"{(regime(c['TM_B10']) == regime(c[col])).mean():.0%}"
        )
    d = c["N50_B10_today_members"] - c["N50_B10_pit"]
    print(f"N50 today-members minus PIT: mean {d.mean():+.1f}, mean |diff| {d.abs().mean():.1f}")
    print_t0(t0)
    print(f"\nwritten to {folder}")


def regime(s: pd.Series) -> pd.Series:
    return pd.Series(np.where(s >= 70, "E", np.where(s <= 30, "W", "M")), index=s.index)


def stage_t1() -> None:
    folder = out_dir()
    b = pd.read_csv(folder / "breadth_weekly.csv", index_col=0, parse_dates=True)
    b["T"] = b["T"].astype("boolean").fillna(False).astype(bool)
    t0 = pd.read_csv(folder / "t0_table.csv", index_col=0)
    series = {
        k: pd.read_csv(folder / f"strategy_{k}.csv", index_col=0, parse_dates=True)
        for k in STRATEGIES
    }
    table, evidence = run_t1_t2(series, b, t0)
    table.to_csv(folder / "t1_t2_runs.csv", index=False)
    evidence.to_csv(folder / "t2_park_unpark.csv", index=False)
    show = [
        "run",
        "full CAGR",
        "full Sharpe",
        "full max_dd",
        "full Calmar",
        "avg exposure",
        "switches/yr",
        "switching cost total",
        "roll3y share Sharpe>=S0",
        "roll3y share DD shallower than S0",
        "passes all",
    ]
    with pd.option_context(
        "display.width", 250, "display.max_columns", 30, "display.float_format", "{:.3f}".format
    ):
        for label, sub in table.groupby("strategy", sort=False):
            print(f"\n=== T1/T2: {label} ===")
            print(sub[show].to_string(index=False))
    print(f"\nwritten to {folder}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("stage", choices=["t0", "t1", "all"])
    args = parser.parse_args()
    if args.stage in ("t0", "all"):
        stage_t0()
    if args.stage in ("t1", "all"):
        stage_t1()


if __name__ == "__main__":
    main()
