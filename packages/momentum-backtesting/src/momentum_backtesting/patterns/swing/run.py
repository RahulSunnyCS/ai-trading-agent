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


def research_dev(out_dir: Path = OUT_DIR, *, echo=print) -> Path:
    """Phases 3-5 on the development window -> search_spaces/bl043_dev_result.json."""
    from .. import SEARCH_SPACES
    from ..bars import split_symbols
    from .research import run_dev

    cands = load_candidates(out_dir)
    daily, _ = development_bars()
    daily = daily[daily["symbol"].isin(set(cands["symbol"]))]
    bars = split_symbols(daily)
    closes = daily.pivot_table(index="date", columns="symbol", values="close", aggfunc="last")
    path = SEARCH_SPACES / "bl043_dev_result.json"
    report = run_dev(cands, bars, closes, path, echo=echo)
    for pattern, info in report["stage_a"].items():
        echo(
            f"{pattern}: walk-forward mean R {info['walk_forward_mean_r']:+.3f} over "
            f"{info['walk_forward_trades']} trades, PBO {info['pbo']['pbo']:.2f}, "
            f"full-window best {info['full_window_choice']}"
        )
    b = report["stage_b"]
    if b.get("patterns"):
        echo(
            f"portfolio walk-forward CAGR {b['walk_forward_cagr']:.1%} vs Nifty 500 TRI "
            f"{report['nifty500_tri_cagr_same_weeks']:.1%}; PBO {b['pbo']['pbo']:.2f}"
        )
    echo(f"development passes: {report['development_passes']}  -> {path}")
    return path
