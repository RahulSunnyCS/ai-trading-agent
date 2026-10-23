"""BL-156 checks of the tick model on a synthetic two-leg short straddle (Phase 0's unit test), plus
the 23 Oct calibration when the lake is mounted.

    uv run python -m pytest research/bl156/test_rules.py
"""

from __future__ import annotations

import sys
from datetime import date
from pathlib import Path
from types import SimpleNamespace

import pytest

sys.path.insert(0, str(Path(__file__).parent))
import rules as R  # noqa: E402

N = 6  # minutes in the synthetic window


def _leg(kind: str, entry: float, o, h, lo, c):
    series = SimpleNamespace(open=o, high=h, low=lo, close=c)
    return SimpleNamespace(
        state="open",
        series=series,
        contract=(None, 0.0, kind),
        spec=SimpleNamespace(position="sell"),
        sign=-1,
        entry_price=entry,
        qty=65,
        trade=SimpleNamespace(entry_min=0),
    )


def _sim(rule: str, legs) -> R.RuleSim:
    sim = object.__new__(R.RuleSim)
    sim.rule, sim.overshoot, sim.realised, sim.legs = rule, 0.02, 0.0, legs
    return sim


def _straddle(ce_high_at3: float, pe_low_at3: float, ce_open_at3: float = 110.0):
    flat = [100.0] * N
    ce_h = list(flat)
    ce_h[3] = ce_high_at3
    pe_lo = list(flat)
    pe_lo[3] = pe_low_at3
    ce_o = list(flat)
    ce_o[3] = ce_open_at3
    ce = _leg("CE", 100.0, ce_o, ce_h, flat, flat)
    pe = _leg("PE", 100.0, flat, flat, pe_lo, flat)
    return [ce, pe]


def test_tick_fires_on_the_index_driven_high_and_not_before():
    # minute 3: CE high 150, PE low 60 -> -(50 - 40) * 65 = -650 (no); CE 150, PE low 90 -> -2,600 (yes)
    sim = _sim("tick", _straddle(150.0, 90.0))
    assert sim._tick_fire(2, 0, 2500) is None
    assert sim._tick_fire(3, 0, 2500) == pytest.approx(-2550.0)
    assert _sim("tick", _straddle(150.0, 60.0))._tick_fire(3, 0, 2500) is None


def test_pessimistic_counts_both_highs_together():
    legs = _straddle(130.0, 100.0)
    legs[1].series.high = [100.0] * 3 + [125.0] + [100.0] * 2  # PE high in the same minute
    assert _sim("tick", legs)._tick_fire(3, 0, 2500) is None  # index-driven: CE up, PE down
    assert _sim("tick_pess", legs)._tick_fire(3, 0, 2500) is not None  # both legs high: -3,575


def test_gap_through_the_stop_exits_at_the_open():
    sim = _sim("tick", _straddle(160.0, 100.0, ce_open_at3=150.0))
    assert sim._tick_fire(3, 0, 2500) == pytest.approx(
        -50 * 65
    )  # open MTM -3,250, worse than -2,550


def test_only_the_decided_minute_is_read():
    a = _sim("tick", _straddle(150.0, 90.0))
    b = _sim("tick", _straddle(150.0, 90.0))
    for leg in b.legs:  # every later minute changed
        for k in ("open", "high", "low", "close"):
            getattr(leg.series, k)[4:] = [999.0, 999.0]
    assert a._tick_fire(3, 0, 2500) == b._tick_fire(3, 0, 2500)


LAKE = Path("/Volumes/TradingData/lake")


@pytest.mark.skipif(not LAKE.exists(), reason="the lake is not mounted")
def test_calibration_23_oct():
    from option_backtesting.data.reference.loader import default_reference_data
    from option_backtesting.fyers.daily import data_dir
    from option_backtesting.legwise.market import load_day
    from option_backtesting.legwise.schema import load_legwise
    from option_backtesting.rotation.lists import SIZING_DATE

    here = Path(__file__).resolve().parents[2]
    s = load_legwise(here / "strategies" / "rotation" / "N_p100_1217.yaml")
    d = load_day(data_dir(), "NIFTY", date(2026, 10, 23))
    ref, sizing = default_reference_data(), date.fromisoformat(SIZING_DATE)
    close = R.simulate(s, d, ref, sizing, "close")
    tick = R.simulate(s, d, ref, sizing, "tick")
    assert close.stopped_by is None and round(close.gross) == 1053
    assert tick.stopped_by == "overall SL (tick) at 13:45" and round(tick.gross) == -2550
