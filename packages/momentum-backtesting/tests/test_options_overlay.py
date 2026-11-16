"""BL-227: the options overlay engine on synthetic chains (no lake needed)."""

from dataclasses import replace

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


def test_sessions_to_an_expiry_past_the_lakes_last_day_go_on_in_weekdays():
    # the lake holds days to 2024-03-08; an entry on 2024-03-01 has 5 more sessions in it and the
    # weekdays 03-11 .. 03-28 (14) to the expiry. Counted in the lake alone it would have 5 and
    # every expiry of the last weeks would be refused.
    sessions = np.array(pd.bdate_range("2024-01-01", "2024-03-08"), dtype="datetime64[ns]")
    day, far = pd.Timestamp("2024-03-01"), np.datetime64("2024-03-28", "ns")
    assert ov._sessions_to(sessions, day, far) == 19
    assert ov._sessions_to(sessions, day, np.datetime64("2024-03-06", "ns")) == 3  # inside it
    rows = pd.DataFrame({"expiry": [pd.Timestamp("2024-03-28")]})
    assert ov._expiry(rows, day, sessions, 19) == pd.Timestamp("2024-03-28")
    assert ov._expiry(rows, day, sessions, 20) is None


def test_the_contract_lives_to_the_exit_day_whatever_min_sessions_left_says():
    # an expiry 3 sessions out would lapse before the exit 5 sessions out and be booked at nothing
    early = pd.Timestamp("2024-01-10")
    strikes = [90.0, 95.0, 100.0, 105.0, 110.0]
    rows = pd.concat([_rows(D0, early, strikes, "CE", 5.0), _chain(D0)], ignore_index=True)
    chains = {(D0, "ABC"): rows, (D1, "ABC"): _chain(D1, exit_price=12.0)}
    lots = pd.Series(100, index=pd.MultiIndex.from_tuples(
        [(D0, "ABC", e) for e in (early, NEAR, NEXT)]), dtype=float)  # fmt: skip
    s = ov.Settings(moneyness="ATM", min_sessions_left=1, slippage=0.0)
    (t,), _ = _run(ov.Leg(picks={D0: ["ABC"]}, right="CE"), s, chains, lots)
    assert t["expiry"] == NEAR  # not the 2024-01-10 contract


def test_the_lake_cache_key_moves_with_the_shared_data_version(tmp_path, monkeypatch):
    from momentum_backtesting import db_read

    (tmp_path / "date=2024-03-01").mkdir()
    monkeypatch.setattr(ov, "_fo_dir", lambda: tmp_path)
    version = {"now": ("bars", 1)}
    monkeypatch.setattr(db_read, "data_version", lambda root=None: version["now"])
    lake = ov.Lake()
    first = lake.version
    assert lake.remember("k", lambda: "old") == "old"
    assert lake.remember("k", lambda: "never") == "old"  # same data: served from the cache
    version["now"] = ("bars", 2)  # a stock-bar top-up: no new F&O day
    assert lake.version != first and lake.newest == "2024-03-01"
    assert lake.remember("k", lambda: "new") == "new"  # the cache was emptied


def test_a_favourites_digest_follows_its_saved_settings(monkeypatch):
    from momentum_backtesting import overlay_runs as runs

    record = {"id": "f", "members": [{"config": {"lookbacks": [4, 13]}}]}
    monkeypatch.setattr(runs, "_favourite", lambda fid: record)
    before = runs._digest("f")
    record["members"][0]["config"]["lookbacks"] = [4, 26]
    assert runs._digest("f") != before and runs._digest(None) is None

    def gone(fid):
        raise LookupError(fid)

    monkeypatch.setattr(runs, "_favourite", gone)
    assert runs._digest("f") is None


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
        ov.Settings(moneyness="ITM5").validate()
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
    assert client.post("/api/options-overlay/jobs", json={"moneyness": "ITM5"}).status_code == 422
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


def test_a_custom_strategy_is_a_valid_broad_request_on_fno_stocks():
    from momentum_backtesting import api, overlay_runs

    cfg = overlay_runs.custom_config(
        {"lookbacks": [26, 4, 52], "top_n": 8, "exit_rank": 16, "rebalance": "fortnightly"}
    )
    req = api.BacktestRequest(**{**cfg, "start": "2020-01-01", "end": None})
    assert req.broad_universe == "fno" and req.broad_category_mode == "off"
    assert req.lookbacks == [4, 26, 52] and req.broad_off_top_n == 8
    assert req.rebalance == "weekly" and req.rebalance_every == 2
    assert overlay_runs.held_n(cfg) == 8
    for bad in ({"lookbacks": [3]}, {"lookbacks": [4], "top_n": 10, "exit_rank": 5},
                {"lookbacks": [4], "rebalance": "daily"}):  # fmt: skip
        with pytest.raises(ValueError):
            overlay_runs.custom_config(bad)


def test_hold_keeps_the_contract_without_a_sale_and_rebuy():
    chains = {(D0, "ABC"): _chain(D0), (D1, "ABC"): _chain(D1, exit_price=12.0),
              (D2, "ABC"): _chain(D2, exit_price=15.0)}  # fmt: skip
    s = ov.Settings(moneyness="ATM", min_sessions_left=15, slippage=0.01, hold=True)
    leg = ov.Leg(picks={D0: ["ABC"], D1: ["ABC"]}, right="CE")
    counts = ov.BookCounts()
    rows = ov.run_leg(leg, s, [D0, D1, D2], chains, SPOTS, _lots(), set(), ARR, counts)
    w1, w2 = rows
    assert w1["held_out"] and not w1["held_in"] and w2["held_in"] and not w2["held_out"]
    assert w1["sell"] == pytest.approx(12.0 * 100)  # a mark: no slippage
    assert w1["costs"] == pytest.approx(ov.costs(w1["buy"], 0.0, D1, orders=1))
    assert w2["buy"] == pytest.approx(12.0 * 100) and counts.held == 1
    pos = ov.positions_of(pd.DataFrame(rows))
    assert len(pos) == 1 and pos.iloc[0]["weeks"] == 2
    assert pos.iloc[0]["pnl"] == pytest.approx(w1["pnl"] + w2["pnl"])


def test_itm_delta_expiry_skip_exposure_and_caps():
    chains = {(D0, "ABC"): _chain(D0), (D1, "ABC"): _chain(D1, exit_price=12.0)}
    leg = lambda: ov.Leg(picks={D0: ["ABC"]}, right="CE")  # noqa: E731
    (t,), _ = _run(leg(), ov.Settings(moneyness="ITM1", min_sessions_left=15), chains)
    assert t["strike"] == 95.0  # ATM 100, one strike in the money for a call
    (t,), _ = _run(leg(), ov.Settings(moneyness="ATM", min_sessions_left=10, expiry_skip=1),
                   chains)  # fmt: skip
    assert t["expiry"] == NEXT  # NEAR qualifies, skipped once
    real = pd.concat([_rows(D0, NEXT, [90.0, 100.0, 110.0], "CE", [13.0, 6.0, 2.0])])
    (t,), _ = _run(leg(), ov.Settings(moneyness="DELTA", delta_target=0.8, min_sessions_left=15),
                   {(D0, "ABC"): real, (D1, "ABC"): _chain(D1)})  # fmt: skip
    assert t["strike"] == 90.0  # the deepest strike has the highest delta
    s = ov.Settings(moneyness="ATM", min_sessions_left=15, sizing="exposure", sizing_value=1.0,
                    capital=100_000.0)  # fmt: skip
    exposed = ov.Leg(picks={D0: ["ABC"]}, right="CE", weekly_total=100_000.0)
    (t,), _ = _run(exposed, s, chains)
    assert t["lots"] >= 1
    two = ov.Leg(picks={D0: ["ABC", "ABC"]}, right="CE")
    trades, counts = _run(two, ov.Settings(min_sessions_left=15, max_positions=1), chains)
    assert len(trades) == 1 and counts.capped == 1


def test_a_stop_closes_on_the_first_daily_close_through_it():
    mid = pd.Timestamp("2024-01-08")
    chains = {(D0, "ABC"): _chain(D0), (mid, "ABC"): _chain(mid, exit_price=3.0),
              (D1, "ABC"): _chain(D1, exit_price=12.0)}  # fmt: skip
    s = ov.Settings(moneyness="ATM", min_sessions_left=15, slippage=0.0, stop=0.5)
    counts = ov.BookCounts()
    (t,) = ov.trade_week(ov.Leg(picks={D0: ["ABC"]}, right="CE"), s, D0, D1, chains, SPOTS,
                         _lots(), set(), ARR, counts, between=[mid, D1])  # fmt: skip
    assert t["exit_how"] == "stop" and t["exit"] == mid and t["p1"] == 3.0
    assert t["week_end"] == D1 and counts.stopped == 1


def test_fresh_starts_run_each_start_as_its_own_account(monkeypatch):
    # every start is one run of the booked path over its own horizon; the run is faked by the
    # start day so the summary and the wash-out can be checked by hand
    sessions = list(pd.bdate_range("2020-01-01", "2021-12-31"))
    monkeypatch.setattr(ov.LAKE, "sessions", lambda: sessions)
    monkeypatch.setattr(ov.Lake, "newest", property(lambda self: "2021-12-31"))
    calls = []
    outcome = {"2020-01-01": (-90_000, [100_000, 10_000, 10_000]),
               "2020-04-01": (300_000, [100_000, 60_000, 400_000]),
               "2020-07-01": (-20_000, [100_000, 80_000, 80_000])}  # fmt: skip

    def fake_run(s, inputs, capital_table=True):
        calls.append(s)
        if s.start == "2020-01-01" and s.end == "2021-12-31":  # the warm-up over the window
            return {}
        if s.start == "2020-10-01":
            raise ValueError("The window holds fewer than three rebalance weeks of F&O data.")
        total, account = outcome[s.start]
        return {"first_day": s.start, "last_day": s.end,
                "book": {"total_rs": total, "max_dd": -0.5},
                "booking": {"account": account, "taken_rs": 0}, "stats": {"trades": 7},
                "counts": {"no_capital": 2}}  # fmt: skip

    monkeypatch.setattr(ov, "run", fake_run)
    s = ov.Settings(capital=100_000.0, start="2020-01-01", end="2021-12-31", split="2020-06-30",
                    sizing="one_lot")  # fmt: skip
    out = ov.starts(s, ov.Inputs(), every_months=3, years=1, washout=0.2)
    # starts 2020-01 .. 2020-10 (2021-01 + 1 year is past the data); the warm-up first
    assert [c.start for c in calls[1:]] == ["2020-01-01", "2020-04-01", "2020-07-01", "2020-10-01"]
    assert all(c.split is None and c.profit_step == ov.NO_BOOKING for c in calls[1:])
    assert calls[1].end == "2021-01-01"
    assert out["skipped"] == 1 and [r["start"] for r in out["starts"]] == [
        "2020-01-01", "2020-04-01", "2020-07-01"]  # fmt: skip
    assert [r["washed_out"] for r in out["starts"]] == [True, False, False]
    assert out["summary"] == {"starts": 3, "median_end_rs": 80_000, "mean_end_rs": 163_333,
                              "best_rs": 400_000, "worst_rs": 10_000, "above_start": 1,
                              "washed_out": 1, "median_trades": 7.0}  # fmt: skip
    with pytest.raises(ValueError, match="shorter than one 3-year"):
        ov.starts(s, ov.Inputs(), years=3)


def test_fresh_starts_never_begin_before_the_data_nor_count_a_late_first_week(monkeypatch):
    # the data begins 2020-01-01; From asks for 2019-07-01. The 2019 starts would trade part of
    # their year, so the first start is the first month-begin inside the data. A start whose
    # first rebalance day comes long after its date (the data began later) is skipped, not counted
    sessions = list(pd.bdate_range("2020-01-01", "2021-12-31"))
    monkeypatch.setattr(ov.LAKE, "sessions", lambda: sessions)
    monkeypatch.setattr(ov.Lake, "newest", property(lambda self: "2021-12-31"))
    calls = []

    def fake_run(s, inputs, capital_table=True):
        calls.append(s)
        if s.end == "2021-12-31":  # the warm-up over the window
            return {}
        late = s.start == "2020-04-01"
        return {"first_day": "2020-04-20" if late else s.start, "last_day": s.end,
                "book": {"total_rs": 1_000, "max_dd": -0.1},
                "booking": {"account": [100_000, 101_000], "taken_rs": 0},
                "stats": {"trades": 3}, "counts": {}}  # fmt: skip

    monkeypatch.setattr(ov, "run", fake_run)
    s = ov.Settings(capital=100_000.0, start="2019-07-01", end="2021-12-31", sizing="one_lot")
    out = ov.starts(s, ov.Inputs(), every_months=3, years=1)
    assert [c.start for c in calls[1:]][0] == "2020-01-01"
    assert all(c.start >= "2020-01-01" for c in calls[1:])
    assert [r["start"] for r in out["starts"]][:2] == ["2020-01-01", "2020-07-01"]
    assert out["skipped"] == 1  # 2020-04-01: its first week was 19 days in


def test_the_starts_api_validates_and_runs_as_a_job():
    from fastapi.testclient import TestClient

    from momentum_backtesting import api

    client = TestClient(api.create_app())
    assert client.post("/api/options-overlay/starts/jobs", json={"years": 4}).status_code == 422
    assert client.post("/api/options-overlay/starts/jobs",
                       json={"every_months": 2}).status_code == 422  # fmt: skip
    job = client.post("/api/options-overlay/starts/jobs", json={"direction": "calls"})
    assert job.status_code == 202
    assert client.get("/api/options-overlay/starts/jobs/nope").status_code == 404


def test_exposure_is_the_legs_own_share_of_the_capital():
    # a leg given half the capital's exposure buys about half the lots of one given all of it,
    # whatever the capital is (it used to size every leg on the whole capital)
    chains = {(D0, "ABC"): _chain(D0), (D1, "ABC"): _chain(D1, exit_price=12.0)}
    s = ov.Settings(moneyness="ATM", min_sessions_left=15, sizing="exposure", sizing_value=1.0,
                    capital=100_000.0, slippage=0.0)  # fmt: skip
    (whole,), _ = _run(ov.Leg(picks={D0: ["ABC"]}, right="CE", weekly_total=100_000.0), s, chains)
    (half,), _ = _run(ov.Leg(picks={D0: ["ABC"]}, right="CE", weekly_total=50_000.0), s, chains)
    assert whole["lots"] > 2 and half["lots"] == pytest.approx(whole["lots"] / 2, abs=1)


def test_a_held_week_splits_the_budget_over_kept_and_new_contracts():
    xyz = lambda day, **kw: _chain(day, **kw).assign(symbol="XYZ")  # noqa: E731
    chains = {(D0, "ABC"): _chain(D0), (D1, "ABC"): _chain(D1, exit_price=12.0),
              (D1, "XYZ"): xyz(D1), (D2, "ABC"): _chain(D2, exit_price=12.0),
              (D2, "XYZ"): xyz(D2, exit_price=8.0)}  # fmt: skip
    spots = pd.DataFrame({"ABC": [101.0, 104.0, 99.0], "XYZ": [100.0] * 3}, index=[D0, D1, D2])
    idx = [(d, sym, e) for d in (D0, D1, D2) for sym in ("ABC", "XYZ") for e in (NEAR, NEXT)]
    lots = pd.Series(100.0, index=pd.MultiIndex.from_tuples(idx))
    s = ov.Settings(moneyness="ATM", min_sessions_left=15, slippage=0.0, hold=True)
    # week 2: ABC is kept, XYZ is new; the week's 3,200 is over both, so XYZ gets 1,600 (2 lots at
    # 800 a lot), not all 3,200
    leg = ov.Leg(picks={D0: ["ABC"], D1: ["ABC", "XYZ"], D2: []}, right="CE", weekly_total=3200.0)
    rows = ov.run_leg(leg, s, [D0, D1, D2], chains, spots, lots, set(), ARR, ov.BookCounts())
    new = [r for r in rows if r["symbol"] == "XYZ"]
    assert len(new) == 1 and new[0]["lots"] == 2 and not new[0]["held_in"]


def test_a_contract_is_not_held_past_the_last_week_or_the_position_cap():
    chains = {(D0, "ABC"): _chain(D0), (D1, "ABC"): _chain(D1, exit_price=12.0),
              (D2, "ABC"): _chain(D2, exit_price=15.0)}  # fmt: skip
    s = ov.Settings(moneyness="ATM", min_sessions_left=15, slippage=0.01, hold=True)
    # the run ends at D1: its picks are never traded, so the week-1 contract is sold, with costs
    leg = ov.Leg(picks={D0: ["ABC"], D1: ["ABC"]}, right="CE")
    (t,) = ov.run_leg(leg, s, [D0, D1], chains, SPOTS, _lots(), set(), ARR, ov.BookCounts())
    assert not t["held_out"] and t["sell"] == pytest.approx(12.0 * 0.99 * 100)
    assert t["costs"] == pytest.approx(ov.costs(t["buy"], t["sell"], D1, orders=2))
    # next week's cap of 1 keeps XYZ, not ABC: ABC is sold, not left to vanish
    capped = replace(s, max_positions=1)
    leg = ov.Leg(picks={D0: ["ABC"], D1: ["XYZ", "ABC"]}, right="CE")
    rows = ov.run_leg(
        leg, capped, [D0, D1, D2], chains, SPOTS, _lots(), set(), ARR, ov.BookCounts()
    )
    assert not rows[0]["held_out"]


def test_two_sleeves_buying_one_stock_the_same_day_are_two_positions():
    chains = {(D0, "ABC"): _chain(D0), (D1, "ABC"): _chain(D1, exit_price=12.0)}
    s = ov.Settings(moneyness="ATM", min_sessions_left=15)
    ids = []
    for slot in (0, 1):
        leg = ov.Leg(picks={D0: ["ABC"]}, right="CE", tag="calls", slot=slot)
        (t,), _ = _run(leg, s, chains)
        ids.append(t["pos_id"])
    assert ids[0] != ids[1]


def test_weeks_won_counts_the_weeks_not_the_positions_last_week():
    # one contract held two weeks: +400 the first, -900 the second. As positions that is one losing
    # position booked in its last week (0 of 1 weeks won); as weeks it is 1 of 2.
    chains = {(D0, "ABC"): _chain(D0), (D1, "ABC"): _chain(D1, exit_price=12.0),
              (D2, "ABC"): _chain(D2, exit_price=3.0)}  # fmt: skip
    s = ov.Settings(moneyness="ATM", min_sessions_left=15, slippage=0.0, hold=True)
    leg = ov.Leg(picks={D0: ["ABC"], D1: ["ABC"]}, right="CE")
    rows = pd.DataFrame(ov.run_leg(leg, s, [D0, D1, D2], chains, SPOTS, _lots(), set(), ARR,
                                   ov.BookCounts()))  # fmt: skip
    pos = ov.positions_of(rows)
    assert len(pos) == 1 and ov.trade_stats(pos)["weeks_won"] == 0.0
    assert ov.trade_stats(pos, per_week=rows)["weeks_won"] == 0.5


def test_the_refill_trial_leaves_the_hold_state_as_it_found_it(monkeypatch):
    # week 3's trial play fills `leg.held`; the real week-3 play must still see week 2's, not it
    seen = []
    counts = ov.BookCounts()
    pnl = {D0: 350.0, D1: -500.0, D2: 0.0}

    def fake(leg, s, d0, d1, chains, spots, lots, bans, sessions, tally, **kw):
        seen.append((d0, "real" if tally is counts else "trial", dict(leg.held)))
        leg.held = {("ABC", "CE"): {"from": "real" if tally is counts else "trial"}}
        if d0 == D2:
            tally.no_capital += 1  # the pick is too dear for the account: refill
        return [{"pnl": pnl[d0], "buy": 0.0}]

    monkeypatch.setattr(ov, "trade_week", fake)
    d3 = pd.Timestamp("2024-01-26")
    leg = ov.Leg(picks={}, right="CE")
    s = ov.Settings(capital=1300.0, profit_step=100.0, withdraw_share=1.0, refill=True, hold=True)
    ov.run_booked([leg], s, [D0, D1, D2, d3], {}, SPOTS, _lots(), set(), ARR, counts)
    at_d2 = [(kind, held) for day, kind, held in seen if day == D2]
    assert [kind for kind, _ in at_d2] == ["trial", "real"]
    assert at_d2[1][1] == {("ABC", "CE"): {"from": "real"}}  # week 2's kept contract, untouched
