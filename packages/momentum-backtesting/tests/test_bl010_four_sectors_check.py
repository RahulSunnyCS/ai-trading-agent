"""The gate and verdict logic of scripts/bl010_four_sectors_check.py (BL-010 addenda 6 to 8).

The check ran once and wrote its result, so a wrong comparison in these functions could not be
caught by running it again. These tests pin the rules on synthetic inputs."""

from __future__ import annotations

import importlib.util
import json
from pathlib import Path

import pandas as pd
import pytest

PKG = Path(__file__).resolve().parent.parent
SCRIPT = PKG / "scripts" / "bl010_four_sectors_check.py"


@pytest.fixture(scope="module")
def check():
    spec = importlib.util.spec_from_file_location("bl010_four_sectors_check", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.mark.parametrize(
    ("g1", "g2", "g3", "soft", "expected"),
    [
        (True, True, True, [True, True, True], "HOLDS_UP"),
        (True, True, True, [True, False, True], "HOLDS_UP"),  # one soft failure is allowed
        (True, True, True, [False, False, True], "DOES_NOT_HOLD_UP"),
        (False, True, True, [True, True, True], "DOES_NOT_HOLD_UP"),  # the minimum bar failed
        (True, False, True, [True, True, True], "MIXED"),  # drawdown basket failed
        (True, True, False, [True, True, True], "MIXED"),  # a bad year
        (True, False, False, [True, False, True], "MIXED"),
        (True, False, True, [False, False, True], "DOES_NOT_HOLD_UP"),
    ],
)
def test_the_verdict_rule_of_addendum_6(check, g1, g2, g3, soft, expected):
    assert check.verdict_of(g1, g2, g3, soft) == expected


def test_the_plateau_gate_is_in_points_and_needs_both_halves(check):
    assert check.g4_passes(-4.9, 0.75)
    assert not check.g4_passes(-5.1, 0.75)  # median neighbour too far below A0
    assert not check.g4_passes(-1.0, 0.74)  # too few neighbours above Mom30 TRI
    assert check.g4_passes(+2.0, 1.0)


def test_the_script_reads_the_committed_numbers_not_its_own(check):
    committed = json.loads((PKG / "search_spaces" / "bl010_criteria_addendum_8.json").read_text())[
        "four_sectors_gates"
    ]
    assert check.G1_EXCESS_OVER_MOM30 == committed["g1_excess_over_mom30"] == 0.05
    assert check.G3_WORST_FY_VS_MOM30 == committed["g3_worst_fy_vs_mom30"] == -0.10
    assert check.G4_MEDIAN_GAP_PTS == committed["g4_median_gap_pts"] == -5.0
    assert committed["g5_alpha"] == check.G5_ALPHA and committed["g5_abs_t"] == check.G5_ABS_T
    assert committed["g6_margin_over_p95"] == check.G6_MARGIN_OVER_P95


def test_falls_report_depth_weeks_down_and_weeks_back(check):
    weeks = pd.date_range("2020-01-03", periods=14, freq="W-FRI")
    #            peak                      trough              back at the peak
    values = [1.0, 1.1, 1.2, 1.0, 0.9, 0.95, 1.0, 1.1, 1.2, 1.25, 1.3, 1.3, 1.3, 1.3]
    curve = pd.Series(values, index=weeks)
    index = pd.Series(1.0, index=weeks)
    falls = check._falls(curve, index)
    assert len(falls) == 1
    fall = falls[0]
    assert fall["depth"] == pytest.approx(0.9 / 1.2 - 1)
    assert fall["weeks_peak_to_trough"] == 2
    assert fall["weeks_trough_to_recovery"] == 4  # 0.9 -> back at 1.2 on the 9th row
