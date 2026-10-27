"""BL-142 Phase 3: a favourite group followed lot by lot against the Kite holdings. The Friday run
books what changed in Kite to a lot, then plans every lot on its own."""

import time
from datetime import datetime

import pytest
from fastapi.testclient import TestClient

from momentum_backtesting import api, holdings_store, lots, notify, runs_store, this_week
from momentum_backtesting.db_read import open_catalog

OWNER = "rahul"
PRICES = {
    "CUPID": 338.0,
    "NAZARA": 404.0,
    "ACMESOLAR": 408.0,
    "GRWRHITECH": 6796.0,
    "RATEGAIN": 790.0,
    "Nasdaq 100": 240.0,
}
SYMBOLS = {name: f"NSE:{name}-EQ" for name in PRICES if name != "Nasdaq 100"}
SYMBOLS["Nasdaq 100"] = "NSE:MON100-EQ"


@pytest.fixture
def client():
    return TestClient(api.create_app())


_DAY = ["2026-10-21"]  # the date the stored snapshots and orders carry: the pinned Friday


def _friday(monkeypatch, year, month, day):
    _DAY[0] = f"{year}-{month:02d}-{day:02d}"

    class Fixed(datetime):
        @classmethod
        def now(cls, tz=None):
            return datetime(year, month, day, 14, 15, tzinfo=tz or notify.IST)

    monkeypatch.setattr(api, "datetime", Fixed)


def _group(client):
    """Two sleeves ("Friday 4 of 4" decided 16 Oct, "Friday 1 of 4" decided 23 Oct) as one group,
    invested and the headline."""
    ids = []
    for name, offset in (("Test · Friday 4 of 4", 3), ("Test · Friday 1 of 4", 0)):
        config = {
            "dataset": "broad",
            "universe": ["broad_momentum"],
            "top_n": 5,
            "rebalance": "weekly",
            "rebalance_every": 4,
            "rebalance_offset": offset,
            "signal_delay": 1,
        }
        run = client.post(
            "/api/saved-runs",
            json={
                "dataset": "broad",
                "name": name,
                "config": config,
                "kpis": {},
                "dates": [],
                "strategy": [],
            },
        ).json()
        ids.append(run["id"])
    with open_catalog() as con:
        group = runs_store.create_group(con, "Test", ids)
        runs_store.update_run(con, group["id"], status="invested")
        runs_store.update_run(con, group["id"], active=True)
    return group["id"], ids


def _signal(week, ids, due_id):
    sleeves = []
    for sid, name, target in (
        (
            ids[0],
            "Test · Friday 4 of 4",
            {"CUPID": 0.25, "NAZARA": 0.25, "RATEGAIN": 0.25, "Nasdaq 100": 0.25},
        ),
        (
            ids[1],
            "Test · Friday 1 of 4",
            {"CUPID": 0.25, "NAZARA": 0.25, "ACMESOLAR": 0.25, "GRWRHITECH": 0.25},
        ),
    ):
        due = sid == due_id
        nxt = {ids[0]: "2026-11-13", ids[1]: "2026-11-20"}[sid]
        sleeves.append(
            {
                "id": sid,
                "name": name,
                "signal": {
                    "week": week,
                    "weights": {},
                    "target_weights": target,
                    "rows": [],
                    "rebalance": {"on_cadence": due, "every": 4, "next": nxt},
                },
            }
        )
    union = {n: 0.25 for n in ("CUPID", "NAZARA", "ACMESOLAR", "GRWRHITECH")}
    return {
        "week": week,
        "weights": {},
        "target_weights": union,
        "rows": [],
        "sleeves": [],
        "_sleeves": sleeves,
    }


def _setup(client, monkeypatch, due_id_index, week):
    gid, ids = _group(client)
    sig = _signal(week, ids, ids[due_id_index])
    monkeypatch.setattr(api, "_orders_signal", lambda *a: (sig, "exact", None, ["ranking"]))
    monkeypatch.setattr(api, "_strategy_symbols", lambda rankings, today: (PRICES, SYMBOLS))
    monkeypatch.setattr(
        api,
        "_order_prices",
        lambda stored, symbols, names: ({n: PRICES[n] for n in names if n in PRICES}, "last close"),
    )
    monkeypatch.setattr(this_week, "paper_start", lambda *a, **k: "2026-10-16")
    client.put("/api/orders/settings", json={"holdings_source": "kite"})
    return gid, ids


@pytest.fixture(autouse=True)
def _ticking_clock(monkeypatch):
    """Every stored snapshot and orders row gets its own second (a real run is never twice in
    one: both are keyed on it)."""
    _DAY[0] = "2026-10-21"
    ticks = iter(range(1, 10_000))

    def now() -> str:
        n = next(ticks)
        return f"{_DAY[0]}T10:{n // 60:02d}:{n % 60:02d}+05:30"

    monkeypatch.setattr(holdings_store, "_now", now)


def _snapshot(rows, cash):
    with open_catalog() as con:
        holdings_store.save_holdings(con, OWNER, "kite", rows, cash=cash)


LOT1 = [
    {"symbol": "CUPID", "quantity": 28.0},
    {"symbol": "NAZARA", "quantity": 24.0},
    {"symbol": "RATEGAIN", "quantity": 12.0},
    {"symbol": "GRWRHITECH", "quantity": 1.0},
]
OUTSIDE = [{"symbol": "20MICRONS", "quantity": 50.0}, {"symbol": "LIQUIDBEES", "quantity": 9.0}]


def test_without_lots_the_run_says_to_seed_them_and_plans_nothing(client, monkeypatch):
    _friday(monkeypatch, 2026, 10, 23)
    _setup(client, monkeypatch, 1, "2026-10-23")
    _snapshot(LOT1, 4509.3)
    payload = api._compute_orders("scheduled")
    assert "plan" not in payload and "mbt lots seed" in payload["reason"]
    note = api._orders_message(payload)
    assert note.severity == "warn" and "mbt lots seed" in note.body


def test_friday_23_oct_buys_a_new_lot_2_and_leaves_lot_1_alone(client, monkeypatch):
    _friday(monkeypatch, 2026, 10, 23)
    gid, ids = _setup(client, monkeypatch, 1, "2026-10-23")
    _snapshot(LOT1 + OUTSIDE, 4509.3)
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

    payload = api._compute_orders("scheduled")
    by_label = {lot["label"]: lot for lot in payload["lots"]}
    assert sorted(by_label) == ["Lot 1", "Lot 2"]
    assert by_label["Lot 1"]["status"] == "not due" and by_label["Lot 1"]["plan"] is None
    assert by_label["Lot 1"]["next"] == "2026-11-13"
    lot2 = by_label["Lot 2"]
    assert lot2["status"] == "new" and lot2["budget"] == 50_000.0
    assert {r["symbol"]: r["quantity"] for r in lot2["plan"]["rows"]} == {
        "ACMESOLAR": 30,
        "CUPID": 36,
        "GRWRHITECH": 1,
        "NAZARA": 30,
    }
    assert payload["deposit_needed"] == pytest.approx(45_490.7)
    assert payload["ledger"]["unexplained"] == [] and payload["ledger"]["booked"] == []
    assert payload["holdings"]["outside"] == ["20MICRONS"]  # yours to handle, never a lot's
    assert payload["holdings"]["excluded"] == ["LIQUIDBEES"]
    assert all(row["lot"] == "Lot 2" for row in payload["plan"]["rows"])

    note = api._orders_message(payload)
    assert note.type == "momentum.orders" and note.severity == "action_required"
    assert (
        "Lot 2 · NEW lot · ₹50,000" in note.body
        and "Lot 1 · not due · next Fri 13 Nov" in note.body
    )
    assert "• BUY CUPID 36 sh" in note.body and "Add ₹45,491 to Kite" in note.body
    # the next change in Kite is lot 2's: the run on the Friday moved the pending lot
    with open_catalog() as con:
        assert lots.pending(con, OWNER, gid) == ids[1]
        stored = holdings_store.orders_for(con, OWNER, "2026-10-23")
    assert stored and stored[0]["lots"][1]["label"] == "Lot 2"


def test_a_top_up_before_friday_is_booked_to_lot_1_and_monday_s_buys_to_lot_2(client, monkeypatch):
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
    # the owner sold 20MICRONS and put it into lot 1's names; the lot-1 top-up reaches the ledger
    topped = [
        {"symbol": "CUPID", "quantity": 34.0},
        {"symbol": "NAZARA", "quantity": 29.0},
        {"symbol": "RATEGAIN", "quantity": 14.0},
        {"symbol": "GRWRHITECH", "quantity": 2.0},
    ]
    _friday(monkeypatch, 2026, 10, 23)
    _snapshot(topped, 1200.0)
    first = api._compute_orders("scheduled")
    booked = {(e["sleeve_id"], e["symbol"]): e["delta"] for e in first["ledger"]["booked"]}
    assert booked == {
        (ids[0], "CUPID"): 6.0,
        (ids[0], "NAZARA"): 5.0,
        (ids[0], "RATEGAIN"): 2.0,
        (ids[0], "GRWRHITECH"): 1.0,
    }
    assert first["ledger"]["unexplained"] == []

    # Monday 26 Oct: lot 2's buys; Friday 30 Oct's run books them to lot 2 (the pending lot)
    monday = [
        {"symbol": "CUPID", "quantity": 34.0 + 36},
        {"symbol": "NAZARA", "quantity": 29.0 + 30},
        {"symbol": "RATEGAIN", "quantity": 14.0},
        {"symbol": "GRWRHITECH", "quantity": 3.0},
        {"symbol": "ACMESOLAR", "quantity": 30.0},
    ]
    _friday(monkeypatch, 2026, 10, 30)
    _snapshot(monday, 6000.0)
    second = api._compute_orders("scheduled")
    booked = {(e["sleeve_id"], e["symbol"]): e["delta"] for e in second["ledger"]["booked"]}
    assert booked == {
        (ids[1], "CUPID"): 36.0,
        (ids[1], "NAZARA"): 30.0,
        (ids[1], "GRWRHITECH"): 1.0,
        (ids[1], "ACMESOLAR"): 30.0,
    }
    with open_catalog() as con:
        ledger = lots.positions(con, OWNER, gid)
    assert ledger[ids[0]]["CUPID"] == 34.0 and ledger[ids[1]]["CUPID"] == 36.0

    # running it again changes nothing: the ledger already matches Kite
    again = api._compute_orders("manual")
    assert again["ledger"]["booked"] == [] and again["ledger"]["unexplained"] == []


def test_a_purchase_no_lot_can_hold_is_reported_not_booked(client, monkeypatch):
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
    _snapshot(LOT1 + [{"symbol": "ACMESOLAR", "quantity": 5.0}], 4509.3)  # lot 1 cannot hold it
    payload = api._compute_orders("scheduled")
    assert [(u["symbol"], u["delta"]) for u in payload["ledger"]["unexplained"]] == [
        ("ACMESOLAR", 5.0)
    ]
    assert payload["ledger"]["booked"] == []
    assert "Not in any lot" in api._orders_message(payload).body
    # the owner books it: mbt lots assign ACMESOLAR --lot 2
    got = api.assign_lot("ACMESOLAR", "2")
    assert got == {"lot": "Lot 2", "symbol": "ACMESOLAR", "delta": 5.0}
    with open_catalog() as con:
        assert lots.positions(con, OWNER, gid)[ids[1]] == {"ACMESOLAR": 5.0}
    assert api._compute_orders("manual")["ledger"]["unexplained"] == []
    with pytest.raises(ValueError, match="No such lot"):
        api.assign_lot("ACMESOLAR", "9")


def test_lots_status_lists_each_lot_and_what_kite_holds_beyond_them(client, monkeypatch):
    gid, ids = _setup(client, monkeypatch, 1, "2026-10-23")
    with open_catalog() as con:
        lots.append(
            con,
            OWNER,
            gid,
            [{"sleeve_id": ids[0], "symbol": "CUPID", "delta": 28.0, "kind": "seed"}],
            "2026-10-20T12:25:13+05:30",
        )
        lots.set_pending(con, OWNER, gid, ids[0], "2026-10-20T12:25:13+05:30")
    _snapshot(
        [{"symbol": "CUPID", "quantity": 30.0}, {"symbol": "LIQUIDBEES", "quantity": 4.0}], 1.0
    )
    got = api.lots_status()
    assert got["lots"]["Lot 1"]["holds"] == {"CUPID": 28.0} and got["lots"]["Lot 2"]["holds"] == {}
    assert got["pending"] == "Lot 1"
    assert got["not_in_a_lot"] == {"CUPID": 2.0}  # LIQUIDBEES is margin: never listed


def test_seeding_books_the_strategys_holdings_to_the_lot_of_that_fridays_sleeve(
    client, monkeypatch
):
    gid, ids = _setup(client, monkeypatch, 1, "2026-10-23")
    monkeypatch.setattr(api, "_broad_ranking", lambda req: object())
    _snapshot(LOT1 + OUTSIDE, 4509.3)
    with pytest.raises(ValueError, match="not a Friday"):
        api.seed_lots(week="2026-10-20")
    got = api.seed_lots(week="2026-10-16", note="GRWRHITECH replaces Nasdaq 100 (premium)")
    assert got["lot"] == "Lot 1" and got["sleeve"].endswith("Friday 4 of 4")
    assert got["booked"] == {"CUPID": 28.0, "GRWRHITECH": 1.0, "NAZARA": 24.0, "RATEGAIN": 12.0}
    assert got["left_out"] == ["20MICRONS", "LIQUIDBEES"]  # outside the strategy / options margin
    with open_catalog() as con:
        assert lots.positions(con, OWNER, gid)[ids[0]]["CUPID"] == 28.0
        assert lots.pending(con, OWNER, gid) == ids[0]
        assert {e["note"] for e in lots.history(con, OWNER, gid)} == {
            "GRWRHITECH replaces Nasdaq 100 (premium)"
        }
    with pytest.raises(ValueError, match="already exist"):
        api.seed_lots(week="2026-10-16")
    assert api.seed_lots(week="2026-10-16", replace=True)["lot"] == "Lot 1"
    with open_catalog() as con:
        assert len(lots.history(con, OWNER, gid)) == 4  # replaced, not doubled


def test_a_run_on_an_old_snapshot_does_not_move_the_pending_lot(client, monkeypatch):
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
    _snapshot(LOT1, 4509.3)  # read on the 21st
    _friday(monkeypatch, 2026, 10, 23)  # the run is on the 23rd: Kite was not read today
    payload = api._compute_orders("manual")
    assert payload["ledger"]["stale"] is True
    assert "log in and press Sync" in api._orders_message(payload).body
    with open_catalog() as con:
        assert lots.pending(con, OWNER, gid) == ids[0]  # still lot 1: Monday's trades unseen


def test_the_friday_run_stores_what_each_lot_was_told_to_trade(client, monkeypatch):
    gid, ids = _setup(client, monkeypatch, 1, "2026-10-23")
    _friday(monkeypatch, 2026, 10, 23)
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
    _snapshot(LOT1, 4509.3)
    api._compute_orders("scheduled")
    with open_catalog() as con:
        pending_id, planned = lots.pending_state(con, OWNER, gid)
    assert pending_id == ids[1]
    assert planned == {ids[1]: {"ACMESOLAR": 30, "CUPID": 36, "GRWRHITECH": 1, "NAZARA": 30}}


def test_a_symbol_that_drops_out_of_the_strategy_data_keeps_its_shares_in_the_lot(
    client, monkeypatch
):
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
    _snapshot(LOT1, 4509.3)
    # RATEGAIN has no price or rank today: the strategy's symbol map lacks it, Kite still holds it
    narrowed = {k: v for k, v in SYMBOLS.items() if k != "RATEGAIN"}
    monkeypatch.setattr(api, "_strategy_symbols", lambda rankings, today: (PRICES, narrowed))
    payload = api._compute_orders("scheduled")
    assert payload["ledger"]["booked"] == [] and payload["ledger"]["unexplained"] == []
    with open_catalog() as con:
        assert lots.positions(con, OWNER, gid)[ids[0]]["RATEGAIN"] == 12.0


def _everything_stored() -> tuple[dict, dict]:
    """Every row of every catalog table (orders, lot ledger and state, holdings, settings, rules,
    saved runs, the forward journal, ...) and every file in the state folder (messages, paper
    start, live rules, alerts) with its bytes."""
    with open_catalog() as con:
        tables = [
            name
            for (name,) in con.execute(
                "SELECT table_name FROM information_schema.tables "
                "WHERE table_type = 'BASE TABLE' ORDER BY table_name"
            ).fetchall()
        ]
        rows = {
            # as text: a TIMESTAMPTZ fetched as a Python value needs pytz
            t: sorted(map(repr, con.execute(f'SELECT COLUMNS(*)::VARCHAR FROM "{t}"').fetchall()))
            for t in tables
        }
    state = this_week.state_dir()
    files = {
        str(path.relative_to(state)): path.read_bytes()
        for path in sorted(state.rglob("*"))
        if path.is_file()
    }
    return rows, files


def _preview(client, favourite_id):
    job = client.post("/api/orders/preview/jobs", json={"favourite": favourite_id})
    assert job.status_code == 202
    job_id = job.json()["id"]
    for _ in range(500):
        got = client.get(f"/api/orders/preview/jobs/{job_id}").json()
        if got["status"] != "running":
            return got
        time.sleep(0.02)
    raise AssertionError("the preview job did not finish")


def test_a_preview_for_a_favourite_writes_nothing_and_leaves_the_friday_run_unchanged(
    client, monkeypatch
):
    """Your orders' "Preview for…": on the very Friday a real run would book Kite's changes to the
    lots, move the pending lot and save the orders, the preview stores nothing at all, and the real
    run afterwards does exactly what it would have done without it."""
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
    # A top-up the real run would book to lot 1, on a snapshot read today (so it moves the lot).
    _snapshot([{**r, "quantity": r["quantity"] + 2} for r in LOT1] + OUTSIDE, 60_000.0)
    this_week.state_dir().mkdir(parents=True, exist_ok=True)
    (this_week.state_dir() / "weekly_messages.json").write_text('[{"title": "kept"}]')
    before = _everything_stored()

    got = _preview(client, gid)
    assert got["status"] == "done", got["error"]
    result = got["result"]
    assert result["preview"] is True and "created_at" not in result
    assert result["headline"]["id"] == gid
    assert "lots" not in result and "ledger" not in result  # one portfolio, never lot by lot
    assert result["holdings"]["source"] == "kite"
    assert result["holdings"]["outside"] == ["20MICRONS"]
    assert "ACMESOLAR" in {r["symbol"] for r in result["plan"]["rows"] if r["quantity"]}
    assert _everything_stored() == before
    with open_catalog() as con:
        assert holdings_store.orders_for(con, OWNER, "2026-10-23") == []

    # An unknown favourite is a reason, not an error, and still writes nothing.
    missing = _preview(client, "nope")
    assert missing["status"] == "done" and "No favourite matches" in missing["result"]["error"]
    assert _everything_stored() == before

    # The real Friday run afterwards books and plans exactly as it would have.
    payload = api._compute_orders("scheduled")
    assert {(e["sleeve_id"], e["symbol"]) for e in payload["ledger"]["booked"]} == {
        (ids[0], r["symbol"]) for r in LOT1
    }
    with open_catalog() as con:
        assert lots.pending(con, OWNER, gid) == ids[1]
        assert len(holdings_store.orders_for(con, OWNER, "2026-10-23")) == 1


def test_the_preview_route_refuses_a_malformed_favourite(client):
    assert client.post("/api/orders/preview/jobs", json={"favourite": "../x"}).status_code == 422
    assert client.get("/api/orders/preview/jobs/unknown").status_code == 404
