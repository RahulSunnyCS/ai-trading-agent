"""Friday's orders planned early (owner, 2026-11-05): the same plan the 14:15 run makes, kept in
the state dir only, shown on This week before Friday and sent on Thursday evening. Nothing in the
catalog changes: no orders row, no lot event, no pending lot."""

import json
import time

import pytest
from fastapi.testclient import TestClient
from test_lot_orders import (  # noqa: F401 - _ticking_clock is the module's autouse clock
    LOT1,
    OUTSIDE,
    OWNER,
    _everything_stored,
    _friday,
    _setup,
    _snapshot,
    _ticking_clock,
)

from momentum_backtesting import api, holdings_store, lots, this_week
from momentum_backtesting.db_read import open_catalog


@pytest.fixture
def client():
    return TestClient(api.create_app())


def _paper_headline(client, monkeypatch):
    run = client.post(
        "/api/saved-runs",
        json={
            "dataset": "broad",
            "name": "Broad headline",
            "config": {"dataset": "broad", "signal_delay": 1},
            "kpis": {},
            "dates": [],
            "strategy": [],
        },
    ).json()
    client.patch(f"/api/saved-runs/{run['id']}", json={"active": True})
    prices = {"AAA": 100.0, "BBB": 200.0}
    symbols = {"AAA": "NSE:AAA-EQ", "BBB": "NSE:BBB-EQ"}
    signal = {
        "week": "2026-11-06",
        "weights": {},
        "target_weights": {"AAA": 0.5, "BBB": 0.5},
        "rows": [],
        "sleeves": [],
    }
    monkeypatch.setattr(api, "_orders_signal", lambda *a: (signal, "exact", None, ["ranking"]))
    monkeypatch.setattr(api, "_strategy_symbols", lambda rankings, today: (prices, symbols))
    monkeypatch.setattr(
        api,
        "_order_prices",
        lambda stored, symbols, names: ({n: prices[n] for n in names if n in prices}, "last close"),
    )
    return run


def _wait(jobs):
    for _ in range(200):
        job = jobs.latest()
        if job and job["status"] != "running":
            return job
        time.sleep(0.02)
    raise AssertionError("the job did not finish")


def test_tentative_orders_plan_the_paper_portfolio_and_save_nothing_in_the_catalog(
    client, monkeypatch
):
    _paper_headline(client, monkeypatch)
    _friday(monkeypatch, 2026, 11, 5)  # a Thursday: the coming Friday is the 6th

    payload = api.tentative_orders()
    assert payload["tentative"] is True and payload["made_at"].startswith("2026-11-05")
    assert payload["week"] == "2026-11-06" and payload["kind"] == "exact"
    assert "created_at" not in payload
    bought = {r["symbol"] for r in payload["plan"]["rows"] if r["quantity"]}
    assert bought == {"AAA", "BBB"}
    with open_catalog() as con:
        assert holdings_store.orders_for(con, OWNER, "2026-11-06") == []
    saved = json.loads(api.tentative_path().read_text())
    assert saved["week"] == "2026-11-06" and saved["tentative"] is True

    # This week reads it beside the (empty) orders of the week, and only for that week.
    view = client.get("/api/orders").json()
    assert view["orders"] == [] and view["tentative"]["week"] == "2026-11-06"
    assert api.read_tentative("2026-11-13") is None

    # The Thursday message is a tentative heading over the 14:15 body, never 'action required'.
    note = api._tentative_message(payload)
    assert note.title.startswith("Friday's orders (tentative) — Broad headline — 06 Nov 2026")
    assert note.body.startswith("Tentative, planned Thu")
    assert "BUY AAA" in note.body and note.severity == "info"

    # The page's button runs the same plan as a background job.
    started = client.post("/api/orders/tentative/run")
    assert started.status_code == 202 and started.json()["started"] is True
    job = _wait(api.TENTATIVE_JOBS)
    assert job["status"] == "done", job["error"]
    assert client.get("/api/orders").json()["tentative_job"]["status"] == "done"


def test_a_broken_or_missing_file_is_no_tentative_orders(client, monkeypatch):
    assert api.read_tentative("2026-11-06") is None
    this_week.state_dir().mkdir(parents=True, exist_ok=True)
    api.tentative_path().write_text("{not json")
    assert api.read_tentative("2026-11-06") is None
    assert client.get("/api/orders").json()["tentative"] is None


def test_a_tentative_lot_plan_books_nothing_and_leaves_the_friday_run_unchanged(
    client, monkeypatch
):
    """The Kite + lots path: on the Friday itself a real run would book Kite's top-up to lot 1,
    move the pending lot and save the orders. The tentative plan shows the same lots and the
    booking it would make, and writes none of it; the real run afterwards does exactly what it
    would have done."""
    gid, ids = _setup(client, monkeypatch, 1, "2026-10-23")
    with open_catalog() as con:
        lots.append(
            con,
            OWNER,
            gid,
            [
                {"sleeve_id": ids[0], "symbol": r["symbol"], "delta": r["quantity"], "kind": "seed"}
                for r in LOT1
            ],
            "2026-10-20T12:25:13+05:30",
        )
        lots.set_pending(con, OWNER, gid, ids[0], "2026-10-20T12:25:13+05:30")
    _friday(monkeypatch, 2026, 10, 23)
    _snapshot([{**r, "quantity": r["quantity"] + 2} for r in LOT1] + OUTSIDE, 60_000.0)
    before = _everything_stored()

    payload = api.tentative_orders(save=False)
    assert payload["tentative"] is True and "created_at" not in payload
    assert {lot["label"] for lot in payload["lots"]} == {"Lot 1", "Lot 2"}
    assert {(e["sleeve_id"], e["symbol"]) for e in payload["ledger"]["booked"]} == {
        (ids[0], r["symbol"]) for r in LOT1
    }
    assert _everything_stored() == before
    with open_catalog() as con:
        assert lots.pending(con, OWNER, gid) == ids[0]
        assert holdings_store.orders_for(con, OWNER, "2026-10-23") == []
    assert not api.tentative_path().exists()

    payload = api._compute_orders("scheduled")
    assert {(e["sleeve_id"], e["symbol"]) for e in payload["ledger"]["booked"]} == {
        (ids[0], r["symbol"]) for r in LOT1
    }
    with open_catalog() as con:
        assert lots.pending(con, OWNER, gid) == ids[1]
        assert len(holdings_store.orders_for(con, OWNER, "2026-10-23")) == 1
