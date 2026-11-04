"""The Rotation page's daily candle card (owner, 2026-11-04): candles on the running total from the
replayed book path under the book stop, each pick's result, the random-basket share, the route."""

from __future__ import annotations

from datetime import date

import pytest
from fastapi.testclient import TestClient

from option_backtesting.api import rotation_candles_routes as routes
from option_backtesting.api.app import create_app
from option_backtesting.legwise.market import N_MINUTES
from option_backtesting.rotation import candles, daylog, journal, portfolio, store, warm

D1, D2 = date(2026, 10, 19), date(2026, 10, 20)


def path(low: float, high: float, close: float) -> tuple[float, ...]:
    """One lot: down to `low` in the first hour, up to `high` by midday, `close` at the end."""
    out = [0.0] * N_MINUTES
    for m in range(N_MINUTES):
        if m <= 60:
            out[m] = low * m / 60
        elif m <= 180:
            out[m] = low + (high - low) * (m - 60) / 120
        else:
            out[m] = high + (close - high) * (m - 180) / (N_MINUTES - 1 - 180)
    return tuple(out)


@pytest.fixture
def world(monkeypatch, tmp_path):
    """Two days of two picks, each pick's crafted path; a pool of four strategies."""
    paths = {
        (D1, "A"): path(-1000, 3000, 2000),
        (D1, "B"): path(-500, 1000, 500),
        (D2, "A"): path(-6000, -1000, -4000),
        (D2, "B"): path(-4000, -2000, -3000),
    }
    monkeypatch.setattr(
        candles,
        "picks_by_day",
        lambda root, book, start, end: {
            d: candles.DayPicks([("A", 1), ("B", 1)], "recorded") for d in (D1, D2)
        },
    )
    monkeypatch.setattr(candles, "_pool", lambda book: ["A", "B", "C", "E"])
    monkeypatch.setattr(portfolio, "one_lot_path", lambda root, d, n, loaded=None: paths[(d, n)])
    pool = {
        "A": {D1: 2000.0, D2: -4000.0},
        "B": {D1: 500.0, D2: -3000.0},
        "C": {D1: 100.0, D2: 900.0},
        "E": {D1: -200.0, D2: 300.0},
    }
    monkeypatch.setattr(store, "read_net", lambda name, root=None: pool[name])
    return tmp_path


def test_candles_lie_on_the_running_total(world):
    r = candles.build("t1", world, D1, D2, stop=None, use_default_stop=False)
    d1, d2 = r["days"]
    # day 1: the book goes to -1,500 an hour in, +4,000 at midday, closes +2,500
    assert (d1["open"], d1["high"], d1["low"], d1["close"], d1["pnl"]) == (
        0,
        4000,
        -1500,
        2500,
        2500,
    )
    # day 2 opens at day 1's close: low -10,000 at the first hour, close -7,000
    assert (d2["open"], d2["low"], d2["close"], d2["pnl"]) == (2500, -7500, -4500, -7000)
    assert d2["high"] == 2500  # it never rose above its open
    assert [p["pnl"] for p in d2["picks"]] == [-4000, -3000]
    assert r["totals"] == {"pnl": -4500, "days": 2, "max_drawdown": 7000, "drawdown_now": 7000}


def test_the_book_stop_cuts_the_day_and_scales_with_lots(world):
    r = candles.build("t1", world, D1, D2, stop=9000)
    d2 = r["days"][1]
    assert d2["stopped_at"] is not None and d2["pnl"] == pytest.approx(-9000, abs=200)
    assert d2["low"] == d2["close"]  # the day ends where the stop cut it
    two = candles.build("t1", world, D1, D2, lots=2, stop=9000)
    assert two["stop"] == 18000  # the stop is per lot of the book
    assert two["days"][1]["pnl"] == pytest.approx(2 * d2["pnl"], abs=400)
    assert [p["lots"] for p in two["days"][0]["picks"]] == [2, 2]


def test_the_default_stop_is_the_books_own(world):
    assert candles.build("t1", world, D1, D2)["stop"] == 9000
    assert candles.build("core", world, D1, D2)["stop"] == 8000
    assert candles.build("t1", world, D1, D2, stop=0, use_default_stop=False)["stop"] is None


def test_beat_is_the_share_of_random_baskets_below_the_day(world):
    r = candles.build("t1", world, D1, D2, stop=None, use_default_stop=False)
    # day 1's +2,500 beats every other pair of the pool (the best other pair is +2,100); day 2's
    # -7,000 is the worst pair there is, so it beats none
    assert r["days"][0]["beat"] > 0.8 and r["days"][1]["beat"] == 0
    assert candles.beat_share(1.0, [0.0, 2.0], 1, "s") == candles.beat_share(
        1.0, [0.0, 2.0], 1, "s"
    )
    assert candles.beat_share(0.0, [1.0], 2, "s") is None  # too small a pool


def test_a_day_that_cannot_be_replayed_is_left_out(world, monkeypatch):
    def boom(root, d, n, loaded=None):
        raise portfolio.PortfolioStopError(f"no collected NIFTY data for {d}")

    monkeypatch.setattr(portfolio, "one_lot_path", boom)
    r = candles.build("t1", world, D1, D2)
    assert r["days"] == [] and [x["day"] for x in r["left_out"]] == ["2026-10-19", "2026-10-20"]


def test_bad_requests():
    with pytest.raises(candles.CandlesError):
        candles.build("ref", None)
    with pytest.raises(candles.CandlesError):
        candles.build("t1", None, lots=11)


def test_picks_are_the_journals_then_rederived_before_it(tmp_path, monkeypatch):
    root = tmp_path / "TradingData"
    journal.append(
        store.journal_path(root, "t1"),
        {"day": D2.isoformat(), "lists": {"C": {"core": ["A", "B"], "buy": ["Z"]}}},
    )

    class Recon:
        def days_available(self):
            return [D1, D2]

        def picks(self, d):
            return {"C": {"core": ["X", "Y"], "buy": []}}

    monkeypatch.setattr(daylog, "reconstruction", lambda root, names: Recon())
    monkeypatch.setattr(candles, "_pool", lambda book: [])
    got = candles.picks_by_day(root, "t1", D1, D2)
    assert got[D1] == candles.DayPicks([("X", 1), ("Y", 1)], "rederived")
    assert got[D2] == candles.DayPicks([("A", 1), ("B", 1), ("Z", 1)], "recorded")


def test_the_route(world, monkeypatch):
    monkeypatch.setenv("TRADING_DATA_ROOT", str(world))
    routes._cache.clear()
    client = TestClient(create_app())
    ok = client.get("/legwise/rotation/candles?book=t1&from=2026-10-19&to=2026-10-20&stop=")
    assert ok.status_code == 200 and ok.json()["stop"] is None and len(ok.json()["days"]) == 2
    assert client.get("/legwise/rotation/candles?book=ref").status_code == 422
    assert client.get("/legwise/rotation/candles?lots=0").status_code == 422
    assert client.get("/legwise/rotation/candles?from=19-10-2026").status_code == 422
    assert client.get("/legwise/rotation/candles?stop=nan").status_code == 422
    monkeypatch.setattr(warm, "run_within", lambda key, fn, wait=None: (False, None))
    routes._cache.clear()
    cold = client.get("/legwise/rotation/candles?book=base&from=2026-10-19&to=2026-10-20")
    assert cold.status_code == 202 and cold.json() == {"status": "warming"}
