"""BL-095 Phase 1: the portfolio MTM stop over a basket (rotation/portfolio.py)."""

from __future__ import annotations

from datetime import date

import pytest

from option_backtesting.legwise.engine import simulate_day
from option_backtesting.legwise.market import N_MINUTES, minute_index
from option_backtesting.rotation import portfolio as pf
from option_backtesting.rotation.portfolio import (
    Member,
    PortfolioStopError,
    Trail,
    apply_book,
    member_from_curve,
    normalise_stop,
    parse_trail,
)

from .test_legwise_engine import bars, day, sell_leg, strategy


def path(*points: tuple[int, float], start: int = 0) -> tuple[float, ...]:
    """A one-lot path: 0 before `start`, then linear between (minute, value) keypoints, flat after
    the last (the realised gross)."""
    out = [0.0] * N_MINUTES
    keys = [(start, 0.0), *points]
    for (m0, v0), (m1, v1) in zip(keys, keys[1:], strict=False):
        for m in range(m0, m1 + 1):
            out[m] = v0 + (v1 - v0) * (m - m0) / max(m1 - m0, 1)
    last_m, last_v = keys[-1]
    for m in range(last_m, N_MINUTES):
        out[m] = last_v
    return tuple(out)


def member(name: str, lots: int, *points: tuple[int, float], start: int = 0) -> Member:
    return Member(name, lots, path(*points, start=start))


@pytest.fixture(autouse=True)
def _isolated_cache(tmp_path, monkeypatch):
    monkeypatch.setenv("ATA_PORTFOLIO_CACHE_DIR", str(tmp_path / "pf-cache"))
    pf.clear_cache()


# --- the settings ---------------------------------------------------------------------------


@pytest.mark.parametrize("value", [None, 0, 0.0, -5, -0.01])
def test_empty_zero_and_negative_stop_mean_no_stop(value):
    assert normalise_stop(value) is None


def test_positive_stop_is_kept_and_junk_raises():
    assert normalise_stop(10000) == 10000.0
    with pytest.raises(PortfolioStopError):
        normalise_stop("abc")  # type: ignore[arg-type]
    with pytest.raises(PortfolioStopError):
        normalise_stop(float("nan"))


def test_parse_trail_the_three_modes():
    assert parse_trail("sl:1000,500") == Trail("sl", x=1000, y=500)
    assert parse_trail("lock:2000,500") == Trail("lock", a=2000, b=500)
    assert parse_trail("locktrail:2000,500,1000,250") == Trail("locktrail", 2000, 500, 1000, 250)
    assert parse_trail("sl:1000,500").text() == "sl:1000,500"


@pytest.mark.parametrize(
    "text", [None, "", "  ", "sl:,500", "sl:1000,", "sl:0,500", "lock:2000,-1"]
)
def test_parse_trail_empty_or_zero_field_is_off(text):
    assert parse_trail(text) is None


@pytest.mark.parametrize(
    "text",
    ["nope:1,2", "sl:1000", "sl:a,b", "lock:1,2,3", "sl:500,1000", "lock:500,2000", "sl:nan,1"],
)
def test_parse_trail_malformed_raises(text):
    with pytest.raises(PortfolioStopError):
        parse_trail(text)


# --- the fixed stop -------------------------------------------------------------------------


def test_no_stop_leaves_the_book_as_it_was():
    book = apply_book([member("a", 2, (200, -3000), (374, 500))], None)
    assert book.stop_minute is None and book.fired_by is None
    assert book.gross_with == book.gross_without == pytest.approx(1000.0)
    assert book.stopped == book.combined
    assert all(v is None for v in book.level)


@pytest.mark.parametrize("stop", [None, 0, -5])
def test_a_stop_of_none_zero_or_below_is_the_same_as_none(stop):
    members = [member("a", 2, (200, -9000), (374, -2000))]
    off = apply_book(members, None)
    assert apply_book(members, stop).to_dict() == off.to_dict()


def test_stop_fires_at_the_first_minute_at_or_below_minus_stop_and_freezes_the_book():
    # 2 lots; one-lot path falls 100 a minute from minute 10: combined = -200 a minute.
    members = [member("a", 2, (10, 0.0), (110, -10000.0), (374, -10000.0))]
    book = apply_book(members, 10000)
    assert book.stop_minute == 60  # combined -10,000 at minute 10 + 50
    assert book.fired_by == "stop"
    assert book.gross_without == pytest.approx(-20000.0)
    assert book.gross_with == pytest.approx(-10000.0)
    assert all(v == pytest.approx(-10000.0) for v in book.stopped[60:])
    assert book.level[0] == -10000.0 and book.level[60] == -10000.0
    assert book.level[61] is None  # nothing after the stop


def test_lots_scale_each_member():
    members = [member("a", 2, (100, -1000)), member("b", 1, (100, -2000))]
    book = apply_book(members, None)
    assert book.combined[-1] == pytest.approx(2 * -1000 + -2000)
    assert [m["gross_without"] for m in book.members] == [-2000.0, -2000.0]


def test_a_member_that_has_not_entered_yet_does_not_enter():
    early = member("early", 2, (100, -6000), (374, -6000))  # -12,000 for 2 lots at minute 100
    late = member("late", 2, (350, 3000), start=300)  # enters 11 minutes before the close
    book = apply_book([early, late], 10000)
    assert book.stop_minute is not None and book.stop_minute < 100
    by_name = {m["name"]: m for m in book.members}
    assert by_name["late"]["at_stop"] == 0.0
    assert by_name["late"]["gross_without"] == pytest.approx(6000.0)
    assert book.gross_with == pytest.approx(-10000.0, abs=250)


def test_a_member_still_open_is_marked_at_its_mtm_when_the_book_stops():
    a = member("a", 1, (50, -4000), (374, -4000))  # done at -4,000
    b = member("b", 1, (50, 0), (150, -8000), (374, 2000))  # still falling at the stop
    book = apply_book([a, b], 10000)
    m = book.stop_minute
    assert m is not None and 50 < m < 150
    got = {r["name"]: r["at_stop"] for r in book.members}
    assert got["a"] == pytest.approx(-4000.0)
    assert got["b"] == pytest.approx(book.combined[m] + 4000.0)


def test_book_that_never_reaches_the_stop_is_untouched():
    members = [member("a", 2, (100, -4000), (374, 1000))]
    book = apply_book(members, 10000)
    assert book.stop_minute is None
    assert book.gross_with == book.gross_without


# --- trailing ---------------------------------------------------------------------------------


def test_trail_sl_moves_y_for_every_x_of_profit_and_stops_at_the_trailed_level():
    # best reaches +3,000; X=1000, Y=500 -> level -10000 + 1500 = -8500
    members = [
        member("a", 1, (100, 3000), (300, -9000), (374, -9000)),
    ]
    book = apply_book(members, 10000, Trail("sl", x=1000, y=500))
    assert book.fired_by == "trail"
    assert book.gross_with == pytest.approx(
        next(v for v in book.combined[100:] if v <= -8500), abs=1e-6
    )
    assert book.gross_with > -10000  # the trailed level exits before the fixed one would
    levels = [v for v in book.level if v is not None]
    assert levels == sorted(levels)  # never moves down
    assert levels[-1] == pytest.approx(-8500.0)


def test_trail_sl_is_the_fixed_stop_when_the_book_never_makes_money():
    members = [member("a", 1, (200, -12000), (374, -12000))]
    fixed = apply_book(members, 10000)
    trailed = apply_book(members, 10000, Trail("sl", x=1000, y=500))
    assert trailed.stop_minute == fixed.stop_minute and trailed.fired_by == "stop"


def test_trail_sl_needs_a_stop():
    members = [member("a", 1, (100, 3000), (300, -9000), (374, -9000))]
    off = apply_book(members, None)
    assert apply_book(members, None, Trail("sl", x=1000, y=500)).to_dict() == off.to_dict()


def test_lock_profit_exits_at_the_lock_once_armed():
    members = [member("a", 1, (100, 2500), (200, 100), (374, 100))]
    book = apply_book(members, 10000, Trail("lock", a=2000, b=500))
    assert book.fired_by == "lock"
    assert book.stop_minute is not None and 100 < book.stop_minute < 200
    assert book.gross_with <= 500.0
    assert book.gross_with > 0  # locked profit, not the day's -ish end


def test_lock_profit_that_is_not_reached_changes_nothing():
    members = [member("a", 1, (100, 1900), (200, -2000), (374, -2000))]
    plain = apply_book(members, 10000)
    locked = apply_book(members, 10000, Trail("lock", a=2000, b=500))
    assert locked.to_dict() == plain.to_dict()


def test_lock_profit_works_with_no_stop_loss():
    members = [member("a", 1, (100, 2500), (300, -3000), (374, -3000))]
    book = apply_book(members, None, Trail("lock", a=2000, b=500))
    assert book.fired_by == "lock"
    assert 0 < book.gross_with <= 500.0
    assert book.level[0] is None  # no level until the lock arms


def test_lock_and_trail_raises_the_locked_level_with_profit():
    # armed at 2,000 (lock 500); peak 4,000 -> 500 + 500 * floor(2000/1000) = 1,500
    members = [member("a", 1, (100, 4000), (300, 0), (374, 0))]
    book = apply_book(members, 10000, Trail("locktrail", a=2000, b=500, x=1000, y=500))
    assert book.fired_by == "lock"
    levels = [v for v in book.level if v is not None]
    assert levels[-1] == pytest.approx(1500.0)
    assert book.gross_with <= 1500.0 and book.gross_with > 1000.0


def test_level_never_moves_down_when_the_book_falls_and_rises_again():
    members = [member("a", 1, (50, 3000), (100, 1500), (150, 2000), (200, 1600), (374, 1600))]
    book = apply_book(members, 10000, Trail("sl", x=1000, y=500))
    levels = [v for v in book.level if v is not None]
    assert levels == sorted(levels)


def test_lock_equal_to_arm_exits_at_once():
    members = [member("a", 1, (100, 2000), (374, 2000))]
    book = apply_book(members, 10000, Trail("lock", a=2000, b=2000))
    assert book.fired_by == "lock" and book.gross_with == pytest.approx(2000.0)


# --- the same numbers the engine and BL-055 give ----------------------------------------------


def test_a_book_of_one_reproduces_the_engines_own_overall_stop():
    legs = [sell_leg(stop_loss={"points": 20}), sell_leg(id="pe", option_type="PE")]
    data = day(
        {
            (22000.0, "CE"): bars(100, {"10:00": (100, 125, 100, 120)}),
            (22000.0, "PE"): bars(100, {"10:05": (100, 125, 100, 118)}),
        }
    )
    engine = simulate_day(strategy(legs, overall={"stop_loss_inr": 2400}), data)
    assert engine.stopped_by == "overall SL at 10:05"
    free = simulate_day(strategy(legs), data)  # the same day without the strategy's own stop
    book = apply_book([member_from_curve("t", 1, free.mtm, free.gross)], 2400)
    assert book.stop_minute == minute_index("10:05")
    assert book.gross_with == pytest.approx(engine.gross)


def test_member_from_curve_holds_the_gross_after_the_last_minute():
    m = member_from_curve("x", 1, [(5, 10.0), (6, -20.0)], gross=-15.0)
    assert m.pnl[4] == 0.0 and m.pnl[5] == 10.0 and m.pnl[6] == -20.0
    assert m.pnl[7] == m.pnl[-1] == -15.0
    assert len(m.pnl) == N_MINUTES
    flat = member_from_curve("y", 1, [], gross=42.0)
    assert set(flat.pnl) == {42.0}


def test_the_disk_cache_round_trips_and_replaces_a_stale_file():
    day = date(2026, 9, 11)
    key = ("/data", day, "N_wide_0917", (1, 2, 3))
    path = tuple(float(i) for i in range(N_MINUTES))
    assert pf._disk_read(key) is None
    pf._disk_write(key, path)
    assert pf._disk_read(key) == path
    newer = ("/data", day, "N_wide_0917", (9, 9, 9))  # the day's lake files changed
    pf._disk_write(newer, path)
    assert pf._disk_read(newer) == path
    assert pf._disk_read(key) is None  # the stale file is gone


def test_a_torn_or_wrong_length_cache_file_is_ignored():
    day = date(2026, 9, 11)
    key = ("/data", day, "N_wide_0917", (1,))
    file = pf._disk_file(key)
    file.parent.mkdir(parents=True, exist_ok=True)
    file.write_text("[1, 2, 3]")
    assert pf._disk_read(key) is None
    file.write_text("{not json")
    assert pf._disk_read(key) is None


def test_cleanup_never_touches_another_data_roots_files():
    day = date(2026, 9, 11)
    mine = ("/data/real", day, "N_wide_0917", (1, 2, 3))
    theirs = ("/data/demo", day, "N_wide_0917", (4, 5, 6))
    path = tuple(float(i) for i in range(N_MINUTES))
    pf._disk_write(mine, path)
    pf._disk_write(theirs, path)  # same pick-day, another root
    assert pf._disk_read(mine) == path
    assert pf._disk_read(theirs) == path
    pf._disk_write(("/data/real", day, "N_wide_0917", (7, 8, 9)), path)  # repaired: mine only
    assert pf._disk_read(mine) is None
    assert pf._disk_read(theirs) == path


def test_the_stamp_covers_reference_csvs_the_symbol_master_and_the_version(tmp_path, monkeypatch):
    from option_backtesting.data.reference import loader
    from option_backtesting.rotation.variants import variant_names

    ref = tmp_path / "reference"
    ref.mkdir()
    (ref / "lot_sizes.csv").write_text("underlying,lot_size,effective_date\nNIFTY,75,2024-11-20\n")
    monkeypatch.setattr(loader, "REFERENCE_DIR", ref)
    name, day = variant_names()[0], date(2026, 9, 11)
    before = pf._stamp(tmp_path, day, name)
    assert before == pf._stamp(tmp_path, day, name)  # deterministic
    (ref / "lot_sizes.csv").write_text("underlying,lot_size,effective_date\nNIFTY,65,2024-11-20\n")
    assert pf._stamp(tmp_path, day, name) != before  # a corrected lot size invalidates
    after_lot = pf._stamp(tmp_path, day, name)
    monkeypatch.setattr(pf, "CACHE_VERSION", pf.CACHE_VERSION + 1)
    assert pf._stamp(tmp_path, day, name) != after_lot  # an engine fix bumps the version
    from trading_data import lake

    master = lake.symbol_master_path(tmp_path, "fyers", day)
    master.parent.mkdir(parents=True, exist_ok=True)
    before_master = pf._stamp(tmp_path, day, name)
    master.write_bytes(b"x")
    assert pf._stamp(tmp_path, day, name) != before_master


def test_concurrent_cold_requests_replay_a_pick_day_once(tmp_path, monkeypatch):
    import threading
    import time

    from option_backtesting.rotation.variants import variant_names

    name, day = variant_names()[0], date(2026, 9, 11)
    replays: list[int] = []
    path = tuple(float(i) for i in range(N_MINUTES))

    def slow(root, d, n, loaded):
        replays.append(1)
        time.sleep(0.3)
        return path

    monkeypatch.setattr(pf, "_replay", slow)
    results: list[tuple] = []
    threads = [
        threading.Thread(target=lambda: results.append(pf.one_lot_path(tmp_path, day, name)))
        for _ in range(4)
    ]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert len(replays) == 1 and results == [path] * 4


@pytest.mark.parametrize(
    ("text", "echo"),
    [
        ("lock:1250000,1000000", "lock:1250000,1000000"),
        ("sl:1000.5,500", "sl:1000.5,500"),
        ("locktrail:20000,12000,2000,1000", "locktrail:20000,12000,2000,1000"),
    ],
)
def test_the_echoed_trail_keeps_every_digit(text, echo):
    assert pf.parse_trail(text).text() == echo


def test_wrong_length_path_is_refused():
    with pytest.raises(PortfolioStopError):
        apply_book([Member("a", 1, (0.0,) * 10)], 10000)


def test_book_day_refuses_an_unknown_variant_and_an_empty_book(tmp_path):
    with pytest.raises(PortfolioStopError):
        pf.book_day(tmp_path, date(2026, 9, 11), [], 10000)
    with pytest.raises(PortfolioStopError):
        pf.book_day(tmp_path, date(2026, 9, 11), [("../etc/passwd", 2)], 10000)
