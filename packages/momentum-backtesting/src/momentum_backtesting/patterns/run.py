"""BL-042 runs over real data: detections for the development window.

Writes under `data/patterns/` (gitignored with the rest of `data/`).
"""

from __future__ import annotations

from pathlib import Path

import pandas as pd

from ..config import DATA_DIR
from . import criteria, dev_end
from .bars import load_daily
from .features import detect

OUT_DIR = DATA_DIR / "patterns"
DETECTIONS = "detections_dev.parquet"


def development_symbols() -> list[str]:
    """Every symbol in the point-in-time `turnover_rank` universe in a development year.
    Year Y's members are ranked on the second half of Y-1 only, so no year past the window is
    needed (later years are dropped, never used)."""
    from ..categories.liquidity import turnover_rank_members_by_year

    window = criteria()["windows"]["development"]
    first, last = pd.Timestamp(window["from"]).year, pd.Timestamp(window["to"]).year
    members = turnover_rank_members_by_year()
    return sorted(set().union(*(members.get(y, set()) for y in range(first, last + 1))))


def detect_development(out_dir: Path = OUT_DIR, *, echo=print) -> Path:
    window = criteria()["windows"]["development"]
    symbols = development_symbols()
    echo(f"{len(symbols)} symbols; loading bars through {dev_end().date()} ...")
    # A year of history before the window so 52-week rules are defined from its first week.
    daily = load_daily(symbols, through=dev_end(), since="2011-01-01")
    echo(f"{len(daily):,} bars, {int(daily['bad'].sum()):,} bad; detecting ...")
    found = detect(daily, since=window["from"])
    out_dir.mkdir(parents=True, exist_ok=True)
    path = out_dir / DETECTIONS
    found.to_parquet(path, index=False)
    echo(found.groupby(["pattern", "state"]).size().unstack(fill_value=0).to_string())
    echo(f"written {path}")
    return path


def load_detections(out_dir: Path = OUT_DIR) -> pd.DataFrame:
    return pd.read_parquet(out_dir / DETECTIONS)


def development_bars() -> pd.DataFrame:
    return load_daily(development_symbols(), through=dev_end(), since="2011-01-01")


def formation_report(out_dir: Path = OUT_DIR, *, echo=print) -> Path:
    """Phase 2b: momentum rank while each base formed (ranks only, no returns)."""
    from . import formation
    from .universe import rank_tables

    detections = load_detections(out_dir)
    echo("building the Broad ranking (pre-registered universe and settings) ...")
    global_ranks, pool_ranks = rank_tables(dev_end())
    table = formation.momentum_during(detections, global_ranks, pool_ranks)
    table.to_parquet(out_dir / "formation_episodes.parquet", index=False)
    summary = formation.summary(table)
    years = formation.per_year(detections)
    path = out_dir / "formation_summary.md"
    path.write_text(
        "## Momentum rank while the base forms (episodes)\n\n```\n"
        + summary.to_string(float_format=lambda v: f"{v:.3f}")
        + "\n```\n\n## Detection rows per year\n\n```\n"
        + years.to_string()
        + "\n```\n"
    )
    echo(summary.to_string(float_format=lambda v: f"{v:.3f}"))
    echo(f"written {path}")
    return path


def gallery(out_dir: Path = OUT_DIR, *, echo=print) -> Path:
    """Phase 3: the label gallery page and its manifest."""
    from . import gallery as gallery_mod

    detections = load_detections(out_dir)
    page, _ = gallery_mod.build(development_bars(), detections, out_dir, echo=echo)
    return page


# --- Phases 4 and 5: only after the detectors are frozen ----------------------------------------


def _frozen_spec() -> dict:
    """The detector freeze (an addendum with `detectors_frozen: true`, written from the owner's
    gallery labels) must be committed before any forward return is computed."""
    from . import frozen

    spec = frozen()
    if spec is None:
        raise RuntimeError(
            "no bl042 addendum has detectors_frozen: true: Phase 3 (the gallery check) must "
            "freeze the detectors before Phases 4-5 read any return"
        )
    return spec


def _patterns_in_play() -> list[str]:
    dropped = set(_frozen_spec().get("dropped_patterns", []))
    return [p for p in criteria()["patterns_tested"] if p not in dropped]


def _column_tables(ranking, detections: pd.DataFrame) -> dict[str, dict[str, pd.DataFrame]]:
    """pattern -> {"state": state score, "blend": state score x quality, "quality": quality},
    each week x column on the ranking's own columns."""
    from .features import score_table
    from .quality import with_quality
    from .ranking import column_scores

    graded = with_quality(detections)
    weeks = ranking.stock_pool_ranks.index
    symbols = sorted(set(ranking.column_to_base_symbol.values()))
    out = {}
    for pattern in _patterns_in_play():
        out[pattern] = {
            name: column_scores(score_table(graded, pattern, weeks, symbols, value=value), ranking)
            for name, value in (
                ("state", "score"),
                ("blend", "blend_score"),
                ("quality", "quality"),
            )
        }
    return out


def event_study(out_dir: Path = OUT_DIR, *, echo=print) -> Path:
    """Phase 4 on the development window -> search_spaces/bl042_event_study_result.json."""
    import json

    from . import SEARCH_SPACES, study
    from .universe import broad_ranking

    _frozen_spec()
    ranking = broad_ranking()
    detections = load_detections(out_dir)
    tables = _column_tables(ranking, detections)
    stocks = list(ranking.stock_pool_ranks.columns)
    report = study.run(
        ranking.prices[stocks],
        ranking.stock_pool_ranks,
        {p: t["state"] for p, t in tables.items()},
        quality={p: t["quality"] for p, t in tables.items()},
    )
    path = SEARCH_SPACES / "bl042_event_study_result.json"
    path.write_text(json.dumps(report, indent=1, default=str))
    for row in report["tests"]:
        echo(
            f"{row['pattern']:>12} h={row['horizon_weeks']:>2}: {row['events']:>6} events "
            f"{row['weeks']:>4} wk  mean {row['mean_excess']:+.4f}  t {row['t_newey_west']:.2f}"
            f"  holm {row['holm_rejects']}"
        )
    echo(f"verdicts: {report['verdicts']}  -> {path}")
    return path


def ranking_test(out_dir: Path = OUT_DIR, *, echo=print) -> Path:
    """Phase 5 on the development window: baseline + every shape x pattern, walk-forward pick,
    PBO -> search_spaces/bl042_dev_result.json (curves in data/patterns/)."""
    import json

    import numpy as np

    from .. import method, metrics
    from ..categories import circuit_exposure as cx
    from . import SEARCH_SPACES
    from . import ranking as shapes
    from .universe import broad_ranking

    _frozen_spec()
    spec = criteria()["phase_5_ranking_test"]
    window = criteria()["windows"]["development"]
    start, end = window["from"], window["to"]
    ranking = broad_ranking()
    locks = cx.lock_masks(ranking.column_to_base_symbol, ranking.prices.index)
    tables = _column_tables(ranking, load_detections(out_dir))

    echo("baseline ...")
    curves = {"baseline": shapes.backtest(ranking, None, start=start, end=end, locks=locks)}
    curves = {"baseline": curves["baseline"].result.equity}
    for pattern, table in tables.items():
        for name, shape, value in shapes.variants():
            echo(f"{pattern} {name} ...")
            ranks = shapes.apply(
                shape, ranking.stock_pool_ranks, table["state"], value, blend=table["blend"]
            )
            out = shapes.backtest(ranking, ranks, start=start, end=end, locks=locks)
            curves[f"{pattern}/{name}"] = out.result.equity
    frame = pd.DataFrame(curves).ffill()
    frame.to_parquet(out_dir / "dev_curves.parquet")
    logs = np.log(frame).diff().dropna()
    excess = logs.drop(columns="baseline").sub(logs["baseline"], axis=0)

    wf = spec["walk_forward"]
    first = pd.Timestamp(start)
    picks, joined = {}, {}
    for pattern in tables:
        cols = [c for c in excess.columns if c.startswith(f"{pattern}/")]
        parts = []
        for year in wf["years"]:
            cut = pd.Timestamp(f"{year}-01-01") - pd.Timedelta(
                weeks=criteria()["windows"]["embargo_weeks"]
            )
            chosen = excess.loc[first:cut, cols].sum().idxmax()
            picks.setdefault(pattern, {})[year] = chosen
            held = excess.loc[f"{year}-01-01" : f"{year}-12-31", chosen]
            parts.append(held)
        series = pd.concat(parts)
        joined[pattern] = {
            "excess_cagr": float(np.exp(series.sum() * 52 / len(series)) - 1),
            "weeks": len(series),
        }
    pbo = method.pbo(excess.to_numpy(), blocks=spec["pbo"]["blocks"])
    verdicts, holdout_choice = {}, {}
    for pattern in tables:
        cols = [c for c in excess.columns if c.startswith(f"{pattern}/")]
        ok = joined[pattern]["excess_cagr"] > 0 and pbo["pbo"] <= spec["pbo"]["kill_above"]
        verdicts[pattern] = "pass" if ok else "kill"
        if ok:
            holdout_choice[pattern] = excess[cols].sum().idxmax()
    stats = {
        name: {
            "cagr": float(metrics.cagr(frame[name])),
            "mdd": float(metrics.max_drawdown(frame[name])[0]),
        }
        for name in frame.columns
    }
    report = {
        "window": [start, end],
        "variants": stats,
        "walk_forward_picks": {p: {str(y): v for y, v in d.items()} for p, d in picks.items()},
        "walk_forward_joined": joined,
        "pbo": pbo,
        "verdicts": verdicts,
        "holdout_choice": holdout_choice,
    }
    path = SEARCH_SPACES / "bl042_dev_result.json"
    path.write_text(json.dumps(report, indent=1, default=str))
    echo(json.dumps({"joined": joined, "pbo": pbo["pbo"], "verdicts": verdicts}, indent=1))
    echo(f"-> {path}")
    return path
