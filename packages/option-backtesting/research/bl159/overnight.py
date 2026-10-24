"""BL-159 read 4: the overnight ATM short straddle from the 5-minute chain snapshots.

Sell the ATM CE + PE (offset 0) of the nearest expiry with dte >= 1 at the close of day d's 15:25 bucket;
buy back at the close of the next session's 09:20 bucket (the same strike and expiry); one lot, four orders,
BL-063 charges. Writes out/overnight.csv, one row per night.

    uv run python research/bl159/overnight.py
"""

from __future__ import annotations

import os
import sys
from datetime import date
from pathlib import Path

import duckdb
import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "src"))
from option_backtesting.ruletest.charges import day_charges  # noqa: E402

START, END = date(2024, 10, 9), date(2026, 10, 8)
LOT = 65  # NIFTY, lot_sizing current at the rotation's sizing date 2026-10-12
OUT = Path(__file__).resolve().parent / "out"


def main() -> int:
    R = Path(os.environ.get("TRADING_DATA_ROOT", str(Path.home() / "TradingData")))
    con = duckdb.connect()
    con.execute("SET TimeZone='Asia/Kolkata'")
    rows = con.execute(
        f"""select date, strftime(bucket,'%H:%M') hm, expiry, dte, strike, option_type, "offset", open, close,
                   spot_open, spot_close
            from read_parquet('{R}/lake/derived/chain_snapshots_5m/underlying=NIFTY/*/data.parquet', hive_partitioning=1)
            where date between '{START}' and '{END}' and strftime(bucket,'%H:%M') in ('15:25','09:15','09:20')
              and abs("offset") <= 10"""
    ).df()
    rows["date"] = pd.to_datetime(rows["date"]).dt.date
    rows["expiry"] = pd.to_datetime(rows["expiry"]).dt.date
    days = sorted(rows["date"].unique())
    by_day = {d: g for d, g in rows.groupby("date")}
    out, skipped = [], {}
    for i, d in enumerate(days[:-1]):
        nxt = days[i + 1]
        g = by_day[d]
        entry = g[(g["hm"] == "15:25") & (g["offset"] == 0) & (g["dte"] >= 1)]
        if entry.empty:
            skipped[d] = "no 15:25 ATM row with dte >= 1"
            continue
        e = entry["expiry"].min()
        entry = entry[entry["expiry"] == e]
        if len(entry) != 2 or entry["close"].isna().any():
            skipped[d] = "entry legs incomplete"
            continue
        k = entry["strike"].iloc[0]
        n = by_day[nxt]
        exit_ = n[(n["hm"] == "09:20") & (n["expiry"] == e) & (n["strike"] == k)]
        open_ = n[(n["hm"] == "09:15") & (n["expiry"] == e) & (n["strike"] == k)]
        if len(exit_) != 2 or exit_["close"].isna().any():
            skipped[d] = "exit legs missing next session"
            continue
        sell_value = float(entry["close"].sum()) * LOT
        buy_value = float(exit_["close"].sum()) * LOT
        gross = sell_value - buy_value
        ch = day_charges("NIFTY", nxt.isoformat(), 4, buy_value, sell_value)
        spot_in = float(entry["spot_close"].iloc[0])
        spot_open = float(n[n["hm"] == "09:15"]["spot_open"].iloc[0]) if (n["hm"] == "09:15").any() else np.nan
        out.append(
            {
                "day": d, "next": nxt, "weekday": d.strftime("%a"), "expiry": e, "dte": int(entry["dte"].iloc[0]),
                "strike": k, "straddle_in": float(entry["close"].sum()), "straddle_out": float(exit_["close"].sum()),
                "straddle_open_next": float(open_["open"].sum()) if len(open_) == 2 and open_["open"].notna().all() else np.nan,
                "gross": round(gross, 2), "charges": round(ch.total, 2), "net": round(gross - ch.total, 2),
                "spot_in": spot_in, "spot_open_next": spot_open,
                "gap_pct": round((spot_open / spot_in - 1) * 100, 3) if spot_open == spot_open else np.nan,
            }
        )
    OUT.mkdir(exist_ok=True)
    df = pd.DataFrame(out)
    df.to_csv(OUT / "overnight.csv", index=False)
    print(f"{len(df)} nights, {len(skipped)} skipped -> {OUT / 'overnight.csv'}")
    if skipped:
        reasons = pd.Series(list(skipped.values())).value_counts()
        print(reasons.to_string())
    print(df[["gross", "charges", "net", "gap_pct"]].describe().round(1))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
