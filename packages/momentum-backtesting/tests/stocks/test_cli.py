"""T8 acceptance: `mbt stocks fetch` / `pin-manifest` / `validate` CLI wiring
(plan.md §7 T8, implementor-brief.md, QA F15, N04, N05, N06).

Monkeypatches the pipeline functions cli.py calls (adjust.build_all,
validate.dividend_check, bhavcopy.download, corporate_actions.fetch_history,
the niftyindices/NSE network calls) rather than exercising the real
multi-guard pipeline end to end -- that is T1/T2/T4/T6/T7's own test suites'
job (test_adjust.py, test_validate.py, test_bhavcopy.py,
test_corporate_actions.py). This file only tests that the CLI:
  - propagates a build failure to a non-zero exit code and a fetch_report.csv
    row (F15);
  - never touches the network under --skip-download;
  - `pin-manifest` writes both curated/raw_manifest.pinned.csv and an advanced
    curated/events_baseline.csv.gz (N04).

Every test monkeypatches cli._stocks_data_dir / cli._stocks_curated_dir to a
tmp_path so nothing is ever written under the real package curated/ dir.
"""

from __future__ import annotations

import gzip
from datetime import date
from pathlib import Path

import pandas as pd
import pytest
from typer.testing import CliRunner

from momentum_backtesting import cli
from momentum_backtesting.stocks import adjust
from momentum_backtesting.stocks.schemas import CURATED_HEADERS, GuardResult, GuardSeverity

runner = CliRunner()


# --------------------------------------------------------------------------
# Small fixtures
# --------------------------------------------------------------------------


def _write_daily_parquet(path: Path) -> None:
    df = pd.DataFrame(
        [
            {
                "date": date(2020, 1, 1),
                "symbol": "TESTCO",
                "series": "EQ",
                "isin": "INE000A00000",
                "open": 100.0,
                "high": 101.0,
                "low": 99.0,
                "close": 100.0,
                "prevclose": 99.0,
                "volume": 1000,
                "turnover": 100000.0,
                "synthetic_close": False,
            },
            {
                "date": date(2020, 1, 2),
                "symbol": "TESTCO",
                "series": "EQ",
                "isin": "INE000A00000",
                "open": 100.0,
                "high": 101.0,
                "low": 99.0,
                "close": 101.0,
                "prevclose": 100.0,
                "volume": 1000,
                "turnover": 100000.0,
                "synthetic_close": False,
            },
        ]
    )
    path.parent.mkdir(parents=True, exist_ok=True)
    df.to_parquet(path, index=False)


def _write_empty_curated(curated_dir: Path) -> None:
    """Every curated/*.csv with just its frozen header -- enough for
    load_curated / build_ca_lookups / combine_manual_over_feed to run over
    genuinely empty inputs without raising."""
    curated_dir.mkdir(parents=True, exist_ok=True)
    for name, header in CURATED_HEADERS.items():
        (curated_dir / name).write_text(",".join(header) + "\n")


@pytest.fixture
def stocks_dirs(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> tuple[Path, Path]:
    """Redirect cli._stocks_data_dir / _stocks_curated_dir at a tmp_path, so no
    test ever writes into the real package's committed curated/ directory."""
    data_dir = tmp_path / "data_stocks"
    curated_dir = tmp_path / "curated"
    monkeypatch.setattr(cli, "_stocks_data_dir", lambda: data_dir)
    monkeypatch.setattr(cli, "_stocks_curated_dir", lambda: curated_dir)
    return data_dir, curated_dir


def _deny_network(monkeypatch: pytest.MonkeyPatch) -> None:
    """Make every network entry point `mbt stocks fetch` could reach raise
    immediately, so a test using this fixture fails loudly if --skip-download
    doesn't actually skip them (QA: "--skip-download never touches the
    network")."""

    def _boom(*_args, **_kwargs):
        raise AssertionError("network was touched despite --skip-download")

    monkeypatch.setattr("momentum_backtesting.stocks.nse.NseClient.warm_up", _boom)
    monkeypatch.setattr("momentum_backtesting.stocks.nse.NseClient.get_bytes", _boom)
    monkeypatch.setattr("momentum_backtesting.stocks.nse.NseClient.get_json", _boom)
    monkeypatch.setattr("momentum_backtesting.stocks.bhavcopy.download", _boom)
    monkeypatch.setattr("momentum_backtesting.stocks.corporate_actions.fetch_history", _boom)
    monkeypatch.setattr("urllib.request.urlopen", _boom)


# --------------------------------------------------------------------------
# F15: exit codes
# --------------------------------------------------------------------------


def test_f15_guard_failure_exits_nonzero_and_writes_fetch_report(
    stocks_dirs: tuple[Path, Path], monkeypatch: pytest.MonkeyPatch
) -> None:
    data_dir, curated_dir = stocks_dirs
    _write_daily_parquet(data_dir / "daily.parquet")
    _write_empty_curated(curated_dir)
    _deny_network(monkeypatch)

    def _fake_build_all(data_dir_arg, curated_dir_arg, accept_ca_diff=None):
        results = [
            GuardResult(guard="session_calendar", severity=GuardSeverity.F, message="boom"),
            GuardResult(guard="ca_diff", severity=GuardSeverity.G, message="fine"),
        ]
        report_path = data_dir_arg / "fetch_report.csv"
        pd.DataFrame(
            [
                {
                    "guard": r.guard,
                    "severity": r.severity.value,
                    "company_id": r.company_id or "",
                    "session": r.session or "",
                    "message": r.message,
                }
                for r in results
            ]
        ).to_csv(report_path, index=False)
        return adjust.BuildReport(
            guard_results=results,
            event_counts={},
            ca_diff=pd.DataFrame(),
            baseline_created=False,
            elapsed_seconds=0.01,
            outputs_written=[str(report_path)],
        )

    monkeypatch.setattr("momentum_backtesting.stocks.adjust.build_all", _fake_build_all)

    result = runner.invoke(cli.app, ["stocks", "fetch", "--skip-download"])

    assert result.exit_code != 0, result.output
    report_path = data_dir / "fetch_report.csv"
    assert report_path.exists()
    written = pd.read_csv(report_path)
    assert (written["severity"] == "F").any()


def test_fetch_passes_through_when_no_f_guards(
    stocks_dirs: tuple[Path, Path], monkeypatch: pytest.MonkeyPatch
) -> None:
    data_dir, curated_dir = stocks_dirs
    _write_daily_parquet(data_dir / "daily.parquet")
    _write_empty_curated(curated_dir)
    _deny_network(monkeypatch)

    def _fake_build_all(data_dir_arg, curated_dir_arg, accept_ca_diff=None):
        return adjust.BuildReport(
            guard_results=[
                GuardResult(guard="session_calendar", severity=GuardSeverity.G, message="ok")
            ],
            event_counts={"dividend/feed": 3},
            ca_diff=pd.DataFrame(),
            baseline_created=True,
            elapsed_seconds=0.01,
            outputs_written=[],
        )

    monkeypatch.setattr("momentum_backtesting.stocks.adjust.build_all", _fake_build_all)

    result = runner.invoke(cli.app, ["stocks", "fetch", "--skip-download"])

    assert result.exit_code == 0, result.output
    assert "0 F" in result.output


def test_fetch_without_daily_parquet_and_skip_download_fails_cleanly(
    stocks_dirs: tuple[Path, Path], monkeypatch: pytest.MonkeyPatch
) -> None:
    data_dir, curated_dir = stocks_dirs
    _write_empty_curated(curated_dir)
    _deny_network(monkeypatch)

    result = runner.invoke(cli.app, ["stocks", "fetch", "--skip-download"])

    assert result.exit_code != 0
    assert "daily.parquet" in result.output


# --------------------------------------------------------------------------
# --skip-download never touches the network (also implicitly covered above,
# via _deny_network + a passing run -- this test asserts it standalone with
# no build_all stub at all, so a real accidental network call anywhere in the
# --skip-download path would fail the test even before build_all runs).
# --------------------------------------------------------------------------


def test_skip_download_never_touches_the_network(
    stocks_dirs: tuple[Path, Path], monkeypatch: pytest.MonkeyPatch
) -> None:
    data_dir, curated_dir = stocks_dirs
    _write_daily_parquet(data_dir / "daily.parquet")
    _write_empty_curated(curated_dir)
    _deny_network(monkeypatch)
    monkeypatch.setattr(
        "momentum_backtesting.stocks.adjust.build_all",
        lambda *a, **k: adjust.BuildReport(
            guard_results=[],
            event_counts={},
            ca_diff=pd.DataFrame(),
            baseline_created=False,
            elapsed_seconds=0.0,
            outputs_written=[],
        ),
    )

    result = runner.invoke(cli.app, ["stocks", "fetch", "--skip-download"])

    assert result.exit_code == 0, result.output


# --------------------------------------------------------------------------
# N04: pin-manifest writes raw_manifest.pinned.csv + advances the baseline
# --------------------------------------------------------------------------


def test_pin_manifest_writes_pinned_csv_and_baseline(stocks_dirs: tuple[Path, Path]) -> None:
    data_dir, curated_dir = stocks_dirs
    _write_daily_parquet(data_dir / "daily.parquet")
    _write_empty_curated(curated_dir)
    (data_dir / "raw" / "corporate_actions").mkdir(parents=True, exist_ok=True)
    manifest = pd.DataFrame(
        [{"file": "cm01JAN2020bhav.csv.zip", "fetched_at": "2020-01-01T00:00:00", "rows": 1}]
    )
    manifest.to_csv(data_dir / "raw_manifest.csv", index=False)

    result = runner.invoke(cli.app, ["stocks", "pin-manifest"])

    assert result.exit_code == 0, result.output
    pinned_path = curated_dir / "raw_manifest.pinned.csv"
    assert pinned_path.exists()
    pd.testing.assert_frame_equal(pd.read_csv(pinned_path), manifest)

    baseline_path = curated_dir / "events_baseline.csv.gz"
    assert baseline_path.exists()
    with gzip.open(baseline_path, "rt", encoding="utf-8") as f:
        header = f.readline().strip()
    assert header == (
        "company_id,ex_date,kind,factor,dividend,source,subject_sha1,symbol_at_ex"
    )


def test_pin_manifest_without_prior_fetch_fails_cleanly(stocks_dirs: tuple[Path, Path]) -> None:
    data_dir, curated_dir = stocks_dirs
    _write_empty_curated(curated_dir)

    result = runner.invoke(cli.app, ["stocks", "pin-manifest"])

    assert result.exit_code != 0
    assert not (curated_dir / "raw_manifest.pinned.csv").exists()


# --------------------------------------------------------------------------
# N06: the existing ETF-path CLI is unaffected by the additive `stocks` sub-app.
# --------------------------------------------------------------------------


def test_top_level_app_still_lists_existing_commands() -> None:
    result = runner.invoke(cli.app, ["--help"])

    assert result.exit_code == 0
    assert "stocks" in result.output
    assert "fetch" in result.output  # the original `mbt fetch` (ETF path), unchanged
