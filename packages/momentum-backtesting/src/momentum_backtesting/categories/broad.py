"""Broad Momentum: momentum-first universe, categories re-ranked from the survivors.

Fixes a methodological problem in the "Custom Index" tab (`categories/compose.py`'s
`build_all_categories_price_table`): that tab's ~113 categories (`curated/stock_groups.csv`,
built by TODO.md 3.9.12) were picked by a third party (stockscans.in) or NSE's own official
sector-index list for being notable -- plausibly because they'd already performed well, exactly
the kind of in-sample selection bias that produced Diamonds Gems Jewellery's suspiciously high
CAGR (TODO.md 3.9.2). Backtesting only on a "these looked interesting" category list, scored by
its own independent history, isn't a fair test of forward edge.

This module implements a three-layer funnel instead (TODO.md 3.9.13; see
`/Users/rahul/.claude/plans/b-both-modes-i-should-silly-kazoo.md` for the full design record):

  1. **Stock-level momentum** (`compute_universe_ranking`) ranks every stock ever in NSE's own
     Nifty Total Market index (755 names as of 2026-09 -- `sources.TOTAL_MARKET_SLUG`, the only
     honest proxy for "top-N by market cap" this repo has, since no market-cap data source
     exists anywhere in the codebase), gated by POINT-IN-TIME membership (`fetch_universe.py`'s
     Wayback-snapshot machinery, generalised from `categories/snapshots.py` -- see
     `run_fetch_total_market` below). The top ~200 (`pool_top_n`/`pool_exit_rank` hysteresis
     buffer, mirroring the `top_n`/`exit_rank` pattern used everywhere else in this engine) form
     a "qualifying pool," refreshed quarterly (`_quarter_end_weeks`) -- entirely unbiased,
     nothing category-specific yet.
  2. **Categories are re-ranked**, but their score is DERIVED from the qualifying pool, not from
     an independent category backtest: a category's score is the average momentum rank of its
     members that made the pool, among only categories clearing a minimum coverage floor
     (`coverage_floor` -- qualifying members / total members), so one special-situation stock
     can't drag a whole category in on a strong average of one. Gold/Silver/Nasdaq 100/Hang Seng
     (`ATOMIC_NAMES`) compete on the SAME footing, each as its own single-member "category" (see
     `score_categories`).
  3. **Within each currently-held category**, its top 2 members BY THE SAME STEP-1 RANK are
     picked -- a lookup/sort against an already-computed rank table, not a new inner backtest
     (unlike Custom Index's per-category `run_inner_category_backtest`).

Category selection uses the exact same top_n/exit_rank hysteresis idiom as the rest of this
engine (`_apply_hysteresis`, reused for both the pool cut and the category cut) -- so at any
time the portfolio can hold between 0 and `category_exit_rank` categories/atomics at once, a mix
of freshly-selected (rank <= `category_top_n`) and lingering-in-the-buffer ones, each contributing
up to `picks_per_category` stocks (1 for an atomic).

**Weighting reuses the existing buffer-rule engine unmodified.** `build_effective_stock_ranks`
constructs a per-week, per-stock RANK TABLE (not a price series or a P&L simulation) that makes
`engine.run_backtest`'s existing `top_n`/`exit_rank` buffer machinery reproduce the intended
weighting on its own: a stock in a currently-fresh category gets a rank within
`[1, category_top_n * picks_per_category]` (eligible for fresh money, like any top-N pick);
a stock in a lingering category gets a rank within
`(category_top_n * picks_per_category, category_exit_rank * picks_per_category]` (held, never
topped up, exactly matching `_run_buffer`'s own semantics); anyone else gets NaN (ineligible).
Fed into `engine.run_backtest` via the `external_ranks` parameter (added by this task -- see
that function's own docstring for why no other engine.py change was needed).

**"Category mode" OFF path** (`build_off_mode_ranks`): skips layers 2-3 entirely and exposes
layer 1's own pool-restricted stock ranking directly, for a second, independent top_n/exit_rank
("SL") -- mirrors `stocks/`'s existing Nifty-50 stock-momentum tab, just pointed at the 755-name
Total Market universe instead of 95 names. Both modes share the same `UniverseRanking`.

Deliberately reuses, unmodified: `categories/prices.py`'s `build_stock_weekly_prices` (corporate-
action-like-event detection/splitting) for the 755-name price frame, and
`categories/compose.py`'s `build_membership_frame` (segment-liveness-aware year membership gate)
for point-in-time eligibility -- exactly the same machinery `compose.py` already uses per
category, just at the 755-name Total Market scale instead of a ~20-name category scale.
"""

from __future__ import annotations

import csv
import time
from collections import OrderedDict
from dataclasses import dataclass, field
from pathlib import Path
from typing import Literal

import numpy as np
import pandas as pd

from momentum_backtesting import engine
from momentum_backtesting import tax as tax_mod
from momentum_backtesting.categories import compose, snapshots, sources
from momentum_backtesting.categories import liquidity as liquidity_mod
from momentum_backtesting.categories import prices as cat_prices
from momentum_backtesting.categories.liquidity import LiquidityConfig
from momentum_backtesting.engine import CASH, Config, Result
from momentum_backtesting.stocks.nse import NseClient, atomic_write_bytes

#: The four non-equity instruments that compete alongside categories at Step 3 (TODO.md 3.9.13's
#: plan, "Gold, Silver, and the International ETFs compete too"). Deliberately excludes Cash/Gilt
#: (`categories/compose.py`'s other two `ATOMIC_INSTRUMENTS`) -- the user explicitly deferred
#: that as "a separate, defensive-mode question... not requested here."
ATOMIC_NAMES: tuple[str, ...] = ("Gold", "Silver", "Nasdaq 100", "Hang Seng")

#: Step 1 output filenames, under data/categories/ (sibling of category_membership.csv, same
#: shape, kept separate rather than merged into that file -- a different "category", Total
#: Market itself, not one of universe.csv's 16 sector indices).
TOTAL_MARKET_LABEL = "Total Market"
TOTAL_MARKET_MEMBERSHIP_FILENAME = "total_market_membership.csv"
TOTAL_MARKET_FETCH_REPORT_FILENAME = "total_market_fetch_report.csv"

#: curated/stock_groups.csv's own filename (TODO.md 3.9.12 -- committed package data, read-only
#: from here per categories/__init__.py's documented boundary).
STOCK_GROUPS_FILENAME = "stock_groups.csv"
#: The extra tags for every NSE-listed stock outside the 755-name Total Market (derived from BSE's
#: sector/industry classification; see curated/stock_groups_wide_catalog.md). Read only when a run
#: asks for `category_tags="extended"` -- the default curated-only behaviour is unchanged.
STOCK_GROUPS_WIDE_FILENAME = "stock_groups_wide.csv"

#: Defaults -- Step 6's real sweep (TODO.md 3.9.13's own row has the full numbers) found
#: pool_exit_rank=250 a clean, unambiguous win over the plan's original 300 guess (better CAGR,
#: Sharpe, drawdown AND turnover, all four -- changed here). category_exit_rank=8 and
#: coverage_floor=0.40 are KEPT at the plan's own starting values even though exit_rank=6 and
#: floor=0.30 each tested marginally better in isolation: the gap is modest and tuning two more
#: knobs off the same single historical backtest run risks the overfitting this session's own
#: standard (3.9.8/3.9.9) exists to guard against -- both are documented as real, reproducible
#: candidates for revisit once there's more than one run's worth of evidence to check them
#: against, not silently dropped.
DEFAULT_POOL_TOP_N = 200
DEFAULT_POOL_EXIT_RANK = 250
DEFAULT_COVERAGE_FLOOR = 0.40
DEFAULT_CATEGORY_TOP_N = 4
DEFAULT_CATEGORY_EXIT_RANK = 8
DEFAULT_PICKS_PER_CATEGORY = 2
#: Concentration caps for the UI's Broad Momentum defaults (see `run_broad_backtest`). Not the
#: engine's own 35% default, which was tuned for ~5 ETF positions. 15% per stock and 30% per
#: category leave room to be fully invested with the default 4 fresh categories x 2 stocks.
DEFAULT_MAX_POSITION = 0.15
DEFAULT_MAX_CATEGORY = 0.30
#: Rupees per share above which a stock is skipped (one share of MRF alone is over a lakh).
DEFAULT_MAX_STOCK_PRICE = 20_000.0


class TotalMarketDataNotFoundError(Exception):
    """data/categories/total_market_membership.csv doesn't exist yet -- run
    `mbt categories fetch-universe` first."""


# ---------------------------------------------------------------------------------------------
# Step 1 -- point-in-time Total Market membership (Wayback snapshots, generalised from
# categories/snapshots.py -- its own build_category_year_membership already takes an arbitrary
# (category label, slug) pair, so no change to that module was needed, only this thin wrapper).
# ---------------------------------------------------------------------------------------------


@dataclass
class FetchSummary:
    rows_written: int = 0
    tier_counts: dict[str, int] = field(default_factory=dict)
    elapsed_seconds: float = 0.0


def _write_csv_atomic(df: pd.DataFrame, path: Path) -> None:
    atomic_write_bytes(path, df.to_csv(index=False).encode("utf-8"))


def run_fetch_total_market(data_dir: Path, client: NseClient, years: list[int]) -> FetchSummary:
    """Fetch/refresh data_dir/total_market_membership.csv (+ its own fetch report) -- the same
    three-tier (live_annual_snapshot/nearest_fallback/constant_current) Wayback-snapshot
    resolution `categories fetch` already does per sector category, run once here against
    `sources.TOTAL_MARKET_SLUG` instead. Never raises for thin/missing Wayback history -- see
    `snapshots.build_category_year_membership`'s own degrade-gracefully contract, unchanged."""
    start = time.monotonic()
    rows, reports = snapshots.build_category_year_membership(
        TOTAL_MARKET_LABEL, sources.TOTAL_MARKET_SLUG, years, client
    )

    data_dir.mkdir(parents=True, exist_ok=True)
    membership_df = pd.DataFrame(
        rows, columns=["category", "year", "symbol", "source_tier", "wayback_timestamp"]
    )
    _write_csv_atomic(membership_df, data_dir / TOTAL_MARKET_MEMBERSHIP_FILENAME)

    report_df = pd.DataFrame(
        [
            {
                "category": r.category,
                "year": r.year,
                "source_tier": r.source_tier,
                "wayback_timestamp": r.wayback_timestamp,
                "n_symbols": r.n_symbols,
                "note": r.note,
            }
            for r in reports
        ],
        columns=["category", "year", "source_tier", "wayback_timestamp", "n_symbols", "note"],
    )
    _write_csv_atomic(report_df, data_dir / TOTAL_MARKET_FETCH_REPORT_FILENAME)

    tier_counts = report_df["source_tier"].replace("", pd.NA).dropna().value_counts().to_dict()
    return FetchSummary(
        rows_written=len(membership_df),
        tier_counts={str(k): int(v) for k, v in tier_counts.items()},
        elapsed_seconds=time.monotonic() - start,
    )


def total_market_members_by_year(data_dir: Path) -> dict[int, set[str]]:
    """year -> Total Market member symbols. Prefers the shared local database (`category_
    membership` table, category='Total Market', populated by `mbt local migrate`) over
    data_dir/total_market_membership.csv once it has rows — see db_read.py's module
    docstring — falling back to the file on a fresh checkout or before that migration
    has run."""
    from .. import db_read  # noqa: PLC0415 (avoid a hard import cycle at module load)

    from_db = db_read.total_market_members_by_year_from_db_or_none()
    if from_db is not None:
        return from_db

    path = data_dir / TOTAL_MARKET_MEMBERSHIP_FILENAME
    if not path.exists():
        raise TotalMarketDataNotFoundError(
            f"{path} does not exist -- run `mbt categories fetch-universe` first"
        )
    df = pd.read_csv(path, dtype={"year": int, "symbol": str})
    if df.empty:
        raise TotalMarketDataNotFoundError(f"{path} has no rows -- Wayback fetch produced nothing")
    return {int(year): set(group["symbol"]) for year, group in df.groupby("year")}


# ---------------------------------------------------------------------------------------------
# curated/stock_groups.csv reader (TODO.md 3.9.12's parent_group/subgroup taxonomy) -- Step 3's
# categories. Read-only reuse, per categories/__init__.py's documented boundary.
# ---------------------------------------------------------------------------------------------


def _read_groups(path: Path, groups: dict[str, set[str]]) -> None:
    with path.open(newline="") as f:
        for row in csv.DictReader(f):
            cid = f"{row['parent_group']} :: {row['subgroup']}"
            symbol = row["symbol"].strip()
            if symbol:
                groups.setdefault(cid, set()).add(symbol)


def load_stock_groups(curated_dir: Path, extended: bool = False) -> dict[str, set[str]]:
    """category_id ("parent_group :: subgroup") -> member symbols, from stock_groups.csv.
    `parent_group :: subgroup` (not `subgroup` alone) is used as the id so two differently-
    parented subgroups that happen to share a display name can never collide -- verified none
    do as of 2026-09 (113 subgroups, 113 distinct ids), but the qualified id costs nothing and
    removes the assumption.

    `extended=True` also reads `stock_groups_wide.csv` (tags for stocks outside the 755-name
    Total Market). Rows that name an existing category id add members to it; others make new
    categories. The default is the curated file only, so every existing result is unchanged."""
    path = curated_dir / STOCK_GROUPS_FILENAME
    wide = curated_dir / STOCK_GROUPS_WIDE_FILENAME
    use_wide = extended and wide.exists()
    if extended and not wide.exists():
        raise FileNotFoundError(
            f"{wide} is missing; build it before using category_tags='extended'"
        )
    stamp = (str(path), path.stat().st_mtime_ns, wide.stat().st_mtime_ns if use_wide else 0)
    cached = _groups_cache.get(stamp)
    if cached is not None:
        return cached
    groups: dict[str, set[str]] = {}
    _read_groups(path, groups)
    if use_wide:
        _read_groups(wide, groups)
    # Same object back on every call until the file changes, so callers must treat it as
    # read-only; it is also what lets `ordered_categories_by_week` recognise repeat calls.
    # One entry per variant (curated / extended) so alternating between them keeps both cached.
    _groups_cache[stamp] = groups
    return groups


_groups_cache: dict[tuple[str, int, int], dict[str, set[str]]] = {}


# ---------------------------------------------------------------------------------------------
# Generic top_n/exit_rank hysteresis -- shared by the Step 2 pool cut and the Step 3 category
# cut. Deliberately standalone/pure (no P&L, no engine.py dependency) -- same idiom
# `engine._Sim.top_names`/`exit_reason` already use, just expressed once here for reuse over
# plain ranked-name lists instead of a live simulation.
# ---------------------------------------------------------------------------------------------


def apply_hysteresis(
    prev_held: list[str] | set[str], ranked_names: list[str], top_n: int, exit_rank: int
) -> list[str]:
    """`ranked_names` sorted best-first (ascending score/rank, ties already broken). Returns the
    new held set, ordered best-first: every name ranked <= top_n enters (or stays, if already
    held); a name NOT in the top_n stays only if it was already held AND is still ranked
    <= exit_rank. A name never held before and outside top_n never enters, even if inside
    exit_rank (matches `engine._Sim.top_names`: only the top N may be freshly bought). The
    returned list length can never exceed exit_rank (every name in it individually satisfies
    rank <= exit_rank, since top_n <= exit_rank is assumed, as engine.Config enforces)."""
    rank_of = {name: i + 1 for i, name in enumerate(ranked_names)}
    held = set(ranked_names[:top_n])
    held |= {n for n in prev_held if rank_of.get(n, float("inf")) <= exit_rank}
    return sorted(held, key=lambda n: rank_of[n])


def _quarter_key(ts: pd.Timestamp) -> tuple[int, int]:
    return (ts.year, (ts.month - 1) // 3)


def _quarter_end_weeks(weeks: list[pd.Timestamp]) -> list[pd.Timestamp]:
    """Weeks that are the last-in-`weeks` for their calendar quarter -- mirrors
    engine._month_end_weeks's own logic exactly, at quarter instead of month granularity. Kept
    here (not added to engine.py) since Step 2's pool refresh is computed directly, never through
    `run_backtest` -- see this module's own docstring."""
    return [
        w
        for i, w in enumerate(weeks)
        if i == len(weeks) - 1 or _quarter_key(weeks[i + 1]) != _quarter_key(w)
    ]


# ---------------------------------------------------------------------------------------------
# Shared frame-building helper (TODO.md 3.9.16) -- the 755-name price frame + point-in-time
# membership gate, split out of Step 2 below so a caller that only needs ONE week's raw prices/
# eligibility (the Momentum Scores snapshot, categories/momentum_scores.py) doesn't have to pay
# for Step 2's engine.compute_ranks call or the quarterly pool-hysteresis loop below -- neither
# is needed for a single-week percentile snapshot, and skipping them is most of what makes that
# endpoint cheap where Step 2 itself (~20s, see api.py's own comment on it) is not.
# ---------------------------------------------------------------------------------------------


@dataclass(frozen=True)
class StockUniverseFrame:
    """The 755-name (+split-segment) weekly price frame and its point-in-time membership gate,
    with no ranking computed yet -- exactly the fields `compute_universe_ranking` used to build
    inline before this was split out; that function is now a thin wrapper: this dataclass's
    fields, unchanged in shape, plus its own Steps 2+."""

    frame: pd.DataFrame  # week x column (755 base symbols, or "SYM#2" etc for split segments)
    weeks: list[pd.Timestamp]
    column_to_base_symbol: dict[str, str]
    stock_membership: pd.DataFrame  # week x column booleans -- point-in-time + segment-liveness
    events: pd.DataFrame
    stale_columns: dict[str, pd.Timestamp]
    missing_symbols: list[str]  # Total Market symbols with no daily.parquet rows at all
    raw_frame: pd.DataFrame | None = None  # unadjusted per-share closes for the entry ceiling
    # week x column booleans from categories/liquidity.py; None = no liquidity gate requested.
    # Already AND-ed into `stock_membership`; kept separately so the quarterly-fixed pool can be
    # re-gated every week (a held stock that turns illiquid mid-quarter must drop out).
    liquidity_gate: pd.DataFrame | None = None


def load_stock_universe_frame(
    *,
    stocks_data_dir: Path,
    categories_data_dir: Path,
    min_drop_pct: float = cat_prices.DEFAULT_MIN_DROP_PCT,
    turnover_spike_multiple: float = cat_prices.DEFAULT_TURNOVER_SPIKE_MULTIPLE,
    liquidity: LiquidityConfig | None = None,
    universe: Literal["total_market", "all_liquid"] = "total_market",
    series_breaks: Literal["legacy", "verified"] = "verified",
) -> StockUniverseFrame:
    """The 755-name Total Market weekly price frame + point-in-time membership gate, computed
    over the WHOLE available price history -- no ranking, no atomics, no pool. See
    `StockUniverseFrame`'s own docstring for why this is split out of `compute_universe_ranking`."""
    if universe == "all_liquid":
        # Whole NSE market: "listed that year" from the bhavcopy lake itself, and the
        # tradability gate is what actually narrows it, so it is mandatory here.
        if liquidity is None:
            raise ValueError("The whole-market universe needs the tradability filter on.")
        members_by_year = liquidity_mod.market_members_by_year()
    else:
        members_by_year = total_market_members_by_year(categories_data_dir)
    all_symbols = sorted(set().union(*members_by_year.values()))

    frame, events, stale_columns, raw_frame = cat_prices.build_stock_weekly_prices(
        all_symbols,
        stocks_data_dir=stocks_data_dir,
        min_drop_pct=min_drop_pct,
        turnover_spike_multiple=turnover_spike_multiple,
        series_breaks=series_breaks,
        return_raw_weekly=True,
    )
    if frame.empty:
        raise ValueError("no priced weeks for the Total Market universe -- check daily.parquet")

    column_to_base_symbol = {col: col.split("#", 1)[0] for col in frame.columns}
    priced_base_symbols = set(column_to_base_symbol.values())
    missing_symbols = sorted(s for s in all_symbols if s not in priced_base_symbols)

    stock_membership = compose.build_membership_frame(
        frame.index,
        members_by_year,
        column_to_base_symbol,
        events=events,
        stale_columns=stale_columns,
    )
    gate = None
    if liquidity is not None:
        base_gate = liquidity_mod.eligibility(liquidity, all_symbols, frame.index)
        gate = pd.DataFrame(
            {col: base_gate[base] for col, base in column_to_base_symbol.items()},
            index=frame.index,
        )
        stock_membership = stock_membership & gate.reindex_like(stock_membership).fillna(False)
    return StockUniverseFrame(
        frame=frame,
        weeks=list(frame.index),
        column_to_base_symbol=column_to_base_symbol,
        stock_membership=stock_membership,
        events=events,
        stale_columns=stale_columns,
        missing_symbols=missing_symbols,
        raw_frame=raw_frame,
        liquidity_gate=gate,
    )


# ---------------------------------------------------------------------------------------------
# Step 2 -- stock-level momentum ranking + quarterly-refreshed qualifying pool.
# ---------------------------------------------------------------------------------------------


@dataclass(frozen=True)
class UniverseRanking:
    """Everything Step 2 produces, ready for both the ON (Steps 3-4) and OFF (direct top-N)
    paths -- see this module's own docstring."""

    prices: pd.DataFrame  # week x (stock columns incl. #N split segments, + ATOMIC_NAMES)
    weeks: list[pd.Timestamp]
    global_ranks: pd.DataFrame  # week x column -- raw momentum rank across the WHOLE frame
    pool_membership: pd.DataFrame  # week x stock column booleans -- quarterly-fixed pool cut
    stock_pool_ranks: pd.DataFrame  # week x stock column -- dense rank, pool stocks only (OFF)
    combined_pool_ranks: pd.DataFrame  # week x column -- dense rank, pool stocks + atomics (ON)
    column_to_base_symbol: dict[str, str]
    events: pd.DataFrame
    stale_columns: dict[str, pd.Timestamp]
    missing_symbols: list[str]  # Total Market symbols with no daily.parquet rows at all
    raw_prices: pd.DataFrame | None = None  # raw stock prices plus atomics, for entry cap
    # week x stock column booleans from the tradability gate (None = no gate). Kept so a trade
    # list can say an exit was "liquidity failed" rather than just "ineligible".
    liquidity_gate: pd.DataFrame | None = None


def _dense_rank(masked: pd.DataFrame) -> pd.DataFrame:
    """Per-week dense re-rank (1..N, ascending, NaN excluded) of an already-NaN-masked score
    frame -- `DataFrame.rank(axis=1)` does exactly this, vectorised; used to turn "raw global
    rank restricted to this week's eligible names" into a fresh 1..N numbering among just those
    names, which is what `top_n`/`exit_rank` comparisons need (the RAW global rank of the
    200th-best pool stock could be an arbitrary large number if many higher-ranked stocks
    aren't currently pool-eligible)."""
    return masked.rank(axis=1, method="min")


def _compute_pool_membership(
    global_ranks: pd.DataFrame,
    stock_membership: pd.DataFrame,
    weeks: list[pd.Timestamp],
    *,
    top_n: int,
    exit_rank: int,
) -> pd.DataFrame:
    """Quarterly-refreshed pool cut (Step 2's own hysteresis, `apply_hysteresis` applied once per
    quarter-end using that week's Total-Market-membership-gated candidates), forward-filled onto
    every week in between -- "the top-200 qualifying pool... refreshed quarterly, fixed" per the
    plan. Weeks before the very first quarter-end use that first quarter's own decision (there is
    no earlier data to decide from; `run_backtest`'s own lookback-eligibility gate excludes very
    early weeks from the backtest regardless)."""
    quarter_ends = _quarter_end_weeks(weeks)
    symbols = list(global_ranks.columns)
    out = pd.DataFrame(False, index=weeks, columns=symbols)
    if not quarter_ends:
        return out

    decisions: dict[pd.Timestamp, list[str]] = {}
    held: list[str] = []
    for qw in quarter_ends:
        row_rank = global_ranks.loc[qw]
        row_member = (
            stock_membership.loc[qw] if qw in stock_membership.index else pd.Series(dtype=bool)
        )
        candidates = [
            n for n in symbols if bool(row_member.get(n, False)) and pd.notna(row_rank.get(n))
        ]
        candidates.sort(key=lambda n: (row_rank[n], n))
        held = apply_hysteresis(held, candidates, top_n, exit_rank)
        decisions[qw] = list(held)

    current = decisions[quarter_ends[0]]
    qi = 0
    for w in weeks:
        while qi < len(quarter_ends) and w >= quarter_ends[qi]:
            current = decisions[quarter_ends[qi]]
            qi += 1
        if current:
            out.loc[w, current] = True
    return out


@dataclass(frozen=True)
class UniverseBase:
    """Step 2 up to the global momentum ranks -- see `compute_universe_base`."""

    universe: StockUniverseFrame
    full_frame: pd.DataFrame
    raw_full_frame: pd.DataFrame | None
    weeks: list[pd.Timestamp]
    global_ranks: pd.DataFrame


def compute_universe_base(
    *,
    outer_prices: pd.DataFrame,
    stocks_data_dir: Path,
    categories_data_dir: Path,
    lookbacks: tuple[int, ...] = (1, 4, 13, 26, 52),
    weights: tuple[float, ...] | None = None,
    score: Literal["ranksum", "voladj", "blend"] = "ranksum",
    voladj_skip_recent_month: bool = True,
    min_drop_pct: float = cat_prices.DEFAULT_MIN_DROP_PCT,
    turnover_spike_multiple: float = cat_prices.DEFAULT_TURNOVER_SPIKE_MULTIPLE,
    liquidity: LiquidityConfig | None = None,
    universe_kind: Literal["total_market", "all_liquid"] = "total_market",
    series_breaks: Literal["legacy", "verified"] = "verified",
) -> UniverseBase:
    """The expensive half of Step 2 -- everything that does not depend on the pool size.
    `finish_universe_ranking` adds the pool cut (cheap), so a search can reuse one base across
    many `pool_top_n`/`pool_exit_rank` settings. Originally `compute_universe_ranking` in one
    piece (still available, below): build the 755-name weekly price frame (Piece A, reused
    unmodified),
    rank it (the existing engine.compute_ranks, unmodified -- just a bigger universe than any
    existing caller passes), and derive the quarterly-refreshed qualifying pool. Computed over
    the WHOLE available price history (no start/end restriction) -- `run_backtest`'s own
    `config.start`/`config.end` windowing is applied later, by the caller, exactly like every
    other dataset in this package.

    `weights` (one per lookback, same as every other dataset's `_config_kwargs`) is threaded
    into the Step-1 ranksum computation -- TODO.md 3.9.15 (per-tab settings audit): the per-
    lookback weight table was already shown in the UI for this tab (score="ranksum" is this
    tab's own default) but silently ignored server-side until now."""
    universe = load_stock_universe_frame(
        stocks_data_dir=stocks_data_dir,
        categories_data_dir=categories_data_dir,
        min_drop_pct=min_drop_pct,
        turnover_spike_multiple=turnover_spike_multiple,
        liquidity=liquidity,
        universe=universe_kind,
        series_breaks=series_breaks,
    )
    frame = universe.frame

    atomics = outer_prices.reindex(frame.index)[list(ATOMIC_NAMES)]
    full_frame = pd.concat([frame, atomics], axis=1)
    raw_full_frame = (
        pd.concat([universe.raw_frame, atomics], axis=1) if universe.raw_frame is not None else None
    )
    weeks = list(full_frame.index)

    config = Config(
        lookbacks=lookbacks,
        weights=weights,
        score=score,
        voladj_skip_recent_month=voladj_skip_recent_month,
        universe=tuple(full_frame.columns),
    )
    global_ranks, _global_scores = engine.compute_ranks(full_frame, config)

    return UniverseBase(
        universe=universe,
        full_frame=full_frame,
        raw_full_frame=raw_full_frame,
        weeks=weeks,
        global_ranks=global_ranks,
    )


def finish_universe_ranking(
    base: UniverseBase,
    *,
    pool_top_n: int = DEFAULT_POOL_TOP_N,
    pool_exit_rank: int = DEFAULT_POOL_EXIT_RANK,
) -> UniverseRanking:
    """The cheap half of Step 2: the quarterly pool cut on a `UniverseBase`'s global ranks."""
    universe = base.universe
    frame = universe.frame
    column_to_base_symbol = universe.column_to_base_symbol
    missing_symbols = universe.missing_symbols
    stock_membership = universe.stock_membership
    full_frame = base.full_frame
    raw_full_frame = base.raw_full_frame
    weeks = base.weeks
    global_ranks = base.global_ranks

    pool_membership = _compute_pool_membership(
        global_ranks[list(frame.columns)],
        stock_membership,
        weeks,
        top_n=pool_top_n,
        exit_rank=pool_exit_rank,
    )
    if universe.liquidity_gate is not None:
        # The pool is only re-decided quarterly; re-gate it every week so a held name that
        # turns illiquid (or gets pinned at a circuit) stops being eligible immediately.
        pool_membership = pool_membership & universe.liquidity_gate.reindex_like(
            pool_membership
        ).fillna(False)

    # Nor may a series that has ended (the pre-demerger half of a split series, a delisted
    # stock) stay in the pool until the next quarter: its price is only carried forward, so a
    # buy would fill at a frozen price nobody could trade at.
    for column, last_real_week in universe.stale_columns.items():
        if column in pool_membership.columns:
            pool_membership.loc[pool_membership.index > last_real_week, column] = False

    stock_pool_ranks = _dense_rank(global_ranks[list(frame.columns)].where(pool_membership))

    combined_eligible = pd.DataFrame(False, index=weeks, columns=full_frame.columns)
    combined_eligible[list(frame.columns)] = pool_membership
    for name in ATOMIC_NAMES:
        combined_eligible[name] = full_frame[name].notna()
    combined_pool_ranks = _dense_rank(global_ranks.where(combined_eligible))

    return UniverseRanking(
        prices=full_frame,
        weeks=weeks,
        global_ranks=global_ranks,
        pool_membership=pool_membership,
        stock_pool_ranks=stock_pool_ranks,
        combined_pool_ranks=combined_pool_ranks,
        column_to_base_symbol=column_to_base_symbol,
        events=universe.events,
        stale_columns=universe.stale_columns,
        missing_symbols=missing_symbols,
        raw_prices=raw_full_frame,
        liquidity_gate=universe.liquidity_gate,
    )


def compute_universe_ranking(
    *,
    pool_top_n: int = DEFAULT_POOL_TOP_N,
    pool_exit_rank: int = DEFAULT_POOL_EXIT_RANK,
    **base_kwargs,
) -> UniverseRanking:
    """Step 2 end to end: `compute_universe_base` then `finish_universe_ranking`."""
    return finish_universe_ranking(
        compute_universe_base(**base_kwargs),
        pool_top_n=pool_top_n,
        pool_exit_rank=pool_exit_rank,
    )


# ---------------------------------------------------------------------------------------------
# Step 3 -- category (+ atomic) selection: pure ranking, no P&L.
# ---------------------------------------------------------------------------------------------


def score_categories(
    pool_ranks_row: pd.Series,
    group_members: dict[str, set[str]],
    atomic_names: tuple[str, ...],
    *,
    coverage_floor: float,
) -> dict[str, float]:
    """One week's score for every category/atomic. A category's score is the mean
    `pool_ranks_row` value among its members that are currently pool-qualifying (non-NaN),
    PROVIDED coverage (qualifying / total members) clears `coverage_floor` -- otherwise the
    category is absent from the returned dict entirely (ineligible that week, not a score of
    +infinity -- see `apply_hysteresis`, which only ever sees names actually present in the
    ranked list). A category with zero qualifying members is the extreme case of failing the
    floor, not a separately-coded rule. An atomic's "score" is simply its own `pool_ranks_row`
    value (it is a one-member category, already ranked on the same scale as every stock)."""
    scores: dict[str, float] = {}
    for cid, members in group_members.items():
        qualifying = [
            pool_ranks_row[m]
            for m in members
            if m in pool_ranks_row.index and pd.notna(pool_ranks_row[m])
        ]
        if not members:
            continue
        coverage = len(qualifying) / len(members)
        if coverage < coverage_floor or not qualifying:
            continue
        scores[cid] = sum(qualifying) / len(qualifying)
    for name in atomic_names:
        if name in pool_ranks_row.index and pd.notna(pool_ranks_row[name]):
            scores[name] = pool_ranks_row[name]
    return scores


_ORDER_CACHE_SIZE = 6
_order_cache: OrderedDict[tuple, tuple] = OrderedDict()


def ordered_categories_by_week(
    combined_pool_ranks: pd.DataFrame,
    group_members: dict[str, set[str]],
    atomic_names: tuple[str, ...],
    coverage_floor: float,
) -> list[list[str]]:
    """For every row of `combined_pool_ranks`, the categories/atomics `score_categories` would
    return, ordered best-first by (score, name) -- the exact input `apply_hysteresis` wants.

    Same numbers as calling `score_categories` week by week, computed once as array maths instead
    (the ranks are whole numbers, so the means are exact either way). It depends only on the
    ranking, the groups and `coverage_floor` -- not on top_n/exit_rank -- so a search that varies
    those reuses it: results are cached against the identity of the inputs."""
    key = (id(combined_pool_ranks), id(group_members), atomic_names, coverage_floor)
    hit = _order_cache.get(key)
    if hit is not None and hit[0] is combined_pool_ranks and hit[1] is group_members:
        _order_cache.move_to_end(key)
        return hit[2]

    columns = {name: i for i, name in enumerate(combined_pool_ranks.columns)}
    values = combined_pool_ranks.to_numpy(dtype=float)
    names: list[str] = []
    score_cols: list[np.ndarray] = []
    for cid, members in group_members.items():
        if not members:
            continue
        idx = [columns[m] for m in members if m in columns]
        if not idx:
            continue
        sub = values[:, idx]
        valid = ~np.isnan(sub)
        count = valid.sum(axis=1)
        total = np.where(valid, sub, 0.0).sum(axis=1)
        with np.errstate(invalid="ignore", divide="ignore"):
            mean = total / count
            covered = (count / len(members) >= coverage_floor) & (count > 0)
        names.append(cid)
        score_cols.append(np.where(covered, mean, np.nan))
    atomic_scores: dict[str, np.ndarray] = {}
    for name in atomic_names:
        if name in columns:
            atomic_scores[name] = values[:, columns[name]]
    for name, col in atomic_scores.items():
        if name in names:  # score_categories: an atomic overwrites a same-named category
            score_cols[names.index(name)] = col
        else:
            names.append(name)
            score_cols.append(col)

    out: list[list[str]] = []
    if names:
        matrix = np.column_stack(score_cols)
        name_order = np.argsort(np.argsort(np.array(names, dtype=object).astype(str)))
        for row in matrix:
            idx = np.flatnonzero(~np.isnan(row))
            order = np.lexsort((name_order[idx], row[idx]))
            out.append([names[i] for i in idx[order]])
    else:
        out = [[] for _ in range(len(combined_pool_ranks))]

    _order_cache[key] = (combined_pool_ranks, group_members, out)
    while len(_order_cache) > _ORDER_CACHE_SIZE:
        _order_cache.popitem(last=False)
    return out


_collapse_cache: OrderedDict[int, tuple] = OrderedDict()


def collapse_segments(ranks: pd.DataFrame, column_to_base: dict[str, str]) -> pd.DataFrame:
    """`ranks` with one column per SYMBOL: the best (lowest) rank among that symbol's price
    series segments (`SYM`, `SYM#2`, ...). Category tags name symbols, so scoring a category
    against the raw columns never saw a stock again after a real price break (a demerger) moved
    it to `SYM#2`. With no split segments the same object comes back, so a frame without them
    behaves exactly as before and `ordered_categories_by_week`'s identity cache still hits;
    the collapsed frame is cached against its source for the same reason."""
    bases = [column_to_base.get(c, c) for c in ranks.columns]
    if bases == list(ranks.columns):
        return ranks
    hit = _collapse_cache.get(id(ranks))
    if hit is not None and hit[0] is ranks:
        _collapse_cache.move_to_end(id(ranks))
        return hit[1]
    collapsed = ranks.T.groupby(bases, sort=False).min().T
    _collapse_cache[id(ranks)] = (ranks, collapsed)
    while len(_collapse_cache) > _ORDER_CACHE_SIZE:
        _collapse_cache.popitem(last=False)
    return collapsed


def segment_members(
    group_members: dict[str, set[str]], column_to_base: dict[str, str]
) -> dict[str, set[str]]:
    """`group_members` with every member symbol joined by its later price-series columns, so a
    category can pick `SYM#2` once that is the live column. Only one segment of a symbol has a
    rank in any week (the others have no price), so a symbol is still picked at most once.
    Returns `group_members` itself when no symbol has a second segment."""
    later: dict[str, set[str]] = {}
    for column, base in column_to_base.items():
        if column != base:
            later.setdefault(base, set()).add(column)
    if not later:
        return group_members
    return {
        cid: members.union(*(later[m] for m in members if m in later))
        for cid, members in group_members.items()
    }


def compute_category_selection(
    combined_pool_ranks: pd.DataFrame,
    group_members: dict[str, set[str]],
    weeks: list[pd.Timestamp],
    *,
    atomic_names: tuple[str, ...] = ATOMIC_NAMES,
    coverage_floor: float = DEFAULT_COVERAGE_FLOOR,
    top_n: int = DEFAULT_CATEGORY_TOP_N,
    exit_rank: int = DEFAULT_CATEGORY_EXIT_RANK,
) -> dict[pd.Timestamp, list[str]]:
    """Per-week held category/atomic set, ordered best-first, via `apply_hysteresis` run every
    week (not just at the pool's own quarterly refresh -- a category's score legitimately moves
    week to week as its qualifying members' own momentum ranks update, even on a week where pool
    MEMBERSHIP itself hasn't changed). A week where zero categories/atomics clear the coverage
    floor naturally returns `held=[]` for that week (falls back to cash) -- the same
    graceful-absence behaviour the engine already has, not a special-cased failure mode.

    Plain, unmodified selection -- no mass-exit trigger/response (TODO.md 3.9.20). See
    `compute_category_selection_mass_exit` below for that; this function is kept exactly as it
    was so every existing caller/test is unaffected."""
    held: list[str] = []
    out: dict[pd.Timestamp, list[str]] = {}
    for w in weeks:
        row = combined_pool_ranks.loc[w]
        scores = score_categories(row, group_members, atomic_names, coverage_floor=coverage_floor)
        ordered = sorted(scores.keys(), key=lambda n: (scores[n], n))
        held = apply_hysteresis(held, ordered, top_n, exit_rank)
        out[w] = list(held)
    return out


# ---------------------------------------------------------------------------------------------
# Mass-exit de-risking trigger (TODO.md 3.9.20) -- a synchronized-exit alternative to the
# rejected `momentum_sizing` (TODO.md 3.9.8's own rejection note: a rolling win/loss tally across
# many concurrently-held, idiosyncratically-exiting positions is a diluted, noisy signal). This
# reacts instead to a coherent, portfolio-wide event: more than half of what was held coming into
# a week dropping out in that SAME week's own ranking update. Two response variants share the
# same trigger-detection logic below (built once, reused by both, so an A/B comparison is against
# an identical underlying signal wherever the two variants haven't yet diverged in what they
# hold):
#   "throttle"     -- withhold a fraction of that week's fresh capital into cash. Acts entirely
#                     inside engine.py's `_run_buffer` capital-split step (see
#                     `Config.mass_exit_throttle`/`mass_exit_throttle_fraction` and
#                     `run_backtest`'s own `mass_exit_weeks` argument) -- this function only
#                     supplies the trigger weeks, unchanged held-set evolution otherwise.
#   "halve_top_n"  -- temporarily admit fewer FRESH categories/atomics on a triggered week
#                     (existing holdings are never force-sold; they still only leave via the
#                     unchanged `exit_rank` test). Needs no engine.py change at all -- it acts on
#                     this module's own category-admission step, before engine.py ever sees a
#                     rank table.
# ---------------------------------------------------------------------------------------------

DEFAULT_MASS_EXIT_THRESHOLD = 0.5
DEFAULT_MASS_EXIT_THROTTLE_FRACTION = 0.5

MassExitResponse = Literal["off", "throttle", "halve_top_n"]


@dataclass(frozen=True)
class CategorySelection:
    """`compute_category_selection_mass_exit`'s full output: the per-week held set (identical
    shape to plain `compute_category_selection`'s return) plus the mass-exit trigger weeks
    detected along the way."""

    held_by_week: dict[pd.Timestamp, list[str]]
    mass_exit_weeks: frozenset[pd.Timestamp]


def compute_category_selection_mass_exit(
    combined_pool_ranks: pd.DataFrame,
    group_members: dict[str, set[str]],
    weeks: list[pd.Timestamp],
    *,
    atomic_names: tuple[str, ...] = ATOMIC_NAMES,
    coverage_floor: float = DEFAULT_COVERAGE_FLOOR,
    top_n: int = DEFAULT_CATEGORY_TOP_N,
    exit_rank: int = DEFAULT_CATEGORY_EXIT_RANK,
    mass_exit_response: MassExitResponse = "off",
    mass_exit_threshold: float = DEFAULT_MASS_EXIT_THRESHOLD,
) -> CategorySelection:
    """`compute_category_selection`, extended with the TODO.md 3.9.20 mass-exit trigger.

    A week is flagged (added to the returned `mass_exit_weeks`) whenever MORE THAN
    `mass_exit_threshold` (default 50%, matching the brief's own ">half") of the categories/
    atomics held coming INTO that week (i.e. `held` as decided by the prior week's iteration --
    the denominator is what was actually held then, never the target `top_n`, per the brief) have
    dropped below `exit_rank` in THIS week's own ranking. The exit test uses `exit_rank` ONLY,
    never `top_n`/`effective_top_n` below -- whether a previously-held name survives is governed
    purely by staying inside the buffer (`apply_hysteresis`'s own survival condition), regardless
    of how many *new* names get admitted this week. That means trigger detection never depends on
    which response is chosen: the same weeks fire with `mass_exit_response="off"` too (this
    function always computes and returns `mass_exit_weeks`, whether or not anything acts on it) --
    "off" and "throttle" therefore always see IDENTICAL trigger weeks and an identical held-set
    evolution (throttle only changes how much cash is deployed, never who's admitted), a clean
    apples-to-apples baseline-vs-throttle comparison. "halve_top_n" can only diverge from that
    point forward on the first week its own admission is actually reduced (fewer names entering
    changes what the FOLLOWING week's `prev_held` is) -- a real, expected difference between the
    two response variants' own paths, not a bug.

    `mass_exit_response="halve_top_n"` reacts to a week's OWN trigger causally, not with
    lookahead: only the top `ceil(top_n / 2)` ranked categories/atomics may freshly enter `held`
    THAT SAME week (never a future one) -- the halving uses only prices/ranks already known as of
    this week's own close, the same same-week signal `_run_buffer`'s own exit/sell step uses.
    Existing holdings are unaffected by the halving; they still only leave via the exit_rank test
    above, never forced out early by a tightened top_n.
    """
    if not 0 < mass_exit_threshold < 1:
        raise ValueError("mass_exit_threshold must be between 0 and 1")
    if mass_exit_response not in ("off", "throttle", "halve_top_n"):
        raise ValueError(f"unknown mass_exit_response {mass_exit_response!r}")

    held: list[str] = []
    out: dict[pd.Timestamp, list[str]] = {}
    mass_exit_weeks: set[pd.Timestamp] = set()
    all_ordered = ordered_categories_by_week(
        combined_pool_ranks, group_members, atomic_names, coverage_floor
    )
    for w in weeks:
        ordered = all_ordered[combined_pool_ranks.index.get_loc(w)]
        rank_of = {name: i + 1 for i, name in enumerate(ordered)}

        prev_held = set(held)
        triggered = False
        if prev_held:
            exited = {n for n in prev_held if rank_of.get(n, float("inf")) > exit_rank}
            triggered = len(exited) / len(prev_held) > mass_exit_threshold
        if triggered:
            mass_exit_weeks.add(w)

        effective_top_n = top_n
        if mass_exit_response == "halve_top_n" and triggered:
            effective_top_n = max(1, (top_n + 1) // 2)  # ceil(top_n / 2), floored at 1

        held = apply_hysteresis(held, ordered, effective_top_n, exit_rank)
        out[w] = list(held)
    return CategorySelection(held_by_week=out, mass_exit_weeks=frozenset(mass_exit_weeks))


# ---------------------------------------------------------------------------------------------
# Step 4 -- derived per-stock rank table (ON mode) + the OFF-mode direct pool rank passthrough.
# ---------------------------------------------------------------------------------------------


@dataclass(frozen=True)
class EffectiveRanks:
    ranks: pd.DataFrame
    scores: pd.DataFrame
    top_n: int  # the EFFECTIVE engine.Config.top_n this rank table was built for
    exit_rank: int  # the EFFECTIVE engine.Config.exit_rank this rank table was built for
    # week x column: the category (or atomic) each ranked stock was picked through - what
    # `engine.Config.max_group` caps against. None for category_mode="off" (no category layer).
    groups: pd.DataFrame | None = None


def category_picks(
    cid: str,
    row: pd.Series,
    group_members: dict[str, set[str]],
    atomic_names: tuple[str, ...],
    picks_per_category: int,
) -> list[str]:
    """The up-to-`picks_per_category` stocks `cid` contributes this week, given one week's
    `combined_pool_ranks` row: an atomic contributes only itself (1 pick, never
    `picks_per_category`, if it currently has a valid rank); a real category contributes its
    top-`picks_per_category` members BY THIS SAME ROW's rank (ties broken by name) among those
    that currently have a valid rank at all. Shared by `build_effective_stock_ranks` (the engine-
    facing rank table) and `api.py`'s "currently held" display -- both need the identical pick
    logic, computed once here."""
    if cid in atomic_names:
        return [cid] if cid in row.index and pd.notna(row[cid]) else []
    members = group_members.get(cid, set())
    candidates = [(m, row[m]) for m in members if m in row.index and pd.notna(row[m])]
    candidates.sort(key=lambda t: (t[1], t[0]))
    return [m for m, _ in candidates[:picks_per_category]]


def build_effective_stock_ranks(
    held_by_week: dict[pd.Timestamp, list[str]],
    combined_pool_ranks: pd.DataFrame,
    group_members: dict[str, set[str]],
    weeks: list[pd.Timestamp],
    columns: list[str],
    *,
    atomic_names: tuple[str, ...] = ATOMIC_NAMES,
    category_top_n: int = DEFAULT_CATEGORY_TOP_N,
    category_exit_rank: int = DEFAULT_CATEGORY_EXIT_RANK,
    picks_per_category: int = DEFAULT_PICKS_PER_CATEGORY,
) -> EffectiveRanks:
    """Turns Step 3's per-week held-category list into a per-week, per-STOCK rank table that
    reproduces the intended weighting through `engine.run_backtest`'s existing, unmodified
    top_n/exit_rank buffer mechanics -- see this module's own docstring for the exact bucket
    math. `category_position` (1-indexed, from `held_by_week`'s own best-first order) decides
    the bucket: positions `1..category_top_n` are FRESH (their up-to-`picks_per_category` picks
    land in ranks `[1, category_top_n * picks_per_category]`); positions
    `category_top_n+1..category_exit_rank` are LINGERING (ranks in
    `(category_top_n * picks_per_category, category_exit_rank * picks_per_category]`). The
    per-category-position rank block is reserved (`base + (bucket_pos-1)*picks_per_category +
    slot`) regardless of how many picks that category/atomic actually contributes this week (an
    atomic only ever fills 1 of its up-to-`picks_per_category` reserved slots) -- so the FRESH/
    LINGERING boundary always falls exactly at `category_top_n * picks_per_category`, never
    drifting with how many real picks happened to exist that week. The returned `top_n`/
    `exit_rank` are exactly the two boundary numbers the caller must set on `engine.Config` for
    this to work as intended."""
    ranks = pd.DataFrame(index=weeks, columns=columns, dtype=float)
    groups = pd.DataFrame(index=weeks, columns=columns, dtype=object)
    top_n = category_top_n * picks_per_category
    exit_rank = category_exit_rank * picks_per_category

    for w in weeks:
        held = held_by_week.get(w, [])
        row = combined_pool_ranks.loc[w]
        for position, cid in enumerate(held, start=1):
            if position > category_exit_rank:
                break
            picks = category_picks(cid, row, group_members, atomic_names, picks_per_category)

            base = 0 if position <= category_top_n else top_n
            bucket_pos = position if position <= category_top_n else position - category_top_n
            for slot, name in enumerate(picks, start=1):
                if name not in ranks.columns:
                    continue
                # A stock tagged to two held categories keeps the rank (and group) from the
                # better-placed one. `held` is best-first, so that is whichever wrote it first;
                # overwriting it here used to hand a top pick a lingering, unbuyable rank.
                if pd.notna(ranks.at[w, name]):
                    continue
                ranks.at[w, name] = base + (bucket_pos - 1) * picks_per_category + slot
                groups.at[w, name] = cid

    scores = -ranks  # informational only (analysis.py's "next actions" panel) -- see engine.py
    return EffectiveRanks(
        ranks=ranks, scores=scores, top_n=top_n, exit_rank=exit_rank, groups=groups
    )


def build_off_mode_ranks(
    stock_pool_ranks: pd.DataFrame, top_n: int, exit_rank: int
) -> EffectiveRanks:
    """Category mode OFF: `stock_pool_ranks` (Step 2's own pool-restricted dense rank, no
    category detour) IS already engine-ready -- just pass it straight through as
    `external_ranks`, with its own independent top_n/exit_rank ("SL"). No new computation."""
    return EffectiveRanks(
        ranks=stock_pool_ranks, scores=-stock_pool_ranks, top_n=top_n, exit_rank=exit_rank
    )


def price_ceiling_mask(
    prices: pd.DataFrame,
    max_stock_price: float | None,
    atomic_names: tuple[str, ...] = ATOMIC_NAMES,
) -> pd.DataFrame | None:
    """week x column booleans, True where a STOCK is priced above `max_stock_price` that week.
    None when no ceiling is set (`None` or <= 0), so callers can skip the whole step.

    These are the raw traded closes (`categories/prices.py` builds each column from unadjusted
    bhavcopy closes, splitting the series at every corporate action), so the comparison is
    against what one share actually cost at the time - the affordability question the ceiling
    exists to answer. Gold/Silver/Nasdaq 100/Hang Seng are exempt: they're index-level
    instruments, not shares you buy one of, so their level says nothing about affordability."""
    if max_stock_price is None or max_stock_price <= 0:
        return None
    stock_cols = [c for c in prices.columns if c not in atomic_names]
    over = pd.DataFrame(False, index=prices.index, columns=prices.columns)
    over[stock_cols] = prices[stock_cols] > max_stock_price
    return over


# ---------------------------------------------------------------------------------------------
# End-to-end orchestration -- Steps 2-4 (ON) or Steps 2+OFF (skip 3-4), wired the way
# `api.py`'s `_stock_backtest`/`_custom_index_backtest` are: one function both the CLI and the
# API layer call, so the two never drift.
# ---------------------------------------------------------------------------------------------


@dataclass(frozen=True)
class BroadBacktestResult:
    result: Result
    ranking: UniverseRanking
    held_by_week: dict[pd.Timestamp, list[str]] | None  # None for category_mode="off"
    effective: EffectiveRanks
    # TODO.md 3.9.20. None for category_mode="off" (no category layer, no trigger concept) or
    # when mass_exit_response was left at "off" and no computation happened to produce it --
    # always populated whenever `category_mode="on"`, regardless of the chosen response, so a
    # caller can inspect the raw trigger even with the response off.
    mass_exit_weeks: frozenset[pd.Timestamp] | None = None


def _tax_classes(columns: list[str]) -> dict[str, str]:
    """Tax class per column of a Broad frame: stocks are listed equity; Gold/Silver and the two
    international indices are what tax.py assumes for them; idle cash is taxed like debt."""
    classes = dict.fromkeys(columns, tax_mod.EQUITY)
    classes["Gold"] = classes["Silver"] = tax_mod.GOLD_SILVER
    classes["Nasdaq 100"] = classes["Hang Seng"] = tax_mod.INTERNATIONAL
    classes[CASH] = tax_mod.DEBT
    return classes


def run_broad_backtest(
    *,
    outer_prices: pd.DataFrame,
    stocks_data_dir: Path,
    categories_data_dir: Path,
    curated_dir: Path,
    category_mode: Literal["on", "off"] = "on",
    category_tags: Literal["curated", "extended"] = "curated",
    start: str = "2017-01-01",
    end: str | None = None,
    lookbacks: tuple[int, ...] = (1, 4, 13, 26, 52),
    weights: tuple[float, ...] | None = None,
    score: Literal["ranksum", "voladj", "blend"] = "ranksum",
    voladj_skip_recent_month: bool = True,
    pool_top_n: int = DEFAULT_POOL_TOP_N,
    pool_exit_rank: int = DEFAULT_POOL_EXIT_RANK,
    coverage_floor: float = DEFAULT_COVERAGE_FLOOR,
    category_top_n: int = DEFAULT_CATEGORY_TOP_N,
    category_exit_rank: int = DEFAULT_CATEGORY_EXIT_RANK,
    picks_per_category: int = DEFAULT_PICKS_PER_CATEGORY,
    off_top_n: int = 10,
    off_exit_rank: int = 20,
    cost_pct: float = 0.10,
    signal_delay: int = 0,
    portfolio: Literal["buffer", "slots"] = "buffer",
    rebalance: Literal["weekly", "monthly"] = "weekly",
    rebalance_every: int = 1,
    rebalance_offset: int = 0,
    sell_every_week: bool = False,
    benchmark: str = engine.BENCHMARK,
    max_position: float | None = 0.35,
    max_category: float | None = None,
    max_stock_price: float | None = None,
    cap_band: float = 0.05,
    entry: Literal["wait", "make_room"] = "wait",
    momentum_sizing: bool = False,
    momentum_sizing_window: int = 10,
    momentum_sizing_floor: float = 0.0,
    cost_model: Literal["flat", "itemised"] = "flat",
    capital: float = 1_000_000.0,
    slippage_bps: float = 5.0,
    mass_exit_response: MassExitResponse = "off",
    mass_exit_threshold: float = DEFAULT_MASS_EXIT_THRESHOLD,
    mass_exit_throttle_fraction: float = DEFAULT_MASS_EXIT_THROTTLE_FRACTION,
    ranking: UniverseRanking | None = None,
    extra_no_buy: pd.DataFrame | None = None,
    min_ranked: int = 0,
    # TODO 3.9.23 owner follow-up: re-order the stocks category/pool selection ALREADY picked
    # (held categories in "on" mode, the pool in "off" mode - selection itself is untouched) by
    # grouped_momentum_ranks's short-vs-long-lookback blend instead of plain momentum. 0 (off) is
    # byte-identical to today. See that function's own docstring for the mechanism.
    stock_tilt: float = 0.0,
    stock_tilt_screen_pct: float = 0.0,
    # A caller (api.py) that already has the rank table cached (grouped_momentum_ranks is not
    # free - two compute_ranks passes over ~755 names) passes it here directly; stock_tilt/
    # stock_tilt_screen_pct are then used only to decide WHETHER to apply it, not recomputed.
    # Script/CLI callers that don't bother caching just set stock_tilt > 0 and leave this None.
    stock_tilt_ranks: tuple[pd.DataFrame, pd.DataFrame] | None = None,
    # Circuit-lock realism (categories/circuit_exposure.py::lock_masks): None = ignore locks, as
    # every earlier run did. uc_locked blocks buying that week, lc_locked blocks selling.
    uc_locked: pd.DataFrame | None = None,
    lc_locked: pd.DataFrame | None = None,
    # Capital-gains tax per sale (tax.py). None = pre-tax, exactly as before. Every stock is
    # taxed as listed equity; the atomics by what they are (see `_tax_classes`).
    tax: tax_mod.TaxRules | None = None,
) -> BroadBacktestResult:
    """Step 2 (if `ranking` isn't already supplied -- e.g. by a caller's own cache, see
    `api.py`'s `get_categories_universe` for the equivalent Custom Index pattern) plus either
    Steps 3-4 (`category_mode="on"`, the default) or the OFF-mode direct pool rank passthrough,
    then one real, unmodified `engine.run_backtest` call -- real prices, real buy/sell/trim, real
    costs throughout, exactly like every other dataset in this package.

    `signal_delay`/`momentum_sizing`*/`cost_model`/`capital`/`slippage_bps` (TODO.md 3.9.15):
    these apply inside `engine.run_backtest`'s shared buffer/slots simulation regardless of
    where the per-week rank table came from (`external_ranks` bypasses only `compute_ranks`
    itself -- see that parameter's own docstring in engine.py), so they were genuine gaps, not
    dataset-specific exclusions: the UI already sent `signal_delay` for every dataset including
    this one, but `_broad_backtest` silently dropped it before this fix. `defensive`/
    `filter_lookback` deliberately stay out (not added here): CASH never enters this
    dataset's `external_ranks` table (Steps 1-4 only ever rank stocks/atomics against each
    other), so `defensive="ranked"` would silently do nothing. `tax` IS supported (added for the
    Round-4 validation): pass a `tax.TaxRules` and every sale is taxed by `_tax_classes`; None
    (the default) is pre-tax, byte-identical to before. The API does not expose it yet.

    `max_position` caps ONE stock's share of the portfolio; `max_category` caps everything held
    through ONE category (its up-to-`picks_per_category` stocks together) - category mode ON
    only, since OFF has no categories. Both are the buffer rule's usual trim-past-cap-plus-band
    mechanic (`engine.Config.max_position`/`max_group`). Sensible values keep
    `max_position * category_top_n * picks_per_category >= 1` and
    `max_category * category_top_n >= 1`, or the caps hold cash back by design.

    `max_stock_price` (rupees per share; None or 0 = off): an ENTRY-only affordability rule. A
    stock priced above it that week cannot be newly bought (`engine.run_backtest(no_buy=...)`);
    the freed slot goes to the next-best-ranked buyable name. A stock already held is never sold
    for crossing it and may be topped up, so it is held through until its rank says sell. Atomics
    are exempt (see `price_ceiling_mask`).

    `mass_exit_response`/`mass_exit_threshold`/`mass_exit_throttle_fraction` (TODO.md 3.9.20):
    `category_mode="on"` only -- raises ValueError if combined with `category_mode="off"`, since
    the trigger is inherently a category-layer concept (see
    `compute_category_selection_mass_exit`'s own docstring). "throttle" threads the detected
    `mass_exit_weeks` into `engine.run_backtest`; "halve_top_n" needs no engine.py involvement at
    all, it only changes which categories this function's own
    `compute_category_selection_mass_exit` call admits.
    """
    if category_mode == "off" and mass_exit_response != "off":
        raise ValueError("mass_exit_response needs category_mode='on'")
    if category_mode == "off" and max_category is not None:
        raise ValueError("max_category needs category_mode='on' (there are no categories in off)")
    if ranking is None:
        ranking = compute_universe_ranking(
            outer_prices=outer_prices,
            stocks_data_dir=stocks_data_dir,
            categories_data_dir=categories_data_dir,
            lookbacks=lookbacks,
            weights=weights,
            score=score,
            voladj_skip_recent_month=voladj_skip_recent_month,
            pool_top_n=pool_top_n,
            pool_exit_rank=pool_exit_rank,
        )

    over_ceiling = price_ceiling_mask(
        ranking.raw_prices if ranking.raw_prices is not None else ranking.prices,
        max_stock_price,
    )
    if extra_no_buy is not None:
        # Research gates (levers.py, TODO 3.9.23): OR-ed with the price ceiling, same entry-only
        # semantics - they block new buys, never force a sale.
        extra = extra_no_buy.reindex(index=ranking.prices.index, columns=ranking.prices.columns)
        extra = extra.fillna(False).astype(bool)
        over_ceiling = extra if over_ceiling is None else (over_ceiling.astype(bool) | extra)

    # Value held positions through gaps in a stock's price history (a suspension, or a move out of
    # the EQ series into trade-for-trade, leaves months with no EQ bars). Without this a held
    # stock's NaN price makes the whole equity curve NaN from that week on. Only valuation sees the
    # filled prices; the rankings were built from the unfilled frame, so a stock in a gap has no
    # rank and cannot be bought. A curve that was already finite is unchanged by this.
    prices = ranking.prices.ffill()
    prices[CASH] = outer_prices.reindex(prices.index)[CASH]
    prices[benchmark] = outer_prices.reindex(prices.index)[benchmark]

    held_by_week: dict[pd.Timestamp, list[str]] | None = None
    mass_exit_weeks: frozenset[pd.Timestamp] | None = None
    if category_mode == "on":
        group_members = load_stock_groups(curated_dir, extended=category_tags == "extended")
        # Categories are scored per symbol and pick per price column: see collapse_segments.
        segments = ranking.column_to_base_symbol
        selection = compute_category_selection_mass_exit(
            collapse_segments(ranking.combined_pool_ranks, segments),
            group_members,
            ranking.weeks,
            coverage_floor=coverage_floor,
            top_n=category_top_n,
            exit_rank=category_exit_rank,
            mass_exit_response=mass_exit_response,
            mass_exit_threshold=mass_exit_threshold,
        )
        held_by_week = selection.held_by_week
        mass_exit_weeks = selection.mass_exit_weeks
        effective = build_effective_stock_ranks(
            held_by_week,
            ranking.combined_pool_ranks,
            segment_members(group_members, segments),
            ranking.weeks,
            columns=list(prices.columns),
            category_top_n=category_top_n,
            category_exit_rank=category_exit_rank,
            picks_per_category=picks_per_category,
        )
    else:
        effective = build_off_mode_ranks(
            ranking.stock_pool_ranks, top_n=off_top_n, exit_rank=off_exit_rank
        )

    ranks_full = effective.ranks.reindex(prices.index)
    scores_full = effective.scores.reindex(prices.index)
    if stock_tilt > 0:
        from ..levers import fresh_52w_low_mask, grouped_momentum_ranks, rerank

        if stock_tilt_ranks is not None:
            _, tilt_scores = stock_tilt_ranks
        else:
            _, tilt_scores = grouped_momentum_ranks(
                ranking.prices,
                Config(lookbacks=lookbacks),
                tilt=stock_tilt,
                screen_top_pct=stock_tilt_screen_pct,
            )
        eligible = effective.ranks.notna()
        masked = tilt_scores.reindex(index=eligible.index, columns=eligible.columns).where(eligible)
        ranks_full = rerank(-masked).reindex(prices.index)
        scores_full = masked.reindex(prices.index)
        low = fresh_52w_low_mask(ranking.prices).reindex(
            index=eligible.index, columns=eligible.columns, fill_value=False
        )
        over_ceiling = low if over_ceiling is None else (over_ceiling.astype(bool) | low)
    includes = {c: "core" for c in prices.columns}
    config = Config(
        lookbacks=lookbacks,
        weights=weights,
        score=score,
        voladj_skip_recent_month=voladj_skip_recent_month,
        top_n=effective.top_n,
        exit_rank=effective.exit_rank,
        cost_pct=cost_pct,
        signal_delay=signal_delay,
        start=start,
        end=end,
        universe=tuple(prices.columns),
        benchmark=benchmark,
        portfolio=portfolio,
        entry=entry,
        max_position=max_position,
        max_group=max_category,
        cap_band=cap_band,
        momentum_sizing=momentum_sizing,
        momentum_sizing_window=momentum_sizing_window,
        momentum_sizing_floor=momentum_sizing_floor,
        rebalance=rebalance,
        rebalance_every=rebalance_every,
        rebalance_offset=rebalance_offset,
        sell_every_week=sell_every_week,
        cost_model=cost_model,
        capital=capital,
        slippage_bps=slippage_bps,
        min_ranked=min_ranked,
        mass_exit_throttle=(mass_exit_response == "throttle"),
        mass_exit_throttle_fraction=mass_exit_throttle_fraction,
        tax=tax,
    )
    result = engine.run_backtest(
        prices,
        includes,
        config,
        external_ranks=(ranks_full, scores_full),
        mass_exit_weeks=mass_exit_weeks if mass_exit_response == "throttle" else None,
        groups=(
            effective.groups.reindex(prices.index)
            if max_category is not None and effective.groups is not None
            else None
        ),
        no_buy=over_ceiling.reindex(prices.index) if over_ceiling is not None else None,
        uc_locked=uc_locked,
        lc_locked=lc_locked,
        tax_classes=_tax_classes(list(prices.columns)) if tax is not None else None,
    )
    return BroadBacktestResult(
        result=result,
        ranking=ranking,
        held_by_week=held_by_week,
        effective=effective,
        mass_exit_weeks=mass_exit_weeks,
    )


def current_holdings_detail(
    outcome: BroadBacktestResult,
    group_members: dict[str, set[str]],
    *,
    category_top_n: int,
    picks_per_category: int,
    atomic_names: tuple[str, ...] = ATOMIC_NAMES,
) -> list[dict]:
    """Step 5's UI panel: what's held as of the backtest's own last week, distinguishing
    freshly-selected (position <= category_top_n) from lingering-in-the-buffer -- the display
    the plan's Step 5 asks for. `[]` for `category_mode="off"` (`outcome.held_by_week is None`,
    there is no category layer to show) or if nothing was ever held."""
    if not outcome.held_by_week:
        return []
    last_week = max(outcome.held_by_week)
    held = outcome.held_by_week[last_week]
    row = outcome.ranking.combined_pool_ranks.loc[last_week]
    group_members = segment_members(group_members, outcome.ranking.column_to_base_symbol)
    return [
        {
            "category": cid,
            "position": position,
            "status": "fresh" if position <= category_top_n else "lingering",
            "picks": category_picks(cid, row, group_members, atomic_names, picks_per_category),
        }
        for position, cid in enumerate(held, start=1)
    ]
