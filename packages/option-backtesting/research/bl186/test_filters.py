"""BL-186 look-ahead check (Phase 0): every filter decision at a stop minute reads only bars that end
before it. A day is fed again with a shock from the stop minute on (index, option prices and volume
all changed); every decision must stay the same.

    uv run python -m pytest research/bl186/test_filters.py
"""

from __future__ import annotations

import copy
import sys
from datetime import date
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).parent))
import sar  # noqa: E402

from option_backtesting.data.reference.loader import default_reference_data
from option_backtesting.legwise.market import N_MINUTES, DayData, Series, minute_index
from option_backtesting.legwise.schema import LegwiseStrategy

DAY, EXP = date(2026, 9, 28), date(2026, 9, 29)


def _series(values: list[float]) -> Series:
    return Series(list(values), [v + 2 for v in values], [v - 2 for v in values], list(values))


def make_day(trend: float = 2.0) -> tuple[DayData, dict]:
    """The index climbs `trend` points a minute from 22000; the calls rise with it, puts fall."""
    spot = [22000 + trend * m for m in range(N_MINUTES)]
    chain = {}
    for k in (21900.0, 22000.0, 22100.0, 22200.0):
        chain[(EXP, k, "CE")] = _series([max(5.0, 100 + (s - k) * 0.5) for s in spot])
        chain[(EXP, k, "PE")] = _series([max(5.0, 100 - (s - k) * 0.5) for s in spot])
    data = DayData(
        day=DAY,
        underlying="NIFTY",
        spot=_series(spot),
        chain=chain,
        listed_expiries=[EXP],
        master_lot_size=65,
    )
    volume = {EXP: np.linspace(1000, 5000, N_MINUTES)}
    return data, volume


def shocked(data: DayData, volume: dict, m: int) -> tuple[DayData, dict]:
    """The same day with everything from bar m on replaced by a reversal shock."""
    d, v = copy.deepcopy(data), copy.deepcopy(volume)
    for s in [d.spot, *d.chain.values()]:
        for i in range(m, N_MINUTES):
            base = s.close[m - 1] * (0.7 if s is d.spot else 3.0)
            s.open[i], s.high[i], s.low[i], s.close[i] = base, base * 1.2, base * 0.5, base
    for arr in v.values():
        arr[m:] = 1e9
    return d, v


@pytest.mark.parametrize("filt", ["C1", "C2", "C2twap", "C3"])
@pytest.mark.parametrize("m", [3, 14, 16, 20, 21, 47, 120, 300])
@pytest.mark.parametrize("kind", ["CE", "PE"])
def test_a_later_shock_never_changes_a_decision(filt, m, kind):
    data, volume = make_day()
    entry = 2
    before = sar.DayFeatures(data, volume).allow(filt, kind, m, entry, EXP)
    d2, v2 = shocked(data, volume, m)
    after = sar.DayFeatures(d2, v2).allow(filt, kind, m, entry, EXP)
    assert before == after


def test_the_filters_see_the_trend_once_their_inputs_have_closed():
    data, volume = make_day()
    f = sar.DayFeatures(data, volume)
    # the opening range closes with the 09:29 bar; the first 5-minute bar after it ends at 09:34
    assert not f.or_break(True, minute_index("09:34"))
    assert f.or_break(True, minute_index("09:35"))
    assert not f.or_break(False, minute_index("09:35"))
    assert f.vwap_side(True, 30, EXP) and not f.vwap_side(False, 30, EXP)
    assert f.iv_rising(60, 2, EXP) in (True, False)  # solvable at both ends
    assert not np.isnan(f.atm_iv(EXP, 59))


def test_filter_sim_decisions_ignore_bars_after_the_stop():
    """End to end: a sold CE stops on the rising index; the shocked copy (from the stop minute's
    next bar on) gives the same decision at the same minute."""
    s = LegwiseStrategy.model_validate(
        {
            "id": "t",
            "underlying": "NIFTY",
            "entry_time": "09:20",
            "exit_time": "15:00",
            "legs": [
                {
                    "id": "ce",
                    "lots": 1,
                    "position": "sell",
                    "option_type": "CE",
                    "strike": {"strike_type": "ATM"},
                    "stop_loss": {"percent": 21},
                    "reverse_on_sl": {"time_stop_minutes": 30},
                }
            ],
        }
    )
    data, volume = make_day()
    ref = default_reference_data()
    for filt in ("C1", "C2", "C3"):
        sim = sar.FilterSim(s, data, ref, DAY, filt=filt, feats=sar.DayFeatures(data, volume))
        sim.run()
        [(leg, m, ok)] = sim.decisions
        d2, v2 = shocked(data, volume, m + 1)
        sim2 = sar.FilterSim(s, d2, ref, DAY, filt=filt, feats=sar.DayFeatures(d2, v2))
        sim2.run()
        assert sim2.decisions[0] == (leg, m, ok)
