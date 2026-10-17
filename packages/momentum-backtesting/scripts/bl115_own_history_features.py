"""BL-115 Phase 1: do a stock's own-history numbers separate the winning picks from the losing ones?

The rule is `search_spaces/bl115_criteria.json` (committed before this ran). This script:

1. re-runs each sleeve of Trio Fortnightly and Four Sectors Monthly, No Tilt with its saved settings
   and data ending 2022-12-30, and takes every closed position as a trade;
2. computes seven features at the decision week (the Friday before the fill) from data up to that
   Friday only;
3. scores each feature against the trade's return over Nifty 500 TRI (rank correlation with a
   block bootstrap over decision weeks, and the loser share of its worst fifth), plus the
   report-only views;
4. writes `search_spaces/bl115_result.json` and the tables under `data/search/bl115/`.

Run from packages/momentum-backtesting:  uv run python scripts/bl115_own_history_features.py
"""

from __future__ import annotations

import json
import math
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
CRITERIA = json.loads((ROOT / "search_spaces" / "bl115_criteria.json").read_text())
END = CRITERIA["windows"]["phase_1"]["end"]
START = CRITERIA["windows"]["phase_1"]["start"]
FIXED_HORIZON_LAST_FILL = "2022-09-30"
BOOTSTRAPS = 2000
SEED = 115
T_MIN = 3.0
LOSER_GAP = 0.10
BANDS = ((0.019, 0.0205), (0.049, 0.0505), (0.099, 0.1005), (0.199, 0.2005))
FEATURES = {
    "F0_avg_weekly_score": "+",
    "F1_steadiness": "+",
    "F2_smoothness": "+",
    "F3_distance_below_52w_high": "+",
    "F4_turnover_expansion": "+",
    "F5_circuit_days": "-",
    "F6_spike_dependence": "-",
}


# --- features (pure: each reads only data up to and including `d`) ------------------------------


def weekly_features(p: pd.Series, d: pd.Timestamp, lookbacks: list[int]) -> dict[str, float]:
    """F0-F3 and the report-only components from one stock's weekly prices `p` (Friday index)."""
    p = p.loc[:d].dropna()
    out: dict[str, float] = {}
    if p.empty or p.index[-1] != d:
        return {
            k: math.nan
            for k in (
                "F0_avg_weekly_score",
                "F1_steadiness",
                "F2_smoothness",
                "F3_distance_below_52w_high",
                "vol26",
            )
        }
    now = p.iloc[-1]

    def back(k: int) -> float:
        return p.iloc[-1 - k] if len(p) > k else math.nan

    parts = []
    for k in lookbacks:
        r = now / back(k) - 1
        out[f"avg_weekly_{k}w"] = 100 * r / k
        parts.append(100 * r / k)
    out["F0_avg_weekly_score"] = float(np.sum(parts)) if all(np.isfinite(parts)) else math.nan
    last27 = p.iloc[-27:]
    weekly = last27.pct_change().dropna()
    out["F1_steadiness"] = float((weekly > 0).mean()) if len(weekly) == 26 else math.nan
    window = p.iloc[-27:]
    out["F2_smoothness"] = (
        float((window / window.cummax() - 1).min()) if len(window) == 27 else math.nan
    )
    year = p.iloc[-53:]
    out["F3_distance_below_52w_high"] = float(now / year.max() - 1) if len(year) == 53 else math.nan
    out["vol26"] = float(weekly.std()) if len(weekly) == 26 else math.nan
    return out


def daily_features(
    move: pd.Series, turnover: pd.Series, p: pd.Series, d: pd.Timestamp
) -> dict[str, float]:
    """F4-F6 from one stock's daily split-adjusted moves, daily rupee turnover and weekly prices."""
    move = pd.to_numeric(move.loc[:d], errors="coerce").astype(float).dropna()
    turnover = pd.to_numeric(turnover.loc[:d], errors="coerce").astype(float).dropna()
    out: dict[str, float] = {}
    t20, t130 = turnover.iloc[-20:], turnover.iloc[-130:]
    out["F4_turnover_expansion"] = (
        float(t20.mean() / t130.mean()) if len(t130) == 130 and t130.mean() > 0 else math.nan
    )
    m65 = move.iloc[-65:]
    if len(m65) == 65:
        on_edge = np.zeros(len(m65), dtype=bool)
        for lo, hi in BANDS:
            on_edge |= m65.abs().between(lo, hi).to_numpy()
        out["F5_circuit_days"] = float(on_edge.sum())
    else:
        out["F5_circuit_days"] = math.nan
    pw = p.loc[:d].dropna()
    rise = math.log(pw.iloc[-1] / pw.iloc[-14]) if len(pw) >= 14 and pw.index[-1] == d else math.nan
    if len(m65) == 65 and np.isfinite(rise) and rise >= 0.05:
        out["F6_spike_dependence"] = float(np.log1p(m65).max() / rise)
    else:
        out["F6_spike_dependence"] = math.nan
    return out


# --- statistics -----------------------------------------------------------------------------------


def spearman(x: np.ndarray, y: np.ndarray) -> float:
    if len(x) < 3:
        return math.nan
    rx, ry = pd.Series(x).rank().to_numpy(), pd.Series(y).rank().to_numpy()
    if rx.std() == 0 or ry.std() == 0:
        return math.nan
    return float(np.corrcoef(rx, ry)[0, 1])


def bootstrap_t(frame: pd.DataFrame, feature: str, outcome: str, rng: np.random.Generator) -> tuple:
    """(rho, t, n): Spearman over the rows, its spread from resampling decision weeks."""
    data = frame[["decision_week", feature, outcome]].dropna()
    rho = spearman(data[feature].to_numpy(), data[outcome].to_numpy())
    if not np.isfinite(rho):
        return rho, math.nan, len(data)
    groups = [g.index.to_numpy() for _, g in data.groupby("decision_week")]
    f, o = data[feature].to_numpy(), data[outcome].to_numpy()
    pos = {idx: i for i, idx in enumerate(data.index)}
    groups = [np.array([pos[i] for i in g]) for g in groups]
    draws = []
    for _ in range(BOOTSTRAPS):
        pick = rng.integers(0, len(groups), len(groups))
        rows = np.concatenate([groups[i] for i in pick])
        draws.append(spearman(f[rows], o[rows]))
    sd = float(np.nanstd(draws))
    return rho, (rho / sd if sd > 0 else math.nan), len(data)


def worst_fifth(frame: pd.DataFrame, feature: str, sign: str) -> dict[str, float]:
    data = frame[[feature, "winner"]].dropna()
    if len(data) < 10:
        return {
            "worst_fifth_loser_share": math.nan,
            "overall_loser_share": math.nan,
            "gap": math.nan,
        }
    cut = data[feature].quantile(0.2 if sign == "+" else 0.8)
    worst = data[data[feature] <= cut] if sign == "+" else data[data[feature] >= cut]
    overall = float((~data["winner"]).mean())
    share = float((~worst["winner"]).mean())
    return {
        "worst_fifth_loser_share": share,
        "overall_loser_share": overall,
        "gap": share - overall,
        "worst_fifth_n": int(len(worst)),
    }


# --- data -----------------------------------------------------------------------------------------


def sleeves() -> dict[str, list[dict]]:
    from momentum_backtesting import runs_store, saved_identity
    from momentum_backtesting.db_read import read_catalog

    with read_catalog() as con:
        strategies = {s["id"]: s for s in runs_store.list_strategies(con)}
    out = {}
    for key, spec in CRITERIA["strategies"].items():
        if not isinstance(spec, dict):
            continue
        group = strategies[spec["group"]]
        members = {m["id"]: m for m in group["members"]}
        configs = []
        for run_id, fingerprint in spec["sleeves"].items():
            config = members[run_id]["config_full"]
            got = saved_identity.fingerprint("broad", config)
            if got != fingerprint:
                raise SystemExit(
                    f"{run_id}: settings fingerprint {got} != pre-registered {fingerprint}"
                )
            configs.append({"id": run_id, "config": config})
        out[key] = configs
    return out


def run_sleeve(config: dict):
    from momentum_backtesting import api

    req = api.BacktestRequest.model_validate({**config, "end": END, "split_fridays": False})
    ranking = api._broad_ranking(req)
    outcome = api._run_broad(req, ranking, api.DATA.get())
    return req, outcome.result, ranking


def nifty500() -> pd.Series:
    from momentum_backtesting import reference_benchmarks

    refs = reference_benchmarks.load_references()
    return refs["Nifty 500 TRI"].dropna()


def daily_inputs(column_to_base: dict[str, str]):
    """(moves by engine column, turnover by base symbol) for the traded stocks, to END."""
    from momentum_backtesting.categories import daily_moves
    from momentum_backtesting.db_read import stock_bars

    moves = daily_moves.daily_moves(column_to_base, "2015-06-01", END).move
    symbols = sorted(set(column_to_base.values()))
    with stock_bars() as con:
        rows = con.execute(
            "SELECT i.symbol, b.date, b.turnover FROM bars_1d_stock b JOIN instruments i "
            "USING (instrument_id) WHERE i.symbol IN (SELECT unnest(?)) AND b.series = 'EQ' "
            "AND b.date >= DATE '2015-06-01' AND b.date <= ?",
            [symbols, END],
        ).df()
    turnover = rows.pivot_table(index="date", columns="symbol", values="turnover", aggfunc="sum")
    turnover.index = pd.to_datetime(turnover.index)
    moves.index = pd.to_datetime(moves.index)
    return moves, turnover


# --- main -----------------------------------------------------------------------------------------


def main() -> None:
    from momentum_backtesting import analysis

    out_dir = ROOT / "data" / "search" / "bl115"
    out_dir.mkdir(parents=True, exist_ok=True)
    bench = nifty500()
    rng = np.random.default_rng(SEED)
    all_trades = []
    open_counts = {}

    plan = sleeves()
    for key, members in plan.items():
        lookbacks = CRITERIA["strategies"][key]["lookbacks_weeks"]
        for member in members:
            req, result, ranking = run_sleeve(member["config"])
            prices = ranking.prices
            if prices.index.max() > pd.Timestamp(END):
                prices = prices.loc[:END]
            weeks = prices.index
            closed = analysis.closed_trades(result)
            buys = result.trades[result.trades["action"] == "BUY"]
            closed_keys = {(r.asset, r.entry_week) for r in closed.itertuples()}
            open_counts[member["id"]] = int(
                sum((r.asset, r.week) not in closed_keys for r in buys.itertuples())
            )
            entry_rank = {(r.asset, r.week): r.rank for r in buys.itertuples()}
            for r in closed.itertuples():
                fill = pd.Timestamp(r.entry_week)
                exit_week = pd.Timestamp(r.exit_week)
                if fill < pd.Timestamp("2017-01-06") or exit_week > pd.Timestamp(END):
                    continue
                i = weeks.get_indexer([fill])[0]
                if i < 1:
                    continue
                d = weeks[i - 1]
                b0 = bench.asof(fill)
                b1 = bench.asof(exit_week)
                all_trades.append(
                    {
                        "strategy": key,
                        "sleeve": member["id"],
                        "asset": r.asset,
                        "base": ranking.column_to_base_symbol.get(r.asset, r.asset),
                        "decision_week": d,
                        "fill_week": fill,
                        "exit_week": exit_week,
                        "position_return": float(r.position_return),
                        "nifty500_return": float(b1 / b0 - 1),
                        "entry_rank": entry_rank.get((r.asset, r.entry_week)),
                        "lookbacks": tuple(lookbacks),
                        "_prices": prices.get(r.asset),
                    }
                )

    trades = pd.DataFrame(all_trades)
    trades["excess"] = trades["position_return"] - trades["nifty500_return"]
    trades["winner"] = trades["excess"] > 0

    column_to_base = dict(zip(trades["asset"], trades["base"], strict=True))
    moves, turnover = daily_inputs(column_to_base)

    feature_rows = []
    for t in trades.itertuples():
        p = trades.at[t.Index, "_prices"]
        if p is None:
            feature_rows.append({})
            continue
        row = weekly_features(p, t.decision_week, list(t.lookbacks))
        move = moves[t.asset] if t.asset in moves else pd.Series(dtype=float)
        turn = turnover[t.base] if t.base in turnover else pd.Series(dtype=float)
        row.update(daily_features(move, turn, p, t.decision_week))
        # report-only: F0 per unit of volatility, and the 13-week fixed-horizon outcome
        vol = row.get("vol26", math.nan)
        row["F0_per_vol"] = (
            row["F0_avg_weekly_score"] / (100 * vol) if vol and vol > 0 else math.nan
        )
        if t.fill_week <= pd.Timestamp(FIXED_HORIZON_LAST_FILL):
            weeks = p.dropna().index
            j = weeks.get_indexer([t.fill_week])[0]
            if j >= 0 and j + 13 < len(weeks) and weeks[j + 13] <= pd.Timestamp(END):
                w13 = weeks[j + 13]
                row["excess_13w"] = (p[w13] / p[t.fill_week] - 1) - (
                    bench.asof(w13) / bench.asof(t.fill_week) - 1
                )
        feature_rows.append(row)
    feats = pd.DataFrame(feature_rows, index=trades.index)
    trades = pd.concat([trades.drop(columns=["_prices"]), feats], axis=1)

    results: dict = {"criteria": "search_spaces/bl115_criteria.json", "strategies": {}}
    for key, group in trades.groupby("strategy"):
        res = {
            "trades": int(len(group)),
            "winners": int(group["winner"].sum()),
            "loser_share": float((~group["winner"]).mean()),
            "decision_weeks": int(group["decision_week"].nunique()),
            "open_at_end_excluded": int(sum(open_counts[m["id"]] for m in plan[key])),
            "features": {},
            "report_only": {},
        }
        for feature, sign in FEATURES.items():
            rho, t, n = bootstrap_t(group, feature, "excess", rng)
            fifth = worst_fifth(group, feature, sign)
            right_sign = np.isfinite(rho) and (rho > 0 if sign == "+" else rho < 0)
            a = bool(right_sign and np.isfinite(t) and abs(t) >= T_MIN)
            b = bool(np.isfinite(fifth["gap"]) and fifth["gap"] >= LOSER_GAP)
            winners = group.loc[group["winner"], feature].dropna()
            losers = group.loc[~group["winner"], feature].dropna()
            res["features"][feature] = {
                "expected_sign": sign,
                "n": n,
                "missing": int(group[feature].isna().sum()),
                "rho": rho,
                "t": t,
                "a_holds": a,
                **fifth,
                "b_holds": b,
                "winners_median": float(winners.median()) if len(winners) else math.nan,
                "losers_median": float(losers.median()) if len(losers) else math.nan,
            }
        # report-only views
        ro = res["report_only"]
        multi = group.groupby("decision_week").filter(lambda g: len(g) >= 2).copy()
        for feature in FEATURES:
            sub = multi[["decision_week", feature, "excess"]].dropna()
            sub = sub.groupby("decision_week").filter(lambda g: len(g) >= 2)
            if len(sub) >= 10:
                fx = sub[feature] - sub.groupby("decision_week")[feature].transform("mean")
                ox = sub["excess"] - sub.groupby("decision_week")["excess"].transform("mean")
                ro.setdefault("same_week_rho", {})[feature] = spearman(fx.to_numpy(), ox.to_numpy())
                ro.setdefault("same_week_n", {})[feature] = int(len(sub))
        for feature in [*FEATURES, "F0_per_vol"] + [
            c for c in group if c.startswith("avg_weekly_")
        ]:
            if group[feature].notna().sum() >= 10:
                ro.setdefault("rho_13w_excess", {})[feature] = (
                    spearman(*group[[feature, "excess_13w"]].dropna().to_numpy().T)
                    if group[[feature, "excess_13w"]].dropna().shape[0] >= 10
                    else math.nan
                )
                ro.setdefault("rho_trade_excess", {})[feature] = spearman(
                    *group[[feature, "excess"]].dropna().to_numpy().T
                )
        worst20 = group["excess"] <= group["excess"].quantile(0.2)
        for feature in FEATURES:
            data = group[[feature]].assign(worst20=worst20).dropna()
            if len(data) >= 25:
                q = pd.qcut(data[feature].rank(method="first"), 5, labels=[1, 2, 3, 4, 5])
                ro.setdefault("worst20_share_by_quintile", {})[feature] = (
                    data.groupby(q, observed=True)["worst20"].mean().round(3).tolist()
                )
        er = group[["entry_rank", "excess"]].dropna()
        ro["entry_rank_rho"] = spearman(er["entry_rank"].to_numpy(), er["excess"].to_numpy())
        results["strategies"][key] = res

    passing = [
        f
        for f in FEATURES
        if all(
            results["strategies"][k]["features"][f]["a_holds"]
            and results["strategies"][k]["features"][f]["b_holds"]
            for k in results["strategies"]
        )
    ]
    results["passing_features"] = passing
    results["verdict"] = "pass" if passing else "kill"

    trades.to_csv(out_dir / "trades.csv", index=False)
    (ROOT / "search_spaces" / "bl115_result.json").write_text(
        json.dumps(results, indent=1, default=lambda v: None if v != v else str(v))
    )
    print(json.dumps({"verdict": results["verdict"], "passing": passing}, indent=1))
    for key, res in results["strategies"].items():
        print(
            f"\n{key}: {res['trades']} trades, loser share {res['loser_share']:.0%}, "
            f"{res['decision_weeks']} decision weeks, {res['open_at_end_excluded']} open at end"
        )
        for f, s in res["features"].items():
            print(
                f"  {f:28} n={s['n']:4d} rho={s['rho']:+.3f} t={s['t']:+.2f} "
                f"worst5th losers {s['worst_fifth_loser_share']:.0%} "
                f"vs {s['overall_loser_share']:.0%} "
                f"(gap {s['gap']:+.0%})  a={s['a_holds']} b={s['b_holds']}"
            )


if __name__ == "__main__":
    main()
