"""
FastAPI service tests — each test builds a fresh `create_app(cache_dir=...,
registry_db=...)` pointed at an isolated tmp_path, never the real committed
cache/registry, via `fastapi.testclient.TestClient`.
"""

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from option_backtesting.api.app import create_app

STRATEGIES_DIR = Path(__file__).parent.parent.parent / "strategies"


@pytest.fixture
def client(tmp_path: Path) -> TestClient:
    app = create_app(cache_dir=tmp_path / "cache", registry_db=tmp_path / "registry.sqlite")
    return TestClient(app)


@pytest.fixture
def real_cache_client() -> TestClient:
    """Points at the real, already-committed M-1 ingested Parquet cache
    (read-only from this test's perspective) but an isolated tmp registry —
    needed for /runs and /coverage, which have nothing to query against an
    empty cache_dir."""
    import tempfile

    from option_backtesting.data.ingest import DEFAULT_CACHE_DIR

    with tempfile.TemporaryDirectory() as tmp:
        app = create_app(cache_dir=DEFAULT_CACHE_DIR, registry_db=Path(tmp) / "registry.sqlite")
        yield TestClient(app)


class TestHealth:
    def test_health_ok(self, client: TestClient) -> None:
        r = client.get("/health")
        assert r.status_code == 200
        assert r.json() == {"status": "ok"}


class TestPresets:
    def test_lists_all_five_committed_strategies(self, client: TestClient) -> None:
        r = client.get("/presets")
        assert r.status_code == 200
        names = {p["name"] for p in r.json()}
        assert names == {"A_flat", "B_pyramid", "C_pyramid_fallback", "D_adaptive_trailing", "or_breakout"}

    def test_get_preset_returns_yaml_content(self, client: TestClient) -> None:
        r = client.get("/presets/A_flat")
        assert r.status_code == 200
        body = r.json()
        assert body["name"] == "A_flat"
        assert "nifty_flat_A" in body["yaml"]

    def test_unknown_preset_is_404(self, client: TestClient) -> None:
        r = client.get("/presets/does_not_exist")
        assert r.status_code == 404

    def test_path_traversal_attempt_is_rejected(self, client: TestClient) -> None:
        r = client.get("/presets/..%2F..%2F..%2Fetc%2Fpasswd")
        assert r.status_code == 404

    def test_path_traversal_with_dotdot_segment_is_rejected(self, client: TestClient) -> None:
        r = client.get("/presets/%2e%2e")
        assert r.status_code in (404, 400)


class TestValidate:
    def test_valid_strategy(self, client: TestClient) -> None:
        yaml_text = (STRATEGIES_DIR / "A_flat.yaml").read_text()
        r = client.post("/validate", json={"yaml": yaml_text})
        assert r.status_code == 200
        body = r.json()
        assert body["valid"] is True
        assert body["strategy_id"] == "nifty_flat_A"
        assert body["n_ladders"] == 0

    def test_invalid_strategy_returns_errors_not_500(self, client: TestClient) -> None:
        r = client.post("/validate", json={"yaml": "not: a valid strategy at all"})
        assert r.status_code == 200
        body = r.json()
        assert body["valid"] is False
        assert len(body["errors"]) > 0

    def test_malformed_yaml_does_not_crash(self, client: TestClient) -> None:
        r = client.post("/validate", json={"yaml": "{{{not yaml"})
        # A YAML parse error is a validation failure, not a 500 — surfaced
        # as {"valid": false, "errors": [...]}, same shape as a schema error.
        assert r.status_code == 200
        assert r.json()["valid"] is False


class TestCoverage:
    def test_empty_cache_returns_empty(self, client: TestClient) -> None:
        r = client.get("/coverage", params={"underlying": "NIFTY"})
        assert r.status_code == 200
        assert r.json() == {}

    def test_real_cache_reports_a_date_range(self, real_cache_client: TestClient) -> None:
        r = real_cache_client.get("/coverage", params={"underlying": "NIFTY"})
        assert r.status_code == 200
        body = r.json()
        assert "15m" in body
        assert body["15m"]["start"] <= body["15m"]["end"]


class TestRuns:
    def test_run_against_empty_cache_is_404(self, client: TestClient) -> None:
        yaml_text = (STRATEGIES_DIR / "A_flat.yaml").read_text()
        r = client.post(
            "/runs", json={"yaml": yaml_text, "from": "2026-08-17", "to": "2026-09-04"}
        )
        assert r.status_code == 404

    def test_invalid_strategy_run_is_422(self, client: TestClient) -> None:
        r = client.post(
            "/runs", json={"yaml": "not: valid", "from": "2026-08-17", "to": "2026-09-04"}
        )
        assert r.status_code == 422

    def test_run_against_real_cache_matches_golden_net(self, real_cache_client: TestClient) -> None:
        yaml_text = (STRATEGIES_DIR / "A_flat.yaml").read_text()
        r = real_cache_client.post(
            "/runs", json={"yaml": yaml_text, "from": "2026-08-17", "to": "2026-09-04"}
        )
        assert r.status_code == 200
        body = r.json()
        assert round(body["net_inr"]) == 7568
        assert round(body["gross_inr"]) > round(body["net_inr"])  # cost was subtracted
        assert body["bootstrap"] is None
        assert len(body["sessions"]) == 15

    def test_bootstrap_flag_populates_the_bootstrap_field(self, real_cache_client: TestClient) -> None:
        yaml_text = (STRATEGIES_DIR / "A_flat.yaml").read_text()
        r = real_cache_client.post(
            "/runs",
            json={
                "yaml": yaml_text,
                "from": "2026-08-17",
                "to": "2026-09-04",
                "bootstrap": True,
                "bootstrap_resamples": 200,
                "seed": 3,
            },
        )
        assert r.status_code == 200
        assert r.json()["bootstrap"] is not None

    def test_run_is_recorded_and_retrievable(self, real_cache_client: TestClient) -> None:
        yaml_text = (STRATEGIES_DIR / "A_flat.yaml").read_text()
        run_body = real_cache_client.post(
            "/runs", json={"yaml": yaml_text, "from": "2026-08-17", "to": "2026-09-04"}
        ).json()
        run_id = run_body["run_id"]

        detail = real_cache_client.get(f"/runs/{run_id}")
        assert detail.status_code == 200
        assert detail.json()["strategy_id"] == "nifty_flat_A"

        listing = real_cache_client.get("/runs")
        assert listing.status_code == 200
        assert any(r["run_id"] == run_id for r in listing.json())

    def test_unknown_run_id_is_404(self, client: TestClient) -> None:
        r = client.get("/runs/does-not-exist")
        assert r.status_code == 404

    def test_empty_registry_lists_no_runs(self, client: TestClient) -> None:
        r = client.get("/runs")
        assert r.status_code == 200
        assert r.json() == []
