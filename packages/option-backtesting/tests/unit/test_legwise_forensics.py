"""Day forensics + anatomy: engine MTM curve, the builder, and the two routes over a
tiny synthetic lake (no network, no real data)."""

from datetime import UTC, date, datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient
from trading_data import lake
from trading_data.db import connect

from option_backtesting.api import legwise_routes
from option_backtesting.api.app import create_app
from option_backtesting.fyers.client import Candle
from option_backtesting.fyers.daily import bars_table, options_table
from option_backtesting.fyers.symbols import Contract
from option_backtesting.legwise import store
from option_backtesting.legwise.engine import simulate_day
from option_backtesting.legwise.market import load_day
from option_backtesting.legwise.schema import LegwiseStrategy

IST = timezone(timedelta(hours=5, minutes=30))
DAY = date(2026, 9, 28)
PREV = date(2026, 9, 25)
EXPIRY = date(2026, 9, 29)

SPEC = {
    "id": "t1",
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
            "stop_loss": {"percent": 30},
        }
    ],
}


def candles(day: date, price_at) -> list[Candle]:
    t0 = datetime(day.year, day.month, day.day, 9, 15, tzinfo=IST)
    out = []
    for i in range(375):
        p = price_at(i)
        out.append(Candle(int((t0 + timedelta(minutes=i)).timestamp()), p, p, p, p, 0, None))
    return out


def write_index(root, day, name, price_at):
    lake.write_parquet(
        bars_table(1, name, candles(day, price_at)), lake.bars_1m_path(root, "index", name, day)
    )


def write_day(root, day, option_price_at):
    write_index(root, day, "NIFTY", lambda i: 22000.0 + i)  # rising index
    write_index(root, day, "INDIAVIX", lambda i: 14.0)
    rows = []
    for strike in (21950.0, 22000.0, 22050.0, 22100.0, 22150.0, 22200.0):
        c = Contract(f"NSE:NIFTY{int(strike)}CE", "NIFTY", EXPIRY, strike, "CE", 65)
        rows.append((c, 7, candles(day, option_price_at)))
    lake.write_parquet(options_table(rows), lake.bars_1m_path(root, "option", "NIFTY", day))


@pytest.fixture
def root(tmp_path, monkeypatch):
    monkeypatch.setenv("TRADING_DATA_ROOT", str(tmp_path))
    return tmp_path


def test_engine_keeps_the_per_minute_mtm_curve(root):
    # option decays 100 -> 90 across the session, no stop hit
    write_day(root, DAY, lambda i: 100.0 - i * 10 / 375)
    strategy = LegwiseStrategy.model_validate(SPEC)
    result = simulate_day(strategy, load_day(root, "NIFTY", DAY))
    assert [m for m, _ in result.mtm] == list(range(5, 345))  # 09:20 .. 14:59
    values = [v for _, v in result.mtm]
    assert (
        values[0] == pytest.approx(0, abs=65 * 0.2) and values[-1] > 0
    )  # a seller profits from decay
    assert min(values) == pytest.approx(result.worst_mtm, abs=1e-6) or result.worst_mtm <= min(
        values
    )


@pytest.fixture
def client(root, tmp_path, monkeypatch):
    monkeypatch.setattr(legwise_routes, "LEGWISE_DIR", tmp_path / "strategies")
    return TestClient(create_app(tmp_path / "cache"))


def test_day_route_returns_curves_markers_attribution_and_anatomy(client, root):
    write_index(root, PREV, "NIFTY", lambda i: 21900.0)
    write_index(root, PREV, "INDIAVIX", lambda i: 14.0)
    write_day(root, DAY, lambda i: 100.0 - i * 10 / 375)
    body = client.get("/legwise/day", params={"strategy": "t1", "day": DAY.isoformat()})
    assert body.status_code == 404  # strategy not saved yet
    client.put("/legwise/strategies/t1", json={"strategy": SPEC})

    out = client.get("/legwise/day", params={"strategy": "t1", "day": DAY.isoformat()}).json()
    assert out["window"] == {"start": "09:20", "end": "15:00"}
    assert len(out["mtm"]) == 340 and out["mtm"][0]["t"] == "09:20"
    assert [m["kind"] for m in out["markers"]] == ["entry", "exit"]
    [attr] = out["attribution"]
    assert attr["leg"] == "ce" and attr["trades"] == 1 and attr["reentries"] == 0
    assert attr["net"] == pytest.approx(out["net"])
    assert out["net_per_lot"] == out["net"]  # one lot
    assert out["legs"][0]["premium"][0]["t"] == "09:20"
    [trade] = out["trades"]  # exact rows, so the UI never has to rebuild a P&L
    assert trade["leg"] == "ce" and trade["pnl"] == pytest.approx(out["gross"])
    # wall-clock-as-UTC: 09:20 IST must read back as 09:20 on a UTC axis
    assert datetime.fromtimestamp(out["mtm"][0]["ts"], UTC).strftime("%H:%M") == "09:20"
    # anatomy: gap from the previous collected day's close, three default segments
    assert out["anatomy"]["gap_pct"] == pytest.approx((22000 - 21900) / 21900 * 100, abs=0.01)
    assert len(out["anatomy"]["segments"]) == 3 and len(out["cuts"]) == 2


def test_day_route_replays_the_version_that_produced_a_result(client, root):
    write_day(root, DAY, lambda i: 100.0)
    old = LegwiseStrategy.model_validate(SPEC)
    with connect(root) as con:
        store.ensure_version(con, old)
    sha = store.spec_hash(old)
    # the file is later edited to a 2-lot strategy; the saved result must still replay the OLD spec
    client.put(
        "/legwise/strategies/t1",
        json={"strategy": {**SPEC, "legs": [{**SPEC["legs"][0], "lots": 2}]}},
    )
    replay = client.get(
        "/legwise/day", params={"strategy": "t1", "day": DAY.isoformat(), "sha": sha}
    ).json()
    now = client.get("/legwise/day", params={"strategy": "t1", "day": DAY.isoformat()}).json()
    assert replay["lots"] == 1 and replay["sha"] == sha
    assert now["lots"] == 2


def test_day_route_rejects_bad_input_and_missing_data(client, root):
    client.put("/legwise/strategies/t1", json={"strategy": SPEC})
    assert client.get("/legwise/day", params={"strategy": "t1", "day": "nope"}).status_code == 422
    assert (
        client.get(
            "/legwise/day", params={"strategy": "t1", "day": "2026-09-28", "cuts": "13:30,10:30"}
        ).status_code
        == 422
    )
    missing = client.get("/legwise/day", params={"strategy": "t1", "day": "2026-09-28"})
    assert missing.status_code == 404 and "no collected NIFTY data" in missing.json()["error"]


def test_anatomy_route_honours_custom_cuts_and_range(client, root):
    for d in (PREV, DAY):
        write_index(root, d, "NIFTY", lambda i: 22000.0 + i * 2)
        write_index(root, d, "INDIAVIX", lambda i: 14.0)
    out = client.get("/legwise/anatomy", params={"cuts": "11:00"}).json()
    assert out["cuts"] == ["11:00"] and [d["day"] for d in out["days"]] == [
        "2026-09-25",
        "2026-09-28",
    ]
    assert all(len(d["segments"]) == 2 for d in out["days"])
    assert out["days"][0]["gap_pct"] is None  # first day in the history has nothing to gap from
    assert out["days"][1]["segments"][0]["label"] == "TREND_UP"
    assert set(out["thresholds"]) == {"quiet_range_over_implied", "trend_strength"}
    narrowed = client.get("/legwise/anatomy", params={"from": "2026-09-28"}).json()
    assert [d["day"] for d in narrowed["days"]] == ["2026-09-28"]
    assert narrowed["days"][0]["gap_pct"] is not None  # gap still measured from the prior day
    assert client.get("/legwise/anatomy", params={"underlying": "XYZ"}).status_code == 422
    assert client.get("/legwise/anatomy", params={"cuts": "10:30,zz"}).status_code == 422
