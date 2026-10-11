"""BL-070: per family, every variant with vs without its overall MTM stop (same days), and the stop's
firing rate.  uv run --with pandas --with numpy python research/bl070/analyse.py"""

from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import pandas as pd

HERE = Path(__file__).parent
sys.path.insert(0, str(HERE.parent / "common"))
import varlib  # noqa: E402

FAM = {"wide": "Widesl OTM", "p80": "Widesl closest", "p100": "Widesl closest", "p250": "Widesl closest", "p320": "Widesl closest", "dir": "Dir ATM", "buy": "Buy"}
FROM = pd.Timestamp("2025-09-01")


def mdd(s) -> float:
    eq = np.cumsum(np.asarray(s, dtype=float))
    return float((eq - np.maximum.accumulate(np.maximum(eq, 0))).min())


def main() -> None:
    rows = []
    for f in sorted((HERE / "results").glob("*.csv")):
        name = f.stem
        ns = pd.read_csv(f, parse_dates=["day"]).set_index("day")
        ws = pd.read_csv(varlib.variant_file(name, "results"), parse_dates=["day"]).set_index("day")
        ws = ws[ws.index >= FROM]
        common = ns.index.intersection(ws.index)
        a, b = ws.loc[common], ns.loc[common]
        rows.append(
            dict(
                variant=name,
                family=FAM[name.split("_")[1]],
                index=name[0],
                days=len(common),
                with_total=a.net.sum(),
                without_total=b.net.sum(),
                with_dd=mdd(a.net),
                without_dd=mdd(b.net),
                with_worst=a.net.min(),
                without_worst=b.net.min(),
                stop_days=int(a.stopped_by.fillna("").str.contains("overall").sum()),
                pnl_on_stop_days_with=a.net[a.stopped_by.fillna("").str.contains("overall")].sum(),
                pnl_on_stop_days_without=b.net[a.stopped_by.fillna("").str.contains("overall")].sum(),
            )
        )
    t = pd.DataFrame(rows)
    (HERE / "out").mkdir(exist_ok=True)
    t.to_csv(HERE / "out" / "with_vs_without.csv", index=False)
    g = t.groupby(["index", "family"]).agg(
        variants=("variant", "size"),
        with_total=("with_total", "mean"),
        without_total=("without_total", "mean"),
        with_dd=("with_dd", "mean"),
        without_dd=("without_dd", "mean"),
        with_worst=("with_worst", "mean"),
        without_worst=("without_worst", "mean"),
        stop_days=("stop_days", "mean"),
        pnl_stop_days_with=("pnl_on_stop_days_with", "mean"),
        pnl_stop_days_without=("pnl_on_stop_days_without", "mean"),
    )
    g["dd_change_pct"] = 100 * (g.without_dd / g.with_dd - 1)
    g["total_change"] = g.without_total - g.with_total
    pd.set_option("display.width", 220)
    print("mean over the family's variants, 1 lot, same days, before charges\n")
    print(g.to_string(float_format=lambda x: f"{x:,.0f}"))
    print(f"\nvariants: {len(t)}; days per variant {t.days.min()}-{t.days.max()}")
    print("all variants: with stop", f"{t.with_total.sum():,.0f}", "| without", f"{t.without_total.sum():,.0f}")
    print(f"stop fired on {t.stop_days.sum()} variant-days of {t.days.sum()} ({100 * t.stop_days.sum() / t.days.sum():.1f}%)")


if __name__ == "__main__":
    main()
