"""Build weekly stock prices for category and Broad Momentum backtests.

Verified split and bonus events from ``stock_action_candidates`` are applied to
*earlier* raw daily closes as share-count multipliers, preserving the return
through the ex-date. These factors come from matching an explicit NSE filing or
a saved human review; the volume/turnover estimate alone never authorizes an
adjustment. ``return_raw_weekly`` also returns unadjusted closes, used for the
max-entry-price cap and live LTP comparisons.

For events without a confirmed share factor, the older daily heuristic still
splits a symbol into synthetic segments when its close drops at least 15% and
rupee turnover rises less than 3x. A reviewed genuine crash is exempted from
that segmentation. Demergers, rights, special dividends, and unresolved large
drops require separate valuation work; the heuristic can still mishandle those.
The split point is snapped to the Monday of the event week so weekly columns
do not overlap within a partial week.
"""

from __future__ import annotations

from collections.abc import Iterable
from pathlib import Path

import pandas as pd

from momentum_backtesting.sources import weekly

DAILY_PARQUET_FILENAME = "daily.parquet"

#: Single-day close drop (as a positive fraction, e.g. 0.15 = 15%) that makes a
#: day a detection *candidate*. See module docstring "Detection rule".
DEFAULT_MIN_DROP_PCT = 0.15

#: turnover[t] / turnover[t-1] at or above this multiple means "real volume
#: spike -> genuine move, not corporate-action-like". See module docstring
#: "Threshold justification".
DEFAULT_TURNOVER_SPIKE_MULTIPLE = 3.0

_LOAD_COLUMNS = ("date", "symbol", "close", "turnover")

#: Columns of the DataFrame `detect_events` / the `events` output of
#: `build_stock_weekly_prices` return, in order.
EVENT_COLUMNS = ("symbol", "event_date", "drop_pct", "turnover_ratio", "new_column")


def load_daily_prices(symbols: Iterable[str], *, stocks_data_dir: Path) -> pd.DataFrame:
    """Load daily rows for `symbols` only (columns: date, symbol, close, turnover).

    Prefers the shared local database (`bars_1d_stock`, populated by `mbt local
    migrate`) over `stocks_data_dir/daily.parquet` — see db_read.py's module
    docstring — via the same predicate-pushdown idea (a SQL WHERE, so the full
    ~4,300-symbol, multi-million-row lake is never fully scanned for a modest
    category universe). Falls back to the parquet file (pyarrow predicate
    pushdown) only when there is no catalog at all. Raises FileNotFoundError if
    NEITHER source has the data (the parquet file is a pre-built cache -- this
    module never fetches/builds it, per the task brief). Returns an empty frame
    (not an error) if none of `symbols` appear in whichever source answered.
    """
    from momentum_backtesting import db_read

    unique_symbols = sorted(set(symbols))
    from_db = db_read.daily_prices_from_db_or_none(unique_symbols)
    if from_db is not None:
        return from_db.sort_values(["symbol", "date"]).reset_index(drop=True)

    path = stocks_data_dir / DAILY_PARQUET_FILENAME
    if not path.exists():
        raise FileNotFoundError(f"{path} does not exist -- no cached daily stock prices")
    if not unique_symbols:
        return pd.DataFrame(columns=list(_LOAD_COLUMNS))
    df = pd.read_parquet(
        path,
        columns=list(_LOAD_COLUMNS),
        filters=[("symbol", "in", unique_symbols)],
    )
    df["date"] = pd.to_datetime(df["date"])
    return df.sort_values(["symbol", "date"]).reset_index(drop=True)


def detect_events(
    daily: pd.DataFrame,
    *,
    min_drop_pct: float = DEFAULT_MIN_DROP_PCT,
    turnover_spike_multiple: float = DEFAULT_TURNOVER_SPIKE_MULTIPLE,
) -> pd.DataFrame:
    """Vectorised corporate-action-like-event detection across every symbol in
    `daily` (as returned by `load_daily_prices`: columns date/symbol/close/
    turnover). Returns one row per detected event (columns: symbol, event_date,
    drop_pct, turnover_ratio), sorted by symbol then event_date -- empty
    (same columns) if none are found.

    A row is a candidate if its close fell by at least `min_drop_pct` versus
    the immediately preceding row *for that symbol in this dataset* (i.e. the
    previous trading day actually present -- not calendar-day adjacent, so a
    weekend/holiday gap is transparent). It is confirmed as an event if the
    turnover ratio against that same preceding row is below
    `turnover_spike_multiple`. Rows with no valid preceding close/turnover (a
    symbol's very first row, or a preceding turnover of exactly 0 -- can't form
    a ratio) are never candidates. A *current*-day turnover of exactly 0 is not
    excluded: a mechanical ex-date price adjustment with zero trades that day
    (common for illiquid names) is itself a strong corporate-action-like
    signal (turnover ratio 0, well under the spike threshold), not a reason to
    skip the row.
    """
    if daily.empty:
        return pd.DataFrame(columns=list(EVENT_COLUMNS[:4]))

    d = daily.sort_values(["symbol", "date"]).reset_index(drop=True)
    prev_close = d.groupby("symbol")["close"].shift(1)
    prev_turnover = d.groupby("symbol")["turnover"].shift(1)
    drop = d["close"] / prev_close - 1
    turnover_ratio = d["turnover"] / prev_turnover

    is_event = (
        prev_close.notna()
        & (prev_close > 0)
        & (d["close"] > 0)
        & (prev_turnover > 0)
        & (drop <= -min_drop_pct)
        & (turnover_ratio < turnover_spike_multiple)
    )

    out = d.loc[is_event, ["symbol", "date"]].rename(columns={"date": "event_date"}).copy()
    out["drop_pct"] = drop[is_event].to_numpy()
    out["turnover_ratio"] = turnover_ratio[is_event].to_numpy()
    return out.sort_values(["symbol", "event_date"]).reset_index(drop=True)


def _week_monday(ts: pd.Timestamp) -> pd.Timestamp:
    """The Monday of `ts`'s Mon-Fri trading week -- the mirror of
    `sources.weekly`'s W-FRI (Friday) week-end label."""
    return ts - pd.Timedelta(days=ts.weekday())


def build_symbol_segments(
    close: pd.Series, symbol: str, event_dates: Iterable[pd.Timestamp]
) -> tuple[dict[str, pd.Series], list[tuple[pd.Timestamp, str]], list[str]]:
    """Partition one symbol's daily close series (`close`, indexed by date,
    already sorted) into segments at each of `event_dates`, snapped to the
    week boundary (see module docstring "Detection granularity"). Returns
    (`{column_name: daily close Series}`, `[(week_monday_boundary,
    column_name_that_starts_there), ...]`, `non_terminal_names`) -- the second
    value lets a caller (`build_stock_weekly_prices`) report which synthetic
    column each detected event actually produced; the third lists every
    segment name EXCEPT the last (currently-active) one, for the forward-fill
    mitigation `build_stock_weekly_prices` applies -- see that function's
    docstring "Why forward-fill a stopped segment".

    Two events whose snapped week-Monday coincide (both land in the same
    trading week) collapse to a single boundary -- one split, not two -- since
    a week can only sensibly belong to one segment. A boundary at or before
    the series' very first date is dropped rather than producing an empty
    leading segment (can only happen for an event detected on a symbol's 2nd
    trading day ever, which real listings in this universe never do, but is
    guarded rather than silently mis-numbering the segments if it ever did).
    """
    if close.empty:
        return {}, [], []

    first = close.index.min()
    boundaries = sorted({_week_monday(pd.Timestamp(d)) for d in event_dates})
    boundaries = [b for b in boundaries if b > first]

    if not boundaries:
        return {symbol: close}, [], []

    names = [symbol, *(f"{symbol}#{i}" for i in range(2, len(boundaries) + 2))]
    starts = [first, *boundaries]
    ends = [*boundaries, close.index.max() + pd.Timedelta(days=1)]

    segments: dict[str, pd.Series] = {}
    for name, start, end in zip(names, starts, ends, strict=True):
        seg = close[(close.index >= start) & (close.index < end)]
        if not seg.empty:
            segments[name] = seg

    boundary_names = list(zip(boundaries, names[1:], strict=True))
    non_terminal_names = [n for n in names[:-1] if n in segments]
    return segments, boundary_names, non_terminal_names


def build_stock_weekly_prices(
    symbols: Iterable[str],
    *,
    stocks_data_dir: Path,
    min_drop_pct: float = DEFAULT_MIN_DROP_PCT,
    turnover_spike_multiple: float = DEFAULT_TURNOVER_SPIKE_MULTIPLE,
    series_breaks: str = "legacy",
    carry_forward_stopped_segments: bool = True,
    return_raw_weekly: bool = False,
) -> (
    tuple[pd.DataFrame, pd.DataFrame, dict[str, pd.Timestamp]]
    | tuple[pd.DataFrame, pd.DataFrame, dict[str, pd.Timestamp], pd.DataFrame]
):
    """The main entry point: given a set of stock symbols (typically from
    `resolve_category_members`), build a weekly (Friday-close) price
    DataFrame (columns = symbol, or `symbol#N` for a post-event segment;
    index = week) suitable for feeding into `engine.run_backtest`, plus a
    report of every detected corporate-action-like event.

    Returns `(weekly_prices, events, stale_columns)`. `weekly_prices` is
    resampled per segment via `sources.weekly` (Friday close) -- reused
    rather than reimplemented, per the task brief. `events` has columns
    `prices.EVENT_COLUMNS` (symbol, event_date, drop_pct, turnover_ratio,
    new_column) -- empty with those columns if no symbols/events are found.
    `stale_columns` is documented below ("Any column can go stale, not just
    a detected event's"). A symbol entirely missing from daily.parquet is
    silently absent from the output (not an error) -- the caller
    (categories/compose.py) is expected to reconcile against the requested
    symbol set if it needs to report gaps.

    **Any column can go stale, not just a detected event's.** A column's
    real daily.parquet coverage can simply end for reasons `detect_events`
    has no signal for at all -- a plain symbol rename with no price
    discontinuity is the confirmed real case (IDFCBANK -> IDFCFIRSTB,
    2019-01-16: IDFCBANK's last daily.parquet row is 2019-01-15, no unusual
    move on it, and daily.parquet has no alias table the way stocks/ does
    for its own, much more curated dataset -- see that package's
    aliases.csv). Without an alias table, a renamed symbol is
    indistinguishable here from "this company simply stopped trading", and
    either way its OWN column just runs out of real data with no drop to
    detect. This is the exact same NaN-corrupts-a-held-position mechanism
    "Why forward-fill a stopped segment" documents for a *detected* split --
    just triggered by "ran out of daily.parquet rows" instead of "large
    price move" -- so it needs the identical treatment, generalised: EVERY
    column (not only ones `build_symbol_segments` split) whose own last real
    (pre-forward-fill) week falls short of the whole frame's last week is
    "stale" and goes through the same forward-fill + (in
    categories/compose.py) buy-ineligible-after-its-own-cutoff treatment.
    `stale_columns` reports each such column's own last real week (the
    forward-fill/exclusion cutoff) -- callers other than compose.py that
    just want prices can ignore it.

    **Why forward-fill a stopped segment (`carry_forward_stopped_segments`,
    default True)**: verified live against a real backtest (Nifty PSU Bank,
    2018-2025) that `engine.run_backtest` has a one-week mechanics gap for any
    *currently held* instrument whose price series stops. `_Sim.exit_reason`
    checks eligibility using data available *through the current week*, but
    that same week's "hold for one more week" step already needs *next*
    week's price to mark the position to market -- one week before
    `exit_reason` would next be evaluated for that week. If a held column's
    price is genuinely absent (NaN) at that next week, the mark-to-market
    multiply corrupts the position's value to NaN, which then poisons the
    portfolio's total value for every week from then on (NaN is contagious
    once it reaches the shared cash/portfolio total) -- observed exactly this
    way for IDBI, split 2020-03-12, corrupting 251 of 365 weeks of equity in
    an otherwise-unmodified inner backtest. The task brief's own reasoning
    ("a price series that stops is handled by the same ineligible/rank-NaN
    path a not-yet-listed instrument's future is") holds for a column that
    hasn't *started* yet (never held, so never mark-to-market'd), but not for
    one that stops while actively held -- a real gap in that assumption,
    surfaced by testing exactly as the brief asked.

    This is deliberately fixed here, in Piece A's own code, rather than in
    engine.py (which the task brief says not to touch without explicit
    sign-off): every stale column (every synthetic split segment except the
    last/currently-active one for its base symbol, PLUS any column at all --
    split or not -- whose real data simply runs out before the frame's last
    week, per "Any column can go stale" above) is forward-filled flat from
    its last real close through to the end of the whole weekly frame, so the
    engine never observes a currently-held column's price vanish. This never
    revives a stale column's eligibility for a NEW purchase after its own
    cutoff -- categories/compose.py's membership gate uses `stale_columns`
    (this function's third return value) to exclude exactly that, on top of
    its existing base-symbol-year category check -- it only prevents an
    *existing* holding from corrupting the whole simulation the moment its
    price disappears. A flat, zero-return "zombie" column does remain
    technically rankable indefinitely by THIS function alone (the
    buy-eligibility exclusion lives in compose.py, not here) -- in practice
    this is low-risk once compose.py's gate is applied (a persistent
    exact-0% return will rank near the bottom against real, moving category
    peers within a few weeks even for the rare case where it's still
    nominally rankable), but it is a real trade-off, not a free fix --
    flagged in this task's final report for explicit review. Pass
    `carry_forward_stopped_segments=False` to see the raw (NaN-corrupting)
    behaviour instead.
    """
    daily = load_daily_prices(symbols, stocks_data_dir=stocks_data_dir)
    if daily.empty:
        empty = (pd.DataFrame(), pd.DataFrame(columns=list(EVENT_COLUMNS)), {})
        return (*empty, pd.DataFrame()) if return_raw_weekly else empty

    # Confirmed exchange filings supply share-count factors. Back-adjust only
    # earlier closes; this preserves economic returns through splits/bonuses.
    # The raw closes are kept separately for the per-share entry price ceiling.
    raw_daily = daily.copy()
    from trading_data.db import connect, data_root

    from momentum_backtesting import db_read, stock_actions

    if series_breaks not in ("legacy", "verified"):
        raise ValueError("series_breaks must be 'legacy' or 'verified'")
    actions = {}
    explained: set[tuple[str, pd.Timestamp]] = set()
    crashes: set[tuple[str, pd.Timestamp]] = set()
    if db_read.catalog_mtime() is not None:
        with connect(data_root(), read_only=True) as con:
            if db_read._has_table(con, "stock_action_candidates"):
                wanted = daily["symbol"].unique().tolist()
                actions = stock_actions.confirmed_factors(con, wanted)
                crashes = stock_actions.classified_crashes(con, wanted)
                if series_breaks == "verified":
                    explained = stock_actions.explained_breaks(con, wanted)
    symbol_indices = daily.groupby("symbol", sort=False).indices
    for symbol, events_for_symbol in actions.items():
        indices = symbol_indices.get(symbol)
        if indices is None:
            continue
        for ex_date, factor in events_for_symbol:
            before = indices[daily.loc[indices, "date"].to_numpy() < ex_date.to_datetime64()]
            daily.loc[before, "close"] /= factor

    events = detect_events(
        daily, min_drop_pct=min_drop_pct, turnover_spike_multiple=turnover_spike_multiple
    )
    if crashes and not events.empty:
        events = events.loc[
            ~events.apply(lambda row: (row.symbol, row.event_date) in crashes, axis=1)
        ].reset_index(drop=True)
    if series_breaks == "verified" and not events.empty:
        # A fall with no corporate-action explanation is a genuine price move: keep ONE continuous
        # series. ("legacy" starts a new column at every such fall, which retires the held segment,
        # freezes it at its pre-fall price and sells it there - so a position that crashes is
        # valued as if it had not. Measured: -7 to -12 points of CAGR on Round 6 winners.)
        events = events.loc[
            events.apply(lambda row: (row.symbol, row.event_date) in explained, axis=1)
        ].reset_index(drop=True)
    events_by_symbol = events.groupby("symbol")["event_date"].apply(list).to_dict()

    weekly_columns: dict[str, pd.Series] = {}
    raw_weekly_columns: dict[str, pd.Series] = {}
    new_column_by_symbol_boundary: dict[str, str] = {}
    non_terminal_columns: list[str] = []
    for symbol, group in daily.groupby("symbol", sort=True):
        close = group.set_index("date")["close"].sort_index()
        close = close[~close.index.duplicated(keep="last")]
        raw_close = None
        if return_raw_weekly:
            raw_close = raw_daily.loc[group.index].set_index("date")["close"]
        segments, boundary_names, non_terminal_names = build_symbol_segments(
            close, symbol, events_by_symbol.get(symbol, [])
        )
        for name, seg in segments.items():
            weekly_columns[name] = weekly(seg)
            if raw_close is not None:
                raw_weekly_columns[name] = weekly(raw_close.reindex(seg.index))
        for boundary, name in boundary_names:
            new_column_by_symbol_boundary[(symbol, boundary)] = name
        non_terminal_columns.extend(non_terminal_names)

    frame = pd.DataFrame(weekly_columns).sort_index()
    frame_end = frame.index.max()

    # Any column (event-split or not) whose own real data doesn't reach the frame's last
    # week is stale -- see "Any column can go stale, not just a detected event's" above.
    # Computed from the pre-forward-fill frame, so a column's *own* last real week is used,
    # not a week where an earlier stale column's own forward-fill happens to still be live.
    stale_columns: dict[str, pd.Timestamp] = {}
    for col in frame.columns:
        last_real = frame[col].last_valid_index()
        if last_real is not None and last_real < frame_end:
            stale_columns[col] = last_real
    stale_columns_to_fill = set(non_terminal_columns) | set(stale_columns)

    if carry_forward_stopped_segments:
        for col in stale_columns_to_fill:
            frame[col] = frame[col].ffill()

    if events.empty:
        events_out = pd.DataFrame(columns=list(EVENT_COLUMNS))
    else:
        events_out = events.copy()
        events_out["new_column"] = [
            new_column_by_symbol_boundary.get((row.symbol, _week_monday(row.event_date)), "")
            for row in events_out.itertuples(index=False)
        ]
        events_out = events_out[list(EVENT_COLUMNS)]

    if return_raw_weekly:
        raw_frame = pd.DataFrame(raw_weekly_columns).reindex(frame.index)
        if carry_forward_stopped_segments:
            for col in stale_columns_to_fill:
                raw_frame[col] = raw_frame[col].ffill()
        return frame, events_out, stale_columns, raw_frame
    return frame, events_out, stale_columns
