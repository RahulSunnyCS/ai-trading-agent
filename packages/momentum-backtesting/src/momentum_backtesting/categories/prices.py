"""Per-stock weekly price series for the category-momentum inner backtest, with
naive corporate-action-like-event detection -- Piece A of the category-momentum
feature (see the task brief; Piece B, the inner/outer composition, is
categories/compose.py).

**Scope, deliberately narrow**: no dividend/rights/scheme/demerger *adjustment*
of any kind. This module never tries to compute a return-preserving adjustment
factor (that is what stocks/adjust.py's total-return machinery does, for a much
narrower Nifty-50-only dataset, for a different purpose -- see that package's
own module docstring). The only thing detected here is: was a big single-day
price move a *mechanical* corporate-action-like event (split/bonus/demerger --
anything that mechanically changes what a share represents) or a genuine market
move (crash, rally, business news)? On a detected event, the symbol is simply
split into two synthetic instruments at that point -- no attempt to preserve
price continuity across it. See "Detection rule" and "Split, don't adjust"
below.

**Detection rule**: for any day where `close` drops >= `min_drop_pct` (default
15%) vs the prior trading day's close, look at the turnover ratio
`turnover[t] / turnover[t-1]` (turnover = rupee value traded, i.e. price x
volume -- already a daily.parquet column, not derived). If turnover did NOT
spike several-fold (< `turnover_spike_multiple`, default 3x), the drop is
treated as corporate-action-like: a mechanical share-count/face-value change
moves the price without anyone actually selling in a panic, so volume stays
normal (or even *drops*, since fewer shares now change hands for the same
rupee interest -- see ONGC below). A drop accompanied by a genuine turnover
spike is treated as a real market move: an unmechanical crash needs someone to
actually sell into it.

**Threshold justification (3x, tested 2026-09 against real daily.parquet
rows)**:
  - ONGC's real 2011-02-08 bonus+split: close -76.4%, turnover ratio 0.52x
    (turnover roughly *halved* -- verified against this exact dataset. This
    package README/brief's own reference example).
  - Policybazaar's real 2026-09-24 crash (confirmed genuine business news, not
    a CA): close -36.0%, turnover ratio 7.57x (verified).
  - A broader sweep of well-known large-cap splits/bonuses in this dataset
    (TATAMOTORS 2011-09-12 face-value split, ratio 1.05x; ICICIBANK 2014-12-04
    split, 1.14x; INFY's three bonus/split events 2014-2018, 0.53-1.43x; WIPRO's
    three bonuses 2017-2024, 0.72-1.38x; BAJFINANCE's 2016 split and its
    documented 2025-06-16 bonus+split (see stocks/schemas.py's EventKind
    docstring), 0.63x/0.70x; GRASIM's 2016 demerger, 2.24x; TATASTEEL's 2022
    10:1 split, 2.72x) all cluster well under 3x, with the highest at 2.72x.
  - A sweep of confirmed genuine, news-driven crashes (INFY's 2019 whistleblower
    crash, 7.70x; YESBANK's 2018/2019/2020 crisis days, 3.27-13.8x; DHFL's 2018
    IL&FS-crisis-adjacent crash, 13.2x; PC Jeweller's 2018 crashes, 10.8-14.5x;
    RCom's 2017 crash, 6.71x) all cluster well above 3x, with the lowest
    comfortably-genuine case at 3.27x -- and even that one (YESBANK) also has a
    same-week corroborating event above 7x.
  - 3x sits in the gap between 2.72x (highest confirmed real CA) and 3.27x
    (lowest confirmed genuine crash) for every case checked. It is not a
    precisely optimal boundary -- there is no such thing with only ~15 hand
    labelled points -- but it is a reasonable, documented, testable default,
    and it is a `min_drop_pct`/`turnover_spike_multiple` keyword on every
    function below so a caller can retune it without touching this module.

**Known limitation -- correlated market-wide crashes (flag for review, not
solved here)**: this rule has one confirmed false-positive mode. During the
COVID March-2020 crash week, several large-caps show a >=15% single-day drop
with a turnover ratio *below* 3x (e.g. ICICIBANK 2020-03-23 at 0.55x,
BAJFINANCE 2020-03-23 at 0.68x, GRASIM 2020-03-23 at 1.21x -- verified against
this dataset), because the *previous* day was already an elevated-volume panic
day, so day-over-day turnover doesn't "spike" even though the move is a
genuine, market-wide, news-driven event, not a mechanical one. The brief for
this task specifies exactly the turnover-ratio rule above (no market-breadth
cross-check); implementing a broader "was this move genuinely single-stock, or
did most of the market move together that day" heuristic is a real, separate
design decision. This is flagged here deliberately rather than silently
papered over -- a caller running this over a period spanning March 2020 should
expect a small number of false-positive splits around 2020-03-09..2020-03-24
and sanity-check that window specifically.

**Known limitation -- the opposite failure, a real split/bonus with a genuine
turnover spike on its own ex-date (flag for review, not solved here; TODO.md
3.9.21)**: confirmed live 2026-09-29 against this exact dataset. AIIL (Authum
Investment & Infrastructure) had a real bonus issue around 2026-01-13 (close
3098.6 -> 667.9, -78.4%, consistent with NSE's reported ~4:1 bonus ratio and
corroborated by AIIL's own reported all-time-high of ~683 shortly after, at
the new post-bonus price level) -- but same-day turnover was 257.6 Cr against
44.4 Cr the prior day, a 5.81x ratio, comfortably *above* `turnover_spike_
multiple` (3.0x). `detect_events` therefore never flags this day at all (the
`turnover_ratio < turnover_spike_multiple` condition fails), AIIL's price
series is never split, and this single stock's column silently carries a
fake -78% "return" into any backtest ranking it over that period. Root cause:
unlike the well-behaved historical splits/bonuses this module's 3x threshold
was tuned against (see "Threshold justification" above, all comfortably
<=2.72x), a corporate action's own record/ex-date can itself draw genuine
elevated trading (arbitrage, index-linked flows, retail reaction to the
lower post-event price) large enough to clear the same multiple used to spot
a genuine crash -- so single-day turnover ratio alone cannot reliably
separate this case from a real market move; simply raising the 3x threshold
would fix this instance but reopens the door to misclassifying genuine
crashes as mechanical (the lowest confirmed genuine crash in this dataset,
YESBANK, sits at 3.27x -- barely above 3x, so a fix that raises the multiple
enough to clear 5.81x would very likely swallow real crashes too, trading
one failure mode for a worse one; not attempted here). A more promising fix
direction, not implemented here because it is a real design change to a
shared price-adjustment path every backtest depends on: cross-check a
turnover-spike candidate against `stocks/corporate_actions.py`'s existing
NSE whole-market corporate-actions feed fetcher (symbol/date/subject, not
Nifty-50-scoped) before falling back to the turnover-ratio heuristic alone --
a real bonus/split filing on/near the candidate date would settle the
classification independent of that day's turnover, at the cost of a new
fetch/cache dependency this module doesn't currently have for the 755-name
Total Market universe. Flagged here deliberately, mirroring the false-
positive limitation above, rather than silently left for the next person to
rediscover.

**Split, don't adjust**: on a detected event, the symbol's price history is
partitioned at that point into two (or, over repeated events, more) synthetic
column names: `TICKER` keeps everything up to (not including) the event, and
`TICKER#2` starts fresh from the event onward; a third event on the same
underlying symbol produces `TICKER#3`, and so on. This is deliberately the
*same* treatment for every detected event, not just demergers -- there is no
reliable columns-only signal (this dataset has no corporate-action-kind label,
unlike stocks/events.parquet's curated feed) to distinguish "clean bonus,
preserve continuity" from "demerger, the old entity's economics genuinely end
here", so resetting is the uniform, safe default. See
categories/compose.py and engine.py's own module docstring for why splitting
(rather than adjusting) needs no engine.py change: a column whose valid prices
simply stop is exactly `_Sim.exit_reason`'s existing "rank went NaN -> force
sell" path, and a column that only starts partway through is exactly how a
newly-listed instrument already becomes eligible today (once it has a full
lookback window of history).

**Detection granularity: daily, snapped to the week boundary**. Detection
itself runs on the *daily* close/turnover series (not the weekly-resampled
one): a single bad day would otherwise get diluted into a Friday-over-Friday
return if only the weekly series were checked, which could both miss real
events (the drop lands mid-week, largely offset by the rest of that week's
move by Friday) and misattribute the timing of ones it did catch. Once an
event's exact daily date is found, the split point is snapped to the *Monday
of that date's trading week* (Mon-Fri, labelled by `sources.weekly`'s own
W-FRI convention) rather than the exact day: the whole week containing the
event is assigned wholly to the *new* segment, and the previous week is the
last one wholly in the *old* segment. This avoids a transition week where the
old segment holds a stale (pre-event) Friday resample value and the new
segment simultaneously starts populating for the *same* week x symbol column
pair (the two would otherwise sit awkwardly close together mid-week, and
`run_backtest`'s ranking is week-granular, not daily, so a same-week
old/new-both-partial overlap has no clean interpretation for it). This is
the one place this module deviates from "exactly the reported daily event
date" -- documented here per the brief's request to verify and justify this
choice rather than silently assume it.
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
    """Load `stocks_data_dir/daily.parquet` rows for `symbols` only (columns:
    date, symbol, close, turnover), via pyarrow predicate pushdown so the full
    ~4,300-symbol, multi-million-row file is never fully materialised in memory
    for a modest category universe. Raises FileNotFoundError if the parquet
    file itself doesn't exist (it is a pre-built cache -- this module never
    fetches/builds it, per the task brief). Returns an empty frame (not an
    error) if none of `symbols` appear in the file at all.
    """
    unique_symbols = sorted(set(symbols))
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
    carry_forward_stopped_segments: bool = True,
) -> tuple[pd.DataFrame, pd.DataFrame, dict[str, pd.Timestamp]]:
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
        return pd.DataFrame(), pd.DataFrame(columns=list(EVENT_COLUMNS)), {}

    events = detect_events(
        daily, min_drop_pct=min_drop_pct, turnover_spike_multiple=turnover_spike_multiple
    )
    events_by_symbol = events.groupby("symbol")["event_date"].apply(list).to_dict()

    weekly_columns: dict[str, pd.Series] = {}
    new_column_by_symbol_boundary: dict[str, str] = {}
    non_terminal_columns: list[str] = []
    for symbol, group in daily.groupby("symbol", sort=True):
        close = group.set_index("date")["close"].sort_index()
        close = close[~close.index.duplicated(keep="last")]
        segments, boundary_names, non_terminal_names = build_symbol_segments(
            close, symbol, events_by_symbol.get(symbol, [])
        )
        for name, seg in segments.items():
            weekly_columns[name] = weekly(seg)
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

    return frame, events_out, stale_columns
