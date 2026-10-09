"""BL-056: per-variant results split by weekday, days to expiry and India VIX band, NIFTY and SENSEX.

Descriptive only (no verdict). Definitions are the ones in backlog/BL-056-weekday-dte-vix-breakdown.md.

    uv run --no-project --with pandas --with numpy --with duckdb python research/bl056/analyse.py
"""

from __future__ import annotations

import sys
from pathlib import Path

import duckdb
import numpy as np
import pandas as pd

HERE = Path(__file__).parent
OUT = HERE / "out"
RESULTS = {"NIFTY": HERE.parent / "bl054" / "results", "SENSEX": HERE / "results"}
LAKE = "/Volumes/TradingData/lake"
VIX_BINS = [0, 10.5, 11.5, 13, 15, 18, 99]
VIX_LABELS = ["<10.5", "10.5-11.5", "11.5-13", "13-15", "15-18", "18+"]
WD = ["Mon", "Tue", "Wed", "Thu", "Fri"]
THIN = 30
WINDOW_FROM = "2025-09-01"  # owner, 2026-10-09: one expiry regime, the earlier period comes later


def day_features(underlying: str, days: pd.DatetimeIndex) -> pd.DataFrame:
    con = duckdb.connect()
    ce = con.sql(
        f"""select date, min(expiry) filter (where expiry >= date and bars > 0) nearest
            from read_parquet('{LAKE}/derived/contracts_daily/**/*.parquet', hive_partitioning=true)
            where underlying = '{underlying}' and date >= '2024-10-01' group by date"""
    ).df()
    ce["date"] = pd.to_datetime(ce.date)
    ce["nearest"] = pd.to_datetime(ce.nearest)
    ce = ce.set_index("date")
    vix = con.sql(
        f"""select date, arg_min(open, ts) vix_open
            from read_parquet('{LAKE}/bars_1m/asset=index/symbol=INDIAVIX/**/*.parquet', hive_partitioning=true)
            where hour(ts) * 60 + minute(ts) >= 555 and date >= '2024-10-01' group by date"""
    ).df()
    vix["date"] = pd.to_datetime(vix.date)
    vix = vix.set_index("date")
    f = pd.DataFrame(index=days)
    f["weekday"] = days.day_name().str[:3]
    f["dte_lake"] = (ce.nearest.reindex(days) - days).dt.days
    from option_backtesting.legwise.anatomy import dte_for

    cal = pd.Series([dte_for(underlying, d.date()) for d in days], index=days, dtype="float")
    f["dte"] = f.dte_lake.where(f.dte_lake.eq(cal) | cal.isna() & f.dte_lake.notna())
    f["dte_label"] = f.dte.map(
        lambda v: "unknown" if pd.isna(v) else (str(int(v)) if v <= 6 else "7+")
    )
    f["vix_open"] = vix.vix_open.reindex(days)
    f["vix_band"] = pd.cut(f.vix_open, VIX_BINS, labels=VIX_LABELS).astype(object).fillna("unknown")
    # expiry weekday regime: the modal weekday of the nearest expiry, per month
    exp_wd = ce.nearest.reindex(days).dt.day_name().str[:3]
    mode = exp_wd.groupby(days.to_period("M")).agg(
        lambda s: s.mode().iat[0] if s.notna().any() else None
    )
    f["expiry_wd"] = [mode.loc[d.to_period("M")] for d in days]
    return f


def load(underlying: str) -> pd.DataFrame:
    cols = {}
    for fp in sorted(RESULTS[underlying].glob("*_[0-9][0-9][0-9][0-9].csv")):
        cols[fp.stem] = pd.read_csv(fp, parse_dates=["day"]).set_index("day").net
    df = pd.DataFrame(cols).sort_index()
    assert df.shape[1] == 33, f"{underlying}: expected 33 variants, found {df.shape[1]}"
    assert not df.isna().any().any(), f"{underlying}: variants do not cover the same days"
    return df


def mdd(x: np.ndarray) -> float:
    eq = np.cumsum(x)
    return float((eq - np.maximum.accumulate(np.maximum(eq, 0))).min())


def cells(
    df: pd.DataFrame,
    feat: pd.DataFrame,
    dim: str,
    labels: list[str],
    underlying: str,
    subset: pd.Series | None = None,
):
    rows = []
    for v in df.columns:
        for lab in labels:
            m = feat[dim].eq(lab)
            if subset is not None:
                m &= subset
            x = df.loc[m.values, v].to_numpy()
            n = len(x)
            rows.append(
                dict(
                    underlying=underlying,
                    variant=v,
                    dim=dim,
                    cell=lab,
                    days=n,
                    total=x.sum() if n else 0.0,
                    avg=x.mean() if n else np.nan,
                    win_pct=100 * (x > 0).mean() if n else np.nan,
                    worst=x.min() if n else np.nan,
                    max_dd=mdd(x) if n else np.nan,
                    thin=n < THIN,
                )
            )
    return pd.DataFrame(rows)


def heat(c: pd.DataFrame, labels: list[str], value="avg") -> str:
    t = c.pivot(index="variant", columns="cell", values=value)[labels]
    d = c.groupby("cell").days.first().reindex(labels)
    head = "days:        " + " ".join(f"{int(d[lab]):>9d}" for lab in labels)
    return head + "\n" + t.to_string(float_format=lambda x: f"{x:,.0f}")


def family_summary(c: pd.DataFrame, labels: list[str]) -> str:
    c = c.assign(family=c.variant.str.split("_").str[0])
    t = c.groupby(["family", "cell"]).avg.mean().unstack()[labels]
    return t.to_string(float_format=lambda x: f"{x:,.0f}")


def main() -> None:
    OUT.mkdir(exist_ok=True)
    summary = []
    for u in ("NIFTY", "SENSEX"):
        df = load(u)
        df = df[df.index >= pd.Timestamp(WINDOW_FROM)]
        feat = day_features(u, df.index)
        wk = feat.weekday.isin(WD)
        print(
            f"\n{'=' * 90}\n{u}: {len(df)} days, {df.index.min().date()} -> {df.index.max().date()}; "
            f"weekend sessions dropped: {int((~wk).sum())} {list(df.index[~wk].strftime('%d-%b-%y'))}\n{'=' * 90}"
        )
        dfw, featw = df[wk.values], feat[wk.values]
        print(
            "unknown dte days:",
            list(featw.index[featw.dte_label.eq("unknown")].strftime("%d-%b-%y")),
            "| unknown VIX days:",
            int(featw.vix_band.eq("unknown").sum()),
        )
        print(
            f"analysis window: {WINDOW_FROM} onward = {len(dfw)} weekdays; expiry weekday in it: "
            f"{featw.expiry_wd.value_counts().to_dict()}"
        )
        specs = [
            ("weekday", WD, None),
            ("dte_label", ["0", "1", "2", "3", "4", "5", "6", "7+", "unknown"], None),
            ("vix_band", VIX_LABELS + ["unknown"], None),
        ]
        names = ["weekday", "dte", "vix"]
        for (dim, labels, subset), name in zip(specs, names, strict=True):
            c = cells(dfw, featw, dim, labels, u, subset)
            c.to_csv(OUT / f"{u.lower()}_by_{name}.csv", index=False)
            # reconcile: cells partition the days used
            used = c.groupby("variant").total.sum()
            expect = (
                dfw[
                    featw[dim].isin(labels).values & (subset.values if subset is not None else True)
                ]
            ).sum()
            assert np.allclose(used.sort_index().values, expect.sort_index().values), (
                f"{u} {name}: cells do not sum to total"
            )
            shown = [lab for lab in labels if c[c.cell == lab].days.iloc[0] > 0]
            print(
                f"\n--- {u} by {name}: average P&L per day, family means over the 11 start times ---"
            )
            print("days:", {lab: int(c[c.cell == lab].days.iloc[0]) for lab in shown})
            print(family_summary(c, shown))
            (OUT / f"{u.lower()}_heat_{name}.txt").write_text(heat(c, shown))
            summary.append(c)
        print(f"\nwhole-window total, e.g. wide_0917: {dfw['wide_0917'].sum():,.0f}")
    pd.concat(summary).to_csv(OUT / "all_cells.csv", index=False)


if __name__ == "__main__":
    sys.exit(main())
