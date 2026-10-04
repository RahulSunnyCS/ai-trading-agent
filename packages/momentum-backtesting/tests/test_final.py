"""Round 4 helpers: deflated Sharpe and the pre-registered reading."""

import numpy as np

from momentum_backtesting import final


def _weekly(mean, sd, n=313, seed=0):
    return np.random.default_rng(seed).normal(mean, sd, n)


def test_deflated_sharpe_rises_with_the_observed_sharpe_and_falls_with_more_trials():
    trials = np.random.default_rng(1).normal(0.05, 0.08, 5000)  # weekly Sharpes of other configs
    weak = final.deflated_sharpe(_weekly(0.002, 0.03), trials, 20000)
    strong = final.deflated_sharpe(_weekly(0.010, 0.03), trials, 20000)
    assert strong["dsr"] > weak["dsr"]
    few = final.deflated_sharpe(_weekly(0.006, 0.03), trials, 10)
    many = final.deflated_sharpe(_weekly(0.006, 0.03), trials, 100000)
    assert few["dsr"] > many["dsr"]
    assert 0 <= weak["dsr"] <= 1 and 0 <= strong["dsr"] <= 1


def test_pure_noise_gets_a_low_deflated_sharpe_when_many_trials_were_run():
    trials = np.random.default_rng(2).normal(0.0, 0.08, 5000)
    noise = final.deflated_sharpe(_weekly(0.0, 0.03, seed=5), trials, 20000)
    assert noise["dsr"] < 0.1


def test_reading_matches_the_preregistered_buckets_for_ten_finalists():
    assert final.reading(0, 10) == final.reading(2, 10) == "the in-sample edge did not generalise"
    assert final.reading(3, 10) == final.reading(6, 10)
    assert final.reading(3, 10).startswith("partial")
    assert final.reading(7, 10).startswith("edge generalises") and final.reading(10, 10).startswith(
        "edge"
    )


def test_run_final_refuses_without_the_explicit_flag(tmp_path):
    import pytest

    with pytest.raises(SystemExit):
        final.run_final(tmp_path, tmp_path / "s.toml", tmp_path / "f.json", open_sealed=False)
