"""BL-059: the whole-day start-time curve, NIFTY and SENSEX x Widesl / Dir ATM / Buy x 24 start times.

Descriptive only (pre-registered in backlog/BL-059-whole-day-start-time-curve.md): per start time
the days, total, average per day, win %, worst day and drawdown of the days chained; first half
vs second half of the window and their rank correlation; the BL-056 weekday / days-to-expiry /
VIX-band tables for all 24 start times. Window 2025-09-01 onward, weekend sessions dropped.

    uv run --with pandas --with numpy --with duckdb python research/bl059/analyse.py
"""

from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import pandas as pd

HERE = Path(__file__).parent
sys.path.insert(0, str(HERE.parent / "bl056"))
sys.path.insert(0, str(HERE.parent / "common"))
import analyse as A  # noqa: E402  (day_features, cells, family_summary, mdd, VIX bands)
import varlib  # noqa: E402

OUT = HERE / "out"
FAMILIES = {"wide": "Widesl", "dir": "Dir ATM", "buy": "Buy"}
SLOTS = varlib.SLOTS_MORNING + varlib.SLOTS_LATE
MORNING_DIR = {
    "NIFTY": HERE.parent / "bl054" / "results",
    "SENSEX": HERE.parent / "bl056" / "results",
}
PREFIX = {"NIFTY": "N", "SENSEX": "S"}
# known whole-window totals of the 09:17 Widesl variants from the earlier items (reconciliation)
KNOWN_WIDE_0917 = {"NIFTY": 48_472, "SENSEX": 38_147}
WINDOWS = [
    ("09:17-11:47", "09:17", "11:47"),
    ("12:02-13:47", "12:02", "13:47"),
    ("14:02-15:02", "14:02", "15:02"),
]


def load(u: str) -> pd.DataFrame:
    cols = {}
    for fam in FAMILIES:
        for slot in SLOTS:
            tag = slot.replace(":", "")
            if slot in varlib.SLOTS_MORNING:
                path = MORNING_DIR[u] / f"{fam}_{tag}.csv"
            else:
                path = HERE / "results" / f"{PREFIX[u]}_{fam}_{tag}.csv"
            cols[f"{fam}_{tag}"] = pd.read_csv(path, parse_dates=["day"]).set_index("day").net
    df = pd.DataFrame(cols).sort_index()
    assert df.shape[1] == 72, f"{u}: expected 72 variants, found {df.shape[1]}"
    assert not df.isna().any().any(), f"{u}: variants do not cover the same days"
    return df


def slot_of(variant: str) -> str:
    tag = variant.split("_")[1]
    return f"{tag[:2]}:{tag[2:]}"


def main() -> None:
    OUT.mkdir(exist_ok=True)
    allcells = []
    for u in ("NIFTY", "SENSEX"):
        df = load(u)
        df = df[df.index >= pd.Timestamp(A.WINDOW_FROM)]
        feat = A.day_features(u, df.index)
        wk = feat.weekday.isin(A.WD).values
        df, feat = df[wk], feat[wk]
        w917 = df["wide_0917"].sum()
        assert round(w917) == KNOWN_WIDE_0917[u] or abs(w917 - KNOWN_WIDE_0917[u]) < 2, (u, w917)
        mid = df.index[len(df) // 2]
        print(
            f"\n{'=' * 110}\n{u}: {len(df)} weekdays {df.index[0].date()} -> {df.index[-1].date()}; halves split at {mid.date()}\n{'=' * 110}"
        )
        rows = []
        for fam, famname in FAMILIES.items():
            print(
                f"\n--- {u} {famname}: 1 lot, before charges (late = 12:02 or later; '*' marks Buy cells that cannot trade: window ends within 2 min of exit) ---"
            )
            print(
                f"{'start':>6} {'days':>5} {'total':>9} {'avg/day':>8} {'win%':>5} {'worst':>8} {'maxDD':>9} {'H1 avg':>7} {'H2 avg':>7}"
            )
            h1s, h2s = [], []
            for slot in SLOTS:
                v = f"{fam}_{slot.replace(':', '')}"
                x = df[v]
                h1, h2 = x[x.index < mid], x[x.index >= mid]
                h1s.append(h1.mean())
                h2s.append(h2.mean())
                star = "*" if fam == "buy" and slot >= "14:47" else ""
                print(
                    f"{slot + star:>6} {len(x):>5} {x.sum():>9,.0f} {x.mean():>8,.0f} {100 * (x > 0).mean():>5.0f} {x.min():>8,.0f} {A.mdd(x.to_numpy()):>9,.0f} {h1.mean():>7,.0f} {h2.mean():>7,.0f}"
                )
                rows.append(
                    dict(
                        underlying=u,
                        family=fam,
                        slot=slot,
                        days=len(x),
                        total=x.sum(),
                        avg=x.mean(),
                        win_pct=100 * (x > 0).mean(),
                        worst=x.min(),
                        max_dd=A.mdd(x.to_numpy()),
                        h1_avg=h1.mean(),
                        h2_avg=h2.mean(),
                    )
                )
            rc = pd.Series(h1s).rank().corr(pd.Series(h2s).rank())
            print(
                f"  rank correlation of first-half and second-half average across the 24 start times: {rc:+.2f}"
            )
            sub = pd.DataFrame([r for r in rows if r["family"] == fam])
            for wname, lo, hi in WINDOWS:
                w = sub[(sub.slot >= lo) & (sub.slot <= hi)]
                print(
                    f"  {wname}: avg of start-time means {w.avg.mean():>6,.0f}/day | both halves positive in {int(((w.h1_avg > 0) & (w.h2_avg > 0)).sum())} of {len(w)} start times"
                )
        pd.DataFrame(rows).to_csv(OUT / f"{u.lower()}_curve.csv", index=False)

        # BL-056 tables for all 24 start times
        for dim, labels, name in (
            ("weekday", A.WD, "weekday"),
            ("dte_label", ["0", "1", "2", "3", "4", "5", "6", "7+", "unknown"], "dte"),
            ("vix_band", A.VIX_LABELS + ["unknown"], "vix"),
        ):
            c = A.cells(df, feat, dim, labels, u, None)
            expect = df[feat[dim].isin(labels).values].sum()
            used = c.groupby("variant").total.sum()
            assert np.allclose(used.sort_index().values, expect.sort_index().values), (
                f"{u} {name}: cells do not sum to total"
            )
            c["slot"] = c.variant.map(slot_of)
            c["late"] = c.slot >= "12:00"
            c.to_csv(OUT / f"{u.lower()}_by_{name}.csv", index=False)
            shown = [lab for lab in labels if c[c.cell == lab].days.iloc[0] > 0]
            days = {lab: int(c[c.cell == lab].days.iloc[0]) for lab in shown}
            print(
                f"\n--- {u} by {name}: average P&L per day, family means  [days per cell: {days}] ---"
            )
            for label, part in (
                ("all 24 start times", c),
                ("morning 09:17-11:47", c[~c.late]),
                ("late 12:02-15:02", c[c.late]),
            ):
                t = (
                    part.assign(family=part.variant.str.split("_").str[0])
                    .groupby(["family", "cell"])
                    .avg.mean()
                    .unstack()[shown]
                )
                print(f"  [{label}]")
                print(t.to_string(float_format=lambda x: f"{x:,.0f}").replace("\n", "\n  "))
            allcells.append(c.assign(underlying=u, table=name))
    pd.concat(allcells).to_csv(OUT / "all_cells.csv", index=False)


if __name__ == "__main__":
    main()
