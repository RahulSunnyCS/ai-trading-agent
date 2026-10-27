"""BL-168 Phase 4: the contract-notes store read as the owner's sheet. Every figure, account
and contract here is invented."""

from __future__ import annotations

import json
from datetime import date, timedelta
from decimal import Decimal
from pathlib import Path

import pytest

from option_backtesting.realised import ratios, sources, store, trips


def _write(root: Path, day: str, lines: list[dict]) -> None:
    path = root / "contract-notes" / "days" / f"{day}.jsonl"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("".join(json.dumps(ln) + "\n" for ln in lines))


def _manual(root: Path, day: str, **fields) -> None:
    path = root / "contract-notes" / "manual" / f"{day}.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({"day": day, **fields}))


def _note(day: str, account: str, final_net: float, charges: float = 10.0, **extra) -> dict:
    return {
        "day": day,
        "broker": "finvasia",
        "account": account,
        "status": "note",
        "fno": {
            "payin_payout_obligation": final_net + charges,
            "net_brokerage": 0,
            "other_charges": charges,
            "total_charges": charges,
            "final_net": final_net,
        },
        **extra,
    }


def _none(day: str, account: str) -> dict:
    return {"day": day, "broker": "finvasia", "account": account, "status": "no_trade"}


# --- the sheet's formulas ------------------------------------------------------------------


@pytest.mark.parametrize(
    ("algos", "fee"), [(None, 0), (0, 0), (1, 38), (3, 63), (4, 75), (10, 150)]
)
def test_algo_fee_is_the_sheets_roundup(algos, fee):
    # ROUNDUP((algos - 3) * 12.5 + 62.5, 0)
    assert ratios.algo_fee(algos) == Decimal(fee)


def test_a_day_adds_the_accounts_and_takes_off_the_algo_fees(tmp_path):
    _write(
        tmp_path,
        "2026-04-01",
        [_note("2026-04-01", "A1", 1000, 20), _note("2026-04-01", "A2", -300, 15)],
    )
    _manual(tmp_path, "2026-04-01", algos=4, capital_total=500000)
    (row,) = ratios.daily(store.load(tmp_path))
    assert row.net == Decimal(700)
    assert row.algo_fees == Decimal(75)
    assert row.profit == Decimal(625)  # Q = net - O
    assert row.charges == Decimal(110)  # P = notes' charges + O
    assert row.capital == Decimal(500000)


def test_a_day_with_no_note_has_no_profit_and_the_averages_skip_it(tmp_path):
    start = date(2026, 1, 1)
    for i in range(100):
        d = (start + timedelta(days=i)).isoformat()
        line = _none(d, "A1") if i % 2 else _note(d, "A1", 200 if i < 50 else 400, 10)
        _write(tmp_path, d, [line])
        _manual(tmp_path, d, capital_total=100000)
    rows = ratios.daily(store.load(tmp_path))
    assert rows[1].profit is None and rows[1].charges is None
    assert rows[48].avg_profit_50 is None  # 49 rows: not yet
    last = rows[-1]
    assert last.avg_profit_50 == 400  # T: the last 50 rows' notes only
    assert last.avg_profit_100 == 300  # U
    assert last.avg_charges_100 == 10  # V
    assert last.charge_profit_pct == 3.3  # W = V * 100 / U
    assert last.avg_capital_100 == 100000  # Y
    assert last.profit_capital_bps == 30  # Z = U * 10000 / Y


def test_drawdown_and_its_longest_run(tmp_path):
    for d, net in [
        ("2026-04-01", 100),
        ("2026-04-02", -50),
        ("2026-04-03", -30),
        ("2026-04-06", 200),
    ]:
        _write(tmp_path, d, [_note(d, "A1", net, 0)])
    rows = ratios.daily(store.load(tmp_path))
    assert [float(r.drawdown) for r in rows] == [0, -50, -80, 0]
    s = ratios.summary(rows)
    assert s["max_drawdown"] == -80
    assert s["longest_drawdown"] == 2
    assert (s["win_days"], s["loss_days"]) == (2, 2)
    assert s["net"] == 220


def test_capital_is_carried_and_a_per_broker_total_needs_both(tmp_path):
    for d in ["2026-04-01", "2026-04-02", "2026-04-03"]:
        _write(tmp_path, d, [_note(d, "A1", 100)])
    _manual(tmp_path, "2026-04-01", capital_total=300000)
    _manual(tmp_path, "2026-04-02", capital={"angelone": 90000})  # one broker: not a total
    _manual(tmp_path, "2026-04-03", capital={"angelone": 90000, "finvasia": 110000})
    rows = ratios.daily(store.load(tmp_path))
    assert [(float(r.capital), r.capital_source) for r in rows] == [
        (300000, "manual"),
        (300000, "carried"),
        (200000, "manual"),
    ]


def test_months_and_financial_years(tmp_path):
    for d, net in [("2026-03-31", 100), ("2026-04-01", 200), ("2026-05-04", -50)]:
        _write(tmp_path, d, [_note(d, "A1", net, 0)])
        _manual(tmp_path, d, capital_total=10000)
    rows = ratios.daily(store.load(tmp_path))
    assert [(m["month"], m["profit"], m["pct"]) for m in ratios.months(rows)] == [
        ("2026-03", 100.0, 1.0),
        ("2026-04", 200.0, 2.0),
        ("2026-05", -50.0, -0.5),
    ]
    assert [(f["fy"], f["profit"]) for f in ratios.fiscal_years(rows)] == [
        ("2025-26", 100.0),
        ("2026-27", 150.0),
    ]


def test_a_damaged_line_is_reported_not_fatal(tmp_path):
    _write(tmp_path, "2026-04-01", [_note("2026-04-01", "A1", 100)])
    path = tmp_path / "contract-notes" / "days" / "2026-04-01.jsonl"
    path.write_text(path.read_text() + '{"day": "2026-04\x00\x00\n')
    book = store.load(tmp_path)
    assert len(book.lines[date(2026, 4, 1)]) == 1
    assert book.problems == ["days/2026-04-01.jsonl line 2 is damaged"]


# --- round trips ---------------------------------------------------------------------------


def _fill(side, qty, total, time, strike=22400, kind="PE", expiry="2026-04-07"):
    return {
        "instrument": "OPTIDX",
        "underlying": "NIFTY",
        "expiry": expiry,
        "strike": strike,
        "kind": kind,
        "side": side,
        "qty": qty,
        "net_total": total,
        "time": time,
    }


def test_fills_pair_from_flat_to_flat_and_trips_add_up_to_the_note(tmp_path):
    fills = [
        _fill("sell", 75, 3000, "09:17:05"),  # trip 1 opens short
        _fill("buy", 75, -2250, "11:02:40"),  # and closes: +750
        _fill("sell", 75, 2700, "13:00:00"),  # trip 2 opens
        _fill("buy", 75, -3300, "14:10:00"),  # and closes: -600
        _fill("buy", 75, -1500, "10:00:00", strike=22600, kind="CE"),  # long, held to expiry
    ]
    # the fills sum to -1350; the note's other charges are 50 more
    line = _note("2026-04-07", "A1", -1400, 50, trades=fills, trades_check="fills")
    out = trips.line_trips(date(2026, 4, 7), line)
    closed = [t for t in out if t.status == "closed"]
    assert [(t.direction, float(t.pnl), t.entry_time, t.exit_time) for t in closed] == [
        ("short", 750.0, "09:17:05", "11:02:40"),
        ("short", -600.0, "13:00:00", "14:10:00"),
    ]
    assert closed[0].holding_minutes == 105
    (expired,) = [t for t in out if t.status == "expired"]
    assert float(expired.pnl) == -1500 and expired.direction == "long"
    assert sum(t.net for t in out) == Decimal("-1400")  # the note's final net
    assert all(t.dte == 0 for t in out)


def test_a_contract_not_closed_before_its_expiry_is_open_with_no_pnl():
    line = _note(
        "2026-04-06",
        "A1",
        990,
        10,
        trades=[_fill("sell", 75, 1000, "09:30:00")],
        trades_check="fills",
    )
    (t,) = trips.line_trips(date(2026, 4, 6), line)
    assert t.status == "open" and t.pnl is None and t.dte == 1


def test_summary_rows_pair_by_side_without_times():
    rows = [
        {**_fill("sell", 150, 6000, None), "time": None},
        {**_fill("buy", 150, -4500, None), "time": None},
    ]
    line = _note("2026-04-01", "A1", 1480, 20, trades=rows, trades_check="summary")
    (t,) = trips.line_trips(date(2026, 4, 1), line)
    assert (t.status, t.direction, float(t.pnl), t.entry_time) == ("closed", None, 1500.0, None)
    assert t.net == Decimal("1480")


def test_unmatched_trades_give_no_trips():
    line = _note(
        "2026-04-01", "A1", 100, trades=[_fill("sell", 75, 1, "09:30:00")], trades_check="unmatched"
    )
    assert trips.line_trips(date(2026, 4, 1), line) == []


def test_weekdays_between_skips_the_weekend():
    assert trips.weekdays_between(date(2026, 10, 23), date(2026, 10, 27)) == 2  # Fri -> Tue
    assert trips.weekdays_between(date(2026, 10, 27), date(2026, 10, 27)) == 0


def test_turnover_by_financial_year():
    line = _note(
        "2026-04-07",
        "A1",
        140,
        10,
        trades=[_fill("sell", 75, 300, "09:17:00"), _fill("buy", 75, -150, "10:00:00")],
        trades_check="fills",
    )
    out = trips.turnover(trips.line_trips(date(2026, 4, 7), line))
    assert out == {"2026-27": {"turnover": 150.0, "profit": 150.0, "charges": 10.0, "trips": 1}}


# --- sources -------------------------------------------------------------------------------


def _capture(root: Path, day: str, rows: list[dict]) -> None:
    path = root / "rotation" / "live" / f"{day}.jsonl"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("".join(json.dumps({"kind": "strategy", "day": day, **r}) + "\n" for r in rows))


def _trip(day="2026-10-21", strike=22400.0, entry="09:17:05", broker="finvasia"):
    return trips.Trip(
        day=date.fromisoformat(day),
        broker=broker,
        account="A1",
        underlying="NIFTY",
        instrument="OPTIDX",
        expiry=date(2026, 10, 27),
        strike=strike,
        kind="PE",
        direction="short",
        qty=75,
        entry_time=entry,
        exit_time="11:00:00",
        entry_price=40.0,
        exit_price=30.0,
        pnl=Decimal(750),
        charges=Decimal(10),
        status="closed",
        fills=2,
        source_check="fills",
        dte=4,
    )


def test_sources(tmp_path):
    sources._capture.cache_clear()
    fill = {
        "symbol": "NIFTY26O2722400PE",
        "side": "S",
        "qty": 75,
        "entry": {"price": 40, "at": "2026-10-21T09:17:30+05:30"},
        "exit": None,
    }
    _capture(
        tmp_path,
        "2026-10-21",
        [
            {
                "broker": "finvasia",
                "traded": True,
                "source": "tool",
                "book": "t1",
                "name": "T1 · x",
                "fills": [fill],
            },
        ],
    )
    assert sources.source_of(tmp_path, _trip())["source"] == "t1"
    assert sources.source_of(tmp_path, _trip(strike=22500.0))["source"] == "manual"
    assert sources.source_of(tmp_path, _trip(entry="10:30:00"))["source"] == "manual"
    assert sources.source_of(tmp_path, _trip(day="2026-10-16"))["source"] == "unknown"
    _capture(
        tmp_path,
        "2026-10-22",
        [
            {
                "broker": "finvasia",
                "traded": True,
                "source": "discretionary",
                "name": "mine",
                "fills": None,
            },
        ],
    )
    assert sources.source_of(tmp_path, _trip(day="2026-10-22"))["source"] == "unattributed"


# --- the routes ----------------------------------------------------------------------------


def test_routes_read_and_the_inputs_route_writes(tmp_path, monkeypatch):
    from fastapi.testclient import TestClient

    from option_backtesting.api import contract_notes_routes
    from option_backtesting.api.app import create_app

    monkeypatch.setenv("TRADING_DATA_ROOT", str(tmp_path))
    contract_notes_routes._clear()
    _write(tmp_path, "2026-04-01", [_note("2026-04-01", "A1", 1000, 20)])
    client = TestClient(create_app())
    body = client.get("/legwise/contract-notes/summary").json()
    assert body["summary"]["net"] == 1000
    r = client.put(
        "/legwise/contract-notes/inputs/2026-04-01", json={"algos": 4, "capital_total": 200000}
    )
    assert r.status_code == 200
    days = client.get("/legwise/contract-notes/days").json()["days"]
    assert (days[0]["algo_fees"], days[0]["profit"], days[0]["capital"]) == (75.0, 925.0, 200000.0)
    assert (
        client.put("/legwise/contract-notes/inputs/2026-04-01", json={"algos": -1}).status_code
        == 422
    )
    assert (
        client.put("/legwise/contract-notes/inputs/2026-04-01", json={"note": "x"}).status_code
        == 422
    )
    assert client.get("/legwise/contract-notes/days?from=x").status_code == 422
    r = client.put("/legwise/contract-notes/inputs/2026-04-01", json={"algos": None})
    assert "algos" not in r.json()["manual"]
