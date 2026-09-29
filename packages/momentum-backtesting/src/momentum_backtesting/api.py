"""Local web UI: `mbt ui` serves this on 127.0.0.1 only. Not meant to be exposed."""

import threading
import urllib.request
from collections import OrderedDict
from pathlib import Path
from typing import Literal

import pandas as pd
from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from . import analysis
from .categories import broad
from .categories import momentum_scores as momentum_scores_mod
from .categories.compose import (
    ATOMIC_INSTRUMENTS,
    DEFAULT_ATOMIC_COPIES,
    MAX_ATOMIC_COPIES,
    AllCategoriesResult,
    all_category_names,
    atomic_copy_names,
    build_all_categories_price_table,
)
from .categories.compose import (
    DEFAULT_EXIT_RANK as CATEGORY_DEFAULT_EXIT_RANK,
)
from .categories.compose import (
    DEFAULT_TOP_N as CATEGORY_DEFAULT_TOP_N,
)
from .config import DATA_DIR
from .engine import BENCHMARK, CASH, Config, Result, run_backtest
from .fetch import load_universe
from .stocks import ui_data
from .stocks.ui_data import (
    NIFTY50_EQUAL_WEIGHT_TRI,
    NIFTY50_TRI,
    NIFTY200_MOMENTUM30_TRI,
    StockDataset,
)
from .tax import TaxRules
from .trade_prices import build_trade_prices

#: Package's own committed curated/ dir (mirrors cli.py's `_categories_curated_dir`) -- the
#: manual category/symbol tag overlay (category_extras.csv) ships with the package, not data/.
CATEGORIES_CURATED_DIR = Path(__file__).parent / "categories" / "curated"

#: "Custom Index" dataset: label (AllCategoriesResult.labels' values) -> (rank-eligibility
#: tag, UI group name). "debt" (Cash/Gilt) is "defensive": only rankable when
#: config.defensive="ranked" (see _custom_index_meta's default and ATOMIC_INSTRUMENTS's own
#: docstring for why - mirrors stock mode's gold/silver/debt feature exactly). Everything else
#: (categories, Gold/Silver) is always-rankable "core". Shared by _custom_index_meta (sidebar
#: groups) and _custom_index_backtest (includes/groups for the real run) so the two can't drift.
_CATEGORY_LABEL_INFO = {
    "official": ("core", "Official (NSE)"),
    "custom": ("core", "Custom"),
    "commodity": ("core", "Commodity"),
    "debt": ("defensive", "Debt"),
    "international": ("core", "International"),
}

STATIC = Path(__file__).with_name("static")
PLOTLY_URL = "https://cdn.jsdelivr.net/npm/plotly.js-dist-min@2.35.2/plotly.min.js"


class _Data:
    """Weekly closes, reloaded when `mbt fetch` rewrites the file."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._mtime = None
        self.prices: pd.DataFrame | None = None
        self.rank_cache: OrderedDict = OrderedDict()
        self.fill_tables: dict = {}
        self._stock_mtime = None
        self.stock: StockDataset | None = None
        self.stock_rank_cache: OrderedDict = OrderedDict()
        # "Custom Index" tab: AllCategoriesResult is expensive to build (~60 real per-category
        # backtests, roughly a minute the first time - see categories/compose.py), so it's cached
        # per exact (inner_top_n, inner_exit_rank, lookbacks, cost_pct, start, end) combination,
        # invalidated wholesale when any of the three files it's built from changes on disk.
        self._categories_mtimes: tuple | None = None
        self.custom_index_cache: OrderedDict = OrderedDict()
        self.custom_index_rank_cache: OrderedDict = OrderedDict()
        # "Broad Momentum" tab: Step 2 (compute_universe_ranking) is the expensive part (~20s -
        # a 755-name price frame + a 1500+-column rank table, see categories/broad.py's own
        # docstring) and is INDEPENDENT of category_mode/top_n/exit_rank/coverage_floor/etc, so
        # it's cached separately from the full broad-backtest result, keyed only on what Step 2
        # itself takes as input.
        self._broad_mtimes: tuple | None = None
        self.broad_ranking_cache: OrderedDict = OrderedDict()
        # "Momentum Scores" page (TODO.md 3.9.16): the 755-name price frame + point-in-time
        # membership gate (categories/momentum_scores.py's shared Step 1 with Broad Momentum's
        # Step 2, `broad.load_stock_universe_frame`) - ~7s cold, same two watch paths as
        # `_broad_mtimes` above, but no lookbacks/score/pool params to key on (this page has no
        # user-configurable knobs at all), so a single cached value is enough - not an
        # OrderedDict keyed cache the way broad_ranking_cache needs to be.
        self._momentum_universe_mtimes: tuple | None = None
        self.momentum_universe_cache: broad.StockUniverseFrame | None = None

    def get(self) -> pd.DataFrame:
        path = DATA_DIR / "weekly_closes.csv"
        if not path.exists():
            raise HTTPException(409, "No data yet - run `mbt login` then `mbt fetch`.")
        with self._lock:
            mtime = path.stat().st_mtime
            if mtime != self._mtime:
                self.prices = pd.read_csv(path, index_col=0, parse_dates=True)
                self._mtime = mtime
                self.rank_cache.clear()
                self.fill_tables.clear()
            return self.prices

    def get_stock(self) -> StockDataset:
        """The Nifty 50 stock-momentum dataset (data/stocks/*.csv, built by `mbt stocks
        fetch`), reloaded when its files change - same mtime-check pattern as `get()`, watched
        on nifty50_weekly_tr.csv since that's the file every other stocks/ series is reindexed
        onto (see ui_data.load_stock_dataset)."""
        base = DATA_DIR / "stocks"
        path = base / "nifty50_weekly_tr.csv"
        if not path.exists():
            raise HTTPException(409, "No stock data yet - run `mbt stocks fetch`.")
        with self._lock:
            mtime = path.stat().st_mtime
            if mtime != self._stock_mtime:
                try:
                    self.stock = ui_data.load_stock_dataset(base)
                except ui_data.StockDataUnavailable as error:
                    raise HTTPException(409, str(error)) from None
                self._stock_mtime = mtime
                self.stock_rank_cache.clear()
            return self.stock

    def fills(self, track: str, execution: str):
        """Trade-price table for this track/execution (None = index at Friday close), built
        once per data refresh - it reads a few dozen daily CSVs."""
        prices = self.get()
        key = (track, execution)
        with self._lock:
            if key not in self.fill_tables:
                try:
                    self.fill_tables[key] = build_trade_prices(
                        prices, track, execution, data_dir=DATA_DIR
                    )
                except ValueError as error:
                    raise HTTPException(409, str(error)) from None
            return self.fill_tables[key]

    def trim_cache(self, limit: int = 24) -> None:
        for cache in (self.rank_cache, self.stock_rank_cache, self.custom_index_rank_cache):
            while len(cache) > limit:
                cache.popitem(last=False)

    def get_categories_universe(
        self,
        *,
        inner_top_n: int,
        inner_exit_rank: int,
        lookbacks: tuple[int, ...],
        cost_pct: float,
        start: str,
        end: str | None,
        commodity_copies: int,
        debt_copies: int,
    ) -> AllCategoriesResult:
        """AllCategoriesResult for this exact parameter combination. Building one is a real
        backtest per category (~60 of them - roughly a minute the first time, verified live
        2026-09-29), so it's cached; a request that only changes an OUTER-ranking parameter
        (top_n, exit_rank, universe selection, portfolio rule, benchmark, ...) reuses this
        unchanged. `commodity_copies`/`debt_copies` ARE part of the cache key (unlike outer
        top_n) because they change the table's own column set (see
        `build_all_categories_price_table`'s own docstring on `MAX_ATOMIC_COPIES` for why outer
        top_n deliberately isn't part of it, and why these two ARE). Whole cache is dropped (not
        just the touched key) if category_membership.csv, category_extras.csv, or daily.parquet
        have changed on disk since it was built - the same mtime-driven invalidation
        `.get()`/`.get_stock()` already use for their own files.

        `outer_prices = self.get()` is read before acquiring `self._lock` (never while holding
        it) - `.get()` takes the same lock internally, and `threading.Lock` isn't reentrant.
        """
        outer_prices = self.get()
        watch_paths = [
            DATA_DIR / "categories" / "category_membership.csv",
            DATA_DIR / "stocks" / "daily.parquet",
            CATEGORIES_CURATED_DIR / "category_extras.csv",
        ]
        mtimes = tuple(p.stat().st_mtime if p.exists() else None for p in watch_paths)
        key = (
            inner_top_n,
            inner_exit_rank,
            tuple(lookbacks),
            cost_pct,
            start,
            end or "",
            commodity_copies,
            debt_copies,
        )
        with self._lock:
            if mtimes != self._categories_mtimes:
                self.custom_index_cache.clear()
                self._categories_mtimes = mtimes
            cached = self.custom_index_cache.get(key)
        if cached is not None:
            return cached

        result = build_all_categories_price_table(
            top_n=inner_top_n,
            exit_rank=inner_exit_rank,
            start=start,
            end=end,
            lookbacks=lookbacks,
            commodity_copies=commodity_copies,
            debt_copies=debt_copies,
            cost_pct=cost_pct,
            outer_prices=outer_prices,
            data_dir=DATA_DIR / "categories",
            curated_dir=CATEGORIES_CURATED_DIR,
            stocks_data_dir=DATA_DIR / "stocks",
        )
        with self._lock:
            self.custom_index_cache[key] = result
            while len(self.custom_index_cache) > 4:
                self.custom_index_cache.popitem(last=False)
        return result

    def get_broad_ranking(
        self,
        *,
        lookbacks: tuple[int, ...],
        weights: tuple[float, ...] | None,
        score: str,
        voladj_skip_recent_month: bool,
        pool_top_n: int,
        pool_exit_rank: int,
    ) -> broad.UniverseRanking:
        """Step 2 (categories/broad.py) for this exact parameter combination - cached the same
        way get_categories_universe caches AllCategoriesResult (the expensive part is independent
        of category_mode/coverage_floor/category_top_n/etc, which only affect Steps 3-4, applied
        fresh on every request on top of this cached ranking). `weights` is part of the key (like
        `lookbacks`/`score`) since it's a Step-1 ranksum input (TODO.md 3.9.15) - not independent
        of this cached ranking the way the Step-3/4-only params are."""
        outer_prices = self.get()
        watch_paths = [
            DATA_DIR / "categories" / broad.TOTAL_MARKET_MEMBERSHIP_FILENAME,
            DATA_DIR / "stocks" / "daily.parquet",
        ]
        mtimes = tuple(p.stat().st_mtime if p.exists() else None for p in watch_paths)
        key = (
            tuple(lookbacks),
            tuple(weights) if weights else None,
            score,
            voladj_skip_recent_month,
            pool_top_n,
            pool_exit_rank,
        )
        with self._lock:
            if mtimes != self._broad_mtimes:
                self.broad_ranking_cache.clear()
                self._broad_mtimes = mtimes
            cached = self.broad_ranking_cache.get(key)
        if cached is not None:
            return cached

        ranking = broad.compute_universe_ranking(
            outer_prices=outer_prices,
            stocks_data_dir=DATA_DIR / "stocks",
            categories_data_dir=DATA_DIR / "categories",
            lookbacks=lookbacks,
            weights=weights,
            score=score,  # type: ignore[arg-type]
            voladj_skip_recent_month=voladj_skip_recent_month,
            pool_top_n=pool_top_n,
            pool_exit_rank=pool_exit_rank,
        )
        with self._lock:
            self.broad_ranking_cache[key] = ranking
            while len(self.broad_ranking_cache) > 4:
                self.broad_ranking_cache.popitem(last=False)
        return ranking

    def get_momentum_universe(self) -> broad.StockUniverseFrame:
        """`momentum_universe_cache`, rebuilt when either watch path changes - see that field's
        own comment in __init__. Computed OUTSIDE the lock (same reasoning as
        get_broad_ranking's own ranking build above): it's a ~7s rebuild on a cold cache/changed
        data, and holding the lock across it would stall every other request, including ones for
        a completely unrelated dataset."""
        watch_paths = [
            DATA_DIR / "categories" / broad.TOTAL_MARKET_MEMBERSHIP_FILENAME,
            DATA_DIR / "stocks" / "daily.parquet",
        ]
        mtimes = tuple(p.stat().st_mtime if p.exists() else None for p in watch_paths)
        with self._lock:
            fresh = mtimes == self._momentum_universe_mtimes
            if fresh and self.momentum_universe_cache is not None:
                return self.momentum_universe_cache

        universe = broad.load_stock_universe_frame(
            stocks_data_dir=DATA_DIR / "stocks",
            categories_data_dir=DATA_DIR / "categories",
        )
        with self._lock:
            self.momentum_universe_cache = universe
            self._momentum_universe_mtimes = mtimes
        return universe


DATA = _Data()


class BacktestRequest(BaseModel):
    dataset: Literal["etf", "stock", "custom_index", "broad"] = "etf"
    universe: list[str] = Field(min_length=1)
    start: str = "2017-01-01"
    end: str | None = None
    top_n: int = Field(5, ge=1, le=20)
    exit_rank: int = Field(10, ge=1, le=40)
    lookbacks: list[int] = Field([1, 4, 13, 26, 52], min_length=1)
    weights: list[float] | None = None
    defensive: Literal["off", "ranked", "filter"] = "off"
    filter_lookback: int = Field(13, ge=1, le=104)
    cost_pct: float = Field(0.10, ge=0, le=5)
    signal_delay: int = Field(0, ge=0, le=4)
    tax: bool = False
    slab_rate: float = Field(0.30, ge=0, le=0.5)
    benchmark: str = BENCHMARK
    portfolio: Literal["buffer", "slots"] = "buffer"
    entry: Literal["wait", "make_room"] = "wait"
    max_position: float | None = Field(0.35, gt=0, le=1)  # None = no cap
    cap_band: float = Field(0.05, ge=0, le=0.5)
    # Broad Momentum only (category mode ON for max_category). max_category caps everything held
    # through ONE category (its stocks together); max_stock_price skips stocks whose share price
    # is above it (rupees; None/0 = off). Both ignored by the other three datasets.
    max_category: float | None = Field(None, gt=0, le=1)
    max_stock_price: float | None = Field(None, ge=0)
    # Buffer rule only (engine.py Config.momentum_sizing): shrinks new/top-up buys after a
    # recent losing streak, ramps back to full size as it recovers. Opt-in try-it toggle, not a
    # new default (see TODO.md 3.9.8) - harmless (never read) for portfolio="slots".
    momentum_sizing: bool = False
    # momentum_sizing only - see engine.py Config.momentum_sizing_window/_floor's own docstrings.
    momentum_sizing_window: int = Field(10, ge=1, le=52)
    momentum_sizing_floor: float = Field(0.0, ge=0, le=1)
    track: Literal["index", "etf"] = "index"
    execution: Literal["fri_close", "mon_open", "mon_10am"] = "fri_close"
    # Stock-momentum additions (engine.py Config fields; harmless defaults for ETF requests).
    score: Literal["ranksum", "voladj", "blend"] = "ranksum"
    voladj_skip_recent_month: bool = True
    rebalance: Literal["weekly", "monthly"] = "weekly"
    cost_model: Literal["flat", "itemised"] = "flat"
    capital: float = Field(1_000_000.0, gt=0)
    slippage_bps: float = Field(5.0, ge=0)
    # dataset="custom_index" only: the INNER (per-category stock-picking) rotation's own
    # top_n/exit_rank - a separate axis from top_n/exit_rank above, which for this dataset is the
    # OUTER (category-vs-category) rotation. Defaults mirror categories/compose.py's own
    # DEFAULT_TOP_N/DEFAULT_EXIT_RANK. Harmlessly ignored for dataset="etf"/"stock".
    inner_top_n: int = Field(CATEGORY_DEFAULT_TOP_N, ge=1, le=10)
    inner_exit_rank: int = Field(CATEGORY_DEFAULT_EXIT_RANK, ge=1, le=40)
    # dataset="custom_index" only: how many duplicate ranked slots Gold/Silver ("commodity")
    # and Cash/Gilt ("debt") may each occupy at once - see categories/compose.py's
    # atomic_copy_names. Default 1 = ordinary single-instrument behaviour (requested after
    # trying the mechanism with the prior fixed default of MAX_ATOMIC_COPIES); raise either to
    # let that asset class win more than one slot when its own momentum is strong. Harmlessly
    # ignored for dataset="etf"/"stock".
    commodity_copies: int = Field(1, ge=1, le=MAX_ATOMIC_COPIES)
    debt_copies: int = Field(1, ge=1, le=MAX_ATOMIC_COPIES)
    # dataset="broad" only (TODO.md 3.9.13) - top_n/exit_rank above are IGNORED for this
    # dataset; the effective engine top_n/exit_rank are always derived (see
    # categories/broad.py's build_effective_stock_ranks/build_off_mode_ranks).
    #
    # "Category mode" toggle, on the same tab (added mid-implementation per explicit user
    # request - see the plan's Step 5 section): "on" runs the full category-funnel (Steps 3-4,
    # the default); "off" skips it and ranks individual stocks directly off Step 2's own
    # pool-restricted rank, with its own independent top_n/exit_rank ("SL",
    # broad_off_top_n/broad_off_exit_rank below) - never conflated with the ON-mode category
    # top_n/exit_rank fields.
    broad_category_mode: Literal["on", "off"] = "on"
    # Step 2: the quarterly-refreshed qualifying-pool hysteresis (shared by both modes).
    broad_pool_top_n: int = Field(broad.DEFAULT_POOL_TOP_N, ge=10, le=500)
    broad_pool_exit_rank: int = Field(broad.DEFAULT_POOL_EXIT_RANK, ge=10, le=700)
    # Step 3 (ON mode only): coverage floor + category-level hysteresis + picks per category.
    broad_coverage_floor: float = Field(broad.DEFAULT_COVERAGE_FLOOR, ge=0, le=1)
    broad_category_top_n: int = Field(broad.DEFAULT_CATEGORY_TOP_N, ge=1, le=20)
    broad_category_exit_rank: int = Field(broad.DEFAULT_CATEGORY_EXIT_RANK, ge=1, le=40)
    broad_picks_per_category: int = Field(broad.DEFAULT_PICKS_PER_CATEGORY, ge=1, le=5)
    # OFF mode only: the direct individual-stock top_n/exit_rank ("SL").
    broad_off_top_n: int = Field(10, ge=1, le=50)
    broad_off_exit_rank: int = Field(20, ge=1, le=100)


def _stock_classification(stock: StockDataset) -> dict[str, tuple[str, str]]:
    """company_id -> (include, group): 'core'/'Current member' if it's a Nifty 50 constituent as
    of the latest membership week, else 'optional'/'Former member' - reuses the ETF universe's
    core/optional include semantics (ranked_universe treats anything but 'defensive' as
    rankable) so the existing "top N must fit the ranked count" check works unmodified. Shared
    by /api/meta and /api/backtest so the two endpoints can never disagree on who counts as a
    current member."""
    last_week = stock.membership.index[-1]
    classification: dict[str, tuple[str, str]] = {}
    for company_id in stock.companies:
        is_member = (
            bool(stock.membership.at[last_week, company_id])
            if company_id in stock.membership.columns
            else False
        )
        classification[company_id] = (
            ("core", "Current member") if is_member else ("optional", "Former member")
        )
    return classification


def _config_kwargs(req: BacktestRequest) -> dict:
    """Config fields shared by the ETF and stock-momentum backtest paths. track/execution are
    deliberately left out here - the ETF path adds them on top, the stock path never does, so
    Config.needs_trade_prices always stays False for a stock backtest and trade_prices is never
    required (stock mode has no ETF-vs-index track/fill-time concept)."""
    return dict(
        lookbacks=tuple(req.lookbacks),
        weights=tuple(req.weights) if req.weights else None,
        top_n=req.top_n,
        exit_rank=req.exit_rank,
        cost_pct=req.cost_pct,
        defensive=req.defensive,
        filter_lookback=req.filter_lookback,
        start=req.start,
        end=req.end or None,
        signal_delay=req.signal_delay,
        tax=TaxRules(slab_rate=req.slab_rate) if req.tax else None,
        universe=tuple(req.universe),
        benchmark=req.benchmark,
        portfolio=req.portfolio,
        entry=req.entry,
        max_position=req.max_position,
        cap_band=req.cap_band,
        momentum_sizing=req.momentum_sizing,
        momentum_sizing_window=req.momentum_sizing_window,
        momentum_sizing_floor=req.momentum_sizing_floor,
        score=req.score,
        voladj_skip_recent_month=req.voladj_skip_recent_month,
        rebalance=req.rebalance,
        cost_model=req.cost_model,
        capital=req.capital,
        slippage_bps=req.slippage_bps,
    )


def _etf_meta() -> dict:
    prices = DATA.get()
    instruments = []
    for inst in load_universe():
        series = prices[inst.name].dropna() if inst.name in prices else pd.Series(dtype=float)
        instruments.append(
            {
                "name": inst.name,
                "group": inst.group,
                "include": inst.include,
                "trade_etf": inst.trade_etf,
                "tax_class": inst.tax_class,
                "note": inst.note,
                "first_week": series.index[0].strftime("%Y-%m-%d") if len(series) else None,
                "has_data": bool(len(series)),
            }
        )
    turnover = {}
    from .config import UNIVERSE_CSV

    for row in pd.read_csv(UNIVERSE_CSV).itertuples():
        turnover[row.index] = row.etf_turnover_cr_day
    for inst in instruments:
        value = turnover.get(inst["name"])
        inst["etf_turnover_cr_day"] = None if pd.isna(value) else float(value)
    defaults = Config()
    return {
        "instruments": instruments,
        "first_week": prices.index[0].strftime("%Y-%m-%d"),
        "last_week": prices.index[-1].strftime("%Y-%m-%d"),
        "cash": CASH,
        "defaults": {
            "top_n": defaults.top_n,
            "exit_rank": defaults.exit_rank,
            "lookbacks": list(defaults.lookbacks),
            "defensive": defaults.defensive,
            "filter_lookback": defaults.filter_lookback,
            "cost_pct": defaults.cost_pct,
            "signal_delay": defaults.signal_delay,
            "start": defaults.start,
            "benchmark": defaults.benchmark,
            "portfolio": defaults.portfolio,
            "entry": defaults.entry,
            "max_position": defaults.max_position,
            "cap_band": defaults.cap_band,
            # The UI opens on what you'd actually trade; the engine default stays "index".
            "track": "etf",
            "execution": defaults.execution,
            "score": defaults.score,
            "voladj_skip_recent_month": defaults.voladj_skip_recent_month,
            "rebalance": defaults.rebalance,
            "cost_model": defaults.cost_model,
            "capital": defaults.capital,
            "slippage_bps": defaults.slippage_bps,
        },
    }


def _stock_meta() -> dict:
    stock = DATA.get_stock()
    classification = _stock_classification(stock)
    instruments = []
    for company_id, name in stock.companies.items():
        include, group = classification[company_id]
        instruments.append(
            {
                "name": company_id,
                "display_name": name,
                "group": group,
                "include": include,
                "trade_etf": "",
                "tax_class": "equity",
                "note": "",
                "first_week": None,
                "has_data": True,
                "etf_turnover_cr_day": None,
            }
        )
    # Gold/Silver/Cash (liquid fund)/Gilt 8-13 yr (see ui_data.StockDataset.extra_instruments) -
    # these use their own real name as `name` directly (no company_id-style code), so there is no
    # separate display_name to translate from; the frontend already falls back to `name` when
    # `display_name` is falsy (see static/app.js's displayName()/buildUniverse()).
    for extra_name, extra in stock.extra_instruments.items():
        instruments.append(
            {
                "name": extra_name,
                "display_name": None,
                "group": extra["group"],
                "include": extra["tag"],
                "trade_etf": "",
                "tax_class": stock.tax_classes.get(extra_name, ""),
                "note": "",
                "first_week": None,
                "has_data": True,
                "etf_turnover_cr_day": None,
            }
        )
    instruments.sort(key=lambda i: i["display_name"] or i["name"])
    # Stock-momentum defaults: a bigger, itemised-cost portfolio over a longer history than the
    # ETF defaults - see the task brief this endpoint was built against for the exact values.
    defaults = Config(
        top_n=10,
        exit_rank=20,
        start="2012-01-01",
        cost_model="itemised",
        capital=1_000_000.0,
        slippage_bps=5.0,
        score="ranksum",
        rebalance="weekly",
        benchmark=NIFTY50_TRI,
        # "ranked": Gold/Silver/Cash/Gilt compete in the same rank table as the 95 stocks out of
        # the box, rather than requiring the user to discover the "Debt in ranking" toggle (the
        # ETF dataset's own default stays "off" - see _etf_meta, unchanged).
        defensive="ranked",
        filter_lookback=13,
        signal_delay=0,
        portfolio="buffer",
        entry="wait",
        max_position=0.35,
        cap_band=0.05,
    )
    return {
        "instruments": instruments,
        "first_week": stock.prices.index[0].strftime("%Y-%m-%d"),
        "last_week": stock.last_week.strftime("%Y-%m-%d"),
        "cash": CASH,
        # TRI/benchmark columns aren't companies, so they never appear in `instruments` - the
        # frontend's benchmark <select> needs this explicit list for stock mode.
        "benchmarks": [NIFTY50_TRI, NIFTY200_MOMENTUM30_TRI, NIFTY50_EQUAL_WEIGHT_TRI],
        "defaults": {
            "top_n": defaults.top_n,
            "exit_rank": defaults.exit_rank,
            "lookbacks": list(defaults.lookbacks),
            "defensive": defaults.defensive,
            "filter_lookback": defaults.filter_lookback,
            "cost_pct": defaults.cost_pct,
            "signal_delay": defaults.signal_delay,
            "start": defaults.start,
            "benchmark": defaults.benchmark,
            "portfolio": defaults.portfolio,
            "entry": defaults.entry,
            "max_position": defaults.max_position,
            "cap_band": defaults.cap_band,
            # Reported for response-shape parity with the ETF defaults, but unused: stock
            # backtests never pass track/execution to Config (see _config_kwargs).
            "track": "index",
            "execution": defaults.execution,
            "score": defaults.score,
            "voladj_skip_recent_month": defaults.voladj_skip_recent_month,
            "rebalance": defaults.rebalance,
            "cost_model": defaults.cost_model,
            "capital": defaults.capital,
            "slippage_bps": defaults.slippage_bps,
        },
    }


def _etf_backtest(req: BacktestRequest) -> dict:
    prices = DATA.get()
    universe = {inst.name: inst for inst in load_universe()}
    includes = {name: inst.include for name, inst in universe.items()}
    if req.weights is not None and len(req.weights) != len(req.lookbacks):
        raise HTTPException(422, "Give one weight per lookback.")
    if req.benchmark not in prices:
        raise HTTPException(422, f"No price history for benchmark {req.benchmark!r}.")
    try:
        config = Config(**_config_kwargs(req), track=req.track, execution=req.execution)
        ranked = [n for n in req.universe if includes.get(n) != "defensive"]
        if config.defensive == "ranked":
            ranked = list(req.universe)
        if len(ranked) < config.top_n:
            raise ValueError(
                f"Only {len(ranked)} instruments selected for ranking - need at least "
                f"top N ({config.top_n})."
            )
        classes = {name: inst.tax_class for name, inst in universe.items()}
        fills = DATA.fills(req.track, req.execution)
        result = run_backtest(
            prices,
            includes,
            config,
            classes,
            DATA.rank_cache,
            fills.prices if fills is not None else None,
        )
        DATA.trim_cache()
    except ValueError as error:
        raise HTTPException(422, str(error)) from None
    groups = {name: inst.group for name, inst in universe.items()}
    return analysis.payload(
        result,
        prices,
        config,
        groups,
        fills.proxy if fills is not None else None,
        fills.warnings if fills is not None else None,
    )


def _stock_backtest(req: BacktestRequest) -> dict:
    stock = DATA.get_stock()
    classification = _stock_classification(stock)
    includes = {cid: include for cid, (include, _group) in classification.items()}
    # Gold/Silver/Cash (liquid fund)/Gilt 8-13 yr join the same `includes` mapping the 95
    # company_ids use - engine.ranked_universe doesn't care whether a name is a company_id or a
    # real instrument name, so no engine change is needed for them to be selected into
    # req.universe and ranked/traded like any other entry. `stock.tax_classes` already carries
    # their gold_silver/debt classes (see ui_data.load_stock_dataset), so nothing extra is needed
    # for tax - it's passed straight through to run_backtest below.
    includes.update({name: extra["tag"] for name, extra in stock.extra_instruments.items()})
    if req.weights is not None and len(req.weights) != len(req.lookbacks):
        raise HTTPException(422, "Give one weight per lookback.")
    if req.benchmark not in stock.prices:
        raise HTTPException(422, f"No price history for benchmark {req.benchmark!r}.")
    try:
        # No track/execution passed: stock backtests have no ETF-vs-index track concept, so
        # Config.needs_trade_prices stays False and trade_prices is never required - the
        # request's track/execution fields are simply ignored for dataset="stock".
        config = Config(**_config_kwargs(req))
        ranked = [n for n in req.universe if includes.get(n) != "defensive"]
        if config.defensive == "ranked":
            ranked = list(req.universe)
        if len(ranked) < config.top_n:
            raise ValueError(
                f"Only {len(ranked)} instruments selected for ranking - need at least "
                f"top N ({config.top_n})."
            )
        result = run_backtest(
            stock.prices,
            includes,
            config,
            stock.tax_classes,
            DATA.stock_rank_cache,
            None,
            membership=stock.membership,
        )
        DATA.trim_cache()
    except ValueError as error:
        raise HTTPException(422, str(error)) from None
    groups = dict.fromkeys(stock.companies, "Nifty 50")
    groups.update({name: extra["group"] for name, extra in stock.extra_instruments.items()})
    payload = analysis.payload(result, stock.prices, config, groups, membership=stock.membership)
    payload["companies"] = stock.companies
    return payload


def _custom_index_meta() -> dict:
    """"Custom Index" tab: one "instrument" per category (16 official NSE Sector/Thematic
    indices + the category_extras.csv custom ones, 62 total as of 2026-09-29), each of which is
    itself an inner top-K-stock rotation - see categories/compose.py's module docstring - plus
    the `ATOMIC_INSTRUMENTS` (Gold/Silver/Cash/Gilt/Nasdaq 100/Hang Seng, no inner rotation,
    Gold/Silver/Cash/Gilt each backed by `MAX_ATOMIC_COPIES` duplicate ranked columns so it can
    win more than one slot; International has no multi-slot mechanism). No
    per-category first_week/etf_turnover_cr_day the way ETFs have (a category has no single
    listing date or turnover figure of its own); `has_data` is left true here (cheap: just the
    category name list) - an individual category that can't actually resolve is instead caught,
    per-category, when the real backtest runs (AllCategoriesResult.skipped, surfaced in the
    payload) rather than pre-checked here at meta time, which would mean running ~60 backtests
    just to answer "what categories exist" (see get_categories_universe's own cost note).
    """
    if not (DATA_DIR / "categories" / "category_membership.csv").exists():
        raise HTTPException(409, "No category data yet - run `mbt categories fetch` first.")
    prices = DATA.get()
    instruments = [
        {
            "name": name,
            "group": _CATEGORY_LABEL_INFO.get(label, ("core", "Custom"))[1],
            "include": _CATEGORY_LABEL_INFO.get(label, ("core", "Custom"))[0],
            "trade_etf": "",
            "tax_class": "equity"
            if label in ("official", "custom")
            else "gold_silver"
            if label == "commodity"
            else "international"
            if label == "international"
            else "debt",
            "note": ""
            if label in ("official", "custom")
            else "no multi-slot mechanism for this instrument"
            if label == "international"
            else "can be configured (see Inner rotation panel) to occupy more than one ranked "
            f"slot at once when its own momentum is strong - up to {MAX_ATOMIC_COPIES}, "
            "1 (ordinary, single-instrument) by default",
            "first_week": None,
            "has_data": True,
            "etf_turnover_cr_day": None,
        }
        for name, label in [*all_category_names(CATEGORIES_CURATED_DIR), *ATOMIC_INSTRUMENTS]
    ]
    defaults = Config()
    return {
        "instruments": instruments,
        "first_week": prices.index[0].strftime("%Y-%m-%d"),
        "last_week": prices.index[-1].strftime("%Y-%m-%d"),
        "cash": CASH,
        # Categories are not sensible benchmarks for each other - unlike ETF mode (whose
        # benchmark list is just its own tradeable instruments), this mirrors stock mode's
        # explicit list, kept to the one obvious choice (Nifty 50) - a conservative default the
        # brief didn't ask to expand on.
        "benchmarks": [BENCHMARK],
        "defaults": {
            # top_n=8/exit_rank=16, not the ETF/stock-mode 5/10 (BacktestRequest's own top_n/
            # exit_rank Field defaults, unchanged - those still govern the other two datasets).
            # TODO.md 3.9.8 (2026-09): holding more of the ~68-name category universe at once
            # meaningfully cut max drawdown AND raised CAGR in real backtests - a genuine
            # win-win, not a tradeoff. Full 2017-2026 window: max drawdown -34.4% -> -30.8%,
            # CAGR 19.8% -> 24.6%. Last-5-years window: max drawdown -25.8% -> -19.3%, CAGR
            # 16.9% -> 32.4%. Checked this wasn't a window-selection artefact (a higher top_n
            # needs >= top_n categories with a valid rank before it can start, which pushes the
            # backtest's own start date later) by re-running both top_n values over the
            # identical, later common start date too - the improvement holds either way.
            # exit_rank kept at exactly 2x top_n, matching the prior 10/5 ratio (not the inner
            # rotation's own 4x DEFAULT_EXIT_RANK/DEFAULT_TOP_N ratio, a separate axis - see
            # inner_top_n/inner_exit_rank below).
            "top_n": 8,
            "exit_rank": 16,
            "lookbacks": list(defaults.lookbacks),
            # "ranked": Cash/Gilt (tagged "defensive", see _CATEGORY_LABEL_INFO) compete in the
            # same ranked table as the categories/Gold/Silver out of the box - same reasoning as
            # stock mode's own default change: "off" would leave them present but never actually
            # competing, defeating the point of adding them.
            "defensive": "ranked",
            "filter_lookback": defaults.filter_lookback,
            "cost_pct": defaults.cost_pct,
            "signal_delay": defaults.signal_delay,
            "start": defaults.start,
            "benchmark": BENCHMARK,
            "portfolio": defaults.portfolio,
            "entry": defaults.entry,
            "max_position": defaults.max_position,
            "cap_band": defaults.cap_band,
            # Opt-in try-it toggle (TODO.md 3.9.8 follow-up) - default False, NOT a new default
            # the way top_n/exit_rank above were: it needs real before/after numbers from the
            # user before defaulting on. See engine.py's Config.momentum_sizing.
            "momentum_sizing": defaults.momentum_sizing,
            "momentum_sizing_window": defaults.momentum_sizing_window,
            "momentum_sizing_floor": defaults.momentum_sizing_floor,
            "track": "index",
            "execution": defaults.execution,
            "score": "ranksum",
            "voladj_skip_recent_month": defaults.voladj_skip_recent_month,
            "rebalance": defaults.rebalance,
            "cost_model": "flat",
            "capital": defaults.capital,
            "slippage_bps": defaults.slippage_bps,
            # Custom-Index-only, read by the frontend's inner-rotation panel (see static/app.js).
            "inner_top_n": CATEGORY_DEFAULT_TOP_N,
            "inner_exit_rank": CATEGORY_DEFAULT_EXIT_RANK,
            # Custom-Index-only: how many ranked slots Gold/Silver and Cash/Gilt may each
            # occupy at once - 1 = ordinary single-instrument behaviour (see
            # compose.DEFAULT_ATOMIC_COPIES), configurable up to MAX_ATOMIC_COPIES.
            "commodity_copies": DEFAULT_ATOMIC_COPIES,
            "debt_copies": DEFAULT_ATOMIC_COPIES,
            "max_atomic_copies": MAX_ATOMIC_COPIES,
        },
    }


#: Inner trade-row fields surfaced to the UI, out of everything `engine._Sim.record` can put on
#: a `Result.trades` row (see engine.py's `record`/`exit_details`). Deliberately excludes
#: `value`/`entry_value`/`tax`: those are fractions of the INNER backtest's own 1.0-normalised
#: portfolio (top_n=inner_top_n stocks, e.g. 2), not of the outer ₹1L-invested portfolio the
#: rest of this payload's rupee figures (`analysis.CAPITAL`) are scaled to - showing them
#: multiplied by CAPITAL the way `analysis.payload()`'s own `trades`/`open_positions` do would
#: silently misrepresent them as real rupee amounts as if the whole outer portfolio were parked
#: in just this one category. `rank`/`price_return`/`position_return` are ratios/ordinals, so
#: they stay meaningful at any scale and are kept.
_INNER_TRADE_FIELDS = (
    "week",
    "action",
    "asset",
    "rank",
    "reason",
    "entry_week",
    "weeks_held",
    "price_return",
    "position_return",
)


def _inner_holdings_now(inner: Result) -> list[dict]:
    """What `inner`'s own rotation currently holds, as an `analysis._holdings_on`-shaped
    `[{"asset", "share"}, ...]` list - built from `Result.open_positions` (the engine's own
    authoritative "still open when the backtest ends" table), deliberately NOT
    `analysis._holdings_on(inner, inner.equity.index[-1])` the way the outer chart's Rotations
    hover reads current holdings: `Result.weights` is keyed to the week a trade was decided,
    but the loop that builds it (`engine._run_slots`/`_run_buffer`) only ever writes
    `weights[nxt]`'s *value* into `equity[nxt]`, never a `weights[nxt]` entry of its own for the
    very last processed week - so `weights.index[-1]` is always one week SHORT of
    `equity.index[-1]`. `_holdings_on` on the true last week silently finds nothing and returns
    `[]` for every category, every run - confirmed live against this task's own test fixture
    during verification (`weights` tail stopped at 2019-05-31, `equity`/`open_positions`'s own
    "as of" week was 2019-06-07). `open_positions` has no such off-by-one - it is written once,
    directly from the engine's final position state - so it is used here instead.
    """
    if not len(inner.open_positions):
        return []
    total = inner.open_positions["value"].sum() + inner.idle_value
    if not total:
        return []
    return [
        {"asset": r.asset, "share": r.value / total} for r in inner.open_positions.itertuples()
    ]


def _inner_category_detail(
    universe_result: AllCategoriesResult, result: Result
) -> dict[str, dict]:
    """Per-category inner (within-category stock) detail, keyed by category name - the data
    behind "which stocks did this category actually buy/sell/hold", threaded through from each
    category's own `InnerBacktestResult.result` (already computed in full by
    `build_all_categories_price_table`/`run_inner_category_backtest` - see categories/
    compose.py's module docstring; nothing here runs a new backtest).

    Bounded to categories that were ever a candidate OUTER-level trade: `result.trades["asset"]`
    union `result.open_positions["asset"]`. This is deliberately used instead of parsing
    `result.holdings` (whose column shape differs by portfolio rule - `slots` has one "slot N"
    column per slot, `buffer` has a single comma-joined "holdings" string column, see engine.py's
    two `_run_*` functions) - every category that is EVER held first has to be bought, which is
    always a trade row regardless of portfolio rule, so trades/open_positions is already a
    superset of anything holdings could add, without this function needing to know about both
    holdings shapes. Categories never selected into `req.universe`, or selected but never
    ranked into an actual trade, are excluded - avoids dumping full inner trade histories for
    ~66 categories when most of them were never held in a given run (see the task brief).

    Each entry: `trades` (that category's own raw inner trade rows - BUY/SELL/ADD/..., the same
    shape `rotations()` already builds the outer chart's hover detail from, not narrowed to
    closed positions the way the OUTER `payload()["trades"]` key is, since a user wants to see
    what was bought as well as what was fully sold) and `holdings_now` (see
    `_inner_holdings_now`).
    """
    names: set[str] = set()
    if len(result.trades):
        names |= set(result.trades["asset"].unique())
    if len(result.open_positions):
        names |= set(result.open_positions["asset"].unique())
    names &= set(universe_result.inner_results)
    if not names:
        return {}

    detail: dict[str, dict] = {}
    for name in sorted(names):
        inner = universe_result.inner_results[name].result
        trades = inner.trades.copy()
        for col in _INNER_TRADE_FIELDS:
            if col not in trades.columns:
                trades[col] = None
        rows = trades[list(_INNER_TRADE_FIELDS)].to_dict("records") if len(trades) else []
        detail[name] = analysis._clean(
            {"trades": rows, "holdings_now": _inner_holdings_now(inner)}
        )
    return detail


def _custom_index_backtest(req: BacktestRequest) -> dict:
    if not (DATA_DIR / "categories" / "category_membership.csv").exists():
        raise HTTPException(409, "No category data yet - run `mbt categories fetch` first.")
    if req.weights is not None and len(req.weights) != len(req.lookbacks):
        raise HTTPException(422, "Give one weight per lookback.")
    try:
        universe_result = DATA.get_categories_universe(
            inner_top_n=req.inner_top_n,
            inner_exit_rank=req.inner_exit_rank,
            lookbacks=tuple(req.lookbacks),
            cost_pct=req.cost_pct,
            start=req.start,
            end=req.end or None,
            commodity_copies=req.commodity_copies,
            debt_copies=req.debt_copies,
        )
    except ValueError as error:
        raise HTTPException(422, str(error)) from None

    prices = universe_result.prices
    if req.benchmark not in prices:
        raise HTTPException(422, f"No price history for benchmark {req.benchmark!r}.")
    includes = {
        name: _CATEGORY_LABEL_INFO.get(label, ("core", "Custom"))[0]
        for name, label in universe_result.labels.items()
    }
    # req.universe (from the sidebar checkboxes) names each atomic instrument ONCE ("Gold"),
    # never its duplicate copy columns (the sidebar shows one checkbox, not up to ten - see
    # _custom_index_meta) - expand each selected base name to exactly as many copies as this
    # REQUEST asked for (req.commodity_copies/debt_copies - the table itself was already built
    # with that many, see get_categories_universe's cache key) so they're actually eligible to
    # rank, matching what selecting "Gold" is supposed to mean. A category name (not in
    # ATOMIC_INSTRUMENTS) passes through unchanged.
    # .get(..., DEFAULT_ATOMIC_COPIES) -- not every atomic label has a configurable copy count
    # (e.g. "international" has no multi-slot mechanism, see ATOMIC_INSTRUMENTS's docstring);
    # indexing with [] here would KeyError the moment a user selects Nasdaq 100/Hang Seng.
    _copies_by_label = {"commodity": req.commodity_copies, "debt": req.debt_copies}
    _atomic_labels = dict(ATOMIC_INSTRUMENTS)
    universe = [
        copy_name
        for name in req.universe
        for copy_name in (
            atomic_copy_names(
                name, _copies_by_label.get(_atomic_labels[name], DEFAULT_ATOMIC_COPIES)
            )
            if name in _atomic_labels
            else [name]
        )
    ]
    try:
        # No track/execution passed, like the stock path: a category has no ETF-vs-index track
        # concept of its own - each column already IS the traded thing (the inner rotation's own
        # equity curve) - so Config.needs_trade_prices stays False.
        config = Config(**{**_config_kwargs(req), "universe": tuple(universe)})
        ranked = [n for n in universe if includes.get(n) != "defensive"]
        if config.defensive == "ranked":
            ranked = list(universe)
        if len(ranked) < config.top_n:
            raise ValueError(
                f"Only {len(ranked)} categories selected for ranking - need at least "
                f"top N ({config.top_n})."
            )
        result = run_backtest(
            prices, includes, config, rank_cache=DATA.custom_index_rank_cache
        )
        DATA.trim_cache()
    except ValueError as error:
        raise HTTPException(422, str(error)) from None
    groups = {
        name: _CATEGORY_LABEL_INFO.get(label, ("core", "Custom"))[1]
        for name, label in universe_result.labels.items()
    }
    payload = analysis.payload(result, prices, config, groups)
    if universe_result.skipped:
        # Surfaced for transparency (e.g. so the UI/report can note "N categories excluded this
        # run and why") - never fatal on its own, matching every other module in categories/'s
        # degrade-gracefully philosophy.
        payload["skipped_categories"] = sorted(universe_result.skipped)
    inner_detail = _inner_category_detail(universe_result, result)
    if inner_detail:
        payload["inner_categories"] = inner_detail
    return payload


def _membership_quality() -> dict:
    """Report years using the current constituent list in place of historical membership."""
    path = DATA_DIR / "categories" / broad.TOTAL_MARKET_MEMBERSHIP_FILENAME
    try:
        membership = pd.read_csv(path, usecols=["year", "source_tier"])
    except (OSError, ValueError):
        return {"constant_current_years": []}
    years = membership.loc[membership["source_tier"] == "constant_current", "year"]
    return {"constant_current_years": sorted(int(year) for year in years.unique())}


def _broad_meta() -> dict:
    """"Broad Momentum" tab (TODO.md 3.9.13): no per-instrument sidebar picker the way the other
    three datasets have (there are 755 stocks + 113 categories + 4 atomics -- which of them are
    even eligible changes every quarter, so a fixed checkbox list doesn't make sense the way it
    does for a static universe.csv/companies.csv list) -- `instruments` is deliberately empty;
    static/app.js skips building a universe section for this dataset entirely.
    """
    if not (DATA_DIR / "categories" / broad.TOTAL_MARKET_MEMBERSHIP_FILENAME).exists():
        raise HTTPException(409, "No Total Market data yet - run `mbt categories fetch-universe`.")
    prices = DATA.get()
    defaults = Config()
    return {
        "instruments": [],
        "first_week": prices.index[0].strftime("%Y-%m-%d"),
        "last_week": prices.index[-1].strftime("%Y-%m-%d"),
        "cash": CASH,
        "benchmarks": [BENCHMARK],
        "membership_quality": _membership_quality(),
        "defaults": {
            "start": "2017-01-01",
            "benchmark": BENCHMARK,
            "lookbacks": list(defaults.lookbacks),
            "cost_pct": defaults.cost_pct,
            "portfolio": defaults.portfolio,
            "entry": defaults.entry,
            # Broad holds up to 16 stocks across up to 8 categories, so the ETF-tuned 35% cap
            # almost never binds. These bind on a concentrated week without holding cash back on
            # a normal one (4 fresh categories x 30% and 8 fresh stocks x 15% both exceed 100%).
            "max_position": broad.DEFAULT_MAX_POSITION,
            "max_category": broad.DEFAULT_MAX_CATEGORY,
            "max_stock_price": broad.DEFAULT_MAX_STOCK_PRICE,
            "cap_band": defaults.cap_band,
            "rebalance": defaults.rebalance,
            "score": defaults.score,
            "voladj_skip_recent_month": defaults.voladj_skip_recent_month,
            # top_n/exit_rank/defensive/filter_lookback: NOT used for this dataset (their panels
            # stay hidden by static/app.js's syncDependentFields - see run_broad_backtest's own
            # docstring for why `defensive`/`filter_lookback` genuinely don't apply here: CASH
            # never enters this dataset's external rank table). Included only so
            # defaultConfig()'s generic field reads never hit `undefined` on a hidden control.
            # signal_delay/momentum_sizing*/cost_model/capital/slippage_bps ARE now used (TODO.md
            # 3.9.15 - see _broad_backtest/run_broad_backtest) and their controls are shown.
            "top_n": defaults.top_n,
            "exit_rank": defaults.exit_rank,
            "defensive": defaults.defensive,
            "filter_lookback": defaults.filter_lookback,
            "signal_delay": defaults.signal_delay,
            "momentum_sizing": defaults.momentum_sizing,
            "momentum_sizing_window": defaults.momentum_sizing_window,
            "momentum_sizing_floor": defaults.momentum_sizing_floor,
            "cost_model": defaults.cost_model,
            "capital": defaults.capital,
            "slippage_bps": defaults.slippage_bps,
            "broad_category_mode": "on",
            "broad_pool_top_n": broad.DEFAULT_POOL_TOP_N,
            "broad_pool_exit_rank": broad.DEFAULT_POOL_EXIT_RANK,
            "broad_coverage_floor": broad.DEFAULT_COVERAGE_FLOOR,
            "broad_category_top_n": broad.DEFAULT_CATEGORY_TOP_N,
            "broad_category_exit_rank": broad.DEFAULT_CATEGORY_EXIT_RANK,
            "broad_picks_per_category": broad.DEFAULT_PICKS_PER_CATEGORY,
            "broad_off_top_n": 10,
            "broad_off_exit_rank": 20,
        },
    }


def _momentum_scores_payload() -> dict:
    """"Momentum Scores" page (TODO.md 3.9.16) - a live/current-state snapshot, not a backtest
    dataset, so it doesn't go through `/api/meta` + `/api/backtest` the way the four config+run
    tabs do; it's its own single GET. Reuses the same Total Market membership file Broad Momentum
    needs, so the same "not fetched yet" guard applies."""
    if not (DATA_DIR / "categories" / broad.TOTAL_MARKET_MEMBERSHIP_FILENAME).exists():
        raise HTTPException(409, "No Total Market data yet - run `mbt categories fetch-universe`.")
    try:
        universe = DATA.get_momentum_universe()
    except ValueError as error:
        raise HTTPException(422, str(error)) from None

    group_info = momentum_scores_mod.load_stock_group_info(CATEGORIES_CURATED_DIR)
    group_members = broad.load_stock_groups(CATEGORIES_CURATED_DIR)
    stock_snapshot = momentum_scores_mod.compute_stock_momentum_scores(universe, group_info)
    sector_snapshot = momentum_scores_mod.compute_sector_momentum_scores(
        stock_snapshot, group_members
    )

    def scores_json(scores: dict) -> dict:
        return {str(k): v for k, v in scores.items()}

    return {
        "as_of": (
            None if pd.isna(stock_snapshot.as_of) else stock_snapshot.as_of.strftime("%Y-%m-%d")
        ),
        "lookbacks": list(stock_snapshot.lookbacks),
        "universe_size": stock_snapshot.universe_size,
        "missing_symbols": universe.missing_symbols,
        "membership_quality": _membership_quality(),
        "stocks": [
            {
                "symbol": r.symbol,
                "company_name": r.company_name,
                "parent_group": r.parent_group,
                "subgroup": r.subgroup,
                "last_price": r.last_price,
                "change_1w_pct": r.change_1w_pct,
                "returns": scores_json(r.returns),
                "scores": scores_json(r.scores),
            }
            for r in stock_snapshot.rows
        ],
        "sectors": [
            {
                "cid": r.cid,
                "parent_group": r.parent_group,
                "subgroup": r.subgroup,
                "member_count": r.member_count,
                "qualifying_count": r.qualifying_count,
                "scores": scores_json(r.scores),
            }
            for r in sector_snapshot.rows
        ],
    }


def _broad_backtest(req: BacktestRequest) -> dict:
    on = req.broad_category_mode == "on"
    if on and req.broad_category_top_n > req.broad_category_exit_rank:
        raise HTTPException(422, "Category top N can't be greater than the category exit rank.")
    if not on and req.broad_off_top_n > req.broad_off_exit_rank:
        raise HTTPException(422, "Top N can't be greater than the exit rank.")
    if req.broad_pool_top_n > req.broad_pool_exit_rank:
        raise HTTPException(422, "Pool top N can't be greater than the pool exit rank.")
    if req.weights is not None and len(req.weights) != len(req.lookbacks):
        raise HTTPException(422, "Give one weight per lookback.")
    if not (DATA_DIR / "categories" / broad.TOTAL_MARKET_MEMBERSHIP_FILENAME).exists():
        raise HTTPException(409, "No Total Market data yet - run `mbt categories fetch-universe`.")

    weights = tuple(req.weights) if req.weights else None
    try:
        ranking = DATA.get_broad_ranking(
            lookbacks=tuple(req.lookbacks),
            weights=weights,
            score=req.score,
            voladj_skip_recent_month=req.voladj_skip_recent_month,
            pool_top_n=req.broad_pool_top_n,
            pool_exit_rank=req.broad_pool_exit_rank,
        )
        outcome = broad.run_broad_backtest(
            outer_prices=DATA.get(),
            stocks_data_dir=DATA_DIR / "stocks",
            categories_data_dir=DATA_DIR / "categories",
            curated_dir=CATEGORIES_CURATED_DIR,
            category_mode=req.broad_category_mode,
            start=req.start,
            end=req.end or None,
            lookbacks=tuple(req.lookbacks),
            weights=weights,
            score=req.score,
            voladj_skip_recent_month=req.voladj_skip_recent_month,
            pool_top_n=req.broad_pool_top_n,
            pool_exit_rank=req.broad_pool_exit_rank,
            coverage_floor=req.broad_coverage_floor,
            category_top_n=req.broad_category_top_n,
            category_exit_rank=req.broad_category_exit_rank,
            picks_per_category=req.broad_picks_per_category,
            off_top_n=req.broad_off_top_n,
            off_exit_rank=req.broad_off_exit_rank,
            cost_pct=req.cost_pct,
            signal_delay=req.signal_delay,
            portfolio=req.portfolio,
            rebalance=req.rebalance,
            benchmark=req.benchmark,
            max_position=req.max_position,
            max_category=req.max_category if req.broad_category_mode == "on" else None,
            max_stock_price=req.max_stock_price or None,
            cap_band=req.cap_band,
            entry=req.entry,
            momentum_sizing=req.momentum_sizing,
            momentum_sizing_window=req.momentum_sizing_window,
            momentum_sizing_floor=req.momentum_sizing_floor,
            cost_model=req.cost_model,
            capital=req.capital,
            slippage_bps=req.slippage_bps,
            ranking=ranking,
        )
        DATA.trim_cache()
    except (ValueError, broad.TotalMarketDataNotFoundError) as error:
        raise HTTPException(422, str(error)) from None

    result = outcome.result
    prices = outcome.ranking.prices
    prices = prices.assign(**{CASH: DATA.get().reindex(prices.index)[CASH]})
    groups = dict.fromkeys(prices.columns, "Stock")
    for name in broad.ATOMIC_NAMES:
        groups[name] = "Atomic"
    payload = analysis.payload(result, prices, result.config, groups, share_prices=True)
    # Always present (empty list for category_mode="off", where there is no category layer at
    # all) - a consistent response shape the frontend can rely on regardless of mode.
    group_members = broad.load_stock_groups(CATEGORIES_CURATED_DIR) if on else {}
    payload["held_categories"] = broad.current_holdings_detail(
        outcome,
        group_members,
        category_top_n=req.broad_category_top_n,
        picks_per_category=req.broad_picks_per_category,
    )
    payload["missing_symbols"] = outcome.ranking.missing_symbols
    return payload


def create_app() -> FastAPI:
    app = FastAPI(title="Momentum backtest", docs_url="/api/docs")

    @app.get("/api/meta")
    def meta(dataset: Literal["etf", "stock", "custom_index", "broad"] = "etf") -> dict:
        if dataset == "stock":
            return _stock_meta()
        if dataset == "custom_index":
            return _custom_index_meta()
        if dataset == "broad":
            return _broad_meta()
        return _etf_meta()

    @app.get("/api/momentum-scores")
    def momentum_scores() -> dict:
        return _momentum_scores_payload()

    @app.post("/api/backtest")
    def backtest(req: BacktestRequest) -> dict:
        if req.dataset == "stock":
            return _stock_backtest(req)
        if req.dataset == "broad":
            return _broad_backtest(req)
        if req.dataset == "custom_index":
            return _custom_index_backtest(req)
        return _etf_backtest(req)

    @app.get("/vendor/plotly.min.js")
    def plotly() -> FileResponse:
        """Charting library, downloaded once and kept in data/ so the UI then works offline."""
        path = DATA_DIR / "vendor" / "plotly-2.35.2.min.js"
        if not path.exists():
            try:
                request = urllib.request.Request(PLOTLY_URL, headers={"User-Agent": "Mozilla/5.0"})
                body = urllib.request.urlopen(request, timeout=60).read()
            except OSError as error:
                raise HTTPException(503, f"Couldn't download the chart library: {error}") from None
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(body)
        return FileResponse(path, media_type="text/javascript")

    app.mount("/static", StaticFiles(directory=STATIC), name="static")

    @app.get("/")
    def index() -> FileResponse:
        return FileResponse(STATIC / "index.html")

    return app


app = create_app()
