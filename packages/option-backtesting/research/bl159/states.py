"""BL-159 reads 1, 2a, 3, 5, 8: one row per trading day with every state, group and the stored gross
of the base strategies. Writes out/states.csv. Reads nothing after the entry minute of the day it labels:
iv_daily values are the PREVIOUS session's, PCR is the previous session's, groups are calendar facts.

    uv run python research/bl159/states.py
"""

from __future__ import annotations

import csv
import os
import sys
from datetime import date
from pathlib import Path

import duckdb
import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent))
from events import EVENTS, GROUP_NAMES, groups  # noqa: E402

START, END = date(2024, 10, 9), date(2026, 10, 8)
OUT = Path(__file__).resolve().parent / "out"
STRATEGIES = {"wide": "results/N_wide_0917.csv", "dir": "base/N_dir_atm_0924.csv", "dir1002": "results/N_dir_1002.csv"}


def root() -> Path:
    return Path(os.environ.get("TRADING_DATA_ROOT", str(Path.home() / "TradingData")))


def read_gross(path: Path) -> dict[date, float]:
    with path.open() as f:
        return {date.fromisoformat(r["day"]): float(r["gross"]) for r in csv.DictReader(f)}


def main() -> int:
    R = root()
    lake = R / "lake"
    con = duckdb.connect()
    con.execute("SET TimeZone='Asia/Kolkata'")
    days_csv = pd.read_csv(R / "rotation/days.csv", parse_dates=["day"])
    days_csv["day"] = days_csv["day"].dt.date
    days = sorted(d for d in days_csv["day"] if START <= d <= END)
    frame = pd.DataFrame({"day": days}).merge(days_csv, on="day", how="left")

    for name, rel in STRATEGIES.items():
        g = read_gross(R / "rotation" / rel)
        frame[f"gross_{name}"] = [g.get(d, np.nan) for d in days]

    # previous-session states from iv_daily (built at 15:00 of its own day)
    iv = con.execute(
        f"""select trading_day, front_iv_1500, skew_1500, spot_close
            from read_parquet('{lake}/derived/iv_daily/underlying=NIFTY/data.parquet')
            where expiry_rank = 0 and trading_day between '2024-08-01' and '{END}' order by trading_day"""
    ).df()
    iv["trading_day"] = pd.to_datetime(iv["trading_day"]).dt.date
    iv["logret"] = np.log(iv["spot_close"]).diff()
    iv["rv10"] = iv["logret"].rolling(10).std() * np.sqrt(252) * 100
    iv["iv_front"] = iv["front_iv_1500"] * 100
    iv["vrp"] = iv["iv_front"] - iv["rv10"]
    prev = iv.set_index("trading_day")[["vrp", "iv_front", "rv10", "skew_1500"]].shift(1)
    # shift(1) in row order = the previous trading session's values
    frame = frame.merge(prev, left_on="day", right_index=True, how="left")

    # previous session's put/call volume ratio, nearest expiry
    pcr = con.execute(
        f"""with v as (
              select date, expiry, option_type, sum(volume) vol
              from read_parquet('{lake}/bars_1m/asset=option/underlying=NIFTY/*/data.parquet', hive_partitioning=1)
              where date between '2024-09-01' and '{END}' group by 1, 2, 3),
            front as (select date, min(expiry) expiry from v where expiry >= date group by 1)
            select v.date, sum(case when option_type='PE' then vol end) / nullif(sum(case when option_type='CE' then vol end), 0) pcr
            from v join front using (date, expiry) group by 1 order by 1"""
    ).df()
    pcr["date"] = pd.to_datetime(pcr["date"]).dt.date
    pcr = pcr.set_index("date")["pcr"].shift(1)
    frame["pcr"] = [pcr.get(d, np.nan) for d in days]

    # the 09:20 ATM straddle's decay to 15:25, front expiry, same strike (read 1's mechanism check)
    chain = con.execute(
        f"""select date, strftime(bucket,'%H:%M') hm, expiry, dte, strike, option_type, "offset", close
            from read_parquet('{lake}/derived/chain_snapshots_5m/underlying=NIFTY/*/data.parquet', hive_partitioning=1)
            where date between '{START}' and '{END}' and strftime(bucket,'%H:%M') in ('09:20','15:25')
              and abs("offset") <= 8 and dte >= 0"""
    ).df()
    chain["date"] = pd.to_datetime(chain["date"]).dt.date
    decay = {}
    for d, g in chain.groupby("date"):
        front = g[g["dte"] == g["dte"].min()]
        at = front[(front["hm"] == "09:20") & (front["offset"] == 0)]
        if len(at) != 2:
            continue
        k = at["strike"].iloc[0]
        s0 = at["close"].sum()
        end = front[(front["hm"] == "15:25") & (front["strike"] == k)]
        if len(end) != 2 or s0 <= 0:
            continue
        decay[d] = (s0 - end["close"].sum()) / s0 * 100
    frame["straddle_decay_pct"] = [decay.get(d, np.nan) for d in days]

    # terciles (over the days with a value)
    for col in ("vrp", "skew_1500", "pcr"):
        q = frame[col].quantile([1 / 3, 2 / 3])
        frame[f"{col}_tercile"] = np.where(
            frame[col].isna(), "", np.where(frame[col] <= q.iloc[0], "low", np.where(frame[col] > q.iloc[1], "high", "mid"))
        )

    # events and groups
    for name, dates in EVENTS.items():
        s = {date.fromisoformat(x) for x in dates}
        frame[f"ev_{name}"] = [d in s for d in days]
    expiries = con.execute(
        f"select distinct expiry from read_parquet('{lake}/derived/iv_daily/underlying=NIFTY/data.parquet') where expiry_rank = 0"
    ).df()["expiry"]
    weekly = {pd.Timestamp(e).date() for e in expiries}
    gmap = groups(days, weekly)
    for g in GROUP_NAMES:
        frame[f"grp_{g}"] = [g in gmap[d] for d in days]

    OUT.mkdir(exist_ok=True)
    frame.to_csv(OUT / "states.csv", index=False)
    print(f"{len(frame)} days -> {OUT / 'states.csv'}")
    print(frame[["vrp", "skew_1500", "pcr", "straddle_decay_pct"]].describe().round(2))
    print({g: int(frame[f'grp_{g}'].sum()) for g in GROUP_NAMES}, {k: int(frame[f'ev_{k}'].sum()) for k in EVENTS})
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
