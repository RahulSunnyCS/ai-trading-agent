"""BL-051 Phase 3: Your orders - whole shares, the minimum trade, blocked names, charges."""

import pytest

from momentum_backtesting import orders


def _rows(plan):
    return {r.symbol: (r.action, r.quantity) for r in plan.rows}


def test_exits_and_new_names_always_trade_and_small_drifts_are_skipped():
    plan = orders.plan(
        holdings={"OLD": 25, "BSE": 10, "HAL": 16, "DIXON": 3},
        prices={"OLD": 1600.0, "BSE": 6950.0, "HAL": 4400.0, "DIXON": 15890.0, "NEW": 2480.0},
        target={"BSE": 0.25, "HAL": 0.20, "DIXON": 0.15, "NEW": 0.40},
        cash=45_000,
    )
    # value: OLD 40,000 + BSE 69,500 + HAL 70,400 + DIXON 47,670 + cash 45,000 = 272,570
    assert plan.portfolio_value == pytest.approx(272_570)
    got = _rows(plan)
    assert got["OLD"] == ("SELL", 25)  # a full exit, whatever its size
    assert got["NEW"] == ("BUY", 43)  # 0.40 * 272,570 / 2,480 = 43.96 -> 43
    assert got["BSE"] == ("", 0)  # 68,142 target vs 69,500 held: under one share of drift
    assert got["HAL"] == ("TRIM", 3)  # 54,514 vs 70,400: Rs 15,886 over the target -> 3 shares
    assert plan.sells == pytest.approx(40_000 + 3 * 4400)  # the exit and the HAL trim


def test_the_minimum_trade_applies_to_top_ups_and_trims_only():
    plan = orders.plan(
        holdings={"A": 100, "B": 100},
        prices={"A": 100.0, "B": 100.0},
        target={"A": 0.40, "B": 0.60},
        cash=0,
        min_trade_rs=1_500,
    )
    # A: 8,000 target vs 10,000 held -> trim 20; B: 12,000 vs 10,000 -> add 20.
    assert _rows(plan) == {"A": ("TRIM", 20), "B": ("ADD", 20)}
    small = orders.plan(
        holdings={"A": 100, "B": 100},
        prices={"A": 100.0, "B": 100.0},
        target={"A": 0.40, "B": 0.60},
        min_trade_rs=2_500,
    )
    assert _rows(small) == {"A": ("SKIP", 0), "B": ("SKIP", 0)}
    assert "would cost ₹" in small.rows[0].note


def test_a_blocked_name_is_held_and_a_buy_under_one_share_is_skipped():
    plan = orders.plan(
        holdings={"KAYNES": 6},
        prices={"KAYNES": 5380.0, "MRF": 150_000.0},
        target={"MRF": 0.5},
        cash=30_000,
        blocked={"KAYNES"},
    )
    got = {r.symbol: (r.action, r.note) for r in plan.rows}
    assert got["KAYNES"][0] == "HOLD" and "split" in got["KAYNES"][1]
    assert got["MRF"][0] == "SKIP" and "less than one share" in got["MRF"][1]
    assert plan.not_traded == 2


def test_charges_follow_the_itemised_rates_and_sells_come_first():
    plan = orders.plan(
        holdings={"S": 100},
        prices={"S": 100.0, "B": 50.0},
        target={"B": 1.0},
        cash=0,
    )
    assert [r.action for r in plan.rows] == ["SELL", "BUY"]
    sell, buy = plan.rows
    assert sell.charges == pytest.approx(10_000 * (0.001 + 0.00004) + 16)
    assert buy.quantity == 200 and buy.charges == pytest.approx(
        10_000 * (0.001 + 0.00015 + 0.00004)
    )
    assert plan.cash_after == pytest.approx(10_000 - 10_000 - sell.charges - buy.charges)


def test_a_missing_price_is_reported_not_guessed():
    plan = orders.plan(holdings={"X": 10}, prices={}, target={"X": 1.0}, cash=1000)
    assert plan.missing_prices == ["X"]
    assert _rows(plan)["X"] == ("SKIP", 0)


def test_fyers_holdings_are_read_only_merged_per_symbol_and_named_like_nse(monkeypatch):
    import io
    import json as _json

    from momentum_backtesting import fyers

    payload = {
        "s": "ok",
        "code": 200,
        "message": "",
        "overall": {},
        "holdings": [
            {"symbol": "NSE:SBIN-EQ", "quantity": 10, "costPrice": 800.0, "holdingType": "HLD"},
            {"symbol": "NSE:SBIN-EQ", "quantity": 5, "costPrice": 830.0, "holdingType": "T1"},
            {"symbol": "NSE:M&M-EQ", "quantity": 2, "costPrice": 3000.0, "holdingType": "HLD"},
            {"symbol": "NSE:LIQUIDBEES-EQ", "quantity": 0, "costPrice": 1000.0},
        ],
    }
    seen = {}

    def fake_urlopen(request, timeout=None):
        seen["method"] = request.get_method()
        seen["url"] = request.full_url
        return io.BytesIO(_json.dumps(payload).encode())

    monkeypatch.setattr(fyers.urllib.request, "urlopen", fake_urlopen)
    creds = fyers.Credentials(app_id="APP-100", access_token="t", source="test")
    got = {h["symbol"]: h for h in fyers.holdings(creds)}
    assert seen == {"method": "GET", "url": fyers.HOLDINGS_URL}
    assert set(got) == {"SBIN", "M&M"}
    assert got["SBIN"]["quantity"] == 15 and got["SBIN"]["avg_price"] == pytest.approx(810.0)
    assert fyers.nse_symbol("NSE:NAVINFLUOR-BE") == "NAVINFLUOR"
