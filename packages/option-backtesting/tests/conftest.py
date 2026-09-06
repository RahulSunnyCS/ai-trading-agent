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
