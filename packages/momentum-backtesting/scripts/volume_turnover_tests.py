"""Volume, trend stage and moving averages as ranking aids (TODO.md 3.9.27).

The spec is docs/momentum-volume-turnover-tests.md (hypotheses H1-H8, stages V0-V5). Broad
Momentum only. Every backtest is an unchanged `engine.run_backtest`; engine.py is never edited.
Shared helpers come from scripts/breadth_regime_tests.py and scripts/overextension_trim_tests.py.

Run from packages/momentum-backtesting:

    uv run python scripts/volume_turnover_tests.py v0   # data checks, redundancy count, stages
    uv run python scripts/volume_turnover_tests.py v1   # spike split on the 3.9.26 events (H2)
    uv run python scripts/volume_turnover_tests.py v2   # predictive test (H1, H4-H7)
    uv run python scripts/volume_turnover_tests.py v3   # liquidity floor reruns (H3)

`v0` builds the weekly feature table and saves it; later stages reuse it (rerun `v0` after a
data refresh). Output goes to data/backtests/volume/ (gitignored).

Conventions (no lookahead):
- Daily rows come from the shared catalog's `bars_1d_stock` (the same table `load_daily_prices`
  and so the Broad price frame read), with share volume, high and low. Synthetic archive-gap
  rows are dropped: their volume is a copy, not a real session.
- Every daily row is assigned to the price segment (`SYM`, `SYM#2`, ...) that
  `categories/prices.build_symbol_segments` cuts the close series into, so no ratio spans a
  split. Ratios need full windows inside one segment.
- A feature at Friday t uses sessions up to and including t, labelled with the same W-FRI bins
  as `sources.weekly`.
"""

from __future__ import annotations

import argparse
import math
import sys
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent))
import breadth_regime_tests as brt  # noqa: E402
import overextension_trim_tests as ott  # noqa: E402

RECENT2 = 10  # sessions, VR2
RECENT4 = 20  # sessions, VR4
PRIOR = 130  # sessions (26 weeks), the VR denominator
WINDOW13 = 65  # sessions, ACC13 and LIQ13
MA_SHORT = 10  # weeks, ABOVE10 / DIST10 (stands in for the 50-day average)
MA_STAGE = 30  # weeks, the stage average
SLOPE_LAG = 4  # weeks
MIN_MA_WEEKS = 34  # a segment's own weekly closes before any moving-average feature
STAGE_BAND = 0.01
STAGE_BANDS_INFO = (0.005, 0.01, 0.02)
STAGE_HOLD = 2  # weeks a new stage must hold before it is recorded
EARLY_WEEKS = 13
REDUNDANCY_FLOOR = 0.05
CRORE = 1e7
START = ott.START
FIRST_HALF_END = ott.FIRST_HALF_END
MIN_EVENT_WEEKS = 10  # V1 pass rule
V2_HORIZONS = (1, 4, 13, 26, 52)
PASS_HORIZONS = (4, 13)
CONTINUOUS = ("VR2", "VR4", "ACC13", "DIST10")  # residual IC + tercile spread
FLAGS = ("RISE2", "ABOVE10", "STAGE3", "EARLY2")  # one regression per week
CROSS_CHECK = ("DIST10",)  # reported, never a pass (owner, after V0)
H7_FEATURES = ("STAGE3", "EARLY2")
H7_BANDS = (0.01, 0.02)
VOLUME_FEATURES = ("VR2", "VR4", "RISE2", "ACC13")  # H5 life cycle
MIN_NAMES = 8  # per week, for a residual IC / spread / flag regression
MIN_FLAG_EACH = 3  # per week, flagged and unflagged names a flag regression needs
LIQ_FLOORS_CR = (1, 5, 10)

FEATURES = (
    "VR2",
    "VR4",
    "RISE2",
    "ACC13",
    "LIQ13",
    "CLV2",
    "ABOVE10",
    "DIST10",
    "STAGE",
    "EARLY2",
)

# Stage sanity names and the week of their big run (the trim test's sanity table). Resolved to
# the price segment that covers that week at run time.
SANITY = {
    "IRFC": "2024-01-19",
    "RVNL": "2023-05-05",
    "IFCI": "2024-02-02",
    "HINDCOPPER": "2021-02-26",
    "GPIL": "2017-12-22",
}

# The three Broad strategies of the trim test (3.9.26), same overrides as its `build_all`.
BROAD = {
    "C3": ("C3: Broad Momentum, shipped defaults", {}),
    "C4": (
        "C4: Broad, category mode off, top 10/exit 20",
        {"category_mode": "off", "off_top_n": 10, "off_exit_rank": 20},
    ),
    "C5": (
        "C5: Broad, entry=make_room, coverage floor 0.25",
        {"entry": "make_room", "coverage_floor": 0.25},
    ),
}


# ---------------------------------------------------------------------------------------------
# Pure pieces (unit-tested in tests/test_volume_turnover.py)
# ---------------------------------------------------------------------------------------------


def friday_label(dates: pd.Series) -> pd.Series:
    """The W-FRI week each date belongs to, the same bins as `sources.weekly`: a Saturday or
    Sunday session (budget day, Muhurat trading) rolls forward to the next Friday."""
    d = pd.to_datetime(dates)
    return d + pd.to_timedelta((4 - d.dt.weekday) % 7, unit="D")


def segment_columns(daily: pd.DataFrame, events: pd.DataFrame) -> np.ndarray:
    """Price-segment column (`SYM`, `SYM#2`, ...) of every row of `daily` (columns symbol, date;
    sorted by symbol then date; positional index), cut exactly where
    `categories/prices.build_symbol_segments` cuts that symbol's close series."""
    from momentum_backtesting.categories import prices as cat_prices

    by_symbol = events.groupby("symbol")["event_date"].apply(list).to_dict() if len(events) else {}
    out = np.empty(len(daily), dtype=object)
    positions = np.arange(len(daily))
    for symbol, rows in daily.groupby("symbol", sort=False):
        pos = pd.Series(positions[rows.index], index=pd.DatetimeIndex(rows["date"]))
        segments, _, _ = cat_prices.build_symbol_segments(pos, symbol, by_symbol.get(symbol, []))
        for name, seg in segments.items():
            out[seg.to_numpy()] = name
    return out


def _rolling(g, column: str, n: int, how: str) -> pd.Series:
    r = g[column].rolling(n, min_periods=n)
    return getattr(r, how)().reset_index(level=0, drop=True)


def daily_volume_features(daily: pd.DataFrame) -> pd.DataFrame:
    """Rolling volume features per daily row, within its segment `col`, from sessions up to and
    including that row. Input columns: col, date, close, shares, turnover; sorted by col then
    date. Medians, not sums, for the ratios: block deals and index days are one-day spikes.

    VR2 = median shares, last 10 sessions / median over the 130 sessions before those.
    VR4 = the same with the last 20 sessions. ACC13 = shares on up-close days / shares on
    down-close days, last 65 sessions. LIQ13 = median rupee turnover, last 65 sessions."""
    d = daily.copy()
    g = d.groupby("col", sort=False)
    prior = _rolling(g, "shares", PRIOR, "median")
    prior_by = prior.groupby(d["col"], sort=False)
    p2 = prior_by.shift(RECENT2)
    p4 = prior_by.shift(RECENT4)
    d["VR2"] = _rolling(g, "shares", RECENT2, "median") / p2.where(p2 > 0)
    d["VR4"] = _rolling(g, "shares", RECENT4, "median") / p4.where(p4 > 0)
    prev = g["close"].shift(1)
    d["up_sh"] = d["shares"].where(d["close"] > prev, 0.0)
    d["down_sh"] = d["shares"].where(d["close"] < prev, 0.0)
    g = d.groupby("col", sort=False)
    down = _rolling(g, "down_sh", WINDOW13, "sum")
    d["ACC13"] = _rolling(g, "up_sh", WINDOW13, "sum") / down.where(down > 0)
    d["LIQ13"] = _rolling(g, "turnover", WINDOW13, "median")
    return d.drop(columns=["up_sh", "down_sh"])


def weekly_volume_features(daily: pd.DataFrame) -> dict[str, pd.DataFrame]:
    """Week x segment frames for VR2, VR4, ACC13, LIQ13 (value at the week's last session),
    RISE2 (weekly median shares up in each of the last 2 weeks) and CLV2 (where the week's close
    sits in its 2-week high-low range). Input: `daily_volume_features` output plus high/low."""
    d = daily.copy()
    d["week"] = friday_label(d["date"])
    last = d.drop_duplicates(["col", "week"], keep="last").set_index(["week", "col"])
    out = {
        name: last[name].unstack("col").sort_index() for name in ("VR2", "VR4", "ACC13", "LIQ13")
    }
    wk = d.groupby(["col", "week"], sort=True).agg(
        med=("shares", "median"), high=("high", "max"), low=("low", "min"), close=("close", "last")
    )
    by = wk.groupby(level="col", sort=False)
    m1, m2 = by["med"].shift(1), by["med"].shift(2)
    rise = ((wk["med"] > m1) & (m1 > m2)).astype(float).where(m2.notna())
    hi2 = np.maximum(wk["high"], by["high"].shift(1))
    lo2 = np.minimum(wk["low"], by["low"].shift(1))
    rng = hi2 - lo2
    clv = ((wk["close"] - lo2) / rng.where(rng > 0)).where(by["high"].shift(1).notna())
    out["RISE2"] = rise.unstack("col").sort_index()
    out["CLV2"] = clv.unstack("col").sort_index()
    return out


def history_ok(prices: pd.DataFrame, stale: dict[str, pd.Timestamp] | None = None) -> pd.DataFrame:
    """True where a segment has a real close and at least MIN_MA_WEEKS of its own weekly closes,
    and (for a stale column) the week is not past its last real week (no flat ffilled tail)."""
    ok = (prices.notna().cumsum() >= MIN_MA_WEEKS) & prices.notna()
    for col, cutoff in (stale or {}).items():
        if col in ok.columns:
            ok.loc[ok.index > cutoff, col] = False
    return ok


def ma_features(prices: pd.DataFrame, ok: pd.DataFrame) -> dict[str, pd.DataFrame]:
    """ABOVE10 (1/0) and DIST10 = close / 10-week simple average - 1, NaN outside `ok`."""
    ma = prices.rolling(MA_SHORT, min_periods=MA_SHORT).mean()
    above = (prices > ma).astype(float).where(ok & ma.notna())
    dist = (prices / ma - 1).where(ok)
    return {"ABOVE10": above, "DIST10": dist}


def raw_trend(prices: pd.DataFrame, ok: pd.DataFrame, band: float = STAGE_BAND) -> pd.DataFrame:
    """2 = close above a rising 30-week average, 4 = below a falling one, 0 = anything else,
    NaN where the history is too short. Rising/falling: MA30 / MA30 four weeks ago - 1 beyond
    +/- `band`."""
    ma = prices.rolling(MA_STAGE, min_periods=MA_STAGE).mean()
    slope = ma / ma.shift(SLOPE_LAG) - 1
    raw = pd.DataFrame(0.0, index=prices.index, columns=prices.columns)
    raw[(prices > ma) & (slope > band)] = 2.0
    raw[(prices < ma) & (slope < -band)] = 4.0
    return raw.where(ok & slope.notna())


def stage_series(raw: np.ndarray, hold: int = STAGE_HOLD) -> tuple[np.ndarray, np.ndarray]:
    """Weinstein stage per week from `raw_trend` codes (2, 4, 0 = neither, NaN = unknown).

    A week's candidate is its raw code when that is 2 or 4. Otherwise it is 3 if the last
    recorded trending stage was 2 (topping), 1 if it was 4 (basing), unknown if there has been
    none yet. A new stage is recorded only after its candidate holds for `hold` consecutive
    weeks; a one-week flip back to the recorded stage cancels it. A NaN week outputs NaN and
    leaves the state alone. Returns (stage, weeks in stage), the count starting at 1 on the first
    week of the confirming run.

    Left-censoring: a spell whose confirming run starts at the segment's first classifiable week
    (data start, or a segment restart such as the 2020 false splits) may have begun earlier, so
    its weeks-in-stage is NaN for the whole spell (EARLY2 is then unknown)."""
    n = len(raw)
    stage = np.full(n, np.nan)
    weeks_in = np.full(n, np.nan)
    recorded = math.nan
    last_trend = math.nan
    pending, count, pending_start, start = math.nan, 0, -1, -1
    first = -1
    censored = False
    for i, r in enumerate(raw):
        if math.isnan(r):
            continue
        if first < 0:
            first = i
        if r in (2.0, 4.0):
            cand = r
        elif last_trend == 2.0:
            cand = 3.0
        elif last_trend == 4.0:
            cand = 1.0
        else:
            cand = math.nan
        if math.isnan(cand) or cand == recorded:
            pending, count = math.nan, 0
        else:
            if cand == pending:
                count += 1
            else:
                pending, count, pending_start = cand, 1, i
            if count >= hold:
                recorded, start = cand, pending_start
                censored = pending_start == first
                pending, count = math.nan, 0
        if recorded in (2.0, 4.0):
            last_trend = recorded
        if not math.isnan(recorded):
            stage[i] = recorded
            weeks_in[i] = np.nan if censored else i - start + 1
    return stage, weeks_in


def stages(
    prices: pd.DataFrame, ok: pd.DataFrame, band: float = STAGE_BAND
) -> tuple[pd.DataFrame, pd.DataFrame]:
    raw = raw_trend(prices, ok, band)
    st = pd.DataFrame(np.nan, index=raw.index, columns=raw.columns)
    wk = st.copy()
    for col in raw.columns:
        s, w = stage_series(raw[col].to_numpy(dtype=float))
        st[col] = s
        wk[col] = w
    return st, wk


def early2(stage: pd.DataFrame, weeks_in: pd.DataFrame) -> pd.DataFrame:
    """1 in the first EARLY_WEEKS of a Stage 2 spell, 0 elsewhere; NaN where the stage is
    unknown or the Stage 2 spell is left-censored (see `stage_series`)."""
    flag = ((stage == 2) & (weeks_in <= EARLY_WEEKS)).astype(float)
    return flag.where(stage.notna() & ~((stage == 2) & weeks_in.isna()))


def cells(mask: pd.DataFrame) -> pd.MultiIndex:
    """(week, column) of every True cell."""
    s = mask.stack()
    return s.index[s.to_numpy(dtype=bool)]


def lookup(frame: pd.DataFrame, weeks, cols) -> np.ndarray:
    """Values of a week x column frame at (week, column) pairs; NaN where absent."""
    rows = frame.index.get_indexer(pd.DatetimeIndex(weeks))
    cidx = frame.columns.get_indexer(pd.Index(cols))
    out = np.full(len(rows), np.nan)
    found = (rows >= 0) & (cidx >= 0)
    out[found] = frame.to_numpy(dtype=float)[rows[found], cidx[found]]
    return out


def stage2_spells(stage: pd.DataFrame, weeks_in: pd.DataFrame) -> pd.DataFrame:
    """One row per Stage 2 spell: column, first week, censored (start unknown)."""
    s2 = stage == 2
    starts = s2 & ~s2.shift(1, fill_value=False)
    at = cells(starts)
    return pd.DataFrame(
        {
            "column": at.get_level_values(1),
            "first_week": at.get_level_values(0),
            "censored": np.isnan(lookup(weeks_in, at.get_level_values(0), at.get_level_values(1))),
        }
    )


def rank_residual(y: pd.Series, controls: pd.DataFrame) -> pd.Series:
    """One week's cross-section: percentile-rank y and each control, OLS of y's rank on the
    controls' ranks plus a constant, return the residual (NaN where any input is NaN)."""
    frame = pd.concat([y.rename("_y"), controls], axis=1).dropna()
    out = pd.Series(np.nan, index=y.index)
    if len(frame) <= controls.shape[1] + 1:
        return out
    ranks = frame.rank(pct=True)
    x = np.column_stack([np.ones(len(ranks)), ranks.drop(columns="_y").to_numpy()])
    beta, *_ = np.linalg.lstsq(x, ranks["_y"].to_numpy(), rcond=None)
    out.loc[frame.index] = ranks["_y"].to_numpy() - x @ beta
    return out


def spearman(a: pd.Series, b: pd.Series) -> float:
    """Rank correlation on the rows where both are present (NaN under 3 rows or no spread)."""
    both = pd.concat([a, b], axis=1).dropna()
    if len(both) < 3:
        return np.nan
    r = both.rank()
    sa, sb = r.iloc[:, 0], r.iloc[:, 1]
    if sa.std() == 0 or sb.std() == 0:
        return np.nan
    return float(np.corrcoef(sa, sb)[0, 1])


def weekly_ic(feature: pd.DataFrame, target: pd.DataFrame, universe: pd.DataFrame) -> pd.Series:
    """Per week: rank correlation of `feature` with `target` across the names in `universe`."""
    out = {}
    for week in feature.index:
        names = universe.columns[universe.loc[week].to_numpy(dtype=bool)]
        out[week] = spearman(feature.loc[week, names], target.loc[week, names])
    return pd.Series(out, dtype=float)


def run_lengths(stage: pd.Series) -> list[tuple[pd.Timestamp, pd.Timestamp, str, int]]:
    """(first week, last week, label, weeks) for each run of the same stage label."""
    labels = stage.map(lambda v: "?" if pd.isna(v) else f"S{int(v)}")
    runs = []
    start = None
    for i, (week, lab) in enumerate(labels.items()):
        if start is None:
            start, current, first = i, lab, week
        elif lab != current:
            runs.append((first, labels.index[i - 1], current, i - start))
            start, current, first = i, lab, week
    if start is not None:
        runs.append((first, labels.index[-1], current, len(labels) - start))
    return runs


def forward_returns(
    prices: pd.DataFrame, horizon: int, stale: dict[str, pd.Timestamp] | None = None
) -> pd.DataFrame:
    """P[t + h] / P[t] - 1 on the weekly frame, NaN when the column's real prices stop before
    t + h (a stale column is forward-filled flat after its last real week, which would otherwise
    read as a 0% return)."""
    fwd = prices.shift(-horizon) / prices - 1
    pos = np.arange(len(prices.index))
    for col, cutoff in (stale or {}).items():
        if col not in fwd.columns:
            continue
        last = prices.index.searchsorted(pd.Timestamp(cutoff), side="right") - 1
        j = fwd.columns.get_loc(col)
        fwd.iloc[pos + horizon > last, j] = np.nan
    return fwd


def flag_coefficient(y: pd.Series, controls: pd.DataFrame, flag: pd.Series) -> float:
    """One week's cross-section: OLS of the forward return `y` on a constant, the controls'
    percentile ranks and the 0/1 `flag`; returns the flag's coefficient (the return gap between
    flagged and unflagged names with similar controls). NaN with too few names of either kind."""
    frame = pd.concat([y.rename("_y"), controls, flag.rename("_f")], axis=1).dropna()
    on = int((frame["_f"] == 1).sum())
    if len(frame) < MIN_NAMES or on < MIN_FLAG_EACH or len(frame) - on < MIN_FLAG_EACH:
        return np.nan
    x = np.column_stack(
        [
            np.ones(len(frame)),
            frame[controls.columns].rank(pct=True).to_numpy(),
            frame["_f"].to_numpy(dtype=float),
        ]
    )
    beta, *_ = np.linalg.lstsq(x, frame["_y"].to_numpy(), rcond=None)
    return float(beta[-1])


def tercile_spread(score: pd.Series, y: pd.Series) -> float:
    """Mean `y` of the top third by `score` minus the bottom third (NaN under MIN_NAMES)."""
    both = pd.concat([score, y], axis=1).dropna()
    k = len(both) // 3
    if len(both) < MIN_NAMES or k == 0:
        return np.nan
    ordered = both.sort_values(both.columns[0])
    return float(ordered.iloc[-k:, 1].mean() - ordered.iloc[:k, 1].mean())


def position_pnl(
    weights: pd.DataFrame, equity: pd.Series, prices: pd.DataFrame, cash_col: str, idle_col: str
) -> pd.DataFrame:
    """Profit per (week, asset) in equity units, before costs. The post-trade weights of each
    engine week become units (weight x equity / price), carried unchanged through the weeks the
    engine skipped; week t's profit is units[t] x (P[t+1] - P[t]). The idle column is priced as
    `cash_col`. `prices` sets the calendar (the `weekly_marks` index)."""
    cal = prices.index
    px = prices.ffill()
    cols = [c for c in weights.columns if (cash_col if c == idle_col else c) in px.columns]
    price_cols = [cash_col if c == idle_col else c for c in cols]
    engine_px = px.reindex(weights.index)[price_cols].to_numpy()
    units = weights[cols].fillna(0.0).to_numpy() * equity.reindex(weights.index).to_numpy()[:, None]
    with np.errstate(invalid="ignore", divide="ignore"):
        units = np.where(engine_px > 0, units / engine_px, 0.0)
    units = pd.DataFrame(units, index=weights.index, columns=cols).reindex(cal).ffill()
    step = px[price_cols].shift(-1) - px[price_cols]
    step.columns = cols
    return units.fillna(0.0) * step.fillna(0.0)


# ---------------------------------------------------------------------------------------------
# Data
# ---------------------------------------------------------------------------------------------


def out_dir() -> Path:
    from momentum_backtesting.config import DATA_DIR

    path = DATA_DIR / "backtests" / "volume"
    path.mkdir(parents=True, exist_ok=True)
    return path


def load_daily_bars(symbols: list[str]) -> pd.DataFrame:
    """date, symbol, close, high, low, shares, turnover from the shared catalog, real sessions
    only, sorted by symbol then date, one row per (symbol, date)."""
    from momentum_backtesting.db_read import connect, data_root

    with connect(data_root(), read_only=True) as con:
        daily = con.execute(
            "SELECT b.date, i.symbol, b.close, b.high, b.low, b.volume AS shares, b.turnover "
            "FROM bars_1d_stock b JOIN instruments i USING (instrument_id) "
            "WHERE i.symbol IN (SELECT unnest(?)) AND NOT b.synthetic_close",
            [sorted(symbols)],
        ).fetchdf()
    daily["date"] = pd.to_datetime(daily["date"])
    daily = daily.sort_values(["symbol", "date"]).drop_duplicates(["symbol", "date"], keep="last")
    return daily.reset_index(drop=True).astype({"shares": float})


@dataclass
class Universe:
    ranking: object  # broad.UniverseRanking
    prices: pd.DataFrame  # week x stock segment column
    stocks: list[str]
    membership: pd.DataFrame  # Total Market membership + segment liveness, week x column
    pool: pd.DataFrame  # Broad's qualifying pool, week x column


def build_universe(ranking) -> Universe:
    from momentum_backtesting.categories import broad, compose
    from momentum_backtesting.config import DATA_DIR

    stocks = [c for c in ranking.prices.columns if c not in broad.ATOMIC_NAMES]
    prices = ranking.prices[stocks]
    members = broad.total_market_members_by_year(DATA_DIR / "categories")
    membership = compose.build_membership_frame(
        prices.index,
        members,
        ranking.column_to_base_symbol,
        events=ranking.events,
        stale_columns=ranking.stale_columns,
    ).reindex(index=prices.index, columns=stocks)
    membership = membership.fillna(False).astype(bool) & prices.notna()
    pool = ranking.stock_pool_ranks.reindex(index=prices.index, columns=stocks).notna()
    return Universe(ranking, prices, stocks, membership, pool)


def build_strategies(keys: tuple[str, ...]) -> tuple[dict[str, ott.Strategy], Universe]:
    out = {}
    ranking = None
    for key in keys:
        label, overrides = BROAD[key]
        print(f"building {key} ...", flush=True)
        out[key], r = ott.build_broad(key, label, ranking=ranking, **overrides)
        if ranking is None:
            ranking = r
    return out, build_universe(ranking)


def build_features(u: Universe) -> tuple[dict[str, pd.DataFrame], pd.DataFrame]:
    """All FEATURES as week x segment frames on the Broad weekly calendar, plus the daily rows
    (with their segment column and rolling features) for the V0 checks."""
    print("loading daily bars ...", flush=True)
    symbols = sorted({u.ranking.column_to_base_symbol[c] for c in u.stocks})
    daily = load_daily_bars(symbols)
    daily["col"] = segment_columns(daily, u.ranking.events)
    daily = daily.sort_values(["col", "date"]).reset_index(drop=True)
    print(f"{len(daily):,} daily rows, {daily['col'].nunique()} segments", flush=True)
    daily = daily_volume_features(daily)
    feats = {
        k: v.reindex(index=u.prices.index, columns=u.stocks)
        for k, v in weekly_volume_features(daily).items()
    }
    ok = history_ok(u.prices, u.ranking.stale_columns)
    feats.update(ma_features(u.prices, ok))
    st, wk = stages(u.prices, ok)
    feats["STAGE"] = st
    feats["WEEKS_IN_STAGE"] = wk
    feats["EARLY2"] = early2(st, wk)
    return feats, daily


def save_features(feats: dict[str, pd.DataFrame], path: Path) -> None:
    long = pd.concat({k: v.stack() for k, v in feats.items()}, axis=1)
    long.index.names = ["week", "col"]
    long.dropna(how="all").reset_index().to_parquet(path, index=False)


def load_features(path: Path, u: Universe) -> dict[str, pd.DataFrame]:
    long = pd.read_parquet(path).set_index(["week", "col"])
    return {
        k: long[k].unstack("col").reindex(index=u.prices.index, columns=u.stocks)
        for k in long.columns
    }


# ---------------------------------------------------------------------------------------------
# V0
# ---------------------------------------------------------------------------------------------


def coverage_by_year(feats: dict[str, pd.DataFrame], eligible: pd.DataFrame) -> pd.DataFrame:
    rows = {}
    for year in sorted(set(eligible.index.year)):
        sel = eligible[eligible.index.year == year]
        n = int(sel.to_numpy().sum())
        rows[year] = {"eligible stock-weeks": n}
        for name in FEATURES:
            f = feats[name].reindex_like(sel)
            rows[year][name] = float((f.notna() & sel).to_numpy().sum() / n) if n else np.nan
    return pd.DataFrame.from_dict(rows, orient="index")


def from_start(frame: pd.DataFrame) -> pd.DataFrame:
    return frame.loc[frame.index >= START]


def feature_rows(frames: dict[str, pd.DataFrame], at: pd.MultiIndex) -> pd.DataFrame:
    return pd.DataFrame(
        {k: lookup(v, at.get_level_values(0), at.get_level_values(1)) for k, v in frames.items()}
    )


def volume_agreement(daily: pd.DataFrame, u: Universe, stored_vr2: pd.DataFrame) -> dict:
    """Stored shares against turnover / close: the per-row ratio, and VR2 built both ways."""
    implied = daily["turnover"] / daily["close"]
    ratio = (daily["shares"] / implied).replace([np.inf, -np.inf], np.nan).dropna()
    alt = daily[["col", "date", "close", "high", "low", "turnover"]].assign(shares=implied)
    alt_vr2 = weekly_volume_features(daily_volume_features(alt))["VR2"]
    at = cells(from_start(u.pool))
    both = pd.DataFrame(
        {
            "stored": lookup(stored_vr2, at.get_level_values(0), at.get_level_values(1)),
            "implied": lookup(alt_vr2, at.get_level_values(0), at.get_level_values(1)),
        }
    ).dropna()
    return {
        "rows": len(ratio),
        "median shares / (turnover/close)": float(ratio.median()),
        "p5": float(ratio.quantile(0.05)),
        "p95": float(ratio.quantile(0.95)),
        "share within 10%": float(((ratio - 1).abs() <= 0.10).mean()),
        "pool weeks with VR2 both ways": len(both),
        "VR2 rank corr (stored vs implied)": spearman(both.iloc[:, 0], both.iloc[:, 1]),
        "VR2 median abs log diff": float(np.log(both.iloc[:, 0] / both.iloc[:, 1]).abs().median()),
    }


def turnover_jumps(daily: pd.DataFrame, u: Universe, top: int = 20) -> pd.DataFrame:
    """The largest single-day turnover jumps (turnover / median of the prior 20 sessions) on
    pool stock-weeks from 2017, with the week's median-based VR2 next to a mean-based version
    to show how much the median blunts a one-day spike."""
    d = daily.copy()
    g = d.groupby("col", sort=False)
    prior = _rolling(g, "turnover", 20, "median").groupby(d["col"], sort=False).shift(1)
    d["jump"] = d["turnover"] / prior.where(prior > 0)
    d["day_ret"] = d["close"] / g["close"].shift(1) - 1
    mean_prior = _rolling(g, "shares", PRIOR, "mean").groupby(d["col"], sort=False).shift(RECENT2)
    d["VR2_mean"] = _rolling(g, "shares", RECENT2, "mean") / mean_prior.where(mean_prior > 0)
    d["week"] = friday_label(d["date"])
    pool = u.pool.stack()
    pool = pool[pool]
    keyed = d.set_index(["week", "col"])
    keep = keyed.index.isin(pool.index) & (keyed["date"] >= START).to_numpy()
    cand = keyed[keep].dropna(subset=["jump"]).sort_values("jump", ascending=False).head(top)
    week_vr2 = d.drop_duplicates(["col", "week"], keep="last").set_index(["week", "col"])
    rows = []
    for (week, col), r in cand.iterrows():
        month_end = (
            r["date"]
            == d.loc[
                (d["col"] == col) & (d["date"].dt.to_period("M") == r["date"].to_period("M")),
                "date",
            ].max()
        )
        rows.append(
            {
                "date": f"{r['date']:%Y-%m-%d} {r['date']:%a}",
                "column": col,
                "turnover Cr": r["turnover"] / CRORE,
                "x prior 20d median": r["jump"],
                "day return": r["day_ret"],
                "month-end session": bool(month_end),
                "week VR2 (median)": week_vr2.at[(week, col), "VR2"],
                "week VR2 (mean)": week_vr2.at[(week, col), "VR2_mean"],
            }
        )
    return pd.DataFrame(rows)


def momentum_correlations(feats: dict[str, pd.DataFrame], u: Universe) -> pd.DataFrame:
    """Mean weekly rank correlation, across the qualifying pool from 2017, of each feature with
    momentum strength (minus the pool rank, so + = goes with stronger momentum), the 2-week
    return and the 4-week return."""
    weeks = u.prices.index[u.prices.index >= START]
    pool = u.pool.loc[weeks]
    targets = {
        "momentum strength": -u.ranking.stock_pool_ranks.reindex(index=weeks, columns=u.stocks),
        "2w return": (u.prices / u.prices.shift(2) - 1).loc[weeks],
        "4w return": (u.prices / u.prices.shift(4) - 1).loc[weeks],
    }
    rows = {}
    for name in FEATURES:
        f = feats[name].loc[weeks]
        rows[name] = {t: float(weekly_ic(f, v, pool).mean()) for t, v in targets.items()}
    return pd.DataFrame.from_dict(rows, orient="index")


def shares_text(table: pd.DataFrame) -> str:
    """A share_table, transposed, with the count as an integer and the rest as percentages."""
    shown = table.T.astype(object)
    for col in shown.columns:
        shown[col] = [f"{int(v):,}" if idx == "n" else f"{v:.1%}" for idx, v in shown[col].items()]
    return shown.to_string()


def stage_label(v: float) -> str:
    return "unknown" if pd.isna(v) else f"Stage {int(v)}"


def share_table(values: dict[str, pd.Series]) -> pd.DataFrame:
    """Rows = what was counted, columns = share in each stage / below the 10-week average."""
    rows = {}
    for name, frame in values.items():
        n = len(frame)
        row = {"n": n}
        row["below 10w avg"] = float((frame["ABOVE10"] == 0).mean()) if n else np.nan
        row["10w avg unknown"] = float(frame["ABOVE10"].isna().mean()) if n else np.nan
        for band in STAGE_BANDS_INFO:
            col = f"STAGE@{band:g}"
            counts = frame[col].map(stage_label).value_counts(normalize=True)
            for lab in ("Stage 1", "Stage 2", "Stage 3", "Stage 4", "unknown"):
                row[f"{lab} ({band:.1%})"] = float(counts.get(lab, 0.0))
        row["early Stage 2"] = float((frame["EARLY2"] == 1).mean()) if n else np.nan
        rows[name] = row
    return pd.DataFrame.from_dict(rows, orient="index")


def share_inputs(feats, stage_by_band) -> dict[str, pd.DataFrame]:
    return {
        "ABOVE10": feats["ABOVE10"],
        "EARLY2": feats["EARLY2"],
        **{f"STAGE@{b:g}": stage_by_band[b] for b in STAGE_BANDS_INFO},
    }


def redundancy(strategies, feats, stage_by_band) -> pd.DataFrame:
    """Fresh BUY rows and every weekly top-N name in C3 and C4, by ABOVE10 and stage."""
    frames = share_inputs(feats, stage_by_band)
    values = {}
    for key in ("C3", "C4"):
        s = strategies[key]
        trades = s.result.trades
        buys = trades[(trades["action"] == "BUY") & trades["asset"].isin(s.positions)]
        ranks = s.result.ranks.reindex(columns=s.positions)
        top = cells(ranks.loc[ranks.index.isin(s.result.equity.index)] <= s.result.config.top_n)
        buy_at = pd.MultiIndex.from_arrays([pd.DatetimeIndex(buys["week"]), buys["asset"]])
        values[f"{key} fresh buys"] = feature_rows(frames, buy_at)
        values[f"{key} weekly top {s.result.config.top_n} (engine weeks)"] = feature_rows(
            frames, top
        )
    return share_table(values)


def segment_for(u: Universe, symbol: str, week: str) -> str | None:
    week = pd.Timestamp(week)
    cols = [c for c in u.stocks if u.ranking.column_to_base_symbol[c] == symbol]
    for c in cols:
        px = u.prices[c]
        real = px.index[px.notna()]
        cutoff = u.ranking.stale_columns.get(c, real.max() if len(real) else None)
        if len(real) and real.min() <= week <= cutoff:
            return c
    return None


def stage_timelines(u: Universe, feats: dict[str, pd.DataFrame]) -> tuple[pd.DataFrame, list]:
    ma30 = u.prices.rolling(MA_STAGE, min_periods=MA_STAGE).mean()
    slope = ma30 / ma30.shift(SLOPE_LAG) - 1
    raw = raw_trend(u.prices, history_ok(u.prices, u.ranking.stale_columns))
    rows, runs = [], []
    for symbol, week in SANITY.items():
        col = segment_for(u, symbol, week)
        if col is None:
            runs.append((symbol, week, None, []))
            continue
        w = pd.Timestamp(week)
        span = u.prices.index[
            (u.prices.index >= w - pd.Timedelta(weeks=52))
            & (u.prices.index <= w + pd.Timedelta(weeks=52))
        ]
        for t in span:
            rows.append(
                {
                    "symbol": symbol,
                    "column": col,
                    "week": t,
                    "close": u.prices.at[t, col],
                    "MA30": ma30.at[t, col],
                    "slope4w": slope.at[t, col],
                    "raw": raw.at[t, col],
                    "stage": feats["STAGE"].at[t, col],
                    "weeks_in_stage": feats["WEEKS_IN_STAGE"].at[t, col],
                    "EARLY2": feats["EARLY2"].at[t, col],
                    "ABOVE10": feats["ABOVE10"].at[t, col],
                    "spike_week": t == w,
                }
            )
        runs.append((symbol, week, col, run_lengths(feats["STAGE"].loc[span, col])))
    return pd.DataFrame(rows), runs


def stage_v0() -> None:
    folder = out_dir()
    strategies, u = build_strategies(("C3", "C4"))
    for s in strategies.values():
        ott.describe([s])
    feats, daily = build_features(u)
    save_features(feats, folder / "features.parquet")
    ok = history_ok(u.prices, u.ranking.stale_columns)
    stage_by_band = {b: stages(u.prices, ok, b)[0] for b in STAGE_BANDS_INFO if b != STAGE_BAND}
    stage_by_band[STAGE_BAND] = feats["STAGE"]

    eligible = from_start(u.membership)
    print("V0 checks ...", flush=True)
    cov = coverage_by_year(feats, eligible)
    agree = volume_agreement(daily, u, feats["VR2"])
    jumps = turnover_jumps(daily, u)
    corr = momentum_correlations(feats, u)
    red = redundancy(strategies, feats, stage_by_band)
    frames = share_inputs(feats, stage_by_band)
    universe_shares = share_table(
        {
            "all eligible stock-weeks": feature_rows(frames, cells(eligible)),
            "qualifying pool stock-weeks": feature_rows(
                frames, cells(from_start(u.pool & u.membership))
            ),
        }
    )
    timeline, runs = stage_timelines(u, feats)
    spells = stage2_spells(feats["STAGE"], feats["WEEKS_IN_STAGE"])
    spells["start_year"] = pd.DatetimeIndex(spells["first_week"]).year
    spells["segment_restart"] = spells["column"].str.contains("#")
    pool_cols = set(u.pool.columns[u.pool.any()])
    spells["ever_in_pool"] = spells["column"].isin(pool_cols)
    censor = spells.groupby("censored").agg(
        spells=("column", "size"),
        segment_restarts=("segment_restart", "sum"),
        starting_2020=("start_year", lambda y: int((y == 2020).sum())),
        ever_in_pool=("ever_in_pool", "sum"),
    )

    cov.to_csv(folder / "v0_coverage_by_year.csv", index_label="year")
    pd.Series(agree).to_csv(folder / "v0_volume_agreement.csv", header=["value"])
    jumps.to_csv(folder / "v0_turnover_jumps.csv", index=False)
    corr.to_csv(folder / "v0_momentum_correlations.csv", index_label="feature")
    red.to_csv(folder / "v0_redundancy.csv", index_label="rows")
    universe_shares.to_csv(folder / "v0_stage_shares.csv", index_label="rows")
    timeline.to_csv(folder / "v0_stage_timelines.csv", index=False)
    spells.to_csv(folder / "v0_stage2_spells.csv", index=False)

    pct = "{:.1%}".format
    with pd.option_context("display.width", 250, "display.max_columns", 40):
        print("\n=== V0 coverage: share of eligible stock-weeks with each feature ===")
        print(cov.to_string(formatters={k: pct for k in FEATURES}))
        print("\n=== V0 stored volume vs turnover / close ===")
        for k, v in agree.items():
            print(f"  {k}: {v:.4f}" if isinstance(v, float) else f"  {k}: {v:,}")
        print("\n=== V0 20 largest single-day turnover jumps (pool stock-weeks, 2017+) ===")
        print(
            jumps.to_string(
                index=False,
                formatters={
                    "turnover Cr": "{:.1f}".format,
                    "x prior 20d median": "{:.1f}".format,
                    "day return": "{:+.1%}".format,
                    "week VR2 (median)": "{:.2f}".format,
                    "week VR2 (mean)": "{:.2f}".format,
                },
            )
        )
        print("\n=== V0 mean weekly rank correlation in the pool (|r| > 0.7 = re-measures it) ===")
        print(corr.to_string(float_format="{:+.2f}".format))
        print("\n=== V0 redundancy count (1% stage band; 0.5% and 2% for information) ===")
        print(shares_text(red))
        print("\n=== V0 stage shares across the universe ===")
        print(shares_text(universe_shares))
    n_c = int(spells["censored"].sum())
    print(
        f"\n=== V0 Stage 2 spells: {len(spells):,}, of which {n_c:,} left-censored "
        f"({n_c / len(spells):.1%}; EARLY2 unknown) ==="
    )
    print(censor.to_string())
    print("\n=== V0 stage timelines (52 weeks either side of the big run) ===")
    for symbol, week, col, rl in runs:
        if col is None:
            print(f"{symbol}: no segment covers {week}")
            continue
        print(f"\n{symbol} ({col}), big run week {week}:")
        for first, last, lab, n in rl:
            mark = " <- big run" if first <= pd.Timestamp(week) <= last else ""
            print(f"  {first:%Y-%m-%d} .. {last:%Y-%m-%d}  {lab:>2}  {n:>3}w{mark}")
    print(f"\nwritten to {folder}")


# ---------------------------------------------------------------------------------------------
# V1
# ---------------------------------------------------------------------------------------------


def v1_subgroups(ev: pd.DataFrame, cuts: tuple[float, float]) -> dict[str, pd.Series]:
    lo, hi = cuts
    vr, clv = ev["VR2"], ev["CLV2"]
    known = vr.notna() & clv.notna()
    climax = (vr > hi) & (clv < 0.5)
    return {
        "all events": pd.Series(True, index=ev.index),
        "VR2 low third": vr <= lo,
        "VR2 middle third": (vr > lo) & (vr <= hi),
        "VR2 top third": vr > hi,
        "CLV2 < 0.5 (weak close)": clv < 0.5,
        "CLV2 >= 0.5 (strong close)": clv >= 0.5,
        "climax (VR2 top third & CLV2 < 0.5)": climax & known,
        "not climax": ~climax & known,
    }


def v1_cell(ev: pd.DataFrame, horizon: int, calendar: pd.DatetimeIndex) -> dict:
    col = f"exc_{horizon}w_B"
    mean, lo, hi, nweeks = ott.weekly_mean_ci(ev["week"], ev[col], calendar)
    row = {"events": int(ev[col].notna().sum()), "event_weeks": nweeks, "mean": mean}
    row["rise mean"] = float(ev["r"].mean()) if len(ev) else np.nan
    row["rise median"] = float(ev["r"].median()) if len(ev) else np.nan
    row.update({"lo": lo, "hi": hi})
    x = ev[col].dropna().sort_values()
    row["drop best 5"] = float(x.iloc[:-5].mean()) if len(x) > 5 else np.nan
    row["drop worst 5"] = float(x.iloc[5:].mean()) if len(x) > 5 else np.nan
    for half, sel, cal in (
        ("2017-2021", ev["week"] <= FIRST_HALF_END, calendar[calendar <= FIRST_HALF_END]),
        ("2022+", ev["week"] > FIRST_HALF_END, calendar[calendar > FIRST_HALF_END]),
    ):
        m, _, _, n = ott.weekly_mean_ci(ev.loc[sel, "week"], ev.loc[sel, col], cal)
        row[f"{half} mean"] = m
        row[f"{half} weeks"] = n
    return row


def v1_pass(table: pd.DataFrame) -> pd.DataFrame:
    """Spec pass rule per (trigger, subgroup, horizon): positive excess, interval excluding zero,
    at least 10 event weeks and the same (positive) sign in both halves, in C3 and in at least one
    of C4 or C5."""

    def ok(r) -> bool:
        return bool(
            r["mean"] > 0
            and r["lo"] > 0
            and r["event_weeks"] >= MIN_EVENT_WEEKS
            and r["2017-2021 mean"] > 0
            and r["2022+ mean"] > 0
        )

    t = table.assign(cell_ok=table.apply(ok, axis=1))
    rows = []
    for (trigger, group, h), sub in t.groupby(["trigger", "subgroup", "horizon"], sort=False):
        by = sub.set_index("strategy")["cell_ok"]
        c3 = bool(by.get("C3", False))
        other = bool(by.get("C4", False)) or bool(by.get("C5", False))
        rows.append(
            {
                "trigger": trigger,
                "subgroup": group,
                "horizon": h,
                "C3 ok": c3,
                "C4 or C5 ok": other,
                "passes": c3 and other,
            }
        )
    return pd.DataFrame(rows)


def stage_v1() -> None:
    folder = out_dir()
    strategies, u = build_strategies(("C3", "C4", "C5"))
    path = folder / "features.parquet"
    if not path.exists():
        raise SystemExit(f"{path} is missing: run the v0 stage first")
    feats = load_features(path, u)
    rows, all_events = [], []
    for key, s in strategies.items():
        ott.describe([s])
        f = ott.build_frames(s)
        ev = ott.event_table(s, f, 2)
        ev = ev[ev["tradable"]].copy()
        ev["VR2"] = lookup(feats["VR2"], ev["week"].to_numpy(), ev["asset"].to_numpy())
        ev["CLV2"] = lookup(feats["CLV2"], ev["week"].to_numpy(), ev["asset"].to_numpy())
        distinct = ev.drop_duplicates(["week", "asset"])
        cuts = tuple(distinct["VR2"].quantile([1 / 3, 2 / 3]))
        print(
            f"{key}: {len(distinct)} distinct tradable events, {distinct['VR2'].isna().sum()} "
            f"without VR2, {distinct['CLV2'].isna().sum()} without CLV2; VR2 tercile cuts "
            f"{cuts[0]:.2f} / {cuts[1]:.2f}; CLV2 < 0.5 in {(distinct['CLV2'] < 0.5).mean():.0%}"
        )
        ev["vr2_cut_low"], ev["vr2_cut_high"] = cuts
        all_events.append(ev)
        for trigger, sub in ev.groupby("trigger", sort=False):
            for group, mask in v1_subgroups(sub, cuts).items():
                for h in (4, 8):
                    row = {"strategy": key, "trigger": trigger, "subgroup": group, "horizon": h}
                    row.update(v1_cell(sub[mask.fillna(False)], h, f.calendar))
                    rows.append(row)
    table = pd.DataFrame(rows)
    verdict = v1_pass(table)
    pd.concat(all_events, ignore_index=True).to_csv(folder / "v1_events.csv", index=False)
    table.to_csv(folder / "v1_spike_split.csv", index=False)
    verdict.to_csv(folder / "v1_pass.csv", index=False)

    def fmt(r) -> str:
        if not r["events"]:
            return "—"
        ci = "" if pd.isna(r["lo"]) else f" [{r['lo']:+.1%}, {r['hi']:+.1%}]"
        star = "*" if (r["lo"] > 0 or r["hi"] < 0) else ""
        return f"{r['mean']:+.1%}{ci}{star} ({r['event_weeks']}w)"

    for key in strategies:
        print(f"\n=== V1 {key}: trim excess vs alternative B (other holdings) ===")
        sub = table[table["strategy"] == key]
        for trigger, t in sub.groupby("trigger", sort=False):
            print(f"\n-- {trigger} --")
            print(
                f"{'subgroup':38} {'events':>6} {'2w rise mean/med':>16}  {'4w':>32}  "
                f"{'8w':>32}  {'8w halves':>17}  {'8w drop best/worst 5':>21}"
            )
            for group, g in t.groupby("subgroup", sort=False):
                r4 = g[g["horizon"] == 4].iloc[0]
                r8 = g[g["horizon"] == 8].iloc[0]
                halves = f"{r8['2017-2021 mean']:+.1%} / {r8['2022+ mean']:+.1%}"
                tail = f"{r8['drop best 5']:+.1%} / {r8['drop worst 5']:+.1%}"
                rise = f"{r4['rise mean']:+.0%} / {r4['rise median']:+.0%}" if r4["events"] else "—"
                print(
                    f"{group:38} {r4['events']:>6} {rise:>16}  {fmt(r4):>32}  {fmt(r8):>32}  "
                    f"{halves:>17}  {tail:>21}"
                )
    print("\n* = 95% interval excludes zero. Positive = trimming would have helped.")
    passing = verdict[verdict["passes"]]
    print(f"\n=== V1 pass rule: {len(passing)} of {len(verdict)} cells pass ===")
    if len(passing):
        print(passing.to_string(index=False))
    print(f"\nwritten to {folder}")


# ---------------------------------------------------------------------------------------------
# V2
# ---------------------------------------------------------------------------------------------


def v2_feature_frames(u: Universe, feats: dict[str, pd.DataFrame]) -> dict[tuple, pd.DataFrame]:
    """(feature, band) -> week x column frame. Stage features carry their slope band; the rest
    use None. STAGE3 is 1 for Stage 3, 0 for Stage 2, NaN otherwise (Stage 3 vs Stage 2). EARLY2
    is only defined inside Stage 2 (early vs late Stage 2), NaN for a censored spell."""
    out = {(k, None): feats[k] for k in ("VR2", "VR4", "ACC13", "DIST10", "RISE2", "ABOVE10")}
    ok = history_ok(u.prices, u.ranking.stale_columns)
    for band in H7_BANDS:
        if band == STAGE_BAND:
            st, wk = feats["STAGE"], feats["WEEKS_IN_STAGE"]
        else:
            st, wk = stages(u.prices, ok, band)
        out[("STAGE3", band)] = (st == 3).astype(float).where(st.isin([2, 3]))
        out[("EARLY2", band)] = early2(st, wk).where(st == 2)
    return out


def v2_weekly(
    feature: pd.DataFrame,
    universe: pd.DataFrame,
    controls: dict[str, pd.DataFrame],
    fwd: dict[int, pd.DataFrame],
    kind: str,
) -> pd.DataFrame:
    """Per week: residual IC and tercile spread per horizon (kind "continuous"), or the flag's
    regression coefficient per horizon (kind "flag"), plus the number of names used."""
    rows = {}
    weeks = universe.index
    for week in weeks:
        names = universe.columns[universe.loc[week].to_numpy(dtype=bool)]
        if len(names) < MIN_NAMES:
            continue
        x = feature.loc[week, names]
        ctrl = pd.DataFrame({k: v.loc[week, names] for k, v in controls.items()})
        row = {}
        if kind == "continuous":
            resid = rank_residual(x, ctrl).dropna()
            row["n"] = len(resid)
            if len(resid) < MIN_NAMES:
                continue
            for h, f in fwd.items():
                y = f.loc[week, resid.index]
                row[f"ic_{h}"] = spearman(resid, y)
                row[f"spread_{h}"] = tercile_spread(resid, y)
        else:
            row["n"] = int(pd.concat([x, ctrl], axis=1).dropna().shape[0])
            for h, f in fwd.items():
                row[f"coef_{h}"] = flag_coefficient(f.loc[week, names], ctrl, x)
        rows[week] = row
    return pd.DataFrame.from_dict(rows, orient="index")


def bootstrap_ci(series: pd.Series, mask: np.ndarray, block: int) -> tuple[float, float]:
    values = series.fillna(0.0).to_numpy()
    m = mask & series.notna().to_numpy()
    if m.sum() < ott.MIN_CI_WEEKS:
        return np.nan, np.nan
    boot = brt.block_bootstrap_means(values, {"m": m}, block=block)["m"]
    lo, hi = np.nanpercentile(boot, [2.5, 97.5])
    return float(lo), float(hi)


def v2_summary(weekly: pd.DataFrame, calendar: pd.DatetimeIndex) -> list[dict]:
    """Mean, 4-week block CI (the spec's), an h-week block CI (robustness for overlapping
    horizons), share of positive weeks, halves, and the same with 2020 excluded."""
    w = weekly.reindex(calendar)
    years = calendar.year
    first = calendar <= FIRST_HALF_END
    rows = []
    stat = "ic" if any(c.startswith("ic_") for c in w.columns) else "coef"
    for h in V2_HORIZONS:
        col = f"{stat}_{h}"
        if col not in w.columns:
            continue
        x = w[col]
        for variant, mask in (("all years", np.ones(len(x), bool)), ("ex 2020", years != 2020)):
            sel = x[mask]
            lo, hi = bootstrap_ci(x, mask, brt.BOOTSTRAP_BLOCK)
            lo_h, hi_h = bootstrap_ci(x, mask, max(brt.BOOTSTRAP_BLOCK, h))
            row = {
                "variant": variant,
                "horizon": h,
                "stat": stat,
                "weeks": int(sel.notna().sum()),
                "mean": float(sel.mean()),
                "lo": lo,
                "hi": hi,
                "lo_hblock": lo_h,
                "hi_hblock": hi_h,
                "pos_share": float((sel.dropna() > 0).mean()) if sel.notna().any() else np.nan,
                "2017-2021": float(x[mask & first].mean()),
                "2022+": float(x[mask & ~first].mean()),
                "names_per_week": float(w["n"][mask].mean()),
            }
            if stat == "ic":
                sp = w[f"spread_{h}"]
                row["spread"] = float(sp[mask].mean())
                row["spread_lo"], row["spread_hi"] = bootstrap_ci(sp, mask, brt.BOOTSTRAP_BLOCK)
            rows.append(row)
    return rows


def v2_pass(table: pd.DataFrame) -> pd.DataFrame:
    """Spec rule per (universe, feature, band): the all-years interval excludes zero at 4 and 13
    weeks with one sign, both halves share it, the spread (continuous features) points the same
    way, and the 2020-excluded mean keeps the sign. H7 also needs the 2% band to agree in sign.
    DIST10 is a cross-check and never passes."""
    rows = []
    for (uni, feat), sub in table.groupby(["universe", "feature"], sort=False):
        keep = (sub["band"] == STAGE_BAND) if feat in H7_FEATURES else sub["band"].isna()
        primary = sub[keep]
        allyrs = primary[primary["variant"] == "all years"].set_index("horizon")
        ex = primary[primary["variant"] == "ex 2020"].set_index("horizon")
        signs = []
        ok = True
        for h in PASS_HORIZONS:
            r = allyrs.loc[h]
            sign = 1 if r["lo"] > 0 else -1 if r["hi"] < 0 else 0
            signs.append(sign)
            ok &= sign != 0
            ok &= np.sign(r["2017-2021"]) == sign and np.sign(r["2022+"]) == sign
            if "spread" in r and not pd.isna(r.get("spread", np.nan)):
                ok &= np.sign(r["spread"]) == sign
            ok &= np.sign(ex.loc[h, "mean"]) == sign
        ok &= len(set(signs)) == 1
        robust = None
        if feat in H7_FEATURES:
            alt = sub[(sub["band"] == 0.02) & (sub["variant"] == "all years")].set_index("horizon")
            robust = all(np.sign(alt.loc[h, "mean"]) == signs[0] for h in PASS_HORIZONS)
            ok &= robust
        rows.append(
            {
                "universe": uni,
                "feature": feat,
                "direction": "+" if signs[0] > 0 else "-" if signs[0] < 0 else "none",
                "2% band agrees": robust,
                "cross-check only": feat in CROSS_CHECK,
                "passes": bool(ok) and feat not in CROSS_CHECK,
            }
        )
    return pd.DataFrame(rows)


def stage_v2() -> None:
    from momentum_backtesting.engine import IDLE

    folder = out_dir()
    strategies, u = build_strategies(("C4",))
    feats = load_features(folder / "features.parquet", u)
    frames = v2_feature_frames(u, feats)
    weeks = u.prices.index[u.prices.index >= START]
    pool = (u.pool & u.membership).loc[weeks]
    c4 = strategies["C4"]
    held = ott.held_matrix(c4.result.weights, c4.marked.index, IDLE)
    held = held.reindex(index=weeks, columns=u.stocks).fillna(False).astype(bool) & pool
    universes = {"pool": pool, "C4 held": held}
    controls = {
        "momentum": -u.ranking.stock_pool_ranks.reindex(index=weeks, columns=u.stocks),
        "r2": (u.prices / u.prices.shift(2) - 1).loc[weeks],
    }
    fwd = {h: forward_returns(u.prices, h, u.ranking.stale_columns).loc[weeks] for h in V2_HORIZONS}
    rows = []
    for uni, mask in universes.items():
        for (feat, band), frame in frames.items():
            print(f"V2 {uni}: {feat}{'' if band is None else f' @{band:.0%}'} ...", flush=True)
            kind = "continuous" if feat in CONTINUOUS else "flag"
            f = frame.loc[weeks]
            weekly = v2_weekly(f, mask & f.notna(), controls, fwd, kind)
            for r in v2_summary(weekly, weeks):
                rows.append({"universe": uni, "feature": feat, "band": band, **r})
    table = pd.DataFrame(rows)
    verdict = v2_pass(table)
    table.to_csv(folder / "v2_predictive.csv", index=False)
    verdict.to_csv(folder / "v2_pass.csv", index=False)
    print_v2(table, verdict)
    print(f"\nwritten to {folder}")


def print_v2(table: pd.DataFrame, verdict: pd.DataFrame) -> None:
    def cell(r) -> str:
        star = "*" if (r["lo"] > 0 or r["hi"] < 0) else " "
        hstar = "h" if (r["lo_hblock"] > 0 or r["hi_hblock"] < 0) else " "
        scale = 100 if r["stat"] == "coef" else 1
        fmt = "{:+.2f}" if r["stat"] == "coef" else "{:+.3f}"
        return (
            f"{fmt.format(scale * r['mean'])} [{fmt.format(scale * r['lo'])},"
            f"{fmt.format(scale * r['hi'])}]{star}{hstar}"
        )

    for uni, sub in table.groupby("universe", sort=False):
        print(f"\n=== V2 {uni}: residual IC (continuous) / flag coefficient in % (flags) ===")
        for variant in ("all years", "ex 2020"):
            print(f"\n-- {variant} --")
            print(
                f"{'feature':16} {'names':>5}  "
                + "  ".join(f"{f'{h}w':>27}" for h in V2_HORIZONS)
                + f"  {'13w halves':>15}  {'4w / 13w spread':>17}"
            )
            v = sub[sub["variant"] == variant]
            for (feat, band), g in v.groupby(["feature", "band"], sort=False, dropna=False):
                g = g.set_index("horizon")
                label = feat if pd.isna(band) else f"{feat} @{band:.0%}"
                if feat in CROSS_CHECK:
                    label += " (x)"
                halves = g.loc[13]
                scale = 100 if halves["stat"] == "coef" else 1
                hv = f"{scale * halves['2017-2021']:+.2f}/{scale * halves['2022+']:+.2f}"
                spread = (
                    f"{100 * g.loc[4, 'spread']:+.2f}%/{100 * g.loc[13, 'spread']:+.2f}%"
                    if "spread" in g.columns and not pd.isna(g.loc[4].get("spread", np.nan))
                    else ""
                )
                print(
                    f"{label:16} {g['names_per_week'].iloc[0]:5.0f}  "
                    + "  ".join(f"{cell(g.loc[h]):>27}" for h in V2_HORIZONS)
                    + f"  {hv:>15}  {spread:>17}"
                )
    print(
        "\n* = 4-week block 95% interval excludes zero (the spec's); h = also with blocks as long"
        " as the horizon. (x) = cross-check, never a pass. Flags in % return per horizon."
    )
    print("\n=== V2 pass rule ===")
    print(verdict.to_string(index=False))


# ---------------------------------------------------------------------------------------------
# V3
# ---------------------------------------------------------------------------------------------


def run_metrics(s: ott.Strategy) -> dict:
    m = s.marked
    stats = brt.metrics_from_returns(
        m["equity"].pct_change().iloc[1:], m["cash"].pct_change().iloc[1:]
    )
    years = (m.index[-1] - m.index[0]).days / 365.25
    trades = s.result.trades
    stock_rows = trades[trades["asset"].isin(s.positions)]
    return {
        "CAGR": stats["CAGR"],
        "Sharpe": stats["Sharpe"],
        "max_dd": stats["max_dd"],
        "fresh buys/yr": float((stock_rows["action"] == "BUY").sum() / years),
        "trade rows/yr": float(len(stock_rows) / years),
    }


def profit_by_entry_liquidity(s: ott.Strategy, liq: pd.DataFrame) -> pd.DataFrame:
    """Each stock holding spell's profit (equity units, before costs) with LIQ13 at its entry
    week, plus the whole portfolio's profit for the denominator."""
    from momentum_backtesting.engine import CASH, IDLE

    pnl = position_pnl(
        s.result.weights, s.result.equity, s.prices.reindex(s.marked.index), CASH, IDLE
    )
    stocks = [c for c in s.positions if c in pnl.columns]
    held = ott.held_matrix(s.result.weights, s.marked.index, IDLE).reindex(columns=stocks)
    held = held.fillna(False).astype(bool)
    spells = ott.spell_ids(held)
    rows = []
    for col in stocks:
        sp = spells[col]
        for sid in np.unique(sp[sp > 0]):
            weeks = sp.index[sp == sid]
            rows.append(
                {
                    "asset": col,
                    "entry_week": weeks[0],
                    "weeks": len(weeks),
                    "pnl": float(pnl.loc[weeks, col].sum()),
                    "LIQ13_entry": lookup(liq, [weeks[0]], [col])[0],
                }
            )
    out = pd.DataFrame(rows)
    out.attrs["total_pnl"] = float(pnl.sum().sum())
    out.attrs["equity_gain"] = float(s.marked["equity"].iloc[-1] / s.marked["equity"].iloc[0] - 1)
    return out


def stage_v3() -> None:
    folder = out_dir()
    strategies, u = build_strategies(("C3", "C4"))
    feats = load_features(folder / "features.parquet", u)
    liq = feats["LIQ13"]
    rows, attribution = [], []
    for key in ("C3", "C4"):
        base = strategies[key]
        label, overrides = BROAD[key]
        spells = profit_by_entry_liquidity(base, liq)
        total = spells.attrs["total_pnl"]
        print(
            f"{key}: attributed profit {total:.3f} vs equity gain {spells.attrs['equity_gain']:.3f}"
            " (difference = costs)",
            flush=True,
        )
        spells.insert(0, "strategy", key)
        attribution.append(spells)
        rows.append({"strategy": key, "floor_cr": 0, **run_metrics(base)})
        for floor in LIQ_FLOORS_CR:
            below = (liq < floor * CRORE).fillna(False)
            print(f"running {key} with a {floor} Cr floor ...", flush=True)
            s, _ = ott.build_broad(key, label, ranking=u.ranking, extra_no_buy=below, **overrides)
            row = {"strategy": key, "floor_cr": floor, **run_metrics(s)}
            known = spells["LIQ13_entry"].notna()
            under = spells["LIQ13_entry"] < floor * CRORE
            row["unfloored: share of profit from spells entered below"] = float(
                spells.loc[under, "pnl"].sum() / total
            )
            row["unfloored: share of stock spells entered below"] = float(under.mean())
            row["unfloored: spells with LIQ13 unknown at entry"] = int((~known).sum())
            rows.append(row)
    table = pd.DataFrame(rows)
    table.to_csv(folder / "v3_liquidity_floor.csv", index=False)
    pd.concat(attribution, ignore_index=True).to_csv(folder / "v3_spell_profit.csv", index=False)
    with pd.option_context("display.width", 250, "display.max_columns", 20):
        print("\n=== V3 liquidity floor (no_buy below median 65-session turnover; never sells) ===")
        print(
            table.to_string(
                index=False,
                formatters={
                    "CAGR": "{:.1%}".format,
                    "Sharpe": "{:.2f}".format,
                    "max_dd": "{:.1%}".format,
                    "fresh buys/yr": "{:.1f}".format,
                    "trade rows/yr": "{:.1f}".format,
                    "unfloored: share of profit from spells entered below": "{:.1%}".format,
                    "unfloored: share of stock spells entered below": "{:.1%}".format,
                },
            )
        )
    print(f"\nwritten to {folder}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("stage", choices=["v0", "v1", "v2", "v3"])
    args = parser.parse_args()
    {"v0": stage_v0, "v1": stage_v1, "v2": stage_v2, "v3": stage_v3}[args.stage]()


if __name__ == "__main__":
    main()
