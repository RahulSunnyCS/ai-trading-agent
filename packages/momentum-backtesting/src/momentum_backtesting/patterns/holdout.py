"""BL-042 Phase 6: the one run on the sealed hold-out (bl042_criteria.json `phase_6_holdout`).

Only a pattern that passed Phase 3 (not dropped in addendum 1), Phase 4 (event study) and
Phase 5 (walk-forward and PBO) enters, with the shape Phase 5 chose for it. The run is claimed
before anything reads the hold-out: a claim file, then the result file, and both refuse a second
run. A crash after the claim is reported to the owner, never retried silently. The code must be
committed first, so the result names the exact commit that produced it.

When no pattern enters, the result says so and the hold-out is never read.
"""

from __future__ import annotations

import json
from pathlib import Path

import pandas as pd

from .. import holdout as bl010_holdout
from . import SEARCH_SPACES, criteria
from .run import OUT_DIR, learned_column, load_detections

RESULT = "bl042_holdout_result.json"
CLAIM = "bl042_holdout.claimed"


def entrants() -> dict[str, str]:
    """pattern -> the shape Phase 5 chose, for every pattern that passed Phases 3-5."""
    from . import frozen

    spec = frozen()
    if spec is None:
        raise RuntimeError("the detectors are not frozen: Phases 3-5 come before the hold-out")
    dropped = set(spec.get("dropped_patterns", []))
    study = json.loads((SEARCH_SPACES / "bl042_event_study_result.json").read_text())
    dev = json.loads((SEARCH_SPACES / "bl042_dev_result.json").read_text())
    return {
        pattern: shape
        for pattern, shape in dev["holdout_choice"].items()
        if pattern not in dropped
        and study["verdicts"].get(pattern) == "pass"
        and dev["verdicts"].get(pattern) == "pass"
    }


def judge(base: pd.Series, mine: pd.Series) -> dict:
    from .. import metrics

    rule = criteria()["phase_6_holdout"]["pass"]
    b_cagr, m_cagr = metrics.cagr(base), metrics.cagr(mine)
    b_mdd, m_mdd = metrics.max_drawdown(base)[0], metrics.max_drawdown(mine)[0]
    excess_pts = (m_cagr - b_cagr) * 100
    dd_worse_pts = (b_mdd - m_mdd) * 100  # drawdowns are negative: positive = deeper
    return {
        "cagr": float(m_cagr),
        "mdd": float(m_mdd),
        "baseline_cagr": float(b_cagr),
        "baseline_mdd": float(b_mdd),
        "excess_cagr_pts": float(excess_pts),
        "drawdown_worse_pts": float(dd_worse_pts),
        "passes": bool(
            excess_pts >= rule["excess_cagr_pts_over_baseline"]
            and dd_worse_pts <= rule["max_drawdown_not_worse_than_baseline_by_pts"]
        ),
    }


def _claim(out_dir: Path) -> Path:
    result = SEARCH_SPACES / RESULT
    if result.exists():
        raise RuntimeError(f"{result.name} exists: the BL-042 hold-out runs once")
    if bl010_holdout._dirty():
        raise RuntimeError("uncommitted changes to the code: commit them, then run")
    out_dir.mkdir(parents=True, exist_ok=True)
    try:
        with (out_dir / CLAIM).open("x") as claim:
            claim.write(f"started on {bl010_holdout._commit()}\n")
    except FileExistsError:
        raise RuntimeError(
            f"{out_dir / CLAIM} exists: the hold-out was already started (one run allowed). "
            "Report it to the owner; do not re-run."
        ) from None
    return result


def run(out_dir: Path = OUT_DIR, *, echo=print) -> dict:
    from .. import reference_benchmarks
    from ..categories import circuit_exposure as cx
    from ..categories.liquidity import turnover_rank_members_by_year
    from . import ranking as shapes
    from .bars import load_daily
    from .features import detect, score_table
    from .quality import with_quality
    from .universe import broad_ranking

    chosen = entrants()
    result_path = _claim(out_dir)
    window = criteria()["windows"]["holdout"]
    start, end = window["from"], window["to"]
    report: dict = {
        "window": [start, end],
        "commit": bl010_holdout._commit(),
        "entrants": chosen,
        "patterns": {},
    }
    if chosen:
        first, last = pd.Timestamp(start).year, pd.Timestamp(end).year
        members = turnover_rank_members_by_year()
        symbols = sorted(set().union(*(members.get(y, set()) for y in range(first, last + 1))))
        echo(f"{len(symbols)} symbols; detecting on the hold-out ...")
        # Enough history before the window for a 65-week cup plus its 52-week advance.
        daily = load_daily(symbols, through=end, since="2021-01-01", allow_holdout=True)
        found = detect(daily, tuple(chosen), since=start)
        found.to_parquet(out_dir / "detections_holdout.parquet", index=False)
        ranking = broad_ranking()
        locks = cx.lock_masks(ranking.column_to_base_symbol, ranking.prices.index)
        weeks = ranking.stock_pool_ranks.index
        names = sorted(set(ranking.column_to_base_symbol.values()))
        base = shapes.backtest(ranking, None, start=start, end=end, locks=locks).result.equity
        refs = reference_benchmarks.load_references()
        line = reference_benchmarks.aligned(refs["Nifty200 Momentum 30 TRI"], base.index)
        from .. import metrics

        report["nifty200_momentum_30_tri_cagr"] = (
            float(metrics.cagr(line)) if line is not None else None
        )
        for pattern, variant in chosen.items():
            name = variant.split("/", 1)[1]
            shape, value = next((s, v) for n, s, v in shapes.variants() if n == name)
            graded = with_quality(found)
            history = with_quality(pd.concat([load_detections(out_dir), found]))
            graded["learned"] = learned_column(ranking, history, graded, end=end)
            state, blend, learned = (
                shapes.column_scores(
                    score_table(graded, pattern, weeks, names, value=column), ranking
                )
                for column in ("score", "blend_score", "learned")
            )
            ranks = shapes.apply(
                shape, ranking.stock_pool_ranks, state, value, blend=blend, learned=learned
            )
            mine = shapes.backtest(ranking, ranks, start=start, end=end, locks=locks).result.equity
            report["patterns"][pattern] = {"variant": name, **judge(base, mine)}
            echo(f"{pattern} {name}: {report['patterns'][pattern]}")
    else:
        report["note"] = "no pattern passed Phases 3-5; the hold-out was not read"
        echo(report["note"])
    result_path.write_text(json.dumps(report, indent=1, default=str))
    echo(f"-> {result_path}")
    return report
