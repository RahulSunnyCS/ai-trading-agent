"""BL-054 Phase 2: weekly rotation vs the pre-registered comparators.

The rule, comparators and pass/kill conditions are the ones fixed in
backlog/BL-054-weekly-strategy-slot-rotation.md before any run. Do not edit them here after
seeing a result; add a new dated block in the item instead.

    uv run python research/bl054/evaluate.py
"""

from __future__ import annotations

from datetime import timedelta
from pathlib import Path

import numpy as np
import pandas as pd

HERE = Path(__file__).parent
RES = HERE / "results"
N_RUNS = 1000
SEED = 54
CORE = 5
BUY_LOTS = 2
W_NEW, W_OLD = 2 / 3, 1 / 3


def load() -> pd.DataFrame:
    cols = {}
    for f in sorted(RES.glob("*_[0-9][0-9][0-9][0-9].csv")):
        cols[f.stem] = pd.read_csv(f, parse_dates=["day"]).set_index("day").net
    df = pd.DataFrame(cols).sort_index()
    assert df.shape[1] == 33, f"expected 33 variants, found {df.shape[1]}"
    assert not df.isna().any().any(), "variants do not cover the same days"
    return df


def week_key(idx: pd.DatetimeIndex) -> pd.Series:
    return pd.Series([d - timedelta(days=d.weekday()) for d in idx], index=idx)


def max_dd(daily: pd.Series | np.ndarray) -> float:
    eq = np.cumsum(np.asarray(daily, dtype=float))
    return float((eq - np.maximum.accumulate(np.maximum(eq, 0))).min()) if len(eq) else 0.0


def pick_core(
    score: pd.Series, wide: list[str], dirs: list[str], min_wide: int
) -> tuple[list[str], bool]:
    pool = wide + dirs
    ranked = sorted(pool, key=lambda v: (-score[v], v))
    core = ranked[:CORE]
    overridden = False
    n_wide = sum(v in wide for v in core)
    if n_wide < min_wide:
        overridden = True
        spare = [v for v in ranked if v in wide and v not in core]
        while n_wide < min_wide:
            drop = min((v for v in core if v in dirs), key=lambda v: (score[v], v))
            core.remove(drop)
            core.append(spare.pop(0))
            n_wide += 1
    return core, overridden


def rotation(df: pd.DataFrame, min_wide: int):
    wk = week_key(df.index)
    weeks = sorted(wk.unique())
    W = df.groupby(wk).sum()
    wide = [c for c in df.columns if c.startswith("wide_")]
    dirs = [c for c in df.columns if c.startswith("dir_")]
    buys = [c for c in df.columns if c.startswith("buy_")]
    daily_parts, plan = [], []
    for i in range(2, len(weeks)):
        mon = weeks[i]
        score = W_NEW * W.loc[weeks[i - 1]] + W_OLD * W.loc[weeks[i - 2]]
        assert (
            df.index[wk.values < mon].max() < mon
        )  # look-ahead check: only earlier days feed the score
        core, overridden = pick_core(score, wide, dirs, min_wide)
        buy_rank = sorted(buys, key=lambda v: (-score[v], v))
        buy_on = score[buy_rank[0]] > 0
        buy_pick = buy_rank[:BUY_LOTS] if buy_on else []
        days = df.index[wk.values == mon]
        block = df.loc[days, core + buy_pick].sum(axis=1)
        daily_parts.append(block)
        # the same 2 Buy lots as if the trigger had been ignored (for the add-on report)
        alt = df.loc[days, buy_rank[:BUY_LOTS]].sum(axis=1).sum()
        plan.append(
            dict(
                week=mon.date(),
                core=core,
                n_wide=sum(v in wide for v in core),
                overridden=overridden,
                buy_on=buy_on,
                buy=buy_pick,
                week_pnl=block.sum(),
                buy_pnl_if_added=alt,
                buy_score=score[buy_rank[0]],
                lots=CORE + len(buy_pick),
            )
        )
        # rank persistence: this week's score vs next week's P&L, across variants
        plan[-1]["rho_core"] = score[wide + dirs].rank().corr(W.loc[mon, wide + dirs].rank())
        plan[-1]["rho_buy"] = score[buys].rank().corr(W.loc[mon, buys].rank())
    return pd.concat(daily_parts), pd.DataFrame(plan), weeks


def stats(daily: pd.Series, wk_index) -> dict:
    w = daily.groupby(week_key(daily.index)).sum()
    return {
        "total": daily.sum(),
        "avg/week": w.mean(),
        "win wk %": 100 * (w > 0).mean(),
        "max DD": max_dd(daily),
        "worst wk": w.min(),
    }


def random_runs(df, plan: pd.DataFrame, min_wide: int, weeks):
    rng = np.random.default_rng(SEED)
    wk = week_key(df.index)
    wide = [c for c in df.columns if c.startswith("wide_")]
    dirs = [c for c in df.columns if c.startswith("dir_")]
    buys = [c for c in df.columns if c.startswith("buy_")]
    pool = wide + dirs
    wide_ix = np.array([c in wide for c in pool])
    blocks = []
    for mon, p in zip(plan.week, plan.itertuples(), strict=True):
        days = df.index[wk.values == pd.Timestamp(mon)]
        blocks.append((df.loc[days, pool].to_numpy(), df.loc[days, buys].to_numpy(), p.buy_on))
    totals, dds = np.empty(N_RUNS), np.empty(N_RUNS)
    for r in range(N_RUNS):
        parts = []
        for core_blk, buy_blk, buy_on in blocks:
            while True:
                ix = rng.choice(len(pool), CORE, replace=False)
                if wide_ix[ix].sum() >= min_wide:
                    break
            d = core_blk[:, ix].sum(axis=1)
            if buy_on:
                d = d + buy_blk[:, rng.choice(len(buys), BUY_LOTS, replace=False)].sum(axis=1)
            parts.append(d)
        all_d = np.concatenate(parts)
        totals[r], dds[r] = all_d.sum(), max_dd(all_d)
    return totals, dds


def comparators(df, rot_daily: pd.Series, plan: pd.DataFrame):
    wk = week_key(df.index)
    wide = [c for c in df.columns if c.startswith("wide_")]
    dirs = [c for c in df.columns if c.startswith("dir_")]
    buys = [c for c in df.columns if c.startswith("buy_")]
    days = rot_daily.index
    buy_weeks = set(pd.Timestamp(w) for w in plan.week[plan.buy_on])
    in_buy_week = wk.loc[days].isin(buy_weeks)
    e = CORE * df.loc[days, wide + dirs].mean(axis=1) + np.where(
        in_buy_week, BUY_LOTS * df.loc[days, buys].mean(axis=1), 0
    )
    t_dir = (
        pd.read_csv(RES / "nifty_dir_924_itm1_sl21_recost.csv", parse_dates=["day"])
        .set_index("day")
        .net
    )
    t_buy = (
        pd.read_csv(RES / "nifty_buy_range_breakout.csv", parse_dates=["day"]).set_index("day").net
    )
    w917, d924, b935 = df.loc[days, "wide_0917"], t_dir.loc[days], t_buy.loc[days]
    t = 2 * w917 + 2 * d924 + 1 * b935
    bench = {
        "B1 5xWide": 5 * w917,
        "B2 3xWide+2xDir": 3 * w917 + 2 * d924,
        "B3 4xWide+Dir+Buy": 4 * w917 + d924 + b935,
    }
    return pd.Series(e, index=days), t, bench


def report(df: pd.DataFrame, min_wide: int, verdict: bool) -> None:
    rot, plan, weeks = rotation(df, min_wide)
    e, t, bench = comparators(df, rot, plan)
    totals, dds = random_runs(df, plan, min_wide, weeks)
    lots = {
        "ROTATION": plan.lots.mean(),
        "E equal-weight": plan.lots.mean(),
        "T 2+2+1": 5,
        "B1 5xWide": 5,
        "B2 3xWide+2xDir": 5,
        "B3 4xWide+Dir+Buy": 6,
    }
    S = pd.DataFrame(
        {
            "ROTATION": stats(rot, None),
            "E equal-weight": stats(e, None),
            "T 2+2+1": stats(t, None),
            **{k: stats(v, None) for k, v in bench.items()},
        }
    ).T
    S["lots/wk"] = pd.Series(lots)
    S["avg/wk per lot"] = S["avg/week"] / S["lots/wk"]
    p90, p50 = np.percentile(totals, 90), np.percentile(totals, 50)
    rank_in_R = 100 * (totals < rot.sum()).mean()
    print(
        f"\n{'=' * 78}\nminimum Widesl in core = {min_wide}   ({'VERDICT RUN' if verdict else 'sensitivity, not part of verdict'})\n{'=' * 78}"
    )
    print(
        f"evaluated {len(plan)} weeks, {len(rot)} days: {rot.index.min().date()} -> {rot.index.max().date()}; "
        f"Buy add-on fired in {int(plan.buy_on.sum())} weeks; lots/week avg {plan.lots.mean():.2f}"
    )
    print(S.to_string(float_format=lambda x: f"{x:,.1f}" if abs(x) < 100 else f"{x:,.0f}"))
    print(
        f"R random picks (n={N_RUNS}): total P50 {p50:,.0f} | P90 {p90:,.0f} | max {totals.max():,.0f}; "
        f"maxDD P50 {np.percentile(dds, 50):,.0f}.  Rotation beats {rank_in_R:.0f}% of random runs"
    )
    c1 = rot.sum() >= p90
    c2 = rot.sum() > e.sum() and max_dd(rot) >= max_dd(e)
    c3s = {k: (rot.sum() > v.sum() and max_dd(rot) >= max_dd(v)) for k, v in bench.items()}
    c3 = all(c3s.values())
    print(
        f"(1) total >= R P90: {c1} | (2) beats E on total and DD: {c2} | (3) beats every benchmark on total and DD: {c3}  {c3s}"
    )
    if verdict:
        print("VERDICT:", "PASS" if (c1 and c2 and c3) else ("KILL" if not c1 else "INCONCLUSIVE"))
    print(
        f"\nrank persistence (score this week vs next week's P&L, Spearman across variants): "
        f"Widesl/Dir mean {plan.rho_core.mean():+.3f}, positive in {100 * (plan.rho_core > 0).mean():.0f}% of weeks | "
        f"Buy mean {plan.rho_buy.mean():+.3f}, positive in {100 * (plan.rho_buy > 0).mean():.0f}% of weeks"
    )
    print(
        f"core mix: Widesl count per week {plan.n_wide.value_counts().sort_index().to_dict()}; "
        f"at-least-{min_wide} override fired in {int(plan.overridden.sum())} weeks"
    )
    fired, idle = plan[plan.buy_on], plan[~plan.buy_on]
    print(
        f"Buy add-on: P&L of the 2 Buy lots in the {len(fired)} weeks they were added: {fired.buy_pnl_if_added.sum():,.0f} "
        f"(avg {fired.buy_pnl_if_added.mean():,.0f}/wk); same rule's 2 lots in the {len(idle)} weeks it stayed out: "
        f"{idle.buy_pnl_if_added.sum():,.0f} (avg {idle.buy_pnl_if_added.mean():,.0f}/wk)"
    )
    top = pd.Series([v for c in plan.core for v in c]).value_counts().head(8)
    print("most-picked core variants:", ", ".join(f"{k}x{v}" for k, v in top.items()))
    if verdict:
        wide = [c for c in df.columns if c.startswith("wide_")]
        dirs = [c for c in df.columns if c.startswith("dir_")]
        ev = df.loc[rot.index]
        hind, _ = pick_core(ev.sum(), wide, dirs, min_wide)
        print(
            f"HINDSIGHT ceiling (look-ahead, best fixed 5 over the window): {ev[hind].sum(axis=1).sum():,.0f} -> {hind}"
        )
        plan.assign(core=plan.core.map(",".join), buy=plan.buy.map(",".join)).to_csv(
            HERE / "weekly_picks_min2.csv", index=False
        )


def main() -> None:
    df = load()
    print(
        f"variants: {df.shape[1]} | days: {len(df)} | {df.index.min().date()} -> {df.index.max().date()}"
    )
    live_f = RES / "nifty_widesl_917_otm1.csv"
    if live_f.exists():
        live = pd.read_csv(live_f, parse_dates=["day"]).set_index("day").net
        print(
            "check wide_0917 == live nifty_widesl_917_otm1 per day:",
            bool(np.allclose(df.wide_0917, live.loc[df.index])),
        )
    print("\nwhole-window, 1 lot, per variant (total / maxDD):")
    for fam in ("wide", "dir", "buy"):
        cols = [c for c in df.columns if c.startswith(fam + "_")]
        print(
            f"  {fam}: "
            + " | ".join(f"{c[-4:]} {df[c].sum():,.0f}/{max_dd(df[c]):,.0f}" for c in cols)
        )
    report(df, 2, verdict=True)
    report(df, 3, verdict=False)


if __name__ == "__main__":
    main()
