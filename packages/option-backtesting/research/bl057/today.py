"""BL-057: apply the pre-registered daily rule (case A + Buy add-on) to one day, then backtest the picks.

Scores use only days before DAY (plus DAY's weekday, days to expiry and 09:15 VIX open), exactly as
rotate.py does inside its loop. Needs DAY's data in the lake for the VIX open, the expiries and
the result.

    uv run --with pandas --with numpy --with duckdb python research/bl057/today.py 2026-10-09
"""

from __future__ import annotations

import sys
from datetime import date
from pathlib import Path

import duckdb
import numpy as np
import pandas as pd

HERE = Path(__file__).parent
sys.path.insert(0, str(HERE))
import rotate as R  # noqa: E402

LAKE = "/Volumes/TradingData/lake"
VARIANTS = {"N_": HERE.parent / "bl054" / "variants", "S_": HERE.parent / "bl056" / "variants"}


def day_attributes(day: pd.Timestamp) -> dict:
    con = duckdb.connect()
    vix = con.sql(f"""select arg_min(open, ts) from read_parquet('{LAKE}/bars_1m/asset=index/symbol=INDIAVIX/date={day.date()}/*.parquet')
                      where hour(ts) * 60 + minute(ts) >= 555""").fetchone()[0]
    out = {
        "weekday": day.day_name()[:3],
        "vix_open": vix,
        "vix_band": str(pd.cut([vix], R.A.VIX_BINS, labels=R.A.VIX_LABELS)[0]),
    }
    for u, key in (("NIFTY", "dte_N"), ("SENSEX", "dte_S")):
        exp = con.sql(f"""select min(expiry) from read_parquet('{LAKE}/derived/contracts_daily/underlying={u}/date={day.date()}/*.parquet')
                          where expiry >= DATE '{day.date()}' and bars > 0""").fetchone()[0]
        d = (pd.Timestamp(exp) - day).days
        out[key] = str(d) if d <= 6 else "7+"
        out[key + "_expiry"] = exp
    return out


def score(P: pd.DataFrame, f: pd.DataFrame, att: dict):
    names = list(P.columns)
    Pv = P.to_numpy()
    n = len(P)
    is_nifty = np.array([c.startswith("N_") for c in names])

    def fit(match: np.ndarray) -> np.ndarray:  # match: history days x variants
        num = np.zeros(66)
        den = np.zeros(66)
        for k, w in R.LOOKBACKS:
            m = match[n - k : n]
            cnt = m.sum(axis=0)
            avg = np.where(cnt > 0, (Pv[n - k : n] * m).sum(axis=0) / np.maximum(cnt, 1), 0.0)
            num += w * avg * (cnt > 0)
            den += w * (cnt > 0)
        return np.where(den > 0, num / np.maximum(den, 1e-12), 0.0)

    dte_hist = np.where(is_nifty[None, :], f.dte_N.to_numpy()[:, None], f.dte_S.to_numpy()[:, None])
    dte_today = np.where(is_nifty, att["dte_N"], att["dte_S"])
    crit = {
        "recent": (2 / 3) * Pv[n - 5 : n].sum(axis=0) + (1 / 3) * Pv[n - 10 : n - 5].sum(axis=0),
        "weekday": fit((f.weekday.to_numpy()[:, None] == att["weekday"]).repeat(66, axis=1)),
        "dte": fit(dte_hist == dte_today[None, :]),
        "vix": fit(
            (f.vix_band.astype(str).to_numpy()[:, None] == att["vix_band"]).repeat(66, axis=1)
        ),
    }
    ranks = {k: R.pct_rank(v) for k, v in crit.items()}
    comp = sum(R.W_CRIT[k] * ranks[k] for k in R.W_CRIT)
    return names, comp, ranks


def select(names, comp):
    fam = [c.split("_")[1] for c in names]
    pool = [i for i in range(66) if fam[i] != "buy"]
    order = sorted(pool, key=lambda v: (-comp[v], names[v]))
    core = order[: R.CORE]
    n_wide = sum(fam[v] == "wide" for v in core)
    while n_wide < 2:
        drop = min((v for v in core if fam[v] == "dir"), key=lambda v: (comp[v], names[v]))
        core.remove(drop)
        core.append(next(v for v in order if fam[v] == "wide" and v not in core))
        n_wide += 1
    top10 = sorted(range(66), key=lambda v: (-comp[v], names[v]))[: R.BUY_TOP]
    buy = [v for v in top10 if fam[v] == "buy"][: R.BUY_MAX]
    return core, buy


def backtest_one_day(name: str, day: date) -> float:
    from option_backtesting.fyers.daily import data_dir
    from option_backtesting.legwise.engine import run_legwise
    from option_backtesting.legwise.schema import load_legwise

    path = VARIANTS[name[:2]] / f"{name[2:]}.yaml"
    res = run_legwise(load_legwise(path), data_dir(), day, day, skipped=(sk := {}))
    if not res:
        raise SystemExit(f"{name}: no result for {day} ({sk})")
    return res[0].gross - res[0].costs


def main() -> None:
    day = pd.Timestamp(sys.argv[1])
    P, f = R.load_all()
    hist = P.index < day
    P, f = P[hist], f[hist]
    att = day_attributes(day)
    print(
        f"\n{day.date()} ({att['weekday']}): VIX open {att['vix_open']:.2f} -> band {att['vix_band']}; "
        f"NIFTY expiry {att['dte_N_expiry']} (dte {att['dte_N']}), SENSEX expiry {att['dte_S_expiry']} (dte {att['dte_S']}); "
        f"history {len(P)} days to {P.index[-1].date()}"
    )
    names, comp, ranks = score(P, f, att)
    core, buy = select(names, comp)
    order = sorted(range(66), key=lambda v: -comp[v])
    print("\ntop 12 by composite (percentile ranks: recent / weekday / dte / vix):")
    for v in order[:12]:
        tag = "CORE" if v in core else ("BUY" if v in buy else "")
        print(
            f"  {names[v]:14s} {comp[v]:.3f}  {ranks['recent'][v]:.2f} {ranks['weekday'][v]:.2f} {ranks['dte'][v]:.2f} {ranks['vix'][v]:.2f}  {tag}"
        )
    picks = [names[v] for v in core + buy]
    print("\npicks:", ", ".join(picks))
    total = 0.0
    print("\nresult (1 lot each, before charges):")
    for p in picks:
        pnl = backtest_one_day(p, day.date())
        total += pnl
        print(f"  {p:14s} {pnl:>9,.0f}")
    print(f"  {'TOTAL':14s} {total:>9,.0f}")


if __name__ == "__main__":
    main()
