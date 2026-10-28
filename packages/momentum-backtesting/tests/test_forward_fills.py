"""BL-024 Phase 3: real Kite fills, from the contract notes, booked to lots through the ledger and
reconciled against each lot's journalled signal."""

import json

import pytest

from momentum_backtesting import forward_fills

W1, W2 = "2026-10-16", "2026-10-23"


def _note(tmp_path, day, trades, charges, broker="kite"):
    folder = tmp_path / "contract-notes" / "days"
    folder.mkdir(parents=True, exist_ok=True)
    line = {
        "day": day,
        "broker": broker,
        "account": "BZ0001",
        "status": "note",
        "eq": {"total_charges": charges},
        "trades": [
            {"symbol": s, "side": side, "qty": q, "price": p, "time": t}
            for s, side, q, p, t in trades
        ],
    }
    with (folder / f"{day}.jsonl").open("a") as handle:
        handle.write(json.dumps(line) + "\n")


def _row(entry_id, week, sleeve, target, rows, on_cadence, at):
    return {
        "entry_id": entry_id,
        "recorded_at": at,
        "week": week,
        "run_kind": "final",
        "source": "favourite",
        "config_id": sleeve,
        "config_name": sleeve,
        "dataset": "broad",
        "settings": "{}",
        "code_commit": "x",
        "holdings_before": "{}",
        "signal": json.dumps(
            {
                "target_weights": target,
                "rows": rows,
                "rebalance": {"on_cadence": on_cadence},
            }
        ),
    }


def test_kite_fills_share_the_notes_charges_by_value_and_skip_other_brokers(tmp_path):
    _note(
        tmp_path,
        "2026-10-19",
        [("A", "buy", 10, 100.0, "09:58:00"), ("B", "buy", 30, 100.0, "09:59:00")],
        4.0,
    )
    _note(tmp_path, "2026-10-19", [("X", "buy", 1, 1.0, "10:00:00")], 9.0, broker="finvasia")
    fills, notes = forward_fills.kite_fills(tmp_path)
    assert [(f.symbol, f.charges) for f in fills] == [("A", 1.0), ("B", 3.0)]
    assert notes == [{"day": "2026-10-19", "account": "BZ0001", "charges": 4.0, "value": 4000.0}]


def test_fills_are_booked_first_in_first_out_and_the_rest_are_outside_the_lots(tmp_path):
    _note(
        tmp_path,
        "2026-10-19",
        [("A", "buy", 10, 100.0, "09:58:00"), ("Z", "buy", 5, 20.0, "09:59:00")],
        0.0,
    )
    _note(tmp_path, "2026-10-22", [("A", "buy", 4, 90.0, "09:40:00")], 0.0)
    _note(
        tmp_path,
        "2026-10-23",
        [("A", "buy", 6, 80.0, "14:30:00"), ("A", "buy", 1, 81.0, "14:35:00")],
        0.0,
    )
    fills, notes = forward_fills.kite_fills(tmp_path)
    events = [
        {
            "sleeve_id": "s1",
            "symbol": "A",
            "delta": 10.0,
            "kind": "seed",
            "at": "2026-10-21T08:55:00+05:30",
            "note": None,
        },
        {
            "sleeve_id": "s1",
            "symbol": "A",
            "delta": 4.0,
            "kind": "attributed",
            "at": "2026-10-23T14:25:00+05:30",
            "note": None,
        },
    ]
    journal = [
        _row(
            1, W1, "s1", {"A": 1.0}, [{"asset": "A", "action": "BUY"}], True, "2026-10-16T14:00:00Z"
        ),
        _row(
            2, W2, "s2", {"A": 1.0}, [{"asset": "A", "action": "BUY"}], True, "2026-10-24T05:00:00Z"
        ),
    ]
    orders = [
        {
            "week": W2,
            "created_at": "2026-10-23T14:25:44+05:30",
            "lots": [
                {
                    "id": "s2",
                    "label": "Lot 2",
                    "budget": 500.0,
                    "plan": {"rows": [{"symbol": "A", "quantity": 6, "price": 79.0}]},
                }
            ],
        }
    ]
    out = forward_fills.reconcile(
        journal_rows=journal,
        lot_sleeves={"s1": "Lot 1", "s2": "Lot 2"},
        events=events,
        planned={"s2": {"A": 6.0}},
        planned_at="2026-10-23T14:25:05+05:30",
        orders=orders,
        fills=fills,
        notes=notes,
        raw_prices={
            ("A", W1): (99.0, 100.0),
            ("A", "2026-10-19"): (101.0, 98.0),
            ("A", W2): (78.0, 80.0),
        },
        next_session={W1: "2026-10-19"},
        paper_start=W1,
        lot_size=1000.0,
    )
    first, second = out["rebalances"]
    assert (first["lot"], first["week"], first["new_lot"]) == ("Lot 1", W1, True)
    row = first["rows"][0]
    # 10 on the first day measured against Friday's close (paid 0, i.e. 0 bps), 4 later counted.
    assert (row["shares"], row["shares_first_day"], row["shares_later"]) == (14.0, 10.0, 4.0)
    assert row["vs_close_bps"] == pytest.approx(0.0)
    assert row["vs_open_bps"] == pytest.approx(-99.0099, abs=1e-3)
    assert row["model_shares"] == 10 and row["status"] == "done"
    lot2 = second["rows"][0]
    assert second["booked_pending"] and lot2["booked"] == [forward_fills.NOT_BOOKED]
    assert (lot2["shares"], lot2["plan_shares"], lot2["status"]) == (6.0, 6.0, "done")
    assert lot2["vs_plan_bps"] == pytest.approx((80 - 79) / 79 * 10000)
    outside = {(o["symbol"], o["qty"]) for o in out["outside_lots"]}
    assert outside == {("Z", 5.0), ("A", 1.0)}


def test_a_target_never_bought_is_missed_and_an_unasked_buy_is_extra(tmp_path):
    _note(tmp_path, "2026-10-19", [("B", "buy", 2, 50.0, "10:00:00")], 0.0)
    fills, notes = forward_fills.kite_fills(tmp_path)
    out = forward_fills.reconcile(
        journal_rows=[
            _row(
                1,
                W1,
                "s1",
                {"A": 1.0},
                [{"asset": "A", "action": "BUY"}],
                True,
                "2026-10-16T14:00:00Z",
            )
        ],
        lot_sleeves={"s1": "Lot 1"},
        events=[
            {
                "sleeve_id": "s1",
                "symbol": "B",
                "delta": 2.0,
                "kind": "seed",
                "at": "2026-10-21T08:55:00+05:30",
                "note": "B replaces A (premium)",
            }
        ],
        planned={},
        planned_at="",
        orders=[],
        fills=fills,
        notes=notes,
        raw_prices={},
        next_session={},
        paper_start=W1,
        lot_size=1000.0,
    )
    rows = {r["symbol"]: r for r in out["rebalances"][0]["rows"]}
    assert rows["A"]["status"] == "missed"
    assert rows["B"]["status"] == "extra"
    assert rows["B"]["note"] == "B replaces A (premium)"
