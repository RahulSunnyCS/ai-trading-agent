"""BL-057: daily four-criteria rotation over the 66 NIFTY + SENSEX start-time variants.

Rule, comparators and pass/kill as pre-registered in
backlog/BL-057-daily-four-criteria-rotation.md. Do not edit after a result is seen.

    uv run --with pandas --with numpy --with duckdb python research/bl057/rotate.py
"""

from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import pandas as pd

HERE = Path(__file__).parent
sys.path.insert(0, str(HERE.parent / "bl056"))
import analyse as A  # noqa: E402  (day_features, load, VIX bands, WD)

WINDOW_FROM = "2025-09-01"
WARMUP = 63
LOOKBACKS = [(5, 0.4), (21, 0.3), (63, 0.3)]
W_CRIT = {"recent": 0.33, "weekday": 0.25, "dte": 0.25, "vix": 0.17}
BUY_TOP = 10


def _arg(name, default):
    return int(sys.argv[sys.argv.index(name) + 1]) if name in sys.argv else default


CORE = _arg("--core", 5)  # 5 = first block; 3 = small-book block
BUY_MAX = _arg("--buy-max", 2)  # 2 = first block; 1 = small-book block
N_RUNS, SEED = 1000, 57
# Case A's Widesl minimum: 2 is the first pre-registered block; 3 is the later block (BL-057).
MIN_WIDE = int(sys.argv[sys.argv.index("--min-wide") + 1]) if "--min-wide" in sys.argv else 2


def load_all():
    frames, feats = [], {}
    for u, pfx in (("NIFTY", "N_"), ("SENSEX", "S_")):
        df = A.load(u)
        df = df[df.index >= pd.Timestamp(WINDOW_FROM)]
        f = A.day_features(u, df.index)
        wk = f.weekday.isin(A.WD).values
        df, f = df[wk], f[wk]
        df.columns = [pfx + c for c in df.columns]
        frames.append(df)
        feats[u] = f
    # keep only the days both indices have (two days each side are missing one index's data)
    common = frames[0].index.intersection(frames[1].index)
    dropped = sorted(set(frames[0].index.symmetric_difference(frames[1].index)).difference(common))
    print("days in one index only, dropped:", [d.strftime("%d-%b-%y") for d in dropped])
    frames = [x.loc[common] for x in frames]
    feats = {u: x.loc[common] for u, x in feats.items()}
    P = pd.concat(frames, axis=1)
    assert P.shape[1] == 66 and not P.isna().any().any()
    assert feats["NIFTY"].index.equals(feats["SENSEX"].index)
    f = feats["NIFTY"][["weekday", "vix_band"]].copy()
    f["dte_N"] = feats["NIFTY"].dte_label
    f["dte_S"] = feats["SENSEX"].dte_label
    return P, f


def skewed_fit(P: np.ndarray, match: np.ndarray, i: int) -> np.ndarray:
    """P: days x variants; match: days x variants bool (day's attribute == day i's attribute,
    per variant); average P&L on matching days in the last 5 / 21 / 63 days, weights 40/30/30
    renormalised over the windows that have a matching day."""
    num = np.zeros(P.shape[1])
    den = np.zeros(P.shape[1])
    for n, w in LOOKBACKS:
        m = match[i - n : i]
        cnt = m.sum(axis=0)
        avg = np.where(cnt > 0, (P[i - n : i] * m).sum(axis=0) / np.maximum(cnt, 1), 0.0)
        num += w * avg * (cnt > 0)
        den += w * (cnt > 0)
    return np.where(den > 0, num / np.maximum(den, 1e-12), 0.0)


def pct_rank(x: np.ndarray) -> np.ndarray:
    return pd.Series(x).rank(pct=True, method="average").to_numpy()


def mdd(s) -> float:
    eq = np.cumsum(np.asarray(s, dtype=float))
    return float((eq - np.maximum.accumulate(np.maximum(eq, 0))).min())


def main() -> None:
    P, f = load_all()
    names = list(P.columns)
    Pv = P.to_numpy()
    is_wide = np.array([n.split("_")[1] == "wide" for n in names])
    is_dir = np.array([n.split("_")[1] == "dir" for n in names])
    is_buy = np.array([n.split("_")[1] == "buy" for n in names])
    is_nifty = np.array([n.startswith("N_") for n in names])
    core_pool = np.where(~is_buy)[0]
    wd = f.weekday.to_numpy()
    vb = f.vix_band.astype(str).to_numpy()
    dte = np.where(
        is_nifty[None, :], f.dte_N.to_numpy()[:, None], f.dte_S.to_numpy()[:, None]
    )  # days x variants
    days = P.index
    print(
        f"66 variants, {len(days)} weekdays {days[0].date()} -> {days[-1].date()}; selection from day {WARMUP + 1} = {days[WARMUP].date()}"
    )

    crit_names = list(W_CRIT)
    pers = {k: [] for k in crit_names + ["composite"]}
    picks_A, picks_B, buy_days, rows = [], [], [], []
    for i in range(WARMUP, len(days)):
        # look-ahead: everything below indexes rows < i, except vb[i] / wd[i] / dte[i] (the day's own attributes)
        recent = (2 / 3) * Pv[i - 5 : i].sum(axis=0) + (1 / 3) * Pv[i - 10 : i - 5].sum(axis=0)
        crit = {
            "recent": recent,
            "weekday": skewed_fit(Pv, (wd[:, None] == wd[i]).repeat(66, axis=1), i),
            "dte": skewed_fit(Pv, dte == dte[i][None, :], i),
            "vix": skewed_fit(Pv, (vb[:, None] == vb[i]).repeat(66, axis=1), i),
        }
        comp = sum(W_CRIT[k] * pct_rank(crit[k]) for k in crit_names)
        today = Pv[i]
        for k in crit_names:
            pers[k].append(pd.Series(crit[k]).rank().corr(pd.Series(today).rank()))
        pers["composite"].append(pd.Series(comp).rank().corr(pd.Series(today).rank()))
        order = sorted(core_pool, key=lambda v: (-comp[v], names[v]))
        core_b = order[:CORE]
        core_a = list(core_b)
        overridden = False
        n_wide = int(is_wide[core_a].sum())
        if n_wide < MIN_WIDE:
            overridden = True
            spare = [v for v in order if is_wide[v] and v not in core_a]
            while n_wide < MIN_WIDE:
                drop = min((v for v in core_a if is_dir[v]), key=lambda v: (comp[v], names[v]))
                core_a.remove(drop)
                core_a.append(spare.pop(0))
                n_wide += 1
        top10 = sorted(range(66), key=lambda v: (-comp[v], names[v]))[:BUY_TOP]
        buy = [v for v in top10 if is_buy[v]][:BUY_MAX]
        picks_A.append(core_a)
        picks_B.append(core_b)
        buy_days.append(buy)
        rows.append(
            dict(
                day=days[i],
                pnl_A=today[core_a].sum() + today[buy].sum(),
                pnl_B=today[core_b].sum() + today[buy].sum(),
                lots=CORE + len(buy),
                n_buy=len(buy),
                buy_pnl=today[buy].sum(),
                buy_alt=today[
                    [v for v in sorted(np.where(is_buy)[0], key=lambda v: -comp[v])][:BUY_MAX]
                ].sum(),
                wide_A=int(is_wide[core_a].sum()),
                wide_B=int(is_wide[core_b].sum()),
                nifty_A=int(is_nifty[core_a].sum()),
                overridden=overridden,
                changes_A=np.nan if len(picks_A) < 2 else len(set(core_a) ^ set(picks_A[-2])) / 2,
            )
        )
    R = pd.DataFrame(rows).set_index("day")
    sel = np.arange(WARMUP, len(days))
    today_all = Pv[sel]

    # comparators
    buy_lots = R.n_buy.to_numpy()
    E = CORE * today_all[:, ~is_buy].mean(axis=1) + buy_lots * today_all[:, is_buy].mean(axis=1)
    b54 = HERE.parent / "bl054" / "results"
    live_w = (
        pd.read_csv(b54 / "nifty_widesl_917_otm1.csv", parse_dates=["day"]).set_index("day").net
    )
    live_d = (
        pd.read_csv(b54 / "nifty_dir_924_itm1_sl21_recost.csv", parse_dates=["day"])
        .set_index("day")
        .net
    )
    nw, nd = {5: (3, 2), 3: (2, 1)}[
        CORE
    ]  # the live mix at this size: 3W+2D (5 lots) or 2W+1D (3 lots)
    B2 = (nw * live_w + nd * live_d).reindex(R.index).to_numpy()
    rng = np.random.default_rng(SEED)
    pool_all = core_pool
    pool_b = np.where(is_buy)[0]

    def random_total(min_wide: int):
        tot, dd = np.empty(N_RUNS), np.empty(N_RUNS)
        for r in range(N_RUNS):
            d = np.empty(len(sel))
            for j, i in enumerate(sel):
                while True:
                    ix = rng.choice(pool_all, CORE, replace=False)
                    if is_wide[ix].sum() >= min_wide:
                        break
                v = Pv[i, ix].sum()
                if buy_lots[j]:
                    v += Pv[i, rng.choice(pool_b, buy_lots[j], replace=False)].sum()
                d[j] = v
            tot[r], dd[r] = d.sum(), mdd(d)
        return tot, dd

    def stats(s):
        s = np.asarray(s)
        wk = pd.Series(s, index=R.index).groupby(R.index.to_period("W")).sum()
        return dict(
            total=s.sum(),
            avg_day=s.mean(),
            win_pct=100 * (s > 0).mean(),
            maxDD=mdd(s),
            worst_day=s.min(),
            worst_wk=wk.min(),
        )

    lots_avg = R.lots.mean()
    print(
        f"\nselection days: {len(R)}; Buy add-on fired on {int((R.n_buy > 0).sum())} days "
        f"({int((R.n_buy == 1).sum())} with 1 lot, {int((R.n_buy == 2).sum())} with 2); lots/day avg {lots_avg:.2f}"
    )
    print("per-lot-day = avg/day divided by that line's avg lots/day")
    for case, col, min_w in (
        (f"A (>={MIN_WIDE} Widesl)", "pnl_A", MIN_WIDE),
        ("B (no minimum)", "pnl_B", 0),
    ):
        tot, dd = random_total(min_w)
        S = pd.DataFrame(
            {
                f"ROTATION case {case}": stats(R[col]),
                "E equal-weight": stats(E),
                f"B live {nw}xW917+{nd}xD924 ({CORE} lots)": stats(B2),
            }
        ).T
        S["lots/day"] = [lots_avg, lots_avg, CORE]
        S["per-lot-day"] = S.avg_day / S["lots/day"]
        print(
            f"\n{'=' * 100}\nCASE {case}{'   <- VERDICT CASE' if min_w == MIN_WIDE else '   (reported only)'}\n{'=' * 100}"
        )
        print(S.to_string(float_format=lambda x: f"{x:,.0f}" if abs(x) >= 100 else f"{x:,.2f}"))
        p90, p50 = np.percentile(tot, 90), np.percentile(tot, 50)
        total = R[col].sum()
        d = mdd(R[col])
        c1 = total >= p90
        c2 = total > E.sum() and d >= mdd(E)
        c3 = total > B2.sum() and d >= mdd(B2)
        print(
            f"R random (n={N_RUNS}): total P50 {p50:,.0f} | P90 {p90:,.0f} | max {tot.max():,.0f}; maxDD P50 {np.percentile(dd, 50):,.0f}; "
            f"rotation beats {100 * (tot < total).mean():.0f}% of random runs"
        )
        print(
            f"(1) total >= R P90: {c1} | (2) beats E on total and DD: {c2} | (3) beats B2 on total and DD: {c3}"
        )
        if min_w == MIN_WIDE:
            print(
                "VERDICT:", "PASS" if (c1 and c2 and c3) else ("KILL" if not c1 else "INCONCLUSIVE")
            )

    print(
        "\n--- signal in each criterion: Spearman(criterion rank, same-day P&L) across the 66, averaged over selection days ---"
    )
    for k, v in pers.items():
        v = np.array(v)
        print(
            f"  {k:10s} mean {np.nanmean(v):+.3f}   positive on {100 * np.nanmean(v > 0):.0f}% of days"
        )
    print(
        f"\n--- picks: case A Widesl count per day {R.wide_A.value_counts().sort_index().to_dict()}, override fired {int(R.overridden.sum())} days; "
        f"case B Widesl count {R.wide_B.value_counts().sort_index().to_dict()}"
    )
    print(
        f"    NIFTY share of core picks (case A): {100 * R.nifty_A.sum() / (CORE * len(R)):.0f}%; "
        f"core members changed per day (case A): avg {R.changes_A.mean():.2f} of 5"
    )
    fired = R[R.n_buy > 0]
    idle = R[R.n_buy == 0]
    print(
        f"    Buy add-on: on the {len(fired)} days it fired its lots made {fired.buy_pnl.sum():,.0f} (avg {fired.buy_pnl.mean():,.0f}/day); "
        f"the top-2 Buy variants on the {len(idle)} days it stayed out would have made {idle.buy_alt.sum():,.0f} (avg {idle.buy_alt.mean():,.0f}/day)"
    )
    counts = pd.Series([names[v] for c in picks_A for v in c]).value_counts().head(10)
    print(
        "    most-picked core variants (case A):", ", ".join(f"{k}x{v}" for k, v in counts.items())
    )
    hind = sorted(core_pool, key=lambda v: -today_all[:, v].sum())[:CORE]
    print(
        f"    HINDSIGHT ceiling (look-ahead, best fixed 5 over the selection days): {today_all[:, hind].sum():,.0f} -> {[names[v] for v in hind]}"
    )
    R.assign(
        core_A=[",".join(names[v] for v in c) for c in picks_A],
        buy=[",".join(names[v] for v in b) for b in buy_days],
    ).to_csv(
        HERE
        / (
            "daily_picks.csv"
            if (MIN_WIDE, CORE, BUY_MAX) == (2, 5, 2)
            else f"daily_picks_min{MIN_WIDE}_core{CORE}_buy{BUY_MAX}.csv"
        )
    )


if __name__ == "__main__":
    main()
