"""BL-043: daily candidates (Phase 1)."""

from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

from momentum_backtesting.patterns.bars import adjust
from momentum_backtesting.patterns.swing import candidates


def _frame(closes, *, symbol="AAA", end="2023-12-29", volume=None, spread=0.01) -> pd.DataFrame:
    closes = np.asarray(closes, dtype=float)
    dates = pd.bdate_range(end=end, periods=len(closes))
    return pd.DataFrame(
        {
            "date": dates,
            "symbol": symbol,
            "open": closes,
            "high": closes * (1 + spread),
            "low": closes * (1 - spread),
            "close": closes,
            "volume": np.full(len(closes), 1e6) if volume is None else np.asarray(volume, float),
        }
    )


def _market(seed: int = 7, n: int = 6) -> pd.DataFrame:
    """Random walks with run-ups, flags, tight pauses and breakouts on volume."""
    rng = np.random.default_rng(seed)
    frames = []
    for k in range(n):
        steps = rng.normal(0.0012, 0.02, 1200)
        volume = rng.lognormal(13.8, 0.3, 1200)
        for start in range(300 + k * 23, 1150, 150):
            steps[start : start + 15] = 0.02  # pole
            volume[start : start + 15] *= 2
            steps[start + 15 : start + 30] = rng.normal(-0.001, 0.003, 15)  # flag / tight range
            volume[start + 15 : start + 30] *= 0.5
            steps[start + 30] = 0.05  # breakout
            volume[start + 30] *= 4
        frame = _frame(500 * np.exp(np.cumsum(steps)), symbol=f"S{k}", volume=volume)
        frames.append(frame)
    return pd.concat(frames)


def test_candidates_cover_both_patterns_and_both_entries():
    found = candidates.scan(adjust(_market(), {}), workers=1)
    kinds = set(zip(found["pattern"], found["entry"], strict=True))
    assert kinds == {
        ("tight_range", "pullback"), ("tight_range", "breakout"),
        ("flag", "pullback"), ("flag", "breakout"),
    }  # fmt: skip
    pull = found[found["entry"] == "pullback"]
    assert (pull["close"] < pull["pivot"] * 0.95).all()
    brk = found[found["entry"] == "breakout"]
    assert (brk["close"] > brk["pivot"]).all()
    assert (found["base_low"] < found["pivot"]).all()
    assert found["quality"].between(0, 1).all()


def test_candidates_up_to_a_cut_do_not_change_when_later_bars_exist():
    daily = _market()
    full = candidates.scan(adjust(daily, {}), workers=1)
    for cut in ("2021-06-30", "2022-09-15", "2023-08-01"):
        part = daily[daily["date"] <= cut]
        early = candidates.scan(adjust(part, {}), workers=1)
        expected = full[full["date"] <= cut].reset_index(drop=True)
        assert len(expected) > 0
        pd.testing.assert_frame_equal(early, expected)


def test_universe_and_tradability_gates():
    daily = _market(n=2)
    members = {y: {"S0"} for y in range(2010, 2030)}
    found = candidates.scan(adjust(daily, {}), members, workers=1)
    assert set(found["symbol"]) == {"S0"}
    cheap = daily.assign(**{c: daily[c] / 10_000 for c in ("open", "high", "low", "close")})
    assert candidates.scan(adjust(cheap, {}), workers=1).empty  # under Rs 30


def test_base_id_is_stable_while_the_base_holds():
    found = candidates.scan(adjust(_market(), {}), workers=1)
    pull = found[(found["entry"] == "pullback") & (found["pattern"] == "tight_range")]
    assert pull.groupby("base_id")["date"].count().max() > 1


# --- Phase 2: the trade simulator ---------------------------------------------------------------

from momentum_backtesting.patterns.bars import SymbolBars  # noqa: E402
from momentum_backtesting.patterns.swing import trader  # noqa: E402


def _bars(rows) -> SymbolBars:
    """rows: (open, high, low, close) per session, from the signal day."""
    frame = pd.DataFrame(rows, columns=["open", "high", "low", "close"], dtype=float)
    frame["date"] = pd.bdate_range("2023-01-02", periods=len(frame))
    frame["symbol"] = "AAA"
    frame["volume"] = 1e6
    return SymbolBars.from_frame("AAA", adjust(frame, {}))


def _trade(rows, *, stop_rule="pct_8", target_r=2.0, base_low=90.0, atr=2.0):
    return trader.simulate_trade(
        _bars(rows), 0, base_low=base_low, atr=atr, stop_rule=stop_rule, target_r=target_r
    )


SIGNAL = (100, 101, 99, 100)


def test_fill_at_next_open_and_stop_intraday():
    t = _trade([SIGNAL, (100, 101, 99, 100), (99, 99, 90, 95)])  # stop 92 touched on day 2
    assert t["fill"] == 100 and t["stop"] == pytest.approx(92)
    assert t["reason"] == "stop" and t["exit_price"] == pytest.approx(92)
    buy, sell = trader.costs()
    assert t["net_return"] == pytest.approx(0.92 * (1 - sell) / (1 + buy) - 1)
    assert t["r"] == pytest.approx(t["net_return"] / 0.08)


def test_gap_through_the_stop_exits_at_the_open():
    t = _trade([SIGNAL, (100, 101, 99, 100), (85, 86, 84, 85)])
    assert t["reason"] == "stop_gap" and t["exit_price"] == 85


def test_target_and_both_touched_same_day():
    t = _trade([SIGNAL, (100, 101, 99, 100), (101, 117, 100, 115)])  # target 116 (2R of 8)
    assert t["reason"] == "target" and t["exit_price"] == pytest.approx(116)
    t = _trade([SIGNAL, (100, 101, 99, 100), (101, 117, 91, 100)])  # both: stop assumed first
    assert t["reason"] == "stop"


def test_time_exit_and_data_end():
    flat = [SIGNAL] + [(100, 101, 99, 100)] * 80
    t = _trade(flat)
    assert t["reason"] == "time" and t["sessions"] == 65
    t = _trade([SIGNAL] + [(100, 101, 99, 100)] * 10)
    assert t["reason"] == "data_end" and t["sessions"] == 10


def test_risk_gates_and_stop_rules():
    assert _trade([SIGNAL, (100, 101, 99, 100)], stop_rule="base_low", base_low=80) is None  # 20%
    assert _trade([SIGNAL, (100, 101, 99, 100)], stop_rule="base_low", base_low=101) is None
    t = _trade([SIGNAL, (100, 101, 99, 100)] * 2, stop_rule="atr_1.5", atr=2.0)
    assert t["stop"] == pytest.approx(97)
    assert _trade([SIGNAL]) is None  # no next session


def _portfolio_case():
    dates = pd.bdate_range("2023-01-02", periods=6)
    syms = [f"S{i}" for i in range(12)]
    closes = pd.DataFrame(100.0, index=dates, columns=syms)
    cands = pd.DataFrame(
        {
            "symbol": syms,
            "base_id": [f"{s}|b" for s in syms],
            "score": np.arange(12, dtype=float),  # S11 best
            "date": dates[0],
        }
    )
    trades = pd.DataFrame(
        {
            "entry_date": dates[1],
            "exit_date": dates[4],
            "fill": 100.0,
            "exit_price": 110.0,
        },
        index=cands.index,
    )
    return cands, trades, closes, dates


def test_portfolio_takes_the_best_scores_into_ten_slots():
    cands, trades, closes, dates = _portfolio_case()
    allowed = pd.Series(True, index=cands.index)
    curve, log = trader.run_portfolio(
        cands, trades, closes, allowed=allowed, start=dates[0], end=dates[-1]
    )
    assert sorted(log["symbol"]) == sorted(f"S{i}" for i in range(2, 12))  # S0, S1 left out
    buy, sell = trader.costs()
    # nine full 10% slots; costs leave the tenth a little smaller (all the remaining cash)
    tenth = (1 - 9 * 0.1 * (1 + buy)) / (1 + buy)
    assert curve.iloc[1] == pytest.approx(0.9 + tenth)  # marked at the fill price
    assert curve.iloc[-1] == pytest.approx((0.9 + tenth) * 1.10 * (1 - sell))


def test_portfolio_skips_disallowed_and_traded_bases():
    cands, trades, closes, dates = _portfolio_case()
    allowed = pd.Series(cands["score"] >= 10, index=cands.index)
    _, log = trader.run_portfolio(
        cands, trades, closes, allowed=allowed, start=dates[0], end=dates[-1]
    )
    assert sorted(log["symbol"]) == ["S10", "S11"]


# --- Phases 3-5 ---------------------------------------------------------------------------------

from momentum_backtesting.patterns.bars import split_symbols  # noqa: E402
from momentum_backtesting.patterns.swing import research  # noqa: E402


def test_score_counts_only_trades_that_had_exited():
    days = pd.bdate_range("2015-01-01", periods=80)
    n = 40
    cands = pd.DataFrame(
        {
            "pattern": "flag",
            "entry": "pullback",
            "above_50dma": True,
            "quality": 0.5,
            "date": days[:n],
            "base_id": [f"b{i}" for i in range(n)],
        }
    )
    trades = pd.DataFrame({"r": 1.0, "exit_date": days[:n] + pd.Timedelta(days=10)})
    first = pd.Series(True, index=cands.index)
    third = pd.Series("mid", index=cands.index)
    s = research.scores(cands, trades, first, third)
    # the 39th signal (index 38): exits before it are trades 0..~30 (10 calendar days earlier)
    assert s.iloc[5] == 50.0  # too few finished trades yet
    later = cands.assign(date=days[-1])
    s2 = research.scores(later, trades, first, third)
    assert s2.iloc[0] == 100.0  # all 40 had exited, mean R +1 -> 100


def test_health_switch_compares_to_its_own_past_median():
    days = pd.bdate_range("2015-01-01", periods=300)
    exits = days[::3]
    r = np.where(np.arange(len(exits)) < 70, 1.0, -1.0)  # wins, then a losing streak
    trades = pd.DataFrame({"r": r, "exit_date": exits})
    cands = pd.DataFrame(index=trades.index)
    first = pd.Series(True, index=trades.index)
    h = research.health(cands, trades, first, days)
    assert h.iloc[150] and not h.iloc[-1]


def _long_market():
    rng = np.random.default_rng(11)
    frames = []
    for k in range(5):
        steps = rng.normal(0.0008, 0.02, 3300)
        volume = rng.lognormal(13.8, 0.3, 3300)
        for start in range(300 + k * 17, 3200, 120):
            steps[start : start + 15] = 0.02
            volume[start : start + 15] *= 2
            steps[start + 15 : start + 30] = rng.normal(-0.001, 0.003, 15)
            volume[start + 15 : start + 30] *= 0.5
            steps[start + 30] = 0.05
            volume[start + 30] *= 4
        frames.append(_frame(500 * np.exp(np.cumsum(steps)), symbol=f"S{k}", volume=volume))
    return pd.concat(frames)


def test_stages_a_and_b_run_end_to_end_on_synthetic_data():
    daily = adjust(_long_market(), {})
    cands = candidates.scan(daily, workers=1)
    bars = split_symbols(daily)
    closes = daily.pivot_table(index="date", columns="symbol", values="close")
    outcomes = {
        f"{stop}|{target}": trader.trade_outcomes(cands, bars, stop_rule=stop, target_r=target)
        for stop in ("base_low", "atr_1.5", "pct_8")
        for target in (2.0, 3.0, None)
    }
    a = research.stage_a(cands, outcomes, echo=lambda *_: None)
    assert set(a) == {"tight_range", "flag"}
    assert all(len(v["walk_forward_picks"]) == 9 for v in a.values())
    for v in a.values():
        v["passes"] = True  # exercise stage B whatever stage A said
    b = research.stage_b(cands, outcomes, closes, a, echo=lambda *_: None)
    assert len(b["portfolios"]) == 6 and len(b["walk_forward_picks"]) == 9
    assert all(np.isfinite(c.iloc[-1]) for c in b["curves"].values())
