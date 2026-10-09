"""BL-055 second block: mixes B1-B4 x Widesl versions (OTM1 / closest 80 / closest 100) x stop levels.
Rule as pre-registered in backlog/BL-055-daily-portfolio-stop-loss.md; do not edit after a result is seen."""

import pickle
from pathlib import Path

import numpy as np
import pandas as pd

HERE = Path(__file__).parent
N = 375
LEVELS = [None, 8000, 10000, 12500]
WIDE = {  # version -> {slot: curve file stem}
    "OTM1": {"0917": "nifty_widesl_917_otm1", "0932": "wide_0932", "1002": "wide_1002"},
    "P80": {s: f"p80_{s}" for s in ("0917", "0932", "1002")},
    "P100": {s: f"p100_{s}" for s in ("0917", "0932", "1002")},
}
OTHER = {
    "D924": "nifty_dir_924_itm1_sl21_recost",
    "DA1117": "dir_1117",
    "DA1132": "dir_1132",
    "B935": "nifty_buy_range_breakout",
}


def mixes(v):
    def w(slot):
        return f"W{v}_{slot}"

    return {
        "B1 5xW917": {w("0917"): 5},
        "B2 3xW917+2xD924": {w("0917"): 3, "D924": 2},
        "B3 4xW917+D924+B": {w("0917"): 4, "D924": 1, "B935": 1},
        "B4 W917+W932+W1002+2xDA+B": {
            w("0917"): 1,
            w("0932"): 1,
            w("1002"): 1,
            "DA1117": 1,
            "DA1132": 1,
            "B935": 1,
        },
    }


def read(stem):
    return pickle.load(open(HERE / f"curves_{stem}.pkl", "rb"))


def build():
    src = {k: read(v) for k, v in OTHER.items()}
    for ver, slots in WIDE.items():
        for slot, stem in slots.items():
            src[f"W{ver}_{slot}"] = read(stem)
    days = sorted(set.intersection(*[set(c) for c in src.values()]))
    arr = {}
    for k, c in src.items():
        a = np.zeros((len(days), N))
        for i, d in enumerate(days):
            rec = c[d]
            curve = rec["curve"]
            if not curve:
                a[i, :] = rec["gross"]
                continue
            for m, val in curve:
                a[i, m] = val
            a[i, curve[-1][0] + 1 :] = rec["gross"]
        arr[k] = a
    return days, arr


def apply(path, X):
    if X is None:
        return path[-1], False
    hit = np.where(path <= -X)[0]
    return (path[hit[0]], True) if len(hit) else (path[-1], False)


def mdd(s):
    eq = np.cumsum(s)
    return float((eq - np.maximum.accumulate(np.maximum(eq, 0))).min())


def main():
    days, arr = build()
    idx = pd.DatetimeIndex(days)
    # check: the final value of each curve array is the strategy's gross for the day
    chk = (
        pd.read_csv(HERE.parent / "bl054" / "results" / "wide_0932.csv", parse_dates=["day"])
        .set_index("day")
        .net
    )
    assert np.allclose(arr["WOTM1_0932"][:, -1], chk.loc[idx].values), "curve final != backtest P&L"
    print(f"days: {len(days)}  {days[0]} -> {days[-1]}   (curve check vs BL-054 results: ok)")
    rows = []
    for ver in WIDE:
        for mname, lots in mixes(ver).items():
            comb = sum(n * arr[k] for k, n in lots.items())
            base = comb[:, -1]
            res = {}
            for X in LEVELS:
                out = [apply(comb[i], X) for i in range(len(days))]
                pnl = pd.Series([o[0] for o in out], index=idx)
                st = np.array([o[1] for o in out])
                wk = pnl.groupby(pnl.index.to_period("W")).sum()
                res[X] = pnl
                rows.append(
                    dict(
                        ver=ver,
                        mix=mname,
                        lots=sum(lots.values()),
                        level="none" if X is None else X,
                        total=pnl.sum(),
                        maxDD=mdd(pnl.values),
                        worst_day=pnl.min(),
                        worst_wk=wk.min(),
                        win=100 * (pnl > 0).mean(),
                        stopped=int(st.sum()),
                        whipsaw=int((pd.Series(base, index=idx)[st] > pnl[st]).sum()),
                    )
                )
            if mname.startswith("B4") and ver == "OTM1":
                w = pd.Series(base, index=idx).nsmallest(10)
                print("\nB4 (OTM1) 10 worst days: unstopped | 8k | 10k | 12.5k")
                for d in w.index:
                    i = idx.get_loc(d)
                    print(
                        f"  {d.strftime('%d-%b-%y %a')} | {base[i]:>8,.0f} | "
                        + " | ".join(f"{res[X].iloc[i]:>8,.0f}" for X in LEVELS[1:])
                    )
    df = pd.DataFrame(rows)
    df.to_csv(HERE / "summary2.csv", index=False)
    print("\n=== NO STOP: total / max drawdown / worst day (all combinations) ===")
    nn = df[df.level == "none"].pivot(
        index="mix", columns="ver", values=["total", "maxDD", "worst_day"]
    )
    for m in ("total", "maxDD", "worst_day"):
        print(f"\n{m}")
        print(nn[m][list(WIDE)].to_string(float_format=lambda x: f"{x:,.0f}"))
    print(
        "\n=== WITH STOP: change vs the same combination without a stop (total %, maxDD %) and 'helps' (DD>=25% smaller AND total<=10% lower) ==="
    )
    for ver in WIDE:
        print(f"\n--- Widesl version {ver} ---")
        print(
            f"{'mix':28s}{'lots':>5s} {'level':>7s} {'total':>10s} {'d tot':>7s} {'maxDD':>10s} {'d DD':>7s} {'worst day':>10s} {'stopped':>7s} {'whipsaw':>7s}  helps"
        )
        for mname in mixes(ver):
            b = df[(df.ver == ver) & (df.mix == mname) & (df.level == "none")].iloc[0]
            print(
                f"{mname:28s}{int(b.lots):>5d} {'none':>7s} {b.total:>10,.0f} {'':>7s} {b.maxDD:>10,.0f} {'':>7s} {b.worst_day:>10,.0f}"
            )
            for X in LEVELS[1:]:
                r = df[(df.ver == ver) & (df.mix == mname) & (df.level == X)].iloc[0]
                helps = r.maxDD >= 0.75 * b.maxDD and r.total >= 0.90 * b.total
                print(
                    f"{'':28s}{'':>5s} {X:>7,d} {r.total:>10,.0f} {100 * (r.total / b.total - 1):>+6.1f}% {r.maxDD:>10,.0f} {100 * (r.maxDD / b.maxDD - 1):>+6.1f}% {r.worst_day:>10,.0f} {int(r.stopped):>7d} {int(r.whipsaw):>7d}  {'YES' if helps else '-'}"
                )


if __name__ == "__main__":
    main()
