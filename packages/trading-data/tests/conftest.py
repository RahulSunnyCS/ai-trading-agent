import pytest


@pytest.fixture(autouse=True)
def _isolated_trading_data_root(tmp_path_factory, monkeypatch):
    """No test may touch the real ~/TradingData (TRADING_DATA_ROOT)."""
    monkeypatch.setenv("TRADING_DATA_ROOT", str(tmp_path_factory.mktemp("trading_data_root")))
