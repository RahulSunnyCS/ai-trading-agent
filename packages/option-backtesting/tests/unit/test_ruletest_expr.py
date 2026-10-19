"""The rule condition grammar (BL-120): parsing errors name their path, operators do what the
module docstring says, and no value at stamp j depends on a later stamp or session."""

from __future__ import annotations

import numpy as np
import pytest

from option_backtesting.ruletest import expr as E


def frame(n: int = 40, seed: int = 1) -> E.Frame:
    rng = np.random.default_rng(seed)
    steps = rng.normal(0, 2, size=(n, E.N_BARS))
    close = 20000 + np.cumsum(steps, axis=1) + np.arange(n)[:, None] * 10
    open_ = np.concatenate([close[:, :1] - 1, close[:, :-1]], axis=1)
    high = np.maximum(open_, close) + rng.uniform(0, 1.5, size=close.shape)
    low = np.minimum(open_, close) - rng.uniform(0, 1.5, size=close.shape)
    vix = 14 + np.cumsum(rng.normal(0, 0.02, size=(n, E.N_BARS)), axis=1)
    return E.Frame(
        days=[f"2026-01-{k + 1:02d}" for k in range(n)],
        O=open_,
        H=high,
        L=low,
        C=close,
        vix_close=vix,
        vix_open=vix[:, 0],
    )


def run(when, fr=None, define=None):
    root, _ = E.parse_rule(when, define)
    return E.evaluate(root, fr or frame())


def test_comparison_and_features():
    fr = frame()
    out = run({"gt": ["close", "open"]}, fr)
    assert out.dtype == bool and (out == (fr.C > fr.O)).all()


def test_clock_and_minute():
    out = run({"all": [{"ge": ["minute", {"clock": "10:30"}]}, {"le": ["minute", 80]}]})
    assert out[0].sum() == 80 - 75 + 1 and out[0, 75] and not out[0, 74]


def test_lag_and_pct_change_and_rolling():
    fr = frame()
    lag = E.evaluate(E.parse_rule({"gt": [{"lag": {"x": "close", "n": 3}}, 0]})[0], fr)
    assert not lag[0, :3].any() and lag[0, 3:].all()
    pct = E.evaluate(E.parse({"pct_change": {"x": "close", "n": 5}}), fr)
    assert np.isnan(pct[:, :5]).all()
    assert np.allclose(pct[:, 5:], fr.C[:, 5:] / fr.C[:, :-5] - 1)
    rmax = E.evaluate(E.parse({"roll_max": {"x": "high", "n": 30}}), fr)
    assert np.isnan(rmax[:, :29]).all() and np.allclose(rmax[:, 40], fr.H[:, 11:41].max(axis=1))


def test_since_at_and_cumulative():
    fr = frame()
    at = E.evaluate(E.parse({"at": {"x": "close", "clock": "09:20"}}), fr)
    assert np.isnan(at[:, :5]).all() and (at[:, 5:] == fr.C[:, [5]]).all()
    after = E.evaluate(E.parse({"max_since": {"x": "close", "after": "09:20"}}), fr)
    assert np.isnan(after[:, :6]).all()
    assert np.allclose(after[:, 10], fr.C[:, 6:11].max(axis=1))
    inclusive = E.evaluate(E.parse({"min_since": {"x": "close", "from": "09:20"}}), fr)
    assert np.allclose(inclusive[:, 10], fr.C[:, 5:11].min(axis=1))
    assert np.allclose(
        E.evaluate(E.parse({"cum_max": {"x": "high"}}), fr)[:, 50], fr.H[:, :51].max(axis=1)
    )


def test_crosses_and_first():
    fr = frame(3)
    fr.C[0, :6] = [10, 10, 12, 12, 8, 8]
    level = {"add": [0, 11]}
    up = E.evaluate(E.parse({"crosses_up": ["close", level]}), fr)[0]
    down = E.evaluate(E.parse({"crosses_down": ["close", level]}), fr)[0]
    assert up[2] and not up[3] and down[4]
    first = E.evaluate(
        E.parse(
            {
                "first": {
                    "any": [{"crosses_up": ["close", level]}, {"crosses_down": ["close", level]}]
                }
            }
        ),
        fr,
    )[0]
    assert first[2] and not first[4] and first.sum() <= 1 + 0  # only the first stamp in the session


def test_prior_median_uses_earlier_sessions_only():
    fr = frame(30)
    med = E.evaluate(E.parse({"prior_median": {"x": "close", "sessions": 5}}), fr)
    assert np.isnan(med[:5]).all()
    assert np.allclose(med[7], np.median(fr.C[2:7], axis=0))


def test_atr_pivot_and_session_constants():
    fr = frame(30)
    atr = E.feature(fr, "atr14")
    assert np.isnan(atr[:14]).all() and np.isfinite(atr[14:]).all()
    pivot = E.feature(fr, "pivot")
    expected = (fr.H[4].max() + fr.L[4].min() + fr.C[4, -1]) / 3
    assert np.allclose(pivot[5], expected)
    assert np.allclose(E.feature(fr, "r1")[5], 2 * expected - fr.L[4].min())


def test_rsi_holds_between_bars():
    fr = frame(20)
    rsi = E.evaluate(E.parse({"rsi": {"n": 14, "minutes": 5}}), fr)
    assert np.isnan(rsi[0, :4]).all()
    assert (rsi[1, 4:8] == rsi[1, 4]).all()  # forward-filled until the next 5-minute bar completes
    assert np.nanmin(rsi) >= 0 and np.nanmax(rsi) <= 100


def test_first_firings_window():
    fr = frame(5)
    root, _ = E.parse_rule({"ge": ["minute", 100]})
    assert E.first_firings(root, fr, 75, 285) == {i: 100 for i in range(5)}
    assert E.first_firings(root, fr, 75, 90) == {}


def test_define_names_and_describe():
    root, defs = E.parse_rule(
        {"all": ["wide", {"gt": ["close", "pivot"]}]},
        {"wide": {"gt": [{"sub": ["high", "low"]}, 3]}},
    )
    assert "wide" in defs
    assert E.describe(root) == "wide and (close > pivot)"
    assert E.describe_defs(defs) == ["wide means ((high − low) > 3)"]


@pytest.mark.parametrize(
    "bad,needle",
    [
        ({"gt": ["close"]}, "expected 2 argument"),
        ({"gt": ["close", "nope"]}, "unknown name 'nope'"),
        ({"wat": [1]}, "unknown operator"),
        ({"lag": {"x": "close"}}, "missing 'n'"),
        ({"lag": {"x": "close", "n": 0}}, "whole number"),
        ({"all": []}, "non-empty list"),
        ({"all": ["close"]}, "expected a condition"),
        ({"not": [{"add": [1, 2]}]}, "expected a condition"),
        ({"gt": [{"clock": "16:00"}, 1]}, "outside the 09:15-15:29"),
        ({"max_since": {"x": "close"}}, "exactly one of from / after"),
        ("close", "must be true / false"),
        (True, "bare true / false"),
    ],
)
def test_parse_errors_name_the_problem(bad, needle):
    with pytest.raises(E.RuleError) as error:
        E.parse_rule(bad)
    assert needle in str(error.value)


def test_define_cannot_shadow_a_name():
    with pytest.raises(E.RuleError, match="already taken"):
        E.parse_rule({"gt": ["close", 1]}, {"close": {"add": [1, 2]}})


# --- causality: no value at stamp j may depend on anything after it ------------------------

CAUSAL_RULES = [
    {"gt": ["close", "open"]},
    {"gt": [{"pct_change": {"x": "close", "n": 7}}, 0]},
    {"gt": ["close", {"roll_max": {"x": "high", "n": 20}}]},
    {"lt": ["close", {"max_since": {"x": "close", "after": "09:30"}}]},
    {"gt": [{"at": {"x": "close", "clock": "09:20"}}, 0]},
    {"gt": ["close", {"prior_median": {"x": "close", "sessions": 8}}]},
    {"first": {"gt": ["close", "pivot"]}},
    {"gt": [{"rsi": {"n": 14, "minutes": 5}}, 55]},
    {"gt": [{"div": [{"sub": ["close", "session_open"]}, "atr14"]}, 0.3]},
    {"gt": [{"sub": [{"div": ["vix", "vix_open"]}, 1]}, 0.001]},
    {"crosses_up": ["close", "r1"]},
    # the straddle's strike is chosen at the `at` bar's close: 12:00 is after the cut below, so a
    # stamp before it must not see the strike (09:20 is before the cut, so it is known there)
    {"gt": [{"straddle": {"at": "12:00"}}, "close"]},
    {"gt": [{"straddle": {"at": "09:20"}}, "close"]},
]


def with_straddle(fr: E.Frame) -> E.Frame:
    """A stand-in for frame.StraddleLoader: like it, the whole session's series depends on the
    spot close at the `at` stamp (the real one picks the strike from it)."""
    fr.straddle_loader = lambda at: np.repeat(fr.C[:, at][:, None], E.N_BARS, axis=1)
    return fr


@pytest.mark.parametrize("when", CAUSAL_RULES, ids=[str(i) for i in range(len(CAUSAL_RULES))])
def test_value_at_a_stamp_ignores_the_future(when):
    base = with_straddle(frame(40, seed=3))
    root, _ = E.parse_rule(when)
    full = E.evaluate(root, base)
    rng = np.random.default_rng(9)
    session, stamp = 30, 140
    cut = E.Frame(
        days=base.days,
        O=base.O.copy(),
        H=base.H.copy(),
        L=base.L.copy(),
        C=base.C.copy(),
        vix_close=base.vix_close.copy(),
        vix_open=base.vix_open.copy(),
    )
    # scramble everything after (session, stamp) and every later session
    for arr in (cut.O, cut.H, cut.L, cut.C, cut.vix_close):
        arr[session, stamp + 1 :] = rng.normal(
            20000 if arr is not cut.vix_close else 14, 50, size=E.N_BARS - stamp - 1
        )
        arr[session + 1 :] = rng.normal(
            20000 if arr is not cut.vix_close else 14, 50, size=arr[session + 1 :].shape
        )
    scrambled = E.evaluate(root, with_straddle(cut))
    same_until = full[: session + 1, : stamp + 1]
    other = scrambled[: session + 1, : stamp + 1]
    # earlier sessions entirely, and this session up to and including `stamp`
    assert np.array_equal(
        np.nan_to_num(same_until.astype(float), nan=-1), np.nan_to_num(other.astype(float), nan=-1)
    )
