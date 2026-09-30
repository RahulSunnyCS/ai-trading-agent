"""The public read API for "which stocks are tagged with which category, as
of which year" -- the one function later backtest-composition code (a
separate, later task per the brief) should import. No network, no I/O side
effects beyond reading the two CSVs below.
"""

from __future__ import annotations

import csv
from pathlib import Path
from typing import Literal

import pandas as pd

from momentum_backtesting.categories.snapshots import MEMBERSHIP_FILENAME

#: The manual-tag overlay file's name under curated_dir (see module docstring
#: of the `curated/` package for its header/columns).
EXTRAS_FILENAME = "category_extras.csv"

Mode = Literal["narrow", "broad"]


class CategoryDataNotFoundError(Exception):
    """No category_membership.csv exists yet under the given data dir --
    run `mbt categories fetch` first."""


def _load_membership(data_dir: Path) -> pd.DataFrame:
    """Prefers the shared local database (`category_membership` table, populated by
    `mbt local migrate`) over category_membership.csv once it has rows — see
    db_read.py's module docstring — falling back to the file otherwise."""
    from momentum_backtesting import db_read

    from_db = db_read.category_membership_from_db_or_none()
    if from_db is not None:
        return from_db

    path = data_dir / MEMBERSHIP_FILENAME
    if not path.exists():
        raise CategoryDataNotFoundError(
            f"{path} does not exist -- run `mbt categories fetch` first"
        )
    return pd.read_csv(path, dtype={"category": str, "symbol": str, "source_tier": str})


def _load_extras(curated_dir: Path, category: str) -> set[str]:
    path = curated_dir / EXTRAS_FILENAME
    if not path.exists():
        return set()
    symbols: set[str] = set()
    with path.open(newline="") as f:
        for row in csv.DictReader(f):
            if (row.get("category") or "").strip() == category:
                symbol = (row.get("symbol") or "").strip()
                if symbol:
                    symbols.add(symbol)
    return symbols


def resolve_category_members(
    category: str,
    year: int,
    mode: Mode,
    *,
    data_dir: Path,
    curated_dir: Path,
) -> set[str]:
    """Member symbols of `category` as of `year`.

    - `mode="narrow"`: only the resolved official-index snapshot for that
      (category, year) -- whatever source tier it ended up at (see
      snapshots.SourceTier; the tier itself is not exposed here, only the
      resulting symbol set -- a caller that needs the tier should read
      category_membership.csv directly).
    - `mode="broad"`: narrow UNION curated_dir/category_extras.csv rows
      hand-tagged for this category. The extras file carries no year column
      -- a manual tag is a standing addition (e.g. "this company is
      genuinely a defense company, just not in the official index yet"), not
      a point-in-time fact, so it applies to every year uniformly.

    Raises CategoryDataNotFoundError if category_membership.csv hasn't been
    built yet (run `mbt categories fetch` first). Returns an empty set (not
    an error) if the file exists but has no rows for this specific
    (category, year) -- e.g. a category that fetch_report.csv shows as
    skipped for that year.
    """
    membership = _load_membership(data_dir)
    narrow = set(
        membership.loc[
            (membership["category"] == category) & (membership["year"] == year), "symbol"
        ]
    )

    if mode == "narrow":
        return narrow

    return narrow | _load_extras(curated_dir, category)
