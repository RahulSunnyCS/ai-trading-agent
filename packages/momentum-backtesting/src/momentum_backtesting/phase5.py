"""BL-010 Phase 5, end to end: robustness over time, the walk-forward of the choice rule, the
factor check, and the choice itself, per criteria addendum 3. Reads stored weekly curves
(`method.score_search`) and writes `report.json` plus `report.md` to an output folder.

Inputs are named series so the caller decides where they come from:

  Nifty200 Momentum 30 TRI   the benchmark every excess is measured against
  Nifty Midcap 150 TRI,      the drawdown baskets' relative limits
  Nifty Smallcap 250 TRI
  Nifty 50 TRI, cash         the factor regression
"""

from __future__ import annotations

import json
import math
from pathlib import Path

import numpy as np
import pandas as pd

from . import choose, criteria

MOM30 = "Nifty200 Momentum 30 TRI"
MIDCAP = "Nifty Midcap 150 TRI"
SMALLCAP = "Nifty Smallcap 250 TRI"
NIFTY50 = "Nifty 50 TRI"
CASH = "cash"
SAMPLE = 100
EVENTS = {
    "2018-19 small-cap bear": ("2018-01-01", "2019-08-31"),
    "Covid fall": ("2020-02-01", "2020-03-31"),
    "Recovery 2020-21": ("2020-04-01", "2021-12-31"),
    "2022": ("2022-01-01", "2022-12-31"),
    "Run-up 2023-24": ("2023-01-01", "2024-09-30"),
    "Fall Oct-24 to Mar-25": ("2024-10-01", "2025-03-31"),
    "Apr-25 to latest": ("2025-04-01", None),  # None: the last week of data
}
HOLDINGS_ULCER_TOLERANCE = 0.25  # "similar Ulcer index": within 25% of the 8-12 line's


def _rolling(series: pd.DataFrame | pd.Series, years: int) -> pd.DataFrame:
    """Annualised return over every `years`-long window starting each quarter."""
    starts = pd.date_range(series.index[0], series.index[-1], freq="QS")
    rows = {}
    for start in starts:
        end = start + pd.DateOffset(years=years) - pd.Timedelta(days=1)
        if end > series.index[-1]:
            break
        if start <= series.index[0]:
            continue
        growth = choose.window_returns(series, start, end)
        rows[start.date().isoformat()] = (1 + growth) ** (1 / years) - 1
    return pd.DataFrame(rows).T if isinstance(series, pd.DataFrame) else pd.Series(rows)


def stitched(curves: pd.DataFrame, table: pd.DataFrame) -> pd.Series:
    """The weekly curve of holding each year's chosen config through its FY, chained."""
    pieces, level = [], 1.0
    for fy, row in table.iterrows():
        if row["chosen"] is None or (
            isinstance(row["chosen"], float) and math.isnan(row["chosen"])
        ):
            continue
        start, end = choose.fy_bounds(int(fy))
        weeks = curves.index
        before = weeks[weeks < start][-1]
        span = curves.loc[before:end, row["chosen"]]
        part = span / span.iloc[0] * level
        pieces.append(part.iloc[1:] if pieces else part)
        level = float(part.iloc[-1])
    return pd.concat(pieces) if pieces else pd.Series(dtype=float)


def _pct(x: float) -> str:
    return "n/a" if x is None or (isinstance(x, float) and math.isnan(x)) else f"{x:.1%}"


def _pts(x: float) -> str:
    return "n/a" if x is None or (isinstance(x, float) and math.isnan(x)) else f"{x * 100:+.1f}"


def run(
    curves: pd.DataFrame,
    scores: pd.DataFrame,
    facts: pd.DataFrame,
    series: dict[str, pd.Series],
    out: Path,
    *,
    echo=print,
) -> dict:
    out.mkdir(parents=True, exist_ok=True)
    rules = criteria.load()
    p5 = rules["phase_5_robustness"]
    bench = series[MOM30].reindex(curves.index).ffill()
    indices = {k: series[k].reindex(curves.index).ffill() for k in (MIDCAP, SMALLCAP)}
    fys = choose.complete_fys(curves.index)
    fy_windows = [choose.fy_bounds(f) for f in fys]
    last = curves.index[-1]
    events = {k: (s, e or last) for k, (s, e) in EVENTS.items()}
    events[f"FY{fys[-1] + 1} to date"] = (choose.fy_bounds(fys[-1] + 1)[0], last)
    report: dict = {"fys": fys, "configs": curves.shape[1], "weeks": curves.shape[0], "baskets": {}}

    echo(f"{curves.shape[1]} configs, {curves.shape[0]} weeks, FY{fys[0]}-FY{fys[-1]}")
    fy_ret = choose.fy_table(curves, fys)
    bench_fy = pd.Series({fy: choose.window_returns(bench, *choose.fy_bounds(fy)) for fy in fys})
    excess = fy_ret.sub(bench_fy, axis=0)
    rank_all = choose.lower_bound(excess)
    top_half = fy_ret.rank(axis=1, pct=True) > 0.5  # FY x config: in the top half of the space
    martin_all = choose.martin(curves)
    ulcer_all = choose.ulcer(curves)

    echo("baskets on the full history ...")
    members = choose.basket_members(curves, indices)
    rng = np.random.default_rng(0)
    for name, ids in members.items():
        echo(f"{name}: {len(ids)} configs")
        entry: dict = {"eligible": len(ids)}
        report["baskets"][name] = entry
        if not ids:
            continue

        # Step 1: are the top 100 (by CAGR, the search's own ranking) special? Against 100
        # random configs of the same basket (the top ones included), drawn 100 times.
        by_cagr = scores.loc[ids, "cagr"].sort_values(ascending=False)
        size = min(SAMPLE, len(ids))
        top = list(by_cagr.index[:size])
        top_median = fy_ret[top].median(axis=1)
        gaps = [
            top_median - fy_ret[list(rng.choice(ids, size=size, replace=False))].median(axis=1)
            for _ in range(100)
        ]
        gap = pd.concat(gaps, axis=1).mean(axis=1)
        beat_share = float(np.mean([(g > 0).mean() for g in gaps]))
        positive = gap.clip(lower=0)
        late = positive.loc[[f for f in (2024, 2025) if f in gap.index]].sum()
        late_share = float(late / positive.sum()) if positive.sum() > 0 else math.nan
        entry["top100_vs_random"] = {
            "sample": size,
            "draws": len(gaps),
            "fy_gap_pts": {int(k): float(v) for k, v in gap.items()},
            "beats_random_share": beat_share,
            "edge_from_fy24_fy25": late_share,
            "killed": bool(
                beat_share < p5["kill_top100_claim"]["beats_random100_in_fy_windows_below"]
                or late_share > 0.5
            ),
        }

        # Step 4: the choice, and the checks around it.
        chosen, rank, found = choose.choose(curves, ids, bench, fy_windows, facts)
        lb_top50 = set(rank.sort_values(ascending=False).index[:50])
        cagr_top50 = set(by_cagr.index[:50])
        overlap = len(lb_top50 & cagr_top50) / 50 if len(ids) >= 50 else math.nan
        entry["clusters"] = len(found)
        entry["singleton_clusters"] = sum(len(c.members) == 1 for c in found)
        entry["largest_clusters"] = [
            {"medoid": c.medoid, "members": len(c.members), "score": c.score} for c in found[:10]
        ]
        entry["rank_top50_overlap_with_cagr_top50"] = overlap
        entry["killed_rank_is_cagr_noise"] = (
            overlap < p5["choice"]["kill_if_lower_bound_top50_overlap_with_cagr_top50_below"]
        )
        if chosen is None:
            continue
        cid = chosen.medoid
        curve = curves[cid]
        pass_share = float(top_half.loc[:, cid].mean())
        worst_fy = float(excess[cid].min())
        entry["chosen"] = {
            "id": cid,
            "cluster_members": len(chosen.members),
            "cluster_score": chosen.score,
            "holdings": int(facts.at[cid, "holdings"]),
            "rebalance_every": int(facts.at[cid, "every"]),
            "cagr": float(scores.at[cid, "cagr"]),
            "mdd": float(scores.at[cid, "mdd"]),
            "ulcer": float(ulcer_all[cid]),
            "martin": float(martin_all[cid]),
            "rank_measure": float(rank_all[cid]),
            "fy_excess_pts": {int(k): float(v) for k, v in excess[cid].items()},
            "top_half_share": pass_share,
            "worst_fy_excess": worst_fy,
            "passes": pass_share >= p5["config_pass"]["top_half_of_space_in_fy_windows"]
            and worst_fy >= -p5["config_pass"]["no_fy_trailing_mom30_by_pts"] / 100,
            "events": {k: choose.window_returns(curve, *v) for k, v in events.items()},
            "events_bench": {k: choose.window_returns(bench, *v) for k, v in events.items()},
            "events_basket_median": {
                k: float(choose.window_returns(curves[ids], *v).median()) for k, v in events.items()
            },
        }
        for years in (2, 3):
            mine, theirs = _rolling(curve, years), _rolling(bench, years)
            diff = (mine - theirs).dropna()
            entry["chosen"][f"rolling_{years}y"] = {
                "worst": float(mine.min()),
                "median": float(mine.median()),
                "best": float(mine.max()),
                "worst_vs_bench_pts": float(diff.min()),
                "share_above_bench": float((diff > 0).mean()),
            }
        if NIFTY50 in series and CASH in series:
            factors = choose.factor_regression(
                curve, series[CASH], series[NIFTY50], indices[SMALLCAP], bench
            )
            kill = p5["factor_regression"]
            factors["killed"] = bool(
                factors["alpha_pa"] < kill["kill_alpha_below_pct"] / 100
                or abs(factors["alpha_t"]) < kill["kill_abs_t_below"]
            )
            entry["chosen"]["factors"] = factors
        entry["chosen"]["bootstrap"] = [
            choose.block_bootstrap(curve, mean_block=b) for b in (13, 26)
        ]

    # Threshold stability: move each basket's fixed limit by 5 points either way.
    echo("threshold stability ...")
    step = p5["choice"]["threshold_stability_pts"] / 100
    for loosen in (-step, step):
        moved = choose.basket_members(curves, indices, loosen=loosen)
        for name, ids in moved.items():
            chosen, _, _ = choose.choose(curves, ids, bench, fy_windows, facts)
            base = report["baskets"][name].get("chosen", {}).get("id")
            report["baskets"][name].setdefault("stability", {})[f"{loosen:+.2f}"] = {
                "eligible": len(ids),
                "chosen": chosen.medoid if chosen else None,
                "same_config": bool(chosen and chosen.medoid == base),
                "base_in_its_cluster": bool(chosen and base in chosen.members),
            }

    # Step 2: walk the rule forward; then the same restricted to 2-6 and to 8-12 holdings.
    wf_kill = p5["walk_forward"]
    # "with_fy2019_partial" is a labelled sensitivity, not the committed rule: FY2019 has no
    # complete FY before its cut, so the committed rule skips it; here it is ranked on the one
    # partial window there is (January to December 2017).
    for label, holdings, partial in (
        ("committed", None, False),
        ("with_fy2019_partial", None, True),
        ("holdings_2_6", (2, 6), False),
        ("holdings_8_12", (8, 12), False),
    ):
        echo(f"walk-forward: {label} ...")
        tables = choose.walk_forward(
            curves, indices, bench, facts, holdings=holdings, partial_first=partial, echo=echo
        )
        for name, table in tables.items():
            summary = choose.joined(table)
            line = stitched(curves, table)
            summary["ulcer"] = (
                float(choose.ulcer(line.to_frame()).iloc[0]) if len(line) else math.nan
            )
            summary["years"] = [int(y) for y in table.index] if not table.empty else []
            summary["table"] = json.loads(table.to_json(orient="index")) if not table.empty else {}
            if label == "committed" and summary.get("chosen") is not None:
                summary["killed"] = (
                    summary["chosen"] - summary["median"]
                    < wf_kill["kill_if_not_above_median_config_pts"] / 100
                ) or (summary["chosen"] <= summary["bench"])
            report["baskets"][name].setdefault("walk_forward", {})[label] = summary
    for entry in report["baskets"].values():
        wf = entry.get("walk_forward", {})
        narrow, broad = wf.get("holdings_2_6", {}), wf.get("holdings_8_12", {})
        if narrow.get("chosen") is not None and broad.get("chosen") is not None:
            ahead = narrow["chosen"] - broad["chosen"]
            similar = abs(narrow["ulcer"] - broad["ulcer"]) <= HOLDINGS_ULCER_TOLERANCE * max(
                broad["ulcer"], 1e-9
            )
            entry["holdings_check"] = {
                "pick_2_6_minus_pick_8_12": ahead,
                "median_2_6_minus_median_8_12": narrow["median"] - broad["median"],
                "ulcer_2_6": narrow["ulcer"],
                "ulcer_8_12": broad["ulcer"],
                "similar_ulcer_tolerance": HOLDINGS_ULCER_TOLERANCE,
                "similar": bool(similar),
            }
            entry["holdings_preference_killed"] = bool(
                ahead > p5["choice"]["kill_holdings_advice_if_2_to_6_beats_by_pts"] / 100
                and similar
            )

    (out / "report.json").write_text(json.dumps(report, indent=1, default=float))
    (out / "report.md").write_text(markdown(report))
    echo(f"wrote {out / 'report.md'}")
    return report


def _killed(flag) -> str:
    return "" if flag is None or flag == "" else ("**killed**" if flag else "passes")


def markdown(report: dict) -> str:
    fys = report["fys"]
    lines = [
        "# BL-010 Phase 5 report",
        "",
        f"{report['configs']} configs, {report['weeks']} weeks, FY{fys[0]}-FY{fys[-1]}. "
        "Pre-tax, Rs 2 lakh, point-in-time universe, today's curated tags (an upper estimate: "
        "the tags, and the search space's bounds, were set with hindsight). Windows are slices "
        "of each continuous curve, not fresh starts.",
        "",
        "## The space, per basket",
        "",
        "| Basket | Eligible | Clusters (singletons) | Top 100 beat random | Edge from FY24-25 "
        "| Rank vs CAGR top-50 overlap |",
        "|---|---|---|---|---|---|",
    ]
    for name, e in report["baskets"].items():
        t = e.get("top100_vs_random", {})
        lines.append(
            f"| {name} | {e['eligible']} | "
            f"{e.get('clusters', 0)} ({e.get('singleton_clusters', 0)}) | "
            f"{_pct(t.get('beats_random_share', math.nan))} "
            f"{_killed(t.get('killed'))} | "
            f"{_pct(t.get('edge_from_fy24_fy25', math.nan))} | "
            f"{_pct(e.get('rank_top50_overlap_with_cagr_top50', math.nan))} "
            f"{_killed(e.get('killed_rank_is_cagr_noise'))} |"
        )
    lines += [
        "",
        "Top 100 by CAGR against 100 random configs of the same basket, 100 draws: the share of "
        "financial years in which the top 100's median beats the random median (kill below 60%, "
        "or more than half the edge from FY2024-25). Rank overlap: of the 50 best by the "
        "third-worst-FY rank, how many are among the 50 best by CAGR (kill below 20%: ranking by "
        "CAGR was noise).",
        "",
        "## Walk-forward of the rule",
        "",
        "| Basket | Variant | Years | Chosen | Median config | Mom30 TRI | Ulcer | Verdict |",
        "|---|---|---|---|---|---|---|---|",
    ]
    for name, e in report["baskets"].items():
        for label, w in e.get("walk_forward", {}).items():
            if not w:
                continue
            years = w.get("years", [])
            span = f"FY{years[0]}-FY{years[-1]}" if years else "-"
            lines.append(
                f"| {name} | {label} | {span} | {_pct(w.get('chosen', math.nan))} | "
                f"{_pct(w.get('median', math.nan))} | {_pct(w.get('bench', math.nan))} | "
                f"{_pct(w.get('ulcer', math.nan))} | {_killed(w.get('killed'))} |"
            )
    sens = next(iter(report["baskets"].values())).get("walk_forward", {}).get("with_fy2019_partial")
    fy19 = (sens or {}).get("table", {}).get("2019")
    lines += [
        "",
        "The committed rule needs a complete financial year to rank on, so it starts at FY2020: "
        "FY2019's cut (2017-12-31) comes before the first complete FY ends. "
        + (
            f"FY2019 was the small-cap bear: Mom30 TRI {_pct(fy19['bench_return'])}, the "
            f"median config {_pct(fy19['median_return'])}. "
            if fy19
            else ""
        )
        + "`with_fy2019_partial` adds it, ranked on January to December 2017: a sensitivity, "
        "not the committed rule. Kill (committed only): not 3 points a year above the median "
        "config, or not above Mom30 TRI.",
        "",
    ]
    for name, e in report["baskets"].items():
        h = e.get("holdings_check")
        if h:
            lines.append(
                f"{name} holdings check: the rule's pick among 2-6 holdings minus its pick among "
                f"8-12, {_pts(h['pick_2_6_minus_pick_8_12'])} pts a year; median config 2-6 minus "
                f"8-12, {_pts(h['median_2_6_minus_median_8_12'])} pts; "
                f"Ulcer {_pct(h['ulcer_2_6'])} "
                f"vs {_pct(h['ulcer_8_12'])} (similar = within "
                f"{h['similar_ulcer_tolerance']:.0%}). 8-12 preference "
                f"{_killed(e.get('holdings_preference_killed'))}."
            )
    lines += ["", "## Chosen per basket (full history)", ""]
    for name, e in report["baskets"].items():
        c = e.get("chosen")
        if not c:
            lines += [f"**{name}:** none eligible.", ""]
            continue
        lines += [
            f"**{name}:** `{c['id']}`, medoid of a {c['cluster_members']}-config cluster; "
            f"{c['holdings']} holdings, every {c['rebalance_every']} weeks. "
            f"CAGR {_pct(c['cagr'])}, max drawdown {_pct(c['mdd'])}, Ulcer {_pct(c['ulcer'])}, "
            f"third-worst FY vs Mom30 {_pts(c['rank_measure'])} pts, worst FY "
            f"{_pts(c['worst_fy_excess'])} pts, top half of the space in "
            f"{_pct(c['top_half_share'])} of FYs: {'passes' if c['passes'] else '**fails**'} "
            "(needs 70% and no FY more than 10 points behind Mom30).",
            "",
        ]
        if "factors" in c:
            f = c["factors"]
            lines.append(
                f"- Factor check: alpha {_pct(f['alpha_pa'])} a year (t {f['alpha_t']:.1f}); "
                f"betas market {f['beta_market']:.2f}, size {f['beta_size']:.2f}, "
                f"momentum {f['beta_momentum']:.2f}: {_killed(f.get('killed'))}."
            )
        for b in c["bootstrap"]:
            lines.append(
                f"- Bootstrap ({b['mean_block_weeks']}-week blocks): "
                f"CAGR 5-95% {_pct(b['cagr_p5'])} to "
                f"{_pct(b['cagr_p95'])}; 1-in-20 max drawdown {_pct(b['mdd_p5'])}."
            )
        for years in (2, 3):
            r = c[f"rolling_{years}y"]
            lines.append(
                f"- Rolling {years}-year: worst {_pct(r['worst'])}, median {_pct(r['median'])}, "
                f"best {_pct(r['best'])}; worst vs Mom30 {_pts(r['worst_vs_bench_pts'])} pts; "
                f"ahead of it in {_pct(r['share_above_bench'])} of windows."
            )
        stab = e.get("stability", {})
        if stab:
            lines.append(
                "- Basket limit moved 5 points (fixed limit only; ceiling and relative rule "
                "unchanged): "
                + "; ".join(
                    f"{k}: {'same config' if v['same_config'] else v['chosen']}"
                    for k, v in stab.items()
                )
                + "."
            )
        lines += [
            "",
            "| Window | Chosen | Basket median | Mom30 TRI |",
            "|---|---|---|---|",
        ]
        for k, v in c["events"].items():
            lines.append(
                f"| {k} | {_pct(v)} | {_pct(c['events_basket_median'][k])} | "
                f"{_pct(c['events_bench'][k])} |"
            )
        lines.append("")
    return "\n".join(lines) + "\n"
