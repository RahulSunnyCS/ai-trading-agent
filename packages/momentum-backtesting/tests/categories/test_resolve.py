"""resolve.py: the public read API later backtest-composition code will call.
Pure file I/O against tmp_path -- no network."""

from __future__ import annotations

from pathlib import Path

import pandas as pd
import pytest

from momentum_backtesting.categories.resolve import (
    CategoryDataNotFoundError,
    resolve_category_members,
)
from momentum_backtesting.categories.snapshots import MEMBERSHIP_FILENAME


def _write_membership(data_dir: Path, rows: list[dict]) -> None:
    data_dir.mkdir(parents=True, exist_ok=True)
    pd.DataFrame(
        rows, columns=["category", "year", "symbol", "source_tier", "wayback_timestamp"]
    ).to_csv(data_dir / MEMBERSHIP_FILENAME, index=False)


def _write_extras(curated_dir: Path, rows: list[dict]) -> None:
    curated_dir.mkdir(parents=True, exist_ok=True)
    pd.DataFrame(rows, columns=["symbol", "category", "note"]).to_csv(
        curated_dir / "category_extras.csv", index=False
    )


def test_resolve_narrow_returns_only_the_official_snapshot(tmp_path):
    data_dir = tmp_path / "data"
    curated_dir = tmp_path / "curated"
    _write_membership(
        data_dir,
        [
            {
                "category": "Nifty Bank",
                "year": 2020,
                "symbol": "AXISBANK",
                "source_tier": "live_annual_snapshot",
                "wayback_timestamp": "20200101000000",
            },
            {
                "category": "Nifty Bank",
                "year": 2020,
                "symbol": "SBIN",
                "source_tier": "live_annual_snapshot",
                "wayback_timestamp": "20200101000000",
            },
            {
                "category": "Nifty IT",
                "year": 2020,
                "symbol": "INFY",
                "source_tier": "live_annual_snapshot",
                "wayback_timestamp": "20200101000000",
            },
        ],
    )
    _write_extras(curated_dir, [])

    result = resolve_category_members(
        "Nifty Bank", 2020, "narrow", data_dir=data_dir, curated_dir=curated_dir
    )

    assert result == {"AXISBANK", "SBIN"}


def test_resolve_broad_unions_curated_extras(tmp_path):
    data_dir = tmp_path / "data"
    curated_dir = tmp_path / "curated"
    _write_membership(
        data_dir,
        [
            {
                "category": "Nifty Bank",
                "year": 2020,
                "symbol": "AXISBANK",
                "source_tier": "live_annual_snapshot",
                "wayback_timestamp": "20200101000000",
            }
        ],
    )
    _write_extras(
        curated_dir,
        [
            {
                "symbol": "SMALLBANK",
                "category": "Nifty Bank",
                "note": "not yet in official index",
            },
            {
                "symbol": "SOMEOTHER",
                "category": "Nifty IT",
                "note": "wrong category, must not leak",
            },
        ],
    )

    narrow = resolve_category_members(
        "Nifty Bank", 2020, "narrow", data_dir=data_dir, curated_dir=curated_dir
    )
    broad = resolve_category_members(
        "Nifty Bank", 2020, "broad", data_dir=data_dir, curated_dir=curated_dir
    )

    assert narrow == {"AXISBANK"}
    assert broad == {"AXISBANK", "SMALLBANK"}
    assert "SOMEOTHER" not in broad


def test_resolve_broad_with_no_extras_file_present_equals_narrow(tmp_path):
    data_dir = tmp_path / "data"
    curated_dir = tmp_path / "curated"  # deliberately never created
    _write_membership(
        data_dir,
        [
            {
                "category": "Nifty Bank",
                "year": 2020,
                "symbol": "AXISBANK",
                "source_tier": "live_annual_snapshot",
                "wayback_timestamp": "20200101000000",
            }
        ],
    )

    broad = resolve_category_members(
        "Nifty Bank", 2020, "broad", data_dir=data_dir, curated_dir=curated_dir
    )

    assert broad == {"AXISBANK"}


def test_resolve_raises_when_membership_file_is_missing(tmp_path):
    with pytest.raises(CategoryDataNotFoundError):
        resolve_category_members(
            "Nifty Bank",
            2020,
            "narrow",
            data_dir=tmp_path / "no_such_dir",
            curated_dir=tmp_path / "curated",
        )


def test_resolve_returns_empty_set_for_a_category_year_with_no_rows(tmp_path):
    data_dir = tmp_path / "data"
    curated_dir = tmp_path / "curated"
    _write_membership(
        data_dir,
        [
            {
                "category": "Nifty Bank",
                "year": 2020,
                "symbol": "AXISBANK",
                "source_tier": "live_annual_snapshot",
                "wayback_timestamp": "20200101000000",
            }
        ],
    )
    _write_extras(curated_dir, [])

    # Nifty Capital Markets has 0 rows in category_membership.csv (it's one of
    # the 4 unmapped categories) -- this must not raise, just return {}.
    result = resolve_category_members(
        "Nifty Capital Markets", 2020, "narrow", data_dir=data_dir, curated_dir=curated_dir
    )

    assert result == set()
