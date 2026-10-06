"""Choose a config the way BL-010 Phase 5 committed to in advance (criteria addendum 3).

Phase 4 showed that the config with the best CAGR is mostly the luckiest one (PBO 0.69 on the
point-in-time universe). So the choice here never looks at CAGR first:

  basket      a config is eligible for a drawdown basket if every fall of its weekly curve
              passes that basket (`criteria.basket_passes`)
  rank        its third-worst financial year against Nifty200 Momentum 30 TRI: the 25th
              percentile of its FY excess returns
  clusters    configs whose weekly returns move together (correlation >= 0.9) are one idea; a
              cluster is scored by its 25th-percentile member and represented by its medoid
  holdings    clusters within 1 point of the best are broken toward a medoid holding 8 to 12
              stocks

`walk_forward` asks whether this rule, applied each year to the data before that year only,
would have earned more than a typical config. Everything works from stored weekly curves
(`method.score_search`), so nothing is re-run.

Slicing a continuous curve is not the same as starting fresh at the window's start (holdings
carried in from before the window are kept); the windows here are slices.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field

import numpy as np
import pandas as pd

from . import criteria

FIRST_FY = 2018  # FY2018 = April 2017 to March 2018; the curves start in January 2017
CLUSTER_CORR = 0.9
HOLDINGS = (8, 12)
NEAR_BEST_PTS = 0.01  # clusters within 1 point of the best are broken toward 8-12 holdings
TIE_PTS = 0.005  # within half a point: higher Martin ratio, then the simpler config
EMBARGO_WEEKS = 13
RANK_PERCENTILE = 25
MIN_PICKS = 3  # addendum 4: fewer than this is reported to the owner


# --- windows ---------------------------------------------------------------------------------


def fy_bounds(fy: int) -> tuple[pd.Timestamp, pd.Timestamp]:
    """FY2018 runs from 2017-04-01 to 2018-03-31."""
    return pd.Timestamp(f"{fy - 1}-04-01"), pd.Timestamp(f"{fy}-03-31")


def window_returns(curves: pd.DataFrame | pd.Series, start, end) -> pd.Series | float:
    """Growth from the last week before `start` to the last week on or before `end`. NaN when
    the curve does not cover the whole window."""
    start, end = pd.Timestamp(start), pd.Timestamp(end)
    index = curves.index
    before = index[index < start]
    inside = index[index <= end]
    covered = len(before) and inside[-1] > before[-1] and index[-1] >= end - pd.Timedelta(days=6)
    if not covered:
        if isinstance(curves, pd.DataFrame):
            return pd.Series(np.nan, index=curves.columns)
        return math.nan
    return curves.loc[inside[-1]] / curves.loc[before[-1]] - 1


def complete_fys(index: pd.DatetimeIndex) -> list[int]:
    """Financial years wholly inside a weekly `index`: it has a week before the FY starts and
    one in the FY's last six days."""
    out, fy = [], FIRST_FY
    while True:
        start, end = fy_bounds(fy)
        if index[-1] < end - pd.Timedelta(days=6):
            return out
        if index[0] < start:
            out.append(fy)
        fy += 1


def fy_table(curves: pd.DataFrame, fys: list[int]) -> pd.DataFrame:
    """FY x config return."""
    return pd.DataFrame({fy: window_returns(curves, *fy_bounds(fy)) for fy in fys}).T


def fy_excess(curves: pd.DataFrame, bench: pd.Series, fys: list[int]) -> pd.DataFrame:
    """FY x config return minus the benchmark's return over the same FY."""
    return window_excess(curves, bench, [fy_bounds(fy) for fy in fys])


def window_excess(curves: pd.DataFrame, bench: pd.Series, windows: list[tuple]) -> pd.DataFrame:
    """Window x config return minus the benchmark's return over the same window."""
    own = pd.DataFrame({i: window_returns(curves, *w) for i, w in enumerate(windows)}).T
    theirs = pd.Series({i: window_returns(bench, *w) for i, w in enumerate(windows)})
    return own.sub(theirs, axis=0)


def lower_bound(excess: pd.DataFrame) -> pd.Series:
    """Per config, the 25th percentile of its FY excess returns. With nine years this is
    exactly the third-worst (linear interpolation lands on the 3rd of 9 ordered values)."""
    return excess.quantile(RANK_PERCENTILE / 100, axis=0, interpolation="linear")


def ulcer(curves: pd.DataFrame) -> pd.Series:
    """Root-mean-square drawdown, as a fraction (same as `metrics.underwater_stats`)."""
    dd = curves / curves.cummax() - 1
    return np.sqrt((dd**2).mean())


def cagr(curves: pd.DataFrame | pd.Series) -> pd.Series | float:
    years = (curves.index[-1] - curves.index[0]).days / 365.25
    return (curves.iloc[-1] / curves.iloc[0]) ** (1 / years) - 1


def martin(curves: pd.DataFrame) -> pd.Series:
    return cagr(curves) / ulcer(curves).replace(0.0, np.nan)


# --- config facts ------------------------------------------------------------------------------


def nominal_holdings(light: dict) -> int:
    """The most stocks the config can hold at once (addendum 3)."""
    return int(min(light["category_top_n"] * light["picks_per_category"], light["pool_top_n"]))


def simplicity(heavy: dict, light: dict) -> tuple:
    """Smaller is simpler: fewer lookbacks, fewer categories, no stock tilt, plain entry."""
    return (
        len(heavy["lookbacks"]),
        light["category_top_n"],
        light.get("stock_tilt", 0.0) != 0.0,
        light.get("entry", "wait") != "wait",
    )


def config_facts(records: dict[str, dict]) -> pd.DataFrame:
    rows = {
        cid: {
            "holdings": nominal_holdings(rec["light"]),
            "simplicity": simplicity(rec["heavy"], rec["light"]),
            "every": rec["light"]["rebalance_every"],
        }
        for cid, rec in records.items()
    }
    return pd.DataFrame.from_dict(rows, orient="index")


# --- baskets -------------------------------------------------------------------------------------


def basket_members(
    curves: pd.DataFrame, indices: dict[str, pd.Series], *, loosen: float = 0.0
) -> dict[str, list[str]]:
    """Basket -> configs whose every fall passes it. `loosen` moves each basket's fixed limit
    (+0.05 = five points more room), for the threshold-stability check."""
    out: dict[str, list[str]] = {name: [] for name in criteria.load()["baskets"]}
    for cid in curves.columns:
        curve = curves[cid].dropna()
        for name in out:
            if criteria.basket_passes(curve, indices, name, loosen=loosen):
                out[name].append(cid)
    return out


# --- clusters and the choice ---------------------------------------------------------------------


@dataclass
class Cluster:
    medoid: str
    members: list[str]
    score: float  # the rank measure of its 25th-percentile member
    extra: dict = field(default_factory=dict)


def _standardised(returns: pd.DataFrame) -> np.ndarray:
    values = returns.to_numpy(dtype=float)
    values = values - values.mean(axis=0)
    norm = np.sqrt((values**2).sum(axis=0))
    norm[norm == 0] = np.nan
    return values / norm


def _medoid(z: np.ndarray, cols: np.ndarray) -> int:
    """The member with the highest mean correlation to the others."""
    if len(cols) == 1:
        return int(cols[0])
    block = z[:, cols]
    mean_corr = np.nanmean(block.T @ block, axis=1)
    return int(cols[int(np.nanargmax(mean_corr))])


def clusters(curves: pd.DataFrame, rank: pd.Series, corr: float = CLUSTER_CORR) -> list[Cluster]:
    """Leader clustering on weekly log returns. The best-ranked unassigned config seeds a
    cluster; every unassigned config correlated >= `corr` with the seed joins; the medoid is
    found, and membership is redone once against the medoid (so a member is one that moves
    with the cluster's centre, not just with its best config)."""
    names = np.asarray(curves.columns)
    z = _standardised(np.log(curves.astype(float)).diff().iloc[1:])
    order = np.argsort(-rank.reindex(names).to_numpy(dtype=float), kind="stable")
    free = np.ones(len(names), dtype=bool)
    out = []
    for seed in order:
        if not free[seed]:
            continue
        near = np.flatnonzero(free & (np.nan_to_num(z.T @ z[:, seed], nan=-1.0) >= corr))
        near = near if seed in near else np.append(near, seed)
        centre = _medoid(z, near)
        members = np.flatnonzero(free & (np.nan_to_num(z.T @ z[:, centre], nan=-1.0) >= corr))
        # The seed and the centre always belong: a seed left free would never be revisited.
        members = np.union1d(members, [seed, centre])
        centre = _medoid(z, members)
        free[members] = False
        member_names = list(names[members])
        score = float(
            np.percentile(rank.reindex(member_names).to_numpy(dtype=float), RANK_PERCENTILE)
        )
        out.append(Cluster(medoid=str(names[centre]), members=member_names, score=score))
    return sorted(out, key=lambda c: -c.score)


def pick(found: list[Cluster], facts: pd.DataFrame, martin_ratio: pd.Series) -> Cluster | None:
    """Addendum 3: the best-scoring cluster's medoid, with two tie-breaks.

    1. Among clusters within 1 point of the best, prefer one whose medoid holds 8 to 12 stocks;
       a medoid outside 8 to 12 wins only if it beats the best 8-to-12 cluster by more than 1
       point.
    2. Clusters within half a point of each other: higher Martin ratio, then simpler."""
    if not found:
        return None
    safe_martin = martin_ratio.fillna(-np.inf)  # a NaN would make the sort order arbitrary

    def in_band(c: Cluster) -> bool:
        return HOLDINGS[0] <= facts.at[c.medoid, "holdings"] <= HOLDINGS[1]

    def tie_break(candidates: list[Cluster]) -> Cluster:
        top = max(c.score for c in candidates)
        level = [c for c in candidates if c.score >= top - TIE_PTS]
        return sorted(
            level,
            key=lambda c: (-safe_martin.get(c.medoid, -np.inf), facts.at[c.medoid, "simplicity"]),
        )[0]

    best = tie_break(found)
    banded = [c for c in found if in_band(c)]
    if in_band(best) or not banded:
        return best
    best_banded = tie_break(banded)
    return best if best.score > best_banded.score + NEAR_BEST_PTS else best_banded


def choose(
    curves: pd.DataFrame,
    members: list[str],
    bench: pd.Series,
    windows: list[tuple],
    facts: pd.DataFrame,
) -> tuple[Cluster | None, pd.Series, list[Cluster]]:
    """Apply the rule to one basket's members, ranking on `windows` (the complete financial
    years, as (start, end) pairs). Returns (the chosen cluster, the rank measure of every
    member, every cluster)."""
    if not members:
        return None, pd.Series(dtype=float), []
    sub = curves[members]
    rank = lower_bound(window_excess(sub, bench, windows))
    found = clusters(sub, rank)
    return pick(found, facts, martin(sub)), rank, found


# --- walk-forward --------------------------------------------------------------------------------


def walk_forward(
    curves: pd.DataFrame,
    indices: dict[str, pd.Series],
    bench: pd.Series,
    facts: pd.DataFrame,
    *,
    first_fy: int = 2019,
    holdings: tuple[int, int] | None = None,
    partial_first: bool = False,
    membership: dict | None = None,
    echo=print,
) -> dict[str, pd.DataFrame]:
    """For each FY from `first_fy`, choose per basket using only data up to 13 weeks before the
    FY starts, hold the medoid through the FY, and record its return next to the basket's
    median config and the benchmark. A year with no complete FY before its cut is skipped, as
    committed; `partial_first` instead ranks it on the one partial window there is (the first
    week to the cut), as a labelled sensitivity.

    `holdings` restricts the eligible configs to that range of nominal holdings (for the
    2-6 vs 8-12 check); None applies the rule as committed. `membership` caches each cut's
    basket membership across calls: whether a config passes a basket depends on its own curve
    only, so a restricted run can reuse the full one's."""
    membership = {} if membership is None else membership
    last_fy = complete_fys(curves.index)[-1]
    rows: dict[str, list[dict]] = {name: [] for name in criteria.load()["baskets"]}
    for fy in range(first_fy, last_fy + 1):
        start, end = fy_bounds(fy)
        cut = start - pd.Timedelta(weeks=EMBARGO_WEEKS)
        past = curves.loc[:cut]
        known = complete_fys(past.index)
        windows = [fy_bounds(f) for f in known]
        selected_on = f"FY{known[0]}-FY{known[-1]}" if known else None
        if not known and partial_first:
            first = past.index[0] + pd.Timedelta(days=1)
            windows = [(first, past.index[-1])]
            selected_on = f"{past.index[0].date()}..{past.index[-1].date()} (partial)"
        if not windows:
            echo(f"FY{fy}: no complete financial year before {cut.date()}, skipped")
            continue
        if cut not in membership:
            cut_indices = {k: v.loc[:cut] for k, v in indices.items()}
            membership[cut] = basket_members(past, cut_indices)
        eligible = past
        baskets = membership[cut]
        if holdings is not None:
            keep = set(
                facts.index[(facts["holdings"] >= holdings[0]) & (facts["holdings"] <= holdings[1])]
            )
            eligible = past[[c for c in past.columns if c in keep]]
            baskets = {k: [c for c in v if c in keep] for k, v in baskets.items()}
        year = window_returns(curves, start, end)
        bench_year = window_returns(bench, start, end)
        for name, members in baskets.items():
            chosen, _, found = choose(eligible, members, bench.loc[:cut], windows, facts)
            row = {
                "fy": fy,
                "selected_on": selected_on,
                "eligible": len(members),
                "clusters": len(found),
                "chosen": chosen.medoid if chosen else None,
                "chosen_return": float(year[chosen.medoid]) if chosen else math.nan,
                "median_return": float(year[members].median()) if members else math.nan,
                "bench_return": float(bench_year),
            }
            rows[name].append(row)
            echo(
                f"FY{fy} {name}: {row['eligible']} eligible, {row['clusters']} clusters, "
                f"chose {row['chosen']} -> {row['chosen_return']:.1%} "
                f"(median {row['median_return']:.1%}, index {row['bench_return']:.1%})"
            )
    return {
        name: pd.DataFrame(r).set_index("fy") if r else pd.DataFrame() for name, r in rows.items()
    }


def joined(table: pd.DataFrame) -> dict[str, float]:
    """Annualised growth of the chosen, median and benchmark columns chained over the years."""
    if table.empty:
        return {}
    years = len(table)
    out = {}
    for col in ("chosen_return", "median_return", "bench_return"):
        growth = float((1 + table[col].fillna(0.0)).prod())
        out[col.replace("_return", "")] = growth ** (1 / years) - 1
    return out


# --- factor check and bootstrap ------------------------------------------------------------------


def factor_regression(
    curve: pd.Series, cash: pd.Series, nifty50: pd.Series, smallcap: pd.Series, mom30: pd.Series
) -> dict[str, float]:
    """Weekly return over cash regressed on the Nifty 50's return over cash, a size spread
    (Smallcap 250 minus Nifty 50) and a momentum spread (Momentum 30 minus Nifty 50).
    Alpha is annualised (x52); t uses Newey-West standard errors with 4 lags."""
    parts = {"y": curve, "cash": cash, "n50": nifty50, "small": smallcap, "mom": mom30}
    # Up to the last week every series really has: carrying a series past its last bar
    # would add zero-return weeks to it alone.
    end = min(s.dropna().index[-1] for s in parts.values())
    frame = pd.concat(parts, axis=1).loc[:end].ffill()
    r = frame.pct_change().dropna()
    y = (r["y"] - r["cash"]).to_numpy()
    x = np.column_stack(
        [np.ones(len(r)), r["n50"] - r["cash"], r["small"] - r["n50"], r["mom"] - r["n50"]]
    )
    beta, *_ = np.linalg.lstsq(x, y, rcond=None)
    resid = y - x @ beta
    xtx_inv = np.linalg.pinv(x.T @ x)  # pinv: a degenerate factor gives NaN-free output
    lags = 4
    s = (x * resid[:, None]).T @ (x * resid[:, None])
    for lag in range(1, lags + 1):
        w = 1 - lag / (lags + 1)
        g = (x[lag:] * resid[lag:, None]).T @ (x[:-lag] * resid[:-lag, None])
        s += w * (g + g.T)
    se = np.sqrt(np.diag(xtx_inv @ s @ xtx_inv))
    return {
        "alpha_pa": float(beta[0] * 52),
        "alpha_t": float(beta[0] / se[0]),
        "beta_market": float(beta[1]),
        "beta_size": float(beta[2]),
        "beta_momentum": float(beta[3]),
        "r2": float(1 - resid.var() / y.var()),
        "weeks": len(r),
    }


def block_bootstrap(
    curve: pd.Series, *, mean_block: int, draws: int = 2000, seed: int = 0
) -> dict[str, float]:
    """Stationary bootstrap (Politis-Romano) of weekly log returns: 5th/50th/95th percentiles of
    CAGR and max drawdown over a resampled history of the same length."""
    rng = np.random.default_rng(seed)
    r = np.log(curve.astype(float)).diff().dropna().to_numpy()
    n = len(r)
    years = n / 52
    cagrs, dds = np.empty(draws), np.empty(draws)
    for d in range(draws):
        idx = np.empty(n, dtype=int)
        i = rng.integers(n)
        idx[0] = i
        for t in range(1, n):
            i = rng.integers(n) if rng.random() < 1 / mean_block else (i + 1) % n
            idx[t] = i
        path = np.cumsum(r[idx])
        cagrs[d] = math.exp(path[-1] / years) - 1
        level = np.exp(np.concatenate([[0.0], path]))
        dds[d] = (level / np.maximum.accumulate(level) - 1).min()
    return {
        "cagr_p5": float(np.percentile(cagrs, 5)),
        "cagr_p50": float(np.percentile(cagrs, 50)),
        "cagr_p95": float(np.percentile(cagrs, 95)),
        "mdd_p5": float(np.percentile(dds, 5)),  # the deep tail: 1 in 20 histories is worse
        "mdd_p50": float(np.percentile(dds, 50)),
        "mean_block_weeks": mean_block,
    }


# --- the Phase 6 ensemble (criteria addendum 4) ------------------------------------------------


def ensemble_group(members: list[str], facts: pd.DataFrame) -> list[str]:
    """The basket members addendum 4 may pick from: 8-12 nominal holdings, rebalancing every 2
    or 4 weeks."""
    spec = criteria.load()["phase_6_ensemble"]["eligible"]
    low, high = spec["nominal_holdings"]
    every = set(spec["rebalance_every_weeks"])
    return [
        c
        for c in members
        if low <= facts.at[c, "holdings"] <= high and int(facts.at[c, "every"]) in every
    ]


def typical_set(
    curves: pd.DataFrame,
    group: list[str],
    bench: pd.Series,
    windows: list[tuple],
    *,
    size: int = 4,
    corr: float = CLUSTER_CORR,
) -> list[str]:
    """Addendum 4's pick: drop configs whose rank measure is below the group's median, then
    take the most typical (highest mean weekly-return correlation with the rest), skipping any
    correlated `corr` or more with one already taken, until `size` are taken."""
    if not group:
        return []
    sub = curves[group]
    rank = lower_bound(window_excess(sub, bench, windows))
    screened = list(rank.index[rank >= rank.median()])
    z = _standardised(np.log(sub[screened].astype(float)).diff().iloc[1:])
    pairwise = np.nan_to_num(z.T @ z, nan=0.0)
    typical = pairwise.mean(axis=1)
    taken: list[int] = []
    for i in np.argsort(-typical, kind="stable"):
        if all(pairwise[i, j] < corr for j in taken):
            taken.append(int(i))
        if len(taken) == size:
            break
    return [screened[i] for i in taken]


def ensemble_window_return(curves: pd.DataFrame, picks: list[str], start, end) -> float:
    """Equal capital in each pick at the window's start, no transfers inside it."""
    if not picks:
        return math.nan
    returns = window_returns(curves[picks], start, end)
    # A pick the window does not cover is a failed year, never silently dropped.
    return float(returns.mean()) if returns.notna().all() else math.nan


def ensemble_curve(curves: pd.DataFrame, picks: list[str]) -> pd.Series:
    """The weekly value of equal capital in `picks`, reset to equal each April (addendum 4)."""
    weeks = curves.index
    out, level = [], 1.0
    # Reset where each financial year's window starts: the last week before 1 April.
    aprils = [pd.Timestamp(f"{y}-04-01") for y in range(weeks[0].year, weeks[-1].year + 1)]
    resets = [weeks[0]] + [weeks[weeks < a][-1] for a in aprils if weeks[0] < a <= weeks[-1]]
    resets = sorted(set(resets))
    for i, start in enumerate(resets):
        end = resets[i + 1] if i + 1 < len(resets) else weeks[-1]
        span = curves.loc[start:end, picks]
        part = (span / span.iloc[0]).mean(axis=1) * level
        out.append(part.iloc[1:] if out else part)
        level = float(part.iloc[-1])
    return pd.concat(out)


def walk_forward_ensemble(
    curves: pd.DataFrame,
    indices: dict[str, pd.Series],
    bench: pd.Series,
    facts: pd.DataFrame,
    *,
    first_fy: int = 2019,
    partial_first: bool = False,
    membership: dict | None = None,
    echo=print,
) -> pd.DataFrame:
    """Addendum 4's walk-forward: each FY, pick on data ending 13 weeks before it, hold equal
    capital in the picks through the FY, next to the eligible group's median config and the
    benchmark. Same cuts, embargo and FY2019 handling as `walk_forward`."""
    basket = criteria.load()["phase_6_ensemble"]["eligible"]["basket"]
    membership = {} if membership is None else membership
    rows = []
    for fy in range(first_fy, complete_fys(curves.index)[-1] + 1):
        start, end = fy_bounds(fy)
        cut = start - pd.Timedelta(weeks=EMBARGO_WEEKS)
        past = curves.loc[:cut]
        known = complete_fys(past.index)
        windows = [fy_bounds(f) for f in known]
        selected_on = f"FY{known[0]}-FY{known[-1]}" if known else None
        if not known and partial_first:
            windows = [(past.index[0] + pd.Timedelta(days=1), past.index[-1])]
            selected_on = f"{past.index[0].date()}..{past.index[-1].date()} (partial)"
        if not windows:
            echo(f"FY{fy}: no complete financial year before {cut.date()}, skipped")
            continue
        if cut not in membership:
            membership[cut] = basket_members(past, {k: v.loc[:cut] for k, v in indices.items()})
        group = ensemble_group(membership[cut][basket], facts)
        picks = typical_set(past, group, bench.loc[:cut], windows)
        year = window_returns(curves[group], start, end) if group else pd.Series(dtype=float)
        row = {
            "fy": fy,
            "selected_on": selected_on,
            "group": len(group),
            "picks": picks,
            "too_few": len(picks) < MIN_PICKS,
            "ensemble_return": ensemble_window_return(curves, picks, start, end),
            "median_return": float(year.median()) if len(year) else math.nan,
            "bench_return": float(window_returns(bench, start, end)),
        }
        rows.append(row)
        echo(
            f"FY{fy}: {row['group']} eligible, picked {len(picks)} -> "
            f"{row['ensemble_return']:.1%} (median {row['median_return']:.1%}, "
            f"index {row['bench_return']:.1%})"
        )
    return pd.DataFrame(rows).set_index("fy") if rows else pd.DataFrame()


def rebalance_phases(picks: list[str], facts: pd.DataFrame) -> dict[str, int]:
    """Addendum 4: one rebalance phase per pick, spreading their rebalance Fridays over a
    four-week cycle; never by performance. Each pick, in the given order, takes the phase that
    keeps the busiest Friday least busy, then the load most even, then the earliest phase.

    A phase is the engine's `rebalance_offset`: the pick trades on Fridays whose week number
    since `engine.CADENCE_EPOCH` is the phase mod its `rebalance_every`. Calendar-anchored, so
    a 4-weekly phase 0 or 2 shares its Fridays with a 2-weekly phase 0."""
    load = [0, 0, 0, 0]
    out = {}
    for cid in picks:
        every = int(facts.at[cid, "every"])
        best, best_key = 0, None
        for offset in range(every):
            trial = [n + (1 if w % every == offset else 0) for w, n in enumerate(load)]
            key = (max(trial), sum(n * n for n in trial))
            if best_key is None or key < best_key:
                best, best_key = offset, key
        for w in range(best, 4, every):
            load[w] += 1
        out[cid] = best
    return out
