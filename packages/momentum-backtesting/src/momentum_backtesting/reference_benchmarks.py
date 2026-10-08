"""Dividend-inclusive comparison lines shown alongside every backtest's own benchmark.

The engine's `benchmark` is a column of the dataset being ranked (ETF mode's "Nifty 50"), and
which flavour of return it carries depends on `track`: index mode prices it on the Fyers
`-INDEX` series (price-return, no dividends), ETF mode on NIFTYBEES (whose NAV keeps
dividends). Neither tells you what a passive investor would really have earned, nor whether
the strategy beats the obvious off-the-shelf momentum product. These two lines answer that:

- Nifty 50 TRI: the honest passive alternative (measured 2017-2026: about 1.3 points a year
  above the price index; TODO 3.9.23).
- Nifty200 Momentum 30 TRI: a buyable factor index (an ETF tracks it). Back-calculated by NSE
  before 2020-08-11 - a backtest of the index methodology, not live history.

Six more TRIs are loaded too (`EXTRA_REFERENCES`, BL-010 Phase 5) for judging a basket
against the broader market or its own factor family, by name, via
`criteria.basket_passes(..., indices=...)`. `compare()` and everything that displays comparison
lines still show only `REFERENCES`, so adding these changed no existing output:

- Nifty Midcap 150 TRI, Nifty Smallcap 250 TRI
- Nifty Midcap150 Momentum 50 TRI, Nifty500 Momentum 50 TRI
- Nifty 500 TRI (BL-010 Phase 6 backcast benchmark)
- Nifty Next 50 TRI (the dashboard's benchmark picker)

NSE back-calculates each of them before the index's launch, as it does Mom30 before 2020-08-11;
unlike Mom30 they carry no back-calculated flag yet, so read their early years as NSE's
backtest of the index method, not investable history.

`picker()` is the one place the dashboard reads several of them at once: the five indices its
headline benchmark picker offers (`PICKER`), each with its curve and headline statistics, so the
page can switch benchmark without running the backtest again. The benchmark never changes the
simulation itself, only what the result is compared against.

All of them come from `data/stocks/benchmarks_weekly.csv` (`mbt stocks fetch`, or for just the
extras `mbt stocks fetch-benchmarks`; niftyindices.com), or the shared database's
`stock_weekly_series` once those rows are migrated there. When neither exists the comparisons
are simply absent - never an error, since every dataset can run without them.
"""

from __future__ import annotations

import math
from pathlib import Path

import pandas as pd

from . import metrics
from .config import DATA_DIR
from .stocks.ui_data import (
    NIFTY50_TRI,
    NIFTY200_MOMENTUM30_TRI,
    NIFTY500_MOMENTUM50_TRI,
    NIFTY500_TRI,
    NIFTY_MIDCAP150_MOMENTUM50_TRI,
    NIFTY_MIDCAP150_TRI,
    NIFTY_NEXT50_TRI,
    NIFTY_SMALLCAP250_TRI,
    REFERENCE_ONLY_COLUMNS,
)

#: The comparison lines every backtest payload shows (`compare`).
REFERENCES = (NIFTY50_TRI, NIFTY200_MOMENTUM30_TRI)
#: Loaded by `load_references` but never displayed by `compare`.
EXTRA_REFERENCES = (
    NIFTY_MIDCAP150_TRI,
    NIFTY_SMALLCAP250_TRI,
    NIFTY_MIDCAP150_MOMENTUM50_TRI,
    NIFTY500_MOMENTUM50_TRI,
    NIFTY500_TRI,
    NIFTY_NEXT50_TRI,
)
LOADED = REFERENCES + EXTRA_REFERENCES
#: The benchmarks the dashboard's headline picker offers, in menu order (owner, 2026-10-07): the
#: buyable momentum index first. All dividend-inclusive, so any two compare like for like.
PICKER = (
    NIFTY200_MOMENTUM30_TRI,
    NIFTY50_TRI,
    NIFTY_NEXT50_TRI,
    NIFTY_MIDCAP150_TRI,
    NIFTY_SMALLCAP250_TRI,
)
#: First live (not back-calculated) week of the Nifty200 Momentum 30 index.
MOMENTUM30_LIVE_FROM = pd.Timestamp("2020-08-11")

_CSV_COLUMNS = {
    "nifty50_tri": NIFTY50_TRI,
    "nifty200_momentum30_tri": NIFTY200_MOMENTUM30_TRI,
    **REFERENCE_ONLY_COLUMNS,
}


def _from_db() -> pd.DataFrame | None:
    from . import db_read  # noqa: PLC0415 (db_read imports trading_data; keep it lazy)

    if db_read.catalog_mtime() is None:
        return None
    with db_read.open_catalog(read_only=True) as con:
        # Migration 004 moved these TRIs from `momentum_prices` to `stock_weekly_series`. A
        # read-only connect never migrates, so a catalog last opened for writing before 004 has
        # no such table: that, or no matching rows, means "not in the database" -> the CSV.
        if not db_read._has_table(con, "stock_weekly_series"):
            return None
        rows = con.execute(
            "SELECT week, series, close FROM stock_weekly_series "
            "WHERE series IN (SELECT unnest(?)) ORDER BY week",
            [list(LOADED)],
        ).fetchall()
    return db_read._pivot_weekly(rows, "close") if rows else None


def load_references(data_dir: Path | None = None) -> pd.DataFrame:
    """Weekly closes for REFERENCES + EXTRA_REFERENCES (Friday-labelled, like every other weekly
    frame): the shared database first, then `<data_dir>/stocks/benchmarks_weekly.csv`. Empty
    frame when no source has them."""
    frame = _from_db()
    if frame is None or any(name not in frame for name in LOADED):
        # The CSV fills whatever the database lacks (e.g. extras written with --skip-catalog,
        # or a catalog migrated before they existed); the database wins where both have it.
        path = (data_dir or DATA_DIR) / "stocks" / "benchmarks_weekly.csv"
        if path.exists():
            raw = pd.read_csv(path, index_col=0, parse_dates=True)
            csv = raw[[c for c in _CSV_COLUMNS if c in raw]].rename(columns=_CSV_COLUMNS)
            if frame is None:
                frame = csv
            else:
                missing = [c for c in csv if c not in frame]
                frame = frame.join(csv[missing], how="outer") if missing else frame
    if frame is None:
        return pd.DataFrame(columns=list(LOADED), dtype=float)
    return frame[[c for c in LOADED if c in frame]].sort_index()


def _align(
    reference: pd.Series | None, span: pd.DatetimeIndex
) -> tuple[pd.Series | None, str | None]:
    """`reference` on the backtest's weeks, rebased to 1.0 at the first week, and why not when it
    cannot be. A week the reference lacks (a holiday-shortened week labelled differently) carries
    the previous close forward one week at most; a longer hole, a start after the first week or
    an end more than a week before the last would make its statistics describe a different
    window (or an invented flat stretch), so the line is refused with a reason the page shows."""
    s = None if reference is None else reference.dropna()
    if s is None or s.empty:
        return None, "No data for this index"
    if s.index[0] > span[0]:
        return None, f"Starts {s.index[0]:%d %b %Y}, after this run's first week"
    filled = s.reindex(s.index.union(span)).ffill(limit=1).reindex(span)
    if pd.isna(filled.iloc[0]):
        return None, f"Starts {s.index[0]:%d %b %Y}, after this run's first week"
    if pd.isna(filled.iloc[-1]):
        return None, f"Ends {s.index[-1]:%d %b %Y}, more than a week before this run's last week"
    if filled.isna().any():
        first = filled.index[filled.isna().to_numpy().argmax()]
        weeks = int(filled.isna().sum())
        return None, f"Missing {weeks} weeks from {first:%d %b %Y}"
    return filled / filled.iloc[0], None


def aligned(reference: pd.Series, span: pd.DatetimeIndex) -> pd.Series | None:
    """`reference` on the backtest's weeks, rebased to 1.0 at the first week; None when it does
    not cover the whole window (see `_align`) - a partial line would make its CAGR meaningless."""
    return _align(reference, span)[0]


def compare(equity: pd.Series, references: pd.DataFrame) -> list[dict]:
    """One entry per reference that covers the whole backtest: its rebased curve and the
    strategy's CAGR edge over it."""
    out = []
    if references is None or references.empty or len(equity) < 2:
        return out
    strategy_cagr = metrics.cagr(equity)
    for name in REFERENCES:
        if name not in references:
            continue
        line = aligned(references[name], equity.index)
        if line is None:
            continue
        ref_cagr = metrics.cagr(line)
        depth, _, _ = metrics.max_drawdown(line)
        note = _back_calculated_note(name, equity.index[0])
        out.append(
            {
                "name": name,
                "curve": line,
                "cagr": ref_cagr,
                "excess_cagr": strategy_cagr - ref_cagr,
                "max_drawdown": depth,
                "note": note,
            }
        )
    return out


def _back_calculated_note(name: str, start: pd.Timestamp) -> str | None:
    if name == NIFTY200_MOMENTUM30_TRI and start < MOMENTUM30_LIVE_FROM:
        return "Back-calculated by NSE before 11 Aug 2020"
    return None


def _year_end_returns(curve: pd.Series) -> pd.Series:
    """Calendar-year returns, the first year from the curve's first week (as `metrics.yearly`)."""
    year_end = curve.groupby(curve.index.year).last()
    start = pd.Series([curve.iloc[0]], index=[curve.index[0].year - 1])
    return pd.concat([start, year_end]).pct_change().dropna()


def picker(equity: pd.Series, cash: pd.Series, references: pd.DataFrame | None) -> list[dict]:
    """One entry per `PICKER` index, in menu order. An index that covers the backtest carries its
    rebased `curve` and the statistics the strategy's own KPIs use, on the same definitions:
    CAGR, volatility and Sharpe vs cash (`metrics.curve_stats`), Sortino as (CAGR - cash CAGR)
    over annualised downside deviation, max drawdown, and how many calendar years the strategy
    beat it. `as_of` is the index's last real close on or before the final week (`aligned` may
    carry it one week forward). An index with no usable data is listed with `available` False,
    so the menu can say so, with a `reason`, instead of dropping it."""
    out: list[dict] = []
    if len(equity) < 2:
        return out
    strategy_cagr = metrics.cagr(equity)
    cash_cagr = metrics.cagr(cash)
    strategy_years = _year_end_returns(equity)
    for name in PICKER:
        source = references[name] if references is not None and name in references else None
        line, reason = _align(source, equity.index)
        if line is None:
            out.append({"name": name, "available": False, "reason": reason})
            continue
        stats = metrics.curve_stats(line, cash)
        weekly = line.pct_change().dropna()
        downside = weekly[weekly < 0].std() * math.sqrt(metrics.WEEKS_PER_YEAR)
        closes = source.dropna()
        as_of = closes.index[closes.index <= equity.index[-1]][-1]
        years = _year_end_returns(line).reindex(strategy_years.index)
        out.append(
            {
                "name": name,
                "available": True,
                "as_of": f"{as_of:%Y-%m-%d}",
                "note": _back_calculated_note(name, equity.index[0]),
                "curve": line,
                "cagr": stats["CAGR"],
                "excess_cagr": strategy_cagr - stats["CAGR"],
                "total_return": line.iloc[-1] - 1,
                "volatility": stats["volatility"],
                "sharpe": stats["Sharpe"],
                "sortino": (stats["CAGR"] - cash_cagr) / downside if downside else None,
                "max_drawdown": stats["max drawdown"],
                "max_drawdown_trough": stats["max drawdown trough"],
                "years_beating": int((strategy_years > years).sum()),
            }
        )
    return out
