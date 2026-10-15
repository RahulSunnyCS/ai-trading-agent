"""BL-105: roll the exhausted leg. A sold leg whose premium falls to `decay` x its entry is closed at
that bar's close and re-enters at the next minute's open (strike re-selected, optional fresh stop)."""

from datetime import date

import pytest
from pydantic import ValidationError

from option_backtesting.legwise.engine import simulate_day
from option_backtesting.legwise.market import N_MINUTES, DayData, Series, minute_index
from option_backtesting.legwise.schema import LegwiseStrategy

DAY = date(2026, 9, 28)
EXP = date(2026, 9, 29)
LOT = 65


def bars(base, overrides=None):
    s = Series([base] * N_MINUTES, [base] * N_MINUTES, [base] * N_MINUTES, [base] * N_MINUTES)
    for label, (o, h, lo, c) in (overrides or {}).items():
        m = minute_index(label)
        s.open[m], s.high[m], s.low[m], s.close[m] = o, h, lo, c
    return s


def day(chain, spot):
    return DayData(
        day=DAY,
        underlying="NIFTY",
        spot=spot,
        chain={(EXP, strike, kind): s for (strike, kind), s in chain.items()},
        listed_expiries=[EXP, date(2026, 10, 6)],
        master_lot_size=LOT,
    )


def strat(leg_extra, **extra):
    leg = {
        "id": "ce",
        "lots": 1,
        "position": "sell",
        "option_type": "CE",
        "strike": {"strike_type": "ATM"},
        "stop_loss": {"percent": 50},
        **leg_extra,
    }
    return LegwiseStrategy.model_validate(
        {
            "id": "t",
            "underlying": "NIFTY",
            "entry_time": "09:20",
            "exit_time": "15:00",
            "legs": [leg],
            **extra,
        }
    )


# spot is 22010 until the 10:00 bar closes at 22110, so a re-selected ATM moves 22000 -> 22100
SPOT = bars(22010, {"10:00": (22010, 22120, 22005, 22110)})
DECAYED = bars(100, {"10:00": (30, 31, 18, 20)})  # closes at 20: 20% of the 100 entry


def test_decayed_leg_is_rolled_to_the_new_atm_at_the_next_open():
    data = day({(22000.0, "CE"): DECAYED, (22100.0, "CE"): bars(80)}, SPOT)
    result = simulate_day(strat({"roll": {"decay": 0.25}}), data)
    first, second = result.trades
    assert (first.exit_reason, first.exit_price, first.exit_min) == (
        "ROLL",
        20,
        minute_index("10:00"),
    )
    assert first.pnl == pytest.approx((100 - 20) * LOT)
    assert second.contract == (EXP, 22100.0, "CE")
    assert (second.entry_min, second.entry_price) == (minute_index("10:01"), 80)
    assert second.exit_reason == "EXIT_TIME"


def test_no_roll_without_the_field_and_above_the_decay_level():
    data = day({(22000.0, "CE"): DECAYED, (22100.0, "CE"): bars(80)}, SPOT)
    assert len(simulate_day(strat({}), data).trades) == 1
    assert len(simulate_day(strat({"roll": {"decay": 0.15}}), data).trades) == 1  # 20 > 15


def test_roll_to_atm_from_an_otm_leg_and_own_strike_otherwise():
    chain = {(22050.0, "CE"): DECAYED, (22100.0, "CE"): bars(80), (22150.0, "CE"): bars(60)}
    otm = {"strike": {"strike_type": "OTM1"}}
    own = simulate_day(strat({**otm, "roll": {"decay": 0.25}}), day(chain, SPOT))
    atm = simulate_day(strat({**otm, "roll": {"decay": 0.25, "to_atm": True}}), day(chain, SPOT))
    assert own.trades[1].contract[1] == 22150.0  # OTM1 of the new spot
    assert atm.trades[1].contract[1] == 22100.0


def test_day_profit_gate_not_after_and_max_rolls():
    data = day({(22000.0, "CE"): DECAYED, (22100.0, "CE"): bars(80)}, SPOT)
    profit = (100 - 20) * LOT  # 5,200
    assert (
        len(simulate_day(strat({"roll": {"decay": 0.25, "min_day_profit": 3000}}), data).trades)
        == 2
    )
    assert profit > 3000
    assert (
        len(simulate_day(strat({"roll": {"decay": 0.25, "min_day_profit": 6000}}), data).trades)
        == 1
    )
    late = day(
        {(22000.0, "CE"): bars(100, {"14:00": (30, 31, 18, 20)}), (22100.0, "CE"): bars(80)}, SPOT
    )
    assert (
        len(simulate_day(strat({"roll": {"decay": 0.25, "not_after": "13:30"}}), late).trades) == 1
    )
    # the rolled leg decays again: only max_rolls (default 1) rolls happen
    twice = day(
        {(22000.0, "CE"): DECAYED, (22100.0, "CE"): bars(80, {"11:00": (30, 31, 15, 16)})}, SPOT
    )
    assert len(simulate_day(strat({"roll": {"decay": 0.25}}), twice).trades) == 2
    assert len(simulate_day(strat({"roll": {"decay": 0.25, "max_rolls": 2}}), twice).trades) == 3


def test_rolled_leg_takes_its_fresh_stop():
    new = bars(80, {"11:00": (80, 110, 79, 100)})  # 30 % stop on 80 = 104; the high reaches 110
    data = day({(22000.0, "CE"): DECAYED, (22100.0, "CE"): new}, SPOT)
    plain = simulate_day(strat({"roll": {"decay": 0.25}}), data).trades[1]  # inherits the 50 % stop
    fresh = simulate_day(strat({"roll": {"decay": 0.25, "stop_loss_percent": 30}}), data).trades[1]
    assert plain.exit_reason == "EXIT_TIME"  # 110 < 120: 50 % stop not touched
    assert (fresh.exit_reason, fresh.exit_price) == ("SL", 104)


def test_schema_rejects_roll_on_a_bought_leg_and_omits_it_from_the_dump_when_unset():
    with pytest.raises(ValidationError):
        strat({"position": "buy", "roll": {"decay": 0.25}})
    assert "roll" not in strat({}).model_dump()["legs"][0]
    assert strat({"roll": {"decay": 0.25}}).model_dump()["legs"][0]["roll"] == {"decay": 0.25}
