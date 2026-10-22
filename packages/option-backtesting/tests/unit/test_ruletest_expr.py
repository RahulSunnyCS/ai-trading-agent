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
    {"gt": ["close", {"supertrend": {"n": 10, "mult": 3, "minutes": 5}}]},
    {"gt": [{"supertrend_dir": {"n": 7, "mult": 2, "minutes": 3}}, 0]},
    {"gt": ["close", {"bollinger": {"n": 20, "k": 2, "minutes": 5, "band": "upper"}}]},
    {"gt": [{"max": ["close", "open"]}, {"min": ["high", "pivot"]}]},
    {"gt": ["close", {"at_first": {"x": "high", "when": {"gt": ["close", "r1"]}}}]},
    {"ge": [{"min_since_first": {"x": "close", "when": {"gt": ["close", "pivot"]}}}, "pivot"]},
    {"le": [{"max_since_first": {"x": "high", "when": {"lt": ["close", "s1"]}}}, "prev_high"]},
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


# --- Supertrend and Bollinger bands ----------------------------------------------------------


def reference_supertrend(h, lo, c, n, mult):
    """TradingView's ta.supertrend written out longhand (direction -1 = up there; +1 here)."""
    tr = [h[0] - lo[0]] + [
        max(h[i] - lo[i], abs(h[i] - c[i - 1]), abs(lo[i] - c[i - 1])) for i in range(1, len(c))
    ]
    atr = [None] * len(c)
    atr[n - 1] = sum(tr[:n]) / n
    for i in range(n, len(c)):
        atr[i] = (atr[i - 1] * (n - 1) + tr[i]) / n
    line, up = [None] * len(c), [None] * len(c)
    pl = pu = ps = None
    for i in range(len(c)):
        if atr[i] is None:
            continue
        mid = (h[i] + lo[i]) / 2
        lower, upper = mid - mult * atr[i], mid + mult * atr[i]
        if pl is not None:
            lower = lower if (lower > pl or c[i - 1] < pl) else pl
            upper = upper if (upper < pu or c[i - 1] > pu) else pu
        if ps is None:
            d = False
        elif ps == pu:
            d = c[i] > upper
        else:
            d = not c[i] < lower
        line[i], up[i] = (lower if d else upper), d
        pl, pu, ps = lower, upper, line[i]
    return line, up


def test_supertrend_matches_the_longhand_definition_across_sessions():
    fr = frame(6, seed=4)
    m, n, mult = 5, 10, 3.0
    nb = E.N_BARS // m
    h = fr.H[:, : nb * m].reshape(fr.n, nb, m).max(2).reshape(-1)
    lo = fr.L[:, : nb * m].reshape(fr.n, nb, m).min(2).reshape(-1)
    c = fr.C[:, m - 1 :: m].reshape(-1)
    want_line, want_up = reference_supertrend(list(h), list(lo), list(c), n, mult)
    line = E.evaluate(E.parse({"supertrend": {"n": n, "mult": mult, "minutes": m}}), fr)
    sdir = E.evaluate(E.parse({"supertrend_dir": {"n": n, "mult": mult, "minutes": m}}), fr)
    got_line = line[:, m - 1 :: m].reshape(-1)
    got_dir = sdir[:, m - 1 :: m].reshape(-1)
    for k, (wl, wu) in enumerate(zip(want_line, want_up, strict=True)):
        if wl is None:
            assert np.isnan(got_line[k]) and np.isnan(got_dir[k])
        else:
            assert got_line[k] == pytest.approx(wl) and got_dir[k] == (1 if wu else -1)
    assert set(np.unique(got_dir[~np.isnan(got_dir)])) <= {-1.0, 1.0}
    # held between bar closes, and the first bar of a session waits for its own close
    assert line[2, 4] == line[2, 8] != line[2, 9] and np.isnan(line[2, 3])


def test_supertrend_follows_a_trend_and_flips():
    n = 4
    up = np.linspace(20000, 20400, E.N_BARS)
    down = np.linspace(20400, 19800, E.N_BARS)
    close = np.vstack([up, down])
    fr = E.Frame(days=["2026-01-01", "2026-01-02"], O=close, H=close + 2, L=close - 2, C=close)
    sdir = E.evaluate(E.parse({"supertrend_dir": {"n": n, "mult": 3, "minutes": 5}}), fr)
    line = E.evaluate(E.parse({"supertrend": {"n": n, "mult": 3, "minutes": 5}}), fr)
    assert sdir[0, 100] == 1 and line[0, 100] < close[0, 100]
    assert sdir[1, 300] == -1 and line[1, 300] > close[1, 300]


def test_bollinger_bands():
    fr = frame(3, seed=6)
    m, n, k = 5, 20, 2.0
    c = fr.C[:, m - 1 :: m].reshape(-1)
    got = {
        band: E.evaluate(E.parse({"bollinger": {"n": n, "k": k, "minutes": m, "band": band}}), fr)[
            :, m - 1 :: m
        ].reshape(-1)
        for band in ("upper", "middle", "lower")
    }
    assert np.isnan(got["middle"][: n - 1]).all()
    for i in (n - 1, 40, len(c) - 1):
        window = c[i - n + 1 : i + 1]
        assert got["middle"][i] == pytest.approx(window.mean())
        assert got["upper"][i] == pytest.approx(window.mean() + k * window.std())
        assert got["lower"][i] == pytest.approx(window.mean() - k * window.std())


def test_indicator_parse_errors_and_words():
    with pytest.raises(E.RuleError, match="band"):
        E.parse({"bollinger": {"band": "top"}})
    with pytest.raises(E.RuleError, match="mult"):
        E.parse({"supertrend": {"mult": 0}})
    with pytest.raises(E.RuleError, match="write"):
        E.parse({"supertrend_dir": {"period": 10}})
    words = E.describe(E.parse({"supertrend_dir": {}}))
    assert words == "the Supertrend (10, 3) direction (+1 up, −1 down) of 5-minute bars"
    assert E.describe(E.parse({"bollinger": {"band": "lower"}})) == (
        "the lower Bollinger band (20, 2) of 5-minute bars"
    )


# --- max / min, values tied to an event, values tied to the trade ----------------------------


def test_max_and_min_keep_a_missing_value_missing():
    fr = frame(3)
    hi = E.evaluate(E.parse({"max": ["close", "open"]}), fr)
    assert np.allclose(hi, np.maximum(fr.C, fr.O))
    lo = E.evaluate(E.parse({"min": ["close", "atr14"]}), fr)  # atr14 is NaN before 14 sessions
    assert np.isnan(lo).all()


def test_at_first_and_since_first():
    close = np.tile(np.arange(E.N_BARS, dtype=float), (2, 1))
    close[0, 50:] = 10.0  # session 1 falls back at stamp 50
    fr = E.Frame(days=["2026-01-01", "2026-01-02"], O=close, H=close + 1, L=close - 1, C=close)
    when = {"ge": ["close", 40]}  # first true at stamp 40 on both sessions
    at = E.evaluate(E.parse({"at_first": {"x": "high", "when": when}}), fr)
    assert np.isnan(at[:, :40]).all() and (at[:, 40:] == 41.0).all()
    lo = E.evaluate(E.parse({"min_since_first": {"x": "close", "when": when}}), fr)
    assert np.isnan(lo[0, :40]).all() and lo[0, 49] == 40.0 and lo[0, 50] == 10.0
    assert lo[1, 300] == 40.0
    hi = E.evaluate(E.parse({"max_since_first": {"x": "close", "when": when}}), fr)
    assert hi[0, 60] == 49.0 and hi[1, 300] == 300.0
    never = E.evaluate(E.parse({"at_first": {"x": "high", "when": {"lt": ["close", -1]}}}), fr)
    assert np.isnan(never).all()
    assert E.describe(E.parse({"at_first": {"x": "high", "when": when}})) == (
        "high when (close ≥ 40) first held today"
    )


def test_trade_relative_values_only_where_allowed():
    ok = E.parse({"lt": ["close", {"sub": [{"at_entry": "close"}, {"mul": [0.3, "atr14"]}]}]})
    assert ok.trade
    assert E.parse({"ge": ["minutes_in_trade", 60]}).trade
    assert not E.parse({"gt": ["close", "open"]}).trade
    with pytest.raises(E.RuleError, match="can only be used under"):
        E.parse({"gt": [{"roll_max": {"x": {"at_entry": "close"}, "n": 5}}, 0]})
    with pytest.raises(E.RuleError, match="another trade-relative"):
        E.parse({"gt": [{"at_entry": "minutes_in_trade"}, 0]})
    with pytest.raises(E.RuleError, match="exit_when only"):
        E.parse_rule({"ge": ["minutes_in_trade", 5]})
    with pytest.raises(E.RuleError, match="exit_when only"):
        E.evaluate(ok, frame(2))


def test_evaluate_trade_reads_the_entry_minute():
    fr = frame(3, seed=8)
    memo: dict = {}
    held = E.evaluate_trade(E.parse({"ge": ["minutes_in_trade", 60]}), fr, 1, 99, memo)
    assert not held[:159].any() and held[159:].all()  # enters at 100; out at 160 = 60 minutes
    node = E.parse({"lt": ["close", {"sub": [{"at_entry": "close"}, 5]}]})
    row = E.evaluate_trade(node, fr, 2, 120, memo)
    assert (row == (fr.C[2] < fr.C[2, 120] - 5)).all()
