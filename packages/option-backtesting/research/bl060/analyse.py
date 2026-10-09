"""BL-060: SENSEX Widesl by closest premium (250, 320) beside the live OTM2 strike, all 24 start times.

Descriptive only (pre-registered in backlog/BL-060-sensex-widesl-closest-premium.md). Window
2025-09-01 onward, weekend sessions dropped, before charges.

    uv run --with pandas --with numpy --with duckdb python research/bl060/analyse.py
"""

from __future__ import annotations

import sys
from datetime import date
from pathlib import Path

import numpy as np
import pandas as pd

HERE = Path(__file__).parent
sys.path.insert(0, str(HERE.parent / "bl056"))
sys.path.insert(0, str(HERE.parent / "common"))
import analyse as A  # noqa: E402  (day_features, cells, family_summary, mdd, VIX bands)
import varlib  # noqa: E402

OUT = HERE / "out"
SLOTS = varlib.SLOTS_MORNING + varlib.SLOTS_LATE
RULES = ["otm2", "p250", "p320"]
KNOWN_OTM2_0917 = 38_147  # SENSEX Widesl 09:17 over the window (BL-056 / BL-059)
WINDOWS = [
    ("09:17-11:47", "09:17", "11:47"),
    ("12:02-13:47", "12:02", "13:47"),
    ("14:02-15:02", "14:02", "15:02"),
]


def read(path: Path) -> pd.Series:
    return pd.read_csv(path, parse_dates=["day"]).set_index("day").net


def load() -> pd.DataFrame:
    cols = {}
    for slot in SLOTS:
        tag = slot.replace(":", "")
        base = HERE.parent / ("bl056" if slot in varlib.SLOTS_MORNING else "bl059") / "results"
        name = f"wide_{tag}.csv" if slot in varlib.SLOTS_MORNING else f"S_wide_{tag}.csv"
        cols[f"otm2_{tag}"] = read(base / name)
        for p in (250, 320):
            cols[f"p{p}_{tag}"] = read(HERE / "results" / f"p{p}_{tag}.csv")
    df = pd.DataFrame(cols).sort_index()
    assert df.shape[1] == 72, f"expected 72 variants, found {df.shape[1]}"
    assert not df.isna().any().any(), "variants do not cover the same days"
    return df


def entry_premiums(sessions: int = 15) -> None:
    """Average premium at entry per leg for the last sessions at 09:17, per rule: does the
    closest-premium choice land near its target, and what does OTM2 collect?"""
    from option_backtesting.fyers.daily import data_dir
    from option_backtesting.legwise.engine import run_legwise
    from option_backtesting.legwise.schema import load_legwise

    files = {
        "OTM2 (live)": HERE.parent.parent
        / "strategies"
        / "legwise"
        / "sensex_widesl_917_otm2.yaml",
        "closest 250": HERE / "variants" / "p250_0917.yaml",
        "closest 320": HERE / "variants" / "p320_0917.yaml",
    }
    print(
        f"\n--- average premium at entry per leg, 09:17, last {sessions} sessions to 2026-10-08 ---"
    )
    for label, path in files.items():
        days = run_legwise(
            load_legwise(path), data_dir(), date(2026, 9, 1), date(2026, 10, 8), skipped={}
        )
        days = [d for d in days if d.trades][-sessions:]
        ce = [t.entry_price for d in days for t in d.trades if t.leg_id == "ce"]
        pe = [t.entry_price for d in days for t in d.trades if t.leg_id == "pe"]
        print(
            f"  {label:12s} call {np.mean(ce):>6.0f}  put {np.mean(pe):>6.0f}  ({len(days)} sessions)"
        )


def main() -> None:
    OUT.mkdir(exist_ok=True)
    df = load()
    df = df[df.index >= pd.Timestamp(A.WINDOW_FROM)]
    feat = A.day_features("SENSEX", df.index)
    wk = feat.weekday.isin(A.WD).values
    df, feat = df[wk], feat[wk]
    assert abs(df["otm2_0917"].sum() - KNOWN_OTM2_0917) < 2, df["otm2_0917"].sum()
    mid = df.index[len(df) // 2]
    print(
        f"SENSEX Widesl: {len(df)} weekdays {df.index[0].date()} -> {df.index[-1].date()}; halves split at {mid.date()}"
    )
    print("(OTM2 09:17 total reconciles with BL-056)\n")
    rows = []
    hdr = f"{'start':>6} | " + " | ".join(f"{r:^25}" for r in RULES)
    print(hdr)
    print(f"{'':>6} | " + " | ".join(f"{'avg/day':>8} {'win%':>4} {'maxDD':>8}" for _ in RULES))
    for slot in SLOTS:
        tag = slot.replace(":", "")
        parts = []
        for r in RULES:
            x = df[f"{r}_{tag}"]
            h1, h2 = x[x.index < mid], x[x.index >= mid]
            parts.append(
                f"{x.mean():>8,.0f} {100 * (x > 0).mean():>4.0f} {A.mdd(x.to_numpy()):>8,.0f}"
            )
            rows.append(
                dict(
                    rule=r,
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
        print(f"{slot:>6} | " + " | ".join(parts))
    t = pd.DataFrame(rows)
    t.to_csv(OUT / "curve.csv", index=False)

    print(
        "\n--- by window: mean of start-time averages (₹/day) | max drawdown averaged over start times | start times positive in both halves ---"
    )
    for wname, lo, hi in WINDOWS:
        line = f"  {wname}:"
        for r in RULES:
            w = t[(t.rule == r) & (t.slot >= lo) & (t.slot <= hi)]
            line += f"  {r} {w.avg.mean():>5,.0f} | {w.max_dd.mean():>7,.0f} | {int(((w.h1_avg > 0) & (w.h2_avg > 0)).sum())}/{len(w)}  ||"
        print(line)
    for r in RULES:
        w = t[t.rule == r]
        print(
            f"  {r}: all 24 start times  total of 24 = ₹{w.total.sum():,.0f}; avg win {w.win_pct.mean():.0f}%; "
            f"rank corr of halves {w.h1_avg.rank().corr(w.h2_avg.rank()):+.2f}"
        )
    # head-to-head per start time against OTM2
    o = t[t.rule == "otm2"].set_index("slot")
    for r in ("p250", "p320"):
        p = t[t.rule == r].set_index("slot")
        print(
            f"\n  {r} vs OTM2: higher average on {int((p.avg > o.avg).sum())} of 24 start times; smaller drawdown on "
            f"{int((p.max_dd > o.max_dd).sum())} of 24; avg ₹/day {p.avg.mean():,.0f} vs {o.avg.mean():,.0f}; "
            f"avg drawdown {p.max_dd.mean():,.0f} vs {o.max_dd.mean():,.0f}"
        )

    for dim, labels, name in (
        ("weekday", A.WD, "weekday"),
        ("dte_label", ["0", "1", "2", "3", "4", "5", "6", "7+", "unknown"], "dte"),
        ("vix_band", A.VIX_LABELS + ["unknown"], "vix"),
    ):
        c = A.cells(df, feat, dim, labels, "SENSEX", None)
        expect = df[feat[dim].isin(labels).values].sum()
        used = c.groupby("variant").total.sum()
        assert np.allclose(used.sort_index().values, expect.sort_index().values), (
            f"{name}: cells do not sum to total"
        )
        c["slot"] = c.variant.str.split("_").str[1].map(lambda s: f"{s[:2]}:{s[2:]}")
        c.to_csv(OUT / f"by_{name}.csv", index=False)
        shown = [lab for lab in labels if c[c.cell == lab].days.iloc[0] > 0]
        print(
            f"\n--- SENSEX Widesl by {name}: average ₹/day, mean over all 24 start times  [days {{{', '.join(f'{lab}: {int(c[c.cell == lab].days.iloc[0])}' for lab in shown)}}}] ---"
        )
        print(A.family_summary(c, shown))
    entry_premiums()


if __name__ == "__main__":
    main()
