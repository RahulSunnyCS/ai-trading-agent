"""BL-142 Phases 2-3: the lot ledger's rules and the per-lot orders."""

import pytest

from momentum_backtesting import lots
from momentum_backtesting.db_read import open_catalog

L1, L2, L3 = "sleeve-1", "sleeve-2", "sleeve-3"


def _allowed(**by_lot):
    return {k: set(v) for k, v in by_lot.items()}


def test_a_top_up_of_a_name_the_pending_lot_holds_is_booked_to_it():
    ledger = {L1: {"CUPID": 28.0, "NAZARA": 24.0}}
    got = lots.reconcile(
        {"CUPID": 35.0, "NAZARA": 24.0}, ledger, L1, _allowed(**{L1: {"CUPID", "NAZARA"}})
    )
    assert got.unexplained == []
    assert got.events == [{"sleeve_id": L1, "symbol": "CUPID", "delta": 7.0, "kind": "attributed"}]
    assert lots.apply(ledger, got.events)[L1] == {"CUPID": 35.0, "NAZARA": 24.0}


def test_a_new_lots_purchases_are_booked_to_the_lot_whose_orders_were_last_made():
    ledger = {L1: {"CUPID": 28.0}}
    held = {"CUPID": 28.0 + 40, "NAZARA": 33.0, "ACMESOLAR": 33.0}  # Monday's lot 2 buys
    got = lots.reconcile(held, ledger, L2, _allowed(**{L2: {"CUPID", "NAZARA", "ACMESOLAR"}}))
    assert got.unexplained == []
    booked = {(e["sleeve_id"], e["symbol"]): e["delta"] for e in got.events}
    assert booked == {(L2, "CUPID"): 40.0, (L2, "NAZARA"): 33.0, (L2, "ACMESOLAR"): 33.0}


def test_a_purchase_outside_every_lots_names_is_not_guessed():
    got = lots.reconcile({"SBIN": 10.0}, {L1: {"CUPID": 5.0}}, L1, _allowed(**{L1: {"CUPID"}}))
    # CUPID is also gone from Kite (held has no CUPID): that sale is booked, the SBIN buy is not
    assert [(u["symbol"], u["delta"]) for u in got.unexplained] == [("SBIN", 10.0)]
    assert got.events == [{"sleeve_id": L1, "symbol": "CUPID", "delta": -5.0, "kind": "attributed"}]


def test_with_no_pending_lot_a_purchase_is_unexplained():
    got = lots.reconcile({"CUPID": 5.0}, {}, None, {})
    assert got.events == [] and got.unexplained[0]["symbol"] == "CUPID"


def test_a_sale_is_booked_to_the_pending_lot_even_when_two_lots_hold_the_name():
    ledger = {L1: {"CUPID": 28.0}, L2: {"CUPID": 40.0}}
    got = lots.reconcile({"CUPID": 50.0}, ledger, L2, _allowed(**{L2: {"CUPID"}}))
    assert got.events == [
        {"sleeve_id": L2, "symbol": "CUPID", "delta": -18.0, "kind": "attributed"}
    ]


def test_a_sale_of_a_name_several_lots_hold_is_not_guessed_when_the_pending_lot_lacks_it():
    ledger = {L1: {"CUPID": 28.0}, L2: {"CUPID": 40.0}}
    got = lots.reconcile({"CUPID": 60.0}, ledger, L3, _allowed(**{L3: {"NAZARA"}}))
    assert got.events == [] and got.unexplained[0]["reason"].startswith("sold, and several")


def test_selling_more_than_the_lot_holds_books_what_it_holds_and_flags_the_rest():
    got = lots.reconcile({}, {L1: {"CUPID": 10.0}}, L1, _allowed(**{L1: {"CUPID"}}))
    assert got.events[0]["delta"] == -10.0 and got.unexplained == []
    got = lots.reconcile({}, {L1: {"CUPID": 10.0}, L2: {"CUPID": 5.0}}, L1, {})
    assert got.events == [
        {"sleeve_id": L1, "symbol": "CUPID", "delta": -10.0, "kind": "attributed"}
    ]
    assert got.unexplained == [
        {"symbol": "CUPID", "delta": -5.0, "reason": "sold more than the lot holds"}
    ]


def test_the_ledger_is_stored_summed_and_cleared(tmp_path):
    with open_catalog() as con:
        assert not lots.has_ledger(con, "rahul", "g")
        lots.append(
            con,
            "rahul",
            "g",
            [
                {"sleeve_id": L1, "symbol": "CUPID", "delta": 28.0, "kind": "seed", "note": "n"},
                {"sleeve_id": L1, "symbol": "CUPID", "delta": 7.0, "kind": "attributed"},
                {"sleeve_id": L1, "symbol": "NAZARA", "delta": 24.0, "kind": "seed"},
                {"sleeve_id": L1, "symbol": "NAZARA", "delta": -24.0, "kind": "attributed"},
            ],
            "2026-10-20T12:25:13+05:30",
        )
        assert lots.positions(con, "rahul", "g") == {L1: {"CUPID": 35.0}}  # NAZARA netted to zero
        assert lots.positions(con, "rahul", "other") == {}
        lots.set_pending(con, "rahul", "g", L2, "2026-10-23T14:15:00+05:30")
        lots.set_pending(con, "rahul", "g", L3, "2026-10-30T14:15:00+05:30")
        assert lots.pending(con, "rahul", "g") == L3
        assert len(lots.history(con, "rahul", "g")) == 4
        lots.clear(con, "rahul", "g")
        assert lots.positions(con, "rahul", "g") == {} and lots.pending(con, "rahul", "g") is None


# --------------------------------------------------------------------------------- the orders

PRICES = {
    "CUPID": 338.0,
    "NAZARA": 404.0,
    "ACMESOLAR": 408.0,
    "GRWRHITECH": 6796.0,
    "RATEGAIN": 800.0,
}
NAME_OF = {s: s for s in PRICES}


def _lot(sid, label, *, due, positions, target, next_due=None):
    return lots.Lot(sid, label, f"Sleeve {label}", due, next_due, positions, target)


def _plan(lot_list, free_cash, **kw):
    return lots.plan_lots(
        lot_list,
        name_of=NAME_OF,
        prices=PRICES,
        free_cash=free_cash,
        lot_size=kw.pop("lot_size", 50_000.0),
        min_trade_rs=10_000.0,
        **kw,
    )


LOT1 = _lot(
    "s1",
    "Lot 1",
    due=False,
    next_due="2026-11-13",
    positions={"CUPID": 28.0, "NAZARA": 24.0, "RATEGAIN": 12.0, "GRWRHITECH": 1.0},
    target={"CUPID": 0.25, "NAZARA": 0.25, "RATEGAIN": 0.25, "GRWRHITECH": 0.25},
)
LOT2 = _lot(
    "s2",
    "Lot 2",
    due=True,
    positions={},
    next_due="2026-11-20",
    target={"CUPID": 0.25, "NAZARA": 0.25, "ACMESOLAR": 0.25, "GRWRHITECH": 0.25},
)


def test_a_new_lot_is_funded_with_the_lot_size_and_says_what_to_add_to_kite():
    got = _plan([LOT1, LOT2], 4_509.0)
    new = next(lot for lot in got["lots"] if lot["id"] == "s2")
    assert new["status"] == "new" and new["budget"] == 50_000.0
    assert got["deposit_needed"] == pytest.approx(45_491.0)
    # the cash the orders spend counts what the owner adds: nothing is "short" afterwards
    assert got["plan"]["cash"] == pytest.approx(50_000.0) and got["plan"]["cash_after"] >= 0
    bought = {r["symbol"]: r["quantity"] for r in new["plan"]["rows"]}
    assert bought == {"ACMESOLAR": 30, "CUPID": 36, "GRWRHITECH": 1, "NAZARA": 30}
    # lot 1 is not due and nothing forces an exit: it trades nothing
    lot1 = next(lot for lot in got["lots"] if lot["id"] == "s1")
    assert lot1["status"] == "not due" and lot1["plan"] is None and lot1["next"] == "2026-11-13"
    assert all(r["lot"] == "Lot 2" for r in got["plan"]["rows"])


def test_a_new_lot_uses_all_free_cash_when_that_is_more_than_the_lot_size():
    got = _plan([LOT1, LOT2], 54_509.0)
    new = next(lot for lot in got["lots"] if lot["id"] == "s2")
    assert new["budget"] == 54_509.0 and got["deposit_needed"] == 0.0
    assert {r["symbol"]: r["quantity"] for r in new["plan"]["rows"]}["GRWRHITECH"] == 2


def test_a_lot_that_is_not_due_never_sells_a_swap_or_trims_drift():
    # lot 1 holds GRWRHITECH in place of a name its sleeve's model holds (the owner's swap):
    # the model target has no GRWRHITECH, and that is not a reason to sell it off-calendar
    swapped = _lot(
        "s1",
        "Lot 1",
        due=False,
        positions=LOT1.positions,
        target={"CUPID": 0.4, "NAZARA": 0.3, "RATEGAIN": 0.3},
    )
    got = _plan([swapped], 0.0)
    only = got["lots"][0]
    assert only["status"] == "not due" and only["plan"] is None


def test_a_lot_that_is_not_due_sells_only_what_its_sleeve_marks_sell():
    leaving = lots.Lot(
        "s1",
        "Lot 1",
        "Sleeve Lot 1",
        False,
        "2026-11-13",
        dict(LOT1.positions),
        {"CUPID": 0.5, "NAZARA": 0.5},
        frozenset({"RATEGAIN"}),
    )
    got = _plan([leaving], 0.0)
    only = got["lots"][0]
    assert only["status"] == "exit"
    assert [(r["action"], r["symbol"], r["quantity"]) for r in only["plan"]["rows"]] == [
        ("SELL", "RATEGAIN", 12)
    ]  # not GRWRHITECH (no longer in the target) and no CUPID / NAZARA drift trades


def test_a_rebalancing_lot_gets_its_own_shares_plus_the_free_cash():
    due = _lot(
        "s1", "Lot 1", due=True, positions=LOT1.positions, target={"CUPID": 0.5, "NAZARA": 0.5}
    )
    got = _plan([due], 20_000.0)
    lot = got["lots"][0]
    assert lot["status"] == "rebalance" and lot["budget"] == 20_000.0
    actions = {r["symbol"]: r["action"] for r in lot["plan"]["rows"]}
    assert actions["RATEGAIN"] == "SELL" and actions["GRWRHITECH"] == "SELL"
    assert got["deposit_needed"] == 0.0


def test_shares_in_a_symbol_the_strategy_cannot_hold_are_left_alone():
    lot = _lot(
        "s1", "Lot 1", due=True, positions={"CUPID": 10.0, "20MICRONS": 50.0}, target={"CUPID": 1.0}
    )
    got = _plan([lot], 0.0)
    assert got["lots"][0]["outside"] == ["20MICRONS"]
    assert all(r["symbol"] != "20MICRONS" for r in got["plan"]["rows"])


def test_net_by_symbol_adds_buys_and_takes_off_sells_across_lots():
    plan = {
        "rows": [
            {"symbol": "CUPID", "action": "BUY", "quantity": 10},
            {"symbol": "CUPID", "action": "SELL", "quantity": 4},
            {"symbol": "NAZARA", "action": "SELL", "quantity": 5},
            {"symbol": "NAZARA", "action": "BUY", "quantity": 5},
            {"symbol": "X", "action": "SKIP", "quantity": 0},
        ]
    }
    assert lots.net_by_symbol(plan) == {"CUPID": 6}
