"""BL-043 addendum 1: the one retry (development window).

Differences from `research.py` (kept as it was, for the recorded original result):

- trades are judged in net % after costs, with a 3% minimum stop distance (`trader`);
- every first-of-base candidate gets 3 matched random controls: other strong stocks eligible
  the same day with no candidate, bought at the next open with the candidate's stop distance,
  target and time limit. Stage A picks and judges on the EDGE (candidate net minus the
  controls' mean);
- the score is built from past net % returns, not R;
- idle cash earns the liquid fund;
- the walk-forward portfolio is ONE continuous simulation from 2015 that applies each year's
  chosen rules, not a stitch of separate portfolios (PR #103 review, P1).
"""

from __future__ import annotations

import itertools
import json
import math
from pathlib import Path

import numpy as np
import pandas as pd

from ... import method, metrics
from ..bars import SymbolBars
from . import criteria
from .research import (
    _cutoff_mask,
    combo_name,
    combos,
    first_per_base,
    health,
    quality_cuts,
    thirds,
)
from .trader import run_portfolio, simulate_trade, trade_outcomes


def sample_controls(
    cands: pd.DataFrame, first: pd.Series, pool: pd.DataFrame
) -> dict[int, list[str]]:
    """candidate index -> control symbols (seeded): eligible that day, no candidate that day."""
    spec = criteria()["control"]
    rng = np.random.default_rng(spec["seed"])
    eligible = pool.groupby("date")["symbol"].apply(lambda s: np.array(sorted(s), dtype=object))
    busy = cands.groupby("date")["symbol"].apply(set)
    out: dict[int, list[str]] = {}
    for idx, row in cands[first].sort_values(["date", "symbol"]).iterrows():
        options = eligible.get(row["date"])
        if options is None:
            out[idx] = []
            continue
        free = [s for s in options if s not in busy.get(row["date"], ())]
        k = min(spec["per_candidate"], len(free))
        out[idx] = list(rng.choice(free, size=k, replace=False)) if k else []
    return out


def control_net(
    cands: pd.DataFrame,
    trades: pd.DataFrame,
    controls: dict[int, list[str]],
    bars_by_symbol: dict[str, SymbolBars],
    positions: dict[str, dict],
    target_r: float | None,
) -> pd.Series:
    """Mean net % of each candidate's controls, with the candidate's stop distance."""
    out = pd.Series(np.nan, index=cands.index)
    for idx, symbols in controls.items():
        risk = trades.at[idx, "risk"] if idx in trades.index else np.nan
        if not symbols or not np.isfinite(risk):
            continue
        day = np.datetime64(cands.at[idx, "date"], "ns")
        nets = []
        for sym in symbols:
            signal = positions[sym].get(day)
            if signal is None:
                continue
            t = simulate_trade(
                bars_by_symbol[sym], signal, base_low=np.nan, atr=np.nan,
                stop_rule="control", target_r=target_r, stop_pct=float(risk),
            )  # fmt: skip
            if t:
                nets.append(t["net_return"])
        if nets:
            out.at[idx] = float(np.mean(nets))
    return out


def scores_net(
    cands: pd.DataFrame, trades: pd.DataFrame, first: pd.Series, third: pd.Series
) -> pd.Series:
    """0-100 from earlier first-of-base trades' mean net % in the same cell, exited before the
    signal day; 50 until the cell has `min_past_trades`."""
    spec = criteria()["score"]
    out = pd.Series(50.0, index=cands.index)
    keys = ["pattern", "entry", "above_50dma", "third"]
    frame = cands.assign(third=third)
    past = frame[first & trades["net_return"].notna()].assign(
        net=trades["net_return"], exit_date=trades["exit_date"]
    )
    for key, cell in past.groupby(keys):
        cell = cell.sort_values("exit_date")
        known = cell["exit_date"].to_numpy()
        csum = np.cumsum(cell["net"].to_numpy())
        mine = frame
        for k, v in zip(keys, key, strict=True):
            mine = mine[mine[k] == v]
        if mine.empty:
            continue
        n = np.searchsorted(known, mine["date"].to_numpy(), side="left")
        mean = np.where(n > 0, csum[np.maximum(n - 1, 0)] / np.maximum(n, 1), 0.0)
        value = np.clip(50 + 50 * mean / 0.05, 0, 100)
        out.loc[mine.index] = np.where(n >= spec["min_past_trades"], value, 50.0)
    return out


def cash_growth(days: pd.DatetimeIndex, weekly: pd.Series) -> pd.Series:
    """Per session, the factor idle cash grows by: each week's liquid-fund return spread
    evenly over that week's sessions."""
    weekly = weekly.dropna().sort_index()
    ret = weekly.pct_change().dropna()
    label = days - pd.to_timedelta(days.weekday, unit="D") + pd.Timedelta(days=4)
    per_week = pd.Series(1, index=days).groupby(label).transform("count")
    r = ret.reindex(ret.index.union(label.unique())).ffill().reindex(label).fillna(0.0).to_numpy()
    return pd.Series((1 + r) ** (1 / per_week.to_numpy()), index=days)


def _monthly(values: pd.Series, dates: pd.Series, months: pd.PeriodIndex) -> np.ndarray:
    by = values.groupby(dates.dt.to_period("M")).mean()
    return by.reindex(months).fillna(0.0).to_numpy()


def stage_a(cands, outcomes, ctrl_nets, echo=print) -> dict:
    spec = criteria()
    first = first_per_base(cands)
    years = spec["windows"]["walk_forward_years"]
    embargo = pd.Timedelta(weeks=spec["windows"]["embargo_weeks"])
    window = spec["windows"]["development"]
    months = pd.period_range(window["from"], window["to"], freq="M")
    names = [combo_name(*c) for c in combos()]
    result = {}
    for pattern in spec["patterns"]["names"]:
        stats, matrix, picks, joined = {}, [], {}, []
        edges = {}
        for (entry, stop, target), name in zip(combos(), names, strict=True):
            key = f"{stop}|{target}"
            t = outcomes[key]
            mask = first & (cands["pattern"] == pattern) & (cands["entry"] == entry)
            both = mask & t["net_return"].notna() & ctrl_nets[key].notna()
            edge = (t["net_return"] - ctrl_nets[key])[both]
            edges[name] = (edge, t.loc[both, "exit_date"], t.loc[both, "entry_date"])
            stats[name] = {
                "trades": int(both.sum()),
                "mean_net": float(t.loc[both, "net_return"].mean()) if both.any() else math.nan,
                "mean_control_net": float(ctrl_nets[key][both].mean()) if both.any() else math.nan,
                "mean_edge": float(edge.mean()) if both.any() else math.nan,
                "win_rate": float((t.loc[both, "net_return"] > 0).mean())
                if both.any()
                else math.nan,
                "median_sessions": float(t.loc[both, "sessions"].median())
                if both.any()
                else math.nan,
            }
            matrix.append(_monthly(edge, t.loc[both, "entry_date"], months))
        for year in years:
            cut = pd.Timestamp(f"{year}-01-01") - embargo
            best, best_mean = None, -math.inf
            for name in names:
                edge, exits, _ = edges[name]
                past = edge[exits < cut]
                if len(past) and past.mean() > best_mean:
                    best, best_mean = name, past.mean()
            picks[year] = best
            edge, _, entries = edges[best]
            joined.extend(edge[entries.dt.year == year].tolist())
        full = max(
            (n for n in names if np.isfinite(stats[n]["mean_edge"])),
            key=lambda n: stats[n]["mean_edge"],
        )
        pbo = method.pbo(np.column_stack(matrix), blocks=spec["search"]["stage_a"]["pbo"]["blocks"])
        wf_edge = float(np.mean(joined)) if joined else math.nan
        result[pattern] = {
            "combos": stats,
            "walk_forward_picks": {str(y): p for y, p in picks.items()},
            "walk_forward_trades": len(joined),
            "walk_forward_mean_edge": wf_edge,
            "pbo": pbo,
            "passes": bool(
                wf_edge > 0 and pbo["pbo"] <= spec["search"]["stage_a"]["pbo"]["kill_above"]
            ),
            "full_window_choice": full,
        }
        echo(
            f"stage A {pattern}: walk-forward edge {wf_edge:+.2%} over {len(joined)} trades, "
            f"PBO {pbo['pbo']:.2f}, full-window best {full} "
            f"(net {stats[full]['mean_net']:+.2%} vs controls "
            f"{stats[full]['mean_control_net']:+.2%})"
        )
    return result


def stage_b(cands, outcomes, closes, growth, a, echo=print) -> dict:
    spec = criteria()
    window = spec["windows"]["development"]
    years = spec["windows"]["walk_forward_years"]
    embargo = pd.Timedelta(weeks=spec["windows"]["embargo_weeks"])
    patterns = [p for p in spec["patterns"]["names"] if a[p]["passes"]]
    if not patterns:
        return {"patterns": [], "note": "no pattern passed stage A; stage B not run"}
    first = first_per_base(cands)
    third = thirds(cands, quality_cuts(cands[first]))
    days = closes.loc[window["from"] : window["to"]].index
    names = [combo_name(*c) for c in combos()]
    first_year = pd.Timestamp(window["from"]).year

    cols = ["entry_date", "exit_date", "fill", "exit_price"]
    trades = pd.DataFrame(index=cands.index, columns=cols)
    score = pd.Series(np.nan, index=cands.index)
    healthy = pd.Series(True, index=cands.index)
    in_play = pd.Series(False, index=cands.index)
    for pattern in patterns:
        for year in range(first_year, years[-1] + 1):
            pick = a[pattern]["walk_forward_picks"][str(max(year, years[0]))]
            entry, stop, target = combos()[names.index(pick)]
            t = outcomes[f"{stop}|{target}"]
            pmask = (cands["pattern"] == pattern) & (cands["entry"] == entry)
            mask = pmask & (cands["date"].dt.year == year)
            if not mask.any():
                continue
            s = scores_net(cands[pmask], t[pmask], first[pmask], third[pmask])
            h = health(cands[pmask], t[pmask], first[pmask], days)
            trades.loc[mask, cols] = t.loc[mask, cols].to_numpy()
            score.loc[mask] = s.reindex(cands.index).loc[mask]
            healthy.loc[mask] = h.reindex(cands.loc[mask, "date"]).fillna(True).to_numpy()
            in_play |= mask
    for col in ("entry_date", "exit_date"):
        trades[col] = pd.to_datetime(trades[col])
    for col in ("fill", "exit_price"):
        trades[col] = trades[col].astype(float)
    frame = cands.assign(score=score)

    rules = {}
    for option, switch in itertools.product(
        spec["cutoffs"]["options"], spec["health_switch"]["options"]
    ):
        allowed = in_play & _cutoff_mask(frame, score, option)
        if switch == "on":
            allowed &= healthy
        rules[f"{option} | health {switch}"] = allowed
    curves = {}
    for name, allowed in rules.items():
        echo(f"stage B {name} ...")
        curves[name], _ = run_portfolio(
            frame, trades, closes, allowed=allowed, start=window["from"], end=window["to"],
            cash_growth=growth,
        )  # fmt: skip
    weekly = pd.DataFrame(
        {k: np.log(v.resample("W-FRI").last().dropna()).diff().dropna() for k, v in curves.items()}
    ).fillna(0.0)
    picks = {}
    wf_allowed = pd.Series(False, index=cands.index)
    for year in years:
        cut = pd.Timestamp(f"{year}-01-01") - embargo
        picks[year] = weekly.loc[:cut].sum().idxmax()
        wf_allowed |= rules[picks[year]] & (cands["date"].dt.year == year)
    echo("stage B walk-forward portfolio (one continuous run) ...")
    wf_curve, wf_log = run_portfolio(
        frame, trades, closes, allowed=wf_allowed, start=f"{years[0]}-01-01", end=window["to"],
        cash_growth=growth,
    )  # fmt: skip
    judged = weekly.loc[f"{years[0]}-01-01" :]
    pbo = method.pbo(judged.to_numpy(), blocks=spec["search"]["stage_b"]["pbo"]["blocks"])
    stats = {
        name: {
            "cagr_2015_2023": float(metrics.cagr(c.loc[f"{years[0]}-01-01" :])),
            "mdd_2015_2023": float(metrics.max_drawdown(c.loc[f"{years[0]}-01-01" :])[0]),
        }
        for name, c in curves.items()
    }
    return {
        "patterns": patterns,
        "portfolios": stats,
        "walk_forward_picks": {str(y): p for y, p in picks.items()},
        "walk_forward_cagr": float(metrics.cagr(wf_curve)),
        "walk_forward_mdd": float(metrics.max_drawdown(wf_curve)[0]),
        "walk_forward_trades": int(len(wf_log)),
        "pbo": pbo,
        "passes_pbo": bool(pbo["pbo"] <= spec["search"]["stage_b"]["pbo"]["kill_above"]),
        "full_window_choice": weekly.sum().idxmax(),
        "wf_curve": wf_curve,
        "curves": curves,
    }


def run_dev(
    cands, bars_by_symbol, closes, pool, cash_weekly, out: Path, curves_dir: Path, echo=print
) -> dict:
    from ... import reference_benchmarks

    exits = criteria()["exits"]
    first = first_per_base(cands)
    positions = {
        sym: {np.datetime64(d, "ns"): i for i, d in enumerate(b.dates)}
        for sym, b in bars_by_symbol.items()
    }
    controls = sample_controls(cands, first, pool)
    outcomes, ctrl_nets = {}, {}
    for stop, (_, target) in itertools.product(exits["stops"], exits["targets"].items()):
        key = f"{stop}|{target}"
        echo(f"trades and controls for stop {stop}, target {target} ...")
        outcomes[key] = trade_outcomes(cands, bars_by_symbol, stop_rule=stop, target_r=target)
        ctrl_nets[key] = control_net(
            cands, outcomes[key], controls, bars_by_symbol, positions, target
        )
    a = stage_a(cands, outcomes, ctrl_nets, echo=echo)
    window = criteria()["windows"]["development"]
    days = closes.loc[window["from"] : window["to"]].index
    b = stage_b(cands, outcomes, closes, cash_growth(days, cash_weekly), a, echo=echo)
    report: dict = {
        "stage_a": a,
        "stage_b": {k: v for k, v in b.items() if k not in ("wf_curve", "curves")},
    }
    passes = False
    if b.get("patterns"):
        refs = reference_benchmarks.load_references()
        weekly = b["wf_curve"].resample("W-FRI").last().dropna()
        bench = {}
        for name in ("Nifty 500 TRI", "Nifty Midcap 150 TRI", "Nifty Smallcap 250 TRI"):
            line = reference_benchmarks.aligned(refs[name], weekly.index)
            bench[name] = {
                "cagr": float(metrics.cagr(line)) if line is not None else math.nan,
                "mdd": float(metrics.max_drawdown(line)[0]) if line is not None else math.nan,
            }
        report["benchmarks_same_weeks"] = bench
        mid, n500 = bench["Nifty Midcap 150 TRI"], bench["Nifty 500 TRI"]
        passes = bool(
            b["passes_pbo"]
            and b["walk_forward_cagr"] > n500["cagr"]
            and b["walk_forward_cagr"] > mid["cagr"]
            and b["walk_forward_mdd"] >= mid["mdd"]
        )
        pd.DataFrame({"walk_forward": b["wf_curve"], **b["curves"]}).to_parquet(
            curves_dir / "retry_dev_curves.parquet"
        )
    report["development_passes"] = passes
    out.write_text(json.dumps(report, indent=1, default=str))
    return report
