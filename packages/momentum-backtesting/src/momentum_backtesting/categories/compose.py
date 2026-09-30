"""Inner/outer composition -- Piece B of the category-momentum feature (see the
task brief; Piece A, the per-stock weekly price builder, is
categories/prices.py).

The existing ETF-rotation engine (`engine.py`, unmodified by this task) ranks
sector/thematic categories as ETFs, weekly, and decides which to hold. This
module changes WHAT gets held when a category is in the top-N: instead of the
sector ETF, an "inner" backtest buys the top-K individual stocks currently
tagged as belonging to that category, rotating those K stocks on their own,
tighter, inner-rank threshold. The inner backtest's resulting equity curve
(portfolio value, 1.0 at the start) is then spliced in as a substitute price
series for the category's ETF column in the OUTER engine's price table, and
the outer backtest runs exactly as it does today -- unmodified, ordinary calls
to `engine.run_backtest` both times, per the brief ("nothing special"). This
single-category splice (`run_inner_category_backtest` +
`splice_category_into_outer_prices`) still exists and is still what the
`mbt categories backtest` CLI command and its own tests exercise.

**The "Custom Index" UI tab (`all_category_names` +
`build_all_categories_price_table`, added after a design correction)** is a
different, simpler composition built on the same two pieces: instead of
splicing one category into the existing ETF universe, EVERY category (16
official + the `category_extras.csv` custom ones) gets its own inner-rotation
equity curve, laid out as a column in a fresh, self-contained price table with
no ETF columns at all. An ordinary, unmodified `engine.run_backtest` then
ranks the categories against EACH OTHER with the usual `top_n`/`exit_rank`
mechanic. This is what gives the tab its diversification: holding the top N
categories at once structurally spreads a portfolio across N different
sectors, rather than relying on a user to manually avoid over-concentrating in
one (e.g. never ending up "full of money" in a single thin category like
Diamonds Gems Jewellery or Micro Finance) -- see `api._custom_index_backtest`
for how the API wires this into the third dataset tab.

**Membership gating, and the 2020-2024 snapshot-coverage gap**:
`categories/snapshots.py` resolved category_membership.csv from whatever
Wayback captures actually exist for each category, which as of 2026-09 only
spans 2020-2024 (a handful of captures per category -- see that module's own
docstring). A category-momentum backtest naturally wants to run over a longer
window than that (the outer engine's own default start is 2017-01-01). Rather
than treating a requested year outside 2020-2024 as "zero members that year"
(which would produce a degenerate, permanently-empty inner universe for every
week outside that 5-year window), `resolve_members_by_year` falls back to the
*nearest* year that has non-empty membership data for that category --
mirroring `snapshots.py`'s own nearest-snapshot philosophy (a category's
constituent list rarely changes dramatically year to year) rather than
inventing a different rule. This is a judgment call worth the caller's
attention: it means membership before 2020 or after 2024 is a rough
approximation of an earlier/later year's index list, not their own. See the
task's final report for how this was sanity-checked.

**Known false-positive window inherited from categories/prices.py**: besides
the COVID-week false positives documented there, a second, category-specific
instance was found while testing this module: 2024-06-04 (the Lok Sabha
election-result day, when PSU and bank stocks specifically saw a market-wide,
politically-driven selloff -- Nifty PSU Bank constituents BANKBARODA and PNB
both show single-day drops >15% with turnover ratios ~1-1.6x that day, well
under the 3x spike threshold). A Nifty PSU Bank / Nifty Bank backtest spanning
mid-2024 should expect a same-week split around 2024-06-03/04 for more than
one constituent and sanity-check it isn't distorting the inner rotation.
"""

from __future__ import annotations

import csv
from dataclasses import dataclass, field
from pathlib import Path

import pandas as pd

from momentum_backtesting.categories import prices, snapshots, sources
from momentum_backtesting.categories.resolve import (
    EXTRAS_FILENAME,
    CategoryDataNotFoundError,
    Mode,
    resolve_category_members,
)
from momentum_backtesting.engine import BENCHMARK, CASH, GILT, Config, Result, run_backtest

#: Non-category instruments ranked alongside the categories in the "Custom Index" tab's outer
#: table, as (name, label) pairs matching `all_category_names`'s own shape. All four are
#: already atomic, directly tradable instruments (real weekly closes -- Gold/Silver since
#: 2016, Gilt since May 2017, Cash (liquid fund) throughout -- sourced from `outer_prices`,
#: see `sources.py`/`fetch.py`'s existing ETF pipeline) -- no inner top-K stock-rotation
#: applies to them the way it does to a category, since there is no "within Gold" universe of
#: stocks to pick from. Included so the tab's diversification covers genuinely uncorrelated,
#: non-equity asset classes, not just more equity sectors -- added on request after the tab's
#: initial build only ranked categories.
#:
#: The label doubles as the RANKING tag, not just the UI group, mirroring stock mode's own
#: gold/silver/debt feature (ui_data.py): "commodity" (Gold/Silver) maps to `include="core"` --
#: always rankable, like a category. "debt" (Cash/Gilt) maps to `include="defensive"` --
#: rankable only when `Config.defensive="ranked"` (see `_custom_index_meta`'s default, changed
#: to "ranked" for this dataset specifically, same reasoning as stock mode's own default
#: change: without it, debt sits in the universe but never actually competes, defeating the
#: point of adding it). `CASH` itself is already unconditionally present in the outer table
#: (every `run_backtest` call needs it, for idle-cash parking) -- it is listed here only to
#: become independently RANKABLE, not to add a second price column for it.
#:
#: Also includes the ETF-mode "International" group (Nasdaq 100, Hang Seng,
#: `universe.csv`) -- already-real `weekly_closes.csv` columns, label="international",
#: no multi-slot mechanism requested for these (`_copies_by_label`'s existing fallback to
#: `DEFAULT_ATOMIC_COPIES` gives them ordinary single-instrument behaviour).
ATOMIC_INSTRUMENTS: tuple[tuple[str, str], ...] = (
    ("Gold", "commodity"),
    ("Silver", "commodity"),
    (CASH, "debt"),
    (GILT, "debt"),
    ("Nasdaq 100", "international"),
    ("Hang Seng", "international"),
)

#: Upper bound on how many duplicate columns any atomic instrument may have (see
#: `atomic_copy_names`'s own `count` parameter) -- a UI-facing max, not the default. Matches
#: `BacktestRequest.top_n`'s own upper bound (`le=10`): no outer ranking can ever hold more
#: than `top_n` slots at once, so more copies than that could never all be held simultaneously
#: anyway.
MAX_ATOMIC_COPIES = 10

#: Default copy count for every atomic instrument -- 1, i.e. behaves as a single ordinary
#: instrument, unchanged from how Gold/Silver/Cash/Gilt worked before this multi-copy
#: mechanism existed. Requested explicitly, after seeing the mechanism run with the (now
#: former) fixed default of `MAX_ATOMIC_COPIES`: "put gold silver number only one as a single
#: stock" -- multiple slots are opt-in via `commodity_copies`/`debt_copies`
#: (`build_all_categories_price_table`, `api.BacktestRequest`), not the out-of-the-box
#: behaviour.
DEFAULT_ATOMIC_COPIES = 1


def atomic_copy_names(name: str, count: int = MAX_ATOMIC_COPIES) -> list[str]:
    """The column names one `ATOMIC_INSTRUMENTS` entry expands to, for a requested `count`
    (1..MAX_ATOMIC_COPIES, not validated here -- callers are expected to clamp, e.g.
    `api.py`'s `Field(..., ge=1, le=MAX_ATOMIC_COPIES)`): `name` itself, plus `f"{name} #2"`
    .. `f"{name} #{count}"`. `count == 1` returns just `[name]` -- ordinary single-instrument
    behaviour, the default (see `DEFAULT_ATOMIC_COPIES`). For `count > 1`, all columns carry
    the identical price series (see `build_all_categories_price_table`) -- ranking ties them
    at the same score, so if e.g. Gold's momentum would naturally occupy ranks 3-6 among
    DISTINCT scores, multiple of its copies fill those adjacent tied ranks too, giving Gold
    proportionally more of the portfolio rather than capping it at a single slot the way an
    ordinary single-column instrument is capped. Requested explicitly: "whenever gold will be
    having three or four [top ranks] ... we will put additionally in the gold" (and the same
    for silver/debt) -- the user's own words for this mechanism.
    """
    return [name] + [f"{name} #{i}" for i in range(2, count + 1)]


#: Default top-K individual stocks held per in-favour category (brief default).
DEFAULT_TOP_N = 2

#: Default inner rotation threshold -- tighter than the outer engine's own
#: default exit_rank=10, since the inner universe is a small, single-category
#: pool rather than the whole sector/thematic universe.
DEFAULT_EXIT_RANK = 8


@dataclass(frozen=True)
class InnerBacktestResult:
    """Everything `run_inner_category_backtest` produces: the engine Result
    itself, plus the bookkeeping needed to explain/verify it."""

    result: Result
    category: str
    years: list[int]
    universe_symbols: list[str]
    members_by_year: dict[int, set[str]]
    events: pd.DataFrame
    weekly_prices: pd.DataFrame
    column_to_base_symbol: dict[str, str] = field(default_factory=dict)
    #: column -> its own last real (pre-forward-fill) week, for any column whose data ran
    #: out with no detected event at all (e.g. a plain symbol rename) -- see
    #: prices.build_stock_weekly_prices's "Any column can go stale, not just a detected
    #: event's". Already folded into `membership`'s buy-eligibility gating; exposed here
    #: for the same explain/verify reason `events` is.
    stale_columns: dict[str, pd.Timestamp] = field(default_factory=dict)


def _category_available_years(category: str, data_dir: Path) -> list[int]:
    """Distinct years category_membership.csv actually has non-empty rows for,
    for `category` -- read directly rather than through resolve.py's private
    loader, since this is the "what years exist at all" question, not "give me
    one year's members" (resolve_category_members answers that one)."""
    from momentum_backtesting import db_read

    membership = db_read.category_membership_from_db_or_none()
    if membership is None:
        path = data_dir / snapshots.MEMBERSHIP_FILENAME
        if not path.exists():
            raise CategoryDataNotFoundError(
                f"{path} does not exist -- run `mbt categories fetch` first"
            )
        membership = pd.read_csv(path, usecols=["category", "year"], dtype={"category": str})
    own_years = membership.loc[membership["category"] == category, "year"].unique()
    return sorted(int(y) for y in own_years)


def resolve_members_by_year(
    category: str,
    years: list[int],
    mode: Mode,
    *,
    data_dir: Path,
    curated_dir: Path,
) -> dict[int, set[str]]:
    """`resolve_category_members` for every year in `years`, falling back to
    the nearest year with non-empty membership data when a requested year
    resolves to nothing of its own -- see module docstring "Membership
    gating".

    **A category with no official NSE index at all** (never in
    `category_membership.csv`, e.g. a purely hand-curated theme like
    "Hotels" or "CDMO" that has no niftyindices.com equivalent) is a valid,
    supported case in `mode="broad"`: `resolve_category_members` already
    returns exactly `curated_dir/category_extras.csv`'s rows for such a
    category (its "narrow"/official component is empty for every year, so
    "narrow ∪ extras" is just extras) -- there is nothing to fall back to
    across years because there is no year-to-year variation to begin with,
    so the SAME extras set is used for every requested year. Only raises
    CategoryDataNotFoundError when there is truly nothing to resolve at
    all: no official data for any year, AND (in narrow mode, or an empty
    extras file) no extras either.
    """
    available = _category_available_years(category, data_dir)
    extras_only_members = (
        resolve_category_members(
            category, years[0], mode, data_dir=data_dir, curated_dir=curated_dir
        )
        if not available and years
        else None
    )
    if not available and not extras_only_members:
        raise CategoryDataNotFoundError(
            f"category {category!r} has no official membership data for any year, and "
            f"(mode={mode!r}) no category_extras.csv rows either -- nothing to resolve"
        )
    if extras_only_members is not None:
        return dict.fromkeys(years, extras_only_members)

    out: dict[int, set[str]] = {}
    for year in years:
        members = resolve_category_members(
            category, year, mode, data_dir=data_dir, curated_dir=curated_dir
        )
        if not members:
            nearest = min(available, key=lambda y: abs(y - year))
            members = resolve_category_members(
                category, nearest, mode, data_dir=data_dir, curated_dir=curated_dir
            )
        out[year] = members
    return out


def _segment_live_windows(
    column_to_base_symbol: dict[str, str],
    events: pd.DataFrame,
    stale_columns: dict[str, pd.Timestamp] | None = None,
) -> dict[str, tuple[pd.Timestamp | None, pd.Timestamp | None]]:
    """Each price column's own `[start, end)` live window -- the span of weeks
    during which it is backed by real (not forward-filled) data. Two
    independent sources feed this, since a column can go stale two different
    ways (see prices.py's "Any column can go stale, not just a detected
    event's"):

    - `events` (columns: symbol, event_date, new_column -- already snapped to
      the week-Monday boundary by prices.py): a *detected* corporate-action-
      like split. Ordered by date per symbol, the original/base column is
      live up to (not including) its earliest boundary; each subsequent
      `SYMBOL#N` column is live from its own boundary up to the *next* one,
      or unbounded if it's the last/currently-active segment.
    - `stale_columns` (from `prices.build_stock_weekly_prices`'s third return
      value: column -> its own last real week): a column whose real data
      simply ran out with NO detected event at all -- a plain symbol rename
      (the confirmed real case: IDFCBANK -> IDFCFIRSTB) is indistinguishable
      here from "stopped trading", either way its OWN column needs the same
      buy-ineligible-after-its-last-real-week treatment. Tightens `end` to
      the week after that column's own last real week if that is earlier
      than whatever `events` already implied (the two sources combine via
      `min`, treating `None`/unbounded as +infinity) -- a column can in
      principle be split by a detected event AND separately go stale later.

    A column mentioned by neither source is live for the whole frame:
    `(None, None)`. Every column in `column_to_base_symbol` gets an entry
    regardless, so a caller can look up any column unconditionally.
    """
    windows: dict[str, tuple[pd.Timestamp | None, pd.Timestamp | None]] = {
        col: (None, None) for col in column_to_base_symbol
    }

    if not events.empty:
        for symbol, group in events.groupby("symbol"):
            ordered = group.sort_values("event_date")
            boundaries = [
                pd.Timestamp(d) - pd.Timedelta(days=pd.Timestamp(d).weekday())
                for d in ordered["event_date"]
            ]
            new_names = [n for n in ordered["new_column"] if n]
            if symbol in windows:
                windows[symbol] = (None, boundaries[0])
            for i, name in enumerate(new_names):
                if name not in windows:
                    continue
                start = boundaries[i]
                end = boundaries[i + 1] if i + 1 < len(boundaries) else None
                windows[name] = (start, end)

    for col, last_real_week in (stale_columns or {}).items():
        if col not in windows:
            continue
        start, existing_end = windows[col]
        candidate_end = pd.Timestamp(last_real_week) + pd.Timedelta(days=1)
        tighter_end = candidate_end if existing_end is None else min(existing_end, candidate_end)
        windows[col] = (start, tighter_end)

    return windows


def build_membership_frame(
    weekly_index: pd.DatetimeIndex,
    members_by_year: dict[int, set[str]],
    column_to_base_symbol: dict[str, str],
    events: pd.DataFrame | None = None,
    stale_columns: dict[str, pd.Timestamp] | None = None,
) -> pd.DataFrame:
    """week x column-name booleans for `run_backtest`'s `membership` gate
    (see engine.py's `_Sim.top_names`): a synthetic split column (e.g.
    `TATAMOTORS#2`) inherits its base symbol's year-by-year category
    membership -- the split is a price-continuity artefact from
    categories/prices.py, not a change in which company the position actually
    is.

    **Segment-liveness gating (`events`/`stale_columns`, optional but should
    always be passed by real callers)**: category membership alone is NOT
    enough. `prices.py` forward-fills a stopped column flat so a *held*
    position never corrupts to NaN (see its own docstring "Why forward-fill a
    stopped segment") -- but that forward-filled "zombie" column still has a
    valid, non-null price for the rest of the backtest, and without this
    extra constraint it remains ordinarily rankable and BUYABLE, including as
    a brand new position, forever. Verified live against real backtests
    (Nifty PSU Bank and Nifty Bank, 2017-2025), two different ways a column
    can go stale (see prices.py's "Any column can go stale, not just a
    detected event's"):
    - A *detected* split: without this constraint, the old `BANKBARODA`
      column (frozen at its 2015 price) was freshly bought 10 separate times
      over a real backtest, including at rank 1.
    - No detected event at all -- a plain symbol rename (IDFCBANK ->
      IDFCFIRSTB, 2019-01-16, no price discontinuity to detect): without
      `stale_columns` catching this too, the stale `IDFCBANK` column's price
      still ran out and corrupted a held position's mark-to-market to NaN,
      which then poisoned that entire inner backtest's equity to NaN from
      that week on -- a silent, whole-run failure, not merely a bad trade.
    Both are real correctness bugs, not low-probability edge cases.

    The fix stays entirely at the membership-gate level, not the price level
    (the forward-fill itself must stay, or the original NaN-corruption bug
    comes back): a column is only ever buy-eligible for the weeks it is
    ACTUALLY backed by real data (`_segment_live_windows`, which merges both
    `events` and `stale_columns`), on top of the existing base-symbol-year
    check. This has no effect on an existing holding -- `_Sim.top_names`'s
    membership gate only filters NEW-buy candidates (see engine.py), never
    forces an exit -- so a position already held when its column stops being
    live keeps being correctly valued (forward-filled price) and exits
    normally once its rank falls, exactly as intended.

    `events=None`/`stale_columns=None` (or empty) skips the corresponding
    constraint entirely and falls back to the original base-symbol-year-only
    behaviour -- kept for a caller with no event/staleness data to give (e.g.
    a plain, never-split universe).
    """
    columns = list(column_to_base_symbol)
    frame = pd.DataFrame(False, index=weekly_index, columns=columns)
    years = sorted({week.year for week in weekly_index})
    for year in years:
        members = members_by_year.get(year, set())
        year_mask = weekly_index.year == year
        for col in columns:
            if column_to_base_symbol[col] in members:
                frame.loc[year_mask, col] = True

    has_events = events is not None and not events.empty
    if has_events or stale_columns:
        windows = _segment_live_windows(
            column_to_base_symbol, events if has_events else pd.DataFrame(), stale_columns
        )
        for col, (start, end) in windows.items():
            if start is not None:
                frame.loc[weekly_index < start, col] = False
            if end is not None:
                frame.loc[weekly_index >= end, col] = False

    return frame


def run_inner_category_backtest(
    category: str,
    *,
    mode: Mode = "narrow",
    top_n: int = DEFAULT_TOP_N,
    exit_rank: int = DEFAULT_EXIT_RANK,
    start: str,
    end: str | None = None,
    lookbacks: tuple[int, ...] = (1, 4, 13, 26, 52),
    cost_pct: float = 0.10,
    use_membership_gate: bool = True,
    outer_prices: pd.DataFrame,
    benchmark: str = BENCHMARK,
    data_dir: Path,
    curated_dir: Path,
    stocks_data_dir: Path,
    min_drop_pct: float = prices.DEFAULT_MIN_DROP_PCT,
    turnover_spike_multiple: float = prices.DEFAULT_TURNOVER_SPIKE_MULTIPLE,
) -> InnerBacktestResult:
    """Piece B steps 1-4: resolve `category`'s member stocks year by year,
    build their weekly price frame (categories/prices.py), and run the
    existing, unmodified `engine.run_backtest` scoped to just those stocks
    with `top_n`/`exit_rank` as the inner rotation rule and
    `portfolio="slots"` (brief: "exactly N positions; a sale's money buys the
    best name not held"). `outer_prices` supplies the CASH and `benchmark`
    columns `run_backtest` always requires present regardless of defensive
    mode (see engine.run_backtest's own validation) -- reindexed onto the
    inner weekly index, they are not ranked (the inner Config.universe is
    exactly the resolved stock columns, never CASH/benchmark).
    """
    start_year = pd.Timestamp(start).year
    end_year = (pd.Timestamp(end) if end else pd.Timestamp.today()).year
    years = list(range(start_year, end_year + 1))

    members_by_year = resolve_members_by_year(
        category, years, mode, data_dir=data_dir, curated_dir=curated_dir
    )
    universe_symbols = sorted(set().union(*members_by_year.values()))
    if not universe_symbols:
        raise ValueError(f"no member symbols resolved for category {category!r} over {years}")

    frame, events, stale_columns = prices.build_stock_weekly_prices(
        universe_symbols,
        stocks_data_dir=stocks_data_dir,
        min_drop_pct=min_drop_pct,
        turnover_spike_multiple=turnover_spike_multiple,
    )
    if frame.empty:
        raise ValueError(
            f"no priced weeks for category {category!r}'s resolved symbols {universe_symbols}"
        )

    missing_prices = sorted(
        s for s in universe_symbols if s not in {c.split("#", 1)[0] for c in frame.columns}
    )

    column_to_base_symbol = {col: col.split("#", 1)[0] for col in frame.columns}

    extra = outer_prices.reindex(frame.index)[[CASH, benchmark]]
    frame = pd.concat([frame, extra], axis=1)

    membership = None
    if use_membership_gate:
        membership = build_membership_frame(
            frame.index,
            members_by_year,
            column_to_base_symbol,
            events=events,
            stale_columns=stale_columns,
        )

    config = Config(
        lookbacks=lookbacks,
        top_n=top_n,
        exit_rank=exit_rank,
        cost_pct=cost_pct,
        start=start,
        end=end,
        universe=tuple(column_to_base_symbol),
        benchmark=benchmark,
        portfolio="slots",
    )
    includes = {name: "core" for name in column_to_base_symbol}

    result = run_backtest(frame, includes, config, membership=membership)

    if missing_prices:
        import logging

        logging.getLogger(__name__).warning(
            "category %r: %d resolved symbol(s) have no daily.parquet rows and were "
            "dropped from the inner universe: %s",
            category,
            len(missing_prices),
            missing_prices,
        )

    return InnerBacktestResult(
        result=result,
        category=category,
        years=years,
        universe_symbols=universe_symbols,
        members_by_year=members_by_year,
        events=events,
        weekly_prices=frame,
        column_to_base_symbol=column_to_base_symbol,
        stale_columns=stale_columns,
    )


def splice_category_into_outer_prices(
    outer_prices: pd.DataFrame, category: str, inner_equity: pd.Series
) -> pd.DataFrame:
    """Replace `outer_prices[category]` (the sector/thematic ETF's own price
    column, e.g. "Nifty PSU Bank" -- universe.csv's `index` value) with the
    inner backtest's equity curve, reindexed onto the outer weekly index.
    Weeks before the inner backtest's own start are NaN, same as any other
    instrument that hasn't started yet -- `run_backtest`'s existing
    eligibility rule (needs a full lookback window of valid prices) handles
    that with no special casing, per the brief's "no engine.py change needed"
    reasoning.
    """
    if category not in outer_prices.columns:
        raise ValueError(f"{category!r} is not a column of the outer price table")
    spliced = outer_prices.copy()
    spliced[category] = inner_equity.reindex(spliced.index)
    return spliced


# ---------------------------------------------------------------------------------------------
# "Custom Index" tab: rank ALL categories against each other (built-in diversification), not a
# picker that splices a handful into the existing ETF universe -- see the task's design
# correction for the full reasoning (a checkbox picker doesn't structurally prevent someone
# ending up "full of money" in one thin sector; ranking every category with an outer top_n/
# exit_rank does, the same way the existing ETF/stock rotations already diversify).
# ---------------------------------------------------------------------------------------------


@dataclass(frozen=True)
class AllCategoriesResult:
    """Everything `build_all_categories_price_table` produces: the outer-ready price table (one
    column per successfully-resolved category plus `ATOMIC_INSTRUMENTS` (Gold/Silver/Cash/Gilt),
    plus CASH and the benchmark), each category's own InnerBacktestResult (for diagnostics/
    verification -- e.g. "did this category actually hold more than one stock"; atomic
    instruments have no entry here, they have no inner rotation), which categories/instruments
    were skipped and why, and each one's label (`all_category_names`/`ATOMIC_INSTRUMENTS`:
    "official"/"custom"/"commodity"/"debt") for the outer backtest's UI/instrument-table
    labelling and ranking-tag requirement.
    """

    prices: pd.DataFrame
    inner_results: dict[str, InnerBacktestResult]
    skipped: dict[str, str]
    labels: dict[str, str]  # category -> "official" | "custom"


def all_category_names(curated_dir: Path) -> list[tuple[str, str]]:
    """Every category the "Custom Index" universe ranks, as `(name, label)` pairs -- `label` is
    "official" (one of universe.csv's 16 Sector/Thematic categories with a working
    niftyindices.com slug, `sources.available_categories()`) or "custom" (a hand-curated,
    no-official-NSE-index theme from `curated_dir/category_extras.csv` -- e.g. CDMO, Hotels,
    Diamonds Gems Jewellery; see that file's own header and `curated/stockscans_catalog.md`).

    Official categories come first, in `sources.CATEGORY_SLUGS`'s own order; custom categories
    follow, in `category_extras.csv`'s own first-appearance order, de-duplicated. A custom-file
    category name that happens to collide with an official one (none do as of 2026-09) is kept
    official-only here -- the official category already resolves its own members via
    `resolve_category_members` regardless of what else shares its display name, and listing it
    twice would double-count it in the outer ranking.
    """
    official = sources.available_categories()
    seen = set(official)
    out: list[tuple[str, str]] = [(name, "official") for name in official]

    path = curated_dir / EXTRAS_FILENAME
    if not path.exists():
        return out
    extra_names: list[str] = []
    with path.open(newline="") as f:
        for row in csv.DictReader(f):
            name = (row.get("category") or "").strip()
            if name and name not in seen:
                extra_names.append(name)
                seen.add(name)
    out += [(name, "custom") for name in dict.fromkeys(extra_names)]
    return out


def build_all_categories_price_table(
    *,
    mode: Mode = "broad",
    top_n: int = DEFAULT_TOP_N,
    exit_rank: int = DEFAULT_EXIT_RANK,
    start: str,
    end: str | None = None,
    lookbacks: tuple[int, ...] = (1, 4, 13, 26, 52),
    cost_pct: float = 0.10,
    use_membership_gate: bool = True,
    outer_prices: pd.DataFrame,
    benchmark: str = BENCHMARK,
    data_dir: Path,
    curated_dir: Path,
    stocks_data_dir: Path,
    min_drop_pct: float = prices.DEFAULT_MIN_DROP_PCT,
    turnover_spike_multiple: float = prices.DEFAULT_TURNOVER_SPIKE_MULTIPLE,
    commodity_copies: int = DEFAULT_ATOMIC_COPIES,
    debt_copies: int = DEFAULT_ATOMIC_COPIES,
) -> AllCategoriesResult:
    """The "Custom Index" tab's own price table: run `run_inner_category_backtest` for EVERY
    category `all_category_names` lists (16 official + however many `category_extras.csv` adds,
    46 as of 2026-09) and lay each one's resulting inner-rotation equity curve out as its own
    column -- ready for an ordinary, unmodified `engine.run_backtest` call to rank categories
    against EACH OTHER (the OUTER ranking), exactly like the existing ETF-universe backtest ranks
    ETFs. No interaction with `universe.csv`'s ETFs at all -- this is a self-contained ranked
    universe of category columns, not a splice into the existing ETF price table (that was the
    superseded design; see `splice_category_into_outer_prices`, still used by the single-category
    `mbt categories backtest` CLI command and its own tests).

    `mode` defaults to "broad" here (not `run_inner_category_backtest`'s own "narrow" default)
    because a category with no official NSE index at all -- every custom one -- resolves to zero
    members in "narrow" mode (see resolve.py's own docstring). "broad" is the only mode that
    gives every category in this table a non-empty inner universe; this is a deliberate,
    conservative choice made for the whole table uniformly (not configurable per-category here)
    rather than "narrow" for the 16 official ones and "broad" for the 46 custom ones, since a
    mixed-mode table would need its own justification this task's brief didn't ask for.

    A category that fails to resolve at all (e.g. `CategoryDataNotFoundError`, or its resolved
    symbols have no priced weeks at all) is skipped, not fatal to the whole table -- recorded in
    `AllCategoriesResult.skipped` with its error message, the same degrade-gracefully philosophy
    every module in this package already follows (sources.py, snapshots.py). Raises `ValueError`
    only if EVERY category fails (an empty outer universe can't be ranked at all). Verified live
    (2026-09) against this package's real `data/`: all 62 categories resolve successfully over
    2017-2026 with the defaults above -- see the task's final report for the real backtest
    numbers this produced.

    `lookbacks`/`cost_pct`/`start`/`end` are shared between the inner (per-category stock-
    picking) and outer (category-vs-category) backtests -- a deliberate simplification: the
    brief ties the outer ranking to "the same momentum scoring... already exists, nothing new
    needed", and there is no stated reason for the two ranking layers to score momentum
    differently. `top_n`/`exit_rank` here are the INNER (per-category stock-picking) rotation's
    own -- the OUTER (category-vs-category) `top_n`/`exit_rank` are a separate `Config` the
    caller builds itself when it runs `engine.run_backtest` on this function's `.prices` output
    (see `api._custom_index_backtest`), exactly mirroring how the existing ETF/stock backtest
    paths already use one shared `Config`.
    """
    inner_results: dict[str, InnerBacktestResult] = {}
    skipped: dict[str, str] = {}
    labels: dict[str, str] = {}
    for name, label in all_category_names(curated_dir):
        labels[name] = label
        try:
            inner_results[name] = run_inner_category_backtest(
                name,
                mode=mode,
                top_n=top_n,
                exit_rank=exit_rank,
                start=start,
                end=end,
                lookbacks=lookbacks,
                cost_pct=cost_pct,
                use_membership_gate=use_membership_gate,
                outer_prices=outer_prices,
                benchmark=benchmark,
                data_dir=data_dir,
                curated_dir=curated_dir,
                stocks_data_dir=stocks_data_dir,
                min_drop_pct=min_drop_pct,
                turnover_spike_multiple=turnover_spike_multiple,
            )
        except (CategoryDataNotFoundError, ValueError, FileNotFoundError) as error:
            skipped[name] = str(error)

    if not inner_results:
        raise ValueError(
            "no category could be resolved into an inner backtest at all -- "
            f"{len(skipped)} skipped: {skipped}"
        )

    table = pd.DataFrame(
        {name: inner.result.equity for name, inner in inner_results.items()}
    ).reindex(outer_prices.index)
    table[CASH] = outer_prices[CASH]
    table[benchmark] = outer_prices[benchmark]

    # Gold/Silver/Gilt need their own price column (from outer_prices, already real data --
    # no new fetching); CASH's column already exists above. Each gets `commodity_copies`
    # (Gold/Silver) or `debt_copies` (Cash/Gilt) identical-price duplicate columns (see
    # atomic_copy_names) so it can occupy more than one ranked slot when its own momentum is
    # strong enough, instead of being capped at one the way a single-column instrument is --
    # defaults to 1 (DEFAULT_ATOMIC_COPIES), ordinary single-instrument behaviour, opt-in for
    # more. Skipped (not fatal) if outer_prices doesn't have a price series for some reason --
    # same degrade-gracefully rule as a category that fails to resolve; skipping is recorded
    # once per base name, not once per copy.
    _copies_by_label = {"commodity": commodity_copies, "debt": debt_copies}
    for name, label in ATOMIC_INSTRUMENTS:
        if name != CASH and name not in outer_prices.columns:
            skipped[name] = f"{name!r} not found in outer_prices"
            continue
        series = table[CASH] if name == CASH else outer_prices[name]
        copies = _copies_by_label.get(label, DEFAULT_ATOMIC_COPIES)
        for copy_name in atomic_copy_names(name, copies):
            table[copy_name] = series
            labels[copy_name] = label

    return AllCategoriesResult(
        prices=table, inner_results=inner_results, skipped=skipped, labels=labels
    )
