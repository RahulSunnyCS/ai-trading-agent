"""`Result.weights` is in date order on the frozen fixture's real runs (BL-001).

`pd.DataFrame.from_dict(..., orient="index")` orders rows by when each column first appears,
not by date, and the circuit card (`holding_periods`, `last_day`) and the weekly signal
(`weights.iloc[-1]`) read the rows in order. The golden responses do not carry the frame, so this
runs scenarios in the harness's own process and records every frame the engine returns.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

from .harness import GOLDEN

PACKAGE_ROOT = GOLDEN.parents[1]
#: One scenario of each kind of run: ETF index, stock, and Broad (the circuit card's).
SCENARIO_NAMES = ["etf_default", "stock_default", "broad_default", "broad_monday_open"]

CHILD = r"""
import json, sys
from pathlib import Path
from fastapi.testclient import TestClient
from momentum_backtesting import api, engine
from tests.golden.harness import build_inputs, expand
import os

seen = []
original = engine.run_backtest

def recording(*args, **kwargs):
    result = original(*args, **kwargs)
    seen.append(result.weights.index)
    return result

for module in list(sys.modules.values()):
    if getattr(module, "__name__", "").startswith("momentum_backtesting") and getattr(
        module, "run_backtest", None
    ) is original:
        module.run_backtest = recording

build_inputs(Path(os.environ["TRADING_DATA_ROOT"]), Path(os.environ["MOMENTUM_DATA_DIR"]))
client = TestClient(api.create_app())
out = {}
for name, scenario in json.loads(Path(sys.argv[1]).read_text()).items():
    seen.clear()
    request = expand(client, scenario)
    assert client.post("/api/backtest", json=request).status_code == 200, name
    out[name] = [
        {"rows": len(i), "sorted": bool(i.is_monotonic_increasing), "unique": bool(i.is_unique)}
        for i in seen
    ]
Path(sys.argv[2]).write_text(json.dumps(out))
"""


def test_every_weights_frame_on_the_fixture_is_in_date_order():
    from .scenarios import SCENARIOS

    with tempfile.TemporaryDirectory(prefix="mbt-golden-weights-") as tmp:
        work = Path(tmp)
        (work / "scenarios.json").write_text(
            json.dumps({name: SCENARIOS[name] for name in SCENARIO_NAMES})
        )
        env = {
            **os.environ,
            "TRADING_DATA_ROOT": str(work / "root"),
            "MOMENTUM_DATA_DIR": str(work / "data"),
            "GOLDEN_CUTOFF": "",
            "PYTHONHASHSEED": "0",
            "PYTHONPATH": str(PACKAGE_ROOT),
        }
        for secret in ("DATABASE_URL", "FYERS_ACCESS_TOKEN", "FYERS_APP_ID"):
            env.pop(secret, None)
        done = subprocess.run(
            [sys.executable, "-c", CHILD, str(work / "scenarios.json"), str(work / "out.json")],
            env=env,
            cwd=PACKAGE_ROOT,
            capture_output=True,
            text=True,
            check=False,
        )
        assert done.returncode == 0, done.stderr[-4000:]
        recorded = json.loads((work / "out.json").read_text())

    for name in SCENARIO_NAMES:
        frames = recorded[name]
        assert frames, f"{name}: the engine returned no weights frame"
        for found in frames:
            assert found["rows"] > 10, name
            assert found["sorted"] and found["unique"], f"{name}: weights not in date order"
