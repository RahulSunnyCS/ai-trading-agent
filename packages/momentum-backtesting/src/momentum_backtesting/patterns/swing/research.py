"""BL-043 Phases 3-5 on the development window (bl043_criteria.json `score`, `health_switch`,
`cutoffs`, `search`, `pass_kill`).

Stage A (trade level, the playbook): per pattern, entry x stop x target = 18 combinations, each
judged on the mean R after costs of its candidates taken as trades. Only the first candidate of
each base and entry counts, so a base that held for 20 days is one trade, not 20. Year by year
(2015-2023) the combination with the best mean R over trades that exited before 1 January minus
13 weeks is used for that year. PBO over the 18 combinations' monthly mean R.

Phase 4 (score): a candidate's score is 50 + 50 x the mean R of earlier stage-A trades in its
cell (pattern, entry, above/below the 50-session average, quality third) under the same
stop/target, counting only trades that had exited before its signal day; 50 until a cell has 30.

Stage B (portfolio): the patterns that pass stage A share 10 slots; 3 cut-offs x the health
switch = 6 portfolios. Year by year the portfolio with the best weekly log return before the
cut is used. PBO over the 6. Years 2012-2014 run with the 2015 stage-A choice: they only train
stage B's first pick; every judged year is out of sample.
"""

from __future__ import annotations

import itertools
import json
import math
from pathlib import Path

import numpy as np
import pandas as pd

from ... import method, metrics
from . import criteria
from .trader import run_portfolio, trade_outcomes


def combos() -> list[tuple[str, str, float | None]]:
    exits = criteria()["exits"]
    entries = ["breakout", "pullback"]
    targets = list(exits["targets"].items())
    return [
        (entry, stop, value)
        for entry, stop, (_, value) in itertools.product(entries, exits["stops"], targets)
    ]


def combo_name(entry: str, stop: str, target: float | None) -> str:
    return f"{entry}/{stop}/{f'{target:g}R' if target else 'none'}"


def first_per_base(cands: pd.DataFrame) -> pd.Series:
    """True for the first candidate (by date) of each base and entry."""
    order = cands.sort_values("date")
    first = ~order.duplicated(["base_id", "entry"])
    return first.reindex(cands.index)


def quality_cuts(cands: pd.DataFrame) -> dict[str, tuple[float, float]]:
    out = {}
    for pattern, part in cands.groupby("pattern"):
        q = part["quality"].dropna()
        out[pattern] = (float(q.quantile(1 / 3)), float(q.quantile(2 / 3)))
    return out


def thirds(cands: pd.DataFrame, cuts: dict[str, tuple[float, float]]) -> pd.Series:
    out = pd.Series("mid", index=cands.index, dtype=object)
    for pattern, (lo, hi) in cuts.items():
        mask = cands["pattern"] == pattern
        q = cands.loc[mask, "quality"]
        out.loc[mask & (cands["quality"] <= lo)] = "low"
        out.loc[mask & (cands["quality"] > hi)] = "high"
        out.loc[mask & q.isna().reindex(cands.index, fill_value=False)] = "mid"
    return out


def scores(
    cands: pd.DataFrame, trades: pd.DataFrame, first: pd.Series, third: pd.Series
) -> pd.Series:
    """Phase 4 score for every candidate, from earlier first-of-base trades in its cell."""
    spec = criteria()["score"]
    out = pd.Series(50.0, index=cands.index)
    keys = ["pattern", "entry", "above_50dma"]
    past = cands[first & trades["r"].notna()].assign(
        third=third, r=trades["r"], exit_date=trades["exit_date"]
    )
    frame = cands.assign(third=third)
    for key, cell in past.groupby([*keys, "third"]):
        cell = cell.sort_values("exit_date")
        known = cell["exit_date"].to_numpy()
        csum = np.cumsum(cell["r"].to_numpy())
        mine = frame
        for k, v in zip([*keys, "third"], key, strict=True):
            mine = mine[mine[k] == v]
        if mine.empty:
            continue
        n = np.searchsorted(known, mine["date"].to_numpy(), side="left")  # exited BEFORE d
        mean = np.where(n > 0, csum[np.maximum(n - 1, 0)] / np.maximum(n, 1), 0.0)
        value = np.clip(50 + 50 * mean, 0, 100)
        out.loc[mine.index] = np.where(n >= spec["min_past_trades"], value, 50.0)
    return out


def health(
    cands: pd.DataFrame, trades: pd.DataFrame, first: pd.Series, days: pd.DatetimeIndex
) -> pd.Series:
    """True (healthy) per session: the win rate of first-of-base trades that exited in the last
    `window` sessions is at or above its own expanding median up to that session."""
    window = criteria()["health_switch"]["window_sessions"]
    done = trades[first & trades["r"].notna()]
    wins = (done["r"] > 0).groupby(done["exit_date"]).sum().reindex(days, fill_value=0)
    count = done.groupby("exit_date").size().reindex(days, fill_value=0)
    rate = wins.rolling(window, min_periods=1).sum() / count.rolling(window, min_periods=1).sum()
    median = rate.expanding().median().shift(1)
    return (rate >= median) | median.isna() | rate.isna()


def _cutoff_mask(cands: pd.DataFrame, score: pd.Series, option: str) -> pd.Series:
    if option.startswith("score>=70"):
        return score >= 70
    if option.startswith("score>=80"):
        return score >= 80
    if option.startswith("friday"):
        friday = cands["date"].dt.weekday == 4
        return (friday & (score >= 70)) | (~friday & (score >= 83))
    raise ValueError(option)


def _mean_r_by_month(trades: pd.DataFrame, mask: pd.Series, months: pd.PeriodIndex) -> np.ndarray:
    t = trades[mask & trades["r"].notna()]
    by = t.groupby(t["entry_date"].dt.to_period("M"))["r"].mean()
    return by.reindex(months).fillna(0.0).to_numpy()


def stage_a(cands: pd.DataFrame, outcomes: dict[str, pd.DataFrame], echo=print) -> dict:
    spec = criteria()
    first = first_per_base(cands)
    years = spec["windows"]["walk_forward_years"]
    embargo = pd.Timedelta(weeks=spec["windows"]["embargo_weeks"])
    months = pd.period_range(
        spec["windows"]["development"]["from"], spec["windows"]["development"]["to"], freq="M"
    )
    result: dict = {}
    for pattern in spec["patterns"]["names"]:
        stats, matrix, picks, joined = {}, [], {}, []
        for entry, stop, target in combos():
            name = combo_name(entry, stop, target)
            t = outcomes[f"{stop}|{target}"]
            mask = first & (cands["pattern"] == pattern) & (cands["entry"] == entry)
            r = t.loc[mask, "r"].dropna()
            stats[name] = {
                "trades": int(len(r)),
                "mean_r": float(r.mean()) if len(r) else math.nan,
                "win_rate": float((r > 0).mean()) if len(r) else math.nan,
                "median_sessions": float(t.loc[r.index, "sessions"].median())
                if len(r)
                else math.nan,
            }
            matrix.append(_mean_r_by_month(t, mask, months))
        names = [combo_name(*c) for c in combos()]
        for year in years:
            cut = pd.Timestamp(f"{year}-01-01") - embargo
            best, best_mean = None, -math.inf
            for (entry, stop, target), name in zip(combos(), names, strict=True):
                t = outcomes[f"{stop}|{target}"]
                mask = first & (cands["pattern"] == pattern) & (cands["entry"] == entry)
                r = t.loc[mask & (t["exit_date"] < cut), "r"].dropna()
                if len(r) and r.mean() > best_mean:
                    best, best_mean = name, r.mean()
            picks[year] = best
            entry, stop, target = combos()[names.index(best)]
            t = outcomes[f"{stop}|{target}"]
            mask = first & (cands["pattern"] == pattern) & (cands["entry"] == entry)
            held = t.loc[mask & (t["entry_date"].dt.year == year), "r"].dropna()
            joined.extend(held.tolist())
        full = max(
            (n for n in names if not math.isnan(stats[n]["mean_r"])),
            key=lambda n: stats[n]["mean_r"],
        )
        pbo = method.pbo(np.column_stack(matrix), blocks=spec["search"]["stage_a"]["pbo"]["blocks"])
        result[pattern] = {
            "combos": stats,
            "walk_forward_picks": {str(y): p for y, p in picks.items()},
            "walk_forward_trades": len(joined),
            "walk_forward_mean_r": float(np.mean(joined)) if joined else math.nan,
            "walk_forward_win_rate": float(np.mean(np.array(joined) > 0)) if joined else math.nan,
            "pbo": pbo,
            "passes": bool(pbo["pbo"] <= spec["search"]["stage_a"]["pbo"]["kill_above"]),
            "full_window_choice": full,
        }
        echo(
            f"stage A {pattern}: walk-forward {len(joined)} trades, mean R "
            f"{result[pattern]['walk_forward_mean_r']:+.3f}, PBO {pbo['pbo']:.2f}"
        )
    return result


def _weekly_log(curve: pd.Series) -> pd.Series:
    weekly = curve.resample("W-FRI").last().dropna()
    return np.log(weekly).diff().dropna()


def stage_b(
    cands: pd.DataFrame,
    outcomes: dict[str, pd.DataFrame],
    closes: pd.DataFrame,
    a: dict,
    *,
    holdout_choice: bool = False,
    echo=print,
) -> dict:
    spec = criteria()
    window = spec["windows"]["development"]
    years = spec["windows"]["walk_forward_years"]
    embargo = pd.Timedelta(weeks=spec["windows"]["embargo_weeks"])
    patterns = [p for p in spec["patterns"]["names"] if a[p]["passes"]]
    if not patterns:
        return {"patterns": [], "note": "no pattern passed stage A; stage B not run"}
    first = first_per_base(cands)
    cuts = quality_cuts(cands[first])
    third = thirds(cands, cuts)
    days = closes.loc[window["from"] : window["to"]].index

    def active(pattern: str, year: int) -> tuple[str, str, float | None]:
        names = [combo_name(*c) for c in combos()]
        pick = a[pattern]["walk_forward_picks"][str(max(year, years[0]))]
        return combos()[names.index(pick)]

    # per (pattern, year) the active combination's trades, scores and health
    trades = pd.DataFrame(
        index=cands.index, columns=["entry_date", "exit_date", "fill", "exit_price"]
    )
    score = pd.Series(np.nan, index=cands.index)
    healthy = pd.Series(True, index=cands.index)
    in_play = pd.Series(False, index=cands.index)
    for pattern in patterns:
        for year in range(pd.Timestamp(window["from"]).year, years[-1] + 1):
            entry, stop, target = active(pattern, year)
            t = outcomes[f"{stop}|{target}"]
            mask = (
                (cands["pattern"] == pattern)
                & (cands["entry"] == entry)
                & (cands["date"].dt.year == year)
            )
            if not mask.any():
                continue
            pmask = (cands["pattern"] == pattern) & (cands["entry"] == entry)
            s = scores(cands[pmask], t[pmask], first[pmask], third[pmask])
            h = health(cands[pmask], t[pmask], first[pmask], days)
            trades.loc[mask, ["entry_date", "exit_date", "fill", "exit_price"]] = t.loc[
                mask, ["entry_date", "exit_date", "fill", "exit_price"]
            ].to_numpy()
            score.loc[mask] = s.reindex(cands.index).loc[mask]
            healthy.loc[mask] = h.reindex(cands.loc[mask, "date"]).fillna(True).to_numpy()
            in_play |= mask
    for col in ("entry_date", "exit_date"):
        trades[col] = pd.to_datetime(trades[col])
    for col in ("fill", "exit_price"):
        trades[col] = trades[col].astype(float)
    frame = cands.assign(score=score)

    curves, logs = {}, {}
    for option, switch in itertools.product(
        spec["cutoffs"]["options"], spec["health_switch"]["options"]
    ):
        allowed = in_play & _cutoff_mask(frame, score, option)
        if switch == "on":
            allowed &= healthy
        name = f"{option} | health {switch}"
        echo(f"stage B {name} ...")
        curve, log = run_portfolio(
            frame, trades, closes, allowed=allowed, start=window["from"], end=window["to"]
        )
        curves[name], logs[name] = curve, log
    weekly = pd.DataFrame({k: _weekly_log(v) for k, v in curves.items()}).fillna(0.0)
    picks, joined = {}, []
    for year in years:
        cut = pd.Timestamp(f"{year}-01-01") - embargo
        best = weekly.loc[:cut].sum().idxmax()
        picks[year] = best
        joined.append(weekly.loc[f"{year}-01-01" : f"{year}-12-31", best])
    joined_s = pd.concat(joined)
    judged = weekly.loc[f"{years[0]}-01-01" :]
    pbo = method.pbo(judged.to_numpy(), blocks=spec["search"]["stage_b"]["pbo"]["blocks"])
    stats = {}
    for name, curve in curves.items():
        part = curve.loc[f"{years[0]}-01-01" :]
        log = logs[name]
        stats[name] = {
            "cagr_2015_2023": float(metrics.cagr(part)),
            "mdd_2015_2023": float(metrics.max_drawdown(part)[0]),
            "trades": int(len(log)),
            "win_rate": float(((log["exit_value"] - log["cost_value"]) > 0).mean())
            if len(log)
            else math.nan,
        }
    joined_cagr = float(math.exp(joined_s.sum() * 52 / len(joined_s)) - 1)
    joined_curve = np.exp(joined_s.cumsum())
    return {
        "patterns": patterns,
        "portfolios": stats,
        "walk_forward_picks": {str(y): p for y, p in picks.items()},
        "walk_forward_cagr": joined_cagr,
        "walk_forward_mdd": float(metrics.max_drawdown(joined_curve)[0]),
        "walk_forward_weeks": [str(joined_s.index[0].date()), str(joined_s.index[-1].date())],
        "pbo": pbo,
        "passes_pbo": bool(pbo["pbo"] <= spec["search"]["stage_b"]["pbo"]["kill_above"]),
        "full_window_choice": weekly.sum().idxmax(),
        "joined_weekly": joined_s,
        "curves": curves,
    }


def calibration(cands: pd.DataFrame, outcomes: dict[str, pd.DataFrame], a: dict) -> dict:
    """Phase 4: does a higher (causal) score go with a better later R? Per pattern, on its
    full-window stage-A choice, first-of-base trades bucketed by their score."""
    first = first_per_base(cands)
    third = thirds(cands, quality_cuts(cands[first]))
    names = [combo_name(*c) for c in combos()]
    edges = [-1, 40, 49.999, 50.001, 60, 70, 80, 101]
    labels = ["<40", "40-50", "50 (too few)", "50-60", "60-70", "70-80", ">=80"]
    out = {}
    for pattern, info in a.items():
        entry, stop, target = combos()[names.index(info["full_window_choice"])]
        t = outcomes[f"{stop}|{target}"]
        pmask = (cands["pattern"] == pattern) & (cands["entry"] == entry)
        s = scores(cands[pmask], t[pmask], first[pmask], third[pmask])
        done = first[pmask] & t.loc[pmask, "r"].notna()
        frame = pd.DataFrame({"score": s[done], "r": t.loc[pmask, "r"][done]})
        frame["bucket"] = pd.cut(frame["score"], edges, labels=labels)
        table = frame.groupby("bucket", observed=False)["r"].agg(["count", "mean"])
        out[pattern] = {
            "combo": info["full_window_choice"],
            "buckets": {
                str(k): {"trades": int(v["count"]), "mean_r": float(v["mean"])}
                for k, v in table.iterrows()
            },
        }
    return out


def run_dev(
    cands: pd.DataFrame, bars_by_symbol: dict, closes: pd.DataFrame, out: Path, echo=print
) -> dict:
    """Stages A and B on the development window; writes the result JSON to `out`."""
    from ... import reference_benchmarks

    exits = criteria()["exits"]
    outcomes = {}
    for stop, (_, target) in itertools.product(exits["stops"], exits["targets"].items()):
        echo(f"trades for stop {stop}, target {target} ...")
        outcomes[f"{stop}|{target}"] = trade_outcomes(
            cands, bars_by_symbol, stop_rule=stop, target_r=target
        )
    a = stage_a(cands, outcomes, echo=echo)
    b = stage_b(cands, outcomes, closes, a, echo=echo)
    report: dict = {
        "stage_a": a,
        "calibration": calibration(cands, outcomes, a),
        "stage_b": {k: v for k, v in b.items() if k not in ("joined_weekly", "curves")},
    }
    if b.get("patterns"):
        refs = reference_benchmarks.load_references()
        weekly = b["joined_weekly"]
        span = weekly.index
        nifty = reference_benchmarks.aligned(refs["Nifty 500 TRI"], span)
        n500 = float(metrics.cagr(nifty)) if nifty is not None else math.nan
        report["nifty500_tri_cagr_same_weeks"] = n500
        report["development_passes"] = bool(
            any(a[p]["passes"] for p in a) and b["passes_pbo"] and b["walk_forward_cagr"] > n500
        )
        pd.DataFrame(b["curves"]).to_parquet(out.parent / "dev_portfolio_curves.parquet")
    else:
        report["development_passes"] = False
    report["interpretation"] = (
        "Stage B includes only the patterns that pass stage A. Portfolio years 2012-2014 use the "
        "2015 stage-A choice and only train stage B's first walk-forward pick; the judged years "
        "are 2015-2023."
    )
    out.write_text(json.dumps(report, indent=1, default=str))
    return report
