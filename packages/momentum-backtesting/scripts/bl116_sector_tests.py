"""BL-116 Phase 1: does the sector a Broad pick came from tell winners from losers?

The rule is `search_spaces/bl116_criteria.json` (committed and pushed before this ran):

- H1, sector position: decided on the nine saved Broad groups other than Trio Fortnightly and Four
  Sectors Monthly, No Tilt (36 sleeves); those two are shown, not judged.
- H2, the sector's own average-weekly score: decided on Trio and Four Sectors.

Writes `search_spaces/bl116_result.json` and `data/search/bl116/trades.csv`.

Run from packages/momentum-backtesting:  uv run python scripts/bl116_sector_tests.py
"""

from __future__ import annotations

import importlib.util
import json
import math
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
CRITERIA = json.loads((ROOT / "search_spaces" / "bl116_criteria.json").read_text())
END = CRITERIA["windows"]["run"]["end"]
FIRST_FILL = pd.Timestamp("2017-01-06")
SEED = 116
BOOTSTRAPS = 2000
MIN_MEMBERS = 3

_spec = importlib.util.spec_from_file_location(
    "bl115", ROOT / "scripts" / "bl115_own_history_features.py"
)
bl115 = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(bl115)


# --- the sector score (pure: reads only data up to and including d) -------------------------------


def stock_score(p: pd.Series, d: pd.Timestamp, lookbacks: list[int]) -> float:
    """The owner's score for one stock: sum over k of (p[d] / p[d-k] - 1) / k, in percent."""
    return bl115.weekly_features(p, d, lookbacks)["F0_avg_weekly_score"]


def sector_score(
    prices: pd.DataFrame,
    membership: pd.DataFrame,
    base_to_columns: dict[str, list[str]],
    members: set[str],
    d: pd.Timestamp,
    lookbacks: list[int],
) -> tuple[float, int]:
    """(mean score over the sector's point-in-time members with a score, how many). Missing (NaN)
    when fewer than MIN_MEMBERS have one."""
    scores = []
    for base in sorted(members):
        for col in base_to_columns.get(base, []):
            if col in membership and d in membership.index and bool(membership.at[d, col]):
                s = stock_score(prices[col], d, lookbacks)
                if np.isfinite(s):
                    scores.append(s)
                break
    if len(scores) < MIN_MEMBERS:
        return math.nan, len(scores)
    return float(np.mean(scores)), len(scores)


# --- runs -----------------------------------------------------------------------------------------


def configs(groups: dict) -> dict[str, list[dict]]:
    from momentum_backtesting import runs_store, saved_identity
    from momentum_backtesting.db_read import read_catalog

    with read_catalog() as con:
        strategies = {s["id"]: s for s in runs_store.list_strategies(con)}
    out = {}
    for name, spec in groups.items():
        members = {m["id"]: m for m in strategies[spec["group"]]["members"]}
        rows = []
        for run_id, fingerprint in spec["sleeves"].items():
            config = members[run_id]["config_full"]
            got = saved_identity.fingerprint("broad", config)
            if got != fingerprint:
                raise SystemExit(
                    f"{name} {run_id}: fingerprint {got} != pre-registered {fingerprint}"
                )
            rows.append({"id": run_id, "config": config})
        out[name] = rows
    return out


def run(config: dict):
    from momentum_backtesting import api

    req = api.BacktestRequest.model_validate({**config, "end": END, "split_fridays": False})
    ranking = api._broad_ranking(req)
    return req, api._run_broad(req, ranking, api.DATA.get())


def trades_of(name: str, sleeve: dict, bench: pd.Series, *, with_score: bool, members_of: dict):
    from momentum_backtesting import analysis
    from momentum_backtesting.categories.broad import ATOMIC_NAMES

    req, outcome = run(sleeve["config"])
    result, ranking = outcome.result, outcome.ranking
    weeks = ranking.prices.index
    groups = outcome.effective.groups
    held = outcome.held_by_week or {}
    delay = int(req.signal_delay)
    lookbacks = list(req.lookbacks)
    top_n = int(req.broad_category_top_n)
    base_to_columns: dict[str, list[str]] = {}
    for col, base in ranking.column_to_base_symbol.items():
        base_to_columns.setdefault(base, []).append(col)
    closed = analysis.closed_trades(result)
    buys = result.trades[result.trades["action"] == "BUY"]
    closed_keys = {(r.asset, r.entry_week) for r in closed.itertuples()}
    counts = {
        "open_at_end": int(sum((r.asset, r.week) not in closed_keys for r in buys.itertuples())),
        "atomic": 0,
        "lingering_position": 0,
        "no_sector": 0,
    }
    rows = []
    for r in closed.itertuples():
        fill, exit_week = pd.Timestamp(r.entry_week), pd.Timestamp(r.exit_week)
        if fill < FIRST_FILL or exit_week > pd.Timestamp(END):
            continue
        if r.asset in ATOMIC_NAMES:
            counts["atomic"] += 1
            continue
        i = weeks.get_indexer([fill])[0]
        if i - delay < 0:
            continue
        d = weeks[i - delay]
        cid = groups.at[d, r.asset] if (groups is not None and r.asset in groups) else None
        if cid is None or (isinstance(cid, float) and math.isnan(cid)):
            counts["no_sector"] += 1
            continue
        order = held.get(d, [])
        position = order.index(cid) + 1 if cid in order else None
        if position is None or position > top_n:
            counts["lingering_position"] += 1
            continue
        row = {
            "group": name,
            "sleeve": sleeve["id"],
            "asset": r.asset,
            "sector": cid,
            "position": position,
            "decision_week": d,
            "fill_week": fill,
            "exit_week": exit_week,
            "excess": float(r.position_return)
            - float(bench.asof(exit_week) / bench.asof(fill) - 1),
        }
        if with_score:
            score, n = sector_score(
                ranking.prices,
                ranking.stock_membership,
                base_to_columns,
                members_of.get(cid, set()),
                d,
                lookbacks,
            )
            row["sector_score"], row["sector_members_scored"] = score, n
            row["stock_score"] = stock_score(ranking.prices[r.asset], d, lookbacks)
        rows.append(row)
    return rows, counts


# --- statistics -----------------------------------------------------------------------------------


def block_bootstrap(frame: pd.DataFrame, stat, rng) -> np.ndarray:
    weeks = frame["decision_week"].unique()
    idx = {w: np.flatnonzero(frame["decision_week"].to_numpy() == w) for w in weeks}
    out = []
    for _ in range(BOOTSTRAPS):
        pick = rng.integers(0, len(weeks), len(weeks))
        rows = np.concatenate([idx[weeks[j]] for j in pick])
        out.append(stat(frame.iloc[rows]))
    return np.asarray(out, dtype=float)


def position_gap(frame: pd.DataFrame) -> float:
    first = frame.loc[frame["position"] == 1, "winner"]
    rest = frame.loc[frame["position"] > 1, "winner"]
    return float(first.mean() - rest.mean()) if len(first) and len(rest) else math.nan


def by_position(frame: pd.DataFrame) -> list[dict]:
    worst = frame["excess"] <= frame["excess"].quantile(0.2)
    g = frame.assign(worst20=worst).groupby("position")
    return [
        {
            "position": int(pos),
            "trades": int(len(s)),
            "beat": float(s["winner"].mean()),
            "mean_excess": float(s["excess"].mean()),
            "median_excess": float(s["excess"].median()),
            "worst20_share": float(s["worst20"].mean()),
        }
        for pos, s in g
    ]


# --- main -----------------------------------------------------------------------------------------


def main() -> None:
    from momentum_backtesting import api
    from momentum_backtesting.categories import broad

    out_dir = ROOT / "data" / "search" / "bl116"
    out_dir.mkdir(parents=True, exist_ok=True)
    bench = bl115.nifty500()
    members_of = broad.load_stock_groups(api.CATEGORIES_CURATED_DIR, dated=True)
    rng = np.random.default_rng(SEED)

    nine = CRITERIA["samples"]["H1_decides_on"]["groups"]
    two = CRITERIA["samples"]["H2_decides_on"]
    rows, counts = [], {}
    for name, sleeves in configs(nine).items():
        for sleeve in sleeves:
            got, c = trades_of(name, sleeve, bench, with_score=False, members_of=members_of)
            rows += [{**r, "sample": "H1"} for r in got]
            counts[sleeve["id"]] = c
            print(f"H1 {name[:34]:34} {sleeve['id'][:6]} {len(got)} trades {c}", flush=True)
    two_specs = {k: {"group": v["group"], "sleeves": v["sleeves"]} for k, v in two.items()}
    for name, sleeves in configs(two_specs).items():
        for sleeve in sleeves:
            got, c = trades_of(name, sleeve, bench, with_score=True, members_of=members_of)
            rows += [{**r, "sample": "H2"} for r in got]
            counts[sleeve["id"]] = c
            print(f"H2 {name[:34]:34} {sleeve['id'][:6]} {len(got)} trades {c}", flush=True)

    trades = pd.DataFrame(rows)
    trades["winner"] = trades["excess"] > 0
    trades.to_csv(out_dir / "trades.csv", index=False)
    result: dict = {"criteria": "search_spaces/bl116_criteria.json", "counts": counts}

    # H1: decided on the nine groups.
    h1 = trades[trades["sample"] == "H1"].reset_index(drop=True)
    per_group = {name: position_gap(g) for name, g in h1.groupby("group")}
    pooled = position_gap(h1)
    draws = block_bootstrap(h1, position_gap, rng)
    lo, hi = np.nanpercentile(draws, [5, 95])
    above = sum(1 for v in per_group.values() if np.isfinite(v) and v > 0)
    h1_pass = above >= 7 and pooled >= 0.05 and lo > 0
    result["H1"] = {
        "trades": int(len(h1)),
        "per_group_gap": per_group,
        "groups_above_zero": above,
        "pooled_gap": pooled,
        "pooled_90pct_interval": [float(lo), float(hi)],
        "verdict": "pass" if h1_pass else "kill",
        "by_position_per_group": {name: by_position(g) for name, g in h1.groupby("group")},
        "by_position_pooled": by_position(h1),
    }
    # report only: the two seen strategies
    h2 = trades[trades["sample"] == "H2"].reset_index(drop=True)
    result["H1_seen_strategies"] = {
        name: {"gap": position_gap(g), "by_position": by_position(g)}
        for name, g in h2.groupby("group")
    }

    # H2: decided on Trio and Four Sectors.
    result["H2"] = {}
    passes = []
    for name, g in h2.groupby("group"):
        g = g.reset_index(drop=True)
        rho, t, n = bl115.bootstrap_t(g, "sector_score", "excess", rng)
        fifth = bl115.worst_fifth(g, "sector_score", "+")
        a = bool(np.isfinite(rho) and rho > 0 and np.isfinite(t) and t >= 3)
        b = bool(np.isfinite(fifth["gap"]) and fifth["gap"] >= 0.10)
        passes.append(a and b)
        # report only
        same_week = (
            g.dropna(subset=["sector_score"])
            .groupby("decision_week")
            .filter(lambda s: s["sector"].nunique() >= 2)
        )
        fx = same_week["sector_score"] - same_week.groupby("decision_week")[
            "sector_score"
        ].transform("mean")
        ox = same_week["excess"] - same_week.groupby("decision_week")["excess"].transform("mean")
        inside = {
            int(pos): bl115.spearman(*s[["sector_score", "excess"]].dropna().to_numpy().T)
            for pos, s in g.groupby("position")
            if s["sector_score"].notna().sum() >= 20
        }
        both = g[["sector_score", "stock_score"]].dropna()
        result["H2"][name] = {
            "trades": int(len(g)),
            "missing_score": int(g["sector_score"].isna().sum()),
            "rho": rho,
            "t": t,
            "n": n,
            "a_holds": a,
            **fifth,
            "b_holds": b,
            "report_only": {
                "same_week_rho": bl115.spearman(fx.to_numpy(), ox.to_numpy())
                if len(same_week) >= 10
                else None,
                "same_week_n": int(len(same_week)),
                "rho_inside_position": inside,
                "sector_vs_stock_score_rho": bl115.spearman(*both.to_numpy().T)
                if len(both) >= 10
                else None,
                "winners_median": float(g.loc[g["winner"], "sector_score"].median()),
                "losers_median": float(g.loc[~g["winner"], "sector_score"].median()),
            },
        }
    result["H2_verdict"] = "pass" if passes and all(passes) else "kill"

    (ROOT / "search_spaces" / "bl116_result.json").write_text(
        json.dumps(result, indent=1, default=lambda v: None if v != v else str(v)) + "\n"
    )
    print(json.dumps({"H1": result["H1"]["verdict"], "H2": result["H2_verdict"]}))


if __name__ == "__main__":
    main()
