"""BL-010 Phase 6 step 0: pick the ensemble Phase 6 follows (criteria addendum 4), after
checking the picking rule with its own walk-forward. Writes `ensemble.json` and `ensemble.md`.

The pick is frozen (written to `search_spaces/bl010_phase6_frozen.json` by the caller) only if
the walk-forward passes; otherwise addendum 4 says Phase 6 tracks the index alone unless the
owner decides otherwise.
"""

from __future__ import annotations

import json
import math
from pathlib import Path

import numpy as np
import pandas as pd

from . import choose, criteria, search
from .phase5 import MIDCAP, MOM30, SMALLCAP, _pct


def _joined(table: pd.DataFrame, column: str) -> float:
    """Annualised chained return; NaN if any year is missing (a missing year is a failure,
    never a 0% year)."""
    years = len(table)
    if not years or table[column].isna().any():
        return math.nan
    return float((1 + table[column]).prod()) ** (1 / years) - 1


def run(
    curves: pd.DataFrame,
    scores: pd.DataFrame,
    facts: pd.DataFrame,
    records: dict[str, dict],
    series: dict[str, pd.Series],
    out: Path,
    *,
    echo=print,
) -> dict:
    out.mkdir(parents=True, exist_ok=True)
    spec = criteria.load()["phase_6_ensemble"]
    basket = spec["eligible"]["basket"]
    bench = series[MOM30].reindex(curves.index).ffill()
    indices = {k: series[k].reindex(curves.index).ffill() for k in (MIDCAP, SMALLCAP)}
    fys = choose.complete_fys(curves.index)
    report: dict = {"basket": basket, "fys": fys}

    membership: dict = {}
    for label, partial in (("committed", False), ("with_fy2019_partial", True)):
        echo(f"walk-forward: {label} ...")
        table = choose.walk_forward_ensemble(
            curves, indices, bench, facts, partial_first=partial, membership=membership, echo=echo
        )
        summary = {
            "years": [int(y) for y in table.index],
            "ensemble": _joined(table, "ensemble_return"),
            "median": _joined(table, "median_return"),
            "bench": _joined(table, "bench_return"),
            "table": json.loads(table.to_json(orient="index")),
        }
        if label == "committed":
            short = [int(y) for y, r in table.iterrows() if r["too_few"]]
            complete = not any(math.isnan(summary[k]) for k in ("ensemble", "median", "bench"))
            summary["too_few_years"] = short
            summary["passes"] = bool(
                complete
                and not short
                and summary["ensemble"] >= summary["median"] - 0.02
                and summary["ensemble"] >= summary["bench"] + 0.05
            )
            if not complete:
                summary["why_not"] = "a year has no ensemble, median or index return"
            elif short:
                summary["why_not"] = f"fewer than {choose.MIN_PICKS} picks in FY{short}"
        report[label] = summary

    echo("the pick on the full history ...")
    full = choose.basket_members(curves, indices)[basket]
    group = choose.ensemble_group(full, facts)
    windows = [choose.fy_bounds(f) for f in fys]
    picks = choose.typical_set(curves, group, bench, windows)
    phases = choose.rebalance_phases(picks, facts)
    line = choose.ensemble_curve(curves, picks)
    depth = float((line / line.cummax() - 1).min())
    fy_rows = {}
    for fy in fys:
        start, end = choose.fy_bounds(fy)
        fy_rows[fy] = {
            "ensemble": choose.ensemble_window_return(curves, picks, start, end),
            "group_median": float(choose.window_returns(curves[group], start, end).median()),
            "bench": float(choose.window_returns(bench, start, end)),
        }
    pairwise = np.log(curves[picks].astype(float)).diff().corr().to_numpy(copy=True)
    np.fill_diagonal(pairwise, np.nan)
    report["pick"] = {
        "group": len(group),
        "too_few": len(picks) < choose.MIN_PICKS,
        "configs": [
            {
                "id": cid,
                "holdings": int(facts.at[cid, "holdings"]),
                "rebalance_every": int(facts.at[cid, "every"]),
                "phase_slot": phases[cid],
                "cagr": float(choose.cagr(curves[cid])),
                # The curves blend every phase; Phase 6 trades one, somewhere in this range.
                "cagr_worst_phase": float(scores.at[cid, "cagr_worst_phase"]),
                "cagr_best_phase": float(scores.at[cid, "cagr_best_phase"]),
                "heavy": records[cid]["heavy"],
                "light": records[cid]["light"],
            }
            for cid in picks
        ],
        "max_pairwise_corr": float(np.nanmax(pairwise)) if len(picks) > 1 else math.nan,
        "ensemble_cagr": float(choose.cagr(line)),
        "ensemble_mdd": depth,
        "ensemble_ulcer": float(choose.ulcer(line.to_frame()).iloc[0]),
        "group_median_cagr": float(choose.cagr(curves[group]).median()),
        "bench_cagr": float(choose.cagr(bench)),
        "fy": fy_rows,
    }
    (out / "ensemble.json").write_text(json.dumps(report, indent=1, default=float))
    (out / "ensemble.md").write_text(markdown(report))
    echo(f"wrote {out / 'ensemble.md'}")
    return report


def markdown(report: dict) -> str:
    c, s = report["committed"], report["with_fy2019_partial"]
    p = report["pick"]
    lines = [
        "# BL-010 Phase 6: the ensemble to follow (criteria addendum 4)",
        "",
        f"Basket: {report['basket']}; 8-12 holdings; rebalance every 2 or 4 weeks. Pre-tax, "
        "Rs 2 lakh, point-in-time universe, today's curated tags.",
        "",
        "## Does the picking rule work? (walk-forward)",
        "",
        "| Variant | Years | Ensemble | Group median | Mom30 TRI |",
        "|---|---|---|---|---|",
    ]
    for label, w in (("committed", c), ("with FY2019 (sensitivity)", s)):
        years = w["years"]
        lines.append(
            f"| {label} | FY{years[0]}-FY{years[-1]} | {_pct(w['ensemble'])} | "
            f"{_pct(w['median'])} | {_pct(w['bench'])} |"
        )
    lines += [
        "",
        "Pass: the ensemble no more than 2 points a year below the group median and at least 5 "
        f"points above Mom30 TRI. **{'Passes' if c['passes'] else 'Killed'}.**"
        + (f" ({c['why_not']})" if c.get("why_not") else ""),
        "",
        "| FY | Picked on | Group | Ensemble | Group median | Mom30 TRI |",
        "|---|---|---|---|---|---|",
    ]
    for fy, row in s["table"].items():
        lines.append(
            f"| {fy} | {row['selected_on']} | {row['group']} | {_pct(row['ensemble_return'])} | "
            f"{_pct(row['median_return'])} | {_pct(row['bench_return'])} |"
        )
    lines += [
        "",
        f"## The pick on the full history ({p['group']} configs eligible)",
        "",
        "| Config | Holdings | Every | Phase (rebalance_offset) | CAGR, phases blended "
        "| CAGR, worst to best phase |",
        "|---|---|---|---|---|---|",
    ]
    for cfg in p["configs"]:
        lines.append(
            f"| `{cfg['id']}` | {cfg['holdings']} | {cfg['rebalance_every']} weeks | "
            f"{cfg['phase_slot']} | {_pct(cfg['cagr'])} | "
            f"{_pct(cfg['cagr_worst_phase'])} to {_pct(cfg['cagr_best_phase'])} |"
        )
    lines += [
        "",
        f"Ensemble (equal capital, reset each April): CAGR {_pct(p['ensemble_cagr'])}, max "
        f"drawdown {_pct(p['ensemble_mdd'])}, Ulcer {_pct(p['ensemble_ulcer'])}. Group median "
        f"config {_pct(p['group_median_cagr'])}; Mom30 TRI {_pct(p['bench_cagr'])}. Highest "
        f"correlation between two picks: {p['max_pairwise_corr']:.2f}.",
        "",
        "The figures blend every rebalance phase. Phase 6 trades each config on one phase (its "
        "`rebalance_offset`: Fridays whose week number since 2016-01-01 is the phase mod "
        "`rebalance_every`), so a live result can sit several points either side.",
        "" + ("**Fewer than 3 configs were found; the owner decides.**" if p["too_few"] else ""),
        "",
        "| FY | Ensemble | Group median | Mom30 TRI |",
        "|---|---|---|---|",
    ]
    for fy, row in p["fy"].items():
        lines.append(
            f"| {fy} | {_pct(row['ensemble'])} | {_pct(row['group_median'])} | "
            f"{_pct(row['bench'])} |"
        )
    return "\n".join(lines) + "\n"


def freeze(
    report: dict, path: Path, *, commit: str, snapshot: dict | None, scored_digest: str, fixed: dict
) -> dict:
    """Addendum 4's freeze record: what Phase 6 follows, exactly, and what it was picked on.
    Refuses to freeze a pick whose walk-forward did not pass."""
    if not report["committed"]["passes"]:
        raise ValueError("the walk-forward did not pass; addendum 4 says report it, not freeze it")
    p = report["pick"]
    record = {
        "frozen": pd.Timestamp.now(tz="Asia/Kolkata").isoformat(timespec="seconds"),
        "rule": "search_spaces/bl010_criteria_addendum_4.json",
        "code_commit": commit,
        "data_snapshot": snapshot,
        "scored_curves_sha256": scored_digest,
        "basket": report["basket"],
        "capital": "equal per config, reset to equal at the last week before each 1 April",
        "phase_meaning": "rebalance_offset: trade on Fridays whose week number since "
        "engine.CADENCE_EPOCH (2016-01-01) is the offset mod rebalance_every",
        "fixed_settings": fixed,
        "configs": [
            {k: cfg[k] for k in ("id", "holdings", "rebalance_every", "heavy", "light")}
            | {"rebalance_offset": cfg["phase_slot"]}
            for cfg in p["configs"]
        ],
        "expected_pre_tax": {
            "ensemble_cagr": p["ensemble_cagr"],
            "ensemble_max_drawdown": p["ensemble_mdd"],
            "walk_forward_cagr_fy2020_fy2026": report["committed"]["ensemble"],
            "group_median_walk_forward": report["committed"]["median"],
            "mom30_walk_forward": report["committed"]["bench"],
        },
    }
    path.write_text(json.dumps(record, indent=2, default=float) + "\n")
    return record


# --- the frozen configs as live requests (BL-010 Phase 6, step 1) --------------------------------

#: The search's parameter name -> the `BacktestRequest` field that carries it. Every parameter a
#: frozen config can set must be here, or `favourite_requests` refuses: a parameter the live path
#: cannot take would silently run on an API default instead.
REQUEST_FIELDS = {
    # fixed settings
    "start": "start",
    "cost_model": "cost_model",
    "cost_pct": "cost_pct",
    "slippage_bps": "slippage_bps",
    "capital": "capital",
    "respect_circuits": "broad_respect_circuits",
    "min_ranked": "broad_every_week",  # 1 -> True, 0 -> False (the only two the API can say)
    "momentum_sizing": "momentum_sizing",
    "momentum_sizing_window": "momentum_sizing_window",
    "momentum_sizing_floor": "momentum_sizing_floor",
    "signal_delay": "signal_delay",
    "cap_band": "cap_band",
    "max_stock_price": "max_stock_price",
    "sell_every_week": "sell_every_week",
    # heavy (the ranking)
    "series_break_policy": "broad_series_breaks",
    "lookbacks": "lookbacks",
    "weight_scheme": "weights",  # expanded with search.weights_for
    "score": "score",
    "voladj_skip_recent_month": "voladj_skip_recent_month",
    "liq_min_turnover_cr": "broad_liq_min_turnover_cr",
    "liq_floor_ratio": "broad_liq_floor_ratio",
    "liq_min_price": "broad_liq_min_price",
    "liq_circuit": "broad_liq_circuit",
    "liq_circuit_run": "broad_liq_circuit_run",
    "liq_max_circuit_days": "broad_liq_max_circuit_days",
    # light (everything after the ranking)
    "coverage_floor": "broad_coverage_floor",
    "pool_top_n": "broad_pool_top_n",
    "pool_exit_rank": "broad_pool_exit_rank",
    "category_top_n": "broad_category_top_n",
    "category_exit_rank": "broad_category_exit_rank",
    "picks_per_category": "broad_picks_per_category",
    "max_position": "max_position",
    "max_category": "max_category",
    "rebalance_every": "rebalance_every",
    "rebalance_offset": "rebalance_offset",
    "entry": "entry",
    "stock_tilt": "broad_reversal_tilt",
    "stock_tilt_screen_pct": "broad_reversal_screen_pct",
}

#: What the search runs with when a space says nothing (the defaults of `bias.Runner` and
#: `run_broad_backtest`), written out so no request field is left to an API default that could
#: differ. Keyed by search parameter. `tests/test_phase6_parity.py` compares the two paths' real
#: arguments, so a drift in either set of defaults fails there.
_SEARCH_DEFAULTS = {
    "cost_model": "flat",
    "cost_pct": 0.10,
    "slippage_bps": 5.0,
    "capital": 1_000_000.0,
    "respect_circuits": False,
    "min_ranked": 0,
    "momentum_sizing": False,
    "momentum_sizing_window": 10,
    "momentum_sizing_floor": 0.0,
    "signal_delay": 0,
    "cap_band": 0.05,
    "max_stock_price": None,
    "sell_every_week": False,
    "series_break_policy": "verified",
    "weight_scheme": None,
    "score": "ranksum",
    "voladj_skip_recent_month": True,
    "liq_min_turnover_cr": 1.0,
    "liq_floor_ratio": 0.25,
    "liq_min_price": 20.0,
    "liq_circuit": True,
    "liq_circuit_run": 3,
    "liq_max_circuit_days": None,
    "max_position": 0.35,
    "max_category": None,
    "rebalance_every": 1,
    "rebalance_offset": 0,
    "entry": "wait",
    "stock_tilt": 0.0,
    "stock_tilt_screen_pct": 0.0,
}


def effective_parameters(fixed: dict, config: dict) -> dict:
    """Every parameter `bias.Runner(...).run(base, heavy, light, rebalance_offset=<top-level>)`
    runs one frozen config with, merged the way the search merges them: the space's fixed
    settings, then the config's light values, then the TOP-LEVEL `rebalance_offset`. The light
    dict's own `rebalance_offset` is the search's raw sample and is never used; the heavy dict
    (which repeats the fixed heavy settings) wins for the ranking-side ones."""
    heavy = {**{k: v for k, v in fixed.items() if k in search.HEAVY_KEYS}, **config["heavy"]}
    light = {k: v for k, v in config["light"].items() if k != "rebalance_offset"}
    if light.get("rebalance_every", config["rebalance_every"]) != config["rebalance_every"]:
        raise ValueError(f"config {config['id']}: rebalance_every differs between light and top")
    rest = {k: v for k, v in fixed.items() if k not in search.HEAVY_KEYS}
    return {**rest, **heavy, **light, "rebalance_offset": config["rebalance_offset"]}


def favourite_request(fixed: dict, config: dict) -> dict:
    """One frozen config as a complete `BacktestRequest` dict for the Broad dataset."""
    params = effective_parameters(fixed, config)
    unmapped = sorted(set(params) - set(REQUEST_FIELDS))
    if unmapped:
        raise ValueError(
            f"config {config['id']}: no request field for {unmapped}; the live path cannot "
            "reproduce it"
        )
    values = {**_SEARCH_DEFAULTS, **params}
    request: dict = {
        "dataset": "broad",
        "universe": ["broad_momentum"],  # required by the model, ignored for Broad
        "end": None,
        "portfolio": "buffer",
        "rebalance": "weekly",
        "broad_category_mode": "on",
        "broad_category_tags": "curated",
        "broad_universe": "turnover_rank",
        "broad_liquidity_filter": True,
    }
    for key, field in REQUEST_FIELDS.items():
        if key not in values:
            continue
        value = values[key]
        if key == "weight_scheme":
            value = search.weights_for(value, len(values["lookbacks"]))
            value = list(value) if value is not None else None
        elif key == "lookbacks":
            value = list(value)
        elif key == "min_ranked":
            if value not in (0, 1):
                raise ValueError(f"config {config['id']}: min_ranked {value} has no request form")
            value = bool(value)
        request[field] = value
    return request


def favourite_requests(frozen: dict) -> list[dict]:
    """The frozen record's configs as the `BacktestRequest` dicts the live weekly signal must run
    to reproduce what the search measured: Broad, point-in-time `turnover_rank` universe behind
    the tradability gate, curated tags, category mode on, every week simulated, and each config's
    top-level `rebalance_offset`. Nothing is left to an API default."""
    return [favourite_request(frozen["fixed_settings"], cfg) for cfg in frozen["configs"]]
