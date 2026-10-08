"""Private Momentum API consumed by the shared dashboard."""

import contextlib
import inspect
import json
import os
import threading
import urllib.parse
from collections import OrderedDict
from collections.abc import Callable
from datetime import date, datetime, time, timedelta
from pathlib import Path
from time import perf_counter
from typing import Literal

import duckdb
import pandas as pd
from fastapi import BackgroundTasks, FastAPI, HTTPException
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import HTMLResponse, RedirectResponse
from pydantic import BaseModel, Field

from . import (
    analysis,
    db_read,
    fyers,
    levers,
    metrics,
    rebalance,
    reference_benchmarks,
    runs_store,
    saved_identity,
    search,
    stock_actions,
    this_week,
)
from . import groups as groups_mod
from .categories import broad
from .categories import circuit_exposure as circuit_exposure_mod
from .categories import exit_reasons as exit_reasons_mod
from .categories import liquidity as liquidity_mod
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
from .config import DATA_DIR, load_repo_env
from .db_read import open_catalog, read_catalog
from .engine import (
    BENCHMARK,
    CASH,
    IDLE,
    Config,
    Result,
    cadence_weeks,
    ranked_universe,
    run_backtest,
)
from .fetch import load_universe
from .forward_journal import week_string as journal_week_string
from .notify import IST, Notification
from .run_parts import RunParts, SectionReleased
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
#: The stock layer's committed curated/ dir: company identity, membership, manual actions.
STOCKS_CURATED_DIR = Path(__file__).parent / "stocks" / "curated"

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

_LOCAL_OAUTH_STATES: dict[str, datetime] = {}
_LOCAL_OAUTH_LOCK = threading.Lock()


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
        # grouped_momentum_ranks (TODO 3.9.23) isn't free - two compute_ranks passes over the
        # ~755-name universe, ~30s cold. Keyed on the ranking object's identity (it's itself
        # cache-held above) plus tilt/screen, so a repeat request with the same settings is fast.
        self.broad_tilt_cache: OrderedDict = OrderedDict()
        # "Momentum Scores" page (TODO.md 3.9.16): the 755-name price frame + point-in-time
        # membership gate (categories/momentum_scores.py's shared Step 1 with Broad Momentum's
        # Step 2, `broad.load_stock_universe_frame`) - ~7s cold, same two watch paths as
        # `_broad_mtimes` above, but no lookbacks/score/pool params to key on (this page has no
        # user-configurable knobs at all), so a single cached value is enough - not an
        # OrderedDict keyed cache the way broad_ranking_cache needs to be.
        self._momentum_universe_mtimes: tuple | None = None
        self.momentum_universe_cache: broad.StockUniverseFrame | None = None
        self._references_mtimes: tuple | None = None
        self.references_cache: pd.DataFrame | None = None
        # BL-005: whole backtest results, keyed on the request and `input_version()`, so an
        # identical re-run (another tab, the same settings after a look elsewhere) is instant.
        self.result_cache: OrderedDict = OrderedDict()

    RESULT_CACHE_SIZE = 8
    #: Of those, how many keep sections they have not built yet (see `store_result`).
    LIVE_RESULTS = 4

    def reset(self) -> None:
        """Drop EVERYTHING this process has cached - rankings, trade-price tables, the loaded
        datasets, the reference benchmarks - and forget every file/database timestamp, so the next
        request reloads from the catalog or files and recomputes from scratch. This is what the
        dashboard's "re-run from scratch" icon asks for (`fresh: true`). A normal run keeps the
        caches: they are keyed on the settings, so they are correct as well as fast."""
        with self._lock:
            self._mtime = None
            self.prices = None
            self.rank_cache.clear()
            self.fill_tables.clear()
            self._stock_mtime = None
            self.stock = None
            self.stock_rank_cache.clear()
            self._categories_mtimes = None
            self.custom_index_cache.clear()
            self.custom_index_rank_cache.clear()
            self._broad_mtimes = None
            self.broad_ranking_cache.clear()
            self.broad_tilt_cache.clear()
            self._momentum_universe_mtimes = None
            self.momentum_universe_cache = None
            self._references_mtimes = None
            self.references_cache = None
            forgotten = list(self.result_cache.values())
            self.result_cache.clear()
        for old in forgotten:  # outside the lock: releasing may wait for a build in progress
            old.release()

    def cached_result(self, key: tuple) -> RunParts | None:
        """The result of an identical earlier request on the same inputs."""
        with self._lock:
            hit = self.result_cache.get(key)
            if hit is not None:
                self.result_cache.move_to_end(key)
            return hit

    def store_result(self, key: tuple, parts: RunParts) -> None:
        """Keep the run. Only the newest `LIVE_RESULTS` keep their unbuilt sections: those hold
        the run's frames and, for Broad, its whole ranking, which `broad_ranking_cache` otherwise
        caps at 4. An older run that still has sections it can no longer build is no use as a
        cache hit, so it is dropped; one whose sections are all built is only data and stays."""
        with self._lock:
            self.result_cache[key] = parts
            self.result_cache.move_to_end(key)
            dropped = []
            while len(self.result_cache) > self.RESULT_CACHE_SIZE:
                dropped.append(self.result_cache.popitem(last=False)[1])
            older = list(self.result_cache.values())[: -self.LIVE_RESULTS]
        # Outside the lock: releasing waits for a section that is being built right now.
        for old in [*dropped, *older]:
            old.release()
        with self._lock:
            for stale in [k for k, p in self.result_cache.items() if not p.complete]:
                del self.result_cache[stale]

    def get(self) -> pd.DataFrame:
        """Prefers the shared local database (`packages/trading-data`, populated by `mbt
        local migrate`) over weekly_closes.csv once it has data — see db_read.py's module
        docstring. Falls back to the CSV on a fresh checkout, or a test fixture that only
        wrote the file, so this stays correct either way. Cache key is whichever source
        was actually used last time, so a write to EITHER invalidates it."""
        path = DATA_DIR / "weekly_closes.csv"
        db_version = db_read.data_version()
        csv_mtime = path.stat().st_mtime if path.exists() else None
        if db_version is None and csv_mtime is None:
            raise HTTPException(409, "No data yet - run `mbt login` then `mbt fetch`.")
        with self._lock:
            mtime = (db_version, csv_mtime)
            if mtime != self._mtime:
                from_db = (
                    db_read.weekly_closes_from_db_or_none() if db_version is not None else None
                )
                if from_db is None and csv_mtime is None:
                    # A catalog exists but holds no weekly prices (anything that opens it for
                    # writing creates it - e.g. the dashboard's first saved-runs call) and there
                    # is no CSV either: say what to run, instead of a FileNotFoundError -> 500.
                    raise HTTPException(
                        409,
                        "No data yet - run `mbt local migrate` (or `mbt login` then `mbt fetch`).",
                    )
                self.prices = (
                    from_db
                    if from_db is not None
                    else pd.read_csv(path, index_col=0, parse_dates=True)
                )
                self._mtime = mtime
                self.rank_cache.clear()
                self.fill_tables.clear()
            return self.prices

    def get_stock(self) -> StockDataset:
        """The Nifty 50 stock-momentum dataset. `ui_data.load_stock_dataset` itself prefers
        the shared database over data/stocks/*.csv (see db_read.py); this method's job is
        only the reload-when-stale cache gate, so it must check BOTH sources — same mtime-
        check pattern as `get()`, watched on nifty50_weekly_tr.csv since that's the file
        every other stocks/ series is reindexed onto."""
        base = DATA_DIR / "stocks"
        path = base / "nifty50_weekly_tr.csv"
        db_version = db_read.data_version()
        csv_mtime = path.stat().st_mtime if path.exists() else None
        if db_version is None and csv_mtime is None:
            raise HTTPException(409, "No stock data yet - run `mbt stocks fetch`.")
        with self._lock:
            mtime = (db_version, csv_mtime)
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

    def references(self) -> pd.DataFrame:
        """Nifty 50 TRI / Nifty200 Momentum 30 TRI comparison lines (reference_benchmarks),
        reloaded when either source changes. Empty, never an error, when neither has them."""
        path = DATA_DIR / "stocks" / "benchmarks_weekly.csv"
        mtimes = (db_read.data_version(), path.stat().st_mtime if path.exists() else None)
        with self._lock:
            if mtimes != self._references_mtimes or self.references_cache is None:
                self.references_cache = reference_benchmarks.load_references(DATA_DIR)
                self._references_mtimes = mtimes
            return self.references_cache

    def get_broad_tilt_ranks(
        self,
        ranking: broad.UniverseRanking,
        lookbacks: tuple[int, ...],
        tilt: float,
        screen_top_pct: float,
    ) -> tuple[pd.DataFrame, pd.DataFrame]:
        with self._lock:
            cached = levers.tilt_cache_get(
                self.broad_tilt_cache, ranking.prices, lookbacks, tilt, screen_top_pct
            )
        if cached is not None:
            return cached
        ranks = levers.grouped_momentum_ranks(
            ranking.prices,
            Config(lookbacks=tuple(lookbacks)),
            tilt=tilt,
            screen_top_pct=screen_top_pct,
        )
        with self._lock:
            levers.tilt_cache_put(
                self.broad_tilt_cache,
                ranking.prices,
                lookbacks,
                tilt,
                screen_top_pct,
                ranks,
                limit=8,
            )
        return ranks

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
        mtimes += (db_read.data_version(),)
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
        liquidity: liquidity_mod.LiquidityConfig | None = None,
        universe_kind: Literal["total_market", "all_liquid", "turnover_rank"] = "total_market",
        series_breaks: Literal["legacy", "verified"] = "verified",
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
        mtimes += (db_read.data_version(),)
        key = (
            tuple(lookbacks),
            tuple(weights) if weights else None,
            score,
            voladj_skip_recent_month,
            pool_top_n,
            pool_exit_rank,
            liquidity,
            universe_kind,
            series_breaks,
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
            liquidity=liquidity,
            universe_kind=universe_kind,
            series_breaks=series_breaks,
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
        a completely unrelated dataset.

        Bug fix (TODO.md 3.11.16): unlike its two siblings (`get_categories_universe`,
        `get_broad_ranking`), this watch list was missing `db_read.catalog_mtime()` — a write
        that only touches the shared catalog/lake (e.g. `stocks/fyers_topup.py`'s Total Market
        top-up, which never touches `daily.parquet` or the membership CSV) left this cache
        silently serving pre-top-up data in a long-running `mbt serve` process until either
        watched file's mtime happened to change or the process restarted. The Momentum Scores
        page showing a stale "as of" date after a successful top-up was this, not a data
        problem."""
        watch_paths = [
            DATA_DIR / "categories" / broad.TOTAL_MARKET_MEMBERSHIP_FILENAME,
            DATA_DIR / "stocks" / "daily.parquet",
        ]
        mtimes = tuple(p.stat().st_mtime if p.exists() else None for p in watch_paths)
        mtimes += (db_read.data_version(),)
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

#: Folders whose files a backtest reads (top level only), besides the shared database.
_INPUT_FOLDERS = ("", "daily", "daily_etf", "categories", "stocks")


#: Files under data/ that are written by the tools, never read by a backtest: logs, the Fyers token
#: cache (`.fyers_token.json`, rewritten every morning) and other dotfiles, and the live-rules
#: check's last report. Counting them moved the data version with no market data changing, which
#: emptied caches and made a moved result look like a data revision (BL-052).
_STATE_FILES = frozenset({"live_rules_last.json"})


def _not_an_input(name: str) -> bool:
    return name.endswith(".log") or name.startswith(".") or name in _STATE_FILES


def input_version() -> tuple:
    """Everything a backtest result depends on apart from its request: the shared database's
    `data_version()` and the size and mtime of every input file under data/ and the curated
    folders. Wider than any one dataset needs (an ETF fetch also invalidates a cached Broad
    result), which costs only a re-run; it must never be narrower."""
    folders = [DATA_DIR / name for name in _INPUT_FOLDERS]
    folders += [CATEGORIES_CURATED_DIR, STOCKS_CURATED_DIR]
    files = []
    for folder in folders:
        if not folder.is_dir():
            continue
        for entry in os.scandir(folder):
            if entry.is_file() and not _not_an_input(entry.name):
                stat = entry.stat()
                files.append((entry.path, stat.st_size, stat.st_mtime_ns))
    return (db_read.data_version(), tuple(sorted(files)))


_IGNORED_FIELDS = {
    dataset: sorted(fields | saved_identity.RUN_ONLY_FIELDS)
    for dataset, fields in saved_identity.IGNORED_FIELDS.items()
}


def _alert_if_not_reproducible(record: dict) -> None:
    """BL-052: a favourite whose result moved with the same settings, code and data is a bug;
    say so on Telegram (untagged, like a live-rules breach: it cannot be switched off). A Check is
    shown on the dashboard only (owner, 2026-10-08)."""
    change = record.get("change")
    strategy = record.get("strategy_ref") or {}
    if not change or change.get("label") != "not_reproducible" or not strategy.get("favourite"):
        return
    from . import notify

    before, after = change.get("kpis_before") or {}, change.get("kpis_after") or {}

    def pct(value: object) -> str:
        return f"{value * 100:.2f}%" if isinstance(value, int | float) else "?"

    notify.send(
        Notification(
            source="Momentum saved runs",
            severity="error",
            title=f"Result not reproducible: {strategy.get('name')}",
            body=(
                "Same settings, same code and same data gave a different result. "
                f"CAGR {pct(before.get('cagr'))} -> {pct(after.get('cagr'))}; first different "
                f"week {change.get('first_difference') or '?'}. Open Saved runs to review it."
            ),
        )
    )


def request_key(req: BaseModel) -> str:
    """The request as canonical JSON: field order never matters, `fresh` is not a setting."""
    return json.dumps(req.model_dump(mode="json", exclude={"fresh"}), sort_keys=True)


#: The parts of a finished backtest fetched on their own (run_parts.RunParts).
BacktestSection = Literal["trades", "instruments", "timeline", "latest", "circuit_exposure"]


class BacktestRequest(BaseModel):
    dataset: Literal["etf", "stock", "custom_index", "broad"] = "etf"
    #: Not a strategy setting: true makes the server drop all its caches and reload the data
    #: before running (the dashboard's "re-run from scratch"). Never part of a saved config.
    fresh: bool = False
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
    # rebalance="weekly" only: trade every K weeks, on calendar phase `rebalance_offset`
    # (engine.Config.rebalance_every). 1 = every week.
    rebalance_every: int = Field(1, ge=1, le=13)
    rebalance_offset: int = Field(0, ge=0, le=12)
    # Buffer rule only. With rebalance_every > 1, sell a dropped-rank holding every week instead
    # of waiting for the next cadence week; new buys and cap trims still wait (engine.Config's
    # own field of the same name). Harmless no-op when rebalance_every == 1.
    sell_every_week: bool = False
    # dataset="etf" only (TODO 3.9.23, owner follow-up): rank on the usual short lookbacks
    # (1/4/13w) blended with a separate "most beaten-down over 26/52w" preference
    # (levers.grouped_momentum_ranks), instead of the config's own ranking method. 0 (default)
    # leaves ranking untouched. A fresh 52-week low is never bought (levers.fresh_52w_low_mask),
    # same falling-knife guard as the reversal sleeve.
    reversal_tilt: float = Field(0.0, ge=0, le=2)
    # grouped_momentum_ranks only: 0 (default) ranks every eligible name; > 0 first keeps only
    # the top share by short-term momentum (e.g. 0.3 = top 30%), the tilt then orders within it.
    reversal_screen_pct: float = Field(0.0, ge=0, lt=1)
    # dataset="broad" only (TODO 3.9.23 owner follow-up): same idea, applied WITHIN whatever
    # category/pool selection the funnel already made - re-orders those stocks by the tilted
    # score instead of plain momentum; it never changes which categories or pool stocks qualify.
    broad_reversal_tilt: float = Field(0.0, ge=0, le=2)
    broad_reversal_screen_pct: float = Field(0.0, ge=0, lt=1)
    # dataset="etf" only (TODO 3.9.23): never freshly BUY the most volatile fraction of the
    # ranked instruments (26-week weekly volatility, levers.high_vol_mask); holdings are
    # untouched. 0 = off. Measured to help ETF mode and to hurt stocks, so ETF only.
    exclude_high_vol: float = Field(0.0, ge=0, lt=1)
    # dataset="broad" only (TODO 3.9.23): simulate every week. Defaults True (TODO 3.11.17) —
    # False skips weeks with fewer than category_top_n x picks ranked stocks (~190 of 508 since
    # 2017), which overstates Broad's CAGR and Sharpe; it also silently hid fresh data from a
    # catalog-only update (e.g. the Fyers Total Market top-up) behind what looked like a stale
    # backtest, since the thin trailing weeks right after an ingest gap are exactly the ones it
    # drops. A saved favourite/run that set this explicitly is unaffected either way.
    broad_every_week: bool = True
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
    # "extended" also tags stocks outside the 755-name Total Market (BSE-derived sectors), so the
    # all-liquid universe's category layer can hold them; "curated" is the original 755-name file.
    broad_category_tags: Literal["curated", "extended"] = "curated"
    # How big one-day falls are treated when building price series. "verified" (the default
    # everywhere since 2026-10-05, BL-010) keeps one continuous series unless a corporate action
    # that cannot be back-adjusted (demerger, rights, scheme, dividend) explains the fall.
    # "legacy" starts a new series at every unexplained fall >= 15%, which retires and freezes a
    # held position; it is kept only to reproduce results saved before the switch, and a run
    # saved without this field now re-runs on "verified".
    broad_series_breaks: Literal["legacy", "verified"] = "verified"
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
    # Optional point-in-time tradability gate on the pool (categories/liquidity.py, TODO 3.9.24).
    # Off = exactly the original Total Market pool.
    # "total_market" = the ~750-name Nifty Total Market pool (default, unchanged); "all_liquid" =
    # every NSE equity, narrowed week by week by the tradability gate (which is then mandatory);
    # "turnover_rank" = the top 750 by turnover as known each January (point in time, BL-010 F1;
    # what the Phase 3-6 searches ran on) - gated like all_liquid, because the search always gates.
    broad_universe: Literal["total_market", "all_liquid", "turnover_rank"] = "total_market"
    broad_liquidity_filter: bool = False
    # Fill as a live account would around circuit locks: no buying a stock locked at the upper
    # circuit, no selling one locked at the lower circuit. Off = fills ignore locks (the original
    # behaviour); the results card always shows the CAGR both ways.
    broad_respect_circuits: bool = False
    broad_liq_min_turnover_cr: float = Field(1.0, gt=0, le=1000)
    broad_liq_floor_ratio: float = Field(0.25, ge=0, le=1)
    broad_liq_min_price: float = Field(20.0, ge=0, le=100_000)
    broad_liq_circuit: bool = True
    broad_liq_circuit_run: int = Field(3, ge=2, le=20)
    # None = no cap on LC/UC (band-edge) days among the last 60 sessions.
    broad_liq_max_circuit_days: int | None = Field(None, ge=0, le=60)


class SavedRunBody(BaseModel):
    """What the frontend already builds client-side after a backtest (previously kept
    only in `localStorage`) - see `runs_store.save_run`."""

    dataset: Literal["etf", "stock", "custom_index", "broad"]
    name: str = Field(min_length=1, max_length=64)
    config: dict
    kpis: dict
    dates: list[str]
    strategy: list[float | None]
    overlay: bool = False
    #: The run's data and code fingerprints, as the backtest result carried them (`versions`,
    #: BL-052). Missing (an older dashboard): measured when the run is saved.
    versions: dict | None = None


class SavedStrategyUpdate(BaseModel):
    """A change to a saved strategy (BL-052): applied to its anchor run."""

    name: str | None = Field(None, min_length=1, max_length=64)
    notes: str | None = Field(None, max_length=500)
    overlay: bool | None = None
    status: Literal["none", "watching", "paper", "invested"] | None = None
    active: bool | None = None


class ResultChangeReview(BaseModel):
    reviewed_by: str = Field("owner", min_length=1, max_length=64)


class SavedRunUpdate(BaseModel):
    name: str | None = Field(None, min_length=1, max_length=64)
    overlay: bool | None = None
    favorite: bool | None = None
    active: bool | None = None
    # BL-051: Watching / Paper / Invested, or "none" to stop following it.
    status: Literal["none", "watching", "paper", "invested"] | None = None


class SavedRunGroupBody(BaseModel):
    """BL-051: saved runs of one dataset made one favourite (`runs_store.create_group`)."""

    name: str = Field(min_length=1, max_length=64)
    members: list[str] = Field(min_length=2, max_length=12)


class WeeklyRunBody(BaseModel):
    run: Literal["preview", "final"]
    send: bool = True
    # CLI/internal use only (the dashboard's manual trigger never sets this): restrict
    # Telegram sending to a rerun that only matters when the active favourite is one of
    # these datasets. See _execute_weekly_run's "in_scope" comment.
    only_if_active_dataset: list[str] | None = None


class StockActionReviewBody(BaseModel):
    symbol: str = Field(min_length=1, max_length=32)
    ex_date: date
    decision: Literal["split", "bonus", "crash"]
    factor: float | None = Field(None, gt=1, le=100)
    source_url: str | None = Field(None, max_length=1000)
    note: str | None = Field(None, max_length=1000)


class RebalanceRequest(BacktestRequest):
    """Actual portfolio weights are percentages, e.g. 12.5 means 12.5%."""

    holdings_pct: dict[str, float] = Field(default_factory=dict)
    portfolio_value: float = Field(gt=0)
    # Operational/live start, distinct from BacktestRequest.start (the research window).
    # When supplied it anchors the every-K-weeks cadence phase used by this preview.
    strategy_start_date: date | None = None
    auth_source: Literal["auto", "dashboard"] = "auto"


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
        rebalance_every=req.rebalance_every,
        rebalance_offset=req.rebalance_offset,
        sell_every_week=req.sell_every_week,
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
            "rebalance_every": defaults.rebalance_every,
            "rebalance_offset": defaults.rebalance_offset,
            "sell_every_week": defaults.sell_every_week,
            "broad_reversal_tilt": 0.0,
            "broad_reversal_screen_pct": 0.0,
            "reversal_tilt": 0.0,
            "reversal_screen_pct": 0.0,
            "exclude_high_vol": 0.0,
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
    # `display_name` is falsy; the dashboard displays `name` in that case.
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
            "rebalance_every": defaults.rebalance_every,
            "rebalance_offset": defaults.rebalance_offset,
            "sell_every_week": defaults.sell_every_week,
            "broad_reversal_tilt": 0.0,
            "broad_reversal_screen_pct": 0.0,
            "cost_model": defaults.cost_model,
            "capital": defaults.capital,
            "slippage_bps": defaults.slippage_bps,
        },
    }


#: What a dataset's backtest builds: (everything needed at once, {section: builder}). See
#: run_parts.RunParts, and `_full` for the one dict the synchronous callers want.
Parts = tuple[dict, dict[str, Callable[[], object]]]


#: Tells a background job which step it has reached ("loading", "ranking", "simulating",
#: "analysing"), so the dashboard can show more than a clock. The synchronous callers pass nothing.
Report = Callable[[str], None]

#: The steps a job goes through, in order. Every name a builder reports is one of these, and each
#: job carries the list so the dashboard does not hard-code the order or the count.
JOB_STAGES = ("loading", "ranking", "simulating", "analysing")


def _no_report(stage: str) -> None:
    return None


def _takes_report(work: Callable[..., object]) -> bool:
    """True when `work` declares a required positional parameter, which is where the job runner
    puts its reporter. A callable with no parameters, only optional ones, or no readable signature
    (some builtins) is called with nothing."""
    try:
        parameters = inspect.signature(work).parameters.values()
    except (TypeError, ValueError):
        return False
    positional = (inspect.Parameter.POSITIONAL_ONLY, inspect.Parameter.POSITIONAL_OR_KEYWORD)
    return any(p.default is inspect.Parameter.empty and p.kind in positional for p in parameters)


def _full(core: dict, lazy: dict[str, Callable[[], object]]) -> dict:
    return {**core, **{name: build() for name, build in lazy.items()}}


def _etf_backtest(req: BacktestRequest) -> dict:
    return _full(*_etf_parts(req))


def _etf_parts(req: BacktestRequest, report: Report = _no_report) -> Parts:
    report("loading")
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
        names = ranked_universe(includes, config)
        masks = []
        if req.exclude_high_vol > 0:
            masks.append(levers.high_vol_mask(prices[names], quantile=1 - req.exclude_high_vol))
        external_ranks = None
        if req.reversal_tilt > 0:
            external_ranks = levers.grouped_momentum_ranks(
                prices[names],
                config,
                tilt=req.reversal_tilt,
                screen_top_pct=req.reversal_screen_pct,
            )
            masks.append(levers.fresh_52w_low_mask(prices[names]))
        no_buy = None
        if masks:
            no_buy = masks[0]
            for extra in masks[1:]:
                no_buy = no_buy.reindex_like(extra).fillna(False) | extra
        report("simulating")
        result = run_backtest(
            prices,
            includes,
            config,
            classes,
            DATA.rank_cache,
            fills.prices if fills is not None else None,
            no_buy=no_buy,
            external_ranks=external_ranks,
        )
        DATA.trim_cache()
    except ValueError as error:
        raise HTTPException(422, str(error)) from None
    groups = {name: inst.group for name, inst in universe.items()}
    report("analysing")
    return analysis.payload_parts(
        result,
        prices,
        config,
        groups,
        fills.proxy if fills is not None else None,
        fills.warnings if fills is not None else None,
        references=DATA.references(),
        no_buy=no_buy,
    )


def _stock_backtest(req: BacktestRequest) -> dict:
    return _full(*_stock_parts(req))


def _stock_parts(req: BacktestRequest, report: Report = _no_report) -> Parts:
    report("loading")
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
        report("simulating")
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
    report("analysing")
    core, lazy = analysis.payload_parts(
        result,
        stock.prices,
        config,
        groups,
        membership=stock.membership,
        references=DATA.references(),
    )
    core["companies"] = stock.companies
    return core, lazy


def _custom_index_meta() -> dict:
    """ "Custom Index" tab: one "instrument" per category (16 official NSE Sector/Thematic
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
    if not (
        db_read.has_category_data()
        or (DATA_DIR / "categories" / "category_membership.csv").exists()
    ):
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
            "rebalance_every": defaults.rebalance_every,
            "rebalance_offset": defaults.rebalance_offset,
            "sell_every_week": defaults.sell_every_week,
            "broad_reversal_tilt": 0.0,
            "broad_reversal_screen_pct": 0.0,
            "cost_model": "flat",
            "capital": defaults.capital,
            "slippage_bps": defaults.slippage_bps,
            # Custom-Index-only, read by the dashboard's inner-rotation controls.
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
    return [{"asset": r.asset, "share": r.value / total} for r in inner.open_positions.itertuples()]


def _inner_category_detail(universe_result: AllCategoriesResult, result: Result) -> dict[str, dict]:
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
        detail[name] = analysis._clean({"trades": rows, "holdings_now": _inner_holdings_now(inner)})
    return detail


def _custom_index_backtest(req: BacktestRequest) -> dict:
    return _full(*_custom_index_parts(req))


def _custom_index_parts(req: BacktestRequest, report: Report = _no_report) -> Parts:
    report("loading")
    if not (
        db_read.has_category_data()
        or (DATA_DIR / "categories" / "category_membership.csv").exists()
    ):
        raise HTTPException(409, "No category data yet - run `mbt categories fetch` first.")
    if req.weights is not None and len(req.weights) != len(req.lookbacks):
        raise HTTPException(422, "Give one weight per lookback.")
    try:
        report("ranking")  # the ~60 per-category backtests behind a cold run
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
        report("simulating")
        result = run_backtest(prices, includes, config, rank_cache=DATA.custom_index_rank_cache)
        DATA.trim_cache()
    except ValueError as error:
        raise HTTPException(422, str(error)) from None
    groups = {
        name: _CATEGORY_LABEL_INFO.get(label, ("core", "Custom"))[1]
        for name, label in universe_result.labels.items()
    }
    report("analysing")
    core, lazy = analysis.payload_parts(
        result, prices, config, groups, references=DATA.references()
    )
    if universe_result.skipped:
        # Surfaced for transparency (e.g. so the UI/report can note "N categories excluded this
        # run and why") - never fatal on its own, matching every other module in categories/'s
        # degrade-gracefully philosophy.
        core["skipped_categories"] = sorted(universe_result.skipped)
    inner_detail = _inner_category_detail(universe_result, result)
    if inner_detail:
        core["inner_categories"] = inner_detail
    return core, lazy


def _membership_quality() -> dict:
    """Report years using the current constituent list in place of historical membership.
    Prefers the shared local database over the file, same pattern as everywhere else here."""
    from_db = db_read.constant_current_total_market_years_from_db_or_none()
    if from_db is not None:
        return {"constant_current_years": from_db}
    path = DATA_DIR / "categories" / broad.TOTAL_MARKET_MEMBERSHIP_FILENAME
    try:
        membership = pd.read_csv(path, usecols=["year", "source_tier"])
    except (OSError, ValueError):
        return {"constant_current_years": []}
    years = membership.loc[membership["source_tier"] == "constant_current", "year"]
    return {"constant_current_years": sorted(int(year) for year in years.unique())}


def _broad_meta() -> dict:
    """ "Broad Momentum" tab (TODO.md 3.9.13): no per-instrument sidebar picker the way the other
    three datasets have (there are 755 stocks + 113 categories + 4 atomics -- which of them are
    even eligible changes every quarter, so a fixed checkbox list doesn't make sense the way it
    does for a static universe.csv/companies.csv list) -- `instruments` is deliberately empty;
    the dashboard skips the per-instrument picker for this dataset.
    """
    if not (
        db_read.has_total_market_data()
        or (DATA_DIR / "categories" / broad.TOTAL_MARKET_MEMBERSHIP_FILENAME).exists()
    ):
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
            "rebalance_every": defaults.rebalance_every,
            "rebalance_offset": defaults.rebalance_offset,
            "sell_every_week": defaults.sell_every_week,
            "broad_reversal_tilt": 0.0,
            "broad_reversal_screen_pct": 0.0,
            "score": defaults.score,
            "voladj_skip_recent_month": defaults.voladj_skip_recent_month,
            # top_n/exit_rank/defensive/filter_lookback: NOT used for this dataset.
            # See run_broad_backtest's own
            # docstring for why `defensive`/`filter_lookback` genuinely don't apply here: CASH
            # never enters this dataset's external rank table). Included only so
            # the dashboard's generic field reads still receive defined defaults.
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
            "broad_every_week": True,
            "broad_universe": "total_market",
            # A new Broad run starts realistic (owner decision 2026-10-05, BL-010 §3.13.2): only
            # stocks that trade enough, and no fills on a circuit-locked day. Together they cut
            # the default run from 53% to 40% CAGR. The request model keeps False, so a saved
            # run (which carries its own values) re-runs unchanged.
            "broad_liquidity_filter": True,
            "broad_respect_circuits": True,
            "broad_liq_min_turnover_cr": 1.0,
            "broad_liq_floor_ratio": 0.25,
            "broad_liq_min_price": 20.0,
            "broad_liq_circuit": True,
            "broad_liq_circuit_run": 3,
            "broad_liq_max_circuit_days": None,
        },
    }


def _liquidity_preview_payload(
    cfg: liquidity_mod.LiquidityConfig, universe: str = "total_market"
) -> dict:
    try:
        cfg.validate()
        if universe == "all_liquid":
            members = liquidity_mod.market_members_by_year()
        elif universe == "turnover_rank":
            members = liquidity_mod.turnover_rank_members_by_year()
        else:
            members = broad.total_market_members_by_year(DATA_DIR / "categories")
    except (ValueError, broad.TotalMarketDataNotFoundError) as error:
        raise HTTPException(422, str(error)) from None
    latest_year = max(members)
    symbols = sorted(members[latest_year])
    return liquidity_mod.preview(cfg, symbols)


_SCORES_MEMO = momentum_scores_mod.UniverseMemo()


def _momentum_scores_payload() -> dict:
    """ "Momentum Scores" page (TODO.md 3.9.16) - a live/current-state snapshot, not a backtest
    dataset, so it doesn't go through `/api/meta` + `/api/backtest` the way the four config+run
    tabs do; it's its own single GET. Reuses the same Total Market membership file Broad Momentum
    needs, so the same "not fetched yet" guard applies."""
    if not (
        db_read.has_total_market_data()
        or (DATA_DIR / "categories" / broad.TOTAL_MARKET_MEMBERSHIP_FILENAME).exists()
    ):
        raise HTTPException(409, "No Total Market data yet - run `mbt categories fetch-universe`.")
    try:
        universe = DATA.get_momentum_universe()
    except ValueError as error:
        raise HTTPException(422, str(error)) from None

    groups_file = CATEGORIES_CURATED_DIR / broad.STOCK_GROUPS_FILENAME
    key = groups_file.stat().st_mtime if groups_file.exists() else None

    def build() -> tuple:
        group_info = momentum_scores_mod.load_stock_group_info(CATEGORIES_CURATED_DIR)
        group_members = broad.load_stock_groups(CATEGORIES_CURATED_DIR)
        stock_snapshot = momentum_scores_mod.compute_stock_momentum_scores(universe, group_info)
        return (
            stock_snapshot,
            momentum_scores_mod.compute_sector_momentum_scores(stock_snapshot, group_members),
            momentum_scores_mod.compute_rotation(universe, group_members),
        )

    # Everything but the quality note is a function of the price frame and the group file, and
    # changes once a day: kept for the frame it came from, so a refresh or a second tab is cheap.
    stock_snapshot, sector_snapshot, rotation = _SCORES_MEMO.get(universe, key, build)
    return momentum_scores_mod.to_payload(
        stock_snapshot,
        sector_snapshot,
        missing_symbols=universe.missing_symbols,
        membership_quality=_membership_quality(),
        rotation=rotation,
    )


def _momentum_stock_payload(symbol: str) -> dict:
    """The stock drawer's own data (BL-049): price with its 40-week average, score history and
    rank history for one stock. Fetched when the drawer opens, so the page's own payload stays
    small."""
    try:
        universe = DATA.get_momentum_universe()
    except ValueError as error:
        raise HTTPException(422, str(error)) from None
    detail = momentum_scores_mod.stock_detail(universe, symbol)
    if detail is None:
        raise HTTPException(404, f"{symbol} is not scored this week.")
    return detail


def _momentum_stock_circuits_payload(symbol: str) -> dict:
    """The circuit locks one stock sat through in the last 52 weeks (BL-049 Phase 3). Its own
    endpoint, fetched after the drawer's history: it reads the daily bars, which the page's own
    payload and the history never touch."""
    try:
        universe = DATA.get_momentum_universe()
    except ValueError as error:
        raise HTTPException(422, str(error)) from None
    if momentum_scores_mod.live_column(universe, symbol) is None:
        raise HTTPException(404, f"{symbol} is not scored this week.")
    try:
        return circuit_exposure_mod.stock_circuit_locks(symbol, universe.frame.index[-1])
    except FileNotFoundError:
        raise HTTPException(503, "The research database has no daily stock bars yet.") from None


def _run_broad(
    req: BacktestRequest,
    ranking: broad.UniverseRanking,
    outer_prices: pd.DataFrame,
) -> broad.BroadBacktestResult:
    weights = tuple(req.weights) if req.weights else None
    stock_tilt_ranks = None
    if req.broad_reversal_tilt > 0:
        stock_tilt_ranks = DATA.get_broad_tilt_ranks(
            ranking, tuple(req.lookbacks), req.broad_reversal_tilt, req.broad_reversal_screen_pct
        )
    uc_locked = lc_locked = None
    if req.broad_respect_circuits:
        uc_locked, lc_locked = circuit_exposure_mod.lock_masks(
            ranking.column_to_base_symbol, ranking.prices.index
        )
    return broad.run_broad_backtest(
        outer_prices=outer_prices,
        stocks_data_dir=DATA_DIR / "stocks",
        categories_data_dir=DATA_DIR / "categories",
        curated_dir=CATEGORIES_CURATED_DIR,
        category_mode=req.broad_category_mode,
        category_tags=req.broad_category_tags,
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
        rebalance_every=req.rebalance_every,
        rebalance_offset=req.rebalance_offset,
        sell_every_week=req.sell_every_week,
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
        min_ranked=1 if req.broad_every_week else 0,
        stock_tilt=req.broad_reversal_tilt,
        stock_tilt_screen_pct=req.broad_reversal_screen_pct,
        stock_tilt_ranks=stock_tilt_ranks,
        uc_locked=uc_locked,
        lc_locked=lc_locked,
    )


def _circuit_realism(
    req: BacktestRequest,
    ranking: broad.UniverseRanking,
    outcome: broad.BroadBacktestResult,
    outer_prices: pd.DataFrame,
) -> dict:
    """The same run with circuit locks ignored and with them respected, so the cost of locks is
    visible whichever way this run was set. Costs one extra engine pass (ranking is cached).
    `outer_prices` is what the run itself used: this can be asked for after the run, when newer
    data may have been loaded."""

    def summary(result: Result) -> dict:
        equity = result.equity
        return {
            "cagr": float(metrics.cagr(equity)),
            "max_drawdown": float(metrics.max_drawdown(equity)[0]),
            "total_return": float(equity.iloc[-1] - 1),
            "trades": int(len(result.trades)),
        }

    other = _run_broad(
        req.model_copy(update={"broad_respect_circuits": not req.broad_respect_circuits}),
        ranking,
        outer_prices,
    )
    this_run, alternative = summary(outcome.result), summary(other.result)
    ignoring, respecting = (
        (alternative, this_run)
        if req.broad_respect_circuits
        else (
            this_run,
            alternative,
        )
    )
    return {
        "this_run_respects_locks": req.broad_respect_circuits,
        "ignoring_locks": ignoring,
        "respecting_locks": respecting,
        "cagr_impact": respecting["cagr"] - ignoring["cagr"],
    }


#: Universes that are only meaningful behind the tradability gate: the whole market (the gate is
#: what narrows it) and the point-in-time turnover rank (every search that used it gated).
GATED_BROAD_UNIVERSES = ("all_liquid", "turnover_rank")


def _liquidity_config(req: BacktestRequest) -> liquidity_mod.LiquidityConfig | None:
    """The request's liquidity gate, or None when it's off (the original, ungated pool)."""
    if not (req.broad_liquidity_filter or req.broad_universe in GATED_BROAD_UNIVERSES):
        return None
    return liquidity_mod.LiquidityConfig(
        min_turnover_cr=req.broad_liq_min_turnover_cr,
        floor_ratio=req.broad_liq_floor_ratio,
        min_price=req.broad_liq_min_price,
        circuit=req.broad_liq_circuit,
        circuit_run=req.broad_liq_circuit_run,
        max_circuit_days=req.broad_liq_max_circuit_days,
    )


def _broad_ranking(req: BacktestRequest) -> broad.UniverseRanking:
    """Step 2 for this request's ranking-side settings (cached by `DATA.get_broad_ranking`)."""
    return DATA.get_broad_ranking(
        lookbacks=tuple(req.lookbacks),
        weights=tuple(req.weights) if req.weights else None,
        score=req.score,
        voladj_skip_recent_month=req.voladj_skip_recent_month,
        pool_top_n=req.broad_pool_top_n,
        pool_exit_rank=req.broad_pool_exit_rank,
        liquidity=_liquidity_config(req),
        universe_kind=req.broad_universe,
        series_breaks=req.broad_series_breaks,
    )


def _broad_backtest(req: BacktestRequest) -> dict:
    return _full(*_broad_parts(req))


def _broad_parts(req: BacktestRequest, report: Report = _no_report) -> Parts:
    report("loading")
    on = req.broad_category_mode == "on"
    if on and req.broad_category_top_n > req.broad_category_exit_rank:
        raise HTTPException(422, "Category top N can't be greater than the category exit rank.")
    if not on and req.broad_off_top_n > req.broad_off_exit_rank:
        raise HTTPException(422, "Top N can't be greater than the exit rank.")
    if req.broad_pool_top_n > req.broad_pool_exit_rank:
        raise HTTPException(422, "Pool top N can't be greater than the pool exit rank.")
    if req.weights is not None and len(req.weights) != len(req.lookbacks):
        raise HTTPException(422, "Give one weight per lookback.")
    if not (
        db_read.has_total_market_data()
        or (DATA_DIR / "categories" / broad.TOTAL_MARKET_MEMBERSHIP_FILENAME).exists()
    ):
        raise HTTPException(409, "No Total Market data yet - run `mbt categories fetch-universe`.")

    try:
        report("ranking")  # ~20 s the first time for a set of ranking settings, then cached
        ranking = _broad_ranking(req)
        outer_prices = DATA.get()
        report("simulating")
        outcome = _run_broad(req, ranking, outer_prices)
        DATA.trim_cache()
    except (ValueError, broad.TotalMarketDataNotFoundError) as error:
        raise HTTPException(422, str(error)) from None

    result = outcome.result
    prices = outcome.ranking.prices
    prices = prices.assign(**{CASH: DATA.get().reindex(prices.index)[CASH]})
    groups = dict.fromkeys(prices.columns, "Stock")
    for name in broad.ATOMIC_NAMES:
        groups[name] = "Atomic"
    report("analysing")
    core, lazy = analysis.payload_parts(
        result,
        prices,
        result.config,
        groups,
        share_prices=True,
        references=DATA.references(),
    )
    # Always present (empty list for category_mode="off", where there is no category layer at
    # all) - a consistent response shape the frontend can rely on regardless of mode.
    group_members = (
        broad.load_stock_groups(
            CATEGORIES_CURATED_DIR, extended=req.broad_category_tags == "extended"
        )
        if on
        else {}
    )
    core["held_categories"] = broad.current_holdings_detail(
        outcome,
        group_members,
        category_top_n=req.broad_category_top_n,
        picks_per_category=req.broad_picks_per_category,
    )
    core["missing_symbols"] = outcome.ranking.missing_symbols
    base_trades = lazy["trades"]

    def trades() -> object:
        rows = base_trades()
        # Fill blank exit ranks and say WHY a holding was sold when it simply stopped being
        # ranked (liquidity gate, left the pool, lost its category). Display-only; never fails
        # the run.
        with contextlib.suppress(Exception):
            exit_reasons_mod.explain_exits(
                rows,
                ranking=outcome.ranking,
                held_by_week=outcome.held_by_week,
                group_members=group_members,
                signal_delay=req.signal_delay,
                pool_exit_rank=req.broad_pool_exit_rank,
                picks_per_category=req.broad_picks_per_category,
                liquidity_cfg=_liquidity_config(req),
            )
        return rows

    def circuit_exposure() -> object:
        # Display-only "worst LC/UC you'd have walked into" card; never allowed to fail the run.
        # Built when the card is opened, so it reads the daily bars (and the lock masks the
        # opposite-setting run needs) from the database as they are THEN: only the weekly prices
        # are held from the run. A Friday ingest in between can therefore move it slightly.
        try:
            exposure = circuit_exposure_mod.circuit_exposure(
                result, outcome.ranking.column_to_base_symbol
            )
        except Exception:  # noqa: BLE001
            return None
        if exposure is not None:
            # The comparison is optional: if its second run fails, keep the rest of the card.
            with contextlib.suppress(Exception):
                exposure["realism"] = _circuit_realism(req, ranking, outcome, outer_prices)
        return exposure

    return core, {**lazy, "trades": trades, "circuit_exposure": circuit_exposure}


def _outer_with_sentinel(week: pd.Timestamp, sentinel: pd.Timestamp) -> pd.DataFrame:
    """The outer-market prices (CASH and the atomic assets) with `week` present and a flat
    `sentinel` week after it, to match a ranking from `rebalance.persisted_broad_ranking`."""
    outer = DATA.get().copy()
    if week not in outer.index:
        available = outer.loc[outer.index <= week]
        if available.empty:
            raise ValueError("No persisted outer-market data for the preview week.")
        outer.loc[week] = available.iloc[-1]
    outer.loc[sentinel] = outer.loc[week]
    return outer


def _broad_sentinel_run(req: BacktestRequest) -> tuple[broad.BroadBacktestResult, pd.Timestamp]:
    """Run Broad on the stored data PLUS one flat sentinel week after the newest stored week, so
    the engine - which never trades its newest week - decides the newest real one with every
    rule it has: rebalance cadence and phase, sell_every_week, signal delay, the price ceiling,
    the 52-week-low guard, circuit locks. Returns the outcome and that decision week."""
    ranking = _broad_ranking(req)
    week = ranking.prices.index[-1]
    sentinel = week + pd.Timedelta(days=7)
    outcome = _run_broad(
        req.model_copy(update={"end": sentinel.strftime("%Y-%m-%d")}),
        rebalance.persisted_broad_ranking(ranking),
        _outer_with_sentinel(week, sentinel),
    )
    return outcome, week


def _model_holdings_or_idle(result: Result, week: pd.Timestamp) -> dict[str, float]:
    """`rebalance.model_holdings`, except that a week the engine holds nothing (it writes no
    weights row for one) is all idle cash rather than an error."""
    if week in result.weights.index:
        return rebalance.model_holdings(result, week)
    return {IDLE: 1.0}


def _broad_engine_signal(req: BacktestRequest) -> dict:
    """This week's Broad signal as the engine itself would trade it (BL-010 Phase 6): same shape
    as `analysis.latest_signal` (`week`, `rows`, `explain`), plus `target_weights`, the model's
    portfolio after the week's trades. `analysis.latest_signal` is an advisory panel that does
    not know the cadence, `sell_every_week`, the price ceiling or the circuit locks, so on a
    4-weekly strategy it recommended trades the engine would not make on 3 weeks in 4."""
    outcome, week = _broad_sentinel_run(req)
    result = outcome.result
    ranking = outcome.ranking
    trades = result.trades
    acted = trades[trades["week"] == week] if len(trades) else trades
    actions: dict[str, tuple[str, str]] = {}
    for trade in acted.itertuples():
        if trade.asset not in (CASH, IDLE):
            actions[trade.asset] = (str(trade.action), str(trade.reason))

    # The engine records no weights row for a week it holds nothing, so "before" is the previous
    # week's row only if there is one.
    earlier = result.equity.index[result.equity.index < week]
    previous = earlier[-1] if len(earlier) else None
    held_before = (
        {n for n, w in result.weights.loc[previous].items() if n != IDLE and w > 1e-9}
        if previous is not None and previous in result.weights.index
        else set()
    )
    ranks, scores = result.ranks.loc[week], result.scores.loc[week]
    history = ranking.prices.loc[:week]
    returns = {
        k: history.iloc[-1] / history.iloc[-1 - k] - 1 for k in req.lookbacks if len(history) > k
    }
    rows = []
    for name in dict.fromkeys([*result.ranked_names, *actions]):
        action, reason = actions.get(name, ("HOLD" if name in held_before else "", ""))
        rows.append(
            {
                "asset": name,
                "rank": ranks.get(name),
                "score": scores.get(name),
                "returns": {str(k): r.get(name) for k, r in returns.items()},
                "held": name in held_before,
                "action": action,
                "reason": reason,
            }
        )
    rows.sort(key=lambda r: (pd.isna(r["rank"]), r["rank"] if pd.notna(r["rank"]) else 0))

    if req.rebalance == "weekly" and req.rebalance_every > 1:
        on_cadence = bool(cadence_weeks([week], req.rebalance_every, req.rebalance_offset))
        explain = (
            f"Rebalance week (every {req.rebalance_every} weeks, phase {req.rebalance_offset})."
            if on_cadence
            else f"Not a rebalance week (every {req.rebalance_every} weeks, phase "
            f"{req.rebalance_offset}): "
            + (
                "only sells of names that dropped out are made."
                if req.sell_every_week
                else "no trades."
            )
        )
    else:
        explain = "Rebalance week."
    if req.signal_delay:
        explain += f" With a {req.signal_delay}-week signal delay, the ranks shown are that old."
    return analysis._clean(
        {
            "week": week,
            "rows": rows,
            "explain": explain,
            "target_weights": {
                name: round(weight, 4)
                for name, weight in _model_holdings_or_idle(result, week).items()
            },
        }
    )


def rebalance_preview(req: RebalanceRequest, *, now: datetime | None = None) -> dict:
    """Always-available, read-only target versus user holdings.

    Market hours prefer a temporary Fyers LTP row. At every other time (and when
    live credentials or quotes are unavailable), the latest persisted strategy week
    and trade closes are used without pretending those prices are live.
    """
    now = (now or datetime.now(IST)).astimezone(IST)
    if req.dataset not in ("stock", "broad"):
        raise HTTPException(422, "Rebalance preview supports Stock and Broad Momentum.")
    if req.weights is not None and len(req.weights) != len(req.lookbacks):
        raise HTTPException(422, "Give one weight per lookback.")
    if any(value < 0 or value > 100 for value in req.holdings_pct.values()):
        raise HTTPException(422, "Holding weights must be percentages between 0 and 100.")
    if sum(req.holdings_pct.values()) > 100.0001:
        raise HTTPException(422, "Current holding percentages total more than 100%.")

    first_allocation = not any(
        name != IDLE and weight > 1e-6 for name, weight in req.holdings_pct.items()
    )

    def model_request(week: pd.Timestamp, settlement_week: pd.Timestamp):
        updates: dict[str, object] = {"end": settlement_week.strftime("%Y-%m-%d")}
        if first_allocation:
            # A first allocation has no history to inherit: replay only the signal week so the
            # target is the current top-N split equally, not weights drifted by past buys.
            # Trade immediately, whatever the cadence phase.
            updates.update(
                start=week.strftime("%Y-%m-%d"),
                rebalance="weekly",
                rebalance_every=1,
                rebalance_offset=0,
            )
        schedule = None
        if req.strategy_start_date is not None:
            schedule = rebalance.operational_rebalance_schedule(
                week.date(),
                strategy_start=req.strategy_start_date,
                rebalance_kind=req.rebalance,
                every=req.rebalance_every,
            )
            offset = schedule["effective_rebalance_offset"]
            if not first_allocation and req.rebalance == "weekly" and isinstance(offset, int):
                updates["rebalance_offset"] = offset
        return req.model_copy(update=updates), schedule

    live = now.weekday() < 5 and time(9, 15) <= now.time() <= time(15, 30)
    creds = None
    if live:
        load_repo_env()
        try:
            creds = fyers.resolve_credentials(prefer_dashboard=req.auth_source == "dashboard")
        except fyers.FyersCredentialsError:
            live = False

    try:
        if req.dataset == "stock":
            stock = DATA.get_stock()
            unknown = (
                set(req.holdings_pct) - set(stock.companies) - set(stock.extra_instruments) - {IDLE}
            )
            if unknown:
                raise ValueError(f"Unknown holding identifiers: {', '.join(sorted(unknown))}.")
            if live:
                try:
                    quotes = rebalance.quote_stock_universe(
                        stock, req.universe, req.holdings_pct, now.date(), creds
                    )
                    prices, membership, ltp, symbols = rebalance.live_stock_prices(
                        stock, req.universe, req.holdings_pct, quotes, now.date()
                    )
                    week = rebalance.signal_week(now.date())
                except (fyers.FyersCredentialsError, RuntimeError, ValueError):
                    live = False
            if not live:
                week = stock.prices.index[-1]
                prices = stock.prices.copy()
                membership = stock.membership.copy()
                ltp, symbols = rebalance.persisted_stock_prices(
                    stock, req.universe, req.holdings_pct, week.date()
                )
            settlement_week = week + pd.Timedelta(days=7)
            prices.loc[settlement_week] = prices.loc[week]
            membership.loc[settlement_week] = membership.loc[week]
            model_req, schedule = model_request(week, settlement_week)
            config = Config(**_config_kwargs(model_req))
            outcome = rebalance.stock_target(stock, prices, membership, config)
            target = rebalance.model_holdings(outcome, week)
        else:
            if (
                req.broad_category_mode == "on"
                and req.broad_category_top_n > req.broad_category_exit_rank
            ):
                raise ValueError("Category top N can't exceed category exit rank.")
            ranking = _broad_ranking(req)
            symbol_map = rebalance.broad_quote_symbols(ranking)
            unknown = set(req.holdings_pct) - set(symbol_map) - {IDLE}
            if unknown:
                raise ValueError(f"Unknown or inactive holdings: {', '.join(sorted(unknown))}.")
            # Quoting every listed stock is intentionally avoided for the whole-market
            # universe. Its preview remains available from the latest database close.
            if live and req.broad_universe in GATED_BROAD_UNIVERSES:
                live = False
            if live:
                try:
                    quotes = fyers.quotes(sorted(set(symbol_map.values())), creds)
                    config = Config(
                        lookbacks=tuple(req.lookbacks),
                        weights=tuple(req.weights) if req.weights else None,
                        score=req.score,
                        voladj_skip_recent_month=req.voladj_skip_recent_month,
                    )
                    preview_ranking, ltp, symbols = rebalance.live_broad_ranking(
                        ranking,
                        quotes,
                        now.date(),
                        config,
                        pool_top_n=req.broad_pool_top_n,
                        pool_exit_rank=req.broad_pool_exit_rank,
                        liquidity=_liquidity_config(req),
                        universe_kind=req.broad_universe,
                        series_breaks=req.broad_series_breaks,
                    )
                    week = rebalance.signal_week(now.date())
                except (fyers.FyersCredentialsError, RuntimeError, ValueError):
                    live = False
            if not live:
                week = ranking.prices.index[-1]
                preview_ranking = rebalance.persisted_broad_ranking(ranking)
                ltp, symbols = rebalance.persisted_broad_prices(ranking, week.date())
            settlement_week = week + pd.Timedelta(days=7)
            model_req, schedule = model_request(week, settlement_week)
            outer = _outer_with_sentinel(week, settlement_week)
            outcome = _run_broad(model_req, preview_ranking, outer).result
            target = rebalance.model_holdings(outcome, week)
        current = dict(req.holdings_pct)
        current[IDLE] = current.get(IDLE, 0.0) + max(0.0, 100 - sum(current.values()))
        rows = rebalance.build_plan(
            current,
            target,
            ltp,
            symbols,
            req.portfolio_value,
            allow_missing_prices=not live,
        )
    except (ValueError, KeyError, broad.TotalMarketDataNotFoundError) as error:
        raise HTTPException(422, str(error)) from None
    except FileNotFoundError as error:
        raise HTTPException(409, str(error)) from None
    price_mode = "live" if live else "last_close"

    return {
        "dataset": req.dataset,
        "as_of": now.isoformat(timespec="seconds") if live else week.strftime("%Y-%m-%d"),
        "signal_week": week.strftime("%Y-%m-%d"),
        "price_mode": price_mode,
        "price_source": "Fyers last traded price" if live else "Latest database close",
        "portfolio_value": req.portfolio_value,
        "first_allocation": first_allocation,
        "rebalance_schedule": schedule,
        "current_pct": current,
        "target_pct": {name: round(weight * 100, 4) for name, weight in target.items()},
        "rows": rows,
        "note": (
            (
                "No invested holdings were supplied, so this is a first allocation. "
                if first_allocation
                else ""
            )
            + "Model target uses the strategy's simulated historical holdings. "
            "Your supplied weights determine the difference. "
            + (
                "Live Fyers prices were used. "
                if live
                else "This is an as-of preview using persisted closes, not live prices. "
            )
            + "Quantities are indicative whole shares; "
            "fees, taxes and live order-book liquidity are not included. No orders were placed."
        ),
    }


def _no_active_signal_notification(
    run: str, outcomes: list[dict], active: dict | None
) -> Notification:
    """A4: the active favourite produced no signal — tell someone, instead of the old silent
    "Telegram was not sent" that only a human reading the log would ever catch."""
    if active is None:
        return Notification(
            "momentum-weekly",
            "warn",
            f"Momentum {run}: no active favourite selected",
            "No saved favourite is marked active, so there is nothing to send to Telegram. "
            "Mark one active in the dashboard's Saved strategies list.",
            type="momentum.problem",
        )
    reasons = "\n".join(
        f"• {outcome['name']}: {outcome['blocked']}" for outcome in outcomes if outcome["blocked"]
    )
    return Notification(
        "momentum-weekly",
        "warn",
        f"Momentum {run}: active favourite could not produce a signal",
        f"'{active['name']}' is the active favourite but is blocked this week.\n\n"
        + (reasons or "No reason was recorded.")
        + "\n\nNo trade signal was sent to Telegram.",
        type="momentum.problem",
    )


def _journal_entries(
    run: str,
    outcomes: list[dict],
    favorites_by_id: dict[str, dict],
    now: datetime,
    target_week: pd.Timestamp | None,
) -> tuple[list, list[str]]:
    """BL-024: one forward-journal entry per signal this run produced, plus the benchmark level
    on a final run. Returns (entries, notes). Everything is read here, before the journal's
    write connection opens: DuckDB refuses a read-only connection in the same process while a
    read-write one is open."""
    from . import forward_journal as journal

    notes: list[str] = []
    # A preview is the signal traded at Friday's close; one taken on any other day is a
    # dashboard what-if, not a record of what would have been traded.
    if run == "preview" and now.weekday() != 4:
        return [], [f"preview on a {now:%A}: not journalled (only Friday previews are)"]
    commit = journal.code_commit()
    closes = journal.file_fingerprint(DATA_DIR / "weekly_closes.csv")
    stock_prices: str | None = None
    broad_snapshot: tuple[dict | None] | None = None
    entries = []
    for outcome in outcomes:
        result = outcome["result"]
        # A group is journalled through its members, one entry each (BL-051).
        if result is None or result.signal is None or outcome.get("group"):
            continue
        signal = result.signal
        favorite = favorites_by_id.get(outcome["id"])
        settings = favorite["config"] if favorite else signal.get("config", {})
        if outcome["dataset"] == "etf":
            fingerprint = f"weekly_closes:{closes}"
        elif outcome["dataset"] == "broad":
            # Broad ranks the lake's stocks, not the Nifty-50 weekly frame.
            broad_snapshot = broad_snapshot or (search.data_snapshot(),)
            universe = settings.get("broad_universe", "total_market")
            fingerprint = f"weekly_closes:{closes};" + journal.broad_fingerprint(
                broad_snapshot[0], universe
            )
        else:
            stock_prices = stock_prices or journal.frame_fingerprint(DATA.get_stock().prices)
            fingerprint = f"weekly_closes:{closes};stock_prices:{stock_prices}"
        entries.append(
            journal.Entry(
                week=journal.week_string(signal["week"]),
                run_kind=run,
                source="favourite",
                config_id=outcome["id"] or "default-live",
                config_name=outcome["name"],
                dataset=outcome["dataset"],
                settings=settings,
                holdings_before=signal.get("weights", {}),
                signal=journal.compact_signal(signal),
                data_fingerprint=fingerprint,
                code_commit=commit,
            )
        )
    if run == "final" and target_week is not None:
        # The benchmark is a level to measure returns from, not a portfolio: recorded only once
        # its data reaches this week (the 19:30 stock-ingest run, not the 16:45 one).
        level = reference_benchmarks.load_references().get(NIFTY200_MOMENTUM30_TRI)
        level = level.dropna().loc[:target_week] if level is not None else None
        if level is None or level.empty or level.index[-1] <= target_week - pd.Timedelta(days=7):
            notes.append(f"{NIFTY200_MOMENTUM30_TRI}: no level for this week yet")
        else:
            entries.append(
                journal.Entry(
                    week=journal.week_string(target_week),
                    run_kind=run,
                    source="benchmark",
                    config_id=NIFTY200_MOMENTUM30_TRI,
                    config_name=NIFTY200_MOMENTUM30_TRI,
                    dataset="benchmark",
                    settings={"benchmark": NIFTY200_MOMENTUM30_TRI},
                    holdings_before={NIFTY200_MOMENTUM30_TRI: 1.0},
                    signal={
                        "level": float(level.iloc[-1]),
                        "level_week": journal.week_string(level.index[-1]),
                    },
                    data_fingerprint=f"level:{float(level.iloc[-1])!r}",
                    code_commit=commit,
                )
            )
    return entries, notes


def _journal_weekly(
    run: str,
    outcomes: list[dict],
    favorites_by_id: dict[str, dict],
    now: datetime,
    target_week: pd.Timestamp | None,
) -> dict:
    """Record this run's signals in the forward journal. Never raises: a journal failure must not
    cost the week's signal, and it is reported (see `_journal_line`), never swallowed."""
    from . import forward_journal as journal

    try:
        entries, notes = _journal_entries(run, outcomes, favorites_by_id, now, target_week)
        recorded = []
        with open_catalog() as con:
            for entry in entries:
                if journal.record(con, entry) is not None:
                    recorded.append(entry.config_name)
            chain = journal.head(con)
    except Exception as error:  # reported to Telegram by the caller
        return {
            "recorded": [],
            "head": None,
            "notes": [],
            "error": f"{type(error).__name__}: {error}",
        }
    return {
        "recorded": recorded,
        "head": {"entries": chain[0], "hash": chain[1]} if chain else None,
        "notes": notes,
        "error": None,
    }


def _journal_entry_view(row: dict) -> dict:
    """One journal row for the dashboard: the stored text parsed, and the signal cut down to its
    actions (a Broad signal ranks hundreds of names; the page needs the ones it acts on)."""
    signal = json.loads(row["signal"])
    return {
        **{key: row[key] for key in row if key not in ("signal", "holdings_before", "settings")},
        "holdings_before": json.loads(row["holdings_before"]),
        "actions": [
            {"asset": r.get("asset"), "action": r.get("action"), "rank": r.get("rank")}
            for r in signal.get("rows", [])
            if r.get("action")
        ],
        "level": signal.get("level"),
    }


def _journal_view(week: str | None) -> dict:
    """GET /api/journal: the weeks recorded, one week's entries, and that week's check."""
    from . import forward_journal as journal
    from .weekly import week_ending_on_or_before

    try:
        with open_catalog(read_only=True) as con:
            if not db_read._has_table(con, journal.TABLE):
                return {"available": False, "weeks": [], "week": None, "entries": [], "check": None}
            weeks = [
                {"week": w, "entries": n}
                for w, n in con.execute(
                    f"SELECT strftime(week, '%Y-%m-%d'), count(*) FROM {journal.TABLE} "
                    "GROUP BY 1 ORDER BY 1 DESC"
                ).fetchall()
            ]
            selected = journal.week_string(
                week
                or (
                    weeks[0]["week"]
                    if weeks
                    else week_ending_on_or_before(datetime.now(IST).date())
                )
            )
            favourites = runs_store.list_favorites(con)
            entries = [_journal_entry_view(row) for row in journal.entries(con, selected)]
            check = journal.check(con, selected, favourites, (NIFTY200_MOMENTUM30_TRI,))
    except FileNotFoundError:
        return {"available": False, "weeks": [], "week": None, "entries": [], "check": None}
    return {"available": True, "weeks": weeks, "week": selected, "entries": entries, "check": check}


def _week_view(week: str | None) -> dict:
    """GET /api/week (BL-051): every favourite's signal for one week, from the journal, and the
    headline's message. Defaults to the latest Friday on or before today."""
    from . import forward_journal as journal
    from .weekly import week_ending_on_or_before

    target = journal.week_string(week_ending_on_or_before(datetime.now(IST).date()))
    selected = journal.week_string(week) if week else target
    previous = journal.week_string(pd.Timestamp(selected) - pd.Timedelta(weeks=1))
    try:
        with read_catalog() as con:
            favourites = runs_store.list_favorites(con, include_groups=True)
            groups = runs_store.list_groups(con)
            if db_read._has_table(con, journal.TABLE):
                rows = journal.entries(con, selected)
                prior = journal.entries(con, previous)
                weeks = [
                    w
                    for (w,) in con.execute(
                        f"SELECT DISTINCT strftime(week, '%Y-%m-%d') FROM {journal.TABLE} "
                        "ORDER BY 1 DESC"
                    ).fetchall()
                ]
            else:
                rows, prior, weeks = [], [], []
    except (FileNotFoundError, duckdb.CatalogException):
        favourites, groups, rows, prior, weeks = [], [], [], [], []
    return {
        "week": selected,
        "target_week": target,
        "weeks": weeks,
        "favourites": this_week.week_view(selected, rows, prior, favourites, groups),
        "message": this_week.message_for(this_week.load_messages(this_week.state_dir()), selected),
    }


def _run_live_rules_check() -> dict:
    """The live-money rules check as the Friday 21:30 job runs it, without sending, saved for
    the dashboard (BL-051)."""
    from . import live_rules
    from .weekly import week_ending_on_or_before

    report = live_rules.run_check(echo=lambda _m: None)
    severity, title, _ = live_rules.summary(report)
    # As `mbt live-rules check` does: numbers that stop short of this week are flagged stale.
    expected = str(week_ending_on_or_before(datetime.now(IST).date()))
    stale = expected if report.week is not None and report.week < expected else None
    if stale:
        severity, title = "error", "Live-rules check ran on stale data"
    live_rules.save_last(report, severity, title, this_week.state_dir(), stale=stale)
    return live_rules.load_last(this_week.state_dir()) or {}


def _journal_line(journal: dict) -> str | None:
    """The Telegram line that witnesses the journal: Telegram's own timestamp then proves how
    long the chain was, and its newest hash, when this message went out."""
    if journal["error"]:
        return (
            f"Forward journal FAILED: {journal['error']}. "
            "This week's signals may be unrecorded; rerun the job."
        )
    if not journal["recorded"]:
        return None
    count = len(journal["recorded"])
    chain = journal["head"]
    return (
        f"Forward journal: {count} new entr{'y' if count == 1 else 'ies'} recorded; "
        f"chain of {chain['entries']}, head {chain['hash'][:16]}."
    )


def _execute_weekly_run(body: WeeklyRunBody) -> dict:
    """Evaluate every favourite and send the active one; the body of a weekly job."""
    from . import notify
    from .weekly import run_favorite_strategies, week_ending_on_or_before

    try:
        creds = fyers.resolve_credentials()
    except fyers.FyersCredentialsError:
        creds = None
    with open_catalog() as con:
        favorites_by_id = {item["id"]: item for item in runs_store.list_favorites(con)}
        favourite_groups = runs_store.list_groups(con)
    # `catalog`, not an open connection: the run refreshes prices over the network and runs a
    # backtest per favourite, minutes in all, and opens the catalog only around each store.
    outcomes = run_favorite_strategies(
        body.run, DATA_DIR, creds=creds, catalog=open_catalog, log=lambda _m: None
    )
    target_week = (
        pd.Timestamp(week_ending_on_or_before(datetime.now(IST).date()))
        if body.run == "final"
        else None
    )
    if target_week is not None:
        for outcome in outcomes:
            if outcome["result"] is not None or outcome["dataset"] == "etf":
                continue
            favorite = favorites_by_id[outcome["id"]]
            try:
                outcome["result"], outcome["blocked"] = _research_weekly_result(
                    favorite, target_week
                )
            except (HTTPException, ValueError, KeyError, FileNotFoundError) as error:
                outcome["result"] = None
                outcome["blocked"] = str(getattr(error, "detail", error))
    outcomes += _group_outcomes(favourite_groups, outcomes, body.run)
    journal = _journal_weekly(body.run, outcomes, favorites_by_id, datetime.now(IST), target_week)
    journal_line = _journal_line(journal)
    active = next((outcome for outcome in outcomes if outcome["active"]), None)
    active_result = active["result"] if active is not None else None
    # B4: the Friday stock-ingest job re-runs this same orchestration after the regular
    # 16:45 final run, purely so Stock/Custom Index/Broad favourites get a chance once their
    # bhavcopy data lands. If the active favourite is an ETF strategy, that rerun has nothing
    # new to say — restricting it to the datasets it actually cares about avoids a duplicate
    # Telegram ping (or a spurious "blocked" warning for a favourite that isn't blocked, just
    # out of scope for this job).
    in_scope = body.only_if_active_dataset is None or (
        active is not None and active["dataset"] in body.only_if_active_dataset
    )
    # BL-051: a stock-based headline (Stock, Custom Index, Broad) gets its signal from the 19:30
    # stock-ingest rerun, once the bhavcopy is in. The 14:40 preview and 16:45 final cannot
    # evaluate it, and saying "blocked" twice every Friday is noise, not an alert.
    # Only when it is merely waiting for that data: a headline blocked for any other reason is
    # still reported, by every run.
    if (
        body.only_if_active_dataset is None
        and active is not None
        and active_result is None
        and active["dataset"] != "etf"
        and (active.get("awaiting_data") or _awaiting_data(active["blocked"]))
    ):
        in_scope = False
    blocked_note: Notification | None = None
    sent_main = False
    if active_result is not None:
        active_result.notification.run_url = notify.run_url()
        if body.send and in_scope:
            if journal_line:
                active_result.notification.body += f"\n\n{journal_line}"
            notify.send(active_result.notification)
            sent_main = True
    elif in_scope:
        # The silent-failure bug: previously this branch printed/returned a message but
        # never actually told anyone — a blocked active favourite meant no Telegram message
        # at all, scheduled or manual, with nothing to notice until a human went looking.
        blocked_note = _no_active_signal_notification(body.run, outcomes, active)
        if body.send:
            if journal_line:
                blocked_note.body += f"\n\n{journal_line}"
            notify.send(blocked_note)
            sent_main = True
    if body.send and journal_line and not sent_main:
        # e.g. the 19:30 stock-ingest rerun, which records the Stock/Broad favourites but does
        # not resend an ETF active favourite's signal: the new entries still need a witness.
        notify.send(
            Notification(
                "momentum-weekly",
                "error" if journal["error"] else "info",
                f"Momentum {body.run}: forward journal",
                journal_line,
                type="momentum.journal",
            )
        )
    # BL-051: keep what was (or would have been) sent, for This week's message card.
    message = (
        active_result.notification if active_result else blocked_note if blocked_note else None
    )
    if message is not None:
        # The message card is a convenience; the run has already done its job.
        with contextlib.suppress(OSError):
            this_week.save_message(
                this_week.state_dir(),
                week=(
                    journal_week_string(active_result.signal["week"])
                    if active_result is not None and (active_result.signal or {}).get("week")
                    else (journal_week_string(target_week) if target_week is not None else None)
                ),
                run=body.run,
                title=message.title,
                body=message.body,
                sent=sent_main,
                headline=active["name"] if active is not None else None,
            )
    return {
        "title": (
            active_result.notification.title
            if active_result
            else blocked_note.title
            if blocked_note
            else "Weekly strategies evaluated"
        ),
        "body": (
            active_result.notification.body
            if active_result
            else blocked_note.body
            if blocked_note
            else "Out of scope for this job; nothing sent."
        ),
        "severity": (
            active_result.notification.severity
            if active_result
            else blocked_note.severity
            if blocked_note
            else "info"
        ),
        "sent_to_telegram": body.send and in_scope,
        "signal": active_result.signal if active_result else None,
        "journal": journal,
        "strategies": [
            {
                "id": outcome["id"],
                "name": outcome["name"],
                "dataset": outcome["dataset"],
                "active": outcome["active"],
                "group": bool(outcome.get("group")),
                "blocked": outcome["blocked"],
                "title": outcome["result"].notification.title if outcome["result"] else None,
                "body": outcome["result"].notification.body if outcome["result"] else None,
                "signal": outcome["result"].signal if outcome["result"] else None,
            }
            for outcome in outcomes
        ],
    }


class _SingleFlightJob:
    """One background job at a time, executed off the request thread so the browser can
    leave the page. A second trigger while one is running attaches to it instead of racing
    a second job against the same shared files/Telegram chat. Only the latest job is kept, in
    memory - a service restart forgets it, which is fine for the weekly run (its signal is
    also saved to `momentum_signals`) and harmless for a stock sync (idempotent; just rerun
    it)."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._latest: dict | None = None

    def latest(self) -> dict | None:
        with self._lock:
            return dict(self._latest) if self._latest is not None else None

    def start(self, work: Callable[[], dict], extra_fields: dict) -> tuple[dict, bool]:
        with self._lock:
            if self._latest is not None and self._latest["status"] == "running":
                return dict(self._latest), False
            job = {
                "id": os.urandom(8).hex(),
                "status": "running",
                "started_at": datetime.now(IST).isoformat(timespec="seconds"),
                "finished_at": None,
                "result": None,
                "error": None,
                **extra_fields,
            }
            self._latest = job
            snapshot = dict(job)
        threading.Thread(target=self._execute, args=(job, work), daemon=True).start()
        return snapshot, True

    def _execute(self, job: dict, work: Callable[[], dict]) -> None:
        try:
            result, error = work(), None
        except Exception as exc:  # the job must always finish, or the UI spins forever
            result, error = None, f"{type(exc).__name__}: {getattr(exc, 'detail', exc)}"
        with self._lock:
            job["status"] = "failed" if error else "done"
            job["result"], job["error"] = result, error
            job["finished_at"] = datetime.now(IST).isoformat(timespec="seconds")


WEEKLY_JOBS = _SingleFlightJob()
LIVE_RULES_JOBS = _SingleFlightJob()
STOCK_SYNC_JOBS = _SingleFlightJob()


class _BacktestJobs:
    """Backtest runs executed off the request thread, several at once, so the browser can leave
    the page (or start a second run) while one is still computing. Unlike `_SingleFlightJob` this
    keeps many jobs, in memory (a service restart forgets them; finished runs are also saved
    server-side by the dashboard). At most `MAX_CONCURRENT` compute at a time - the work is
    CPU-bound Python, so more only makes each slower - the rest wait as `queued`. A `fresh` run
    (`DATA.reset()`) runs alone: it waits for the others to finish and holds new ones back, so it
    never wipes caches out from under a run that is mid-computation."""

    MAX_CONCURRENT = 3
    MAX_KEPT = 30
    #: Finished jobs whose sections can still be fetched. A run's builders keep its result and
    #: price frames alive, so only the newest few do; older jobs keep their core result.
    MAX_PARTS = 4

    def __init__(self) -> None:
        self._cond = threading.Condition()
        self._jobs: OrderedDict[str, dict] = OrderedDict()
        self._active = 0
        self._fresh_waiting = 0
        self._fresh_running = False
        self._finished = 0  # counts finishes, to tell which runs are the newest

    @staticmethod
    def _public(job: dict, with_result: bool) -> dict:
        view = {k: v for k, v in job.items() if k != "result" and not k.startswith("_")}
        if with_result:
            view["result"] = job["result"]
        return view

    def get(self, job_id: str) -> dict | None:
        with self._cond:
            job = self._jobs.get(job_id)
            return self._public(job, True) if job is not None else None

    def parts_for(self, job_id: str) -> tuple[str, RunParts | None]:
        """("ok", parts), or why there are none: "missing" (no such job), the job's own status
        when it has not finished successfully, or "gone" (finished, but its sections were let
        go to make room for newer runs)."""
        with self._cond:
            job = self._jobs.get(job_id)
            if job is None:
                return "missing", None
            if job["status"] != "done":
                return job["status"], None
            parts = job.get("_parts")
            return ("ok", parts) if parts is not None else ("gone", None)

    def list(self) -> list[dict]:
        """Newest first, without the (large) results."""
        with self._cond:
            return [self._public(job, False) for job in reversed(self._jobs.values())]

    def start(
        self, work: Callable[..., dict | tuple[dict, RunParts]], fresh: bool, extra_fields: dict
    ) -> dict:
        with self._cond:
            job = {
                "id": os.urandom(8).hex(),
                "status": "queued",
                "fresh": fresh,
                "started_at": datetime.now(IST).isoformat(timespec="seconds"),
                "compute_started_at": None,
                "finished_at": None,
                "result": None,
                "error": None,
                # The step a running job has reached (see `Report`); None before and after.
                "stage": None,
                "stages": list(JOB_STAGES),
                # How long the computation took, in milliseconds (the timestamps are whole seconds).
                "compute_ms": None,
                "_parts": None,
                **extra_fields,
            }
            self._jobs[job["id"]] = job
            self._evict()
            if fresh:
                self._fresh_waiting += 1
            snapshot = self._public(job, False)
        threading.Thread(target=self._execute, args=(job, work, fresh), daemon=True).start()
        return snapshot

    def _evict(self) -> None:
        """Drop the oldest finished jobs beyond MAX_KEPT (never a queued/running one)."""
        for job_id in [j for j, v in self._jobs.items() if v["status"] in ("done", "failed")]:
            if len(self._jobs) <= self.MAX_KEPT:
                break
            del self._jobs[job_id]

    def _can_run(self, fresh: bool) -> bool:
        if self._fresh_running:
            return False
        if fresh:
            return self._active == 0
        return self._active < self.MAX_CONCURRENT and self._fresh_waiting == 0

    def _execute(
        self,
        job: dict,
        work: Callable[..., dict | tuple[dict, RunParts]],
        fresh: bool,
    ) -> None:
        with self._cond:
            self._cond.wait_for(lambda: self._can_run(fresh))
            self._active += 1
            if fresh:
                self._fresh_waiting -= 1
                self._fresh_running = True
            job["status"] = "running"
            job["compute_started_at"] = datetime.now(IST).isoformat(timespec="seconds")
        began = perf_counter()
        parts = None

        def report(stage: str) -> None:
            with self._cond:
                job["stage"] = stage

        try:
            # A job that wants to say how far it has got takes `report`; a plain callable does not.
            out = work(report) if _takes_report(work) else work()
            result, parts = out if isinstance(out, tuple) else (out, None)
            error = None
        except Exception as exc:  # the job must always finish, or the UI spins forever
            result, error = None, f"{type(exc).__name__}: {getattr(exc, 'detail', exc)}"
        with self._cond:
            job["status"] = "failed" if error else "done"
            job["stage"] = None
            job["compute_ms"] = round((perf_counter() - began) * 1000)
            job["result"], job["error"], job["_parts"] = result, error, parts
            job["finished_at"] = datetime.now(IST).isoformat(timespec="seconds")
            self._finished += 1
            job["_finished"] = self._finished
            self._release_old_parts()
            self._active -= 1
            if fresh:
                self._fresh_running = False
            self._cond.notify_all()

    def _release_old_parts(self) -> None:
        """Keep the sections of the `MAX_PARTS` jobs that finished most recently. Ordered by when
        they finished, not started: a slow run that ends last is the newest."""
        holders = sorted(
            (j for j in self._jobs.values() if j.get("_parts") is not None),
            key=lambda j: j["_finished"],
        )
        for job in holders[: max(0, len(holders) - self.MAX_PARTS)]:
            job["_parts"] = None


BACKTEST_JOBS = _BacktestJobs()


def _execute_stock_sync() -> dict:
    """B4: incremental bhavcopy fetch + shared-DB migrate, triggerable from the dashboard's
    Data panel instead of waiting for the Friday 19:30 IST job or a terminal. Calls the CLI's
    `stocks_sync` directly (same code the `mbt stocks sync` command and the launchd job run)
    rather than a second implementation."""
    from .cli import stocks_sync

    stocks_sync()
    return {"ok": True}


_SCHEDULED_RUNS = (
    # (run, label, scheduled hour, scheduled minute, log filename) — the hour/minute are
    # launchd's StartCalendarInterval values from the matching plist, used for B5's
    # "ran late" flag (see _schedule_entry below).
    ("preview", "Fri 14:40 IST", 14, 40, "launchd-weekly-preview.log"),
    ("final", "Fri 16:45 IST", 16, 45, "launchd-weekly-final.log"),
    ("stock-ingest", "Fri 19:30 IST", 19, 30, "launchd-weekly-stock-ingest.log"),
    ("journal-check", "Fri 21:00 IST", 21, 0, "launchd-weekly-journal-check.log"),
    ("live-rules", "Fri 21:30 IST", 21, 30, "launchd-weekly-live-rules.log"),
)
#: The scheduler's job id for each scheduled run (`apps/scheduler/src/jobs.ts`).
_SCHEDULER_JOB_IDS = {
    "preview": "momentum-preview",
    "final": "momentum-final",
    "stock-ingest": "momentum-stock-ingest",
    "journal-check": "momentum-journal-check",
    "live-rules": "momentum-live-rules",
}


def _scheduler_last_runs() -> dict[str, tuple[str | None, int | None]]:
    """(ended_at, exit_code) of each job's latest run in the scheduler's own history
    (`apps/scheduler`, SQLite at SCHEDULER_STATE_DIR), read-only. A log file's time moves when a
    run fails too, so only the exit code says whether it worked. Empty when there is none."""
    import sqlite3

    root = os.environ.get("SCHEDULER_STATE_DIR", "").strip() or str(
        Path.home() / "Library" / "Application Support" / "ai-trading-agent"
    )
    path = Path(root) / "scheduler.db"
    if not path.exists():
        return {}
    try:
        with contextlib.closing(sqlite3.connect(f"file:{path}?mode=ro", uri=True, timeout=2)) as db:
            rows = db.execute(
                "SELECT job, ended_at, exit_code FROM runs r WHERE id = "
                "(SELECT max(id) FROM runs WHERE job = r.job)"
            ).fetchall()
    except sqlite3.Error:
        return {}
    return {job: (ended, code) for job, ended, code in rows}


# A scheduled job fired more than this many minutes after its scheduled time (typically the
# laptop was asleep, per TODO.md 3.11.5's launchd caveat) is flagged "ran late" rather than
# silently treated as on time.
_LATE_THRESHOLD_MINUTES = 10


def _weekly_status(today: date | None = None) -> dict:
    """How far each weekly input has been ingested, the last saved signals, and when the
    scheduled jobs last ran - what the dashboard needs to explain a blocked strategy."""
    from .weekly import week_ending_on_or_before

    today = today or datetime.now(IST).date()
    target = pd.Timestamp(week_ending_on_or_before(today))

    def dataset(key: str, label: str, through, note: str, error: str | None = None) -> dict:
        return {
            "key": key,
            "label": label,
            "through": through.strftime("%Y-%m-%d") if through is not None else None,
            "ready": through is not None and through.normalize() >= target,
            "note": note,
            "error": error,
        }

    datasets = []
    try:
        datasets.append(
            dataset(
                "etf",
                "Index & ETF prices",
                DATA.get().index[-1],
                "Refreshed automatically by every weekly run (Fyers + public sources).",
            )
        )
    except HTTPException as error:
        datasets.append(
            dataset("etf", "Index & ETF prices", None, "Run `mbt fetch`.", str(error.detail))
        )
    stock_note = (
        "Used by Stock, Custom Index and Broad strategies. Refreshed automatically Fri "
        "19:30 IST, or update now with `mbt stocks sync` / the Data panel's refresh button."
    )
    try:
        datasets.append(
            dataset("stock", "NSE bhavcopy stock data", DATA.get_stock().last_week, stock_note)
        )
    except HTTPException as error:
        datasets.append(
            dataset("stock", "NSE bhavcopy stock data", None, stock_note, str(error.detail))
        )

    try:
        with read_catalog() as con:
            # epoch() rather than the TIMESTAMPTZ itself: returning a TIMESTAMPTZ to Python
            # makes DuckDB import pytz, which this package does not depend on.
            rows = con.execute(
                "SELECT week, run_kind, config_label, payload, epoch(generated_at) "
                "FROM momentum_signals ORDER BY generated_at DESC LIMIT 6"
            ).fetchall()
    except (FileNotFoundError, duckdb.CatalogException):  # no catalog / table yet: no signals
        rows = []
    signals = [
        {
            "week": f"{week:%Y-%m-%d}",
            "run": run_kind,
            # B6: prefer the saved favourite's name (display_name, since 2026-10-02) over the
            # engine's config-derived label; older rows saved before that have no
            # display_name, so label remains the fallback.
            "label": json.loads(payload).get("display_name", label),
            "generated_at": datetime.fromtimestamp(generated, IST).isoformat(timespec="seconds"),
        }
        for week, run_kind, label, payload, generated in rows
    ]

    schedule = []
    scheduler_runs = _scheduler_last_runs()
    for run, when, hour, minute, log_name in _SCHEDULED_RUNS:
        log = DATA_DIR / log_name
        last_ran_at = last_line = None
        ran_late_by_minutes = None
        if log.exists():
            ran_at = datetime.fromtimestamp(log.stat().st_mtime, IST)
            last_ran_at = ran_at.isoformat(timespec="seconds")
            lines = [line for line in log.read_text(errors="replace").splitlines() if line.strip()]
            last_line = lines[-1] if lines else None
            # B5: launchd only fires while the Mac is awake, so a run the schedule missed
            # fires late on wake with no catch-up marker of its own — this is the only way
            # to tell "ran on time" from "ran late because the laptop was asleep".
            scheduled_at = ran_at.replace(hour=hour, minute=minute, second=0, microsecond=0)
            delay = (ran_at - scheduled_at).total_seconds() / 60
            if delay > _LATE_THRESHOLD_MINUTES:
                ran_late_by_minutes = round(delay)
        ended_at, exit_code = scheduler_runs.get(_SCHEDULER_JOB_IDS[run], (None, None))
        schedule.append(
            {
                "run": run,
                "when": when,
                "last_ran_at": last_ran_at,
                "last_line": last_line,
                "ran_late_by_minutes": ran_late_by_minutes,
                # BL-051: the scheduler's verdict on its latest run of this job (None: unknown).
                "last_exit_code": exit_code,
                "last_exit_at": ended_at,
            }
        )

    return {
        "today": today.isoformat(),
        "target_week": target.strftime("%Y-%m-%d"),
        "datasets": datasets,
        "signals": signals,
        "schedule": schedule,
    }


def _rebalance_info(req: BacktestRequest, week: pd.Timestamp) -> dict:
    """Whether `week` is a rebalance week for this config, and the next one (BL-051)."""
    every = req.rebalance_every if req.rebalance == "weekly" else 1
    offset = req.rebalance_offset if every > 1 else 0
    if req.rebalance != "weekly":
        return {"on_cadence": True, "every": None, "offset": None, "next": None}
    week = pd.Timestamp(week).normalize()
    upcoming = [week + pd.Timedelta(weeks=k) for k in range(1, every + 1)]
    following = next(w for w in upcoming if cadence_weeks([w], every, offset))
    return {
        "on_cadence": bool(cadence_weeks([week], every, offset)),
        "every": every,
        "offset": offset,
        "next": following.strftime("%Y-%m-%d"),
    }


#: Reasons a stock-based favourite has no signal yet that only mean "its data lands at 19:30".
_AWAITING_DATA = ("is not processed yet", "Weekly ingest is not yet available")


def _awaiting_data(blocked: str | None) -> bool:
    return blocked is not None and any(reason in blocked for reason in _AWAITING_DATA)


def _group_outcomes(groups: list[dict], outcomes: list[dict], run: str) -> list[dict]:
    """One outcome per favourite group, combined from its members' outcomes (BL-051). A group
    whose members did not all produce a signal in this run is blocked, naming them."""
    from .forward_journal import week_string
    from .weekly import RunResult

    by_id = {outcome["id"]: outcome for outcome in outcomes}
    combined = []
    for group in groups:
        members = [by_id.get(member["id"]) for member in group["members"]]
        missing = [
            f"{member['name']}: {(outcome or {}).get('blocked') or 'not evaluated in this run'}"
            for member, outcome in zip(group["members"], members, strict=True)
            if outcome is None or outcome["result"] is None or outcome["result"].signal is None
        ]
        result, blocked, awaiting = None, None, False
        weeks = (
            {} if missing else {o["name"]: week_string(o["result"].signal["week"]) for o in members}
        )
        if missing or not members:
            blocked = (
                f"{len(missing)} of {len(group['members'])} sleeves have no signal: "
                + "; ".join(missing)
            )
            awaiting = all(
                outcome is not None and _awaiting_data(outcome["blocked"])
                for outcome in members
                if outcome is None or outcome["result"] is None
            )
        elif len(set(weeks.values())) > 1:
            # Never present a lagging sleeve's old portfolio as this week's.
            blocked = "The sleeves' signals are for different weeks: " + ", ".join(
                f"{name} {week}" for name, week in weeks.items()
            )
        else:
            week = next(iter(weeks.values()))
            signal = groups_mod.combine(
                group,
                [{"id": o["id"], "name": o["name"], "signal": o["result"].signal} for o in members],
                week,
            )
            result = RunResult(groups_mod.notification(signal, run), signal)
        combined.append(
            {
                "id": group["id"],
                "name": group["name"],
                "dataset": group["config"].get("dataset", "etf"),
                "active": group["active"],
                "result": result,
                "blocked": blocked,
                "awaiting_data": awaiting,
                "group": True,
            }
        )
    return combined


def _research_weekly_result(favorite: dict, target_week: pd.Timestamp):
    """Evaluate one bhavcopy-backed favourite after its processed-week gate passes."""
    from .weekly import RunResult

    config = dict(favorite["config"])
    req = BacktestRequest.model_validate(config)
    stock = DATA.get_stock()
    if stock.last_week.normalize() < target_week.normalize():
        return None, (
            f"NSE bhavcopy-backed data is complete through {stock.last_week:%d %b %Y}; "
            f"the week ending {target_week:%d %b %Y} is not processed yet."
        )

    if req.dataset == "stock":
        payload = _stock_backtest(req)
    elif req.dataset == "custom_index":
        payload = _custom_index_backtest(req)
    elif req.dataset == "broad":
        payload = _broad_backtest(req)
        # The engine's own decision for this week, not the advisory panel (see its docstring).
        payload["latest"] = _broad_engine_signal(req)
    else:
        return None, f"Unsupported weekly dataset {req.dataset!r}."

    latest = payload.get("latest", {})
    rows = latest.get("rows", [])
    actionable = [
        row
        for row in rows
        if row.get("action")
        and str(row.get("action", "")).upper() not in {"HOLD", "AT CAP", "WAIT"}
    ]
    lines = [f"Strategy: {favorite['name']} · dataset: {req.dataset}"]
    if actionable:
        lines.extend(
            f"• {row.get('asset', 'Unknown')} — {row.get('action')} · rank {row.get('rank', '-')}"
            for row in actionable
        )
    else:
        lines.append("No trades this week.")
    lines.append(f"Data complete through {stock.last_week:%d %b %Y} (NSE bhavcopy).")
    # BL-024: the model portfolio at this week's close as weights of the whole portfolio, like the
    # ETF signal's `weights` - BEFORE this week's actions, which the engine never trades on its
    # newest week. The rest is idle cash.
    equity = (payload.get("series", {}).get("strategy") or [None])[-1]
    weights = {}
    if equity:
        for position in payload.get("open_positions", []):
            if position.get("value"):
                weights[position["asset"]] = round(position["value"] / equity, 4)
        idle = round(1 - sum(weights.values()), 4)
        if idle > 1e-4:
            weights[IDLE] = idle
    signal = {
        "week": latest.get("week", target_week.strftime("%Y-%m-%d")),
        "label": favorite["name"],
        "rows": rows,
        "weights": weights,
        "config": config,
        # BL-051: what a group needs to combine this sleeve with the others.
        # The engine's decision week (the newest stored one), which the rows are for.
        "rebalance": _rebalance_info(req, pd.Timestamp(latest.get("week", target_week))),
        "sleeve_value": groups_mod.sleeve_value(
            payload.get("series", {}).get("dates", []),
            payload.get("series", {}).get("strategy", []),
        ),
    }
    if latest.get("target_weights") is not None:
        signal["target_weights"] = latest["target_weights"]
    note = Notification(
        "momentum-weekly",
        "action_required" if actionable else "info",
        f"Momentum FINAL — {favorite['name']} — week of {target_week:%d %b %Y}",
        "\n".join(lines),
        type="momentum.final",
    )
    return RunResult(note, signal), None


def create_app() -> FastAPI:
    app = FastAPI(title="Momentum backtest", docs_url="/api/docs")
    # Results are 0.4-2 MB of JSON that compresses ~4x; it matters once the dashboard reaches
    # this service over the tunnel (BL-002). The Fastify proxy's fetch() decompresses for itself.
    # Level 5, not Starlette's default 9: on a real 1.8 MB Broad result level 9 took 233 ms for
    # 0.25 MB and level 6 took 69 ms for 0.26 MB, and a cached re-run pays it on every response.
    app.add_middleware(GZipMiddleware, minimum_size=1024, compresslevel=5)

    # Local direct-mode dashboard preview: the normal Fastify OAuth flow stores
    # its token in broker_tokens. This API can run without Postgres, so it
    # uses the existing 0600 mbt token cache and the same Fyers auth-code flow.
    @app.get("/api/auth/fyers/status")
    def local_fyers_status() -> dict:
        load_repo_env()
        try:
            fyers._oauth_config()
            configured = True
        except fyers.FyersCredentialsError:
            configured = False
        credentials = None
        if configured:
            try:
                # Direct-mode dashboards still share the encrypted broker_tokens
                # row whenever Postgres is available; the local 0600 cache remains
                # only as the documented no-database fallback.
                credentials = fyers.resolve_credentials(prefer_dashboard=True)
            except fyers.FyersCredentialsError:
                credentials = None
        # A token inside its date window can still be dead (revoked, or reset early).
        revoked = credentials is not None and fyers.probe_token(credentials) == "rejected"
        connected = credentials is not None and not revoked
        expires_at = credentials.expires_at if credentials else None
        if revoked:
            expires_at = datetime.now(IST)  # shows "Expired", not a countdown
        return {
            "configured": configured,
            "connected": connected,
            "degraded": not connected,
            "needsReauth": not connected,
            "expiresAt": expires_at.isoformat() if expires_at else None,
            "appId": credentials.app_id if credentials else None,
            **({"revoked": True} if revoked else {}),
        }

    @app.get("/api/auth/fyers/start")
    def local_fyers_start(handoff: str = "") -> RedirectResponse:
        load_repo_env()
        try:
            _app_id, _secret, redirect_uri = fyers._oauth_config()
        except fyers.FyersCredentialsError as error:
            raise HTTPException(503, str(error)) from None
        # `handoff` marks a request that already came back from the central start URL. When
        # FYERS_REDIRECT_URI is the dashboard itself (no Fastify server running) that URL is
        # forwarded straight back here; without the marker the two redirected forever and the
        # browser showed a blank page. A returned request runs the local flow instead.
        if os.environ.get("DATABASE_URL", "").strip() and not handoff:
            callback = urllib.parse.urlparse(redirect_uri)
            central_start = urllib.parse.urlunparse(
                (callback.scheme, callback.netloc, "/api/auth/fyers/start", "", "handoff=1", "")
            )
            return RedirectResponse(
                central_start, status_code=302, headers={"Cache-Control": "no-store"}
            )
        url, state = fyers.build_auth_url()
        now = datetime.now(IST)
        with _LOCAL_OAUTH_LOCK:
            for old_state, expiry in list(_LOCAL_OAUTH_STATES.items()):
                if expiry <= now:
                    del _LOCAL_OAUTH_STATES[old_state]
            _LOCAL_OAUTH_STATES[state] = now + timedelta(minutes=10)
        return RedirectResponse(url, status_code=302, headers={"Cache-Control": "no-store"})

    @app.get("/callback")
    @app.get("/api/auth/fyers/callback")
    def local_fyers_callback(state: str = "", auth_code: str = "", code: str = "") -> HTMLResponse:
        now = datetime.now(IST)
        with _LOCAL_OAUTH_LOCK:
            expiry = _LOCAL_OAUTH_STATES.pop(state, None)
        if not state or expiry is None or expiry <= now:
            raise HTTPException(400, "Fyers login state is missing, expired or already used.")
        actual_code = auth_code or code
        if not actual_code:
            raise HTTPException(400, "Fyers did not return an authorization code.")
        load_repo_env()
        try:
            creds = fyers.exchange_auth_code(actual_code)
            fyers.save_token(creds)
            # The dashboard card and resolve_credentials read broker_tokens first; without this
            # row a fresh login here would be invisible whenever DATABASE_URL is set.
            fyers.save_token_to_db(creds)
        except fyers.FyersCredentialsError as error:
            raise HTTPException(502, str(error)) from None
        return HTMLResponse(
            "<!doctype html><title>Fyers connected</title>"
            "<p>Fyers connected. You can return to the dashboard.</p>"
            "<script>setTimeout(() => window.close(), 1200)</script>",
            headers={"Cache-Control": "no-store"},
        )

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

    @app.get("/api/momentum-scores/stock/{symbol}")
    def momentum_scores_stock(symbol: str) -> dict:
        return _momentum_stock_payload(symbol)

    @app.get("/api/momentum-scores/stock/{symbol}/circuits")
    def momentum_scores_stock_circuits(symbol: str) -> dict:
        return _momentum_stock_circuits_payload(symbol)

    @app.get("/api/liquidity-preview")
    def liquidity_preview(
        min_turnover_cr: float = 1.0,
        floor_ratio: float = 0.25,
        min_price: float = 20.0,
        circuit: bool = True,
        circuit_run: int = 3,
        max_circuit_days: int | None = None,
        universe: Literal["total_market", "all_liquid", "turnover_rank"] = "total_market",
    ) -> dict:
        """What the Broad Momentum liquidity gate would do *right now* with these thresholds:
        how many Total Market stocks pass, and why each failing one failed. Cheap enough to call
        on every slider move (the heavy features are cached per catalog version)."""
        return _liquidity_preview_payload(
            liquidity_mod.LiquidityConfig(
                min_turnover_cr=min_turnover_cr,
                floor_ratio=floor_ratio,
                min_price=min_price,
                circuit=circuit,
                circuit_run=circuit_run,
                max_circuit_days=max_circuit_days,
            ),
            universe,
        )

    def _dispatch_parts(req: BacktestRequest, report: Report = _no_report) -> tuple[RunParts, bool]:
        """The run for this request (built, or the identical earlier one) and whether it was an
        earlier one. Nothing heavy beyond the core is built here: see run_parts.RunParts."""
        if req.fresh:
            DATA.reset()
        key = (input_version(), request_key(req))
        hit = DATA.cached_result(key)
        if hit is not None:
            return hit, True
        versions = saved_identity.versions_from_input(key[0], saved_identity.code_commit())
        builders = {
            "stock": _stock_parts,
            "broad": _broad_parts,
            "custom_index": _custom_index_parts,
        }
        core, lazy = builders.get(req.dataset, _etf_parts)(req, report)
        parts = RunParts(core, lazy, datetime.now(IST).isoformat(timespec="seconds"))
        # BL-052: what the result was computed from, so a saved run can say why it later moved.
        parts.versions = versions
        DATA.store_result(key, parts)
        return parts, False

    def _dispatch_backtest(req: BacktestRequest) -> dict:
        """The whole result, every section included: what the synchronous endpoint returns."""
        parts, hit = _dispatch_parts(req)
        return {
            **parts.full(),
            "cache": {"hit": hit, "computed_at": parts.computed_at},
            "versions": getattr(parts, "versions", None),
        }

    def _dispatch_job(req: BacktestRequest, report: Report) -> tuple[dict, RunParts]:
        """A job's result is the core plus the names of the sections still to fetch."""
        parts, hit = _dispatch_parts(req, report)
        result = {
            **parts.core,
            "cache": {"hit": hit, "computed_at": parts.computed_at},
            "versions": getattr(parts, "versions", None),
            "sections_available": list(parts.names),
        }
        return result, parts

    @app.post("/api/backtest")
    def backtest(req: BacktestRequest) -> dict:
        return _dispatch_backtest(req)

    @app.post("/api/backtest/jobs", status_code=202)
    def backtest_start_job(req: BacktestRequest) -> dict:
        """Same computation as `/api/backtest`, run in the background so the browser can leave
        the page or start more runs. Body validation (422) still happens here, up front; a failure
        during the computation lands in the job's `error`. Returns the job at once."""
        job = BACKTEST_JOBS.start(
            lambda report: _dispatch_job(req, report),
            req.fresh,
            {"dataset": req.dataset},
        )
        return {"job": job}

    @app.get("/api/backtest/jobs")
    def backtest_list_jobs() -> dict:
        return {"jobs": BACKTEST_JOBS.list()}

    @app.get("/api/backtest/jobs/{job_id}")
    def backtest_get_job(job_id: str) -> dict:
        job = BACKTEST_JOBS.get(job_id)
        if job is None:
            raise HTTPException(404, "backtest job not found (the service may have restarted)")
        return {"job": job}

    @app.get("/api/backtest/jobs/{job_id}/sections/{section}")
    def backtest_job_section(job_id: str, section: BacktestSection) -> dict:
        """One heavy part of a finished job's result (see run_parts.RunParts), built on the
        first request and kept: the same data the synchronous endpoint puts under that key."""
        state, parts = BACKTEST_JOBS.parts_for(job_id)
        if state == "missing":
            raise HTTPException(404, "backtest job not found (the service may have restarted)")
        if state == "gone":
            raise HTTPException(410, "this run's sections were released; run it again to load them")
        if state == "failed":
            raise HTTPException(409, "the run failed, so it has no sections")
        if parts is None:
            raise HTTPException(
                409, f"the run is still {state}; its sections exist once it is done"
            )
        if not parts.has(section):
            raise HTTPException(404, f"this run has no {section!r} section")
        try:
            return {"section": section, "data": parts.section(section)}
        except SectionReleased:
            raise HTTPException(
                410, "this run's sections were released; run it again to load them"
            ) from None

    @app.get("/api/saved-runs")
    def saved_runs(dataset: Literal["etf", "stock", "custom_index", "broad"] = "etf") -> list[dict]:
        # Read-only (`read_catalog`): the dashboard polls this, and a read-write connection
        # excludes every other request's (2026-10-07: `/api/meta` waited 8 s and more).
        try:
            with read_catalog() as con:
                return runs_store.list_runs(con, dataset)
        except (FileNotFoundError, duckdb.CatalogException):  # no catalog / no runs table yet
            return []

    @app.post("/api/saved-runs")
    def create_saved_run(body: SavedRunBody, background: BackgroundTasks) -> dict:
        versions = body.versions or {
            **saved_identity.versions_from_input(input_version(), saved_identity.code_commit()),
            "measured": "at_save",
        }
        with open_catalog() as con:
            record = runs_store.save_run(
                con,
                body.dataset,
                name=body.name,
                config=body.config,
                kpis=body.kpis,
                dates=body.dates,
                strategy=body.strategy,
                overlay=body.overlay,
                versions=versions,
            )
        # After the response: a slow Telegram must not hold up the dashboard's save.
        background.add_task(_alert_if_not_reproducible, record)
        return record

    @app.post("/api/saved-runs/groups")
    def create_saved_run_group(body: SavedRunGroupBody) -> dict:
        try:
            with open_catalog() as con:
                return runs_store.create_group(con, body.name, body.members)
        except runs_store.FavouriteError as error:
            raise HTTPException(409, str(error)) from error

    @app.patch("/api/saved-runs/{run_id}")
    def patch_saved_run(run_id: str, body: SavedRunUpdate) -> dict:
        try:
            with open_catalog() as con:
                record = runs_store.update_run(
                    con,
                    run_id,
                    name=body.name,
                    overlay=body.overlay,
                    favorite=body.favorite,
                    active=body.active,
                    status=body.status,
                )
        except runs_store.FavouriteError as error:
            raise HTTPException(409, str(error)) from error
        if record is None:
            raise HTTPException(404, "saved run not found")
        return record

    @app.get("/api/favorite-strategies")
    def favorite_strategies() -> list[dict]:
        """The persisted candidates for the weekly scheduler and dashboard: every favourite, and
        each group with its members' records under `members` (BL-051). The headline is first."""
        try:
            with read_catalog() as con:
                groups = {group["id"]: group for group in runs_store.list_groups(con)}
                return [
                    groups.get(record["id"], record)
                    for record in runs_store.list_favorites(con, include_groups=True)
                ]
        except (FileNotFoundError, duckdb.CatalogException):  # no catalog / no runs table yet
            return []

    @app.delete("/api/saved-runs/{run_id}")
    def remove_saved_run(run_id: str) -> dict:
        try:
            with open_catalog() as con:
                found = runs_store.delete_run(con, run_id)
        except runs_store.FavouriteError as error:
            raise HTTPException(409, str(error)) from error
        if not found:
            raise HTTPException(404, "saved run not found")
        return {"ok": True}

    # --- saved strategies (BL-052): one per set of settings, with why a result moved ---------

    @app.get("/api/saved-strategies")
    def saved_strategies(
        dataset: Literal["etf", "stock", "custom_index", "broad"] | None = None,
    ) -> dict:
        try:
            with read_catalog() as con:
                return {
                    "strategies": runs_store.list_strategies(con, dataset),
                    "unreviewed": len(runs_store.list_changes(con, unreviewed=True)),
                    # The settings each dataset never reads, so the dashboard leaves them out
                    # when it says how a strategy differs from the defaults (and names it).
                    "ignored_fields": _IGNORED_FIELDS,
                }
        except (FileNotFoundError, duckdb.CatalogException):
            return {"strategies": [], "unreviewed": 0, "ignored_fields": _IGNORED_FIELDS}

    # Registered before `/{run_id}`: the static path must not be read as a strategy id.
    @app.get("/api/saved-strategies/merge")
    def saved_strategies_merge_plan() -> dict:
        """The one-time merge as a dry run: what would be folded together. Writes nothing."""
        try:
            with read_catalog() as con:
                return runs_store.merge_plan(con)
        except (FileNotFoundError, duckdb.CatalogException):
            return {"merges": [], "conflicts": [], "runs": 0, "strategies": 0}

    @app.post("/api/saved-strategies/merge")
    def saved_strategies_merge() -> dict:
        with open_catalog() as con:
            return runs_store.apply_merge(con)

    @app.get("/api/saved-strategies/{run_id}")
    def saved_strategy(run_id: str) -> dict:
        try:
            with read_catalog() as con:
                strategy = runs_store.get_strategy(con, run_id)
        except (FileNotFoundError, duckdb.CatalogException):
            strategy = None
        if strategy is None:
            raise HTTPException(404, "saved strategy not found")
        return strategy

    @app.patch("/api/saved-strategies/{run_id}")
    def patch_saved_strategy(run_id: str, body: SavedStrategyUpdate) -> dict:
        try:
            with open_catalog() as con:
                strategy = runs_store.update_strategy(
                    con, run_id, **body.model_dump(exclude_none=True)
                )
        except runs_store.FavouriteError as error:
            raise HTTPException(409, str(error)) from error
        if strategy is None:
            raise HTTPException(404, "saved strategy not found")
        return strategy

    @app.delete("/api/saved-strategies/{run_id}")
    def remove_saved_strategy(run_id: str) -> dict:
        try:
            with open_catalog() as con:
                found = runs_store.delete_strategy(con, run_id)
        except runs_store.FavouriteError as error:
            raise HTTPException(409, str(error)) from error
        if not found:
            raise HTTPException(404, "saved strategy not found")
        return {"ok": True}

    @app.get("/api/result-changes")
    def result_changes(unreviewed: bool = False) -> dict:
        """The result-change log (BL-052), newest first; `unreviewed=true` gives the Check and Not
        reproducible changes nobody has marked reviewed."""
        try:
            with read_catalog() as con:
                return {"changes": runs_store.list_changes(con, unreviewed=unreviewed)}
        except (FileNotFoundError, duckdb.CatalogException):
            return {"changes": []}

    @app.post("/api/result-changes/{change_id}/reviewed")
    def review_result_change(change_id: str, body: ResultChangeReview) -> dict:
        with open_catalog() as con:
            change = runs_store.mark_reviewed(con, change_id, body.reviewed_by)
        if change is None:
            raise HTTPException(404, "result change not found")
        return change

    @app.post("/api/weekly/run", status_code=202)
    def weekly_run(body: WeeklyRunBody) -> dict:
        """Manual trigger for the Friday signal (TODO.md 3.11.5): the same orchestration the
        launchd-scheduled `mbt weekly` CLI runs. Starts a background job and returns at once;
        the browser polls `/api/weekly/jobs/latest`, so leaving the page loses nothing. A run
        already in progress is returned instead of starting a second one (`started: false`)."""
        job, started = WEEKLY_JOBS.start(
            lambda: _execute_weekly_run(body), {"run": body.run, "send": body.send}
        )
        return {"started": started, "job": job}

    @app.get("/api/weekly/jobs/latest")
    def weekly_latest_job() -> dict:
        """The most recent manual run since this service started (null before the first)."""
        return {"job": WEEKLY_JOBS.latest()}

    @app.get("/api/weekly/status")
    def weekly_status() -> dict:
        return _weekly_status()

    @app.get("/api/week")
    def week_view(week: date | None = None) -> dict:
        return _week_view(week.isoformat() if week else None)

    @app.get("/api/live-rules")
    def live_rules_last() -> dict:
        """The latest live-money rules check (the 21:30 job's, or one run from here)."""
        from . import live_rules

        return {
            "report": live_rules.load_last(this_week.state_dir()),
            "job": LIVE_RULES_JOBS.latest(),
        }

    @app.post("/api/live-rules/run", status_code=202)
    def live_rules_run() -> dict:
        job, started = LIVE_RULES_JOBS.start(_run_live_rules_check, {})
        return {"job": job, "started": started}

    @app.get("/api/journal")
    def forward_journal_view(week: str | None = None) -> dict:
        try:
            return _journal_view(week)
        except ValueError as error:  # an unparseable ?week=
            raise HTTPException(422, str(error)) from error

    @app.post("/api/weekly/stock-sync", status_code=202)
    def weekly_stock_sync() -> dict:
        """B4: manual 'Refresh stock data' trigger (bhavcopy fetch + shared-DB migrate) for
        the dashboard's Data panel — the same background-job pattern as `/api/weekly/run`."""
        job, started = STOCK_SYNC_JOBS.start(_execute_stock_sync, {})
        return {"started": started, "job": job}

    @app.get("/api/weekly/stock-sync/jobs/latest")
    def weekly_stock_sync_latest_job() -> dict:
        return {"job": STOCK_SYNC_JOBS.latest()}

    @app.get("/api/stock-actions")
    def stock_action_suggestions() -> dict:
        with open_catalog(read_only=True) as con:
            return stock_actions.review_snapshot(con)

    @app.post("/api/stock-actions/review")
    def review_stock_action(body: StockActionReviewBody) -> dict:
        if body.decision != "crash" and body.factor is None:
            raise HTTPException(422, "Enter the new-share multiplier for a split or bonus.")
        if body.decision != "crash" and not (body.source_url or body.note):
            raise HTTPException(422, "Add a source URL or a note for the confirmed factor.")
        with open_catalog() as con:
            baseline = con.execute(
                "SELECT manual_review_after FROM stock_action_scan_state WHERE id=1"
            ).fetchone()
            if baseline is None or body.ex_date <= baseline[0]:
                raise HTTPException(
                    422, "Dashboard review is for new events after the historical audit."
                )
            try:
                stock_actions.save_review(
                    con,
                    symbol=body.symbol.upper().strip(),
                    ex_date=body.ex_date,
                    decision=body.decision,
                    factor=body.factor,
                    source_url=body.source_url,
                    note=body.note,
                )
            except ValueError as error:
                raise HTTPException(422, str(error)) from None
        return {"ok": True}

    @app.post("/api/rebalance-preview")
    def preview(req: RebalanceRequest) -> dict:
        return rebalance_preview(req)

    return app


app = create_app()
