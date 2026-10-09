"""BL-055: the volatility-adjusted score that follows the selected lookbacks and weights."""

import numpy as np
import pandas as pd
import pytest

from momentum_backtesting.engine import Config, compute_ranks

WEEKS = pd.date_range("2015-01-02", periods=140, freq="W-FRI")


def prices() -> pd.DataFrame:
    rng = np.random.default_rng(9)
    cols = [f"S{i}" for i in range(15)]
    return pd.DataFrame(
        100 * np.cumprod(1 + rng.normal(0.003, 0.04, (len(WEEKS), len(cols))), axis=0),
        index=WEEKS,
        columns=cols,
    )


def test_off_by_default_and_ignores_lookbacks_as_before() -> None:
    p = prices()
    a, _ = compute_ranks(p, Config(score="voladj", lookbacks=(4, 13), universe=tuple(p)))
    b, _ = compute_ranks(p, Config(score="voladj", lookbacks=(26, 52), universe=tuple(p)))
    pd.testing.assert_frame_equal(a, b)


def test_26_52_equal_weights_reproduces_the_default_score() -> None:
    p = prices()
    _, classic = compute_ranks(p, Config(score="voladj", universe=tuple(p)))
    _, flagged = compute_ranks(
        p, Config(score="voladj", lookbacks=(26, 52), voladj_lookbacks=True, universe=tuple(p))
    )
    pd.testing.assert_frame_equal(classic, flagged)


def test_the_lookbacks_and_weights_now_change_the_ranking() -> None:
    p = prices()
    base = dict(score="voladj", voladj_lookbacks=True, universe=tuple(p))
    short, _ = compute_ranks(p, Config(lookbacks=(4, 13), **base))
    long, _ = compute_ranks(p, Config(lookbacks=(26, 52), **base))
    tilted, _ = compute_ranks(p, Config(lookbacks=(4, 13), weights=(3.0, 1.0), **base))
    last = WEEKS[-1]
    assert not short.loc[last].equals(long.loc[last])
    assert not short.loc[last].equals(tilted.loc[last])


def test_short_lookbacks_skip_no_month() -> None:
    p = prices()
    cfg = Config(score="voladj", lookbacks=(4,), voladj_lookbacks=True, universe=tuple(p))
    _, score = compute_ranks(p, cfg)
    ret = p / p.shift(4) - 1
    vol = p.pct_change().rolling(26).std()
    comp = ret / vol
    z = comp.sub(comp.mean(axis=1), axis=0).div(comp.std(axis=1), axis=0)
    pd.testing.assert_series_equal(score.iloc[-1], z.iloc[-1], check_names=False)


def test_no_look_ahead() -> None:
    p = prices()
    cfg = Config(score="voladj", lookbacks=(4, 13, 26), voladj_lookbacks=True, universe=tuple(p))
    full, _ = compute_ranks(p, cfg)
    cut, _ = compute_ranks(p.iloc[:100], cfg)
    pd.testing.assert_frame_equal(cut, full.iloc[:100])


def test_blend_uses_it_too() -> None:
    p = prices()
    a, _ = compute_ranks(p, Config(score="blend", lookbacks=(4, 13), universe=tuple(p)))
    b, _ = compute_ranks(
        p, Config(score="blend", lookbacks=(4, 13), voladj_lookbacks=True, universe=tuple(p))
    )
    assert not a.iloc[-1].equals(b.iloc[-1])


@pytest.mark.parametrize("score", ["voladj", "blend"])
def test_a_shared_rank_cache_keeps_the_two_variants_apart(score) -> None:
    from momentum_backtesting.engine import BENCHMARK, CASH, run_backtest

    p = prices()
    names = list(p.columns)
    p[CASH] = 100 * 1.001 ** np.arange(len(p))
    p[BENCHMARK] = 100 * 1.002 ** np.arange(len(p))
    includes = {n: "core" for n in names} | {CASH: "defensive", BENCHMARK: "benchmark"}
    cache: dict = {}
    common = dict(
        score=score,
        lookbacks=(4, 13),
        top_n=3,
        exit_rank=5,
        universe=tuple(names),
        start="2016-01-01",
    )
    plain = run_backtest(p, includes, Config(**common), rank_cache=cache)
    flagged = run_backtest(p, includes, Config(voladj_lookbacks=True, **common), rank_cache=cache)
    assert len(cache) == 2
    assert not plain.ranks.equals(flagged.ranks)
