"""Every catalog connection here says which lake views it binds.

Binding a view lists (and, for some, reads the footer of) every file under it while the
catalog is locked, and nothing in this package reads a lake view through the catalog: the
legwise engine and the derived tables read the Parquet day files directly. So each
`connect()` passes `views=()`, keeping `obt daily`'s save, the run registry and the
collector's ingest runs from holding up every other process (trading_data.db.connect).
"""

import ast
from pathlib import Path

SRC = Path(__file__).parents[2] / "src" / "option_backtesting"


def test_every_catalog_connect_names_its_views():
    calls, missing = 0, []
    for path in sorted(SRC.rglob("*.py")):
        tree = ast.parse(path.read_text())
        names = {
            alias.asname or alias.name
            for node in ast.walk(tree)
            if isinstance(node, ast.ImportFrom) and node.module == "trading_data.db"
            for alias in node.names
            if alias.name == "connect"
        }
        for node in ast.walk(tree):
            if (
                isinstance(node, ast.Call)
                and isinstance(node.func, ast.Name)
                and node.func.id in names
            ):
                calls += 1
                if not any(k.arg == "views" for k in node.keywords):
                    missing.append(f"{path.relative_to(SRC)}:{node.lineno}")
    assert calls > 10  # the check found the callers (it cannot pass vacuously)
    assert missing == []
