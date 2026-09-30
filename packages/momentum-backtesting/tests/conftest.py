import pytest


@pytest.fixture(autouse=True)
def _isolated_trading_data_root(tmp_path_factory, monkeypatch):
    """No test may read or write the real ~/TradingData (TRADING_DATA_ROOT) — the
    shared local database (packages/trading-data). A test that wants a specific
    root still passes its own path explicitly; this is only the safe default."""
    monkeypatch.setenv("TRADING_DATA_ROOT", str(tmp_path_factory.mktemp("trading_data_root")))
