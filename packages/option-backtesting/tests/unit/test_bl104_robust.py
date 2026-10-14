"""BL-104: the numpy CSCV in research/bl104/robust.py reproduces analytics/overfit.run_cscv."""

from __future__ import annotations

import importlib.util
import sys
from datetime import date
from pathlib import Path
from types import SimpleNamespace

import numpy as np
import pytest

from option_backtesting.analytics.overfit import run_cscv
from option_backtesting.analytics.sweep import SweepReport

ROBUST_PY = Path(__file__).resolve().parents[2] / "research" / "bl104" / "robust.py"


def _load():
    spec = importlib.util.spec_from_file_location("bl104_robust", ROBUST_PY)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    sys.modules["bl104_robust"] = module
    spec.loader.exec_module(module)
    return module


robust = _load()


def _report(matrix: np.ndarray) -> SweepReport:
    configs = [
        SimpleNamespace(
            label=f"c{j}",
            result=SimpleNamespace(sessions=[SimpleNamespace(net=float(v)) for v in matrix[:, j]]),
        )
        for j in range(matrix.shape[1])
    ]
    return SweepReport(date_from=date(2025, 1, 1), date_to=date(2025, 12, 31), configs=configs)


@pytest.mark.parametrize("seed", [1, 2, 3])
@pytest.mark.parametrize("n_blocks", [4, 8])
def test_numpy_cscv_matches_the_library(seed: int, n_blocks: int) -> None:
    rng = np.random.default_rng(seed)
    matrix = rng.normal(50, 1500, size=(61, 9)).round(2)
    matrix[:, 0] += 120  # one config with a real edge
    matrix[:, 1] = 0.0  # a flat config: zero variance -> Sharpe 0 in both
    pbo, splits = robust.cscv_pbo(matrix, n_blocks)
    expected = run_cscv(_report(matrix), n_blocks=n_blocks)
    assert splits == expected.n_combinations
    assert pbo == pytest.approx(expected.pbo)


def test_cscv_rejects_bad_shapes() -> None:
    with pytest.raises(ValueError):
        robust.cscv_pbo(np.zeros((10, 1)), 4)
    with pytest.raises(ValueError):
        robust.cscv_pbo(np.zeros((7, 3)), 4)


def test_half_years_and_ulcer() -> None:
    days = [
        date(2024, 10, 9),
        date(2025, 2, 3),
        date(2025, 6, 2),
        date(2025, 11, 3),
        date(2026, 5, 4),
    ]
    values = np.array([100.0, -50.0, 200.0, -300.0, 400.0])
    halves = robust.half_years(days, values)
    assert [h["n_days"] for h in halves] == [2, 1, 1, 1]
    assert halves[0]["avg_day_inr"] == pytest.approx(25.0)
    assert robust.ulcer(np.array([100.0, -100.0, 100.0])) == pytest.approx(
        np.sqrt((0 + 100**2 + 0) / 3)
    )
