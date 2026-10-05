"""The independent replay (BL-010 Phase 2): it must agree with the real engine on honest data,
catch a wrong number on either side, and share no code with what it checks."""

from __future__ import annotations

import ast
import copy
import json
import math
import random
from datetime import date, timedelta
from pathlib import Path

import pandas as pd
import pytest
from trading_data.db import connect

from momentum_backtesting import db_read, engine
from momentum_backtesting.audit import bundle as bundle_mod
from momentum_backtesting.audit import outside, replay, studies
from momentum_backtesting.categories.prices import build_stock_weekly_prices
from momentum_backtesting.engine import CASH, Config
from momentum_backtesting.tax import TaxRules

AUDIT_DIR = Path(replay.__file__).parent
SPLIT_DAY = date(2021, 6, 23)  # AAA splits 2-for-1 here, a Wednesday, while it is held
HALT = (date(2021, 7, 19), date(2021, 8, 6))  # BBB does not trade for three weeks


# --- the rule the whole audit rests on ----------------------------------------------------------


@pytest.mark.parametrize("name", ["replay.py", "studies.py", "outside.py"])
def test_the_independent_side_imports_nothing_from_the_backtest(name):
    tree = ast.parse((AUDIT_DIR / name).read_text())
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            assert not any(a.name.startswith("momentum_backtesting") for a in node.names)
        if isinstance(node, ast.ImportFrom):
            assert not (node.module or "").startswith("momentum_backtesting")
            if node.level:
                # Only its own independent siblings, and replay.py itself stands alone.
                assert name != "replay.py" and node.level == 1
                assert node.module in ("replay", "studies")


def test_a_week_ends_on_its_friday():
    assert replay.week_ending(date(2021, 6, 11)) == date(2021, 6, 11)  # Friday
    assert replay.week_ending(date(2021, 6, 7)) == date(2021, 6, 11)  # Monday
    assert replay.week_ending(date(2021, 6, 12)) == date(2021, 6, 18)  # a Saturday session


# --- a small market with a split, a trading halt and the liquid fund ----------------------------


def _sessions(start: date, end: date) -> list[date]:
    days, day = [], start
    while day <= end:
        if day.weekday() < 5:
            days.append(day)
        day += timedelta(days=1)
    return days


@pytest.fixture
def small_market(tmp_path, monkeypatch):
    """Four stocks over about ten months of daily bars, written the way the real lake is."""
    monkeypatch.setenv("TRADING_DATA_ROOT", str(tmp_path))
    rng = random.Random(7)
    days = _sessions(date(2021, 1, 4), date(2021, 10, 29))
    drift = {"AAA": 0.004, "BBB": -0.001, "CCC": 0.002, "DDD": 0.0005}
    with connect(tmp_path) as con:
        ids = {
            symbol: con.execute(
                "INSERT INTO instruments (instrument_key, asset_class, exchange, symbol) "
                "VALUES (?, 'stock', 'NSE', ?) RETURNING instrument_id",
                [f"stock:NSE:{symbol}", symbol],
            ).fetchone()[0]
            for symbol in drift
        }
        con.execute(
            "INSERT INTO stock_action_candidates VALUES "
            "('AAA', ?, 0, 0, 0, 0, 0, 0, 2.0, 2.0, 2.0, 2.0, 'confirmed', 'split', 'test', 'x')",
            [SPLIT_DAY],
        )
        nav = 100.0
        for day in days:
            nav *= 1.0002
            con.execute(
                "INSERT INTO momentum_prices VALUES (?, 'signal', ?, ?, ?)", [CASH, day, nav, nav]
            )
            if day.weekday() == 4:
                for name, level in ((CASH, nav), ("Nifty 50", 15000 + nav)):
                    con.execute(
                        "INSERT INTO momentum_prices VALUES (?, 'weekly', ?, NULL, ?)",
                        [name, day, level],
                    )
    rows = []
    for symbol, daily_drift in drift.items():
        price = 200.0
        for day in days:
            previous = price
            price *= 1 + daily_drift + rng.uniform(-0.03, 0.03)
            if symbol == "AAA" and day == SPLIT_DAY:
                price /= 2
            if symbol == "BBB" and HALT[0] <= day <= HALT[1]:
                continue
            open_ = round(previous * (1 + rng.uniform(-0.01, 0.01)), 2)
            if symbol == "AAA" and day == SPLIT_DAY:
                open_ = round(open_ / 2, 2)
            rows.append(
                {
                    "instrument_id": ids[symbol],
                    "date": day,
                    "series": "EQ",
                    "isin": f"INE{symbol}",
                    "open": open_,
                    "high": round(price * 1.01, 2),
                    "low": round(price * 0.99, 2),
                    "close": round(price, 2),
                    "prevclose": round(previous, 2),
                    "volume": 100_000,
                    "turnover": 50_000_000.0,
                    "synthetic_close": False,
                }
            )
    frame = pd.DataFrame(rows)
    frame["date"] = pd.to_datetime(frame["date"])
    path = tmp_path / "lake" / "bars_1d" / "asset=stock" / "year=2021" / "data.parquet"
    path.parent.mkdir(parents=True)
    frame.to_parquet(path, index=False)
    return tmp_path


def _run(root: Path, tax: TaxRules | None = None, **config) -> tuple[dict, replay.Market]:
    """The real price builder and the real engine on the small market, as one bundle."""
    weekly, events, _stale = build_stock_weekly_prices(
        ["AAA", "BBB", "CCC", "DDD"], stocks_data_dir=root
    )
    outer = db_read.weekly_closes_from_db(root)
    prices = weekly.ffill()
    for name in (CASH, "Nifty 50"):
        prices[name] = outer.reindex(prices.index)[name]
    settings = dict(
        lookbacks=(1, 4),
        top_n=2,
        exit_rank=3,
        start="2021-02-05",
        universe=("AAA", "BBB", "CCC", "DDD"),
        signal_delay=1,
        max_position=0.6,
        min_ranked=1,
        cost_model="itemised",
        capital=200_000,
        slippage_bps=15.0,
        tax=tax,
    )
    settings.update(config)
    result = engine.run_backtest(
        prices,
        dict.fromkeys(prices.columns, "core"),
        Config(**settings),
        tax_classes=dict.fromkeys(prices.columns, "equity") | {CASH: "debt"} if tax else None,
    )
    made = bundle_mod.build_bundle(
        result,
        prices=prices,
        column_to_base_symbol={c: c.split("#", 1)[0] for c in weekly.columns},
        events=events,
        label="small",
        run_id="test",
        variant="unit",
    )
    made = json.loads(json.dumps(made, default=str))  # exactly what a bundle file holds
    return made, replay.market_for(made, root)


def _failed(made: dict, market: replay.Market) -> set[str]:
    return {c.name for c in replay.compare(made, replay.replay(made, market)) if not c.passed}


@pytest.mark.parametrize("tax", [None, TaxRules()], ids=["pre-tax", "taxed"])
def test_the_replay_reproduces_the_engine_from_raw_bars(small_market, tax):
    made, market = _run(small_market, tax)
    assert len(made["orders"]) > 20, "the fixture should trade enough to mean something"
    mine = replay.replay(made, market)
    checks = replay.compare(made, mine)
    assert [c.name for c in checks if not c.passed] == []
    # The split and the halt really are inside what was held, or this proves little.
    assert any(not q.fresh for marks in mine.marks.values() for q in marks.values())
    spans = studies.holding_spans(mine)["AAA"]
    assert any(start < SPLIT_DAY <= (end or date.max) for start, end in spans)
    assert mine.tax_paid > 0 if tax else mine.tax_paid == 0


def test_make_room_and_trims_reconcile_too(small_market):
    made, market = _run(small_market, entry="make_room", max_position=0.4, cap_band=0.02)
    assert {"TRIM"} <= {o["action"] for o in made["orders"]}
    assert _failed(made, market) == set()


def test_a_wrong_claim_is_caught(small_market):
    made, market = _run(small_market, TaxRules())
    assert _failed(made, market) == set()

    priced = copy.deepcopy(made)
    priced["claims"]["fills"][3]["fill_price"] *= 1.01
    assert "fill prices" in _failed(priced, market)

    costed = copy.deepcopy(made)
    sale = next(i for i, o in enumerate(made["orders"]) if o["action"] == "SELL")
    costed["claims"]["fills"][sale]["cost"] *= 2
    assert "costs" in _failed(costed, market)

    taxed = copy.deepcopy(made)
    paid = next(i for i, f in enumerate(made["claims"]["fills"]) if (f["tax"] or 0) > 0)
    taxed["claims"]["fills"][paid]["tax"] *= 1.5
    assert "tax" in _failed(taxed, market)

    inflated = copy.deepcopy(made)
    inflated["claims"]["equity"] = [
        e * (1.01 if i > 20 else 1) for i, e in enumerate(made["claims"]["equity"])
    ]
    inflated["claims"]["kpis"]["cagr"] += 0.02
    assert {"weekly equity", "CAGR"} <= _failed(inflated, market)


def test_an_order_the_money_cannot_cover_is_caught(small_market):
    made, market = _run(small_market)
    bigger = copy.deepcopy(made)
    buy = next(i for i, o in enumerate(made["orders"]) if o["action"] == "BUY")
    bigger["orders"][buy]["value"] *= 1.2
    assert "cash is fully used after buying" in _failed(bigger, market)


def test_a_missing_split_factor_shows_as_a_price_gap(small_market):
    made, market = _run(small_market)
    market.stocks["AAA"].factors.clear()  # the lake as it would be had the split been missed
    assert {"fill prices", "weekly price of everything held"} & _failed(made, market)


# --- costs and tax, by hand ---------------------------------------------------------------------


def test_itemised_costs_in_rupees():
    costs = replay.Costs("itemised", capital_rs=200_000, slippage=0.0015, flat_rate=0.001)
    # Rs 50,000 bought: STT 50 + stamp 7.5 + exchange 2 + slippage 75.
    assert costs.on_buy(0.25, False) * 200_000 == pytest.approx(134.5)
    # Rs 50,000 sold: STT 50 + exchange 2 + slippage 75 + Rs 16 to the depository.
    assert costs.on_sell(0.25, False) * 200_000 == pytest.approx(143.0)
    # A Rs 100 sale: the depository charge is capped at 5% of it.
    assert costs.on_sell(0.0005, False) * 200_000 == pytest.approx(0.254 + 5.0)
    assert costs.on_buy(0.25, True) * 200_000 == pytest.approx(2.5)
    assert costs.on_sell(0.25, True) == 0.0


def test_tax_book_banks_losses_and_taxes_what_is_left():
    rules = {
        "slab_rate": 0.30,
        "cess": 0.04,
        "equity_stcg": 0.20,
        "ltcg": 0.125,
        "long_term_days": 365,
    }
    book = replay.TaxBook(rules)
    assert book.on_sale("equity", -100.0, 30) == 0.0  # a short-term loss is banked
    assert book.on_sale("equity", 150.0, 30) == pytest.approx(50 * 0.20 * 1.04)
    assert book.on_sale("equity", 100.0, 400) == pytest.approx(100 * 0.125 * 1.04)
    assert book.on_sale("debt", 100.0, 400) == pytest.approx(100 * 0.30 * 1.04)  # never long-term
    assert book.on_sale("equity", -80.0, 400) == 0.0  # a long-term loss...
    assert book.on_sale("equity", 100.0, 30) == pytest.approx(100 * 0.20 * 1.04)  # ...not here
    assert book.on_sale("equity", 100.0, 400) == pytest.approx(20 * 0.125 * 1.04)  # ...but here


# --- what-ifs -----------------------------------------------------------------------------------


def test_the_same_decisions_at_the_same_prices_change_nothing(small_market):
    made, market = _run(small_market, TaxRules())
    mine = replay.replay(made, market)
    assert studies.baseline_matches(made, market, mine) < 1e-12


def test_filling_at_the_next_open_uses_that_open(small_market):
    made, market = _run(small_market)
    mine = replay.replay(made, market)
    shares = replay.decisions(mine)
    moved = replay.replay(made, market, replay.Sizing(shares=shares, fill_at="next_open"))
    stock_fills = [f for f in moved.fills if made["assets"][f.asset]["kind"] == "stock"]
    assert stock_fills
    for fill in stock_fills:
        history = market.stocks[made["assets"][fill.asset]["symbol"]]
        bar = history.first_after(fill.week)
        if bar is not None and bar.day <= fill.week + timedelta(days=7):
            assert fill.price_day == bar.day > fill.week
            assert fill.raw_price == bar.open
    result = studies.monday_open(made, market, mine)
    assert result["cagr_at_close"] == pytest.approx(replay.cagr(mine.equity))
    assert result["cagr_change_pts"] != 0


def test_whole_shares_and_a_participation_cap_leave_money_unspent(small_market):
    made, market = _run(small_market)
    mine = replay.replay(made, market)
    shares = replay.decisions(mine)
    whole = replay.replay(made, market, replay.Sizing(shares=shares, whole_shares=True))
    capital = made["settings"]["capital"]
    for fill in whole.fills:
        if fill.action in ("BUY", "ADD") and fill.amount > 0:
            bought = (fill.amount - fill.cost) * capital / fill.raw_price
            assert bought == pytest.approx(round(bought), abs=1e-6)
    # Rs 5 crore trades a day here; a cap of 0.01% of that is Rs 5,000 an order.
    capped = replay.replay(
        made, market, replay.Sizing(shares=shares, whole_shares=True, participation_cap=0.0001)
    )
    assert all(
        f.amount * capital <= 5_000 + 1e-6 for f in capped.fills if f.action in ("BUY", "ADD")
    )
    assert max(capped.cash.values()) > 0.5  # most of the money could not be placed


# --- studies ------------------------------------------------------------------------------------


def test_contribution_adds_up_to_the_whole_return(small_market):
    made, market = _run(small_market)
    mine = replay.replay(made, market)
    for week in sorted(mine.pnl):
        before = max(w for w in mine.equity if w < week)
        assert sum(mine.pnl[week].values()) == pytest.approx(
            mine.equity[week] - mine.equity[before]
        )
    profile = studies.contribution(made, mine)
    assert sum(profile["by_calendar_year"].values()) == pytest.approx(1.0)
    assert sum(profile["by_financial_year"].values()) == pytest.approx(1.0)
    last = max(mine.equity)
    assert profile["total_log_return"] == pytest.approx(math.log(mine.equity[last]))


def test_big_days_see_the_adjusted_series_not_the_raw_one(small_market):
    made, market = _run(small_market)
    mine = replay.replay(made, market)
    # The 2-for-1 split halves the raw price, but it is adjusted: not a big day.
    assert not [d for d in studies.big_days(made, market, mine) if d["symbol"] == "AAA"]
    market.stocks["AAA"].factors.clear()
    flagged = [d for d in studies.big_days(made, market, mine) if d["symbol"] == "AAA"]
    assert [d["day"] for d in flagged] == [str(SPLIT_DAY)] and flagged[0]["move"] < -0.4


def test_action_feed_reads_share_count_changes(tmp_path):
    split = "Face Value Split (Sub-Division) - From Rs 10/- Per Share To Rs {to}/- Per Share"
    subjects = {
        "pfc": ("21-Sep-2023", "Bonus 1:4"),
        "DIXON": ("18-Mar-2021", split.format(to=2)),
        "RAMA": ("14-Mar-2016", " Bonus 4:1/" + split.format(to=5)),
        "TVS": ("25-Aug-2025", "Scheme Of Arrangement - Bonus Ncrps 4:1"),
        "ABB": ("20-Dec-2019", "Demerger"),
        "ITC": ("01-Jun-2020", "Dividend - Rs 10 Per Share"),
        "BAD": ("-", "Bonus 1:1"),
    }
    rows = [
        {"symbol": symbol, "isin": "X", "exDate": ex_date, "subject": subject}
        for symbol, (ex_date, subject) in subjects.items()
    ]
    (tmp_path / "ca_2021.json").write_text(json.dumps(rows))
    feed = {row["symbol"]: row for row in studies.load_action_feed(tmp_path)}
    assert feed["PFC"]["factor"] == pytest.approx(1.25)
    assert feed["PFC"]["ex_date"] == date(2023, 9, 21)
    assert feed["DIXON"]["factor"] == pytest.approx(5.0)
    assert feed["RAMA"]["factor"] == pytest.approx(10.0)
    assert feed["TVS"]["factor"] is None  # preference shares add no equity shares
    assert feed["ABB"]["factor"] is None and feed["ABB"]["kinds"] == ["demerger"]
    assert "ITC" not in feed and "BAD" not in feed


def test_a_filed_split_the_lake_missed_is_named_and_costed(small_market):
    made, market = _run(small_market)
    mine = replay.replay(made, market)
    feed = [
        {
            "symbol": "AAA",
            "isin": "",
            "ex_date": SPLIT_DAY,
            "kinds": ["bonus"],
            "factor": 2.0,
            "subject": "Bonus 1:1",
        },
    ]
    scan = studies.jump_scan(made, market, mine, feed)
    assert [a["adjusted"] for a in scan["filed_share_count_actions"]] == [True]
    assert scan["missed_actions_cost_pts"] == 0

    market.stocks["AAA"].factors.clear()  # now the lake has missed it
    stale = replay.replay(made, market, replay.Sizing(shares=replay.decisions(mine)))
    scan = studies.jump_scan(made, market, mine, feed)
    (action,) = scan["filed_share_count_actions"]
    assert not action["adjusted"] and action["booked_as"] == pytest.approx(-0.5)
    assert scan["kill"]["share_count_action_not_adjusted"]
    # Applying the missing factor gives back the result the adjusted lake had.
    assert scan["cagr"] == pytest.approx(replay.cagr(stale.equity))
    assert scan["cagr_with_missed_actions_adjusted"] == pytest.approx(replay.cagr(mine.equity))


# --- the outside source -------------------------------------------------------------------------


def _stamp(day: date) -> int:
    return int(pd.Timestamp(day, tz="Asia/Kolkata").timestamp()) + 9 * 3600


def test_outside_history_is_read_back_to_traded_prices():
    payload = {
        "chart": {
            "result": [
                {
                    "timestamp": [_stamp(date(2024, 4, 19)), _stamp(date(2026, 6, 3))],
                    "indicators": {"quote": [{"close": [4158.95, 2838.4], "volume": [1, 2]}]},
                    "events": {
                        "splits": {
                            "x": {
                                "date": _stamp(date(2026, 6, 4)),
                                "numerator": 3.0,
                                "denominator": 2.0,
                            }
                        }
                    },
                }
            ]
        }
    }
    history = outside.parse(payload)
    assert history.splits == [(date(2026, 6, 4), 1.5)]
    # Fully adjusted close: times the later ratio.
    assert history.raw(date(2026, 6, 3)) == (pytest.approx(4257.6), ["2026-06-04"])
    # Yahoo had not applied that bonus to its 2024 prices; the lake's raw close says so.
    assert history.raw(date(2024, 4, 19), near=4158.95) == (pytest.approx(4158.95), [])


def test_asset_definitions_place_a_split_series_in_time():
    events = pd.DataFrame(
        [
            {"symbol": "VEDL", "event_date": pd.Timestamp("2026-04-29"), "new_column": "VEDL#2"},
            {"symbol": "STAR", "event_date": pd.Timestamp("2019-03-06"), "new_column": "STAR#2"},
            {"symbol": "STAR", "event_date": pd.Timestamp("2021-08-12"), "new_column": "STAR#3"},
        ]
    )
    names = {"VEDL", "VEDL#2", "STAR#2", "TCS", "Gold", CASH}
    base = {n: n.split("#", 1)[0] for n in names}
    assets = bundle_mod.asset_definitions(names, base, events)
    assert assets["VEDL"] == {
        "kind": "stock",
        "symbol": "VEDL",
        "from": None,
        "until": "2026-04-27",
    }
    assert assets["VEDL#2"] == {
        "kind": "stock",
        "symbol": "VEDL",
        "from": "2026-04-27",
        "until": None,
    }
    assert assets["STAR#2"]["from"] == "2019-03-04" and assets["STAR#2"]["until"] == "2021-08-09"
    assert assets["TCS"] == {"kind": "stock", "symbol": "TCS", "from": None, "until": None}
    assert assets["Gold"] == {"kind": "series", "instrument": "Gold"}
    assert assets[CASH] == {"kind": "liquid_fund", "instrument": CASH}
