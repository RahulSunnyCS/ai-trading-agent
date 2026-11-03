"""BL-176 finalist checks (criteria addendum 1): the gates read for an ensemble."""

import importlib.util
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
_spec = importlib.util.spec_from_file_location(
    "bl176_finalists", ROOT / "scripts" / "bl176_finalists.py"
)
fin = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(fin)


def _weeks(n: int = 160) -> pd.DatetimeIndex:
    return pd.date_range("2018-01-05", periods=n, freq="W-FRI")


def test_g4_compares_each_neighbour_with_its_own_member():
    """A neighbour of a weak member is judged against that member, not against the ensemble:
    a member at 20% whose neighbours sit at 19% is a plateau even beside a member at 40%."""
    own = {"a": 0.40, "b": 0.20}
    neigh = pd.DataFrame(
        {
            "member": ["a", "a", "b", "b"],
            "label": ["x", "y", "x", "y"],
            "cagr": [0.39, 0.38, 0.19, 0.19],
            "mom30_cagr": [0.10] * 4,
        }
    )
    g4 = fin.g4_pooled(neigh, own)
    assert g4["pass"]
    assert np.isclose(g4["median_gap_pts"], -1.0)
    assert np.isclose(g4["per_member"]["a"]["median_gap_pts"], -1.5)
    assert g4["share_5_pts_above_mom30"] == 1.0


def test_g4_fails_on_a_spike_and_on_neighbours_near_mom30():
    own = {"a": 0.40}
    spike = pd.DataFrame(
        {
            "member": ["a"] * 4,
            "label": list("wxyz"),
            "cagr": [0.30, 0.31, 0.32, 0.33],
            "mom30_cagr": [0.10] * 4,
        }
    )
    assert not fin.g4_pooled(spike, own)["pass"]  # median 7.5 points below
    near = spike.assign(cagr=[0.39] * 4, mom30_cagr=[0.36] * 4)
    assert not fin.g4_pooled(near, own)["pass"]  # none 5 points above Mom30


def test_placebo_ensembles_pair_the_members_by_seed():
    """Seed s of the placebo ensemble holds every member's run on seed s, equal capital."""
    weeks = _weeks()
    flat = pd.Series(np.linspace(1.0, 1.0, len(weeks)), index=weeks)
    up = pd.Series(np.linspace(1.0, 2.0, len(weeks)), index=weeks)
    frames = {
        "a": pd.DataFrame({"0": flat, "1": up, "2": up}),
        "b": pd.DataFrame({"0": flat, "1": up}),  # seed 2 missing: not an ensemble yet
    }
    cagr = fin.placebo_ensembles(frames)
    assert list(cagr.index) == [0, 1]
    assert np.isclose(cagr[0], 0.0)
    assert cagr[1] > 0.2


def test_extended_ranking_aliases_its_own_tags_and_tax():
    """In the extended ranking P1 is P0 and T_real is T0 (addendum 1), so neither is run twice;
    the curated ranking runs both, and both rankings report Rs 50,000 beside."""
    names = lambda r: [p[0] for p in fin._variant_plan(r)]  # noqa: E731
    assert names("curated") == [
        "P0_as_ranked",
        "T0_after_tax",
        "P1_extended_tags",
        "T_real",
        "T_real_50k",
    ]
    assert names("extended") == ["P0_as_ranked", "T0_after_tax", "T_real_50k"]
    assert fin.ALIASES["extended"] == {"P1_extended_tags": "P0_as_ranked", "T_real": "T0_after_tax"}
    small = fin._variant_plan("extended")[-1]
    assert small[1:3] == ("extended", True)
    assert small[3] == {"capital": 50_000.0, "max_stock_price": 5000}


def test_ensemble_resets_to_equal_capital_each_april():
    weeks = _weeks(120)
    a = pd.Series(np.linspace(1.0, 3.0, len(weeks)), index=weeks)
    b = pd.Series(1.0, index=weeks)
    curve = fin.ensemble({"a": a, "b": b})
    # without the reset the blend is the plain mean; with it, gains are halved each year
    assert curve.iloc[-1] < (a.iloc[-1] + b.iloc[-1]) / 2
    assert np.isclose(curve.iloc[0], 1.0)


def test_the_check_reads_the_registered_gate_numbers():
    """No threshold is restated: every gate number is addendum 8's, via the four-sectors check."""
    from momentum_backtesting import criteria

    gates = criteria.load()["four_sectors_gates"]
    assert gates["g1_excess_over_mom30"] == fin.four.G1_EXCESS_OVER_MOM30
    assert gates["g6_margin_over_p95"] == fin.four.G6_MARGIN_OVER_P95
    assert fin.ADDENDUM.exists()
