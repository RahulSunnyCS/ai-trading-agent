"""`mbt categories fetch` / `mbt categories resolve` CLI wiring. Monkeypatches
the pipeline functions cli.py calls (snapshots.run_fetch,
resolve.resolve_category_members) rather than exercising real network --
that's test_sources.py/test_snapshots.py's job. Mirrors
tests/stocks/test_cli.py's pattern.
"""

from __future__ import annotations

from pathlib import Path

import pytest
from typer.testing import CliRunner

from momentum_backtesting import cli
from momentum_backtesting.categories import snapshots

runner = CliRunner()


@pytest.fixture
def categories_dirs(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> tuple[Path, Path]:
    """Redirect cli._categories_data_dir / _categories_curated_dir at a
    tmp_path, so no test ever writes into the real package's committed
    curated/ directory."""
    data_dir = tmp_path / "data_categories"
    curated_dir = tmp_path / "curated"
    monkeypatch.setattr(cli, "_categories_data_dir", lambda: data_dir)
    monkeypatch.setattr(cli, "_categories_curated_dir", lambda: curated_dir)
    return data_dir, curated_dir


# --------------------------------------------------------------------------
# `mbt categories fetch`
# --------------------------------------------------------------------------


def test_fetch_invokes_run_fetch_with_the_requested_year_range(
    categories_dirs: tuple[Path, Path], monkeypatch: pytest.MonkeyPatch
) -> None:
    data_dir, _curated_dir = categories_dirs
    captured = {}

    def fake_run_fetch(data_dir_arg, client, years):
        captured["data_dir"] = data_dir_arg
        captured["years"] = years
        return snapshots.FetchSummary(
            categories_fetched=["Nifty Bank"],
            categories_skipped=["Nifty Chemicals"],
            tier_counts={"live_annual_snapshot": 5},
            rows_written=5,
            elapsed_seconds=1.23,
        )

    monkeypatch.setattr(snapshots, "run_fetch", fake_run_fetch)

    args = ["categories", "fetch", "--from-year", "2020", "--to-year", "2021"]
    result = runner.invoke(cli.app, args)

    assert result.exit_code == 0, result.output
    assert captured["data_dir"] == data_dir
    assert captured["years"] == [2020, 2021]
    assert "fetched 1" in result.output
    assert "skipped 1" in result.output
    assert "Nifty Chemicals" in result.output


def test_fetch_defaults_to_year_from_2016(
    categories_dirs: tuple[Path, Path], monkeypatch: pytest.MonkeyPatch
) -> None:
    captured = {}

    def fake_run_fetch(data_dir_arg, client, years):
        captured["years"] = years
        return snapshots.FetchSummary()

    monkeypatch.setattr(snapshots, "run_fetch", fake_run_fetch)

    result = runner.invoke(cli.app, ["categories", "fetch", "--to-year", "2018"])

    assert result.exit_code == 0, result.output
    assert captured["years"] == [2016, 2017, 2018]


# --------------------------------------------------------------------------
# `mbt categories resolve`
# --------------------------------------------------------------------------


def test_resolve_prints_symbols(
    categories_dirs: tuple[Path, Path], monkeypatch: pytest.MonkeyPatch
) -> None:
    def fake_resolve(category, year, mode, *, data_dir, curated_dir):
        assert category == "Nifty Bank"
        assert year == 2020
        assert mode == "narrow"
        return {"AXISBANK", "SBIN"}

    monkeypatch.setattr(
        "momentum_backtesting.categories.resolve.resolve_category_members", fake_resolve
    )

    result = runner.invoke(cli.app, ["categories", "resolve", "Nifty Bank", "2020"])

    assert result.exit_code == 0, result.output
    assert "AXISBANK" in result.output
    assert "SBIN" in result.output


def test_resolve_reports_missing_data_cleanly(
    categories_dirs: tuple[Path, Path], monkeypatch: pytest.MonkeyPatch
) -> None:
    from momentum_backtesting.categories.resolve import CategoryDataNotFoundError

    def fake_resolve(category, year, mode, *, data_dir, curated_dir):
        raise CategoryDataNotFoundError("run fetch first")

    monkeypatch.setattr(
        "momentum_backtesting.categories.resolve.resolve_category_members", fake_resolve
    )

    result = runner.invoke(cli.app, ["categories", "resolve", "Nifty Bank", "2020"])

    assert result.exit_code != 0
    assert "run fetch first" in result.output


def test_resolve_rejects_an_invalid_mode(categories_dirs: tuple[Path, Path]) -> None:
    args = ["categories", "resolve", "Nifty Bank", "2020", "--mode", "bogus"]
    result = runner.invoke(cli.app, args)

    assert result.exit_code != 0


def test_resolve_reports_zero_symbols_without_erroring(
    categories_dirs: tuple[Path, Path], monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(
        "momentum_backtesting.categories.resolve.resolve_category_members",
        lambda *a, **k: set(),
    )

    result = runner.invoke(cli.app, ["categories", "resolve", "Nifty Capital Markets", "2020"])

    assert result.exit_code == 0, result.output
    assert "0 symbols" in result.output


# --------------------------------------------------------------------------
# The existing/other CLI surfaces are unaffected by this additive sub-app.
# --------------------------------------------------------------------------


def test_top_level_app_still_lists_existing_and_new_commands() -> None:
    result = runner.invoke(cli.app, ["--help"])

    assert result.exit_code == 0
    assert "stocks" in result.output
    assert "categories" in result.output
    assert "fetch" in result.output  # the original `mbt fetch` (ETF path), unchanged
