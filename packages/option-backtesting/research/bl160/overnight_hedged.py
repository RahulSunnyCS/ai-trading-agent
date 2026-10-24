"""BL-160: the overnight short straddle into expiry morning, hedged and not, NIFTY and SENSEX, four exit
minutes, from the lake's 1-minute bars. Definitions: backlog/BL-160-overnight-straddle-into-expiry.md.
Writes out/nights.csv (one row per index x night x hedge x exit) and prints the registered tables.

    uv run python research/bl160/overnight_hedged.py
"""

from __future__ import annotations

import os
import sys
from bisect import bisect_left, bisect_right
from datetime import date
from pathlib import Path

import numpy as np
import pandas as pd
import pyarrow.parquet as pq

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "src"))
from trading_data import lake, quality  # noqa: E402

from option_backtesting.ruletest.charges import day_charges  # noqa: E402

STEP = {"NIFTY": 50, "SENSEX": 100}
LOT = {"NIFTY": 65, "SENSEX": 20}  # lot_sizing current (sizing date 2026-10-12)
WING = 6
ENTRY = 15 * 60 + 25
EXITS = {"0915": None, "0917": 9 * 60 + 17, "0920": 9 * 60 + 20, "0924": 9 * 60 + 24}
OPEN_MIN = 9 * 60 + 15
FIRST, LAST = date(2022, 1, 3), date(2026, 10, 8)
LEARN = (date(2024, 10, 9), date(2026, 10, 8))
CONFIRM = {"NIFTY": (date(2022, 1, 3), date(2024, 10, 8)), "SENSEX": (date(2023, 7, 26), date(2024, 10, 8))}
SLIPS = (0.0, 0.005, 0.01)
OUT = Path(__file__).resolve().parent / "out"


def _dates(folder: Path) -> list[date]:
    return sorted(date.fromisoformat(p.name[5:]) for p in folder.glob("date=*") if (p / "data.parquet").exists())


def _minutes(ts: pd.Series) -> np.ndarray:
    local = pd.to_datetime(ts, utc=True).dt.tz_convert("Asia/Kolkata")
    return (local.dt.hour * 60 + local.dt.minute).to_numpy()


def load_option(root: Path, u: str, d: date) -> pd.DataFrame | None:
    path = lake.bars_1m_path(root, "option", u, d)
    if not path.exists():
        return None
    df = pq.read_table(path, columns=["ts", "expiry", "strike", "option_type", "open", "close"]).to_pandas()
    df["m"] = _minutes(df["ts"])
    df = df[((df.m >= ENTRY - 11) & (df.m < ENTRY)) | ((df.m >= OPEN_MIN) & (df.m < 9 * 60 + 24))]
    df["expiry"] = pd.to_datetime(df["expiry"]).dt.date
    return df


def spot_at(root: Path, u: str, d: date, minute: int) -> float | None:
    path = lake.bars_1m_path(root, "index", u, d)
    if not path.exists():
        return None
    df = pq.read_table(path, columns=["ts", "close"]).to_pandas()
    df["m"] = _minutes(df["ts"])
    w = df[(df.m >= minute - 10) & (df.m < minute)].sort_values("m")
    return float(w["close"].iloc[-1]) if len(w) else None


def price(df: pd.DataFrame, expiry: date, strike: float, ot: str, minute: int | None) -> float | None:
    leg = df[(df.expiry == expiry) & (df.strike == strike) & (df.option_type == ot)]
    if minute is None:  # the 09:15 open
        b = leg[leg.m == OPEN_MIN]
        return float(b["open"].iloc[0]) if len(b) and b["open"].iloc[0] > 0 else None
    w = leg[(leg.m >= minute - 10) & (leg.m < minute)].sort_values("m")
    return float(w["close"].iloc[-1]) if len(w) and w["close"].iloc[-1] > 0 else None


def run_index(root: Path, u: str) -> list[dict]:
    idx_days = _dates(lake.bars_1m_path(root, "index", u, FIRST).parent.parent)
    opt_days = set(_dates(lake.bars_1m_path(root, "option", u, FIRST).parent.parent))
    excluded = set((quality.excluded_days(root, "option", u) or {}).keys())
    days = [d for d in idx_days if d >= FIRST]
    rows: list[dict] = []
    cache: dict[date, pd.DataFrame | None] = {}

    def opt(d: date) -> pd.DataFrame | None:
        if d not in cache:
            cache.clear() if len(cache) > 4 else None
            cache[d] = load_option(root, u, d) if d in opt_days else None
        return cache[d]

    for i, d in enumerate(days[:-1]):
        if d > LAST:
            break
        nxt = days[i + 1]
        base = {"index": u, "day": d, "next": nxt}
        if d in excluded or nxt in excluded:
            rows.append({**base, "skip": "excluded day"})
            continue
        a, b = opt(d), opt(nxt)
        spot = spot_at(root, u, d, ENTRY)
        if a is None or b is None or spot is None:
            rows.append({**base, "skip": "no data"})
            continue
        later = sorted(e for e in a["expiry"].unique() if e > d)
        if not later:
            rows.append({**base, "skip": "no expiry after d"})
            continue
        expiry = later[0]
        step = STEP[u]
        atm = round(spot / step) * step
        dte = bisect_right(days, expiry) - bisect_left(days, nxt) - 1
        legs = {"ce": (atm, "CE", -1), "pe": (atm, "PE", -1), "ce_w": (atm + WING * step, "CE", 1),
                "pe_w": (atm - WING * step, "PE", 1)}
        entry = {k: price(a, expiry, s, ot, ENTRY) for k, (s, ot, _) in legs.items()}
        for hedge, names in (("none", ("ce", "pe")), ("h6", ("ce", "pe", "ce_w", "pe_w"))):
            for ex, minute in EXITS.items():
                row = {**base, "hedge": hedge, "exit": ex, "expiry": expiry, "dte_exit": dte, "atm": atm, "skip": ""}
                exit_ = {k: price(b, expiry, legs[k][0], legs[k][1], minute) for k in names}
                if any(entry[k] is None for k in names) or any(v is None for v in exit_.values()):
                    rows.append({**row, "skip": "leg price missing"})
                    continue
                lot = LOT[u]
                for s in SLIPS:
                    gross, buy, sell = 0.0, 0.0, 0.0
                    for k in names:
                        side = legs[k][2]  # -1 sold at entry, +1 bought at entry
                        pin = entry[k] * (1 + side * s)
                        pout = exit_[k] * (1 - side * s)
                        gross += side * (pout - pin) * lot
                        if side < 0:
                            sell, buy = sell + pin * lot, buy + pout * lot
                        else:
                            buy, sell = buy + pin * lot, sell + pout * lot
                    ch = day_charges(u, nxt.isoformat(), 2 * len(names), buy, sell).total
                    tag = "" if s == 0 else f"_s{int(s * 1000):03d}"
                    row[f"gross{tag}"] = round(gross, 2)
                    row[f"net{tag}"] = round(gross - ch, 2)
                    if s == 0:
                        row["charges"] = round(ch, 2)
                        row["straddle_in"] = entry["ce"] + entry["pe"]
                rows.append(row)
        if i % 100 == 0:
            print(f"{u} {d}", flush=True)
    return rows


def period(r: pd.Series) -> str:
    if LEARN[0] <= r["day"] <= LEARN[1]:
        return "learn"
    c = CONFIRM[r["index"]]
    return "confirm" if c[0] <= r["day"] <= c[1] else ""


def tstat(x: pd.Series) -> float:
    x = x.dropna()
    return float(x.mean() / (x.std(ddof=1) / np.sqrt(len(x)))) if len(x) > 1 and x.std(ddof=1) > 0 else np.nan


def maxdd(x: pd.Series) -> float:
    c = x.cumsum().to_numpy()
    return float((c - np.maximum.accumulate(np.concatenate([[0.0], c]))[1:]).min()) if len(c) else 0.0


def summary(df: pd.DataFrame, keys: list[str]) -> pd.DataFrame:
    g = df.groupby(keys)
    return pd.DataFrame({
        "nights": g["net"].count(), "mean_net": g["net"].mean().round(0), "t": g["net"].apply(tstat).round(2),
        "hit": g["net"].apply(lambda x: (x > 0).mean()).round(2), "worst": g["net"].min().round(0),
        "maxdd": g["net"].apply(maxdd).round(0), "net_s005": g["net_s005"].mean().round(0),
        "net_s010": g["net_s010"].mean().round(0),
    })


def main() -> int:
    root = Path(os.environ.get("TRADING_DATA_ROOT", str(Path.home() / "TradingData")))
    rows = run_index(root, "NIFTY") + run_index(root, "SENSEX")
    df = pd.DataFrame(rows)
    df["period"] = df.apply(period, axis=1)
    df["dte_group"] = np.where(df["dte_exit"] == 0, "DTE0", np.where(df["dte_exit"] == 1, "DTE1", "DTE2+"))
    OUT.mkdir(exist_ok=True)
    df.to_csv(OUT / "nights.csv", index=False)
    ok = df[df["skip"] == ""]
    pd.set_option("display.width", 200)
    skips = df[df["skip"] != ""].groupby(["index", "period", "hedge", "skip"], dropna=False).size()
    print("skips:\n", skips.to_string())
    print("\nLEARNING PERIOD (descriptive):")
    print(summary(ok[ok.period == "learn"], ["index", "dte_group", "hedge", "exit"]).to_string())
    print("\nUNSEEN PERIOD (registered primary = NIFTY DTE0 h6 0917):")
    print(summary(ok[ok.period == "confirm"], ["index", "dte_group", "hedge", "exit"]).to_string())
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
