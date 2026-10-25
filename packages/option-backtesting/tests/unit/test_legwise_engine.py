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


def test_fixed_time_entry_and_exit_at_the_close_of_the_bar_ending_then():
    """09:20 is the close of the 09:19 bar, as AlgoTest reads it (BL-009 Phase 1)."""
    data = day(
        {(22000.0, "CE"): bars(100, {"09:19": (99, 103, 98, 101), "14:59": (81, 81, 79, 80)})}
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
                    "14:59": (70, 70, 70, 70),  # the exit at 15:00 is this bar's close
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


def _breakout_leg(side: str = "high", **range_extra) -> dict:
    return {
        "id": "pe",
        "lots": 1,
        "position": "buy",
        "option_type": "PE",
        "strike": {"strike_type": "ATM"},
        "range_breakout": {"until": "09:30", "side": side, **range_extra},
    }


def _breakout_day(overrides: dict[str, tuple[float, float, float, float]]) -> DayData:
    """Range 09:20-09:30 is high 58 / low 49 (the 09:25 bar); flat 50 around it."""
    return day({(22000.0, "PE"): bars(50, {"09:25": (50, 58, 49, 55), **overrides})})


def test_range_breakout_gap_percent_widens_the_trigger_on_the_high_side():
    # 5% above the range high 58 is 60.9: a high of 60 is not a trigger, 61 is, filled at 60.9.
    leg = _breakout_leg("high", gap_percent=5)
    short = _breakout_day({"09:40": (56, 60, 55, 59)})
    assert simulate_day(strategy([leg]), short).trades == []
    long = _breakout_day({"09:40": (56, 61, 55, 60), "14:59": (70, 70, 70, 70)})
    [t] = simulate_day(strategy([leg]), long).trades
    assert t.entry_min == minute_index("09:40")
    assert t.entry_price == 60.9  # 60.9000000000000x, rounded to the 0.05 tick
    # a bar that gaps open above the widened level fills at its open
    gapped = _breakout_day({"09:40": (63, 64, 62, 63)})
    [g] = simulate_day(strategy([leg]), gapped).trades
    assert g.entry_price == 63


def test_range_breakout_gap_percent_widens_the_trigger_on_the_low_side():
    # 5% below the range low 49 is 46.55: a low of 47 is not a trigger, 46 is, filled at 46.55.
    leg = _breakout_leg("low", gap_percent=5)
    short = _breakout_day({"09:40": (48, 49, 47, 48)})
    assert simulate_day(strategy([leg]), short).trades == []
    long = _breakout_day({"09:40": (48, 49, 46, 47), "14:59": (40, 40, 40, 40)})
    [t] = simulate_day(strategy([leg]), long).trades
    assert t.entry_min == minute_index("09:40")
    assert t.entry_price == 46.55
    gapped = _breakout_day({"09:40": (44, 45, 43, 44)})
    [g] = simulate_day(strategy([leg]), gapped).trades
    assert g.entry_price == 44


def test_range_breakout_valid_until_ends_the_armed_state():
    leg = _breakout_leg("high", valid_until="10:00")
    # the valid_until minute itself is still armed
    on_time = _breakout_day({"10:00": (56, 61, 55, 60), "14:59": (70, 70, 70, 70)})
    [t] = simulate_day(strategy([leg]), on_time).trades
    assert (t.entry_min, t.entry_price) == (minute_index("10:00"), 58)
    # one minute later the leg has expired without entering, however far it then breaks
    late = _breakout_day({"10:01": (56, 61, 55, 60), "11:00": (80, 90, 80, 85)})
    result = simulate_day(strategy([leg]), late)
    assert result.trades == []
    assert any("breakout window closed at 10:00" in n for n in result.notes)
    # without valid_until the same late break does enter
    [t] = simulate_day(strategy([_breakout_leg("high")]), late).trades
    assert t.entry_min == minute_index("10:01")


def test_range_breakout_without_gap_or_valid_until_is_unchanged():
    overrides = {"09:40": (56, 61, 30, 60), "14:59": (70, 70, 70, 70)}
    plain = simulate_day(strategy([_breakout_leg("high")]), _breakout_day(overrides))
    explicit = simulate_day(
        strategy([_breakout_leg("high", gap_percent=0, valid_until=None)]),
        _breakout_day(overrides),
    )
    assert plain.trades == explicit.trades and plain.gross == explicit.gross
    assert [(t.entry_min, t.entry_price) for t in plain.trades] == [(minute_index("09:40"), 58)]
    rb = strategy([_breakout_leg("high")]).legs[0].range_breakout
    assert rb.gap_percent == 0 and rb.valid_until is None
    # defaults stay out of the dump, so `store.spec_hash` (and every saved result version and
    # frozen golden hash) of an existing range-breakout strategy does not move
    assert set(rb.model_dump(mode="json")) == {"until", "side", "source"}
    tuned = strategy([_breakout_leg("high", gap_percent=2, valid_until="10:00")])
    assert tuned.legs[0].range_breakout.model_dump(mode="json")["gap_percent"] == 2
    assert tuned.legs[0].range_breakout.model_dump(mode="json")["valid_until"] == "10:00"


def test_range_breakout_schema_validates_gap_and_valid_until():
    with pytest.raises(ValidationError):
        strategy([_breakout_leg(gap_percent=-1)])
    with pytest.raises(ValidationError):
        strategy([_breakout_leg(gap_percent=100)])  # a low trigger would be at or below zero
    with pytest.raises(ValidationError):
        strategy([_breakout_leg(gap_percent=float("inf"))])
    with pytest.raises(ValidationError):
        strategy([_breakout_leg(valid_until="9am")])
    with pytest.raises(ValidationError, match="valid_until"):
        strategy([_breakout_leg(valid_until="09:30")])  # not after until
    with pytest.raises(ValidationError, match="valid_until"):
        strategy([_breakout_leg(valid_until="09:25")])  # before until
    with pytest.raises(ValidationError, match="valid_until"):
        strategy([_breakout_leg(valid_until="15:01")])  # after exit (15:00)
    assert strategy([_breakout_leg(valid_until="15:00")])  # exactly at exit is fine


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
    the 30 Jan monthly was listed earlier and keeps 25 until it expires (historical sizing)."""
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
    historical = strategy(legs, execution={"lot_sizing": "historical"})
    result = simulate_day(historical, data)
    qty = {t.leg_id: t.qty for t in result.trades}
    assert qty == {"weekly_ce": 75, "monthly_ce": 25}
    # the default, "current" (owner's choice, like AlgoTest): today's lot on every leg
    result = simulate_day(strategy(legs), data, sizing_date=date(2026, 10, 7))
    assert {t.leg_id: t.qty for t in result.trades} == {"weekly_ce": 65, "monthly_ce": 65}


# --- BL-164: the peak trail and stops judged on the close ------------------------------------


def buy_leg(**extra) -> dict:
    return {**sell_leg(**extra), "position": "buy"}


PEAK = {"activate_percent": 105, "exit_percent": 80}


def test_peak_trail_arms_above_its_level_and_exits_at_a_share_of_the_peak():
    # entry 100; the 10:00 high of 110 arms it (after that bar's checks): level 88
    data = day(
        {(22000.0, "CE"): bars(100, {"10:00": (100, 110, 100, 108), "10:01": (108, 108, 87, 90)})}
    )
    [t] = simulate_day(strategy([buy_leg(trail_peak=PEAK)]), data).trades
    assert (t.exit_price, t.exit_reason) == (88, "TRAIL")
    assert t.exit_min == minute_index("10:01")


def test_peak_trail_stays_off_until_the_premium_has_been_above_the_activation():
    leg = buy_leg(trail_peak=PEAK, stop_loss={"percent": 30})
    data = day(
        {(22000.0, "CE"): bars(100, {"10:00": (100, 104, 100, 103), "10:01": (103, 103, 65, 68)})}
    )
    [t] = simulate_day(strategy([leg]), data).trades
    assert (t.exit_price, t.exit_reason) == (70, "SL")


def test_peak_trail_and_sl_on_one_bar_exit_at_the_higher_level_or_a_gapped_open():
    leg = buy_leg(trail_peak=PEAK, stop_loss={"percent": 30})
    both = day(
        {(22000.0, "CE"): bars(100, {"10:00": (100, 110, 100, 108), "10:01": (90, 90, 60, 62)})}
    )
    [t] = simulate_day(strategy([leg]), both).trades
    assert (t.exit_price, t.exit_reason) == (88, "TRAIL")
    gapped = day(
        {(22000.0, "CE"): bars(100, {"10:00": (100, 110, 100, 108), "10:01": (80, 80, 60, 62)})}
    )
    [t] = simulate_day(strategy([leg]), gapped).trades
    assert (t.exit_price, t.exit_reason) == (80, "TRAIL")


def test_stop_on_close_ignores_an_intrabar_spike_and_fills_at_the_close():
    leg = buy_leg(stop_loss={"percent": 30}, stop_on="close")
    data = day(
        {(22000.0, "CE"): bars(100, {"10:00": (100, 100, 60, 75), "10:01": (75, 75, 68, 69)})}
    )
    [t] = simulate_day(strategy([leg]), data).trades
    assert (t.exit_price, t.exit_reason) == (69, "SL")
    assert t.exit_min == minute_index("10:01")


def test_stop_on_close_tracks_the_peak_from_closes():
    leg = buy_leg(trail_peak=PEAK, stop_on="close")
    # the 10:00 high of 130 is ignored: the peak is the 110 close, so the level is 88
    data = day(
        {
            (22000.0, "CE"): bars(
                100,
                {
                    "10:00": (100, 130, 100, 110),
                    "10:01": (110, 110, 85, 89),
                    "10:02": (89, 89, 86, 87),
                },
            )
        }
    )
    [t] = simulate_day(strategy([leg]), data).trades
    assert (t.exit_price, t.exit_reason) == (87, "TRAIL")
    assert t.exit_min == minute_index("10:02")


def test_stop_on_close_applies_to_a_sold_legs_stop_and_target():
    leg = sell_leg(stop_loss={"percent": 50}, target={"percent": 40}, stop_on="close")
    spike = day(
        {(22000.0, "CE"): bars(100, {"10:00": (100, 170, 100, 140), "10:01": (140, 140, 55, 58)})}
    )
    [t] = simulate_day(strategy([leg]), spike).trades
    assert (t.exit_price, t.exit_reason) == (58, "TARGET")


def test_peak_trail_and_stop_on_validate_and_stay_out_of_the_dump_when_unset():
    with pytest.raises(ValidationError, match="bought legs"):
        strategy([sell_leg(trail_peak=PEAK)])
    with pytest.raises(ValidationError):
        strategy([buy_leg(trail_peak={"activate_percent": 100, "exit_percent": 80})])
    with pytest.raises(ValidationError):
        strategy([buy_leg(stop_on="bar")])
    plain = strategy([sell_leg(stop_loss={"percent": 50})]).model_dump()["legs"][0]
    assert "trail_peak" not in plain and "stop_on" not in plain
    set_ = strategy([buy_leg(trail_peak=PEAK, stop_on="close")]).model_dump()["legs"][0]
    assert set_["stop_on"] == "close" and set_["trail_peak"] == PEAK
