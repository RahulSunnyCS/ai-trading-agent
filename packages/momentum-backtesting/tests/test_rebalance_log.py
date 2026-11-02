"""BL-200: the rebalance log built over the fills reconciliation (pure)."""

from __future__ import annotations

from momentum_backtesting import rebalance_log as rl

START = "2026-10-16"


def _row(symbol, status, *, shares=None, side="buy", plan=None, price=None, avg=None):
    return {
        "symbol": symbol,
        "status": status,
        "side": side,
        "shares": shares,
        "shares_first_day": shares,
        "avg_first_day": avg,
        "shares_later": None,
        "avg_later": None,
        "plan_shares": plan,
        "plan_price": price,
        "model_shares": None,
        "friday_close": None,
    }


def _rebalance(week, lot, sleeve, rows, session=None):
    return {
        "week": week,
        "lot": lot,
        "sleeve_id": sleeve,
        "rows": rows,
        "next_session": session,
        "new_lot": True,
        "first_trade_day": week,
        "orders_at": None,
        "totals": {"real_charges": 10.0},
    }


def _build(rebalances, *, through="2026-11-10", events=None, **kw):
    groups = [{"group_id": "g", "name": "Four", "rebalances": rebalances, "outside_lots": []}]
    out = rl.build(
        groups,
        {"g": events or []},
        paper_start=START,
        notes_through=through,
        lots_per_group={"g": 4},
        **kw,
    )
    return {b["week"]: b for b in out["groups"][0]["blocks"]}


def test_week_numbers_count_fridays_from_the_paper_start():
    assert rl.week_number("2026-10-16", START) == 1
    assert rl.week_number("2026-10-23", START) == 2
    assert rl.week_number("2026-11-13", START) == 5


def test_status_done_partly_and_the_lines_net_per_stock():
    blocks = _build(
        [
            _rebalance("2026-10-16", "Lot 1", "a", [_row("NAZARA", "done", shares=33, avg=400)]),
            _rebalance(
                "2026-10-23",
                "Lot 2",
                "b",
                [
                    _row("CUPID", "done", shares=42, avg=310),
                    _row("THELEELA", "missed", plan=21, price=578),
                    _row("HELD", "held"),
                ],
            ),
        ]
    )
    assert blocks["2026-10-16"]["status"] == rl.DONE
    week2 = blocks["2026-10-23"]
    assert week2["status"] == rl.PARTLY
    assert [line["symbol"] for line in week2["lines"]] == ["CUPID", "THELEELA"]  # held: no trade
    assert week2["lines"][0]["value"] == 42 * 310
    assert week2["lines"][1]["shares"] is None and week2["lines"][1]["planned_shares"] == 21
    assert week2["bought"] == 42 * 310


def test_nothing_traded_waits_for_the_monday_notes_then_is_not_done_and_folded():
    rebalance = _rebalance("2026-10-30", "Lot 3", "c", [_row("NAZARA", "missed", plan=23)])
    waiting = _build([rebalance], through="2026-11-01")["2026-10-30"]
    assert waiting["status"] == rl.WAITING and waiting["folded_into"] is None
    missed = _build([rebalance], through="2026-11-02")["2026-10-30"]
    assert missed["status"] == rl.NOT_DONE
    # no later due week stored yet: the lot's next turn, four Fridays on
    assert missed["folded_into"] == {"week": "2026-11-27", "week_no": 7, "scheduled": True}


def test_a_missed_week_folds_into_the_lots_next_stored_due_week():
    blocks = _build(
        [
            _rebalance("2026-10-30", "Lot 3", "c", [_row("NAZARA", "missed", plan=23)]),
            _rebalance("2026-11-27", "Lot 3", "c", [_row("NAZARA", "done", shares=23, avg=1)]),
        ]
    )
    assert blocks["2026-10-30"]["folded_into"] == {
        "week": "2026-11-27",
        "week_no": 7,
        "scheduled": False,
    }


def test_holding_after_is_the_ledger_before_the_friday_plus_the_weeks_fills():
    events = [
        {"sleeve_id": "a", "symbol": "NAZARA", "delta": 33, "at": "2026-10-23T14:20"},
        {"sleeve_id": "a", "symbol": "CUPID", "delta": 40, "at": "2026-10-23T14:20"},
        {"sleeve_id": "b", "symbol": "OTHER", "delta": 5, "at": "2026-10-23T14:20"},
        {"sleeve_id": "a", "symbol": "LATER", "delta": 9, "at": "2026-11-13T14:30"},
    ]
    week5 = _rebalance(
        "2026-11-13",
        "Lot 1",
        "a",
        [
            _row("CUPID", "done", shares=40, side="sell", avg=330),
            _row("ACME", "done", shares=10, avg=370),
        ],
    )
    block = _build([week5], events=events)["2026-11-13"]
    assert block["holding_after"] == [
        {"symbol": "ACME", "shares": 10},
        {"symbol": "NAZARA", "shares": 33.0},
    ]
    assert block["sold"] == 40 * 330 and block["bought"] == 10 * 370


def test_blocks_are_newest_first_and_filtered_by_date():
    out = _build(
        [
            _rebalance("2026-10-16", "Lot 1", "a", [_row("N", "done", shares=1, avg=1)]),
            _rebalance("2026-10-23", "Lot 2", "b", [_row("N", "done", shares=1, avg=1)]),
        ],
        start="2026-10-20",
    )
    assert list(out) == ["2026-10-23"]


def test_notes_through_reads_the_kite_mailbox_check():
    cursor = {
        "me|kite/BZ1": {"checked_at": "2026-11-02T10:00:10.564Z"},  # 15:30 IST: not 2 Nov's note
        "me|angelone/R1": {"checked_at": "2026-11-03T10:00:00Z"},
    }
    assert rl.notes_through(cursor) == "2026-11-01"
    cursor["me|kite/BZ1"]["checked_at"] = "2026-11-02T18:30:00Z"  # 00:00 IST on 3 Nov
    assert rl.notes_through(cursor) == "2026-11-02"
    assert rl.notes_through({}, "2026-10-23") == "2026-10-23"


def test_no_paper_start_gives_no_groups():
    assert rl.build([], {}, paper_start=None, notes_through=None, lots_per_group={})["groups"] == []


def test_the_route_passes_the_dates_and_refuses_a_bad_one(monkeypatch):
    from fastapi.testclient import TestClient

    from momentum_backtesting import api, forward_run

    seen = {}

    def fake(start=None, end=None):
        seen.update(start=start, end=end)
        return {"paper_start": START, "notes_through": None, "groups": []}

    monkeypatch.setattr(forward_run, "rebalance_log", fake)
    client = TestClient(api.create_app())
    got = client.get("/api/lots/rebalances", params={"from": "2026-10-01", "to": "2026-11-30"})
    assert got.status_code == 200 and got.json()["groups"] == []
    assert seen == {"start": "2026-10-01", "end": "2026-11-30"}
    assert client.get("/api/lots/rebalances", params={"from": "Oct"}).status_code == 422


def test_kite_check_compares_the_snapshot_with_what_the_lots_hold_now():
    events = [{"sleeve_id": "c", "symbol": "LEDGERONLY", "delta": 4, "at": "2026-10-10T14:00"}]
    rebalances = [
        _rebalance("2026-10-16", "Lot 1", "a", [_row("NAZARA", "done", shares=33, avg=1)]),
        _rebalance("2026-10-23", "Lot 2", "b", [_row("NAZARA", "done", shares=33, avg=1)]),
    ]
    groups = [{"group_id": "g", "name": "F", "rebalances": rebalances, "outside_lots": []}]
    kite = {
        "synced_at": "2026-11-02T22:17",
        "cash": 40000.0,
        "holdings": {"NAZARA": 66, "LEDGERONLY": 4, "GRWRHITECH": 1},
    }
    out = rl.build(
        groups,
        {"g": events},
        paper_start=START,
        notes_through="2026-11-10",
        lots_per_group={"g": 4},
        kite=kite,
        start="2026-10-20",  # the date filter does not hide what a lot holds now
    )
    check = out["kite_check"]
    assert check["differences"] == [{"symbol": "GRWRHITECH", "kite": 1, "lots": 0.0}]
    assert check["matches"] is False and check["cash"] == 40000.0
    assert rl.kite_check(None, {}) is None


def test_shares_that_differ_from_the_orders_leave_the_week_partly_done():
    block = _build(
        [
            _rebalance(
                "2026-10-23",
                "Lot 2",
                "b",
                [_row("ACME", "shares differ", shares=30, plan=35, avg=1)],
            )
        ]
    )["2026-10-23"]
    assert block["status"] == rl.PARTLY


def test_an_owners_correction_after_the_block_counts_in_the_kite_check():
    events = [
        # booked after the Friday: a seed books the week's own fills (already counted)...
        {
            "sleeve_id": "a",
            "symbol": "NAZARA",
            "delta": 33,
            "at": "2026-10-21T08:55",
            "kind": "seed",
        },
        # ...an assignment is the owner's correction, and clears the difference
        {
            "sleeve_id": "a",
            "symbol": "GRWRHITECH",
            "delta": 1,
            "at": "2026-11-03T09:00",
            "kind": "assigned",
        },
    ]
    rebalances = [
        _rebalance("2026-10-16", "Lot 1", "a", [_row("NAZARA", "done", shares=33, avg=1)])
    ]
    groups = [{"group_id": "g", "name": "F", "rebalances": rebalances, "outside_lots": []}]
    kite = {"synced_at": "x", "cash": 1.0, "holdings": {"NAZARA": 33, "GRWRHITECH": 1}}
    out = rl.build(
        groups,
        {"g": events},
        paper_start=START,
        notes_through="2026-11-10",
        lots_per_group={"g": 4},
        kite=kite,
    )
    assert out["kite_check"]["matches"] is True
