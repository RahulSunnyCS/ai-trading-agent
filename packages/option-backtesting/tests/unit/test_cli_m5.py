"""
CLI-level tests for the M-5 commands (`walkforward`, `sweep`, `export-
personality`), using typer's bundled CliRunner (no new dependency) against
the real, already-committed M-1 ingested Parquet cache — the same
`real_cache_client`-style approach test_api.py uses for FastAPI. Every
prior milestone verified its CLI commands via a real end-to-end manual
invocation rather than an automated CliRunner test; these close that gap
for the M-5 commands specifically, using an isolated tmp registry_db so
nothing here touches the real committed `data/registry.sqlite`.
"""

import json
from pathlib import Path

from typer.testing import CliRunner

from option_backtesting.cli import app
from option_backtesting.data.ingest import DEFAULT_CACHE_DIR

STRATEGIES_DIR = Path(__file__).parent.parent.parent / "strategies"
runner = CliRunner()


class TestWalkforwardCommand:
    def test_headlines_out_of_sample_against_real_cache(self) -> None:
        result = runner.invoke(
            app,
            [
                "walkforward",
                str(STRATEGIES_DIR / "A_flat.yaml"),
                "--is-from",
                "2026-08-17",
                "--is-to",
                "2026-08-27",
                "--oos-from",
                "2026-08-28",
                "--oos-to",
                "2026-09-04",
                "--cache-dir",
                str(DEFAULT_CACHE_DIR),
            ],
        )
        assert result.exit_code == 0
        assert "OUT-OF-SAMPLE" in result.stdout
        assert "in-sample (reference only)" in result.stdout

    def test_overlapping_windows_exits_nonzero(self) -> None:
        result = runner.invoke(
            app,
            [
                "walkforward",
                str(STRATEGIES_DIR / "A_flat.yaml"),
                "--is-from",
                "2026-08-17",
                "--is-to",
                "2026-08-27",
                "--oos-from",
                "2026-08-27",
                "--oos-to",
                "2026-09-04",
                "--cache-dir",
                str(DEFAULT_CACHE_DIR),
            ],
        )
        assert result.exit_code == 1


class TestSweepCommand:
    def test_runs_and_reports_every_config(self, tmp_path: Path) -> None:
        changes_path = tmp_path / "changes.json"
        changes_path.write_text(
            json.dumps(
                [
                    {"strategy": {"entry": {"lots": 4}, "caps": {"max_lots": 4}}},
                    {"strategy": {"entry": {"lots": 2}, "caps": {"max_lots": 2}}},
                ]
            )
        )
        result = runner.invoke(
            app,
            [
                "sweep",
                str(STRATEGIES_DIR / "A_flat.yaml"),
                "--changes",
                str(changes_path),
                "--from",
                "2026-08-17",
                "--to",
                "2026-09-04",
                "--cache-dir",
                str(DEFAULT_CACHE_DIR),
            ],
        )
        assert result.exit_code == 0
        assert "2 config(s), 2 succeeded" in result.stdout
        assert "config_0" in result.stdout
        assert "config_1" in result.stdout

    def test_overfit_flag_adds_pbo_and_deflated_sharpe(self, tmp_path: Path) -> None:
        changes_path = tmp_path / "changes.json"
        changes_path.write_text(
            json.dumps(
                [
                    {"strategy": {"entry": {"lots": 4}, "caps": {"max_lots": 4}}},
                    {"strategy": {"entry": {"lots": 3}, "caps": {"max_lots": 3}}},
                    {"strategy": {"entry": {"lots": 2}, "caps": {"max_lots": 2}}},
                ]
            )
        )
        result = runner.invoke(
            app,
            [
                "sweep",
                str(STRATEGIES_DIR / "A_flat.yaml"),
                "--changes",
                str(changes_path),
                "--from",
                "2026-06-08",
                "--to",
                "2026-09-04",
                "--cache-dir",
                str(DEFAULT_CACHE_DIR),
                "--overfit",
                "--n-blocks",
                "8",
            ],
        )
        assert result.exit_code == 0
        assert "PBO" in result.stdout
        assert "Deflated Sharpe" in result.stdout

    def test_non_array_changes_file_exits_nonzero(self, tmp_path: Path) -> None:
        changes_path = tmp_path / "changes.json"
        changes_path.write_text(json.dumps({"not": "a list"}))
        result = runner.invoke(
            app,
            [
                "sweep",
                str(STRATEGIES_DIR / "A_flat.yaml"),
                "--changes",
                str(changes_path),
                "--from",
                "2026-08-17",
                "--to",
                "2026-09-04",
                "--cache-dir",
                str(DEFAULT_CACHE_DIR),
            ],
        )
        assert result.exit_code == 1
        assert "JSON array" in result.stdout


class TestExportPersonalityCommand:
    def test_export_after_a_recorded_run(self, tmp_path: Path) -> None:
        registry_db = tmp_path / "registry.sqlite"
        run_result = runner.invoke(
            app,
            [
                "run",
                str(STRATEGIES_DIR / "B_pyramid.yaml"),
                "--from",
                "2026-08-17",
                "--to",
                "2026-09-04",
                "--cache-dir",
                str(DEFAULT_CACHE_DIR),
                "--registry-db",
                str(registry_db),
            ],
        )
        assert run_result.exit_code == 0
        run_id_line = next(
            line for line in run_result.stdout.splitlines() if "Recorded as run" in line
        )
        run_id = run_id_line.split()[3]

        export_result = runner.invoke(
            app, ["export-personality", run_id, "--registry-db", str(registry_db)]
        )
        assert export_result.exit_code == 0
        payload = json.loads(export_result.stdout)
        assert payload["source_run_id"] == run_id
        assert payload["entryType"] == "fixed_time"
        assert payload["managementStyle"] == "roll"
        assert len(payload["manual_review"]) > 0

    def test_unknown_run_id_exits_nonzero(self, tmp_path: Path) -> None:
        registry_db = tmp_path / "registry.sqlite"
        result = runner.invoke(
            app, ["export-personality", "does-not-exist", "--registry-db", str(registry_db)]
        )
        assert result.exit_code == 1
        assert "Unknown run_id" in result.stdout
