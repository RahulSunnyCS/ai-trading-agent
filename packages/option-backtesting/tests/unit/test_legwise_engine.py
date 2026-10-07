from datetime import date

import pytest
from pydantic import ValidationError

from option_backtesting.legwise.engine import simulate_day
from option_backtesting.legwise.market import N_MINUTES, DayData, Series, minute_index, pick_expiry
from option_backtesting.legwise.schema import LegwiseStrategy

DAY = date(2026, 9, 28)
EXP = date(2026, 9, 29)
LOT = 65  # NIFTY, from reference/lot_sizes.csv


def bars(
    base: float, overrides: dict[str, tuple[float, float, float, float]] | None = None
) -> Series:
    """Flat `base` all day, with (o, h, l, c) overrides at "HH:MM" minutes."""
    s = Series([base] * N_MINUTES, [base] * N_MINUTES, [base] * N_MINUTES, [base] * N_MINUTES)
    for label, (o, h, lo, c) in (overrides or {}).items():
        m = minute_index(label)
        s.open[m], s.high[m], s.low[m], s.close[m] = o, h, lo, c
    return s


def day(chain: dict[tuple[float, str], Series], spot: float = 22010.0) -> DayData:
    return DayData(
        day=DAY,
        underlying="NIFTY",
        spot=bars(spot),
        chain={(EXP, strike, kind): s for (strike, kind), s in chain.items()},
        listed_expiries=[EXP, date(2026, 10, 6)],
        master_lot_size=LOT,
    )


def strategy(legs: list[dict], **extra) -> LegwiseStrategy:
    return LegwiseStrategy.model_validate(
        {
            "id": "t",
            "underlying": "NIFTY",
            "entry_time": "09:20",
            "exit_time": "15:00",
            "legs": legs,
            **extra,
        }
    )


def sell_leg(**extra) -> dict:
    return {
        "id": "ce",
        "lots": 1,
        "position": "sell",
        "option_type": "CE",
        "strike": {"strike_type": "ATM"},
        **extra,
    }


def test_fixed_time_entry_and_exit_at_open_of_those_minutes():
    data = day(
        {(22000.0, "CE"): bars(100, {"09:20": (101, 103, 99, 102), "15:00": (80, 81, 79, 80)})}
    )
    result = simulate_day(strategy([sell_leg()]), data)
    [t] = result.trades
    assert (t.entry_price, t.exit_price, t.exit_reason) == (101, 80, "EXIT_TIME")
    assert t.pnl == pytest.approx((101 - 80) * LOT)


def test_strike_type_resolves_from_index_open():
    data = day({(22050.0, "CE"): bars(50), (22000.0, "CE"): bars(90)}, spot=22010.0)
    result = simulate_day(strategy([sell_leg(strike={"strike_type": "OTM1"})]), data)
    assert result.trades[0].contract == (EXP, 22050.0, "CE")


def test_percent_sl_fills_at_trigger_or_at_a_gapped_open():
    leg = sell_leg(stop_loss={"percent": 50})
    touched = day({(22000.0, "CE"): bars(100, {"10:00": (120, 160, 118, 150)})})
    [t] = simulate_day(strategy([leg]), touched).trades
    assert (t.exit_price, t.exit_reason) == (150, "SL")
    gapped = day({(22000.0, "CE"): bars(100, {"10:00": (170, 175, 165, 170)})})
    [t] = simulate_day(strategy([leg]), gapped).trades
    assert t.exit_price == 170


def test_trail_sl_moves_y_for_every_full_x_in_favour():
    leg = sell_leg(stop_loss={"percent": 115}, trail_sl={"points": [15, 10]})
    # entry 100 -> SL 215. Low of 69 = 31 in favour = 2 full steps -> SL 195.
    data = day(
        {
            (22000.0, "CE"): bars(
                100,
                {
                    "10:00": (90, 90, 69, 70),
                    "10:01": (70, 72, 70, 71),
                    "11:00": (150, 196, 150, 190),
                },
            )
        }
    )
    [t] = simulate_day(strategy([leg]), data).trades
    assert (t.exit_price, t.exit_reason) == (195, "SL")


def test_closest_premium_breaks_ties_to_the_lower_premium():
    leg = sell_leg(strike={"closest_premium": 50})
    data = day({(22200.0, "CE"): bars(45), (22100.0, "CE"): bars(55), (22000.0, "CE"): bars(90)})
    assert simulate_day(strategy([leg]), data).trades[0].contract[1] == 22200.0


def test_range_breakout_enters_at_the_range_high_after_the_window():
    leg = {
        "id": "pe",
        "lots": 1,
        "position": "buy",
        "option_type": "PE",
        "strike": {"closest_premium": 50},
        "stop_loss": {"percent": 25},
        "range_breakout": {"until": "09:30", "side": "high"},
    }
    data = day(
        {
            (22000.0, "PE"): bars(
                50,
                {
                    "09:25": (50, 58, 49, 55),  # range high 58
                    "09:31": (55, 57, 54, 56),  # inside the range: no entry
                    "09:40": (56, 61, 30, 60),  # breaks 58; its low must not stop it out
                    "15:00": (70, 70, 70, 70),
                },
            )
        }
    )
    [t] = simulate_day(strategy([leg]), data).trades
    assert (t.entry_min, t.entry_price) == (minute_index("09:40"), 58)
    assert (t.exit_price, t.exit_reason) == (70, "EXIT_TIME")


def test_range_breakout_never_triggers_without_a_break():
    leg = {
        "id": "ce",
        "lots": 1,
        "position": "buy",
        "option_type": "CE",
        "strike": {"strike_type": "ATM"},
        "range_breakout": {"until": "09:30", "side": "high"},
    }
    assert simulate_day(strategy([leg]), day({(22000.0, "CE"): bars(50)})).trades == []


def test_re_cost_re_enters_same_contract_at_entry_price_once():
    leg = sell_leg(stop_loss={"percent": 20}, reentry_on_sl={"mode": "cost", "count": 1})
    ce = bars(100, {"10:00": (110, 125, 110, 124)})  # SL at 120
    for m in range(minute_index("10:01"), minute_index("10:30")):
        ce.open[m] = ce.high[m] = ce.low[m] = ce.close[m] = 115  # above cost: no re-entry yet
    ce.open[minute_index("10:30")], ce.low[minute_index("10:30")] = 105, 98  # back to 100
    ce.high[minute_index("10:30")], ce.close[minute_index("10:30")] = 105, 99
    ce.high[minute_index("11:00")] = 130  # SL again; count used up, so no third trade
    trades = simulate_day(strategy([leg]), day({(22000.0, "CE"): ce})).trades
    assert [(t.entry_min, t.entry_price, t.exit_price, t.exit_reason) for t in trades] == [
        (minute_index("09:20"), 100, 120, "SL"),
        (minute_index("10:30"), 100, 120, "SL"),
    ]


def test_overall_sl_counts_realised_and_open_pnl_and_closes_everything():
    legs = [
        sell_leg(stop_loss={"points": 20}),
        sell_leg(id="pe", option_type="PE"),
    ]
    data = day(
        {
            (22000.0, "CE"): bars(
                100, {"10:00": (100, 125, 100, 120)}
            ),  # SL at 120: -20*65 = -1300
            (22000.0, "PE"): bars(100, {"10:05": (100, 125, 100, 118)}),  # open -18*65 = -1170
        }
    )
    result = simulate_day(strategy(legs, overall={"stop_loss_inr": 2400}), data)
    assert result.stopped_by == "overall SL at 10:05"
    assert [t.exit_reason for t in result.trades] == ["SL", "OVERALL_SL"]
    assert result.gross == pytest.approx(-2470)


def test_square_off_complete_exits_other_legs_on_any_sl():
    legs = [sell_leg(stop_loss={"points": 20}), sell_leg(id="pe", option_type="PE")]
    data = day(
        {
            (22000.0, "CE"): bars(100, {"10:00": (100, 125, 100, 120)}),
            (22000.0, "PE"): bars(100, {"10:00": (100, 100, 90, 92)}),
        }
    )
    result = simulate_day(strategy(legs, square_off="complete"), data)
    assert [(t.exit_reason, t.exit_price) for t in result.trades] == [
        ("SL", 120),
        ("SQUARE_OFF", 92),
    ]


def test_pick_expiry_weekly_next_and_monthly():
    data = day({})
    data.listed_expiries = [EXP, date(2026, 10, 6), date(2026, 10, 13), date(2026, 10, 27)]
    assert pick_expiry(data, "weekly") == EXP
    assert pick_expiry(data, "next_weekly") == date(2026, 10, 6)
    assert pick_expiry(data, "monthly") == EXP  # last listed expiry of September


def test_schema_rejects_unsupported_or_inconsistent_settings():
    with pytest.raises(ValidationError):
        strategy([sell_leg(simple_momentum={"points": 10})])
    with pytest.raises(ValidationError):
        strategy([sell_leg(trail_sl={"points": [15, 10]})])  # trail without SL
    with pytest.raises(ValidationError):
        strategy([sell_leg(range_breakout={"until": "09:30", "side": "high", "on": "instrument"})])


def test_lot_size_follows_each_legs_expiry_not_the_trading_day():
    """15 Jan 2025, after the 20 Nov 2024 revision: the 16 Jan weekly was listed at 75, but
    the 30 Jan monthly was listed earlier and keeps 25 until it expires."""
    weekly, monthly = date(2025, 1, 16), date(2025, 1, 30)
    data = DayData(
        day=date(2025, 1, 15),
        underlying="NIFTY",
        spot=bars(23000.0),
        chain={
            (weekly, 23000.0, "CE"): bars(100),
            (monthly, 23000.0, "CE"): bars(200),
        },
        listed_expiries=[weekly, date(2025, 1, 23), monthly],
        master_lot_size=None,
    )
    legs = [
        sell_leg(id="weekly_ce", expiry="weekly"),
        sell_leg(id="monthly_ce", expiry="monthly"),
    ]
    result = simulate_day(strategy(legs), data)
    qty = {t.leg_id: t.qty for t in result.trades}
    assert qty == {"weekly_ce": 75, "monthly_ce": 25}
