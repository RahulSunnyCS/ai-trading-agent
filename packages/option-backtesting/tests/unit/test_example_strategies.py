"""
All five example strategies under strategies/ must validate — the second
half of the M-2 exit criterion (the first half, the lagless-feature line
number, is in test_strategy_loader.py).
"""

from pathlib import Path

import pytest

from option_backtesting.strategy.loader import load_strategy

STRATEGIES_DIR = Path(__file__).parent.parent.parent / "strategies"

EXPECTED_FILES = [
    "A_flat.yaml",
    "B_pyramid.yaml",
    "C_pyramid_fallback.yaml",
    "D_adaptive_trailing.yaml",
    "or_breakout.yaml",
]


def test_strategies_dir_has_exactly_the_expected_files() -> None:
    actual = sorted(p.name for p in STRATEGIES_DIR.glob("*.yaml"))
    assert actual == sorted(EXPECTED_FILES)


@pytest.mark.parametrize("filename", EXPECTED_FILES)
def test_example_strategy_validates(filename: str) -> None:
    loaded = load_strategy(STRATEGIES_DIR / filename)
    assert loaded.strategy is not None
    assert loaded.strategy.id


def test_variant_a_is_flat_no_ladders() -> None:
    loaded = load_strategy(STRATEGIES_DIR / "A_flat.yaml")
    assert loaded.strategy.entry.lots == 4
    assert loaded.strategy.ladders == []


def test_variant_b_has_two_fixed_anchor_ladders() -> None:
    loaded = load_strategy(STRATEGIES_DIR / "B_pyramid.yaml")
    assert len(loaded.strategy.ladders) == 2
    assert all(ladder.when.ref.at == "entry" for ladder in loaded.strategy.ladders)


def test_variant_c_adds_a_fallback() -> None:
    loaded = load_strategy(STRATEGIES_DIR / "C_pyramid_fallback.yaml")
    assert loaded.strategy.fallback is not None
    assert loaded.strategy.fallback.time == "12:00"


def test_variant_d_uses_running_low_and_adaptive_threshold() -> None:
    loaded = load_strategy(STRATEGIES_DIR / "D_adaptive_trailing.yaml")
    assert all(ladder.when.ref.at == "running_low" for ladder in loaded.strategy.ladders)
    assert all(
        ladder.when.ref.plus.feature == "spike_thr_5d" for ladder in loaded.strategy.ladders
    )
    assert loaded.features["spike_thr_5d"].lag == 1


def test_or_breakout_uses_any_condition_and_fuller_exits() -> None:
    loaded = load_strategy(STRATEGIES_DIR / "or_breakout.yaml")
    assert len(loaded.strategy.entry.filter) == 1
    assert type(loaded.strategy.entry.filter[0]).__name__ == "AnyCondition"
    assert len(loaded.strategy.exits) == 3
