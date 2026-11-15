"""BL-227: the options overlay engine on synthetic chains (no lake needed)."""

import numpy as np
import pandas as pd
import pytest

from momentum_backtesting import options_overlay as ov

D0, D1, D2 = pd.Timestamp("2024-01-05"), pd.Timestamp("2024-01-12"), pd.Timestamp("2024-01-19")
NEAR, NEXT = pd.Timestamp("2024-01-25"), pd.Timestamp("2024-02-29")
SESSIONS = pd.bdate_range("2024-01-01", "2024-03-29")
ARR = np.array(SESSIONS, dtype="datetime64[ns]")


def _rows(day, expiry, strikes, right, price, oi=100_000, contracts=10, symbol="ABC"):
    return pd.DataFrame({
        "date": day, "symbol": symbol, "expiry": expiry, "strike": strikes,
        "option_type": right, "close": price, "settle": price, "contracts": contracts, "oi": oi,
    })  # fmt: skip


def _chain(day, *, exit_price=None, strikes=(90.0, 95.0, 100.0, 105.0, 110.0), lot=100):
    near = _rows(day, NEAR, list(strikes), "CE", 5.0)
    nxt = _rows(day, NEXT, list(strikes), "CE", 8.0 if exit_price is None else exit_price)
    puts = _rows(day, NEXT, list(strikes), "PE", 6.0 if exit_price is None else exit_price)
    return pd.concat([near, nxt, puts], ignore_index=True)


def _lots(lot=100, days=(D0, D1, D2)):
    idx = pd.MultiIndex.from_tuples([(d, "ABC", e) for d in days for e in (NEAR, NEXT)])
    return pd.Series(lot, index=idx, dtype=float)


SPOTS = pd.DataFrame({"ABC": [101.0, 104.0, 99.0]}, index=[D0, D1, D2])


def _run(leg, settings, chains, lots=None):
    counts = ov.BookCounts()
    trades = ov.run_leg(leg, settings, [D0, D1], chains, SPOTS, lots if lots is not None else
                        _lots(), set(), ARR, counts)  # fmt: skip
    return trades, counts


def test_expiry_needs_ten_sessions_and_strikes_count_outward():
    chains = {(D0, "ABC"): _chain(D0), (D1, "ABC"): _chain(D1, exit_price=12.0)}
    # NEAR (2024-01-25) is 14 sessions after D0, NEXT further: with 15 needed, NEXT is bought
    s = ov.Settings(moneyness="OTM1", min_sessions_left=15)
    trades, _ = _run(ov.Leg(picks={D0: ["ABC"]}, right="CE"), s, chains)
    assert trades[0]["expiry"] == NEXT and trades[0]["strike"] == 105.0  # ATM 100, one up
    trades, _ = _run(ov.Leg(picks={D0: ["ABC|PE"]}, right="CE"), s, chains)
    assert trades[0]["right"] == "PE" and trades[0]["strike"] == 95.0  # one down for a put
    s = ov.Settings(moneyness="ATM", min_sessions_left=10)
    trades, _ = _run(ov.Leg(picks={D0: ["ABC"]}, right="CE"), s, chains)
    assert trades[0]["expiry"] == NEAR


def test_sizing_one_lot_premium_and_pnl():
    chains = {(D0, "ABC"): _chain(D0), (D1, "ABC"): _chain(D1, exit_price=12.0)}
    s = ov.Settings(moneyness="ATM", min_sessions_left=15, slippage=0.0)
    (t,), _ = _run(ov.Leg(picks={D0: ["ABC"]}, right="CE"), s, chains)
    assert (
        t["lots"] == 1 and t["buy"] == pytest.approx(800.0) and t["sell"] == pytest.approx(1200.0)
    )
    assert t["pnl"] == pytest.approx(400.0 - ov.costs(800.0, 1200.0, D1))
    (t,), _ = _run(ov.Leg(picks={D0: ["ABC"]}, right="CE", per_stock=4000.0), s, chains)
    assert t["lots"] == 5
    two, _ = _run(ov.Leg(picks={D0: ["ABC", "ABC"]}, right="CE", weekly_total=3200.0), s, chains)
    assert [x["lots"] for x in two] == [2, 2]  # 3200 over two picks = 1600 a stock = 2 lots
    # a skipped pick (not a stock) does not take a share of the week's budget
    (t,), _ = _run(ov.Leg(picks={D0: ["ABC", "GOLD"]}, right="CE", weekly_total=1600.0), s, chains)
    assert t["lots"] == 2
    trades, counts = _run(ov.Leg(picks={D0: ["ABC"]}, right="CE", per_stock=300.0), s, chains)
    assert trades == [] and counts.too_dear == 1


def test_thin_nan_premium_and_non_stock_are_skipped_and_counted():
    thin = _chain(D0)
    thin["oi"] = 500  # under 10 lots of 100
    chains = {(D0, "ABC"): thin, (D1, "ABC"): _chain(D1)}
    trades, counts = _run(ov.Leg(picks={D0: ["ABC", "GOLD"]}, right="CE"), ov.Settings(), chains)
    assert trades == [] and counts.thin == 1 and counts.not_a_stock == 1
    nan = _chain(D0)
    nan["close"] = np.nan
    nan["settle"] = np.nan
    trades, counts = _run(ov.Leg(picks={D0: ["ABC"]}, right="CE"), ov.Settings(),
                          {(D0, "ABC"): nan, (D1, "ABC"): _chain(D1)})  # fmt: skip
    assert trades == [] and counts.no_contract == 1


def test_a_restruck_contract_is_followed_and_a_vanished_one_booked_at_zero():
    s = ov.Settings(moneyness="ATM", min_sessions_left=15, slippage=0.0)
    # a 1:1 bonus between entry and exit: strikes halve, the lot doubles
    after = _chain(D1, exit_price=5.0, strikes=(45.0, 47.5, 50.0, 52.5, 55.0))
    lots = pd.concat([_lots(100, (D0,)), _lots(200, (D1,))])
    (t,), counts = _run(ov.Leg(picks={D0: ["ABC"]}, right="CE"), s,
                        {(D0, "ABC"): _chain(D0), (D1, "ABC"): after}, lots)  # fmt: skip
    assert t["exit_how"] == "restruck" and counts.restruck == 1
    assert t["sell"] == pytest.approx(5.0 * 200)  # 200 new shares at 5, against 100 at 8
    (t,), counts = _run(ov.Leg(picks={D0: ["ABC"]}, right="CE"), s, {(D0, "ABC"): _chain(D0)})
    assert t["exit_how"] == "zero" and t["sell"] == 0 and counts.zero_booked == 1


def test_tax_is_taken_at_the_year_end_with_losses_carried():
    weeks = [pd.Timestamp("2023-03-24"), pd.Timestamp("2023-03-31"), pd.Timestamp("2024-03-29")]
    trades = pd.DataFrame({"exit": weeks, "pnl": [-100.0, 50.0, 200.0]})
    w = ov.weekly_pnl(trades, weeks, tax=True)
    assert w["tax"].iloc[1] == 0  # FY2022 lost 50: carried
    assert w["tax"].iloc[2] == pytest.approx(ov.TAX_RATE * 150)
    assert ov.weekly_pnl(trades, weeks, tax=False)["tax"].sum() == 0


def test_settings_are_validated():
    with pytest.raises(ValueError):
        ov.Settings(sizing="capital_share", sizing_value=None).validate()
    with pytest.raises(ValueError):
        ov.Settings(moneyness="ITM1").validate()
    ov.Settings(sizing="capital_share", sizing_value=0.2).validate()


def test_mirror_and_weak_lists_tilt_with_the_market():
    idx = pd.date_range("2020-01-03", periods=80, freq="W-FRI")
    rng = np.random.default_rng(3)
    steps = rng.normal(0, 0.01, size=(80, 8)) - 0.02
    falling = pd.DataFrame(100 * np.exp(np.cumsum(steps, axis=0)), index=idx,
                           columns=[f"S{i}" for i in range(8)])  # fmt: skip
    member = pd.DataFrame(True, index=idx, columns=falling.columns)
    late = [x for w in idx[55:] for x in ov.mirror_list(falling, member, {}, 3)[w]]
    assert late and all(x.endswith("|PE") for x in late)
    assert any(ov.weak_list(falling, member, {}, 3)[w] for w in idx[55:])
    assert ov.breadth(falling, member).iloc[-1] < 0.4


def test_the_api_runs_as_a_job_and_refuses_calls_without_a_strategy():
    import time

    from fastapi.testclient import TestClient

    from momentum_backtesting import api

    client = TestClient(api.create_app())
    job = client.post("/api/options-overlay/jobs", json={"direction": "calls"})
    assert job.status_code == 202
    for _ in range(50):
        state = client.get(f"/api/options-overlay/jobs/{job.json()['id']}").json()
        if state["status"] != "running":
            break
        time.sleep(0.05)
    assert state["status"] == "failed" and state["error_status"] == 422
    assert "Pick a strategy" in state["error"]
    assert client.post("/api/options-overlay/jobs", json={"moneyness": "ITM1"}).status_code == 422
    assert client.get("/api/options-overlay/jobs/nope").status_code == 404


def test_two_sleeves_buying_one_contract_are_one_position():
    row = {
        "entry": D0,
        "exit": D1,
        "symbol": "ABC",
        "right": "CE",
        "leg": "calls",
        "expiry": NEXT,
        "strike": 100.0,
        "lot": 100,
        "lots": 1,
        "p0": 8.0,
        "p1": 12.0,
        "exit_how": "same",
        "buy": 800.0,
        "sell": 1200.0,
        "costs": 50.0,
        "pnl": 350.0,
    }
    other = {**row, "symbol": "XYZ"}
    merged = ov.merge_positions(pd.DataFrame([row, row, other]))
    assert len(merged) == 2
    abc = merged[merged["symbol"] == "ABC"].iloc[0]
    assert abc["lots"] == 2 and abc["pnl"] == 700.0 and abc["p0"] == 8.0


def test_profit_booking_takes_out_its_share_and_sizes_on_the_account():
    chains = {(D0, "ABC"): _chain(D0), (D1, "ABC"): _chain(D1, exit_price=12.0)}
    s = ov.Settings(moneyness="ATM", min_sessions_left=15, slippage=0.0, capital=1000.0,
                    profit_step=300.0, withdraw_share=0.75)  # fmt: skip
    leg = ov.Leg(picks={D0: ["ABC"]}, right="CE")
    counts = ov.BookCounts()
    trades, booking = ov.run_booked([leg], s, [D0, D1], chains, SPOTS, _lots(), set(), ARR, counts)
    pnl = trades[0]["pnl"]  # 400 less costs: one whole 300 step
    assert booking["taken"][D1] == pytest.approx(0.75 * 300)
    assert booking["account"][D1] == pytest.approx(1000 + pnl - 225)
    assert booking["events"][0] == {"day": "2024-01-12", "kind": "out", "amount_rs": 225,
                                    "account_rs": round(1000 + pnl - 225)}  # fmt: skip
    # an account that cannot pay for one lot (800) buys nothing
    poor = ov.Settings(moneyness="ATM", min_sessions_left=15, slippage=0.0, capital=500.0,
                       profit_step=300.0)  # fmt: skip
    counts = ov.BookCounts()
    trades, _ = ov.run_booked([leg], poor, [D0, D1], chains, SPOTS, _lots(), set(), ARR, counts)
    assert trades == [] and counts.no_capital == 1


def test_refill_moves_taken_out_money_back_when_a_lot_is_too_dear():
    # week 1 gains (booked out), week 2 loses (account under capital), week 3's pick costs more
    # than the account holds: money taken out goes back in, up to capital
    d3 = pd.Timestamp("2024-01-26")
    chains = {
        (D0, "ABC"): _chain(D0),  # buy at 8
        (D1, "ABC"): _chain(D1, exit_price=12.0),  # sell at 12, buy again at 12
        (D2, "ABC"): _chain(D2, exit_price=3.0),  # sell at 3
        (D2, "XYZ"): _chain(D2, exit_price=6.0).assign(symbol="XYZ"),  # one lot 600
        (d3, "XYZ"): _chain(d3, exit_price=6.0).assign(symbol="XYZ"),
    }
    spots = pd.DataFrame({"ABC": [101.0, 104.0, 99.0, 99.0], "XYZ": [100.0] * 4},
                         index=[D0, D1, D2, d3])  # fmt: skip
    idx = [(d, sym, e) for d in (D0, D1, D2, d3) for sym in ("ABC", "XYZ") for e in (NEAR, NEXT)]
    lots = pd.Series(100.0, index=pd.MultiIndex.from_tuples(idx))
    leg = ov.Leg(picks={D0: ["ABC"], D1: ["ABC"], D2: ["XYZ"]}, right="CE")

    def run(refill: bool):
        s = ov.Settings(moneyness="ATM", min_sessions_left=15, slippage=0.0, capital=1300.0,
                        profit_step=100.0, withdraw_share=1.0, refill=refill)  # fmt: skip
        return ov.run_booked([leg], s, [D0, D1, D2, d3], chains, spots, lots, set(), ARR,
                             ov.BookCounts())  # fmt: skip

    trades, booking = run(True)
    kinds = [e["kind"] for e in booking["events"]]
    assert kinds[0] == "out" and kinds[-1] == "in"
    back = booking["events"][-1]
    assert back["day"] == "2024-01-19" and back["account_rs"] <= 1300
    assert [t["symbol"] for t in trades] == ["ABC", "ABC", "XYZ"]  # week 3 traded
    trades, booking = run(False)
    assert [t["symbol"] for t in trades] == ["ABC", "ABC"]
    assert all(e["kind"] == "out" for e in booking["events"])
