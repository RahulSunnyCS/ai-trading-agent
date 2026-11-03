from datetime import date

import pytest
from pydantic import ValidationError

from option_backtesting.legwise.engine import simulate_day, to_tick
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


def test_a_trail_exit_squares_off_complete_and_arms_reentry_on_sl():
    trail = day(
        {
            (22000.0, "CE"): bars(
                100, {"10:00": (100, 110, 100, 108), "10:01": (108, 108, 87, 90)}
            ),
            (22000.0, "PE"): bars(100, {"10:01": (100, 100, 99, 95)}),
        }
    )
    pe = {**buy_leg(), "id": "pe", "option_type": "PE"}
    legs = [buy_leg(trail_peak=PEAK), pe]
    done = simulate_day(strategy(legs, square_off="complete"), trail)
    by_leg = {t.leg_id: t for t in done.trades}
    assert by_leg["ce"].exit_reason == "TRAIL"
    assert (by_leg["pe"].exit_reason, by_leg["pe"].exit_min) == (
        "SQUARE_OFF",
        minute_index("10:01"),
    )
    again = buy_leg(
        trail_peak=PEAK, stop_loss={"percent": 30}, reentry_on_sl={"mode": "asap", "count": 1}
    )
    trades = simulate_day(strategy([again]), trail).trades
    assert [t.exit_reason for t in trades] == ["TRAIL", "EXIT_TIME"]


def test_stop_on_close_judges_an_intrabar_entry_s_own_bar():
    leg = buy_leg(
        stop_loss={"percent": 30},
        stop_on="close",
        range_breakout={"until": "09:30", "side": "high", "source": "instrument"},
    )
    # range high 100 (flat); the 10:00 bar breaks it (fill 100) and closes at 60, below the 70 stop
    data = day({(22000.0, "CE"): bars(100, {"10:00": (100, 105, 55, 60)})})
    [t] = simulate_day(strategy([leg]), data).trades
    assert (t.entry_min, t.exit_min, t.exit_price, t.exit_reason) == (
        minute_index("10:00"),
        minute_index("10:00"),
        60,
        "SL",
    )


def test_stop_on_close_names_the_higher_level_when_both_are_crossed():
    leg = buy_leg(trail_peak=PEAK, stop_loss={"percent": 30}, stop_on="close")
    data = day(
        {(22000.0, "CE"): bars(100, {"10:00": (100, 110, 100, 110), "10:01": (100, 100, 60, 65)})}
    )
    [t] = simulate_day(strategy([leg]), data).trades
    assert (t.exit_price, t.exit_reason) == (65, "TRAIL")


# --- BL-186: stop-and-reverse on a sold leg's stop -------------------------------------------


def rising(base: float, overrides: dict, after: str, level: float) -> Series:
    """`bars(base, overrides)`, then flat at `level` from the minute after `after`."""
    s = bars(base, overrides)
    for m in range(minute_index(after) + 1, N_MINUTES):
        s.open[m] = s.high[m] = s.low[m] = s.close[m] = level
    return s


def sar_leg(**rev) -> dict:
    return sell_leg(
        stop_loss={"percent": 21},
        reentry_on_sl={"mode": "cost", "count": 1},
        reverse_on_sl=rev,
    )


STOP_BAR = {"10:00": (100, 125, 100, 124)}  # entry 100, SL 121 touched intrabar


def test_reverse_on_sl_buys_the_stopped_contract_at_the_stop_on_a_trend_day():
    data = day({(22000.0, "CE"): rising(100, STOP_BAR, "10:00", 180)})
    result = simulate_day(strategy([sar_leg()]), data)
    short, long = result.trades
    assert (short.position, short.exit_price, short.exit_reason) == ("sell", 121, "SL")
    assert (long.leg_id, long.position, long.contract) == ("ce_rev", "buy", short.contract)
    assert (long.entry_min, long.entry_price, long.qty) == (minute_index("10:00"), 121, LOT)
    assert (long.exit_price, long.exit_reason) == (180, "EXIT_TIME")
    assert result.gross == pytest.approx((100 - 121) * LOT + (180 - 121) * LOT)


def test_reverse_on_sl_whipsaw_hits_the_longs_own_30pct_stop_and_is_not_re_sold():
    # back through the 100 entry (RE COST would re-sell there), down to 80: the long's 30% stop
    whip = {**STOP_BAR, "10:30": (100, 100, 80, 82)}
    data = day({(22000.0, "CE"): rising(110, whip, "10:30", 82)})
    data.chain[(EXP, 22000.0, "CE")].close[minute_index("09:19")] = 100  # entry at 100
    trades = simulate_day(strategy([sar_leg()]), data).trades
    assert [(t.leg_id, t.exit_price, t.exit_reason) for t in trades] == [
        ("ce", 121, "SL"),
        ("ce_rev", to_tick(121 * 0.7), "SL"),
    ]
    # the same day without the option: RE COST re-sells at 100 instead
    plain = sell_leg(stop_loss={"percent": 21}, reentry_on_sl={"mode": "cost", "count": 1})
    assert [t.entry_price for t in simulate_day(strategy([plain]), data).trades] == [100, 100]


def test_reverse_on_sl_long_counts_in_the_overall_stop():
    # short -21 x 65 = -1365 realised; long from 121 to a 110 close = -715 open: -2080 <= -2000
    ce = rising(100, STOP_BAR, "10:00", 118)  # the long holds 118 (-195 open) until 10:05
    ce.open[minute_index("10:05")], ce.high[minute_index("10:05")] = 118, 118
    ce.low[minute_index("10:05")], ce.close[minute_index("10:05")] = 109, 110
    data = day({(22000.0, "CE"): ce})
    result = simulate_day(strategy([sar_leg()], overall={"stop_loss_inr": 2000}), data)
    assert result.stopped_by == "overall SL at 10:05"
    assert [(t.leg_id, t.exit_reason, t.exit_price) for t in result.trades] == [
        ("ce", "SL", 121),
        ("ce_rev", "OVERALL_SL", 110),
    ]
    assert result.gross == pytest.approx(-2080)


def test_reverse_on_sl_time_stop_exits_at_the_price_n_minutes_after_the_buy():
    data = day({(22000.0, "CE"): rising(100, STOP_BAR, "10:00", 150)})
    _, long = simulate_day(strategy([sar_leg(time_stop_minutes=30)]), data).trades
    assert (long.exit_min, long.exit_price, long.exit_reason) == (
        minute_index("10:30"),
        150,
        "TIME",
    )


def test_reverse_on_sl_trail_half_size_and_a_gapped_stop():
    # gap: the stop fills at the 130 open; the long buys there and its own bar is judged
    gap = {
        "10:00": (130, 135, 128, 132),
        "10:10": (170, 210, 170, 200),
        "10:11": (200, 200, 150, 155),
    }
    data = day({(22000.0, "CE"): rising(100, gap, "10:11", 155)})
    for m in range(minute_index("10:01"), minute_index("10:10")):
        s = data.chain[(EXP, 22000.0, "CE")]
        s.open[m] = s.high[m] = s.low[m] = s.close[m] = 132
    leg = sar_leg(lots_ratio=0.5, trail_peak={"activate_percent": 150, "exit_percent": 80})
    short, long = simulate_day(strategy([leg]), data).trades
    assert (short.exit_price, long.entry_price, long.qty) == (130, 130, LOT * 0.5)
    # peak 210 > 195 arms the trail after the 10:10 bar: out at 168 on the 10:11 bar
    assert (long.exit_min, long.exit_price, long.exit_reason) == (
        minute_index("10:11"),
        168,
        "TRAIL",
    )
    assert long.pnl == pytest.approx((168 - 130) * LOT * 0.5)


def test_reverse_on_sl_filter_hook_falls_back_to_re_cost():
    from option_backtesting.data.reference.loader import default_reference_data
    from option_backtesting.legwise.engine import _DaySim

    class NoReverse(_DaySim):
        def _reverse_allowed(self, run, minute):
            return False

    whip = {**STOP_BAR, "10:30": (100, 100, 95, 97)}
    data = day({(22000.0, "CE"): rising(110, whip, "10:30", 97)})
    data.chain[(EXP, 22000.0, "CE")].close[minute_index("09:19")] = 100  # entry at 100
    trades = NoReverse(strategy([sar_leg()]), data, default_reference_data()).run().trades
    assert [(t.leg_id, t.position, t.entry_price) for t in trades] == [
        ("ce", "sell", 100),
        ("ce", "sell", 100),
    ]


def test_reverse_on_sl_validates_and_stays_out_of_the_dump_when_unset():
    plain = strategy([sell_leg(stop_loss={"percent": 21})]).model_dump()["legs"][0]
    assert "reverse_on_sl" not in plain
    set_ = strategy([sar_leg(time_stop_minutes=30)]).model_dump()["legs"][0]
    assert set_["reverse_on_sl"]["time_stop_minutes"] == 30
    assert set_["reverse_on_sl"]["stop_loss_percent"] == 30
    with pytest.raises(ValidationError, match="for sold legs"):
        strategy([buy_leg(stop_loss={"percent": 30}, reverse_on_sl={})])
    with pytest.raises(ValidationError, match="needs a stop_loss"):
        strategy([sell_leg(reverse_on_sl={})])
    with pytest.raises(ValidationError, match="1.0 or 0.5"):
        strategy([sar_leg(lots_ratio=0.7)])
    with pytest.raises(ValidationError, match="square_off: complete"):
        strategy([sell_leg(stop_loss={"percent": 21}, reverse_on_sl={})], square_off="complete")


# --- BL-186 Amendment 1: a cheaper long, and the re-sale toggle ---------------------------------


def cheap_chain(**extra) -> dict:
    """The stopped 22000 CE (entry 100, SL 121 touched at 10:00) and three other CE strikes: 22100
    at 48 (the closest to 50), 22050 at 60 (in the band, farther) and 22200 at 30 (below it). The
    22100 spikes inside the stop bar to a 66 close, then runs to 90."""
    stop_bar = {"10:00": (100, 125, 100, 124)}
    return {
        (22000.0, "CE"): rising(100, stop_bar, "10:00", 124),
        (22100.0, "CE"): rising(48, {"10:00": (48, 70, 48, 66)}, "10:00", 90),
        (22050.0, "CE"): bars(60),
        (22200.0, "CE"): bars(30),
        **extra,
    }


def test_strike_premium_buys_the_closest_strike_at_the_close_of_the_stop_bar():
    result = simulate_day(strategy([sar_leg(strike_premium=50)]), day(cheap_chain()))
    short, long = result.trades
    assert (short.exit_price, short.exit_reason) == (121, "SL")
    assert (long.leg_id, long.contract) == ("ce_rev", (EXP, 22100.0, "CE"))
    # picked on its 48 before the stop bar; filled at the stop bar's close, 66; judged from 10:01
    assert (long.entry_min, long.entry_price, long.qty) == (minute_index("10:00"), 66, LOT)
    assert (long.exit_price, long.exit_reason) == (90, "EXIT_TIME")
    assert result.gross == pytest.approx((100 - 121) * LOT + (90 - 66) * LOT)


def test_strike_premium_long_has_its_own_stop_and_time_stop_counted_from_the_fill():
    chain = cheap_chain()
    chain[(22100.0, "CE")] = rising(
        48, {"10:00": (48, 70, 48, 66), "10:20": (66, 66, 40, 44)}, "10:20", 44
    )
    [_, long] = simulate_day(strategy([sar_leg(strike_premium=50)]), day(chain)).trades
    assert (long.exit_price, long.exit_reason, long.exit_min) == (
        to_tick(66 * 0.7),
        "SL",
        minute_index("10:20"),
    )
    timed = simulate_day(
        strategy([sar_leg(strike_premium=50, time_stop_minutes=30)]), day(cheap_chain())
    ).trades[1]
    # 30 minutes after the fill at the end of the 10:00 bar (10:01)
    assert (timed.exit_min, timed.exit_price, timed.exit_reason) == (
        minute_index("10:31"),
        90,
        "TIME",
    )


def test_strike_premium_with_no_strike_in_the_band_or_only_the_stopped_one_does_not_reverse():
    only_far = {
        (22000.0, "CE"): rising(100, {"10:00": (100, 125, 100, 124)}, "10:00", 124),
        (22200.0, "CE"): bars(30),  # below 35
        (22300.0, "CE"): bars(90),  # above 70
    }
    data = day(only_far)
    data.chain[(EXP, 22000.0, "CE")].close[minute_index("09:19")] = 100
    result = simulate_day(strategy([sar_leg(strike_premium=50)]), data)
    assert [t.leg_id for t in result.trades] == ["ce"]  # RE COST armed, price never returns
    assert any("reverse skipped, no strike priced 35-70" in n for n in result.notes)
    # a target that makes the stopped contract itself the closest: no reversal either
    same = simulate_day(strategy([sar_leg(strike_premium=100)]), day(cheap_chain()))
    assert [t.leg_id for t in same.trades] == ["ce"]
    assert any("closest strike is the stopped one" in n for n in same.notes)


def test_resell_after_reverse_waits_for_the_long_to_close_then_re_sells_at_cost():
    back = {
        "10:00": (100, 125, 100, 124),
        "10:03": (110, 110, 95, 97),  # back through the 100 entry while the long is still open
    }
    ce = rising(110, back, "10:03", 97)
    ce.close[minute_index("09:19")] = 100  # entry at 100
    data = day({(22000.0, "CE"): ce})
    plain = simulate_day(strategy([sar_leg(time_stop_minutes=5)]), data)
    assert [t.leg_id for t in plain.trades] == ["ce", "ce_rev"]  # a reversed leg is not re-sold
    result = simulate_day(strategy([sar_leg(time_stop_minutes=5, resell_after_reverse=True)]), data)
    short, long, resold = result.trades
    assert (long.exit_reason, long.exit_min) == ("TIME", minute_index("10:05"))
    assert (resold.leg_id, resold.position, resold.entry_price) == ("ce", "sell", 97)
    assert resold.entry_min > long.exit_min  # not before the long closed
    assert short.exit_reason == "SL"


def test_amendment_fields_validate_and_stay_out_of_the_dump_at_their_defaults():
    base = strategy([sar_leg(time_stop_minutes=30)]).model_dump()["legs"][0]["reverse_on_sl"]
    assert "strike_premium" not in base and "resell_after_reverse" not in base
    on = strategy([sar_leg(strike_premium=50, resell_after_reverse=True)]).model_dump()
    rev = on["legs"][0]["reverse_on_sl"]
    assert (rev["strike_premium"], rev["resell_after_reverse"]) == (50, True)
    with pytest.raises(ValidationError):
        strategy([sar_leg(strike_premium=0)])
