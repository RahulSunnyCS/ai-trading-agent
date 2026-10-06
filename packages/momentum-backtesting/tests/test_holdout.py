"""BL-010 Phase 6 backcast harness (criteria addendum 5): the data patches and the pass rule.
Synthetic data only: nothing here reads the 2012-2016 hold-out."""

import numpy as np
import pandas as pd
import pytest

from momentum_backtesting import holdout
from momentum_backtesting.engine import CASH


def test_patched_outer_prices_prepends_cash_and_swaps_the_benchmark():
    weeks = pd.date_range("2016-01-01", periods=3, freq="W-FRI")
    outer = pd.DataFrame({CASH: [100.0, 100.1, 100.2], "Nifty 50": [1.0, 2.0, 3.0]}, index=weeks)
    earlier = pd.date_range("2015-12-18", periods=5, freq="W-FRI")
    cash = pd.Series([99.8, 99.9, 100.0, 100.1, 100.2], index=earlier)
    tri = pd.Series(np.arange(10.0, 15.0), index=earlier)
    out = holdout.patched_outer_prices(outer, cash, tri)
    assert list(out.index) == list(earlier)
    assert out.loc["2015-12-18", CASH] == 99.8 and out.loc["2016-01-08", CASH] == 100.1
    assert list(out["Nifty 50"]) == list(tri)  # the benchmark line is the TRI throughout


WEEKS = pd.date_range("2012-01-06", periods=261, freq="W-FRI")


def _line(rate: float, fall: float = 0.0) -> pd.Series:
    """Five years compounding at `rate`, with a temporary `fall` over ten weeks."""
    values = np.exp(np.linspace(0, np.log((1 + rate) ** 5), len(WEEKS)))
    values[100:110] *= 1 - fall
    return pd.Series(values, index=WEEKS)


def _refs(midcap: pd.Series) -> pd.DataFrame:
    return pd.DataFrame(
        {
            "Nifty 500 TRI": _line(0.10, 0.12),
            "Nifty Midcap 150 TRI": midcap,
            "Nifty200 Momentum 30 TRI": _line(0.15),
            "Nifty Smallcap 250 TRI": _line(0.12),
        }
    )


def test_judge_needs_both_benchmarks_beaten_by_5_points_within_1_5x_drawdown():
    ensemble = _line(0.30, 0.15)
    assert holdout.judge(ensemble, _refs(_line(0.20, 0.12)))["passes"]
    # Midcap 150 at 26% a year: the ensemble is no longer 5 points ahead of it.
    verdict = holdout.judge(ensemble, _refs(_line(0.26, 0.12)))
    assert verdict["benchmarks"]["Nifty 500 TRI"]["passes"]
    assert not verdict["benchmarks"]["Nifty Midcap 150 TRI"]["passes"]
    assert not verdict["passes"]
    # A fall deeper than 1.5x the benchmark's fails despite the return (15% against 1.5 x 5%).
    assert not holdout.judge(ensemble, _refs(_line(0.10, 0.05)))["passes"]


def test_the_hold_out_runs_once(tmp_path):
    (tmp_path / "backcast.json").write_text("{}")
    with pytest.raises(RuntimeError, match="runs once"):
        holdout.run(tmp_path / "frozen.json", tmp_path / "space.toml", tmp_path)


def test_a_started_hold_out_cannot_be_started_again(tmp_path, monkeypatch):
    """The run is claimed before it starts: a crash after the numbers were seen still blocks
    a second run."""
    monkeypatch.setattr(holdout, "_dirty", lambda: False)
    monkeypatch.setattr(holdout, "_commit", lambda: "abc123")
    with pytest.raises(FileNotFoundError):  # no frozen record here: the run gets past the claim
        holdout.run(tmp_path / "frozen.json", tmp_path / "space.toml", tmp_path)
    assert (tmp_path / "backcast.claimed").read_text() == "started on abc123\n"
    with pytest.raises(RuntimeError, match="already started"):
        holdout.run(tmp_path / "frozen.json", tmp_path / "space.toml", tmp_path)


def test_a_dirty_tree_cannot_run_the_hold_out(tmp_path, monkeypatch):
    monkeypatch.setattr(holdout, "_dirty", lambda: True)
    with pytest.raises(RuntimeError, match="uncommitted"):
        holdout.run(tmp_path / "frozen.json", tmp_path / "space.toml", tmp_path)
    assert not (tmp_path / "backcast.claimed").exists()
