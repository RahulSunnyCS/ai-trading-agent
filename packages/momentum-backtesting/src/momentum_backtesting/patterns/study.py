"""BL-041 Phase 4: does a pattern predict returns beyond momentum? (bl041_criteria.json
`phase_4_event_study`)

For each Friday t in the development window and each stock in the Broad pool that week: the
forward return to t+h on the weekly prices the engine trades. An *event* is a detection (score
>= 0.5) of the pattern; its *controls* are the other pool stocks in the same pool-rank decile
that week without one. The weekly statistic is the event-weighted mean of (event mean - control
mean) across deciles. Its mean over weeks is tested one-sided with Newey-West standard errors
(lags = h, since h-week returns overlap), and Holm-corrected across patterns x horizons.

Forward returns must end inside the development window: a week whose t+h passes its end is
left out, so nothing here reads the hold-out.
"""

from __future__ import annotations

import math

import numpy as np
import pandas as pd

from . import criteria, dev_end


def forward_returns(prices: pd.DataFrame, horizon: int) -> pd.DataFrame:
    """week x column: price(t+h) / price(t) - 1 on forward-filled prices (as the engine values a
    held position through a gap); NaN where t+h is past the last week given."""
    filled = prices.ffill()
    return filled.shift(-horizon) / filled - 1


def weekly_statistic(
    returns: pd.DataFrame,
    pool_ranks: pd.DataFrame,
    events: pd.DataFrame,
    exclude: pd.DataFrame | None = None,
) -> pd.Series:
    """Per week: event-weighted mean of (event mean - control mean) over pool-rank deciles.
    Names marked in `exclude` are neither events nor controls that week."""
    out = {}
    for week in returns.index:
        rank = pool_ranks.loc[week]
        ret = returns.loc[week]
        ok = rank.notna() & ret.notna()
        if exclude is not None:
            ok &= ~exclude.loc[week].reindex(ok.index).fillna(False).astype(bool)
        if not ok.any():
            continue
        r, f = rank[ok], ret[ok]
        hit = events.loc[week].reindex(r.index).fillna(False).astype(bool)
        if not hit.any():
            continue
        decile = np.ceil(r / r.max() * 10).clip(1, 10)
        num = den = 0.0
        for d in np.unique(decile[hit]):
            in_d = decile == d
            ev, ctl = f[in_d & hit], f[in_d & ~hit]
            if len(ctl) == 0:
                continue
            num += len(ev) * (ev.mean() - ctl.mean())
            den += len(ev)
        if den:
            out[week] = num / den
    return pd.Series(out, dtype=float)


def newey_west_t(series: pd.Series, lags: int) -> float:
    """t-statistic of the mean of `series` with a Bartlett-kernel long-run variance."""
    x = series.dropna().to_numpy(dtype=float)
    n = len(x)
    if n < 3:
        return math.nan
    e = x - x.mean()
    var = e @ e / n
    for lag in range(1, min(lags, n - 1) + 1):
        weight = 1 - lag / (lags + 1)
        var += 2 * weight * (e[lag:] @ e[:-lag]) / n
    return float(x.mean() / math.sqrt(var / n)) if var > 0 else math.nan


def one_sided_p(t: float) -> float:
    """P(Z >= t) for a standard normal (the sample is hundreds of weeks)."""
    return 0.5 * math.erfc(t / math.sqrt(2)) if t == t else math.nan


def holm(pvalues: dict, alpha: float) -> dict:
    """Holm step-down: key -> True if rejected at family-wise level `alpha`."""
    ordered = sorted((p, k) for k, p in pvalues.items() if p == p)
    m, out, stop = len(ordered), {k: False for k in pvalues}, False
    for i, (p, key) in enumerate(ordered):
        if stop or p > alpha / (m - i):
            stop = True
            continue
        out[key] = True
    return out


def run(
    prices: pd.DataFrame,
    pool_ranks: pd.DataFrame,
    scores: dict[str, pd.DataFrame],
    *,
    window: tuple[str, str] | None = None,
    quality: dict[str, pd.DataFrame] | None = None,
) -> dict:
    """The whole Phase 4 judgement. `prices` / `pool_ranks` / each score table are week x column
    on the same columns (the Broad ranking's own); `scores` maps pattern -> score table."""
    spec = criteria()["phase_4_event_study"]
    start, end = window or (criteria()["windows"]["development"]["from"], str(dev_end().date()))
    prices = prices.loc[:end]  # forward returns never read past the window
    results, pvalues = {}, {}
    for pattern, score in scores.items():
        events = score.reindex(index=prices.index, columns=prices.columns).fillna(0) >= 0.5
        for h in spec["horizons_weeks"]:
            fwd = forward_returns(prices, h).loc[start:end]
            ranks = pool_ranks.reindex(index=fwd.index, columns=fwd.columns)
            stat = weekly_statistic(fwd, ranks, events.loc[fwd.index])
            in_sample = events.loc[fwd.index] & ranks.notna() & fwd.notna()
            n_events, n_weeks = int(in_sample.to_numpy().sum()), int(len(stat))
            t = newey_west_t(stat, h)
            enough = (
                n_events >= spec["minimum_sample"]["events"]
                and n_weeks >= spec["minimum_sample"]["distinct_weeks"]
            )
            key = f"{pattern}/{h}"
            pvalues[key] = one_sided_p(t) if enough else math.nan
            results[key] = {
                "pattern": pattern,
                "horizon_weeks": h,
                "events": n_events,
                "weeks": n_weeks,
                "mean_excess": float(stat.mean()) if n_weeks else math.nan,
                "t_newey_west": t,
                "p_one_sided": pvalues[key],
                "enough_sample": enough,
            }
    rejected = holm(pvalues, 0.05)
    verdicts = {}
    for key, row in results.items():
        row["holm_rejects"] = rejected[key]
    for pattern in scores:
        primary = results[f"{pattern}/13"]
        verdicts[pattern] = (
            "inconclusive"
            if not primary["enough_sample"]
            else "pass"
            if primary["holm_rejects"] and primary["mean_excess"] > 0
            else "kill"
        )
    thirds = {}
    for pattern, grade in (quality or {}).items():
        thirds[pattern] = by_quality_third(
            prices, pool_ranks, scores[pattern], grade, start=start, end=end
        )
    return {
        "window": [start, end],
        "tests": list(results.values()),
        "verdicts": verdicts,
        "reported_by_quality_third": thirds,
    }


def by_quality_third(
    prices: pd.DataFrame,
    pool_ranks: pd.DataFrame,
    score: pd.DataFrame,
    grade: pd.DataFrame,
    *,
    start: str,
    end: str,
    horizon: int = 13,
) -> dict:
    """Reported only (addendum 1): the 13-week statistic for detections in each third of
    quality, cut points from the window's detections. Controls are the same as the judged test:
    non-detections in the same decile."""
    events = score.reindex(index=prices.index, columns=prices.columns).fillna(0) >= 0.5
    grade = grade.reindex(index=prices.index, columns=prices.columns)
    fwd = forward_returns(prices, horizon).loc[start:end]
    ranks = pool_ranks.reindex(index=fwd.index, columns=fwd.columns)
    in_window = events.loc[fwd.index]
    values = grade.loc[fwd.index].where(in_window).stack().dropna()
    if values.empty:
        return {}
    cuts = values.quantile([1 / 3, 2 / 3]).to_list()
    out = {}
    bands = (("low", -1.0, cuts[0]), ("mid", cuts[0], cuts[1]), ("high", cuts[1], 2.0))
    for name, lo, hi in bands:
        g = grade.loc[fwd.index]
        mine = in_window & (g > lo) & (g <= hi)
        # controls: never a detection of this pattern; other thirds' detections sit out
        stat = weekly_statistic(fwd, ranks, mine, exclude=in_window & ~mine)
        out[name] = {
            "quality_range": [float(max(lo, 0.0)), float(min(hi, 1.0))],
            "events": int((mine & ranks.notna() & fwd.notna()).to_numpy().sum()),
            "mean_excess": float(stat.mean()) if len(stat) else math.nan,
            "t_newey_west": newey_west_t(stat, horizon),
        }
    return out
