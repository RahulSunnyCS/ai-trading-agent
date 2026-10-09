"""BL-057: apply the pre-registered daily rule to one day, then backtest the picks.

The scoring and selection are rotate.py's own `score_day` and `select_picks`, so this cannot drift
from the research run, and it takes the same settings (--min-wide, --core, --buy-max; the defaults
are the BL-057 first block: 5 core lots, at least 2 Widesl, up to 2 Buy). Scores use only days
before DAY plus DAY's own weekday, days to expiry and 09:15 VIX open. Needs DAY's data in the lake
(INDIAVIX bars, derived contracts) and the per-day results of earlier days in research/bl054 and
research/bl056 (the nightly update will provide them; see BL-058).

    uv run --with pandas --with numpy --with duckdb python research/bl057/today.py 2026-10-09
    uv run --with pandas --with numpy --with duckdb python research/bl057/today.py --basket DRB-6W2 2026-10-09
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
sys.path.insert(0, str(HERE.parent / "common"))
import varlib  # noqa: E402


def _one(con, sql: str, what: str):
    try:
        value = con.sql(sql).fetchone()[0]
    except duckdb.IOException as error:
        raise SystemExit(f"{what}: not in the lake yet ({error})") from error
    if value is None:
        raise SystemExit(f"{what}: no rows")
    return value


def day_attributes(day: pd.Timestamp) -> dict:
    con = duckdb.connect()
    # hour(ts)/minute(ts) on a TIMESTAMPTZ read the session zone: pin it to the exchange's
    con.execute("SET TimeZone='Asia/Kolkata'")
    vix = _one(
        con,
        f"""select arg_min(open, ts)
            from read_parquet('{LAKE}/bars_1m/asset=index/symbol=INDIAVIX/date={day.date()}/*.parquet')
            where hour(ts) * 60 + minute(ts) >= 555""",
        f"INDIAVIX bars for {day.date()}",
    )
    out = {
        "weekday": day.day_name()[:3],
        "vix_open": vix,
        "vix_band": str(pd.cut([vix], R.A.VIX_BINS, labels=R.A.VIX_LABELS)[0]),
    }
    for u, key in (("NIFTY", "dte_N"), ("SENSEX", "dte_S")):
        exp = _one(
            con,
            f"""select min(expiry)
                from read_parquet('{LAKE}/derived/contracts_daily/underlying={u}/date={day.date()}/*.parquet')
                where expiry >= DATE '{day.date()}' and bars > 0""",
            f"{u} contracts for {day.date()}",
        )
        d = (pd.Timestamp(exp) - day).days
        out[key] = str(d) if d <= 6 else "7+"
        out[key + "_expiry"] = exp
    return out


def backtest_one_day(name: str, day: date) -> float:
    from option_backtesting.fyers.daily import data_dir
    from option_backtesting.legwise.engine import run_legwise
    from option_backtesting.legwise.schema import load_legwise

    path = varlib.variant_file(name, "variants")
    skipped: dict = {}
    res = run_legwise(load_legwise(path), data_dir(), day, day, skipped=skipped)
    if not res:
        raise SystemExit(f"{name}: no result for {day} ({skipped})")
    return res[0].gross - res[0].costs


def main() -> None:
    day = pd.Timestamp([a for a in sys.argv[1:] if not a.startswith("--") and "-" in a][0])
    P, f = R.load_all()
    keep = P.index < day
    P, f = P[keep], f[keep]
    att = day_attributes(day)
    print(
        f"\n{day.date()} ({att['weekday']}): VIX open {att['vix_open']:.2f} -> band {att['vix_band']}; "
        f"NIFTY expiry {att['dte_N_expiry']} (dte {att['dte_N']}), SENSEX expiry {att['dte_S_expiry']} "
        f"(dte {att['dte_S']}); history {len(P)} days to {P.index[-1].date()}"
    )
    print(f"settings: core {R.CORE}, at least {R.MIN_WIDE} Widesl, up to {R.BUY_MAX} Buy")
    if (day - P.index[-1]).days > 4:
        print(
            f"WARNING: results end {P.index[-1].date()}; days since then are missing from the scores"
        )

    names = list(P.columns)
    # the day itself joins the history as the last row: its results are unknown (zeros, never
    # read by score_day), its weekday / VIX band / days to expiry are known
    row = {k: att[k] for k in ("weekday", "vix_band", "dte_N", "dte_S")}
    f_ext = pd.concat([f[list(row)], pd.DataFrame([row], index=[day])])
    Pv = np.vstack([P.to_numpy(), np.zeros((1, len(names)))])
    wd, vb, dte = R.day_inputs(f_ext, names)
    crit, comp = R.score_day(Pv, wd, vb, dte, len(P))
    ranks = {k: R.pct_rank(v) for k, v in crit.items()}
    core, _, buy, _ = R.select_picks(comp, names, R.variant_masks(names))

    print("\ntop 12 by composite (percentile ranks: recent / weekday / dte / vix):")
    for v in sorted(range(len(names)), key=lambda v: -comp[v])[:12]:
        tag = "CORE" if v in core else ("BUY" if v in buy else "")
        print(
            f"  {names[v]:14s} {comp[v]:.3f}  {ranks['recent'][v]:.2f} {ranks['weekday'][v]:.2f} "
            f"{ranks['dte'][v]:.2f} {ranks['vix'][v]:.2f}  {tag}"
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
