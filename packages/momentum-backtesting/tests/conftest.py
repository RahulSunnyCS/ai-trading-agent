import os

import pytest


@pytest.fixture(autouse=True)
def _isolated_trading_data_root(tmp_path_factory, monkeypatch):
    """No test may read or write the real ~/TradingData (TRADING_DATA_ROOT) — the
    shared local database (packages/trading-data). A test that wants a specific
    root still passes its own path explicitly; this is only the safe default."""
    monkeypatch.setenv("TRADING_DATA_ROOT", str(tmp_path_factory.mktemp("trading_data_root")))


@pytest.fixture(autouse=True)
def _isolated_state_dir(tmp_path_factory, monkeypatch):
    """BL-051: the weekly message and live-rules files (`this_week.state_dir()`) go to a temp
    folder, never the real `data/`."""
    monkeypatch.setenv("MOMENTUM_STATE_DIR", str(tmp_path_factory.mktemp("momentum_state")))
    # ... and the scheduler's run history is never the real one either.
    monkeypatch.setenv("SCHEDULER_STATE_DIR", str(tmp_path_factory.mktemp("scheduler_state")))


@pytest.fixture(autouse=True)
def _isolated_environ():
    """A7 fix: `config.load_repo_env()` loads the repo's real `.env` into `os.environ` via
    `os.environ.setdefault` — a direct mutation, not `monkeypatch.setenv`. Several API routes
    call it unmocked (e.g. the Fyers OAuth endpoints), so the first test in the whole pytest
    process to hit one of them permanently sets real values (DATABASE_URL, FYERS_APP_ID,
    FYERS_ACCESS_TOKEN, ...) in the process environment for every later test — including
    tests that only mock their own `load_repo_env` reference and assume a clean slate. That
    made `test_local_browser_oauth_caches_token_only_after_valid_state` fail only when run
    after certain other tests, never alone. Snapshot/restore the whole environment around
    every test to catch this regardless of which mutation path caused it."""
    before = dict(os.environ)
    yield
    os.environ.clear()
    os.environ.update(before)
