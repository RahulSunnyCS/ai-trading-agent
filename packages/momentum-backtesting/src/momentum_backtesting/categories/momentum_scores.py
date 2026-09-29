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
from dataclasses import dataclass
from pathlib import Path

import pandas as pd

from momentum_backtesting.categories import broad

#: 4/13/26 weeks standing in for 1M/3M/6M -- see this module's own docstring for why.
DEFAULT_LOOKBACKS: tuple[int, ...] = (4, 13, 26)


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


def load_stock_group_info(curated_dir: Path) -> dict[str, StockGroupInfo]:
    """symbol -> (parent_group, subgroup, company_name), from stock_groups.csv -- the same file
    `broad.load_stock_groups` reads. A symbol appears in exactly one subgroup in this file
    (verified during 3.9.12: 755 Total Market symbols, 755 rows), so this reverse mapping is
    unambiguous."""
    path = curated_dir / broad.STOCK_GROUPS_FILENAME
    info: dict[str, StockGroupInfo] = {}
    with path.open(newline="") as f:
        for row in csv.DictReader(f):
            symbol = row["symbol"].strip()
            if symbol:
                info[symbol] = StockGroupInfo(
                    parent_group=row["parent_group"],
                    subgroup=row["subgroup"],
                    company_name=row["company_name"],
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


@dataclass(frozen=True)
class StockMomentumSnapshot:
    as_of: pd.Timestamp
    universe_size: int
    lookbacks: tuple[int, ...]
    rows: list[StockMomentumRow]


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

    rows: list[StockMomentumRow] = []
    for col in live_cols:
        price = last_price_row.get(col)
        if pd.isna(price):
            continue
        symbol = universe.column_to_base_symbol[col]
        info = group_info.get(symbol)
        change_1w = return_row_by_k[1].get(col)
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
            )
        )
    rows.sort(key=lambda r: r.symbol)
    return StockMomentumSnapshot(
        as_of=as_of, universe_size=len(rows), lookbacks=lookbacks, rows=rows
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
