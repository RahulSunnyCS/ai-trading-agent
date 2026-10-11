"""BL-083 phase 1: the first firing minute of T1..T4 per day and index, from 1-minute bars <= that minute.

    uv run --with pandas --with numpy --with duckdb python research/bl083/triggers.py

Definitions as registered in backlog/BL-083-event-triggered-intraday-entries.md (Phase 0). Window: bar
stamps 10:30..14:00 (j = 75..285); a firing at stamp j means entry at the open of stamp j+1. Writes
out/triggers.csv: one row per (underlying, day, trigger) that fired at least once.

  T1  spot's close crosses yesterday's P, R1 or S1 for the first time today (closes from 09:15) and
      (close - 09:15 open) / 14-session ATR has the cross's sign with magnitude >= 0.3
  T2  VIX >= +2% on its 09:15 open and its 30-minute change <= -1%
  T3  09:20-ATM straddle was up >= 5% on its 10:00 value at some point since, is now >= 3% below that high,
      and the last-30-minute spot range / ATR is below its trailing-252-session median at that stamp
  T4  5-minute RSI-14 completes a block that crosses back below 70 (from >= 70) or above 30 (from <= 30)
"""

from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import pandas as pd

HERE = Path(__file__).parent
sys.path.insert(0, str(HERE.parent / "bl081"))
import state as S  # noqa: E402

S.START = "2020-09-01"  # 252 sessions of history before 2022-01-03 (T3's median needs them)

OUT = HERE / "out"
J0, J1 = 75, 285  # 10:30 .. 14:00
J_1000, J_EXIT = 45, 373  # 10:00, 15:28
SETS = {"explore": ("2024-10-09", "2026-10-08"), "confirm": ("2022-01-03", "2024-10-08")}


def which_set(underlying: str, day: str) -> str | None:
    for k, (a, b) in SETS.items():
        if a <= day <= b and not (k == "confirm" and underlying != "NIFTY"):
            return k
    return None


def straddle_series(con, und: str, day: str, spot_0920: float):
    """(straddle close per minute, expiry) of the 09:20-ATM, nearest expiry; None when unavailable."""
    path = f"{S.LAKE}/bars_1m/asset=option/underlying={und}/date={day}/data.parquet"
    if not Path(path).exists():
        return None
    exp = con.execute(f"select min(expiry) from read_parquet('{path}') where expiry >= date '{day}'").fetchone()[0]
    if exp is None:
        return None
    strike = round(spot_0920 / S.STEP[und]) * S.STEP[und]
    df = con.execute(
        f"""select ((epoch(ts) + 19800)::BIGINT % 86400) / 60 - {S.OPEN_MIN} m, option_type t, close
            from read_parquet('{path}') where expiry = date '{exp}' and strike = {strike}"""
    ).df()
    px = {}
    for t in ("C", "P"):
        g = df[df.t.astype(str).str.upper().str[0] == t].drop_duplicates("m").set_index("m")
        if g.empty:
            return None
        px[t] = g.close.reindex(range(S.N_BARS)).ffill()
    return (px["C"] + px["P"]).to_numpy(), str(exp)


def build() -> pd.DataFrame:
    con = S._con()
    vdays, V = S.load_grid(con, "INDIAVIX")
    vix_ix = {d: i for i, d in enumerate(vdays)}
    rows = []
    for und in ("NIFTY", "SENSEX"):
        days, G = S.load_grid(con, und)
        O, H, L, C = G["O"], G["H"], G["L"], G["C"]  # noqa: E741
        n = len(days)
        dayH, dayL, dayC = H.max(1), L.min(1), C[:, -1]
        prevC = np.r_[np.nan, dayC[:-1]]
        tr = np.maximum.reduce([dayH - dayL, np.abs(dayH - prevC), np.abs(dayL - prevC)])
        atr = np.full(n, np.nan)
        for i in range(14, n):
            atr[i] = np.nanmean(tr[i - 14 : i])
        # last-30-minute range / ATR at every stamp, then its trailing-252-session median per stamp
        r30 = np.full((n, S.N_BARS), np.nan)
        for j in range(29, S.N_BARS):
            r30[:, j] = (H[:, j - 29 : j + 1].max(1) - L[:, j - 29 : j + 1].min(1)) / atr
        c5 = C[:, 4::5]
        rsi = S.wilder_rsi(c5.reshape(-1)).reshape(c5.shape)
        for i, d in enumerate(days):
            if i < 253 or d < "2021-12-01" or d not in vix_ix:
                continue
            st_name = which_set(und, d)
            if st_name is None:
                continue
            vi = vix_ix[d]
            vO, vC = V["O"][vi, 0], V["C"][vi]
            pH, pL, pC = dayH[i - 1], dayL[i - 1], dayC[i - 1]
            piv = (pH + pL + pC) / 3
            levels = {"P": piv, "R1": 2 * piv - pL, "S1": 2 * piv - pH}
            trend = (C[i] - O[i, 0]) / atr[i]
            med = np.nanmedian(r30[i - 252 : i], axis=0)
            sres = None
            if d >= S.OPT_START[und]:
                try:
                    sres = straddle_series(con, und, d, C[i, 5])
                except Exception as e:  # noqa: BLE001
                    print(f"{und} {d}: straddle unreadable ({e})", file=sys.stderr)
            fired: dict[str, tuple] = {}
            # T1
            crossed = {k: False for k in levels}
            for j in range(1, J1 + 1):
                for k, lv in levels.items():
                    up = C[i, j - 1] < lv <= C[i, j]
                    dn = C[i, j - 1] > lv >= C[i, j]
                    if (up or dn) and not crossed[k]:
                        crossed[k] = True
                        with_trend = (up and trend[j] >= 0.3) or (dn and trend[j] <= -0.3)
                        if J0 <= j <= J1 and "T1" not in fired and with_trend:
                            fired["T1"] = (j, f"{k}_{'up' if up else 'down'}")
            # T2
            for j in range(J0, J1 + 1):
                if vC[j] / vO - 1 >= 0.02 and vC[j] / vC[j - 30] - 1 <= -0.01:
                    fired["T2"] = (j, "")
                    break
            # T3
            if sres is not None:
                st, _exp = sres
                base = st[J_1000]
                for j in range(J0, J1 + 1):
                    hi = np.nanmax(st[J_1000 + 1 : j + 1])
                    if (hi >= 1.05 * base and st[j] <= 0.97 * hi and r30[i, j] < med[j]
                            and not np.isnan(r30[i, j]) and not np.isnan(med[j])):
                        fired["T3"] = (j, "")
                        break
            # T4
            for j in range(J0, J1 + 1):
                if (j - 4) % 5:
                    continue
                k = (j - 4) // 5
                a, b = rsi[i, k - 1], rsi[i, k]
                if (a >= 70 > b) or (a <= 30 < b):
                    fired["T4"] = (j, "from_over70" if a >= 70 else "from_under30")
                    break
            for trig, (j, extra) in fired.items():
                assert J0 <= j <= J1 and j + 1 < S.N_BARS, (und, d, trig, j)  # entry minute exists, inside the window
                st_entry = sres[0][j + 1] if sres is not None else np.nan
                rows.append(dict(
                    set=st_name, underlying=und, day=d, trigger=trig, stamp=j, entry=f"{(S.OPEN_MIN + j + 1) // 60:02d}:{(S.OPEN_MIN + j + 1) % 60:02d}",
                    detail=extra, expiry_day=bool(sres is not None and sres[1] == d),
                    fwd_spot=C[i, J_EXIT] / O[i, j + 1] - 1,
                    fwd_straddle=(sres[0][J_EXIT] / st_entry - 1) if sres is not None and st_entry > 0 else np.nan,
                    atr_pct=atr[i] / O[i, 0], vix_open=vO,
                ))
        print(f"{und}: {n} sessions", file=sys.stderr)
    return pd.DataFrame(rows)


if __name__ == "__main__":
    OUT.mkdir(exist_ok=True)
    t = build()
    t.to_csv(OUT / "triggers.csv", index=False)
    days = {s: t.groupby("set").day.nunique().to_dict() for s in ("n",)}
    print(f"triggers.csv: {len(t)} events")
    allday = {}
    for (st, und), g in t.groupby(["set", "underlying"]):
        allday[(st, und)] = g.day.nunique()
    tab = t.groupby(["set", "underlying", "trigger"]).size().unstack(fill_value=0)
    print(tab.to_string())
    print("\nmedian entry hour by trigger:", t.groupby("trigger").stamp.median().map(lambda j: f"{(555 + int(j) + 1) // 60:02d}:{(555 + int(j) + 1) % 60:02d}").to_dict())
    print("T1 detail:", t[t.trigger == "T1"].detail.value_counts().to_dict())
    print("expiry-day share by trigger:", t.groupby("trigger").expiry_day.mean().round(2).to_dict())
