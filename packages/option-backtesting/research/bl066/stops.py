"""BL-066: daily portfolio stop levels on DRB-6W3L2 (rule pre-registered in
backlog/BL-066-drb-6w3l2-daily-stop.md).

    uv run --no-project --with pandas --with numpy python research/bl066/stops.py [--pairs]

--pairs writes the 8 chunk files of (variant, day) pairs to run through curves.py; without it the
recorded curves are evaluated."""

import json
import sys
from pathlib import Path

import numpy as np
import pandas as pd

HERE = Path(__file__).parent
CAP = 1_300_000
N = 375  # minutes on the grid
# levels in rupees; `--levels 8000,6000,4000` replaces the default five (BL-066's later block)
LEVELS = [None] + (
    [int(x) for x in sys.argv[sys.argv.index("--levels") + 1].split(",")]
    if "--levels" in sys.argv
    else [10_000, 12_000, 15_000, 17_000, 20_000]
)
FILL_AT_LEVEL = "--fill-at-level" in sys.argv
PER = 2  # lots in each strategy (DRB-6W3L2)
PICKS = HERE.parent / "bl057" / "daily_picks_min3_core6_buy2L2_whole_day.csv"
CHARGES = HERE.parent / "bl063" / "out" / "daily_charges.csv"


def picks_by_day() -> dict:
    picks = pd.read_csv(PICKS, parse_dates=["day"])
    return {
        r.day.date().isoformat(): r.core_A.split(",")
        + (r.buy.split(",") if isinstance(r.buy, str) else [])
        for r in picks.itertuples()
    }


def mdd(s) -> float:
    eq = np.cumsum(np.asarray(s, dtype=float))
    return float((eq - np.maximum.accumulate(np.maximum(eq, 0))).min())


def main() -> None:
    days = picks_by_day()
    if "--pairs" in sys.argv:
        pairs = sorted((n, d) for d, names in days.items() for n in names)
        for i in range(8):
            (HERE / f"pairs_{i}.txt").write_text(
                "\n".join(f"{n} {d}" for n, d in pairs[i::8]) + "\n"
            )
        print(len(pairs), "pairs in 8 chunk files")
        return
    rec = {}
    for file in HERE.glob("curves_*.jsonl"):
        for line in file.read_text().splitlines():
            r = json.loads(line)
            rec[(r["v"], r["day"])] = r
    keys = sorted(days)
    paths, final = np.zeros((len(keys), N)), np.zeros(len(keys))
    for i, d in enumerate(keys):
        for n in days[d]:
            r = rec[(n, d)]
            a = np.zeros(N)
            for m, v in r["curve"]:
                a[m] = v
            if r["curve"]:
                a[r["curve"][-1][0] + 1 :] = r["gross"]
            else:
                a[:] = r["gross"]
            assert abs(a[-1] - r["gross"]) < 0.01, (n, d)  # the curve ends at the stored gross
            paths[i] += PER * a
        final[i] = paths[i, -1]
    idx = pd.DatetimeIndex(keys)
    stored = pd.read_csv(PICKS, parse_dates=["day"]).set_index("day").pnl_A
    assert np.allclose(final, stored.reindex(idx).to_numpy(), atol=0.5), (
        "curves do not reproduce the stored P&L"
    )
    print(
        f"{len(keys)} days; combined curves reproduce DRB-6W3L2's stored daily P&L (₹{final.sum():,.0f})"
    )
    ch = pd.read_csv(CHARGES, parse_dates=["day"])
    charges = ch[ch.rotation == "DRB-6W3L2"].set_index("day").charges.reindex(idx).to_numpy()
    low = paths.min(axis=1)
    print(
        f"deepest intraday combined loss: ₹{low.min():,.0f}; days whose intraday low reached "
        + " / ".join(f"-{x // 1000}k" for x in LEVELS[1:])
        + ": "
        + " / ".join(str(int((low <= -x).sum())) for x in LEVELS[1:])
    )
    rows, results = [], {}
    for X in LEVELS:
        pnl, stopped, mins = final.copy(), np.zeros(len(keys), bool), np.full(len(keys), -1)
        if X is not None:
            for i in range(len(keys)):
                hit = np.where(paths[i] <= -X)[0]
                if len(hit):
                    # default: close at the combined value of the first minute that ends at or below -X;
                    # --fill-at-level: best case, the stop fills exactly at -X (a stop order that fires inside the bar)
                    pnl[i], stopped[i], mins[i] = (
                        (-X if FILL_AT_LEVEL else paths[i, hit[0]]),
                        True,
                        hit[0],
                    )
        s = pd.Series(pnl, index=idx)
        net = s - charges
        m = net.groupby(net.index.to_period("M")).sum()
        wk = s.groupby(s.index.to_period("W")).sum()
        st = stopped
        rows.append(
            dict(
                level="none" if X is None else f"{X:,}",
                stopped=int(st.sum()),
                gross=s.sum(),
                gross_pct=100 * s.sum() / CAP,
                dd=mdd(s),
                worst=s.min(),
                net=net.sum(),
                net_pct=100 * net.sum() / CAP,
                net_dd=mdd(net),
                worst_month=100 * m.min() / CAP,
                months_pos=f"{int((m > 0).sum())}/{len(m)}",
                worst_wk=wk.min(),
                whipsaw=int((final[st] > pnl[st]).sum()),
                stop_pnl=pnl[st].sum() if st.any() else 0.0,
                unstopped_same=final[st].sum() if st.any() else 0.0,
                avg_stop=pnl[st].mean() if st.any() else np.nan,
            )
        )
        results[X] = (pnl, stopped, mins)
    t = pd.DataFrame(rows)
    b = t.iloc[0]
    print(
        "\nDRB-6W3L2 with a daily portfolio stop; ₹13 lakh base; net uses the unstopped day's charges (flat ₹13 per order)\n"
    )
    print(
        f"{'stop':>7} {'days stopped':>12} | {'gross ₹':>9} {'vs none':>8} {'max DD':>9} {'vs none':>8} {'worst day':>9} {'worst wk':>9} | {'NET ₹':>9} {'NET %':>6} {'net DD':>9} {'worst mo':>8} {'mo +':>5} | {'whipsaw':>7} {'avg stopped day':>15} {'helps?':>6}"
    )
    for r in t.itertuples():
        helps = (
            "-"
            if r.level == "none"
            else ("YES" if (r.dd >= 0.75 * b.dd and r.gross >= 0.90 * b.gross) else "no")
        )
        print(
            f"{r.level:>7} {r.stopped:>12} | {r.gross:>9,.0f} {100 * (r.gross / b.gross - 1):>+7.1f}% {r.dd:>9,.0f} {100 * (r.dd / b.dd - 1):>+7.1f}% {r.worst:>9,.0f} {r.worst_wk:>9,.0f} | {r.net:>9,.0f} {r.net_pct:>5.1f}% {r.net_dd:>9,.0f} {r.worst_month:>7.2f}% {r.months_pos:>5} | {r.whipsaw:>7} {r.avg_stop:>15,.0f} {helps:>6}"
        )
    print("\nstopped days: what they made with the stop vs without it (₹)")
    for r in t.iloc[1:].itertuples():
        print(
            f"  {r.level:>7}: with the stop {r.stop_pnl:>10,.0f}   without {r.unstopped_same:>10,.0f}   saved {r.stop_pnl - r.unstopped_same:>+9,.0f}  ({r.whipsaw} of {r.stopped} would have finished better unstopped)"
        )
    worst = pd.Series(final, index=idx).nsmallest(10)
    print(
        "\n10 worst unstopped days (₹): unstopped | "
        + " | ".join(f"{x // 1000:.0f}k" for x in LEVELS[1:])
    )
    for d in worst.index:
        i = idx.get_loc(d)
        print(
            f"  {d:%d-%b-%y %a} | {final[i]:>8,.0f} | "
            + " | ".join(f"{results[x][0][i]:>7,.0f}" for x in LEVELS[1:])
        )
    mins = results[LEVELS[1]][2]
    hh = (
        pd.Series([f"{9 + (m + 15) // 60:02d}:{(m + 15) % 60:02d}" for m in mins[mins >= 0]])
        .str[:2]
        .value_counts()
        .sort_index()
    )
    print(f"\nhour (IST) in which the {LEVELS[1] // 1000}k stop fired:", hh.to_dict())
    suffix = (
        "_" + sys.argv[sys.argv.index("--levels") + 1].replace(",", "_")
        if "--levels" in sys.argv
        else ""
    )
    pd.DataFrame({"day": idx, **{f"pnl_{x}": results[x][0] for x in LEVELS}}).to_csv(
        HERE / f"out_daily_with_stops{suffix}.csv",
        index=False,
    )


if __name__ == "__main__":
    main()
