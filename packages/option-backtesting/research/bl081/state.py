"""BL-081: the market state at each checkpoint hour, per index and day, from 1-minute bars <= the hour.

    uv run --with pandas --with numpy --with duckdb python research/bl081/state.py

Writes out/state_raw.csv (one row per day x index x hour: the raw values of every registered variable)
and exposes `labels()` which turns them into the registered bands (backlog/BL-081-...md, Phase 0).

Conventions (BL-081 Log, 2026-10-10): a state "at h" uses bars stamped <= h (complete at h + 1 minute);
nothing later is read (asserted). ATR = mean true range of the previous 14 completed sessions.
"""

from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import pandas as pd

HERE = Path(__file__).parent
OUT = HERE / "out"
LAKE = "/Volumes/TradingData/lake"
HOURS = {"1030": 630, "1130": 690, "1230": 750, "1330": 810, "1430": 870}  # minutes since midnight
OPEN_MIN = 555  # 09:15
N_BARS = 375
START = "2021-09-01"  # history for ATR / terciles before the first period day
STEP = {"NIFTY": 50, "SENSEX": 100}
OPT_START = {"NIFTY": "2022-01-03", "SENSEX": "2024-10-09"}


def _con():
    import duckdb

    con = duckdb.connect()
    con.execute("SET TimeZone='Asia/Kolkata'")
    return con


def load_grid(con, symbol: str) -> tuple[list, dict[str, np.ndarray]]:  # noqa: E741
    """Days x 375 minute grid (09:15..15:29) of open/high/low/close; a missing minute carries the last
    close forward; a day with no 09:15 bar is dropped."""
    df = con.execute(
        f"""select date::varchar d, ((epoch(ts) + 19800)::BIGINT % 86400) / 60 m, open, high, low, close
            from read_parquet('{LAKE}/bars_1m/asset=index/symbol={symbol}/**/*.parquet',
                              hive_partitioning=true)
            where date >= '{START}' order by 1, 2"""
    ).df()
    days, O, H, L, C = [], [], [], [], []  # noqa: E741
    for d, g in df.groupby("d", sort=True):
        m = g.m.to_numpy().astype(int) - OPEN_MIN
        if m.min() != 0:
            continue
        ok = (m >= 0) & (m < N_BARS)
        m = m[ok]
        arr = {}
        for k in ("open", "high", "low", "close"):
            a = np.full(N_BARS, np.nan)
            a[m] = g[k].to_numpy()[ok]
            arr[k] = a
        c = pd.Series(arr["close"]).ffill().to_numpy()
        for k in ("open", "high", "low"):
            arr[k] = np.where(np.isnan(arr[k]), c, arr[k])
        days.append(d)
        O.append(arr["open"])
        H.append(arr["high"])
        L.append(arr["low"])
        C.append(c)
    return days, {"O": np.array(O), "H": np.array(H), "L": np.array(L), "C": np.array(C)}


def wilder_rsi(closes: np.ndarray, n: int = 14) -> np.ndarray:
    out = np.full(len(closes), np.nan)
    if len(closes) <= n:
        return out
    d = np.diff(closes)
    up, dn = np.maximum(d, 0), np.maximum(-d, 0)
    au, ad = up[:n].mean(), dn[:n].mean()
    out[n] = 100 - 100 / (1 + au / ad) if ad > 0 else 100.0
    for i in range(n, len(d)):
        au = (au * (n - 1) + up[i]) / n
        ad = (ad * (n - 1) + dn[i]) / n
        out[i + 1] = 100 - 100 / (1 + au / ad) if ad > 0 else 100.0
    return out


def straddle_vwap(con, underlying: str, day: str, spot_0920: float):
    """Minute arrays (375) of the 09:20-ATM straddle close and call + put volume, nearest expiry."""
    path = f"{LAKE}/bars_1m/asset=option/underlying={underlying}/date={day}/data.parquet"
    if not Path(path).exists():
        return None
    exp = con.execute(
        f"select min(expiry) from read_parquet('{path}') where expiry >= date '{day}'"
    ).fetchone()[0]
    if exp is None:
        return None
    strike = round(spot_0920 / STEP[underlying]) * STEP[underlying]
    df = con.execute(
        f"""select ((epoch(ts) + 19800)::BIGINT % 86400) / 60 - {OPEN_MIN} m, option_type t, close, volume
            from read_parquet('{path}') where expiry = date '{exp}' and strike = {strike}"""
    ).df()
    if df.empty:
        return None
    px, vol = {}, {}
    for t in ("CE", "PE"):
        g = df[df.t.astype(str).str.upper().str[0] == t[0]].drop_duplicates("m").set_index("m")
        if g.empty:
            return None
        px[t] = g.close.reindex(range(N_BARS)).ffill()
        vol[t] = g.volume.reindex(range(N_BARS)).fillna(0.0)
    st = (px["CE"] + px["PE"]).to_numpy()
    return st, (vol["CE"] + vol["PE"]).to_numpy()


def derived_straddle(con) -> dict:
    """(underlying, day) -> (open straddle, [(bucket start minute, straddle, atm_iv), ...]) nearest expiry."""
    df = con.execute(
        f"""select underlying u, date::varchar d, expiry, ((epoch(bucket) + 19800)::BIGINT % 86400) / 60 m,
                   straddle, straddle_open, atm_iv
            from read_parquet('{LAKE}/derived/straddle_series_5m/**/*.parquet', hive_partitioning=true)"""
    ).df()
    out = {}
    for (u, d), g in df.groupby(["u", "d"]):
        g = g[g.expiry == g.expiry.min()].sort_values("m")
        out[(u, d)] = g
    return out


def build() -> pd.DataFrame:
    con = _con()
    vdays, V = load_grid(con, "INDIAVIX")
    vix_ix = {d: i for i, d in enumerate(vdays)}
    ds = derived_straddle(con)
    rows = []
    for und in ("NIFTY", "SENSEX"):
        days, G = load_grid(con, und)
        O, H, L, C = G["O"], G["H"], G["L"], G["C"]  # noqa: E741
        n = len(days)
        dayH, dayL, dayC = H.max(1), L.min(1), C[:, -1]
        prevC = np.r_[np.nan, dayC[:-1]]
        tr = np.maximum.reduce([dayH - dayL, np.abs(dayH - prevC), np.abs(dayL - prevC)])
        atr = np.full(n, np.nan)
        for i in range(14, n):
            atr[i] = np.nanmean(tr[i - 14 : i])
        c5 = C[:, 4::5]  # last 1-minute close of each 5-minute block (stamps 09:19, 09:24, ...)
        rsi = wilder_rsi(c5.reshape(-1)).reshape(c5.shape)
        for i, d in enumerate(days):
            if i < 1 or d < "2021-12-01" or d not in vix_ix:
                continue
            if und == "SENSEX" and d < "2024-01-01":
                continue
            vi = vix_ix[d]
            vopen, vC = V["O"][vi, 0], V["C"][vi]
            pH, pL, pC = dayH[i - 1], dayL[i - 1], dayC[i - 1]
            piv = (pH + pL + pC) / 3
            r1, s1 = 2 * piv - pL, 2 * piv - pH
            gap = abs(O[i, 0] - pC) / pC
            sv = None
            if d >= OPT_START[und]:
                try:
                    sv = straddle_vwap(con, und, d, C[i, 5])  # 09:20 bar
                except Exception as e:  # noqa: BLE001
                    print(f"{und} {d}: option bars unreadable ({e})", file=sys.stderr)
            dg = ds.get((und, d))
            for hh, h in HOURS.items():
                j = h - OPEN_MIN
                assert 0 < j < N_BARS
                ch = C[i, j]
                lo, hi = L[i, : j + 1].min(), H[i, : j + 1].max()
                l60, h60 = L[i, j - 59 : j + 1].min(), H[i, j - 59 : j + 1].max()
                k5 = (j - 4) // 5
                row = dict(
                    day=d, index=und, h=hh,
                    vix_open=vC[j] / vopen - 1, vix_60=vC[j] / vC[j - 60] - 1,
                    trend_atr=(ch - O[i, 0]) / atr[i], range_pos=(ch - lo) / (hi - lo) if hi > lo else 0.5,
                    twap_dev=ch / C[i, : j + 1].mean() - 1,
                    atr_range=(hi - lo) / atr[i], atr_60=(h60 - l60) / atr[i],
                    rsi=rsi[i, k5], rsi_chg=rsi[i, k5] - rsi[i, k5 - 6],
                    pivot_zone=int(ch >= s1) + int(ch >= piv) + int(ch >= r1),  # 0 below S1 .. 3 above R1
                    pivot_lines=int(lo <= s1 <= hi) + int(lo <= piv <= hi) + int(lo <= r1 <= hi),
                    gap=gap, strad_vwap=np.nan, strad_chg=np.nan, iv_chg=np.nan,
                )
                if sv is not None:
                    st, w = sv
                    tot = w[: j + 1].sum()
                    if tot > 0:
                        row["strad_vwap"] = st[j] / ((st[: j + 1] * w[: j + 1]).sum() / tot) - 1
                if dg is not None and len(dg):
                    done = dg[dg.m <= h - 4]  # buckets complete by h + 1 minute
                    if len(done) and dg.m.min() == OPEN_MIN:
                        first, last = dg.iloc[0], done.iloc[-1]
                        row["strad_chg"] = last.straddle / first.straddle_open - 1
                        row["iv_chg"] = last.atm_iv / first.atm_iv - 1
                rows.append(row)
        print(f"{und}: {n} sessions read", file=sys.stderr)
    return pd.DataFrame(rows)


# ---- labels -------------------------------------------------------------------------------------


def _band(x, lo, hi, names=("down", "flat", "up")):
    x = np.asarray(x, float)
    out = np.where(x < lo, names[0], np.where(x > hi, names[2], names[1])).astype(object)
    out[np.isnan(x)] = None
    return out


def _tercile_labels(df: pd.DataFrame, col: str) -> np.ndarray:
    """Point-in-time terciles: cutoffs from the previous <= 252 sessions of this index at this hour
    (>= 60 needed, else no label)."""
    out = np.full(len(df), None, dtype=object)
    for (_u, _h), g in df.groupby(["index", "h"]):
        g = g.sort_values("day")
        v = g[col].to_numpy(float)
        res = np.full(len(g), None, dtype=object)
        for i in range(len(g)):
            prev = v[max(0, i - 252) : i]
            prev = prev[~np.isnan(prev)]
            if len(prev) < 60 or np.isnan(v[i]):
                continue
            a, b = np.quantile(prev, [1 / 3, 2 / 3])
            res[i] = "low" if v[i] <= a else ("high" if v[i] > b else "mid")
        out[df.index.get_indexer(g.index)] = res
    return out


VARS = [
    "vix_open", "vix_60", "trend_atr", "range_pos", "twap_dev", "strad_vwap", "atr_range", "atr_60",
    "rsi", "rsi_chg", "pivot_zone", "pivot_lines", "strad_chg", "iv_chg", "gap",
]
SUPPORTING_ONLY = {"strad_chg", "iv_chg"}  # no 2022-24 data: cannot count


def labels(raw: pd.DataFrame) -> pd.DataFrame:
    raw = raw.reset_index(drop=True)
    lab = raw[["day", "index", "h"]].copy()
    lab["vix_open"] = _band(raw.vix_open, -0.02, 0.02)
    lab["vix_60"] = _band(raw.vix_60, -0.01, 0.01)
    lab["trend_atr"] = _band(raw.trend_atr, -0.3, 0.3)
    lab["range_pos"] = _band(raw.range_pos, 0.25, 0.75, ("bottom", "mid", "top"))
    lab["twap_dev"] = _band(raw.twap_dev, -0.0015, 0.0015, ("below", "near", "above"))
    lab["strad_vwap"] = _band(raw.strad_vwap, -0.02, 0.02, ("below", "near", "above"))
    lab["atr_range"] = _tercile_labels(raw, "atr_range")
    lab["atr_60"] = _tercile_labels(raw, "atr_60")
    lab["rsi"] = _band(raw.rsi, 30, 70, ("oversold", "mid", "overbought"))
    lab["rsi_chg"] = _band(raw.rsi_chg, -5, 5, ("falling", "flat", "rising"))
    lab["pivot_zone"] = raw.pivot_zone.map(
        {0: "below_S1", 1: "S1_P", 2: "P_R1", 3: "above_R1"}
    ).astype(object)
    lab["pivot_lines"] = raw.pivot_lines.map({0: "0", 1: "1", 2: "2+", 3: "2+"}).astype(object)
    lab["strad_chg"] = _band(raw.strad_chg, -0.10, 0.10)
    lab["iv_chg"] = _band(raw.iv_chg, -0.05, 0.05)
    lab["gap"] = np.where(raw.gap.isna(), None, np.where(raw.gap < 0.003, "g0", np.where(raw.gap < 0.007, "g1", "g2")))
    # registered pairs (never more than two at once)
    def pair(a, b):
        return np.where(lab[a].isna() | lab[b].isna(), None, lab[a].astype(str) + "|" + lab[b].astype(str))

    lab["vix_open+trend_atr"] = pair("vix_open", "trend_atr")
    lab["vix_open+rsi"] = pair("vix_open", "rsi")
    lab["trend_atr+pivot_zone"] = pair("trend_atr", "pivot_zone")
    return lab


ALL_LABELS = VARS + ["vix_open+trend_atr", "vix_open+rsi", "trend_atr+pivot_zone"]

if __name__ == "__main__":
    OUT.mkdir(exist_ok=True)
    df = build()
    df.to_csv(OUT / "state_raw.csv", index=False)
    print(f"state_raw.csv: {len(df)} rows; days {df.day.min()} .. {df.day.max()}")
    print(df.groupby(["index", "h"]).size().unstack())
    print(df.drop(columns=["day", "index", "h"]).describe().T[["count", "mean", "min", "max"]].to_string())
