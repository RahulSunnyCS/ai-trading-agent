"""
Derived datasets (BL-034 Phase 3), rebuilt from the 1-minute lake — never edited by hand:

    lake/derived/chain_snapshots_5m/underlying=U/date=D/data.parquet
    lake/derived/straddle_series_5m/underlying=U/date=D/data.parquet
    lake/derived/contracts_daily/underlying=U/date=D/data.parquet
    lake/derived/iv_daily/underlying=U/data.parquet

**Time.** A 5-minute row with `bucket` T covers the window [T, T+5 min) of the session
09:15-15:30 (75 windows; off-session bars are ignored). Its values use only the 1-minute bars
that START inside the window (and, for carried prices, earlier ones), so a row is known at
T+5. `open` is the price at the window's START exactly as the 1-minute legwise engine sees it
(the open of the window's first minute, or the last earlier close when that minute had no
trade); high/low/close/volume/oi are the window's. IV, greeks and the forward are computed from
the window's CLOSE.

**Contracts kept.** Every expiry within MAX_DTE_DAYS of the day; a strike from the first window
it is within STRIKES_EACH_SIDE steps of that window's ATM (ATM = the spot at the window's start,
rounded half up on the strike step — the legwise engine's and apps/server's rule) to the end of
the day, so a position opened near the money keeps a price however far the index moves.
`offset` is always relative to the row's own window, so it can exceed ±10.

**Forward and IV.** The implied forward of each (window, expiry) comes from put-call parity at
the strike nearest the spot with both a call and a put price: F = K + (C - P) e^{rT}, r the RBI
repo rate (`rates.csv`), T from the window's end to 15:30 on expiry day in calendar years (at
least one minute). IV is Black-76 on that forward, solved by bisection; greeks are Black-76
(delta is d(price)/dF, theta per calendar day, vega per volatility point). `iv_quality` names
why an IV should not be trusted: low_premium (< 2), stale (no trade in the window),
expiry_last_hour, parity_gap (forward more than 1% from spot), no_solution.

**Versioning.** Every file carries `derived_version` in its Parquet key-value metadata; a
rebuild skips files already at DERIVED_VERSION unless forced. Bump it whenever a formula or a
column changes.
"""

from __future__ import annotations

import csv
import math
from collections.abc import Callable, Iterable
from dataclasses import dataclass
from datetime import date, datetime, time
from pathlib import Path
from zoneinfo import ZoneInfo

import duckdb
import numpy as np
import pyarrow as pa
import pyarrow.parquet as pq

from . import lake
from .reference import REFERENCE_DIR

DERIVED_VERSION = 1
IST = ZoneInfo("Asia/Kolkata")
BUCKET_MINUTES = 5
N_BUCKETS = 75  # 09:15 .. 15:25 window starts
SESSION_OPEN = time(9, 15)
EXPIRY_CLOSE = time(15, 30)
STRIKES_EACH_SIDE = 10
#: Expiries further out are left out of the snapshots. 45 days keeps the current monthly and
#: every weekly in front of it, so "monthly = last listed expiry of its month" still works.
MAX_DTE_DAYS = 45
#: Owner decision (2026-10-06): derived tables for NIFTY and SENSEX; the code takes any index.
DEFAULT_UNDERLYINGS = ("NIFTY", "SENSEX")
#: The first day with dated lot sizes, real expiries and full chains (BL-034 Phase 2).
DERIVED_FROM = date(2024, 10, 1)
DATASETS = ("chain_snapshots_5m", "straddle_series_5m", "contracts_daily")
#: iv_daily uses the window ending at these times.
IV_OPEN_BUCKET = 0  # 09:15-09:20, "IV at 09:20"
IV_CLOSE_BUCKET = 68  # 14:55-15:00, "IV at 15:00" (before the last half hour's noise)
SKEW_STEPS = 5
LOW_PREMIUM = 2.0
PARITY_GAP = 0.01
_SECONDS_PER_YEAR = 365.0 * 86400.0

_TS = pa.timestamp("s", tz="Asia/Kolkata")
CHAIN_SCHEMA = pa.schema(
    [
        pa.field("bucket", _TS),
        pa.field("expiry", pa.date32()),
        pa.field("strike", pa.float64()),
        pa.field("option_type", pa.string()),
        pa.field("offset", pa.int16()),  # strike steps from the window's ATM (spot at its start)
        pa.field("open", pa.float64()),
        pa.field("high", pa.float64()),
        pa.field("low", pa.float64()),
        pa.field("close", pa.float64()),
        pa.field("volume", pa.float64()),
        pa.field("oi", pa.float64()),
        pa.field("traded", pa.bool_()),
        pa.field("spot_open", pa.float64()),
        pa.field("spot_high", pa.float64()),
        pa.field("spot_low", pa.float64()),
        pa.field("spot_close", pa.float64()),
        pa.field("vix", pa.float64()),
        pa.field("dte", pa.int16()),
        pa.field("t_years", pa.float64()),
        pa.field("forward", pa.float64()),
        pa.field("forward_source", pa.string()),  # parity | spot
        pa.field("iv", pa.float64()),
        pa.field("delta", pa.float64()),
        pa.field("gamma", pa.float64()),
        pa.field("theta", pa.float64()),
        pa.field("vega", pa.float64()),
        pa.field("iv_quality", pa.string()),
    ]
)
STRADDLE_SCHEMA = pa.schema(
    [
        pa.field("bucket", _TS),
        pa.field("expiry", pa.date32()),
        pa.field("dte", pa.int16()),
        pa.field("spot_open", pa.float64()),
        pa.field("spot_close", pa.float64()),
        pa.field("vix", pa.float64()),
        pa.field("atm", pa.float64()),  # from spot_close, like apps/server's straddle calculator
        pa.field("ce_close", pa.float64()),
        pa.field("pe_close", pa.float64()),
        pa.field("straddle", pa.float64()),
        pa.field("atm_open", pa.float64()),  # from spot_open: the strike an entry at T would get
        pa.field("ce_open", pa.float64()),
        pa.field("pe_open", pa.float64()),
        pa.field("straddle_open", pa.float64()),
        pa.field("forward", pa.float64()),
        pa.field("atm_iv", pa.float64()),  # mean of the ATM call and put IV
        pa.field("skew", pa.float64()),  # IV(put, ATM - 5 steps) - IV(call, ATM + 5 steps)
    ]
)
CONTRACTS_SCHEMA = pa.schema(
    [
        pa.field("instrument_id", pa.int64()),
        pa.field("expiry", pa.date32()),
        pa.field("strike", pa.float64()),
        pa.field("option_type", pa.string()),
        pa.field("dte", pa.int16()),
        pa.field("first_ts", _TS),
        pa.field("last_ts", _TS),
        pa.field("bars", pa.int32()),  # in-session 1-minute bars
        pa.field("traded_minutes", pa.int32()),  # of those, with volume > 0
        pa.field("open", pa.float64()),
        pa.field("high", pa.float64()),  # = max premium
        pa.field("low", pa.float64()),  # = min premium
        pa.field("close", pa.float64()),
        pa.field("volume", pa.float64()),
        pa.field("oi", pa.float64()),  # last in-session OI
    ]
)
IV_DAILY_SCHEMA = pa.schema(
    [
        pa.field("trading_day", pa.date32()),
        pa.field("expiry", pa.date32()),
        pa.field("expiry_rank", pa.int16()),  # 0 = nearest
        pa.field("dte", pa.int16()),
        pa.field("atm_iv_0920", pa.float64()),
        pa.field("atm_iv_1500", pa.float64()),
        pa.field("skew_1500", pa.float64()),
        pa.field("straddle_1500", pa.float64()),
        pa.field("forward_1500", pa.float64()),
        pa.field("spot_close", pa.float64()),
        pa.field("vix_close", pa.float64()),
        pa.field("rv_20", pa.float64()),  # annualised, close-to-close log returns, 20 days
        pa.field("front_expiry", pa.date32()),  # nearest expiry at least 2 days away
        pa.field("front_iv_1500", pa.float64()),
        pa.field("vix_pct_1y", pa.float64()),  # share of the last 252 days at or below today
        pa.field("vix_pct_2y", pa.float64()),  # ... 504 days
        pa.field("front_iv_pct_1y", pa.float64()),
        pa.field("front_iv_pct_2y", pa.float64()),
    ]
)
#: Percentiles need at least this many days of history, else NULL.
MIN_PCT_HISTORY = 60


# ---------------------------------------------------------------------------
# Paths and versions
# ---------------------------------------------------------------------------


def derived_path(root: Path, dataset: str, underlying: str, day: date | None = None) -> Path:
    base = root / "lake" / "derived" / dataset / f"underlying={underlying}"
    if day is None:
        return base / "data.parquet"
    return base / f"date={day.isoformat()}" / "data.parquet"


def file_version(path: Path) -> int | None:
    if not path.exists():
        return None
    meta = pq.read_metadata(path).metadata or {}
    value = meta.get(b"derived_version")
    return int(value) if value is not None else None


def _write(table: pa.Table, path: Path) -> None:
    meta = dict(table.schema.metadata or {})
    meta[b"derived_version"] = str(DERIVED_VERSION).encode()
    lake.write_parquet(table.replace_schema_metadata(meta), path)


# ---------------------------------------------------------------------------
# Reference data, read from the committed CSVs (lock-free; the catalog is their master)
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class Reference:
    steps: dict[str, list[tuple[date, float]]]
    rates: list[tuple[date, float]]

    @classmethod
    def load(cls, folder: Path = REFERENCE_DIR) -> Reference:
        steps: dict[str, list[tuple[date, float]]] = {}
        with (folder / "strike_step.csv").open(newline="") as fh:
            for row in csv.DictReader(fh):
                steps.setdefault(row["underlying"], []).append(
                    (date.fromisoformat(row["effective_date"]), float(row["step"]))
                )
        with (folder / "rates.csv").open(newline="") as fh:
            rates = [
                (date.fromisoformat(r["effective_date"]), float(r["rate_pct"]) / 100)
                for r in csv.DictReader(fh)
                if r["name"] == "RBI_REPO"
            ]
        return cls({u: sorted(v) for u, v in steps.items()}, sorted(rates))

    @staticmethod
    def _as_of(rows: list[tuple[date, float]], day: date, what: str) -> float:
        found = [v for d, v in rows if d <= day]
        if not found:
            raise ValueError(f"no {what} effective on or before {day}")
        return found[-1]

    def step(self, underlying: str, day: date) -> float:
        return self._as_of(self.steps.get(underlying, []), day, f"strike step for {underlying}")

    def rate(self, day: date) -> float:
        return self._as_of(self.rates, day, "RBI repo rate")


# ---------------------------------------------------------------------------
# Black-76
# ---------------------------------------------------------------------------


def _norm_cdf(x: np.ndarray) -> np.ndarray:
    """Abramowitz & Stegun 7.1.26 via erf; absolute error < 1.5e-7 — far below the paise
    an option price is quoted in."""
    z = np.abs(x) / math.sqrt(2.0)
    t = 1.0 / (1.0 + 0.3275911 * z)
    poly = t * (
        0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429)))
    )
    erf = 1.0 - poly * np.exp(-z * z)
    return 0.5 * (1.0 + np.sign(x) * erf)


def _norm_pdf(x: np.ndarray) -> np.ndarray:
    return np.exp(-0.5 * x * x) / math.sqrt(2.0 * math.pi)


def black76(
    forward: np.ndarray,
    strike: np.ndarray,
    t: np.ndarray,
    sigma: np.ndarray,
    df: np.ndarray,
    is_call: np.ndarray,
) -> np.ndarray:
    sq = sigma * np.sqrt(t)
    d1 = (np.log(forward / strike) + 0.5 * sq * sq) / sq
    d2 = d1 - sq
    call = df * (forward * _norm_cdf(d1) - strike * _norm_cdf(d2))
    put = df * (strike * _norm_cdf(-d2) - forward * _norm_cdf(-d1))
    return np.where(is_call, call, put)


def implied_vol(
    price: np.ndarray,
    forward: np.ndarray,
    strike: np.ndarray,
    t: np.ndarray,
    df: np.ndarray,
    is_call: np.ndarray,
    iterations: int = 80,
) -> np.ndarray:
    """Black-76 IV by bisection on [0.0001, 5]; NaN where the price is outside the
    no-arbitrage bounds (at or below discounted intrinsic, or above the upper bound)."""
    intrinsic = df * np.where(
        is_call, np.maximum(forward - strike, 0), np.maximum(strike - forward, 0)
    )
    upper = df * np.where(is_call, forward, strike)
    ok = (price > intrinsic + 1e-9) & (price < upper) & np.isfinite(forward) & (t > 0)
    lo = np.full(price.shape, 1e-4)
    hi = np.full(price.shape, 5.0)
    safe_f = np.where(ok, forward, 1.0)
    safe_k = np.where(ok, strike, 1.0)
    for _ in range(iterations):
        mid = 0.5 * (lo + hi)
        above = black76(safe_f, safe_k, t, mid, df, is_call) > price
        hi = np.where(above, mid, hi)
        lo = np.where(above, lo, mid)
    return np.where(ok, 0.5 * (lo + hi), np.nan)


def greeks(
    forward: np.ndarray,
    strike: np.ndarray,
    t: np.ndarray,
    sigma: np.ndarray,
    df: np.ndarray,
    is_call: np.ndarray,
    rate: float,
    price: np.ndarray,
) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    """delta (per unit of forward), gamma, theta (per calendar day), vega (per vol point)."""
    sq = sigma * np.sqrt(t)
    d1 = (np.log(forward / strike) + 0.5 * sq * sq) / sq
    pdf = _norm_pdf(d1)
    delta = np.where(is_call, df * _norm_cdf(d1), -df * _norm_cdf(-d1))
    gamma = df * pdf / (forward * sq)
    vega = df * forward * pdf * np.sqrt(t) / 100.0
    theta = (-df * forward * pdf * sigma / (2.0 * np.sqrt(t)) + rate * price) / 365.0
    return delta, gamma, theta, vega


# ---------------------------------------------------------------------------
# One day
# ---------------------------------------------------------------------------


@dataclass
class DayBuild:
    chain: pa.Table
    straddle: pa.Table
    contracts: pa.Table


def _session_epoch(day: date) -> int:
    return int(datetime.combine(day, SESSION_OPEN, IST).timestamp())


def _sql_path(path: Path) -> str:
    return path.as_posix().replace("'", "''")


def _index_windows(con: duckdb.DuckDBPyConnection, path: Path, t0: int) -> dict[int, tuple]:
    """{window: (open at start, high, low, close)} for an index file, carried forward over
    windows without bars up to the last window that has one (and the open taken from the
    previous close when the window's first minute is missing), as the legwise engine's
    forward-filled series."""
    rows = con.execute(
        f"""
        WITH m AS (
            SELECT ((epoch(ts) - {t0}) // 60)::INT AS minute, open, high, low, close
            FROM read_parquet('{_sql_path(path)}')
        )
        SELECT minute // 5 AS w,
               max(open) FILTER (WHERE minute % 5 = 0) AS first_open,
               max(high), min(low), arg_max(close, minute)
        FROM m WHERE minute BETWEEN 0 AND {N_BUCKETS * BUCKET_MINUTES - 1}
        GROUP BY 1 ORDER BY 1
        """
    ).fetchall()
    by_w = {int(r[0]): r[1:] for r in rows}
    out: dict[int, tuple] = {}
    last: float | None = None
    # never past the last window with a bar: a short session must not grow carried windows
    for w in range(max(by_w, default=-1) + 1):
        if w in by_w:
            first_open, hi, lo, close = by_w[w]
            start = first_open if first_open is not None else last
            if start is None:
                start = close
            out[w] = (start, max(hi, start), min(lo, start), close)
            last = close
        elif last is not None:
            out[w] = (last, last, last, last)
    return out


def build_day(
    root: Path, underlying: str, day: date, reference: Reference | None = None
) -> DayBuild | None:
    """All three per-day tables, or None when the day has no option file, no index file, or no
    in-session index bar."""
    reference = reference or Reference.load()
    opt = lake.bars_1m_path(root, "option", underlying, day)
    idx = lake.bars_1m_path(root, "index", underlying, day)
    if not opt.exists() or not idx.exists():
        return None
    vix_path = lake.bars_1m_path(root, "index", "INDIAVIX", day)
    t0 = _session_epoch(day)
    step = reference.step(underlying, day)
    rate = reference.rate(day)
    con = duckdb.connect()
    try:
        con.execute("SET TimeZone = 'Asia/Kolkata'")
        spot = _index_windows(con, idx, t0)
        if not spot:
            return None
        vix = _index_windows(con, vix_path, t0) if vix_path.exists() else {}
        contracts = _contracts_daily(con, opt, t0, day)
        chain = _chain(con, opt, t0, day, step, spot)
    finally:
        con.close()
    chain = _add_spot_and_iv(chain, day, spot, vix, rate, step)
    straddle = _straddle(chain, step)
    return DayBuild(chain=chain, straddle=straddle, contracts=contracts)


def _contracts_daily(con: duckdb.DuckDBPyConnection, opt: Path, t0: int, day: date) -> pa.Table:
    last_minute = N_BUCKETS * BUCKET_MINUTES - 1
    table = con.execute(
        f"""
        WITH m AS (
            SELECT instrument_id, expiry, strike, option_type, ts, open, high, low, close,
                   volume, oi, ((epoch(ts) - {t0}) // 60)::INT AS minute
            FROM read_parquet('{_sql_path(opt)}')
        )
        SELECT instrument_id, expiry, strike, option_type,
               (expiry - DATE '{day.isoformat()}')::SMALLINT AS dte,
               min(ts) AS first_ts, max(ts) AS last_ts,
               count(*)::INT AS bars, count(*) FILTER (WHERE volume > 0)::INT AS traded_minutes,
               arg_min(open, minute) AS open, max(high) AS high, min(low) AS low,
               arg_max(close, minute) AS close, sum(volume) AS volume,
               arg_max(oi, minute) AS oi
        FROM m WHERE minute BETWEEN 0 AND {last_minute}
        GROUP BY ALL ORDER BY expiry, strike, option_type
        """
    ).to_arrow_table()
    return table.select(CONTRACTS_SCHEMA.names).cast(CONTRACTS_SCHEMA)


def _chain(
    con: duckdb.DuckDBPyConnection,
    opt: Path,
    t0: int,
    day: date,
    step: float,
    spot: dict[int, tuple],
) -> dict[str, np.ndarray]:
    """Window rows for the kept contracts, as numpy columns (no spot/IV yet)."""
    atm = {w: math.floor(v[0] / step + 0.5) * step for w, v in spot.items()}
    lo_strike = min(atm.values()) - (STRIKES_EACH_SIDE + 1) * step
    hi_strike = max(atm.values()) + (STRIKES_EACH_SIDE + 1) * step
    con.register("atm_by_w", pa.table({"w": list(atm), "atm": list(atm.values())}))
    last_minute = N_BUCKETS * BUCKET_MINUTES - 1
    d = day.isoformat()
    table = con.execute(
        f"""
        WITH m AS (
            SELECT expiry, strike, option_type, ((epoch(ts) - {t0}) // 60)::INT AS minute,
                   open, high, low, close, volume, oi
            FROM read_parquet('{_sql_path(opt)}')
            WHERE expiry BETWEEN DATE '{d}' AND DATE '{d}' + {MAX_DTE_DAYS}
              AND strike BETWEEN {lo_strike} AND {hi_strike}
        ),
        wa AS (
            SELECT expiry, strike, option_type, minute // 5 AS w,
                   max(open) FILTER (WHERE minute % 5 = 0) AS first_open,
                   max(high) AS hi, min(low) AS lo, arg_max(close, minute) AS c,
                   sum(volume) AS vol, arg_max(oi, minute) AS oi_last
            FROM m WHERE minute BETWEEN 0 AND {last_minute}
            GROUP BY ALL
        ),
        k AS (SELECT expiry, strike, option_type, min(w) AS w0 FROM wa GROUP BY ALL),
        grid AS (
            SELECT k.expiry, k.strike, k.option_type, r.range AS w
            FROM k, range(0, {N_BUCKETS}) r WHERE r.range >= k.w0
        ),
        g AS (
            SELECT grid.*, wa.first_open, wa.hi, wa.lo, wa.c, wa.vol, wa.oi_last,
                   wa.c IS NOT NULL AS traded,
                   last_value(wa.c IGNORE NULLS) OVER win AS c_ff,
                   last_value(wa.oi_last IGNORE NULLS) OVER win AS oi_ff
            FROM grid LEFT JOIN wa USING (expiry, strike, option_type, w)
            WINDOW win AS (PARTITION BY grid.expiry, grid.strike, grid.option_type ORDER BY grid.w
                           ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)
        ),
        f AS (
            SELECT g.*, lag(c_ff) OVER (PARTITION BY expiry, strike, option_type ORDER BY w)
                   AS prev_close
            FROM g
        ),
        banded AS (
            SELECT f.*, a.atm,
                   abs(f.strike - a.atm) <= {STRIKES_EACH_SIDE * step} + 1e-9 AS in_band
            FROM f JOIN atm_by_w a ON a.w = f.w
        ),
        -- a contract stays from the first window it is near the money to the end of the day,
        -- so a position opened in it keeps a price however far the index then moves
        sticky AS (
            SELECT expiry, strike, option_type, min(w) AS w_in
            FROM banded WHERE in_band GROUP BY ALL
        )
        SELECT b.w, b.expiry, b.strike, b.option_type,
               round((b.strike - b.atm) / {step})::SMALLINT AS offset,
               coalesce(b.first_open, b.prev_close) AS open,
               greatest(coalesce(b.hi, b.prev_close), coalesce(b.first_open, b.prev_close, b.hi))
                   AS high,
               least(coalesce(b.lo, b.prev_close), coalesce(b.first_open, b.prev_close, b.lo))
                   AS low,
               b.c_ff AS close, coalesce(b.vol, 0) AS volume, b.oi_ff AS oi, b.traded,
               (b.expiry - DATE '{d}')::SMALLINT AS dte
        FROM banded b JOIN sticky s USING (expiry, strike, option_type)
        WHERE b.w >= s.w_in
        ORDER BY b.w, b.expiry, b.strike, b.option_type
        """
    ).to_arrow_table()
    con.unregister("atm_by_w")
    return {name: table.column(name).to_numpy(zero_copy_only=False) for name in table.column_names}


def _add_spot_and_iv(
    c: dict[str, np.ndarray],
    day: date,
    spot: dict[int, tuple],
    vix: dict[int, tuple],
    rate: float,
    step: float,
) -> pa.Table:
    n = len(c["w"])
    w = c["w"].astype(np.int64)
    spot_cols = np.array([spot.get(int(i), (np.nan,) * 4) for i in range(N_BUCKETS)], dtype=float)
    vix_close = np.array([vix[i][3] if i in vix else np.nan for i in range(N_BUCKETS)], dtype=float)
    s_open, s_high, s_low, s_close = (spot_cols[w, j] for j in range(4)) if n else ([],) * 4
    expiry = c["expiry"]
    # seconds from each window's end to 15:30 on expiry day
    t0 = _session_epoch(day)
    win_end = t0 + (w + 1) * BUCKET_MINUTES * 60
    exp_close = np.array(
        [int(datetime.combine(e, EXPIRY_CLOSE, IST).timestamp()) for e in _as_dates(expiry)],
        dtype=np.int64,
    )
    t_years = np.maximum(exp_close - win_end, 60) / _SECONDS_PER_YEAR
    df = np.exp(-rate * t_years)
    strike = c["strike"].astype(float)
    close = np.array([np.nan if v is None else v for v in c["close"]], dtype=float)
    is_call = c["option_type"] == "CE"

    # implied forward per (window, expiry), from the strike nearest spot with both prices
    forward = np.full(n, np.nan)
    source = np.full(n, None, dtype=object)
    groups: dict[tuple[int, object], list[int]] = {}
    for i in range(n):
        groups.setdefault((int(w[i]), expiry[i]), []).append(i)
    for (wi, _e), idx in groups.items():
        s = spot_cols[wi, 3]
        calls = {strike[i]: close[i] for i in idx if is_call[i] and not np.isnan(close[i])}
        puts = {strike[i]: close[i] for i in idx if not is_call[i] and not np.isnan(close[i])}
        both = sorted(set(calls) & set(puts), key=lambda k: (abs(k - s), k))
        dfi = df[idx[0]]
        if both:
            k = both[0]
            f, src = k + (calls[k] - puts[k]) / dfi, "parity"
        else:
            f, src = s / dfi, "spot"
        forward[idx] = f
        source[idx] = src

    iv = implied_vol(close, forward, strike, t_years, df, is_call)
    sigma = np.where(np.isnan(iv), 0.2, iv)
    delta, gamma, theta, vega = greeks(forward, strike, t_years, sigma, df, is_call, rate, close)
    bad = np.isnan(iv)
    delta, gamma, theta, vega = (np.where(bad, np.nan, x) for x in (delta, gamma, theta, vega))

    last_hour = (c["dte"] == 0) & (w >= (14 * 60 + 30 - (9 * 60 + 15)) // BUCKET_MINUTES)
    flags = []
    for i in range(n):
        reasons = []
        if bad[i]:
            reasons.append("no_solution")
        if not np.isnan(close[i]) and close[i] < LOW_PREMIUM:
            reasons.append("low_premium")
        if not c["traded"][i]:
            reasons.append("stale")
        if last_hour[i]:
            reasons.append("expiry_last_hour")
        if source[i] == "parity" and abs(forward[i] / s_close[i] - 1) > PARITY_GAP:
            reasons.append("parity_gap")
        flags.append(",".join(reasons) or None)

    bucket = (t0 + w * BUCKET_MINUTES * 60).astype(np.int64)
    table = pa.table(
        {
            "bucket": pa.array(bucket, pa.int64()).cast(pa.timestamp("s", tz="UTC")).cast(_TS),
            "expiry": pa.array(_as_dates(expiry), pa.date32()),
            "strike": strike,
            "option_type": c["option_type"].astype(str),
            "offset": c["offset"].astype(np.int16),
            "open": _f(c["open"]),
            "high": _f(c["high"]),
            "low": _f(c["low"]),
            "close": close,
            "volume": _f(c["volume"]),
            "oi": _f(c["oi"]),
            "traded": c["traded"].astype(bool),
            "spot_open": s_open,
            "spot_high": s_high,
            "spot_low": s_low,
            "spot_close": s_close,
            "vix": pa.array(vix_close[w] if n else [], pa.float64(), from_pandas=True),
            "dte": c["dte"].astype(np.int16),
            "t_years": t_years,
            "forward": forward,
            "forward_source": pa.array(list(source), pa.string()),
            "iv": pa.array(iv, pa.float64(), from_pandas=True),
            "delta": pa.array(delta, pa.float64(), from_pandas=True),
            "gamma": pa.array(gamma, pa.float64(), from_pandas=True),
            "theta": pa.array(theta, pa.float64(), from_pandas=True),
            "vega": pa.array(vega, pa.float64(), from_pandas=True),
            "iv_quality": pa.array(flags, pa.string()),
        }
    )
    return table.cast(CHAIN_SCHEMA)


def _f(values: np.ndarray) -> np.ndarray:
    return np.array([np.nan if v is None else v for v in values], dtype=float)


def _as_dates(values: Iterable) -> list[date]:
    out = []
    for v in values:
        if isinstance(v, np.datetime64):
            v = date.fromisoformat(str(v.astype("datetime64[D]")))
        out.append(v)
    return out


def _straddle(chain: pa.Table, step: float) -> pa.Table:
    """Per (window, expiry): the ATM straddle at the window's close (ATM from spot_close) and at
    its start (ATM from spot_open), the ATM IV and the 5-step skew."""
    cols = chain.to_pydict()
    by_key: dict[tuple, dict] = {}
    for i in range(chain.num_rows):
        key = (cols["bucket"][i], cols["expiry"][i])
        by_key.setdefault(key, {})[(cols["strike"][i], cols["option_type"][i])] = i
    out: dict[str, list] = {name: [] for name in STRADDLE_SCHEMA.names}
    for (bucket, expiry), rows in by_key.items():
        first = next(iter(rows.values()))
        s_open, s_close = cols["spot_open"][first], cols["spot_close"][first]
        atm = math.floor(s_close / step + 0.5) * step
        atm_open = math.floor(s_open / step + 0.5) * step

        def val(strike: float, kind: str, col: str, rows: dict = rows) -> float | None:
            i = rows.get((strike, kind))
            v = None if i is None else cols[col][i]
            return None if v is None or (isinstance(v, float) and math.isnan(v)) else v

        ce, pe = val(atm, "CE", "close"), val(atm, "PE", "close")
        ce_o, pe_o = val(atm_open, "CE", "open"), val(atm_open, "PE", "open")
        ivs = [x for x in (val(atm, "CE", "iv"), val(atm, "PE", "iv")) if x is not None]
        put_iv = val(atm - SKEW_STEPS * step, "PE", "iv")
        call_iv = val(atm + SKEW_STEPS * step, "CE", "iv")
        row = {
            "bucket": bucket,
            "expiry": expiry,
            "dte": cols["dte"][first],
            "spot_open": s_open,
            "spot_close": s_close,
            "vix": cols["vix"][first],
            "atm": atm,
            "ce_close": ce,
            "pe_close": pe,
            "straddle": None if ce is None or pe is None else ce + pe,
            "atm_open": atm_open,
            "ce_open": ce_o,
            "pe_open": pe_o,
            "straddle_open": None if ce_o is None or pe_o is None else ce_o + pe_o,
            "forward": cols["forward"][first],
            "atm_iv": sum(ivs) / len(ivs) if ivs else None,
            "skew": None if put_iv is None or call_iv is None else put_iv - call_iv,
        }
        for name in STRADDLE_SCHEMA.names:
            out[name].append(row[name])
    return pa.table(out).cast(STRADDLE_SCHEMA)


# ---------------------------------------------------------------------------
# iv_daily
# ---------------------------------------------------------------------------


def build_iv_daily(root: Path, underlying: str) -> pa.Table:
    """One row per (day, expiry) from every straddle_series_5m file of the underlying.
    Trailing values (rv_20, percentiles) use only that day and earlier days."""
    folder = root / "lake" / "derived" / "straddle_series_5m" / f"underlying={underlying}"
    if not any(folder.glob("date=*/data.parquet")):
        return IV_DAILY_SCHEMA.empty_table()
    con = duckdb.connect()
    try:
        con.execute("SET TimeZone = 'Asia/Kolkata'")
        rows = con.execute(
            f"""
            SELECT date AS trading_day, expiry, dte,
                   max(atm_iv) FILTER (WHERE w = {IV_OPEN_BUCKET}) AS atm_iv_0920,
                   max(atm_iv) FILTER (WHERE w = {IV_CLOSE_BUCKET}) AS atm_iv_1500,
                   max(skew) FILTER (WHERE w = {IV_CLOSE_BUCKET}) AS skew_1500,
                   max(straddle) FILTER (WHERE w = {IV_CLOSE_BUCKET}) AS straddle_1500,
                   max(forward) FILTER (WHERE w = {IV_CLOSE_BUCKET}) AS forward_1500,
                   arg_max(spot_close, w) AS spot_close, arg_max(vix, w) AS vix_close
            FROM (
                SELECT *, ((extract(hour FROM bucket) * 60 + extract(minute FROM bucket)
                            - (9 * 60 + 15)) // 5)::INT AS w
                FROM read_parquet('{_sql_path(folder)}/date=*/data.parquet',
                                  hive_partitioning = true)
            )
            GROUP BY ALL ORDER BY trading_day, expiry
            """
        ).fetchall()
    finally:
        con.close()
    days = sorted({r[0] for r in rows})
    per_day: dict[date, list[tuple]] = {}
    for r in rows:
        per_day.setdefault(r[0], []).append(r)
    spot_close = {d: per_day[d][0][8] for d in days}
    vix_close = {d: per_day[d][0][9] for d in days}
    front: dict[date, tuple[date | None, float | None]] = {}
    for d in days:
        cands = [r for r in per_day[d] if r[2] >= 2]
        front[d] = (cands[0][1], cands[0][4]) if cands else (None, None)

    def trailing(series: dict[date, float | None], i: int, window: int) -> float | None:
        today = series[days[i]]
        if today is None:
            return None
        hist = [series[days[j]] for j in range(max(0, i - window + 1), i + 1)]
        hist = [h for h in hist if h is not None]
        if len(hist) < MIN_PCT_HISTORY:
            return None
        return sum(1 for h in hist if h <= today) / len(hist)

    front_iv = {d: front[d][1] for d in days}
    out: dict[str, list] = {name: [] for name in IV_DAILY_SCHEMA.names}
    for i, d in enumerate(days):
        rets = [
            math.log(spot_close[days[j]] / spot_close[days[j - 1]])
            for j in range(max(1, i - 19), i + 1)
        ]
        rv = (
            math.sqrt(sum(x * x for x in rets) / len(rets)) * math.sqrt(252)
            if len(rets) == 20
            else None
        )
        day_level = {
            "spot_close": spot_close[d],
            "vix_close": vix_close[d],
            "rv_20": rv,
            "front_expiry": front[d][0],
            "front_iv_1500": front[d][1],
            "vix_pct_1y": trailing(vix_close, i, 252),
            "vix_pct_2y": trailing(vix_close, i, 504),
            "front_iv_pct_1y": trailing(front_iv, i, 252),
            "front_iv_pct_2y": trailing(front_iv, i, 504),
        }
        for rank, r in enumerate(per_day[d]):
            row = {
                "trading_day": d,
                "expiry": r[1],
                "expiry_rank": rank,
                "dte": r[2],
                "atm_iv_0920": r[3],
                "atm_iv_1500": r[4],
                "skew_1500": r[5],
                "straddle_1500": r[6],
                "forward_1500": r[7],
                **day_level,
            }
            for name in IV_DAILY_SCHEMA.names:
                out[name].append(row[name])
    return pa.table(out).cast(IV_DAILY_SCHEMA)


# ---------------------------------------------------------------------------
# Rebuild
# ---------------------------------------------------------------------------


@dataclass
class RebuildReport:
    built: int = 0
    skipped_current: int = 0
    skipped_no_data: int = 0
    iv_daily_rows: int = 0


def candidate_days(root: Path, underlying: str, days: tuple[date, date] | None) -> list[date]:
    lo, hi = days or (DERIVED_FROM, date.max)
    lo = max(lo, DERIVED_FROM)
    option_days = set(lake.available_days(root, "option", underlying))
    index_days = set(lake.available_days(root, "index", underlying))
    return sorted(d for d in option_days & index_days if lo <= d <= hi)


def rebuild(
    root: Path,
    underlyings: Iterable[str] = DEFAULT_UNDERLYINGS,
    *,
    days: tuple[date, date] | None = None,
    force: bool = False,
    log: Callable[[str], None] = print,
) -> dict[str, RebuildReport]:
    """Build every missing or out-of-version day file, then iv_daily for each underlying."""
    reference = Reference.load()
    reports = {}
    for u in underlyings:
        report = RebuildReport()
        todo = candidate_days(root, u, days)
        for n, day in enumerate(todo, 1):
            paths = {ds: derived_path(root, ds, u, day) for ds in DATASETS}
            if not force and all(file_version(p) == DERIVED_VERSION for p in paths.values()):
                report.skipped_current += 1
                continue
            build = build_day(root, u, day, reference)
            if build is None or build.chain.num_rows == 0:
                report.skipped_no_data += 1
                continue
            _write(build.chain, paths["chain_snapshots_5m"])
            _write(build.straddle, paths["straddle_series_5m"])
            _write(build.contracts, paths["contracts_daily"])
            report.built += 1
            if n % 50 == 0:
                log(f"{u}: {n}/{len(todo)} days")
        iv = build_iv_daily(root, u)
        if iv.num_rows:
            _write(iv, derived_path(root, "iv_daily", u))
        report.iv_daily_rows = iv.num_rows
        log(
            f"{u}: built {report.built}, already current {report.skipped_current}, "
            f"no data {report.skipped_no_data}; iv_daily {iv.num_rows} rows"
        )
        reports[u] = report
    return reports


def check_day(root: Path, underlying: str, day: date) -> list[str]:
    """Rebuild one day in memory and compare it with the stored files; [] when identical."""
    build = build_day(root, underlying, day)
    if build is None:
        return [f"{underlying} {day}: no input data"]
    problems = []
    for dataset, table in (
        ("chain_snapshots_5m", build.chain),
        ("straddle_series_5m", build.straddle),
        ("contracts_daily", build.contracts),
    ):
        path = derived_path(root, dataset, underlying, day)
        if not path.exists():
            problems.append(f"{dataset}: not built")
            continue
        stored = pq.read_table(path).replace_schema_metadata(None)
        if not stored.cast(table.schema).equals(table.replace_schema_metadata(None)):
            problems.append(f"{dataset}: differs from a fresh rebuild")
    return problems
