"""BL-110: does NIFTY's daily range persist? Pre-registered in backlog/BL-110. Read-only: reads
the index 1-minute bars and India VIX from the lake and writes only under this folder.

    TRADING_DATA_ROOT=/Volumes/TradingData uv run python research/bl110/persistence.py
"""

from __future__ import annotations

import json
from datetime import date, timedelta
from pathlib import Path

import duckdb
import numpy as np
from trading_data import lake

from option_backtesting.fyers.daily import data_dir
from option_backtesting.rotation import attrs as attrs_mod

OUT = Path(__file__).parent
START, END = date(2022, 1, 3), date(2026, 10, 15)
SPLIT = date(2024, 10, 8)  # the end of the first sub-period
LOOKBACK = 20
EXPANDED, RANGEBOUND = 1.25, 0.80
BLOCK, RESAMPLES, SEED, LEVEL = 20, 2000, 20261015, 0.90
OPEN_M, OR_END_M, CLOSE_OK_M = 9 * 60 + 15, 9 * 60 + 45, 15 * 60 + 25

SQL = """
WITH b AS (
  SELECT ts, open, high, low,
         hour(ts AT TIME ZONE 'Asia/Kolkata') * 60 + minute(ts AT TIME ZONE 'Asia/Kolkata') AS m
  FROM read_parquet(?)
  WHERE hour(ts AT TIME ZONE 'Asia/Kolkata') * 60 + minute(ts AT TIME ZONE 'Asia/Kolkata')
        BETWEEN 555 AND 929  -- the 09:15 to 15:29 session; pre-open bars are not part of it
)
SELECT min(m), max(m), arg_min(open, ts), max(high), min(low),
       max(high) FILTER (WHERE m < ?), min(low) FILTER (WHERE m < ?),
       max(high) FILTER (WHERE m >= ?), min(low) FILTER (WHERE m >= ?),
       arg_min(open, ts) FILTER (WHERE m >= ?)
FROM b
"""


def sessions(root: Path) -> list[dict]:
    con = duckdb.connect()
    out = []
    d = START
    while d <= END:
        path = lake.bars_1m_path(root, "index", "NIFTY", d)
        if d.weekday() < 5 and path.exists():
            r = con.execute(
                SQL, [str(path), OR_END_M, OR_END_M, OR_END_M, OR_END_M, OR_END_M]
            ).fetchone()
            first, last, o, hi, lo, orh, orl, ah, al, a_open = r
            if (
                first == OPEN_M
                and last >= CLOSE_OK_M
                and None not in (o, hi, lo, orh, orl, ah, al, a_open)
            ):
                vix = attrs_mod.vix_close_from_lake(root, d)
                out.append(
                    {
                        "day": d,
                        "R": (hi - lo) / o * 100,
                        "OR": (orh - orl) / o * 100,
                        "A": (ah - al) / a_open * 100,
                        "vix": vix,
                    }
                )
        d += timedelta(days=1)
    return out


def ranks(x: np.ndarray) -> np.ndarray:
    _, inv, counts = np.unique(x, return_inverse=True, return_counts=True)
    return (np.cumsum(counts) - (counts - 1) / 2)[inv]


def spearman(x: np.ndarray, y: np.ndarray) -> float:
    if len(x) < 5:
        return float("nan")
    return float(np.corrcoef(ranks(x), ranks(y))[0, 1])


def boot_idx(n: int, rng: np.random.Generator) -> np.ndarray:
    nb = -(-n // BLOCK)
    starts = rng.integers(0, n, size=(RESAMPLES, nb))
    return ((starts[:, :, None] + np.arange(BLOCK)[None, None, :]) % n).reshape(RESAMPLES, -1)[
        :, :n
    ]


def interval(stat, n: int, seed_offset: int = 0) -> list[float]:
    """90% circular-block-bootstrap percentile interval of `stat(indices)` over `n` paired rows."""
    if n < 30:
        return [float("nan"), float("nan")]
    idx = boot_idx(n, np.random.default_rng(SEED + seed_offset))
    vals = np.array([stat(i) for i in idx])
    vals = vals[np.isfinite(vals)]
    lo, hi = np.percentile(vals, [(1 - LEVEL) / 2 * 100, (1 + LEVEL) / 2 * 100])
    return [float(lo), float(hi)]


def trailing_median(v: np.ndarray, n: int = LOOKBACK) -> np.ndarray:
    out = np.full(len(v), np.nan)
    for t in range(n, len(v)):
        out[t] = np.median(v[t - n : t])
    return out


def analyse(rows: list[dict], label: str) -> dict:
    """`rows` is the whole sequence; `label` selects the sub-period for the statistics."""
    day = np.array([r["day"] for r in rows])
    R = np.array([r["R"] for r in rows])
    OR = np.array([r["OR"] for r in rows])
    A = np.array([r["A"] for r in rows])
    vix = np.array([np.nan if r["vix"] is None else r["vix"] for r in rows])
    B = trailing_median(R)
    E = R / B
    ORr = OR / trailing_median(OR)
    Ar = A / trailing_median(A)
    if label == "first":
        inside = day <= SPLIT
    elif label == "second":
        inside = day > SPLIT
    else:
        inside = np.ones(len(day), dtype=bool)
    res: dict = {"label": label, "sessions": int((inside & np.isfinite(E)).sum())}

    # 1. autocorrelation of log R
    ac = {}
    logR = np.log(R)
    for lag in (1, 2, 3, 5, 10):
        t = np.array([i for i in range(len(R) - lag) if inside[i]])
        x, y = logR[t], logR[t + lag]
        ac[str(lag)] = {
            "rho": spearman(x, y),
            "ci90": interval(lambda i, x=x, y=y: spearman(x[i], y[i]), len(t), lag),
            "n": int(len(t)),
        }
    res["autocorrelation_log_range"] = ac

    # 2. states and forward ratios
    state = np.where(E >= EXPANDED, 1, np.where(E <= RANGEBOUND, -1, 0))
    st: dict = {}
    for name, code in (("expanded", 1), ("range_bound", -1)):
        ts_ = np.array(
            [i for i in range(len(R) - 5) if inside[i] and np.isfinite(E[i]) and state[i] == code]
        )
        fk = {}
        for k in range(1, 6):
            vals = R[ts_ + k] / B[ts_]
            fk[str(k)] = float(vals.mean())
        valid = np.array([i for i in range(len(R) - 1) if inside[i] and np.isfinite(E[i])])
        same_next = float((state[ts_ + 1] == code).mean())
        base = float((state[valid] == code).mean())
        st[name] = {
            "n": int(len(ts_)),
            "mean_forward_ratio": fk,
            "p_next_same_state": same_next,
            "p_state_overall": base,
        }
    res["states"] = st
    ex = np.array([i for i in range(len(R) - 1) if inside[i] and np.isfinite(E[i])])
    f1 = R[ex + 1] / B[ex]
    sx = state[ex]

    def diff(i):
        a, b = sx[i] == 1, sx[i] == -1
        return f1[i][a].mean() - f1[i][b].mean() if a.any() and b.any() else np.nan

    mean_diff = float(f1[sx == 1].mean() - f1[sx == -1].mean())
    res["f1_expanded_minus_range_bound"] = {"diff": mean_diff, "ci90": interval(diff, len(ex), 11)}

    # 3. opening range -> rest of day
    ok = np.array(
        [i for i in range(len(R)) if inside[i] and np.isfinite(ORr[i]) and np.isfinite(Ar[i])]
    )
    x, y = ORr[ok], Ar[ok]
    cuts = np.percentile(x, [100 / 3, 200 / 3])
    tercile = np.digitize(x, cuts)
    res["opening_range"] = {
        "spearman": spearman(x, y),
        "ci90": interval(lambda i: spearman(x[i], y[i]), len(ok), 13),
        "mean_rest_of_day_ratio_by_opening_tercile": [
            float(y[tercile == k].mean()) for k in range(3)
        ],
        "n": int(len(ok)),
    }

    # 4. VIX control: log R_{t+1} on log R_t (+ log VIX_t)
    rows_ok = np.array(
        [i for i in range(len(R) - 1) if inside[i] and np.isfinite(vix[i]) and vix[i] > 0]
    )
    y = logR[rows_ok + 1]
    xr = logR[rows_ok]
    xv = np.log(vix[rows_ok])

    def ols(X, yy):
        beta, *_ = np.linalg.lstsq(X, yy, rcond=None)
        resid = yy - X @ beta
        return beta, 1 - resid.var() / yy.var()

    one = np.ones_like(xr)
    b1, r1 = ols(np.column_stack([one, xr]), y)
    b2, r2 = ols(np.column_stack([one, xr, xv]), y)

    def coef_with_vix(i):
        return ols(np.column_stack([one[i], xr[i], xv[i]]), y[i])[0][1]

    def coef_alone(i):
        return ols(np.column_stack([one[i], xr[i]]), y[i])[0][1]

    res["vix_control"] = {
        "n": int(len(rows_ok)),
        "coef_log_range_alone": float(b1[1]),
        "coef_log_range_alone_ci90": interval(coef_alone, len(rows_ok), 17),
        "r2_alone": float(r1),
        "coef_log_range_with_vix": float(b2[1]),
        "coef_log_range_with_vix_ci90": interval(coef_with_vix, len(rows_ok), 19),
        "coef_log_vix": float(b2[2]),
        "r2_with_vix": float(r2),
    }
    return res


def verdict(first: dict, second: dict) -> dict:
    ac = [p["autocorrelation_log_range"]["1"]["ci90"][0] > 0 for p in (first, second)]
    gap = [p["f1_expanded_minus_range_bound"]["diff"] >= 0.15 for p in (first, second)]
    vix = [p["vix_control"]["coef_log_range_with_vix_ci90"][0] > 0 for p in (first, second)]
    orr = [p["opening_range"]["ci90"][0] > 0 for p in (first, second)]
    return {
        "range_persists_supported": all(ac) and all(gap),
        "lag1_interval_above_zero_both": all(ac),
        "f1_gap_at_least_0_15_both": all(gap),
        "beyond_vix_supported": all(vix),
        "opening_range_informative_supported": all(orr),
    }


def main() -> None:
    root = data_dir()
    rows = sessions(root)
    first = analyse(rows, "first")
    second = analyse(rows, "second")
    full = analyse(rows, "all")
    report = {
        "sessions": len(rows),
        "from": rows[0]["day"].isoformat(),
        "to": rows[-1]["day"].isoformat(),
        "split": SPLIT.isoformat(),
        "periods": {"first": first, "second": second, "all": full},
        "verdict": verdict(first, second),
        "medians": {
            "day_range_pct": float(np.median([r["R"] for r in rows])),
            "opening_range_pct": float(np.median([r["OR"] for r in rows])),
        },
    }
    (OUT / "persistence_2026-10-15.json").write_text(json.dumps(report, indent=1) + "\n")
    print(json.dumps(report, indent=1))


if __name__ == "__main__":
    main()
