"""BL-022: the day vector at a check time, and the nearest earlier days. Pre-registered in
backlog/BL-022-analog-day-search.md (Phase 0, 2026-10-22); every constant below is from there.

A bar stamped m covers m .. m + 1, so "bars stamped before T" (grid columns [0, j) with
j = T - 09:15) are complete at T. Nothing here reads column j or later for a feature; the outcome
reads columns j .. 15:14 only.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import pandas as pd

LAKE = "/Volumes/TradingData/lake"
OPEN_MIN = 9 * 60 + 15
N_BARS = 375  # 09:15 .. 15:29
LAST_OUTCOME_COL = 15 * 60 + 14 - OPEN_MIN  # 15:14, the last bar the rest-of-day range reads
CHECKS = {"1030": 10 * 60 + 30, "1100": 11 * 60, "1200": 12 * 60}
PATH_STEP = 15
ATR_DAYS = 14
DTE_CAP = 7
K = 20


def con():
    import duckdb

    c = duckdb.connect()
    c.execute("SET TimeZone='Asia/Kolkata'")
    return c


@dataclass
class Grid:
    days: list[str]
    O: np.ndarray  # noqa: E741  days x 375 (a missing minute carries the last close forward)
    H: np.ndarray
    L: np.ndarray
    C: np.ndarray
    full: np.ndarray  # bool: the session has real bars through 15:14


def load_grid(c, symbol: str, start: str = "2015-01-01") -> Grid:
    """Days x 375 minute grid of one index; a day with no 09:15 bar is dropped."""
    df = c.execute(
        f"""select date::varchar d, ((epoch(ts) + 19800)::BIGINT % 86400) / 60 - {OPEN_MIN} j,
                   open, high, low, close
            from read_parquet('{LAKE}/bars_1m/asset=index/symbol={symbol}/**/*.parquet',
                              hive_partitioning=true)
            where date >= '{start}' order by 1, 2"""
    ).df()
    df = df[(df.j >= 0) & (df.j < N_BARS)]
    first = df.groupby("d").j.min()
    keep = first[first == 0].index
    df = df[df.d.isin(keep)]
    days = sorted(keep)
    row = pd.Series(np.arange(len(days)), index=days)[df.d].to_numpy()
    col = df.j.to_numpy().astype(int)
    arr = {}
    for k in ("open", "high", "low", "close"):
        a = np.full((len(days), N_BARS), np.nan)
        a[row, col] = df[k].to_numpy()
        arr[k] = a
    C = pd.DataFrame(arr["close"]).ffill(axis=1).to_numpy()
    O, H, L = (np.where(np.isnan(arr[k]), C, arr[k]) for k in ("open", "high", "low"))  # noqa: E741
    full = ~np.isnan(arr["close"][:, LAST_OUTCOME_COL])
    return Grid(days, O, H, L, C, full)


def atr_pct(g: Grid) -> np.ndarray:
    """Mean true range of the previous 14 completed sessions / the previous close (NaN early)."""
    dH, dL, dC = g.H.max(1), g.L.min(1), g.C[:, -1]
    pC = np.r_[np.nan, dC[:-1]]
    tr = np.maximum.reduce([dH - dL, np.abs(dH - pC), np.abs(dL - pC)])
    out = np.full(len(g.days), np.nan)
    for i in range(ATR_DAYS + 1, len(g.days)):
        out[i] = np.nanmean(tr[i - ATR_DAYS : i]) / dC[i - 1]
    return out


def path_cols(check_min: int) -> list[int]:
    """Grid columns whose close is "the close at" 09:30, 09:45 .. T: the bar stamped one minute
    earlier, complete at that time."""
    return [t - OPEN_MIN - 1 for t in range(OPEN_MIN + PATH_STEP, check_min + 1, PATH_STEP)]


def day_features(
    o: np.ndarray,
    h: np.ndarray,
    low: np.ndarray,
    c: np.ndarray,
    check_min: int,
    atr: float,
    prev_close: float,
    vix_c: np.ndarray | None,
    vix_open: float | None,
    dte: float,
) -> dict[str, float]:
    """The registered day vector at T from one day's minute rows (and VIX's). Reads columns < j."""
    j = check_min - OPEN_MIN
    o, h, low, c = o[:j], h[:j], low[:j], c[:j]  # nothing at or after T is in scope below
    open_ = o[0]
    out: dict[str, float] = {}
    for n, col in enumerate(path_cols(check_min)):
        out[f"p{n}"] = np.log(c[col] / open_) / atr
    out["gap"] = np.log(open_ / prev_close) / atr
    out["rsf"] = (h.max() - low.min()) / open_ / atr
    if vix_c is not None and vix_open is not None:
        out["vix"] = float(vix_c[j - 1])
        out["vix_chg"] = float(np.log(vix_c[j - 1] / vix_open))
    else:
        out["vix"] = out["vix_chg"] = np.nan
    out["dte"] = float(min(dte, DTE_CAP))
    return out


def outcome(h: np.ndarray, low: np.ndarray, c: np.ndarray, check_min: int) -> float:
    """Rest-of-day range: highest high - lowest low over T .. 15:14, / the close just before T."""
    j = check_min - OPEN_MIN
    return float(
        (h[j : LAST_OUTCOME_COL + 1].max() - low[j : LAST_OUTCOME_COL + 1].min()) / c[j - 1]
    )


def feature_names(check: str) -> list[str]:
    n = len(path_cols(CHECKS[check]))
    return [f"p{i}" for i in range(n)] + ["gap", "rsf", "vix", "vix_chg", "dte"]


# ---- neighbours -------------------------------------------------------------------------------


def zscore(pool: np.ndarray, x: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Pool and query standardised with the pool's own mean / sd (earlier days only)."""
    mu, sd = pool.mean(0), pool.std(0)
    sd = np.where(sd > 0, sd, 1.0)
    return (pool - mu) / sd, (x - mu) / sd


def euclid(pool_z: np.ndarray, x_z: np.ndarray) -> np.ndarray:
    return np.sqrt(((pool_z - x_z) ** 2).sum(1))


def dtw_band1(pool_path: np.ndarray, x_path: np.ndarray) -> np.ndarray:
    """Squared-error DTW distance of each pool row to x, warping window +-1 step (vectorised over
    the pool)."""
    n = x_path.shape[0]
    big = np.inf
    D = np.full((pool_path.shape[0], n + 1, n + 1), big)
    D[:, 0, 0] = 0.0
    for a in range(1, n + 1):
        for b in range(max(1, a - 1), min(n, a + 1) + 1):
            cost = (pool_path[:, b - 1] - x_path[a - 1]) ** 2
            D[:, a, b] = cost + np.minimum.reduce(
                [D[:, a - 1, b], D[:, a, b - 1], D[:, a - 1, b - 1]]
            )
    return D[:, n, n]


def distances(pool_z: np.ndarray, x_z: np.ndarray, n_path: int, variant: str) -> np.ndarray:
    """`euclid`: every standardised feature, equal weight. `dtw`: DTW on the path block plus squared
    Euclidean on the context block."""
    if variant == "euclid":
        return euclid(pool_z, x_z)
    if variant == "dtw":
        ctx = ((pool_z[:, n_path:] - x_z[n_path:]) ** 2).sum(1)
        return np.sqrt(dtw_band1(pool_z[:, :n_path], x_z[:n_path]) + ctx)
    raise ValueError(variant)


def nearest(pool: np.ndarray, x: np.ndarray, n_path: int, variant: str, k: int = K) -> np.ndarray:
    """Indexes (into `pool`) of the k nearest rows to x. Ties break toward the earlier row."""
    pz, xz = zscore(pool, x)
    d = distances(pz, xz, n_path, variant)
    return np.argsort(d, kind="stable")[:k]
