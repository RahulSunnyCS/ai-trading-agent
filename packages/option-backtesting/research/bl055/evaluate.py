"""BL-055: daily portfolio stop on the BL-054 benchmark mixes. Rule as pre-registered in
backlog/BL-055-daily-portfolio-stop-loss.md; do not edit after a result is seen."""

import pickle
from pathlib import Path

import numpy as np
import pandas as pd

HERE = Path(__file__).parent
NAMES = {
    "W": "nifty_widesl_917_otm1",
    "D": "nifty_dir_924_itm1_sl21_recost",
    "B": "nifty_buy_range_breakout",
}
MIXES = {"B1 5xW": {"W": 5}, "B2 3xW+2xD": {"W": 3, "D": 2}, "B3 4xW+D+B": {"W": 4, "D": 1, "B": 1}}
LEVELS = [None, 8000, 10000, 12500]
N = 375  # minutes 09:15..15:29


def load():
    cur = {}
    for k, v in NAMES.items():
        with open(HERE / f"curves_{v}.pkl", "rb") as fh:
            cur[k] = pickle.load(fh)
    days = sorted(set.intersection(*[set(c) for c in cur.values()]))
    # per strategy and day: MTM at every minute of the grid; 0 before the strategy starts,
    # its realised P&L (gross) after it ends
    arr = {}
    for k, c in cur.items():
        a = np.zeros((len(days), N))
        for i, d in enumerate(days):
            rec = c[d]
            curve = rec["curve"]
            if not curve:
                a[i, :] = rec["gross"]
                continue
            for m, v in curve:
                a[i, m] = v
            a[i, curve[-1][0] + 1 :] = rec["gross"]
        arr[k] = a
    return days, arr


def apply(path: np.ndarray, X):
    """path: combined MTM per minute (final entry = the unstopped day's P&L). Returns (pnl, stop minute or None)."""
    if X is None:
        return path[-1], None
    hit = np.where(path <= -X)[0]
    return (path[hit[0]], hit[0]) if len(hit) else (path[-1], None)


def mdd(s):
    eq = np.cumsum(s)
    return float((eq - np.maximum.accumulate(np.maximum(eq, 0))).min())


def main():
    days, arr = load()
    idx = pd.DatetimeIndex(days)
    print("days:", len(days), days[0], "->", days[-1])
    summary = []
    for mname, lots in MIXES.items():
        comb = sum(n * arr[k] for k, n in lots.items())
        base = comb[:, -1]
        print(
            f"\n{'=' * 80}\n{mname}  ({sum(lots.values())} lots)   intraday low of the day: worst {comb.min(axis=1).min():,.0f}\n{'=' * 80}"
        )
        res = {}
        for X in LEVELS:
            out = [apply(comb[i], X) for i in range(len(days))]
            pnl = pd.Series([o[0] for o in out], index=idx)
            stop = [o[1] is not None for o in out]
            res[X] = (pnl, np.array(stop))
            wk = pnl.groupby(pnl.index.to_period("W")).sum()
            st_pnl = pnl[np.array(stop)]
            un_pnl = pd.Series(base, index=idx)[np.array(stop)]
            row = dict(
                level="no stop" if X is None else f"{X:,}",
                total=pnl.sum(),
                maxDD=mdd(pnl.values),
                worst_day=pnl.min(),
                worst_wk=wk.min(),
                win_pct=100 * (pnl > 0).mean(),
                stopped=int(sum(stop)),
                stop_pnl=st_pnl.sum() if len(st_pnl) else 0,
                unstopped_same_days=un_pnl.sum() if len(un_pnl) else 0,
                whipsaw_days=int((un_pnl > st_pnl).sum()) if len(un_pnl) else 0,
                avg_stop_loss=st_pnl.mean() if len(st_pnl) else np.nan,
            )
            row["mix"] = mname
            summary.append(row)
        t0, d0 = res[None][0].sum(), mdd(res[None][0].values)
        print(
            f"{'level':>8} {'total':>10} {'vs none':>8} {'maxDD':>10} {'vs none':>8} {'worst day':>10} {'worst wk':>9} {'win%':>5} {'stopped':>7} {'whipsaw':>7} {'avg stop day':>12}"
        )
        for r in [x for x in summary if x["mix"] == mname]:
            print(
                f"{r['level']:>8} {r['total']:>10,.0f} {100 * (r['total'] / t0 - 1):>+7.1f}% {r['maxDD']:>10,.0f} {100 * (r['maxDD'] / d0 - 1):>+7.1f}% "
                f"{r['worst_day']:>10,.0f} {r['worst_wk']:>9,.0f} {r['win_pct']:>5.0f} {r['stopped']:>7} {r['whipsaw_days']:>7} {r['avg_stop_loss']:>12,.0f}"
            )
        for X in LEVELS[1:]:
            r = next(x for x in summary if x["mix"] == mname and x["level"] == f"{X:,}")
            helps = (r["maxDD"] >= 0.75 * d0) and (
                r["total"] >= 0.90 * t0
            )  # DD >=25% smaller AND total <=10% lower
            print(
                f"  level {X:,}: stopped days made {r['stop_pnl']:,.0f}; the same days unstopped {r['unstopped_same_days']:,.0f}; helps (rule)? {helps}"
            )
        # worst 10 days of the unstopped mix
        w = pd.Series(base, index=idx).nsmallest(10)
        print("\n  10 worst days (unstopped) | intraday low | with 8k | 10k | 12.5k")
        for d in w.index:
            i = idx.get_loc(d)
            print(
                f"  {d.strftime('%d-%b-%y %a')} | {base[i]:>8,.0f} | {comb[i].min():>8,.0f} | "
                + " | ".join(f"{res[X][0].iloc[i]:>7,.0f}" for X in LEVELS[1:])
            )
    pd.DataFrame(summary).to_csv(HERE / "summary.csv", index=False)


if __name__ == "__main__":
    main()
