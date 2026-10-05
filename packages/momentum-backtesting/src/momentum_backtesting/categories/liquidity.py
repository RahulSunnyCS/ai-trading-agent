"""Point-in-time liquidity + circuit gate for the Broad Momentum pool.

Why: the Total Market pool is ~750 names, some of which are too thin to buy or sell at a few
tens of thousands of rupees, or sit pinned at a circuit limit for days. Backtests that ignore
this overstate returns from names nobody could actually trade (the plain top-N-stocks mode
lost about half its CAGR once gated -- see TODO.md 3.9.24).

Each week-ending Friday a stock is *eligible* only if, using sessions up to and including that
Friday (never later):

  * every one of its last 60 sessions is a real trading day in series EQ (no BE/BZ
    trade-to-trade or surveillance segment, no zero-volume days) -- at least 55 sessions of data;
  * median daily turnover over those 60 sessions >= `min_turnover_cr` (Rs crore);
  * its 10th-percentile day >= `min_turnover_cr * floor_ratio` -- a quiet day must still absorb
    an exit;
  * last close >= `min_price` (tick-size / spread sanity);
  * (optional) at most `max_circuit_days` band-edge sessions (either direction, any of the four
    bands) among its last 60 -- catches stocks that keep hitting circuits without ever doing so
    several days in a row. None = no cap. Note 2%-band moves also happen on ordinary volatile
    stocks, so a sensible cap starts around 8;
  * (optional circuit gate) no run of `circuit_run`+ consecutive sessions, inside the last 125,
    closing at a band edge (1.9-2%, 4.9-5%, 9.9-10%, 19.9-20%) in the SAME direction -- i.e. not
    pinned at a limit. Bhavcopy carries no band data, so this is inferred from the close move.

The features that do not depend on the knobs are computed once per catalog version and cached;
applying thresholds is a cheap vectorised comparison, so the UI preview is instant.
"""

from __future__ import annotations

import threading
from dataclasses import dataclass
from pathlib import Path

import pandas as pd
from trading_data.db import connect, data_root

TURNOVER_WINDOW = 60
CIRCUIT_WINDOW = 125
MIN_SESSIONS = 55
#: Close-to-close |move| bands that mean "pinned at a price band" (2/5/10/20% circuits).
_BANDS = ((0.019, 0.0205), (0.049, 0.0505), (0.099, 0.1005), (0.199, 0.2005))


@dataclass(frozen=True)
class LiquidityConfig:
    """Hashable (it is part of the cached-ranking key)."""

    min_turnover_cr: float = 1.0
    floor_ratio: float = 0.25
    min_price: float = 20.0
    circuit: bool = True
    circuit_run: int = 3
    max_circuit_days: int | None = None

    def validate(self) -> None:
        if not 0 < self.min_turnover_cr <= 10_000:
            raise ValueError("Minimum turnover must be between 0 and 10,000 crore.")
        if not 0 <= self.floor_ratio <= 1:
            raise ValueError("Worst-day floor must be between 0 and 1 of the median.")
        if self.min_price < 0:
            raise ValueError("Minimum price can't be negative.")
        if not 2 <= self.circuit_run <= 20:
            raise ValueError("Circuit run must be between 2 and 20 sessions.")
        if self.max_circuit_days is not None and not 0 <= self.max_circuit_days <= TURNOVER_WINDOW:
            raise ValueError("Circuit days allowed must be between 0 and 60.")


_lock = threading.Lock()
_cache: dict[tuple[float | None, tuple[str, ...]], pd.DataFrame] = {}


def market_members_by_year(root: Path | None = None) -> dict[int, set[str]]:
    """year -> every real-equity symbol that traded in series EQ that year (the whole NSE
    market, delisted names included). ISIN 'INE...' keeps companies and drops ETFs / mutual-fund
    units ('INF...', e.g. GOLDBEES) that also trade in the EQ series. This is only the "was it
    listed" part of point-in-time membership; the tradability gate does the rest."""
    with connect(root or data_root(), read_only=True) as con:
        rows = con.execute(
            "SELECT DISTINCT year(b.date) AS y, i.symbol FROM bars_1d_stock b "
            "JOIN instruments i USING (instrument_id) "
            "WHERE b.series = 'EQ' AND b.isin LIKE 'INE%'"
        ).fetchall()
    out: dict[int, set[str]] = {}
    for year, symbol in rows:
        out.setdefault(int(year), set()).add(symbol)
    return out


#: How many of the most-traded stocks stand in for the Total Market index each year.
TURNOVER_RANK_TOP = 750


def turnover_rank_members_by_year(
    top: int = TURNOVER_RANK_TOP, root: Path | None = None
) -> dict[int, set[str]]:
    """year -> the `top` real-equity symbols by median daily turnover over the last six months
    of the year before. A stand-in for the index's membership as it was at the time (BL-010
    F1): the stored Total Market list is today's 755 names applied to every year, so every one
    of them is a survivor. This uses only what was known on 1 January of each year and keeps
    stocks that later fell out or were delisted.

    It is a proxy, not the index: NSE ranks by free-float market value, which is not in the
    data. A stock needs 60 sessions in the window, so a recent listing waits a year."""
    with connect(root or data_root(), read_only=True) as con:
        rows = con.execute(
            """
            WITH window_stats AS (
                SELECT year(b.date) + 1 AS for_year, i.symbol,
                       median(b.turnover) AS typical, count(*) AS sessions
                FROM bars_1d_stock b JOIN instruments i USING (instrument_id)
                WHERE b.isin LIKE 'INE%' AND month(b.date) >= 7
                  AND NOT coalesce(b.synthetic_close, false)
                GROUP BY 1, 2
            )
            SELECT for_year, symbol FROM (
                SELECT *, row_number() OVER (
                    PARTITION BY for_year ORDER BY typical DESC, symbol) AS place
                FROM window_stats WHERE sessions >= 60
            ) WHERE place <= ?
            """,
            [top],
        ).fetchall()
    out: dict[int, set[str]] = {}
    for year, symbol in rows:
        out.setdefault(int(year), set()).add(symbol)
    return out


def _band_sql() -> str:
    return " or ".join(f"abs(r) between {lo} and {hi}" for lo, hi in _BANDS)


def weekly_features(symbols: list[str], root: Path | None = None) -> pd.DataFrame:
    """One row per (symbol, week-ending Friday): the as-of-that-week liquidity features."""
    from .. import db_read  # noqa: PLC0415 (avoid an import cycle at module load)

    mtime = db_read.catalog_mtime(root)
    key = (mtime, tuple(sorted(symbols)))
    with _lock:
        hit = _cache.get(key)
    if hit is not None:
        return hit
    if mtime is None or not symbols:
        return pd.DataFrame()
    frame = compute_weekly_features(symbols, root)
    with _lock:
        _cache.clear()  # one live entry is enough; a new catalog version invalidates the rest
        _cache[key] = frame
    return frame


def compute_weekly_features(symbols: list[str], root: Path | None = None) -> pd.DataFrame:
    """`weekly_features` without the cache: for a handful of symbols (e.g. explaining why a few
    holdings were sold) where evicting the whole-market entry would make the next run recompute
    it."""
    sql = f"""
    with d as (
      select i.symbol, b.date, b.series, b.close, b.volume, b.turnover / 1e7 as cr,
             b.close / nullif(b.prevclose, 0) - 1 as r
      from bars_1d_stock b join instruments i using (instrument_id)
      where i.symbol in (select unnest(?))),
    h as (
      select *, case when {_band_sql()} then sign(r) else 0 end as hit from d),
    c as (select *, lag(hit) over (partition by symbol order by date) as lh from h),
    g as (
      select *, sum(case when hit is distinct from lh then 1 else 0 end)
                over (partition by symbol order by date) as grp from c),
    runs as (
      select *, case when hit = 0 then 0
                     else row_number() over (partition by symbol, grp order by date) end as run_len
      from g),
    f as (
      select symbol, date, close,
        count(*) over w60 as n60,
        sum((series <> 'EQ')::int) over w60 as noneq60,
        sum((coalesce(volume, 0) = 0)::int) over w60 as zero60,
        median(cr) over w60 as med60,
        quantile_cont(cr, 0.1) over w60 as p10_60,
        max(run_len) over w125 as maxrun125,
        sum((hit <> 0)::int) over w60 as bandhits60
      from runs
      window w60 as (partition by symbol order by date
                     rows between {TURNOVER_WINDOW - 1} preceding and current row),
             w125 as (partition by symbol order by date
                      rows between {CIRCUIT_WINDOW - 1} preceding and current row))
    select symbol, (date_trunc('week', date) + interval 4 day)::date as wk,
           arg_max(n60, date) as n60, arg_max(noneq60, date) as noneq60,
           arg_max(zero60, date) as zero60, arg_max(med60, date) as med60,
           arg_max(p10_60, date) as p10_60, arg_max(maxrun125, date) as maxrun125,
           arg_max(bandhits60, date) as bandhits60, arg_max(close, date) as px
    from f group by 1, 2"""
    with connect(root or data_root(), read_only=True) as con:
        frame = con.execute(sql, [symbols]).df()
    frame["wk"] = pd.to_datetime(frame["wk"])
    return frame


def _passes(features: pd.DataFrame, cfg: LiquidityConfig) -> pd.Series:
    ok = (
        (features["n60"] >= MIN_SESSIONS)
        & (features["noneq60"] == 0)
        & (features["zero60"] == 0)
        & (features["med60"] >= cfg.min_turnover_cr)
        & (features["p10_60"] >= cfg.min_turnover_cr * cfg.floor_ratio)
        & (features["px"] >= cfg.min_price)
    )
    if cfg.circuit:
        ok &= features["maxrun125"] < cfg.circuit_run
    if cfg.max_circuit_days is not None:
        ok &= features["bandhits60"] <= cfg.max_circuit_days
    return ok


def failure_reason(row: pd.Series, cfg: LiquidityConfig) -> str:
    """The first gate test a stock's feature row fails (short label), or "eligible"."""
    if row["n60"] < MIN_SESSIONS:
        return "too few sessions"
    if row["noneq60"] > 0:
        return "not EQ series throughout"
    if row["zero60"] > 0:
        return "zero-volume days"
    if row["med60"] < cfg.min_turnover_cr:
        return "median turnover too low"
    if row["p10_60"] < cfg.min_turnover_cr * cfg.floor_ratio:
        return "quiet days too thin"
    if row["px"] < cfg.min_price:
        return "price too low"
    if cfg.circuit and row["maxrun125"] >= cfg.circuit_run:
        return "stuck at circuit"
    if cfg.max_circuit_days is not None and row["bandhits60"] > cfg.max_circuit_days:
        return "too many circuit days"
    return "eligible"


def failure_detail(row: pd.Series, cfg: LiquidityConfig) -> str:
    """`failure_reason` with the numbers, for a human reading a trade list."""
    label = failure_reason(row, cfg)
    if label == "too few sessions":
        return f"only {int(row['n60'])} trading days in the last 60 (needs {MIN_SESSIONS})"
    if label == "not EQ series throughout":
        return f"{int(row['noneq60'])} of the last 60 sessions were outside the EQ series"
    if label == "zero-volume days":
        return f"{int(row['zero60'])} zero-volume days in the last 60 sessions"
    if label == "median turnover too low":
        return (
            f"median daily turnover Rs {row['med60']:.2f} cr "
            f"below the Rs {cfg.min_turnover_cr:g} cr gate"
        )
    if label == "quiet days too thin":
        floor = cfg.min_turnover_cr * cfg.floor_ratio
        return f"quietest days Rs {row['p10_60']:.2f} cr below the Rs {floor:.2f} cr floor"
    if label == "price too low":
        return f"price Rs {row['px']:.0f} below the Rs {cfg.min_price:g} minimum"
    if label == "stuck at circuit":
        return f"{int(row['maxrun125'])} sessions in a row at the circuit limit"
    if label == "too many circuit days":
        return f"{int(row['bandhits60'])} circuit-limit days in the last 60 sessions"
    return label


def eligibility(
    cfg: LiquidityConfig, symbols: list[str], weeks: pd.Index, root: Path | None = None
) -> pd.DataFrame:
    """week x symbol booleans. A week with no fresh row (holiday-shortened) reuses the previous
    week's verdict once; a longer gap means the stock isn't trading, so it is ineligible."""
    cfg.validate()
    features = weekly_features(symbols, root)
    if features.empty:
        return pd.DataFrame(False, index=weeks, columns=symbols)
    # 1.0 = passed, 0.0 = has a fresh row and failed, NaN = no fresh row that week. Only the NaN
    # weeks may reuse the previous verdict: a week that was measured and failed must stay failed
    # (it used to be left as NaN too, so the forward-fill turned every first failing week back
    # into a pass and each gate exit landed a week late).
    verdict = features.assign(ok=_passes(features, cfg).astype(float)).pivot_table(
        index="wk", columns="symbol", values="ok", aggfunc="max"
    )
    verdict = verdict.reindex(index=weeks.union(verdict.index)).sort_index().ffill(limit=1)
    out = verdict.reindex(index=weeks, columns=symbols)
    return out.fillna(0.0).astype(bool)


def _last_full_week(features: pd.DataFrame) -> pd.Timestamp:
    """Latest week in which most of the market has a bar. After the newest bhavcopy day only a
    partial Fyers top-up exists (just the Total Market pool), which would make a "latest week"
    snapshot look like the whole market is untradable."""
    counts = features.groupby("wk")["symbol"].nunique().sort_index()
    typical = counts.tail(12).max()
    full = counts[counts >= 0.6 * typical]
    return full.index.max() if not full.empty else counts.index.max()


def preview(
    cfg: LiquidityConfig,
    symbols: list[str],
    *,
    as_of: pd.Timestamp | None = None,
    root: Path | None = None,
) -> dict:
    """What the gate does *today* (latest week with data): counts, and why each rejected stock
    failed, so the thresholds can be tuned by looking at actual names."""
    cfg.validate()
    features = weekly_features(symbols, root)
    if features.empty:
        return {
            "as_of": None,
            "universe": len(symbols),
            "eligible": 0,
            "reasons": {},
            "excluded": [],
        }
    latest = features["wk"].max()
    last = as_of or _last_full_week(features)
    snap = features[features["wk"] == last].set_index("symbol")
    eligible = _passes(snap, cfg)

    def reason(row: pd.Series) -> str:
        return failure_reason(row, cfg)

    rejected = snap[~eligible]
    reasons = rejected.apply(reason, axis=1)
    missing = sorted(set(symbols) - set(snap.index))
    excluded = [
        {
            "symbol": sym,
            "reason": reasons[sym],
            "median_turnover_cr": None if pd.isna(row["med60"]) else round(float(row["med60"]), 2),
            "price": None if pd.isna(row["px"]) else round(float(row["px"]), 2),
        }
        for sym, row in rejected.sort_values("med60").iterrows()
    ]
    excluded += [
        {"symbol": s, "reason": "no recent trading", "median_turnover_cr": None, "price": None}
        for s in missing
    ]
    counts = {k: int(v) for k, v in reasons.value_counts().items()}
    if missing:
        counts["no recent trading"] = len(missing)
    behind = latest > pd.Timestamp(last)
    return {
        "data_through": f"{pd.Timestamp(latest):%Y-%m-%d}",
        "warning": (
            f"Full-market bhavcopy only runs through {pd.Timestamp(last):%d %b %Y}; "
            "newer weeks hold just the Total Market pool, so a whole-market signal for them "
            "is incomplete until the NSE data catches up."
            if behind
            else None
        ),
        "as_of": f"{pd.Timestamp(last):%Y-%m-%d}",
        "universe": len(symbols),
        "eligible": int(eligible.sum()),
        "reasons": counts,
        "excluded": excluded[:200],
        "median_turnover_cr_p50": None
        if snap["med60"].dropna().empty
        else round(float(snap["med60"].median()), 2),
    }
