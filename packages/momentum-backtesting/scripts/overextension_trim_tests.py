"""Over-extension trim rule: event study before any engine work (TODO.md 3.9.26).

The spec is docs/momentum-overextension-trim-tests.md. The question: when a held position has
run up fast over the last 2 weeks, is selling half of it and putting the money elsewhere better
than holding it? Every backtest here is an unchanged `engine.run_backtest`; the trim is only
measured, never simulated. Shared helpers come from scripts/breadth_regime_tests.py.

Run from packages/momentum-backtesting:

    uv run python scripts/overextension_trim_tests.py sanity   # 20 largest 2-week jumps + CAs
    uv run python scripts/overextension_trim_tests.py c1       # M1 and M3 on C1 only
    uv run python scripts/overextension_trim_tests.py broad    # M1-M5 on C3-C5 (+ C6 control)
    uv run python scripts/overextension_trim_tests.py all      # M1-M5 on all six strategies

Output goes to data/backtests/trim/ (gitignored).

Conventions (no lookahead):
- Weeks are the valuation price table's own weekly calendar. Positions are the engine's
  post-trade weights, carried unchanged across weeks the engine skipped (`weekly_marks`).
- An event at Friday close t needs the position held after trades at t-2, t-1 AND t (if the
  engine sells it at t anyway, there is nothing left to trim).
- r_w = P[t] / P[t-w] - 1 on the price the engine values the position at. The volatility scale
  uses 26 weekly returns ending at t-w, so the move itself does not inflate its own yardstick.
- One event per position (holding spell) per 4 weeks.
"""

from __future__ import annotations

import argparse
import math
import sys
from dataclasses import dataclass, field
from pathlib import Path
from unittest import mock

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent))
import breadth_regime_tests as brt  # noqa: E402

HORIZONS = (1, 2, 4, 8, 13)
ALTS = {"A": "liquid fund", "B": "other holdings", "C": "best unheld"}
COOLDOWN_WEEKS = 4
MIN_CI_WEEKS = 5  # fewer distinct event weeks than this: no interval reported
TRIM_SHARE = 0.5
TAX_RATE = 0.208  # 20% STCG + 4% cess
FIRST_HALF_END = "2021-12-31"
START = "2017-01-01"
STOCK_X = (0.20, 0.30, 0.40)
ETF_X = (0.08, 0.12)
Z = (3.0, 4.0)


# ---------------------------------------------------------------------------------------------
# Pure pieces (unit-tested in tests/test_overextension_trim.py)
# ---------------------------------------------------------------------------------------------


def run_return(prices: pd.DataFrame, window: int) -> pd.DataFrame:
    return prices / prices.shift(window) - 1


def vol_score(prices: pd.DataFrame, window: int) -> pd.DataFrame:
    """r_w divided by (26-week weekly vol, measured up to t-w) x sqrt(w)."""
    weekly = prices / prices.shift(1) - 1
    vol = weekly.rolling(26, min_periods=26).std().shift(window)
    return run_return(prices, window) / (vol * math.sqrt(window))


def held_matrix(weights: pd.DataFrame, calendar: pd.DatetimeIndex, idle_col: str) -> pd.DataFrame:
    """Post-trade holdings (True = held after that week's trades) on the full calendar. Weeks the
    engine skipped carry the last engine week's holdings: nothing trades in a skipped week."""
    w = weights.drop(columns=[idle_col], errors="ignore")
    held = (w.abs() > 1e-9).reindex(calendar).ffill()
    return held.fillna(False).astype(bool)


def spell_ids(held: pd.DataFrame) -> pd.DataFrame:
    """Integer id of each continuous holding spell per column (0 = not held)."""
    starts = held & ~held.shift(1, fill_value=False)
    ids = starts.cumsum()
    return ids.where(held, 0).astype(int)


def eligible_matrix(held: pd.DataFrame, window: int) -> pd.DataFrame:
    """Held after trades at t-window .. t (inclusive), within one spell."""
    out = held.copy()
    for lag in range(1, window + 1):
        out &= held.shift(lag, fill_value=False)
    return out


def detect_events(
    signal: pd.DataFrame, spells: pd.DataFrame, cooldown: int = COOLDOWN_WEEKS
) -> list[tuple[pd.Timestamp, str]]:
    """(week, column) events from a boolean signal, keeping at most one per holding spell per
    `cooldown` weeks: a later trigger in the same spell needs at least `cooldown` weeks since
    the last kept event. A new spell (sold and bought back) starts fresh."""
    events = []
    weeks = signal.index
    for col in signal.columns:
        hits = np.flatnonzero(signal[col].to_numpy(dtype=bool))
        last_pos, last_spell = None, None
        for pos in hits:
            spell = spells[col].iat[pos]
            if last_spell == spell and last_pos is not None and pos - last_pos < cooldown:
                continue
            events.append((weeks[pos], col))
            last_pos, last_spell = pos, spell
    return sorted(events)


def only_rows(frame: pd.DataFrame, rows: pd.Series) -> pd.DataFrame:
    """Boolean frame with every row where `rows` is False set to False."""
    keep = rows.reindex(frame.index).fillna(False).to_numpy(dtype=bool)
    return frame & pd.DataFrame(
        np.repeat(keep[:, None], frame.shape[1], axis=1), index=frame.index, columns=frame.columns
    )


def forward_return(prices: pd.DataFrame, horizon: int) -> pd.DataFrame:
    px = prices.ffill()
    return px.shift(-horizon) / px - 1


def other_holdings_return(fwd: pd.DataFrame, held: pd.DataFrame) -> pd.DataFrame:
    """For every (t, a): equal-weighted forward return of everything else held after trades at
    t, excluding a itself. NaN where nothing else is held."""
    h = held.reindex(columns=fwd.columns).fillna(False).astype(bool)
    valid = h & fwd.notna()
    total = fwd.where(valid, 0.0).sum(axis=1)
    count = valid.sum(axis=1)
    own = fwd.where(valid, 0.0)
    others = count.to_numpy()[:, None] - valid.to_numpy()
    with np.errstate(invalid="ignore", divide="ignore"):
        out = (total.to_numpy()[:, None] - own.to_numpy()) / others
    out[others <= 0] = np.nan
    return pd.DataFrame(out, index=fwd.index, columns=fwd.columns)


def best_unheld(ranks: pd.DataFrame, held: pd.DataFrame, allowed: pd.DataFrame | None) -> pd.Series:
    """Column with the best (lowest) rank at t that is not held after trades at t."""
    r = ranks.where(~held.reindex_like(ranks).fillna(False).astype(bool))
    if allowed is not None:
        r = r.where(allowed.reindex_like(r).fillna(False).astype(bool))
    r = r.dropna(how="all")
    return r.idxmin(axis=1).reindex(ranks.index)


def excess(alt: float | np.ndarray, stock: float | np.ndarray):
    """Positive = trimming into the alternative beat holding the stock."""
    return alt - stock


def fisher_greater(a: int, b: int, c: int, d: int) -> float:
    """One-sided Fisher exact p-value that row 1 (a, b) has a higher first-column rate than
    row 2 (c, d)."""
    n1, n2, k = a + b, c + d, a + c
    total = n1 + n2

    def log_comb(n, r):
        return math.lgamma(n + 1) - math.lgamma(r + 1) - math.lgamma(n - r + 1)

    denom = log_comb(total, k)
    p = 0.0
    for x in range(a, min(n1, k) + 1):
        p += math.exp(log_comb(n1, x) + log_comb(n2, k - x) - denom)
    return min(1.0, p)


# ---------------------------------------------------------------------------------------------
# Strategies
# ---------------------------------------------------------------------------------------------


@dataclass
class Strategy:
    key: str
    label: str
    kind: str  # "stock" | "broad" | "etf"
    result: object
    prices: pd.DataFrame  # valuation prices, week x column
    marked: pd.DataFrame  # weekly_marks output on the full calendar
    positions: list[str]  # columns that can carry an event
    ranks: pd.DataFrame  # for alternative C, lower = better
    allowed: pd.DataFrame | None  # buyable mask for alternative C
    cash_col: str
    idle_col: str
    cost_pct: float
    ca_events: pd.DataFrame = field(default_factory=pd.DataFrame)  # column, date, kind, detail


def _stock_dataset():
    """The Stock dataset through `ui_data.load_stock_dataset`, the loader api.py's
    `_Data.get_stock()` uses. Its shared-database branch is switched off here because the
    catalog has no Nifty benchmark TRI rows (it raises KeyError); its stock prices and
    membership were checked identical to the files on 2026-10-01."""
    from momentum_backtesting import db_read
    from momentum_backtesting.config import DATA_DIR
    from momentum_backtesting.stocks.ui_data import load_stock_dataset

    with mock.patch.object(db_read, "stock_dataset_from_db_or_none", return_value=None):
        return load_stock_dataset(DATA_DIR / "stocks")


def _stock_ca_events(company_ids: list[str]) -> pd.DataFrame:
    from momentum_backtesting.config import DATA_DIR

    ev = pd.read_parquet(DATA_DIR / "stocks" / "events.parquet")
    ev = ev[(ev["kind"] != "dividend") & ev["company_id"].isin(company_ids)]
    return pd.DataFrame(
        {
            "column": ev["company_id"],
            "date": pd.to_datetime(ev["ex_date"]),
            "kind": ev["kind"],
            "detail": ev["symbol_at_ex"] + " factor " + ev["factor"].round(3).astype(str),
        }
    )


def build_stock(key: str, entry: str) -> Strategy:
    from momentum_backtesting.engine import CASH, IDLE, Config, run_backtest
    from momentum_backtesting.stocks.ui_data import NIFTY50_TRI

    stock = _stock_dataset()
    last = stock.membership.index[-1]
    includes = {
        cid: "core" if bool(stock.membership.at[last, cid]) else "optional"
        for cid in stock.companies
        if cid in stock.membership.columns
    }
    includes.update({name: extra["tag"] for name, extra in stock.extra_instruments.items()})
    # api.py's shipped Stock defaults, except top 5 / exit 10 (the spec) and a 2017 start (the
    # hold-out halves).
    config = Config(
        top_n=5,
        exit_rank=10,
        start=START,
        cost_model="itemised",
        capital=1_000_000.0,
        slippage_bps=5.0,
        benchmark=NIFTY50_TRI,
        defensive="ranked",
        filter_lookback=13,
        portfolio="buffer",
        entry=entry,
        max_position=0.35,
        cap_band=0.05,
        universe=tuple(includes),
    )
    result = run_backtest(
        stock.prices, includes, config, stock.tax_classes, None, None, membership=stock.membership
    )
    companies = [c for c in stock.companies if c in stock.prices.columns]
    marked = brt.weekly_marks(result.equity, result.weights, stock.prices, CASH, IDLE)
    label = f"{key}: Nifty 50 stocks, top 5/exit 10, entry={entry}"
    return Strategy(
        key=key,
        label=label,
        kind="stock",
        result=result,
        prices=stock.prices,
        marked=marked,
        positions=companies,
        ranks=result.ranks.reindex(columns=companies),
        allowed=stock.membership.reindex(columns=companies),
        cash_col=CASH,
        idle_col=IDLE,
        cost_pct=config.cost_pct,
        ca_events=_stock_ca_events(companies),
    )


def build_broad(key: str, label: str, ranking=None, **overrides) -> tuple[Strategy, object]:
    from momentum_backtesting.categories import broad
    from momentum_backtesting.engine import CASH, IDLE

    if ranking is not None:
        overrides["ranking"] = ranking
    outcome, _run, prices, over = brt.run_broad_outcome(**overrides)
    result = outcome.result
    stocks = [c for c in outcome.ranking.prices.columns if c not in broad.ATOMIC_NAMES]
    marked = brt.weekly_marks(result.equity, result.weights, prices, CASH, IDLE)
    allowed = None if over is None else ~over.reindex(columns=stocks).fillna(False).astype(bool)
    return Strategy(
        key=key,
        label=label,
        kind="broad",
        result=result,
        prices=prices,
        marked=marked,
        positions=stocks,
        ranks=outcome.ranking.stock_pool_ranks.reindex(columns=stocks),
        allowed=allowed,
        cash_col=CASH,
        idle_col=IDLE,
        cost_pct=result.config.cost_pct,
    ), outcome.ranking


def broad_ca_events(columns: list[str]) -> pd.DataFrame:
    """Mechanical drops the Total Market frame detected (split points between `SYM` and
    `SYM#2` columns), plus the Nifty 50 feed's events for names that were ever Nifty 50."""
    from momentum_backtesting.categories import broad
    from momentum_backtesting.config import DATA_DIR

    uni = broad.load_stock_universe_frame(
        stocks_data_dir=DATA_DIR / "stocks", categories_data_dir=DATA_DIR / "categories"
    )
    base = {c: c.split("#", 1)[0] for c in columns}
    detected = uni.events
    rows = []
    for col, sym in base.items():
        for r in detected[detected["symbol"] == sym].itertuples(index=False):
            rows.append(
                (
                    col,
                    pd.Timestamp(r.event_date),
                    "detected drop",
                    f"{r.drop_pct:.0f}% drop, turnover x{r.turnover_ratio:.1f}",
                )
            )
    feed = pd.read_parquet(DATA_DIR / "stocks" / "events.parquet")
    feed = feed[feed["kind"] != "dividend"]
    for col, sym in base.items():
        for r in feed[feed["symbol_at_ex"] == sym].itertuples(index=False):
            rows.append((col, pd.Timestamp(r.ex_date), f"N50 feed {r.kind}", f"factor {r.factor}"))
    return pd.DataFrame(rows, columns=["column", "date", "kind", "detail"])


def build_etf() -> Strategy:
    from momentum_backtesting.engine import CASH, IDLE, ranked_universe

    config, run, valuation = brt.run_etf_base()
    result = run(config)
    from momentum_backtesting.fetch import load_universe

    includes = {i.name: i.include for i in load_universe()}
    names = [n for n in ranked_universe(includes, config) if n != CASH]
    marked = brt.weekly_marks(result.equity, result.weights, valuation, CASH, IDLE)
    return Strategy(
        key="C6",
        label="C6: ETF, live_config.toml",
        kind="etf",
        result=result,
        prices=valuation,
        marked=marked,
        positions=names,
        ranks=result.ranks.reindex(columns=names),
        allowed=None,
        cash_col=CASH,
        idle_col=IDLE,
        cost_pct=config.cost_pct,
    )


ALL_KEYS = ("C1", "C2", "C3", "C4", "C5", "C6")
BROAD_KEYS = ("C3", "C4", "C5")


def build_all(keys: tuple[str, ...] = ALL_KEYS) -> list[Strategy]:
    out = []
    if "C1" in keys:
        print("building C1 ...", flush=True)
        out.append(build_stock("C1", "wait"))
    if "C2" in keys:
        print("building C2 ...", flush=True)
        out.append(build_stock("C2", "make_room"))
    if any(k in keys for k in BROAD_KEYS):
        print("building C3-C5 (Broad) ...", flush=True)
        c3, ranking = build_broad("C3", "C3: Broad Momentum, shipped defaults")
        c4, _ = build_broad(
            "C4",
            "C4: Broad, category mode off, top 10/exit 20",
            ranking=ranking,
            category_mode="off",
            off_top_n=10,
            off_exit_rank=20,
        )
        c5, _ = build_broad(
            "C5",
            "C5: Broad, entry=make_room, coverage floor 0.25",
            ranking=ranking,
            entry="make_room",
            coverage_floor=0.25,
        )
        events = broad_ca_events(sorted(set(c3.positions)))
        for s in (c3, c4, c5):
            s.ca_events = events
        out += [s for s in (c3, c4, c5) if s.key in keys]
    if "C6" in keys:
        print("building C6 (ETF) ...", flush=True)
        out.append(build_etf())
    return out


# ---------------------------------------------------------------------------------------------
# Event table
# ---------------------------------------------------------------------------------------------


def triggers_for(kind: str, window: int) -> dict[str, tuple[str, float]]:
    xs = ETF_X if kind == "etf" else STOCK_X
    out = {f"{window}w r>={round(x * 100)}%": ("abs", x) for x in xs}
    out.update({f"{window}w z>={z:g}": ("z", z) for z in Z})
    return out


@dataclass
class Frames:
    """Everything per strategy that does not depend on the trigger."""

    calendar: pd.DatetimeIndex
    prices: pd.DataFrame
    held: pd.DataFrame  # post-trade, positions only
    held_all: pd.DataFrame  # post-trade, every non-idle column (alternative B)
    spells: pd.DataFrame
    w_pre: pd.DataFrame  # weight entering t (drifted from the last engine week), positions
    entry_week: pd.DataFrame  # spell's first week, per cell
    sale_week: pd.DataFrame  # first week after the spell (engine sold at that close)
    fwd: dict  # horizon -> forward return frame (all columns)
    cash_fwd: dict  # horizon -> Series
    best: pd.Series  # best unheld column per week
    engine_week: pd.Series
    trims: pd.DataFrame  # TRIM rows (week, asset)


def build_frames(s: Strategy) -> Frames:
    cal = s.marked.index
    prices = s.prices.reindex(cal)
    held_all = held_matrix(s.result.weights, cal, s.idle_col)
    held_all = held_all.reindex(columns=[c for c in held_all.columns if c in prices.columns])
    held = held_all.reindex(columns=s.positions).fillna(False).astype(bool)
    spells = spell_ids(held)

    # Weight entering t: last engine week's post-trade weight, drifted by price and equity.
    w_post = s.result.weights.reindex(columns=s.positions).fillna(0.0)
    anchor = pd.Series(cal.where(s.marked["engine_week"]), index=cal).ffill().shift(1)
    w_pre = pd.DataFrame(np.nan, index=cal, columns=s.positions)
    px = prices[s.positions].ffill()
    eq = s.marked["equity"]
    valid = anchor.notna()
    a_idx = pd.DatetimeIndex(anchor[valid])
    rel_px = px.loc[valid].to_numpy() / px.reindex(a_idx).to_numpy()
    rel_eq = eq[valid].to_numpy() / eq.reindex(a_idx).to_numpy()
    w_pre.loc[valid] = w_post.reindex(a_idx).to_numpy() * rel_px / rel_eq[:, None]

    # Spell entry and sale weeks per cell.
    entry = pd.DataFrame(pd.NaT, index=cal, columns=s.positions)
    sale = pd.DataFrame(pd.NaT, index=cal, columns=s.positions)
    for col in s.positions:
        sp = spells[col]
        for sid in np.unique(sp[sp > 0]):
            weeks = sp.index[sp == sid]
            after = cal[cal > weeks[-1]]
            entry.loc[weeks, col] = weeks[0]
            sale.loc[weeks, col] = after[0] if len(after) else pd.NaT

    fwd = {h: forward_return(prices, h) for h in HORIZONS}
    cash = prices[s.cash_col].ffill()
    cash_fwd = {h: cash.shift(-h) / cash - 1 for h in HORIZONS}
    best = best_unheld(s.ranks.reindex(cal), held.reindex(columns=s.ranks.columns), s.allowed)
    trades = s.result.trades
    trims = trades[trades["action"] == "TRIM"][["week", "asset"]] if not trades.empty else None
    return Frames(
        calendar=cal,
        prices=prices,
        held=held,
        held_all=held_all,
        spells=spells,
        w_pre=w_pre,
        entry_week=entry,
        sale_week=sale,
        fwd=fwd,
        cash_fwd=cash_fwd,
        best=best,
        engine_week=s.marked["engine_week"].astype(bool),
        trims=trims,
    )


def cell_excess(f: Frames, horizon: int) -> dict[str, pd.DataFrame]:
    """Excess (alternative minus stock) for every (t, position) cell, per alternative."""
    stock = f.fwd[horizon][f.held.columns]
    alt_a = pd.DataFrame(
        np.repeat(f.cash_fwd[horizon].to_numpy()[:, None], stock.shape[1], axis=1),
        index=stock.index,
        columns=stock.columns,
    )
    alt_b = other_holdings_return(f.fwd[horizon], f.held_all).reindex(columns=stock.columns)
    best_ret = pd.Series(
        [f.fwd[horizon].at[t, c] if isinstance(c, str) else np.nan for t, c in f.best.items()],
        index=f.best.index,
    )
    alt_c = pd.DataFrame(
        np.repeat(best_ret.to_numpy()[:, None], stock.shape[1], axis=1),
        index=stock.index,
        columns=stock.columns,
    )
    return {"A": excess(alt_a, stock), "B": excess(alt_b, stock), "C": excess(alt_c, stock)}


def until_sold_excess(f: Frames, s: Strategy, events: pd.DataFrame) -> pd.DataFrame:
    rows = []
    px = f.prices.ffill()
    cash = px[s.cash_col]
    for r in events.itertuples(index=False):
        end = f.sale_week.at[r.week, r.asset]
        if pd.isna(end):
            end = f.calendar[-1]
        stock = px.at[end, r.asset] / px.at[r.week, r.asset] - 1
        held_now = f.held_all.loc[r.week].to_numpy(dtype=bool)
        others = [c for c in f.held_all.columns[held_now] if c != r.asset]
        rel = (px.loc[end, others] / px.loc[r.week, others] - 1).mean() if others else np.nan
        best = f.best.get(r.week)
        c_ret = px.at[end, best] / px.at[r.week, best] - 1 if isinstance(best, str) else np.nan
        rows.append(
            {
                "exc_sold_A": cash[end] / cash[r.week] - 1 - stock,
                "exc_sold_B": rel - stock,
                "exc_sold_C": c_ret - stock,
                "weeks_to_sale": int((end - r.week).days / 7),
            }
        )
    return pd.DataFrame(rows, index=events.index)


def event_table(s: Strategy, f: Frames, window: int = 2) -> pd.DataFrame:
    r = run_return(f.prices[s.positions], window)
    z = vol_score(f.prices[s.positions], window)
    elig = eligible_matrix(f.held, window)
    excess_by_h = {h: cell_excess(f, h) for h in HORIZONS}
    px = f.prices[s.positions].ffill()
    max13 = pd.concat([px.shift(-k) for k in range(1, 14)]).groupby(level=0).max() / px - 1
    tables = []
    for name, (kind, threshold) in triggers_for(s.kind, window).items():
        signal = elig & ((r >= threshold) if kind == "abs" else (z >= threshold))
        events = detect_events(signal, f.spells)
        if not events:
            continue
        ev = pd.DataFrame(events, columns=["week", "asset"])
        ev["trigger"] = name
        ev["r"] = [r.at[w, a] for w, a in events]
        ev["z"] = [z.at[w, a] for w, a in events]
        ev["tradable"] = [bool(f.engine_week[w]) for w, _ in events]
        ev["w_pre"] = [f.w_pre.at[w, a] for w, a in events]
        ev["entry_week"] = [f.entry_week.at[w, a] for w, a in events]
        ev["days_held"] = [(w - f.entry_week.at[w, a]).days for w, a in events]
        ev["gain_since_entry"] = [
            px.at[w, a] / px.at[f.entry_week.at[w, a], a] - 1 for w, a in events
        ]
        ev["max_up_13w"] = [max13.at[w, a] for w, a in events]
        for h in HORIZONS:
            ev[f"stock_{h}w"] = [f.fwd[h].at[w, a] for w, a in events]
            for alt in ALTS:
                ev[f"exc_{h}w_{alt}"] = [excess_by_h[h][alt].at[w, a] for w, a in events]
        ev = ev.join(until_sold_excess(f, s, ev))
        if f.trims is not None and len(f.trims):
            tr = f.trims
            ev["cap_trim_within_2w"] = [
                bool(((tr["asset"] == a) & ((tr["week"] - w).abs() <= pd.Timedelta(weeks=2))).any())
                for w, a in events
            ]
        else:
            ev["cap_trim_within_2w"] = False
        tables.append(ev)
    if not tables:
        return pd.DataFrame()
    out = pd.concat(tables, ignore_index=True)
    out.insert(0, "strategy", s.key)
    out["window"] = window
    return out


def baseline_cells(s: Strategy, f: Frames, trigger: tuple[str, float], window: int = 2):
    """Excess frames for held cells (held t-w..t) with no trigger hit: the 'is a spike special'
    baseline."""
    kind, threshold = trigger
    r = run_return(f.prices[s.positions], window)
    z = vol_score(f.prices[s.positions], window)
    hit = (r >= threshold) if kind == "abs" else (z >= threshold)
    return only_rows(eligible_matrix(f.held, window) & ~hit, f.engine_week)


# ---------------------------------------------------------------------------------------------
# Statistics
# ---------------------------------------------------------------------------------------------


def weekly_mean_ci(
    weeks: pd.Series, values: pd.Series, calendar: pd.DatetimeIndex
) -> tuple[float, float, float, int]:
    """Average events within a week first, then a 4-week block bootstrap over the calendar.
    Returns (mean of week means, lo, hi, distinct weeks)."""
    v = pd.Series(values.to_numpy(), index=pd.DatetimeIndex(weeks)).dropna()
    if v.empty:
        return np.nan, np.nan, np.nan, 0
    per_week = v.groupby(level=0).mean().reindex(calendar)
    mask = per_week.notna().to_numpy()
    if mask.sum() < MIN_CI_WEEKS:  # a 1-4 point bootstrap is degenerate, not evidence
        return float(per_week.mean()), np.nan, np.nan, int(mask.sum())
    boot = brt.block_bootstrap_means(per_week.fillna(0.0).to_numpy(), {"m": mask})["m"]
    lo, hi = np.nanpercentile(boot, [2.5, 97.5])
    return float(per_week.mean()), float(lo), float(hi), int(mask.sum())


def cell_mean_ci(excess_frame: pd.DataFrame, mask: pd.DataFrame) -> tuple[float, float, float]:
    vals = excess_frame.where(mask)
    per_week = vals.mean(axis=1)  # NaN-skipping mean across that week's cells
    m = per_week.notna().to_numpy()
    if not m.any():
        return np.nan, np.nan, np.nan
    boot = brt.block_bootstrap_means(per_week.fillna(0.0).to_numpy(), {"m": m})["m"]
    lo, hi = np.nanpercentile(boot, [2.5, 97.5])
    return float(per_week.mean()), float(lo), float(hi)


def m1_table(s: Strategy, f: Frames, events: pd.DataFrame, with_baseline: bool = True):
    rows = []
    tradable = events[events["tradable"]]
    for trigger, ev in tradable.groupby("trigger", sort=False):
        kind, threshold = triggers_for(s.kind, int(ev["window"].iloc[0]))[trigger]
        base_mask = baseline_cells(s, f, (kind, threshold), int(ev["window"].iloc[0]))
        skipped = int(((events["trigger"] == trigger) & ~events["tradable"]).sum())
        for h in (*HORIZONS, "sold"):
            for alt in ALTS:
                col = f"exc_{h}w_{alt}" if h != "sold" else f"exc_sold_{alt}"
                mean, lo, hi, nweeks = weekly_mean_ci(ev["week"], ev[col], f.calendar)
                x = ev[col].dropna()
                row = {
                    "strategy": s.key,
                    "trigger": trigger,
                    "horizon": h,
                    "alt": alt,
                    "events": int(x.size),
                    "event_weeks": nweeks,
                    "stocks": int(ev.loc[x.index, "asset"].nunique()),
                    "skipped_week_events": skipped,
                    "mean": mean,
                    "median": float(x.median()) if x.size else np.nan,
                    "hit_rate": float((x > 0).mean()) if x.size else np.nan,
                    "lo": lo,
                    "hi": hi,
                }
                if with_baseline and h != "sold":
                    b_mean, b_lo, b_hi = cell_mean_ci(cell_excess_cached(f, h)[alt], base_mask)
                    row.update({"baseline_mean": b_mean, "baseline_lo": b_lo, "baseline_hi": b_hi})
                rows.append(row)
    return pd.DataFrame(rows)


_EXCESS_CACHE: dict = {}


def cell_excess_cached(f: Frames, h: int):
    key = (id(f), h)
    if key not in _EXCESS_CACHE:
        _EXCESS_CACHE[key] = cell_excess(f, h)
    return _EXCESS_CACHE[key]


def m2_table(events: pd.DataFrame) -> pd.DataFrame:
    rows = []
    for (strategy, trigger), ev in events[events["tradable"]].groupby(
        ["strategy", "trigger"], sort=False
    ):
        row = {
            "strategy": strategy,
            "trigger": trigger,
            "events": len(ev),
            "share_up_50pct_more_13w": float((ev["max_up_13w"] >= 0.5).mean()),
        }
        for h in (4, 8):
            x = ev[f"exc_{h}w_B"].dropna().sort_values()
            row[f"mean_{h}w_B"] = float(x.mean()) if len(x) else np.nan
            row[f"mean_{h}w_B_drop_best5"] = float(x.iloc[:-5].mean()) if len(x) > 5 else np.nan
            row[f"mean_{h}w_B_drop_worst5"] = float(x.iloc[5:].mean()) if len(x) > 5 else np.nan
        rows.append(row)
    return pd.DataFrame(rows)


def m3(s: Strategy, f: Frames, window: int = 2) -> tuple[pd.DataFrame, pd.DataFrame]:
    """Top-20 winning closed trades with their pre-peak run-ups, and the base-rate table."""
    trades = s.result.trades
    sells = trades[(trades["action"] == "SELL") & trades["asset"].isin(s.positions)].copy()
    sells = sells.sort_values("price_return", ascending=False).head(20)
    r = run_return(f.prices[s.positions], window)
    z = vol_score(f.prices[s.positions], window)
    trig = triggers_for(s.kind, window)
    px = f.prices[s.positions].ffill()
    lines = []
    for t in sells.itertuples(index=False):
        span = px.loc[t.entry_week : t.week, t.asset]
        peak = span.idxmax()
        before = r.loc[:peak, t.asset].loc[t.entry_week :].tail(6)
        marks = []
        for wk, val in before.items():
            hits = [
                n
                for n, (k, th) in trig.items()
                if (val >= th if k == "abs" else z.at[wk, t.asset] >= th)
            ]
            marks.append(f"{wk:%y-%m-%d} {val:+.0%}" + (f" [{', '.join(hits)}]" if hits else ""))
        lines.append(
            {
                "strategy": s.key,
                "asset": t.asset,
                "entry": t.entry_week.date(),
                "exit": t.week.date(),
                "return": t.price_return,
                "peak_week": peak.date(),
                "r2_before_peak": " | ".join(marks),
            }
        )
    top = pd.DataFrame(lines)

    # Base rates over closed spells only (an open spell's peak is not known yet).
    closed = f.sale_week.notna()
    elig = only_rows(eligible_matrix(f.held, window) & closed, f.engine_week)
    peak_week = pd.DataFrame(pd.NaT, index=f.calendar, columns=s.positions)
    for col in s.positions:
        sp = f.spells[col]
        for sid in np.unique(sp[sp > 0]):
            weeks = sp.index[sp == sid]
            peak_week.loc[weeks, col] = px.loc[weeks, col].idxmax()
    gap = peak_week - pd.DataFrame(
        np.repeat(f.calendar.to_numpy()[:, None], len(s.positions), axis=1),
        index=f.calendar,
        columns=s.positions,
    )
    near = (gap >= pd.Timedelta(0)) & (gap <= pd.Timedelta(weeks=4))
    rows = []
    for name, (kind, th) in trig.items():
        hit = ((r >= th) if kind == "abs" else (z >= th)).fillna(False)
        a = int((elig & hit & near).sum().sum())
        b = int((elig & hit & ~near).sum().sum())
        c = int((elig & ~hit & near).sum().sum())
        d = int((elig & ~hit & ~near).sum().sum())
        rows.append(
            {
                "strategy": s.key,
                "trigger": name,
                "a hit+peak": a,
                "b hit, no peak": b,
                "c no hit, peak": c,
                "d no hit, no peak": d,
                "P(peak|hit)": a / (a + b) if a + b else np.nan,
                "P(peak|no hit)": c / (c + d) if c + d else np.nan,
                "fisher_p": fisher_greater(a, b, c, d) if a + b else np.nan,
            }
        )
    return top, pd.DataFrame(rows)


def m4_table(strategies: dict[str, Strategy], events: pd.DataFrame) -> pd.DataFrame:
    rows = []
    for (key, trigger), ev in events[events["tradable"]].groupby(
        ["strategy", "trigger"], sort=False
    ):
        s = strategies[key]
        years = (s.marked.index[-1] - s.marked.index[0]).days / 365.25
        w = ev["w_pre"].fillna(0.0)
        cost = TRIM_SHARE * w * 2 * s.cost_pct / 100
        gain_frac = (1 - 1 / (1 + ev["gain_since_entry"])).clip(lower=0)
        tax = TAX_RATE * TRIM_SHARE * w * gain_frac
        row = {"strategy": key, "trigger": trigger, "events": len(ev)}
        for h in (4, 8):
            edge = TRIM_SHARE * w * ev[f"exc_{h}w_B"].fillna(0.0) - cost
            row[f"gross_{h}w_pts_per_yr"] = 100 * edge.sum() / years
            row[f"after_tax_{h}w_pts_per_yr"] = 100 * (edge - tax).sum() / years
        row["share_within_13w_of_LTCG"] = float(
            ((ev["days_held"] >= 365 - 91) & (ev["days_held"] < 365)).mean()
        )
        row["mean_weight"] = float(w.mean())
        row["cap_trim_within_2w"] = float(ev["cap_trim_within_2w"].mean())
        rows.append(row)
    return pd.DataFrame(rows)


def half_stats(events: pd.DataFrame, calendar_by: dict[str, pd.DatetimeIndex]) -> pd.DataFrame:
    rows = []
    ev_all = events[events["tradable"]]
    for (key, trigger), ev in ev_all.groupby(["strategy", "trigger"], sort=False):
        for half, sel in (
            ("2017-2021", ev["week"] <= FIRST_HALF_END),
            ("2022+", ev["week"] > FIRST_HALF_END),
        ):
            cal = calendar_by[key]
            cal = cal[cal <= FIRST_HALF_END] if half == "2017-2021" else cal[cal > FIRST_HALF_END]
            row = {"strategy": key, "trigger": trigger, "half": half}
            for h in (4, 8):
                mean, lo, hi, n = weekly_mean_ci(
                    ev.loc[sel, "week"], ev.loc[sel, f"exc_{h}w_B"], cal
                )
                row.update({f"mean_{h}w_B": mean, f"lo_{h}w": lo, f"hi_{h}w": hi, "event_weeks": n})
            rows.append(row)
    return pd.DataFrame(rows)


def m5_table(halves: pd.DataFrame) -> pd.DataFrame:
    rows = []
    for key, sub in halves.groupby("strategy", sort=False):
        ins = sub[(sub["half"] == "2017-2021") & sub["trigger"].str.startswith("2w")]
        ins = ins[ins["event_weeks"] >= 10]
        if ins.empty:
            rows.append({"strategy": key, "chosen": None})
            continue
        score = (ins["mean_4w_B"] + ins["mean_8w_B"]) / 2
        chosen = ins.loc[score.idxmax(), "trigger"]
        out = sub[(sub["half"] == "2022+") & (sub["trigger"] == chosen)].iloc[0]
        rows.append(
            {
                "strategy": key,
                "chosen": chosen,
                "in_sample_4w": float(ins.loc[score.idxmax(), "mean_4w_B"]),
                "in_sample_8w": float(ins.loc[score.idxmax(), "mean_8w_B"]),
                "oos_event_weeks": int(out["event_weeks"]),
                "oos_4w": out["mean_4w_B"],
                "oos_4w_ci": f"[{out['lo_4w']:+.2%}, {out['hi_4w']:+.2%}]",
                "oos_8w": out["mean_8w_B"],
                "oos_8w_ci": f"[{out['lo_8w']:+.2%}, {out['hi_8w']:+.2%}]",
            }
        )
    return pd.DataFrame(rows)


# ---------------------------------------------------------------------------------------------
# Stages
# ---------------------------------------------------------------------------------------------


def out_dir() -> Path:
    from momentum_backtesting.config import DATA_DIR

    path = DATA_DIR / "backtests" / "trim"
    path.mkdir(parents=True, exist_ok=True)
    return path


def describe(strategies: list[Strategy]) -> None:
    for s in strategies:
        m = s.marked
        stats = brt.metrics_from_returns(
            m["equity"].pct_change().iloc[1:], m["cash"].pct_change().iloc[1:]
        )
        print(
            f"{s.label}: {m.index[0]:%Y-%m-%d} to {m.index[-1]:%Y-%m-%d}, "
            f"CAGR {stats['CAGR']:.1%}, max DD {stats['max_dd']:.1%}, "
            f"{int((~m['engine_week']).sum())} skipped weeks marked"
        )


def stage_sanity() -> list[Strategy]:
    strategies = build_all()
    describe(strategies)
    rows = []
    for s in strategies:
        f = build_frames(s)
        r = run_return(f.prices[s.positions], 2).where(eligible_matrix(f.held, 2))
        stacked = r.stack().dropna()
        for (week, col), val in stacked.items():
            rows.append((s.key, week, col, val, s))
    df = pd.DataFrame(rows, columns=["strategy", "week", "asset", "r2", "s"])
    top = (
        df.sort_values("r2", ascending=False)
        .groupby(["week", "asset"], sort=False)
        .agg(r2=("r2", "first"), strategies=("strategy", ",".join), s=("s", "first"))
        .reset_index()
        .sort_values("r2", ascending=False)
        .head(20)
    )
    lines = []
    for t in top.itertuples(index=False):
        s = t.s
        px = s.prices[t.asset].reindex(s.marked.index).ffill()
        i = px.index.get_loc(t.week)
        path = " ".join(f"{px.iloc[j]:.1f}" for j in range(max(0, i - 3), min(len(px), i + 5)))
        ca = s.ca_events
        near = (
            ca[
                (ca["column"] == t.asset)
                & (ca["date"] >= t.week - pd.Timedelta(weeks=3))
                & (ca["date"] <= t.week + pd.Timedelta(weeks=1))
            ]
            if len(ca)
            else ca
        )
        note = "; ".join(f"{r.date:%Y-%m-%d} {r.kind} ({r.detail})" for r in near.itertuples())
        lines.append(
            {
                "week": f"{t.week:%Y-%m-%d}",
                "asset": t.asset,
                "r2": t.r2,
                "held_in": t.strategies,
                "price t-3..t+4": path,
                "corporate actions t-3w..t+1w": note or "none",
            }
        )
    out = pd.DataFrame(lines)
    out.to_csv(out_dir() / "sanity_top20_r2.csv", index=False)
    with pd.option_context("display.width", 250, "display.max_colwidth", 120):
        print("\n=== 20 largest 2-week run-ups in held positions ===")
        print(out.to_string(index=False, formatters={"r2": "{:+.0%}".format}))
    return strategies


def print_m1(m1: pd.DataFrame, horizons=(1, 2, 4, 8, 13, "sold")) -> None:
    for (key, trigger), sub in m1.groupby(["strategy", "trigger"], sort=False):
        first = sub.iloc[0]
        print(
            f"\n--- {key} {trigger}: {first['events']} events, {first['event_weeks']} event weeks, "
            f"{first['stocks']} names, {first['skipped_week_events']} events on skipped weeks ---"
        )
        print(
            f"{'H':>5} {'alt':>3} {'mean':>7} {'median':>7} {'hit':>5} {'95% CI':>18}  "
            f"{'baseline mean':>13} {'baseline CI':>18}"
        )
        for r in sub.itertuples(index=False):
            if r.horizon not in horizons:
                continue
            star = "*" if (r.lo > 0 or r.hi < 0) else " "  # NaN compares False
            base = (
                f"{r.baseline_mean:+7.2%} [{r.baseline_lo:+6.2%},{r.baseline_hi:+6.2%}]"
                if hasattr(r, "baseline_mean") and not pd.isna(getattr(r, "baseline_mean", np.nan))
                else ""
            )
            print(
                f"{str(r.horizon):>5} {r.alt:>3} {r.mean:+7.2%} {r.median:+7.2%} {r.hit_rate:5.0%} "
                f"[{r.lo:+6.2%},{r.hi:+6.2%}]{star}  {base}"
            )
    print("\nexcess = alternative minus stock; positive = trimming helped; * = CI excludes 0")


def stage_c1() -> None:
    folder = out_dir()
    (c1,) = build_all(("C1",))
    describe([c1])
    f = build_frames(c1)
    events = event_table(c1, f, 2)
    events.to_csv(folder / "events_c1.csv", index=False)
    m1 = m1_table(c1, f, events)
    m1.to_csv(folder / "m1_c1.csv", index=False)
    print("\n=== M1, C1 (2-week window) ===")
    print_m1(m1)
    top, base = m3(c1, f)
    top.to_csv(folder / "m3_top20_c1.csv", index=False)
    base.to_csv(folder / "m3_base_rates_c1.csv", index=False)
    with pd.option_context("display.width", 250, "display.max_colwidth", 200):
        print("\n=== M3, C1: 20 biggest winning closed trades, 2-week returns before the peak ===")
        print(top.to_string(index=False, formatters={"return": "{:+.0%}".format}))
        print("\n=== M3, C1: base rates (peak = highest close of the holding spell, t..t+4) ===")
        print(base.to_string(index=False, float_format="{:.3f}".format))


def stage_all(
    keys: tuple[str, ...] = ALL_KEYS,
    primary: str = "C1",
    group: tuple[str, ...] = ALL_KEYS,
    min_positive: int = 4,
) -> None:
    folder = out_dir()
    strategies = build_all(keys)
    describe(strategies)
    by_key = {s.key: s for s in strategies}
    all_events, m1s, sens, tops, bases = [], [], [], [], []
    for s in strategies:
        print(f"analysing {s.key} ...", flush=True)
        f = build_frames(s)
        ev = event_table(s, f, 2)
        all_events.append(ev)
        m1s.append(m1_table(s, f, ev))
        for window in (1, 4):
            ev_w = event_table(s, f, window)
            if len(ev_w):
                sens.append(m1_table(s, f, ev_w, with_baseline=False))
        top, base = m3(s, f)
        tops.append(top)
        bases.append(base)
    events = pd.concat(all_events, ignore_index=True)
    m1 = pd.concat(m1s, ignore_index=True)
    m1_sens = pd.concat(sens, ignore_index=True)
    m2 = m2_table(events)
    top = pd.concat(tops, ignore_index=True)
    base = pd.concat(bases, ignore_index=True)
    m4 = m4_table(by_key, events)
    halves = half_stats(events, {s.key: s.marked.index for s in strategies})
    m5 = m5_table(halves)
    for name, df in (
        ("events", events),
        ("m1", m1),
        ("m1_sensitivity_1w_4w", m1_sens),
        ("m2", m2),
        ("m3_top20", top),
        ("m3_base_rates", base),
        ("m4", m4),
        ("halves", halves),
        ("m5", m5),
    ):
        df.to_csv(folder / f"{name}.csv", index=False)
    decision = decision_rule(m1, m2, base, m4, halves, primary, group, min_positive)
    decision.to_csv(folder / "decision_rule.csv", index=False)
    with pd.option_context(
        "display.width", 250, "display.max_columns", 40, "display.float_format", "{:.4f}".format
    ):
        key_m1 = m1[(m1["alt"] == "B") & m1["horizon"].isin([4, 8])]
        print("\n=== M1 (alt B = other holdings), H = 4 and 8 ===")
        print(
            key_m1[
                [
                    "strategy",
                    "trigger",
                    "horizon",
                    "events",
                    "event_weeks",
                    "mean",
                    "lo",
                    "hi",
                    "hit_rate",
                    "baseline_mean",
                    "baseline_lo",
                    "baseline_hi",
                ]
            ].to_string(index=False)
        )
        print("\n=== M2 ===")
        print(m2.to_string(index=False))
        print("\n=== M3 base rates ===")
        print(base.to_string(index=False))
        print("\n=== M4 ===")
        print(m4.to_string(index=False))
        print("\n=== halves ===")
        print(halves.to_string(index=False))
        print("\n=== M5 ===")
        print(m5.to_string(index=False))
        print("\n=== decision rule (2-week triggers) ===")
        print(decision.to_string(index=False))
    print(f"\nwritten to {folder}")


ETF_EQUIVALENT = {"2w r>=20%": "2w r>=8%", "2w r>=30%": "2w r>=12%", "2w r>=40%": "2w r>=12%"}


def decision_rule(
    m1, m2, base, m4, halves, primary="C1", group=ALL_KEYS, min_positive=4
) -> pd.DataFrame:
    """The spec's five rules, judged on `primary`; rule 2's sign count runs over `group`."""
    rows = []
    c1 = m1[(m1["strategy"] == primary) & (m1["alt"] == "B")]
    for trigger in c1["trigger"].unique():
        if not trigger.startswith("2w"):
            continue
        sub = c1[c1["trigger"] == trigger].set_index("horizon")
        r1 = (
            all(h in sub.index and sub.at[h, "mean"] > 0 and sub.at[h, "lo"] > 0 for h in (4, 8))
            and int(sub["event_weeks"].max()) >= 20
        )
        hv = halves[(halves["strategy"] == primary) & (halves["trigger"] == trigger)]
        halves_ok = len(hv) == 2 and bool(((hv["mean_4w_B"] > 0) & (hv["mean_8w_B"] > 0)).all())
        positive = 0
        for key in group:
            t = ETF_EQUIVALENT.get(trigger, trigger) if key == "C6" else trigger
            x = m1[(m1["strategy"] == key) & (m1["trigger"] == t) & (m1["alt"] == "B")]
            x = x.set_index("horizon")
            if all(h in x.index and x.at[h, "mean"] > 0 for h in (4, 8)):
                positive += 1
        r2 = halves_ok and positive >= min_positive
        m4r = m4[(m4["strategy"] == primary) & (m4["trigger"] == trigger)]
        r3 = bool(len(m4r)) and bool(
            (m4r["after_tax_4w_pts_per_yr"] > 0).all()
            and (m4r["after_tax_8w_pts_per_yr"] > 0).all()
        )
        m2r = m2[(m2["strategy"] == primary) & (m2["trigger"] == trigger)]
        r4 = bool(len(m2r)) and all(
            m2r[f"mean_{h}w_B_drop_{side}5"].iloc[0] > 0
            for h in (4, 8)
            for side in ("best", "worst")
        )
        br = base[(base["strategy"] == primary) & (base["trigger"] == trigger)]
        r5 = bool(len(br)) and bool(
            br["P(peak|hit)"].iloc[0] >= 1.5 * br["P(peak|no hit)"].iloc[0]
            and br["fisher_p"].iloc[0] < 0.05
        )
        rows.append(
            {
                "trigger": trigger,
                "primary": primary,
                "rule1 4w&8w excess>0, CI excl 0, >=20 weeks": r1,
                f"rule2 both halves + >={min_positive} of {len(group)} strategies": r2,
                "strategies positive (4w&8w)": positive,
                "rule3 M4 after tax > 0": r3,
                "rule4 survives top/bottom 5": r4,
                "rule5 P(peak|hit) >= 1.5x and Fisher p<0.05": r5,
                "passes all": r1 and r2 and r3 and r4 and r5,
            }
        )
    return pd.DataFrame(rows)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("stage", choices=["sanity", "c1", "broad", "all"])
    args = parser.parse_args()
    if args.stage == "broad":
        # Owner, 2026-10-01: judge the rule on Broad Momentum (C3 primary), not the Nifty 50
        # stock layer, where the triggers barely fire. C6 (ETF) stays as the spec's control.
        stage_all(("C3", "C4", "C5", "C6"), primary="C3", group=BROAD_KEYS, min_positive=2)
        return
    {"sanity": stage_sanity, "c1": stage_c1, "all": stage_all}[args.stage]()


if __name__ == "__main__":
    main()
