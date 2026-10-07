"""BL-043 runs over real data. Outputs go to `data/patterns/swing/` (gitignored with `data/`)."""

from __future__ import annotations

from pathlib import Path

import pandas as pd

from ...config import DATA_DIR
from .. import dev_end
from ..bars import load_daily
from . import criteria

OUT_DIR = DATA_DIR / "patterns" / "swing"
CANDIDATES = "candidates_dev.parquet"


def members_by_year() -> dict[int, set[str]]:
    from ...categories.liquidity import turnover_rank_members_by_year

    return turnover_rank_members_by_year()


def development_bars() -> tuple[pd.DataFrame, dict[int, set[str]]]:
    window = criteria()["windows"]["development"]
    first, last = pd.Timestamp(window["from"]).year, pd.Timestamp(window["to"]).year
    members = {y: s for y, s in members_by_year().items() if first <= y <= last}
    symbols = sorted(set().union(*members.values()))
    return load_daily(symbols, through=dev_end(), since="2011-01-01"), members


def candidates_dev(out_dir: Path = OUT_DIR, *, echo=print) -> Path:
    """Phase 1: every candidate in the development window."""
    from .candidates import scan

    daily, members = development_bars()
    echo(f"{daily['symbol'].nunique()} symbols, {len(daily):,} bars; scanning every close ...")
    found = scan(daily, members, since=criteria()["windows"]["development"]["from"])
    out_dir.mkdir(parents=True, exist_ok=True)
    path = out_dir / CANDIDATES
    found.to_parquet(path, index=False)
    echo(
        found.groupby(["pattern", "entry"])
        .agg(rows=("symbol", "size"), bases=("base_id", "nunique"))
        .to_string()
    )
    echo(f"written {path}")
    return path


def load_candidates(out_dir: Path = OUT_DIR) -> pd.DataFrame:
    return pd.read_parquet(out_dir / CANDIDATES)
