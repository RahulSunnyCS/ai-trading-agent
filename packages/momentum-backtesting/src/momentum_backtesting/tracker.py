"""BL-010 Phase 6 step 3: paper tracking of the frozen ensemble (criteria addendum 5).

Read-only. From a start Friday, measure three things side by side: the ensemble (equal capital
in the four frozen configs, reset each April), the median companion (the config of addendum 4's
eligible group whose full-history CAGR is closest to the group's median, ties to the lower id)
and Nifty200 Momentum 30 TRI; then test addendum 5's two fail lines.

Each config's model portfolio is the engine's own (the frozen request, its own rebalance Fridays,
pre-tax, Rs 2 lakh), run through the latest week. The model portfolio exists since 2017, so
"tracking from S" rebases its curve at the week before S, and what is measured is the portfolio
as it stood then: its holdings carry in, exactly as a paper account opened on that day would
hold them. Nothing is written to the shared database, and nothing here saves a favourite.
"""

from __future__ import annotations

import json
from pathlib import Path

import pandas as pd

from . import choose, metrics

#: Addendum 5, paper_tracking.fail.drawdown: 1.3 x 43.9%, where 43.9% is the 1-in-20 max drawdown
#: of the frozen ensemble's full-history curve (stationary bootstrap, 13-week blocks, seed 0).
DRAWDOWN_LIMIT = -0.571
#: Addendum 5, paper_tracking.fail.trailing_index: at 26 weeks, ensemble minus Mom30 below this.
TRAILING_LIMIT = -0.10
TRAILING_WEEKS = 26


def start_week(index: pd.DatetimeIndex, since: str | pd.Timestamp) -> pd.Timestamp:
    """The week the tracking is rebased at: the last week on or before `since`."""
    earlier = index[index <= pd.Timestamp(since)]
    if not len(earlier):
        raise ValueError(f"no week on or before {since}")
    return earlier[-1]


def _rebased(curve: pd.Series, start: pd.Timestamp) -> pd.Series:
    sliced = curve.loc[start:]
    return sliced / sliced.iloc[0]


def evaluate(
    ensemble: pd.Series, companion: pd.Series, bench: pd.Series, since: str | pd.Timestamp
) -> dict:
    """Addendum 5's two fail tests and the side-by-side numbers, from weekly curves."""
    start = start_week(ensemble.index, since)
    e, c, b = (
        _rebased(s.reindex(ensemble.index).ffill(), start) for s in (ensemble, companion, bench)
    )
    weeks = len(e) - 1
    depth, peak, trough = metrics.max_drawdown(e)
    out: dict = {
        "start": str(start.date()),
        "latest": str(e.index[-1].date()),
        "weeks": weeks,
        "returns": {
            "ensemble": float(e.iloc[-1] - 1),
            "companion": float(c.iloc[-1] - 1),
            "mom30": float(b.iloc[-1] - 1),
        },
        "drawdown": {
            "ensemble": float(depth),
            "companion": float(metrics.max_drawdown(c)[0]),
            "mom30": float(metrics.max_drawdown(b)[0]),
        },
        "fail": {},
    }
    if weeks >= TRAILING_WEEKS:
        at = e.index[TRAILING_WEEKS]
        gap = float((e.loc[at] - 1) - (b.loc[at] - 1))
        out["fail"]["trailing_index"] = {
            "measured_at": str(at.date()),
            "ensemble_minus_mom30": gap,
            "failed": gap < TRAILING_LIMIT,
        }
    else:
        out["fail"]["trailing_index"] = {
            "measured_at": None,
            "failed": False,
            "note": "not yet 26 weeks",
        }
    out["fail"]["drawdown"] = {
        "ensemble_max_drawdown": float(depth),
        "limit": DRAWDOWN_LIMIT,
        "failed": bool(depth < DRAWDOWN_LIMIT),
    }
    out["failed"] = any(v["failed"] for v in out["fail"].values())
    # The latest gap to the index, for the weekly read (the rule is judged at week 26 only).
    out["latest_gap_to_mom30"] = float((e.iloc[-1] - 1) - (b.iloc[-1] - 1))
    out["curves"] = {
        "ensemble": {str(k.date()): float(v) for k, v in e.items()},
        "companion": {str(k.date()): float(v) for k, v in c.items()},
        "mom30": {str(k.date()): float(v) for k, v in b.items()},
    }
    return out


def median_companion(curves: pd.DataFrame, group: list[str]) -> str:
    """Addendum 5: the group's config whose full-history CAGR is closest to the group's median
    (ties: the lower config id)."""
    cagr = pd.Series({cid: choose.cagr(curves[cid]) for cid in group})
    target = cagr.median()
    distance = (cagr - target).abs()
    return sorted(distance.index[distance == distance.min()])[0]


def run_config(runner, cfg: dict) -> pd.Series:
    """One frozen config's weekly equity through the latest week: the same call as the search
    (and, per the parity tests, the live path), with the frozen rebalance offset."""
    heavy = cfg["heavy"]
    light = {
        **cfg["light"],
        "rebalance_offset": cfg.get("rebalance_offset", cfg["light"].get("rebalance_offset", 0)),
    }
    outcome, _ = runner.run(runner.base(heavy), heavy, light)
    return outcome.result.equity


def markdown(report: dict) -> str:
    r, d = report["returns"], report["drawdown"]
    lines = [
        "# BL-010 Phase 6: paper tracking",
        "",
        f"Tracking from {report['start']} to {report['latest']} ({report['weeks']} weeks). "
        "The four "
        "frozen configs, equal capital reset each April, pre-tax, against the median companion "
        f"(`{report['companion_id']}`) and Nifty200 Momentum 30 TRI.",
        "",
        "| | Return since start | Worst fall since start |",
        "|---|---|---|",
        f"| **Ensemble** | {r['ensemble']:+.1%} | {d['ensemble']:.1%} |",
        f"| Median companion | {r['companion']:+.1%} | {d['companion']:.1%} |",
        f"| Nifty200 Momentum 30 TRI | {r['mom30']:+.1%} | {d['mom30']:.1%} |",
        "",
        "Ensemble minus Nifty200 Momentum 30 TRI so far: "
        f"{report['latest_gap_to_mom30'] * 100:+.1f} points.",
        "",
    ]
    t, dd = report["fail"]["trailing_index"], report["fail"]["drawdown"]
    lines.append(
        "- Trailing the index (judged at 26 weeks; fail if more than 10 points behind): "
        + (
            f"{t['ensemble_minus_mom30'] * 100:+.1f} points at {t['measured_at']}: "
            f"**{'FAILED' if t['failed'] else 'ok'}**"
            if t["measured_at"]
            else t["note"]
        )
    )
    lines.append(
        f"- Drawdown (fail if the ensemble falls deeper than {dd['limit']:.1%}): worst so far "
        f"{dd['ensemble_max_drawdown']:.1%}: **{'FAILED' if dd['failed'] else 'ok'}**"
    )
    lines.append("")
    lines.append(
        "**Overall: "
        + ("FAILED, report to the owner." if report["failed"] else "no fail line crossed.")
        + "**"
    )
    return "\n".join(lines) + "\n"


def track(
    frozen_path: Path,
    space_path: Path,
    results_dir: Path,
    scored_dir: Path,
    refs: pd.DataFrame,
    since: str,
    out: Path | None = None,
    *,
    echo=print,
) -> dict:
    """Run the four frozen configs and the companion through the latest week and evaluate."""
    from . import bias, method, search
    from .phase5 import MOM30

    frozen = json.loads(Path(frozen_path).read_text())
    space = search.load_space(space_path)
    runner = bias.Runner(space, universe_kind="turnover_rank", category_tags="curated")

    curves = {}
    for cfg in frozen["configs"]:
        echo(f"{cfg['id']} ...")
        curves[cfg["id"]] = run_config(runner, cfg)
    frame = pd.DataFrame(curves).ffill()
    ensemble = choose.ensemble_curve(frame / frame.iloc[0], list(frame.columns))

    # The companion: the median config of the same eligible group, run the same way.
    scores, scored = method.load_scores(scored_dir)
    records = bias.load_records(results_dir, set(scored.columns))
    facts = choose.config_facts(records)
    from . import criteria

    indices = {
        k: refs[k].reindex(scored.index).ffill()
        for k in ("Nifty Midcap 150 TRI", "Nifty Smallcap 250 TRI")
    }
    basket = criteria.load()["phase_6_ensemble"]["eligible"]["basket"]
    group = choose.ensemble_group(choose.basket_members(scored, indices)[basket], facts)
    companion_id = median_companion(scored, group)
    rec = records[companion_id]
    echo(f"median companion {companion_id} ...")
    companion = run_config(runner, {"heavy": rec["heavy"], "light": rec["light"]})

    report = evaluate(ensemble, companion, refs[MOM30].dropna(), since)
    report["companion_id"] = companion_id
    report["configs"] = [cfg["id"] for cfg in frozen["configs"]]
    if out is not None:
        out.mkdir(parents=True, exist_ok=True)
        stamp = report["latest"]
        (out / f"tracking-{stamp}.json").write_text(json.dumps(report, indent=1))
        (out / f"tracking-{stamp}.md").write_text(markdown(report))
    return report
