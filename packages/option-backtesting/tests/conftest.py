"""
Shared pytest fixtures. `anyio_backend` pins async tests (e.g.
test_mcp_server.py, which calls the MCP server's async `call_tool`) to
asyncio only — anyio's pytest plugin (bundled transitively via
fastapi/starlette, already a dependency here) would otherwise also try the
trio backend, which this package never uses and does not depend on.
"""

import pytest


@pytest.fixture
def anyio_backend() -> str:
    return "asyncio"


@pytest.fixture(autouse=True)
def _isolated_trading_data_root(tmp_path_factory, monkeypatch):
    """No test may read or write the real ~/TradingData (TRADING_DATA_ROOT). A test that
    wants a specific root still sets its own; this is only the safe default underneath."""
    monkeypatch.setenv("TRADING_DATA_ROOT", str(tmp_path_factory.mktemp("trading_data_root")))


@pytest.fixture(autouse=True)
def _no_message_slippage(monkeypatch):
    """The evening message's figures after slippage (`rotation.slippage`) read the results'
    slippage copy, copying a missing pick from the day's bars. Tests run without it unless they
    set `SLIPPAGE_PCT` themselves."""
    from option_backtesting.rotation import slippage

    monkeypatch.setattr(slippage, "SLIPPAGE_PCT", 0.0)
