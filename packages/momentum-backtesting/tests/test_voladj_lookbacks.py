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


def test_the_default_score_widens_the_window_instead_of_skipping() -> None:
    """Pins today's default as it is: 30- and 56-week returns to the latest close (the
    'skip-month' widens the window), not 26/52 measured 4 weeks back. See BL-055's log."""
    p = prices()
    _, classic = compute_ranks(p, Config(score="voladj", universe=tuple(p)))
    vol = p.pct_change().rolling(26).std()

    def z(ret):
        comp = ret / vol
        return comp.sub(comp.mean(axis=1), axis=0).div(comp.std(axis=1), axis=0)

    widened = z(p / p.shift(30) - 1) + z(p / p.shift(56) - 1)
    pd.testing.assert_series_equal(classic.iloc[-1], widened.iloc[-1], check_names=False)


def test_26_52_with_a_true_skip_is_nse_as_published() -> None:
    p = prices()
    cfg = Config(score="voladj", lookbacks=(26, 52), voladj_lookbacks=True, universe=tuple(p))
    _, score = compute_ranks(p, cfg)
    vol = p.pct_change().rolling(26).std()

    def z(ret):
        comp = ret / vol
        return comp.sub(comp.mean(axis=1), axis=0).div(comp.std(axis=1), axis=0)

    nse = z(p.shift(4) / p.shift(30) - 1) + z(p.shift(4) / p.shift(56) - 1)
    pd.testing.assert_series_equal(score.iloc[-1], nse.iloc[-1], check_names=False)


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


def _single(p: pd.DataFrame, skip: str) -> pd.Series:
    cfg = Config(
        score="voladj", lookbacks=(4,), voladj_lookbacks=True, voladj_skip=skip, universe=tuple(p)
    )
    return compute_ranks(p, cfg)[1].iloc[-1]


def _expected(p: pd.DataFrame, start: int, end: int) -> pd.Series:
    ret = p.shift(end) / p.shift(start) - 1
    comp = ret / p.pct_change().rolling(26).std()
    z = comp.sub(comp.mean(axis=1), axis=0).div(comp.std(axis=1), axis=0)
    return z.iloc[-1]


def test_skip_all_measures_every_lookback_four_weeks_back() -> None:
    p = prices()
    pd.testing.assert_series_equal(_single(p, "all"), _expected(p, 8, 4), check_names=False)


def test_skip_none_runs_every_lookback_to_the_latest_close() -> None:
    p = prices()
    pd.testing.assert_series_equal(_single(p, "none"), _expected(p, 4, 0), check_names=False)


def test_skip_long_only_skips_26_weeks_and_more() -> None:
    p = prices()
    pd.testing.assert_series_equal(_single(p, "long"), _single(p, "none"))  # 4 < 26: no skip
    cfg = dict(score="voladj", lookbacks=(26, 52), voladj_lookbacks=True, universe=tuple(p))
    _, long_rule = compute_ranks(p, Config(voladj_skip="long", **cfg))
    _, all_rule = compute_ranks(p, Config(voladj_skip="all", **cfg))
    pd.testing.assert_frame_equal(long_rule, all_rule)  # every lookback here is >= 26


def test_unknown_skip_rule_is_refused() -> None:
    with pytest.raises(ValueError):
        Config(voladj_skip="some")
