"""BL-043: daily candidates (Phase 1)."""

from __future__ import annotations

import numpy as np
import pandas as pd

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
