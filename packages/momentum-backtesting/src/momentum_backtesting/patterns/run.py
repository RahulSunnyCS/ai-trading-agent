"""BL-041 runs over real data: detections for the development window.

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
