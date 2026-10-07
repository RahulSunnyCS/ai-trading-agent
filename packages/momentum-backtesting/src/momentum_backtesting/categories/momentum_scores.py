"""Momentum Scores page (TODO.md 3.9.16): a live/current-state snapshot of momentum across the
same 755-name Total Market universe Broad Momentum (TODO.md 3.9.13) ranks, and the same
curated/stock_groups.csv (TODO.md 3.9.12) sector taxonomy Broad Momentum's category layer uses --
percentile-scored per lookback window, as of the single latest available week. This is
deliberately NOT a backtest: no portfolio simulation, no P&L, just "where does this instrument's
return over the last N weeks rank against the whole universe, right now."

**Design, resolved with the user before this was built (TODO.md 3.9.16)**:
  - Lookback windows are the engine's existing weekly lookbacks -- 4/13/26 weeks standing in for
    "1M"/"3M"/"6M" (this pipeline is weekly-close data; exact calendar months would need daily
    data this repo doesn't fetch for the whole universe).
  - Score = percentile-of-universe, scaled to 0-100, per lookback, computed at the single latest
    available week (rank 1 of ~755 -> ~100, worst -> ~0) -- see `_percentile_scores`.
  - No market-cap data exists anywhere in this repo (confirmed during 3.9.13's planning,
    re-confirmed here) -- the reference screenshot's market-cap column is deliberately NOT
    reproduced with an invented rupee figure. Last close price + the latest 1-week % change stand
    in instead (both real data this repo already has, unlike a fabricated market cap).

**Why this is cheap where Broad Momentum's own Step 2 is not (~20s, see api.py's own comment on
`get_broad_ranking`)**: this reuses `broad.load_stock_universe_frame` (the 755-name price frame +
point-in-time membership gate) but skips BOTH `engine.compute_ranks` (which computes one
*combined*, weighted-multi-lookback rank -- this page wants three INDEPENDENT percentile scores,
one per lookback) and the quarterly pool-hysteresis loop (a portfolio-selection concept this
snapshot has no use for). `_returns_at` reuses `prices / prices.shift(k) - 1` --
`engine._compute_ranks_ranksum`'s own return formula, applied directly to just the last row, once
per lookback, rather than routed through any engine.py machinery."""

from __future__ import annotations

import csv
import math
from dataclasses import dataclass
from pathlib import Path

import pandas as pd

from momentum_backtesting import engine
from momentum_backtesting.categories import broad

#: 1, 2, 4, 8, 13, 26 and 52 weeks: from "this week" to "a year" (BL-049). The 4/13/26 windows
#: stand in for 1M/3M/6M -- see this module's own docstring for why. The 1-week score is shown
#: for timing only; the composite rank never uses it as a stand-alone window.
DEFAULT_LOOKBACKS: tuple[int, ...] = (1, 2, 4, 8, 13, 26, 52)

#: Weeks of history the composite rank needs: the engine's longest lookback (52) plus the row it
#: is measured from, with a few to spare. `compute_ranks` only ever uses prices up to each week,
#: so ranking this tail reproduces the last row of ranking the whole frame.
RANK_WEEKS = 60
#: Trading weeks in the moving average / the up-weeks window / the volatility window.
MA_WEEKS = 40
UP_WEEKS = 26
YEAR_WEEKS = 52
SPARK_WEEKS = 26
#: The parent group that is a theme (PSU / CPSE baskets...), not a sector: its stocks also sit in
#: a real sector, which is what a stock's own "sector" should name.
THEME_PARENT = "Cross-Sector Themes"


# ---------------------------------------------------------------------------------------------
# curated/stock_groups.csv, read the OTHER way round from broad.load_stock_groups (symbol ->
# its group, not group -> members) -- this page's per-stock table needs the company name and
# sector label for each row, not the reverse lookup Broad Momentum's category selection needs.
# ---------------------------------------------------------------------------------------------


@dataclass(frozen=True)
class StockGroupInfo:
    parent_group: str
    subgroup: str
    company_name: str
    #: Every (parent_group, subgroup) the symbol is tagged to in the file, in file order.
    tags: tuple[tuple[str, str], ...] = ()


def load_stock_group_info(curated_dir: Path) -> dict[str, StockGroupInfo]:
    """symbol -> (parent_group, subgroup, company_name, tags), from stock_groups.csv -- the same
    file `broad.load_stock_groups` reads. 65 of the 755 symbols carry two tags (mostly a
    sector plus a "Cross-Sector Themes" basket). The stock's own `parent_group`/`subgroup` is
    the first tag that is not a theme, in file order -- deterministic, and what a reader means by
    "its sector" -- and `tags` keeps every one, so a filter can match either."""
    path = curated_dir / broad.STOCK_GROUPS_FILENAME
    names: dict[str, str] = {}
    tags: dict[str, list[tuple[str, str]]] = {}
    with path.open(newline="") as f:
        for row in csv.DictReader(f):
            symbol = row["symbol"].strip()
            if not symbol:
                continue
            names.setdefault(symbol, row["company_name"])
            tag = (row["parent_group"], row["subgroup"])
            if tag not in tags.setdefault(symbol, []):
                tags[symbol].append(tag)
    info: dict[str, StockGroupInfo] = {}
    for symbol, symbol_tags in tags.items():
        primary = next((t for t in symbol_tags if t[0] != THEME_PARENT), symbol_tags[0])
        info[symbol] = StockGroupInfo(
            parent_group=primary[0],
            subgroup=primary[1],
            company_name=names[symbol],
            tags=tuple(symbol_tags),
        )
    return info


# ---------------------------------------------------------------------------------------------
# Percentile scoring -- the whole point of this module.
# ---------------------------------------------------------------------------------------------


def _percentile_scores(returns_row: pd.Series) -> pd.Series:
    """Rank 1 (best return) of N eligible names -> ~100, worst -> ~0 (TODO.md 3.9.16's own score
    design). Computed as `(ascending_rank - 1) / (N - 1) * 100`: ranking `returns_row` ascending
    puts the WORST (lowest) return at rank 1 (-> score 0) and the BEST (highest) return at rank N
    (-> score 100). Ties share the same (lowest, `method="min"`) rank, so tied names get the same
    score. NaN entries (not eligible this lookback -- not enough price history yet) are dropped
    before ranking and are simply absent from the returned Series. N<=1 has no meaningful spread
    to rank against, so it is scored neutral (50) for N==1, or returns an empty Series for N==0,
    rather than dividing by zero."""
    valid = returns_row.dropna()
    n = len(valid)
    if n == 0:
        return pd.Series(dtype=float)
    if n == 1:
        return pd.Series(50.0, index=valid.index)
    ranked = valid.rank(ascending=True, method="min")  # 1 = worst, n = best
    return (ranked - 1) / (n - 1) * 100.0


def _none_if_nan(v: float) -> float | None:
    return None if pd.isna(v) else float(v)


# ---------------------------------------------------------------------------------------------
# Stock-level snapshot.
# ---------------------------------------------------------------------------------------------


@dataclass(frozen=True)
class StockMomentumRow:
    symbol: str
    company_name: str
    parent_group: str
    subgroup: str
    last_price: float
    change_1w_pct: float | None
    returns: dict[int, float | None]  # lookback weeks -> raw return, e.g. {4: 0.081, ...}
    scores: dict[int, float | None]  # lookback weeks -> percentile score 0-100
    #: Broad Momentum's own rank-sum ranking (1 = strongest) among the stocks scored here, this
    #: week and last week (its change is the page's "up 6 places"). None until the stock has the
    #: 52 weeks of history the engine's longest lookback needs.
    composite_rank: int | None = None
    composite_rank_prev: int | None = None
    #: Last close over the 52-week high, minus 1 (0 at the high, -0.1 = 10% below it).
    high_52w_gap: float | None = None
    #: Last close over its 40-week average, minus 1.
    above_ma40: float | None = None
    #: Standard deviation of the last 52 weekly returns, annualised.
    volatility_52w: float | None = None
    #: Share of the last 26 weeks that closed up.
    up_weeks_26: float | None = None
    #: The last 26 weekly closes, rebased to 100 at the first; empty without a full window.
    spark: tuple[float, ...] = ()
    #: Every (parent_group, subgroup) the symbol is tagged to.
    tags: tuple[tuple[str, str], ...] = ()


@dataclass(frozen=True)
class Breadth:
    """How wide the market's momentum is, over the stocks scored (point-in-time members)."""

    #: Share of members above their 40-week average: now, a week ago, four weeks ago.
    above_ma40: dict[str, float | None]
    #: Share of members up over 13 weeks: now and a week ago.
    positive_13w: dict[str, float | None]
    median_26w: float | None
    top_decile_26w: float | None  # the 90th-percentile 26-week return


@dataclass(frozen=True)
class StockMomentumSnapshot:
    as_of: pd.Timestamp
    universe_size: int
    lookbacks: tuple[int, ...]
    rows: list[StockMomentumRow]
    ranked_count: int = 0  # stocks with a composite rank
    breadth: Breadth | None = None


def compute_stock_momentum_scores(
    universe: broad.StockUniverseFrame,
    group_info: dict[str, StockGroupInfo],
    *,
    lookbacks: tuple[int, ...] = DEFAULT_LOOKBACKS,
) -> StockMomentumSnapshot:
    """One row per currently-live, currently-in-Total-Market stock -- `universe.stock_membership`
    at the frame's own last week is the same point-in-time + segment-liveness gate Broad
    Momentum's own buy-eligibility uses (see `compose.build_membership_frame`), so a delisted/
    renamed/removed-from-the-index name whose old price column just sits there forward-filled is
    correctly excluded from a "right now" snapshot, not silently shown as if still current.

    Only the last row (plus one earlier row per lookback, for the return divisor) is ever read,
    not the whole frame -- deliberately NOT `frame / frame.shift(k) - 1` (which computes every
    week's return over the whole frame, only to then throw away every row but the last): this
    computes the identical formula, `frame.iloc[pos] / frame.iloc[pos - k] - 1`, restricted to
    the one position that matters. `frame`'s index is the same contiguous, gap-free weekly-Friday
    series `engine.compute_ranks`'s own `.shift(k)` already relies on behaving as a plain
    k-ROWS-back offset (not a k-calendar-weeks lookup) -- see that function's docstring -- so
    positional (`.iloc`) indexing here reproduces its own `prices / prices.shift(k) - 1` exactly,
    just without materialising the unused rows."""
    frame = universe.frame
    if frame.empty:
        return StockMomentumSnapshot(as_of=pd.NaT, universe_size=0, lookbacks=lookbacks, rows=[])

    as_of_pos = len(frame.index) - 1
    as_of = frame.index[as_of_pos]
    member_row = universe.stock_membership.loc[as_of]
    live_cols = [c for c in frame.columns if bool(member_row.get(c, False))]

    curr_row = frame.iloc[as_of_pos]
    last_price_row = curr_row
    # 1 is included alongside the requested lookbacks purely for the "latest 1-week % change"
    # market-cap-substitute column (TODO.md 3.9.16, point 4) -- it is never itself percentile-
    # scored (that would misrepresent a market-cap stand-in as a fourth momentum window).
    all_k = tuple(dict.fromkeys((*lookbacks, 1)))  # de-duplicated, order-preserving
    return_row_by_k: dict[int, pd.Series] = {}
    score_row_by_k: dict[int, pd.Series] = {}
    for k in all_k:
        past_pos = as_of_pos - k
        if past_pos < 0:
            row = pd.Series(float("nan"), index=live_cols)
        else:
            row = (curr_row / frame.iloc[past_pos] - 1).reindex(live_cols)
        return_row_by_k[k] = row
        if k in lookbacks:
            score_row_by_k[k] = _percentile_scores(row)

    ranks_now = _composite_ranks(frame, as_of_pos, live_cols)
    prev_cols = (
        [
            c
            for c in frame.columns
            if bool(universe.stock_membership.loc[frame.index[as_of_pos - 1]].get(c, False))
        ]
        if as_of_pos >= 1
        else []
    )
    ranks_prev = _composite_ranks(frame, as_of_pos - 1, prev_cols) if as_of_pos >= 1 else {}
    stats = _window_stats(frame, as_of_pos, live_cols)

    rows: list[StockMomentumRow] = []
    for col in live_cols:
        price = last_price_row.get(col)
        if pd.isna(price):
            continue
        symbol = universe.column_to_base_symbol[col]
        info = group_info.get(symbol)
        change_1w = return_row_by_k[1].get(col)
        stat = stats.get(col, {})
        rows.append(
            StockMomentumRow(
                symbol=symbol,
                company_name=info.company_name if info else symbol,
                parent_group=info.parent_group if info else "",
                subgroup=info.subgroup if info else "",
                last_price=float(price),
                change_1w_pct=_none_if_nan(change_1w),
                returns={k: _none_if_nan(return_row_by_k[k].get(col)) for k in lookbacks},
                scores={k: _none_if_nan(score_row_by_k[k].get(col)) for k in lookbacks},
                composite_rank=ranks_now.get(col),
                composite_rank_prev=ranks_prev.get(col),
                high_52w_gap=stat.get("high_52w_gap"),
                above_ma40=stat.get("above_ma40"),
                volatility_52w=stat.get("volatility_52w"),
                up_weeks_26=stat.get("up_weeks_26"),
                spark=stat.get("spark", ()),
                tags=info.tags if info else (),
            )
        )
    rows.sort(key=lambda r: r.symbol)
    return StockMomentumSnapshot(
        as_of=as_of,
        universe_size=len(rows),
        lookbacks=lookbacks,
        rows=rows,
        ranked_count=len(ranks_now),
        breadth=_breadth(universe, as_of_pos, return_row_by_k.get(26)),
    )


# ---------------------------------------------------------------------------------------------
# The composite rank, per-stock price statistics and market breadth (BL-049). All of them read
# the same weekly frame and the same point-in-time membership as the percentile scores above.
# ---------------------------------------------------------------------------------------------


def _composite_ranks(frame: pd.DataFrame, pos: int, columns: list[str]) -> dict[str, int]:
    """Broad Momentum's own ranking at week `pos`: `engine.compute_ranks` with its default
    rank-sum over the 1, 4, 13, 26 and 52-week returns (1 = strongest), among `columns` only --
    the stocks that were members that week. A rank-sum depends on who is in the cross-section, so
    this is the strategy's formula over this page's universe, not the strategy's exact pick
    (which also runs a pool and a category step over a wider frame). A stock without a full 52
    weeks of history has no rank."""
    if pos < 0 or not columns:
        return {}
    window = frame.iloc[max(0, pos - RANK_WEEKS + 1) : pos + 1][columns]
    if len(window.index) <= max(engine.Config().lookbacks):
        return {}
    ranks, _ = engine.compute_ranks(window, engine.Config())
    last = ranks.iloc[-1].dropna()
    return {str(column): int(rank) for column, rank in last.items()}


def _window_stats(frame: pd.DataFrame, pos: int, columns: list[str]) -> dict[str, dict]:
    """The per-stock figures a momentum investor reads beside the scores: distance from the
    52-week high, distance above the 40-week average, 52-week volatility, share of up weeks over
    26, and a 26-week price line. Each needs its full window of closes; a stock that has fewer
    gets None for that figure rather than one computed on a shorter, flattering window."""
    out: dict[str, dict] = {}
    if not columns:
        return out
    year = frame.iloc[max(0, pos - YEAR_WEEKS) : pos + 1][columns]
    ma = frame.iloc[max(0, pos - MA_WEEKS + 1) : pos + 1][columns]
    spark = frame.iloc[max(0, pos - SPARK_WEEKS + 1) : pos + 1][columns]
    last = frame.iloc[pos][columns]
    weekly = year.pct_change()
    for col in columns:
        stat: dict = {}
        if year[col].count() == YEAR_WEEKS + 1 and last[col] > 0:
            stat["high_52w_gap"] = float(last[col] / year[col].max() - 1)
            stat["volatility_52w"] = float(weekly[col].std() * math.sqrt(YEAR_WEEKS))
        if ma[col].count() == MA_WEEKS and ma[col].mean() > 0:
            stat["above_ma40"] = float(last[col] / ma[col].mean() - 1)
        recent = weekly[col].iloc[-UP_WEEKS:].dropna()
        if len(recent) == UP_WEEKS:
            stat["up_weeks_26"] = float((recent > 0).mean())
        line = spark[col]
        if len(line) == SPARK_WEEKS and line.notna().all() and line.iloc[0] > 0:
            stat["spark"] = tuple(float(v) for v in line / line.iloc[0] * 100.0)
        out[col] = stat
    return out


def _share_above_ma40(frame: pd.DataFrame, members: pd.Series, pos: int) -> float | None:
    """Share of the members at week `pos` whose close is above their 40-week average (members
    with fewer than 40 closes are left out of both counts)."""
    if pos < MA_WEEKS - 1:
        return None
    cols = [c for c in frame.columns if bool(members.get(c, False))]
    window = frame.iloc[pos - MA_WEEKS + 1 : pos + 1][cols]
    valid = window.count() == MA_WEEKS
    if not valid.any():
        return None
    above = frame.iloc[pos][cols] > window.mean()
    return float(above[valid].mean())


def _share_positive(frame: pd.DataFrame, members: pd.Series, pos: int, weeks: int) -> float | None:
    if pos < weeks:
        return None
    cols = [c for c in frame.columns if bool(members.get(c, False))]
    change = (frame.iloc[pos][cols] / frame.iloc[pos - weeks][cols] - 1).dropna()
    return float((change > 0).mean()) if len(change) else None


def _breadth(universe: broad.StockUniverseFrame, pos: int, return_26w: pd.Series | None) -> Breadth:
    frame, membership = universe.frame, universe.stock_membership

    def members_at(p: int) -> pd.Series:
        return membership.loc[frame.index[p]]

    def at(p: int, fn) -> float | None:
        return fn(p) if 0 <= p <= pos else None

    above = {
        "now": _share_above_ma40(frame, members_at(pos), pos),
        "week_ago": at(pos - 1, lambda p: _share_above_ma40(frame, members_at(p), p)),
        "month_ago": at(pos - 4, lambda p: _share_above_ma40(frame, members_at(p), p)),
    }
    positive = {
        "now": _share_positive(frame, members_at(pos), pos, 13),
        "week_ago": at(pos - 1, lambda p: _share_positive(frame, members_at(p), p, 13)),
    }
    valid = return_26w.dropna() if return_26w is not None else pd.Series(dtype=float)
    return Breadth(
        above_ma40=above,
        positive_13w=positive,
        median_26w=float(valid.median()) if len(valid) else None,
        top_decile_26w=float(valid.quantile(0.9)) if len(valid) else None,
    )


# ---------------------------------------------------------------------------------------------
# Sector-level snapshot -- aggregated from the stock-level snapshot via curated/stock_groups.csv.
# ---------------------------------------------------------------------------------------------


@dataclass(frozen=True)
class SectorMomentumRow:
    cid: str  # "parent_group :: subgroup", same id shape as broad.load_stock_groups's own keys
    parent_group: str
    subgroup: str
    member_count: int  # total symbols tagged to this subgroup in stock_groups.csv
    qualifying_count: int  # of those, how many are in this snapshot's stock-level rows
    scores: dict[int, float | None]  # lookback weeks -> mean qualifying-member score


@dataclass(frozen=True)
class SectorMomentumSnapshot:
    as_of: pd.Timestamp
    lookbacks: tuple[int, ...]
    rows: list[SectorMomentumRow]


def compute_sector_momentum_scores(
    stock_snapshot: StockMomentumSnapshot,
    group_members: dict[str, set[str]],
) -> SectorMomentumSnapshot:
    """A subgroup's score per lookback = the mean percentile score of its currently-qualifying
    (live, in-universe, scored) members -- the same "average member score" aggregation spirit
    Broad Momentum's own `score_categories` uses for its pool-rank average (TODO.md 3.9.13),
    applied here to this page's percentile scores instead. Deliberately no coverage floor: this
    is a display of "what does the sector look like right now," not a portfolio-selection gate,
    so a subgroup with thin (but nonzero) coverage is still shown -- with its own
    `qualifying_count`/`member_count` alongside it -- rather than silently dropped the way Broad
    Momentum's `coverage_floor` would drop it from holding consideration. A subgroup with zero
    qualifying members gets `scores={k: None for k in lookbacks}` (still listed, not omitted), so
    the UI can show "no data" instead of the row just vanishing."""
    scores_by_symbol = {row.symbol: row.scores for row in stock_snapshot.rows}
    rows: list[SectorMomentumRow] = []
    for cid, members in group_members.items():
        qualifying = [scores_by_symbol[s] for s in members if s in scores_by_symbol]
        parent_group, _, subgroup = cid.partition(" :: ")
        row_scores: dict[int, float | None] = {}
        for k in stock_snapshot.lookbacks:
            vals = [q[k] for q in qualifying if q.get(k) is not None]
            row_scores[k] = sum(vals) / len(vals) if vals else None
        rows.append(
            SectorMomentumRow(
                cid=cid,
                parent_group=parent_group,
                subgroup=subgroup,
                member_count=len(members),
                qualifying_count=len(qualifying),
                scores=row_scores,
            )
        )
    rows.sort(key=lambda r: r.cid)
    return SectorMomentumSnapshot(
        as_of=stock_snapshot.as_of, lookbacks=stock_snapshot.lookbacks, rows=rows
    )


# ---------------------------------------------------------------------------------------------
# The page's JSON. Rounded to what the page shows, so a 755-stock payload stays small.
# ---------------------------------------------------------------------------------------------


def _round(value: float | None, digits: int) -> float | None:
    return None if value is None or not math.isfinite(value) else round(value, digits)


def _by_lookback(values: dict[int, float | None], digits: int) -> dict[str, float | None]:
    return {str(k): _round(v, digits) for k, v in values.items()}


def to_payload(
    stock_snapshot: StockMomentumSnapshot,
    sector_snapshot: SectorMomentumSnapshot,
    *,
    missing_symbols: list[str],
    membership_quality: dict | None,
) -> dict:
    """`/api/momentum-scores`' response. Returns to 4 decimals, scores to 1, closes to 2: far more
    precise than the page prints, a fraction of the size."""
    snap = stock_snapshot
    breadth = snap.breadth
    return {
        "as_of": None if pd.isna(snap.as_of) else snap.as_of.strftime("%Y-%m-%d"),
        "lookbacks": list(snap.lookbacks),
        "universe_size": snap.universe_size,
        "ranked_count": snap.ranked_count,
        "missing_symbols": missing_symbols,
        "membership_quality": membership_quality,
        "breadth": None
        if breadth is None
        else {
            "above_ma40": {k: _round(v, 4) for k, v in breadth.above_ma40.items()},
            "positive_13w": {k: _round(v, 4) for k, v in breadth.positive_13w.items()},
            "median_26w": _round(breadth.median_26w, 4),
            "top_decile_26w": _round(breadth.top_decile_26w, 4),
        },
        "stocks": [
            {
                "symbol": r.symbol,
                "company_name": r.company_name,
                "parent_group": r.parent_group,
                "subgroup": r.subgroup,
                "tags": [{"parent_group": p, "subgroup": g} for p, g in r.tags],
                "last_price": r.last_price,
                "change_1w_pct": _round(r.change_1w_pct, 4),
                "returns": _by_lookback(r.returns, 4),
                "scores": _by_lookback(r.scores, 1),
                "composite_rank": r.composite_rank,
                "composite_rank_prev": r.composite_rank_prev,
                "high_52w_gap": _round(r.high_52w_gap, 4),
                "above_ma40": _round(r.above_ma40, 4),
                "volatility_52w": _round(r.volatility_52w, 4),
                "up_weeks_26": _round(r.up_weeks_26, 3),
                "spark": [round(v, 2) for v in r.spark],
            }
            for r in snap.rows
        ],
        "sectors": [
            {
                "cid": r.cid,
                "parent_group": r.parent_group,
                "subgroup": r.subgroup,
                "member_count": r.member_count,
                "qualifying_count": r.qualifying_count,
                "scores": _by_lookback(r.scores, 1),
            }
            for r in sector_snapshot.rows
        ],
    }
