"""The Momentum API, on generated prices so it doesn't depend on downloaded data."""

import json
import os

import numpy as np
import pandas as pd
import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

from momentum_backtesting import api
from momentum_backtesting.fetch import load_universe
from momentum_backtesting.run_parts import RunParts


@pytest.fixture
def client(tmp_path, monkeypatch):
    weeks = pd.date_range("2016-01-01", periods=180, freq="W-FRI")
    rng = np.random.default_rng(7)
    prices = pd.DataFrame(
        {
            inst.name: 100 * np.cumprod(1 + rng.normal(0.002, 0.03, len(weeks)))
            for inst in load_universe()
        },
        index=weeks,
    )
    prices["Cash (liquid fund)"] = 100 * np.cumprod(np.full(len(weeks), 1.0012))
    prices.index.name = "week_ending"
    prices.to_csv(tmp_path / "weekly_closes.csv")
    monkeypatch.setattr(api, "DATA_DIR", tmp_path)
    monkeypatch.setattr(api, "DATA", api._Data())
    return TestClient(api.create_app())


def test_data_get_prefers_the_database_over_the_csv_once_populated(tmp_path, monkeypatch):
    """_Data.get() (the ETF/index dataset _custom_index_backtest etc. all build on) should
    prefer momentum_prices once `mbt local migrate` has populated it, over weekly_closes.csv -
    and must still fall back to the CSV untouched on a fresh checkout (every other fixture in
    this file relies on exactly that fallback)."""
    from trading_data.db import connect

    monkeypatch.setattr(api, "DATA_DIR", tmp_path)
    monkeypatch.setattr(api, "DATA", api._Data())

    # No catalog, no CSV yet: a clear 409, not a crash.
    with pytest.raises(HTTPException):
        api.DATA.get()

    # CSV only (no catalog) - the existing fallback path every other test fixture uses.
    weeks = pd.date_range("2020-01-03", periods=5, freq="W-FRI")
    csv_frame = pd.DataFrame({"A": [1.0, 2.0, 3.0, 4.0, 5.0]}, index=weeks)
    csv_frame.index.name = "week_ending"
    csv_frame.to_csv(tmp_path / "weekly_closes.csv")
    monkeypatch.setattr(api, "DATA", api._Data())
    from_csv = api.DATA.get()
    assert list(from_csv["A"]) == [1.0, 2.0, 3.0, 4.0, 5.0]
    assert list(from_csv.index) == list(csv_frame.index)

    # Now populate the database with DIFFERENT values under the same instrument name - if
    # the DB is truly preferred, .get() must return these, not the CSV's [1..5].
    db_root = tmp_path / "tdroot"
    monkeypatch.setenv("TRADING_DATA_ROOT", str(db_root))
    db_frame = pd.DataFrame({"A": [10.0, 20.0, 30.0, 40.0, 50.0]}, index=weeks)
    with connect(db_root) as con:
        con.executemany(
            "INSERT INTO momentum_prices VALUES ('A', 'weekly', ?, NULL, ?)",
            [[week.date(), value] for week, value in db_frame["A"].items()],
        )
    monkeypatch.setattr(api, "DATA", api._Data())
    got = api.DATA.get()
    assert list(got["A"]) == [10.0, 20.0, 30.0, 40.0, 50.0]
    assert list(got["A"]) != list(csv_frame["A"])  # proves it did NOT read the CSV


# Real company_ids from stocks/curated/companies.csv - ui_data._load_companies() always reads
# that bundled file directly (not from data_dir), so the synthetic dataset below must reuse real
# ids for their names to resolve. STOCK_IDS[-1] ("C0006") is given a strong deterministic uptrend
# but is never a membership True - it exists to prove the membership gate, not the ranking.
STOCK_IDS = ["C0001", "C0002", "C0003", "C0004", "C0005", "C0006"]

# The 4 non-company instruments this task adds - real names, not company_ids (see
# ui_data.StockDataset.extra_instruments). Gold/Silver are "core" (always rankable); Cash/Gilt
# are "defensive" (ranked only under defensive="ranked").
EXTRA_NAMES = ["Gold", "Silver", "Cash (liquid fund)", "Gilt 8-13 yr"]


@pytest.fixture
def stock_client(tmp_path, monkeypatch):
    weeks = pd.date_range("2016-01-01", periods=80, freq="W-FRI")
    rng = np.random.default_rng(11)
    stocks_dir = tmp_path / "stocks"
    stocks_dir.mkdir()

    data = {
        name: 100 * np.cumprod(1 + rng.normal(0.001, 0.02, len(weeks))) for name in STOCK_IDS[:-1]
    }
    # A clear winner-by-return that must never be bought, since it's never a member.
    data[STOCK_IDS[-1]] = 100 * np.cumprod(1 + rng.normal(0.02, 0.02, len(weeks)))
    tr = pd.DataFrame(data, index=weeks)
    tr.index.name = "week_ending"
    tr.to_csv(stocks_dir / "nifty50_weekly_tr.csv")
    tr.to_csv(stocks_dir / "nifty50_weekly_price.csv")  # ex-dividend series unused by these tests

    membership = pd.DataFrame(True, index=weeks, columns=STOCK_IDS[:-1])
    membership[STOCK_IDS[-1]] = False  # never an index member
    membership.index.name = "week_ending"
    membership.to_csv(stocks_dir / "nifty50_membership_weekly.csv")

    benchmarks = pd.DataFrame(
        {
            "nifty50_tri": 100 * np.cumprod(1 + rng.normal(0.001, 0.015, len(weeks))),
            "nifty200_momentum30_tri": 100 * np.cumprod(1 + rng.normal(0.0012, 0.02, len(weeks))),
            "nifty50_ew_tri": 100 * np.cumprod(1 + rng.normal(0.001, 0.016, len(weeks))),
        },
        index=weeks,
    )
    benchmarks.index.name = "week_ending"
    benchmarks.to_csv(stocks_dir / "benchmarks_weekly.csv")

    cash = pd.DataFrame({"date": weeks, "close": 100 * np.cumprod(np.full(len(weeks), 1.0008))})
    cash.to_csv(stocks_dir / "cash_weekly.csv", index=False)

    # weekly_closes.csv - the ETF pipeline's own output (a sibling of stocks_dir, not under it;
    # see ui_data._load_extra_instruments) - carries the 4 extra instruments. Gold is given the
    # strongest deterministic uptrend in this fixture (steeper than even C0006's noisy 2%/week
    # mean), so it reliably ranks #1 once eligible - analogous to how C0006 was engineered as a
    # never-a-member winner, but here to prove an extra instrument CAN win a portfolio slot.
    # Cash (liquid fund) is included for schema realism even though the loader never reads it
    # from here - CASH is already priced via cash_weekly.csv above (see _EXTRA_PRICE_COLUMNS).
    weekly_closes = pd.DataFrame(
        {
            "Gold": 100 * (1.03 ** np.arange(len(weeks))),
            "Silver": 100 * (1.006 ** np.arange(len(weeks))),
            "Cash (liquid fund)": 100 * np.cumprod(np.full(len(weeks), 1.0008)),
            "Gilt 8-13 yr": 100 * (1.001 ** np.arange(len(weeks))),
        },
        index=weeks,
    )
    weekly_closes.index.name = "week_ending"
    weekly_closes.to_csv(tmp_path / "weekly_closes.csv")

    monkeypatch.setattr(api, "DATA_DIR", tmp_path)
    monkeypatch.setattr(api, "DATA", api._Data())
    return TestClient(api.create_app())


SYNTHETIC_CATEGORIES = {
    "Synthetic Alpha": ["S1", "S2"],
    "Synthetic Beta": ["S3", "S4"],
    "Synthetic Gamma": ["S5", "S6"],
}


@pytest.fixture
def custom_index_client(tmp_path, monkeypatch):
    """Everything api._custom_index_meta/_custom_index_backtest reads: the ETF weekly_closes.csv
    (only for its CASH/benchmark columns and the weekly index the Custom Index table gets
    reindexed onto - see api._Data.get_categories_universe), an empty-but-present
    category_membership.csv (so resolve.py's per-category lookups don't raise "run `mbt
    categories fetch`" for a fixture that simply has no official-index data), a synthetic
    category_extras.csv with three custom categories, and a synthetic daily.parquet for their
    stocks. The real 16 official NSE categories are still listed by api.CATEGORIES_CURATED_DIR-
    independent `sources.available_categories()`, but have no membership/extras data here, so a
    backtest against them alone would find nothing to resolve - see build_all_categories_price_
    table's own graceful-skip behaviour (tests/categories/test_compose.py covers that directly).
    """
    weeks = pd.date_range("2016-01-01", periods=180, freq="W-FRI")
    rng = np.random.default_rng(13)

    prices = pd.DataFrame(
        {
            inst.name: 100 * np.cumprod(1 + rng.normal(0.002, 0.03, len(weeks)))
            for inst in load_universe()
        },
        index=weeks,
    )
    prices["Cash (liquid fund)"] = 100 * np.cumprod(np.full(len(weeks), 1.0012))
    prices.index.name = "week_ending"
    prices.to_csv(tmp_path / "weekly_closes.csv")

    categories_dir = tmp_path / "categories"
    categories_dir.mkdir()
    pd.DataFrame(columns=["category", "year", "symbol", "source_tier", "wayback_timestamp"]).to_csv(
        categories_dir / "category_membership.csv", index=False
    )

    curated_dir = tmp_path / "curated"
    curated_dir.mkdir()
    extras_rows = "\n".join(
        f"{symbol},{category},test"
        for category, symbols in SYNTHETIC_CATEGORIES.items()
        for symbol in symbols
    )
    (curated_dir / "category_extras.csv").write_text(f"symbol,category,note\n{extras_rows}\n")

    stocks_dir = tmp_path / "stocks"
    stocks_dir.mkdir()
    all_symbols = [s for symbols in SYNTHETIC_CATEGORIES.values() for s in symbols]
    rows = []
    for i, symbol in enumerate(all_symbols):
        series = 100 * np.cumprod(1 + rng.normal(0.0015 + 0.0005 * i, 0.03, len(weeks)))
        for date, close in zip(weeks, series, strict=True):
            rows.append(
                {
                    "date": date.strftime("%Y-%m-%d"),
                    "symbol": symbol,
                    "close": float(close),
                    "turnover": 1_000_000.0,
                }
            )
    pd.DataFrame(rows, columns=["date", "symbol", "close", "turnover"]).to_parquet(
        stocks_dir / "daily.parquet"
    )

    monkeypatch.setattr(api, "DATA_DIR", tmp_path)
    monkeypatch.setattr(api, "CATEGORIES_CURATED_DIR", curated_dir)
    monkeypatch.setattr(api, "DATA", api._Data())
    return TestClient(api.create_app())


def core(client):
    return [
        i["name"] for i in client.get("/api/meta").json()["instruments"] if i["include"] == "core"
    ]


def test_meta_lists_every_instrument_with_its_data_start(client):
    meta = client.get("/api/meta").json()
    assert len(meta["instruments"]) == len(load_universe())
    assert all(i["has_data"] and i["first_week"] for i in meta["instruments"])
    assert meta["defaults"]["portfolio"] == "buffer"


@pytest.mark.parametrize(
    "extra",
    [
        {},
        {"entry": "make_room"},
        {"portfolio": "slots"},
        {"defensive": "filter"},
        {"defensive": "ranked", "universe_add": ["Cash (liquid fund)", "Gilt 8-13 yr"]},
        {"tax": True, "slab_rate": 0.2},
        {"lookbacks": [1, 4, 13], "weights": [1.5, 1.25, 1.0], "top_n": 3, "exit_rank": 9},
    ],
)
def test_backtest_returns_a_complete_json_payload(client, extra):
    universe = core(client) + extra.pop("universe_add", [])
    res = client.post("/api/backtest", json={"universe": universe, "start": "2017-01-06", **extra})
    assert res.status_code == 200, res.text
    body = res.json()
    for key in (
        "kpis",
        "series",
        "rotations",
        "trades",
        "instruments",
        "timeline",
        "yearly",
        "latest",
    ):
        assert key in body
    series = body["series"]
    assert len(series["dates"]) == len(series["strategy"]) == len(series["benchmark"])
    assert body["latest"]["rows"]
    json.dumps(body, allow_nan=False)  # no NaN/Infinity reaches the browser


def test_filtering_the_universe_limits_what_is_ranked_and_held(client):
    chosen = core(client)[:8]
    body = client.post("/api/backtest", json={"universe": chosen, "top_n": 3}).json()
    assert set(body["universe"]) == set(chosen)
    held = {s["asset"] for s in body["timeline"]}
    assert held <= set(chosen)


def test_too_few_instruments_for_top_n_is_a_clear_error(client):
    res = client.post("/api/backtest", json={"universe": core(client)[:3], "top_n": 5})
    assert res.status_code == 422
    assert "need at least top N" in res.json()["detail"]


def test_bad_rule_combinations_are_rejected(client):
    universe = core(client)
    assert (
        client.post(
            "/api/backtest", json={"universe": universe, "top_n": 6, "exit_rank": 4}
        ).status_code
        == 422
    )
    assert (
        client.post(
            "/api/backtest", json={"universe": universe, "lookbacks": [1, 4], "weights": [1.0]}
        ).status_code
        == 422
    )
    assert (
        client.post(
            "/api/backtest", json={"universe": universe, "benchmark": "Not an index"}
        ).status_code
        == 422
    )


def test_legacy_ui_is_not_served(client):
    assert client.get("/").status_code == 404
    assert client.get("/static/app.js").status_code == 404
    assert client.get("/vendor/plotly.min.js").status_code == 404
    assert client.get("/api/docs").status_code == 200


def _daily_files(tmp_path, etf_names=("Nifty 50", "Nifty IT")):
    """Daily files from the weekly table (one row per week is enough for fills), plus ETFs
    for a couple of instruments that 'listed' part-way through at a small premium."""
    weekly = pd.read_csv(tmp_path / "weekly_closes.csv", index_col=0, parse_dates=True)
    (tmp_path / "daily").mkdir()
    (tmp_path / "daily_etf").mkdir()
    for name in weekly:
        closes = weekly[name].dropna()
        monday = closes.copy()
        monday.index = monday.index + pd.Timedelta(days=3)
        daily = pd.concat([closes, monday * 1.001]).sort_index().to_frame("close")
        daily["open"] = daily["close"]
        daily.to_csv(tmp_path / "daily" / f"{name}.csv", index_label="date")
        if name in etf_names:
            listed = daily[daily.index >= "2019-01-01"] * 1.01
            listed.to_csv(tmp_path / "daily_etf" / f"{name}.csv", index_label="date")


@pytest.mark.parametrize("execution", ["fri_close", "mon_open", "mon_10am"])
def test_backtest_on_etf_prices_marks_proxy_trades(client, tmp_path, execution):
    _daily_files(tmp_path)
    res = client.post(
        "/api/backtest",
        json={
            "universe": core(client),
            "start": "2017-01-06",
            "track": "etf",
            "execution": execution,
        },
    )
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["fills"]["track"] == "etf" and body["fills"]["execution"] == execution
    assert all("proxy" in t for t in body["trades"])
    if execution == "mon_10am":  # no intraday files: every 10:00 fill fell back to the open
        assert body["fills"]["warnings"]


def test_etf_track_without_daily_files_says_to_refetch(client):
    res = client.post(
        "/api/backtest", json={"universe": core(client), "start": "2017-01-06", "track": "etf"}
    )
    assert res.status_code == 409 and "mbt fetch" in res.json()["detail"]


def test_tracking_command_writes_its_report(client, tmp_path, monkeypatch):
    from typer.testing import CliRunner

    from momentum_backtesting import cli, trade_prices

    _daily_files(tmp_path)
    monkeypatch.setattr(cli, "DATA_DIR", tmp_path)
    monkeypatch.setattr(trade_prices, "DATA_DIR", tmp_path)
    out = CliRunner().invoke(cli.app, ["tracking", "--start", "2017-01-06"])
    assert out.exit_code == 0, out.output
    assert "track x execution" in out.output and "No premium data" in out.output
    assert (tmp_path / "backtests" / "tracking.xlsx").exists()


# --- stock-momentum dataset --------------------------------------------------------------------
def test_etf_backtest_has_no_companies_field(client):
    """The ETF payload never carries a `companies` map - that's a stock-only, dataset="stock" key
    (see _stock_backtest). `dataset` omitted from the request must still default to "etf"."""
    res = client.post("/api/backtest", json={"universe": core(client), "start": "2017-01-06"})
    assert res.status_code == 200, res.text
    assert "companies" not in res.json()


def test_stock_dataset_missing_gives_a_clear_409_not_a_500(client):
    """`client` (not `stock_client`) never writes a data/stocks/ dir."""
    res = client.get("/api/meta?dataset=stock")
    assert res.status_code == 409
    assert "mbt stocks fetch" in res.json()["detail"]

    res2 = client.post(
        "/api/backtest", json={"dataset": "stock", "universe": ["C0001"], "start": "2016-01-01"}
    )
    assert res2.status_code == 409
    assert "mbt stocks fetch" in res2.json()["detail"]


def test_stock_meta_returns_companies_and_benchmarks(stock_client):
    meta = stock_client.get("/api/meta?dataset=stock").json()
    assert meta["benchmarks"] == [
        "Nifty 50 TRI",
        "Nifty200 Momentum 30 TRI",
        "Nifty50 Equal Weight TRI",
    ]
    # Every row of the bundled curated/companies.csv is listed, regardless of which ids this
    # fixture's synthetic price data actually covers - meta always reflects the full company
    # roster (has_data is always True for stocks; see _stock_meta) - plus the 4 extra
    # instruments (Gold/Silver/Cash (liquid fund)/Gilt 8-13 yr; see test_stock_meta_lists_the_
    # four_extra_instruments for their own group/include/defaults assertions).
    assert len(meta["instruments"]) == 96 + 4
    by_id = {i["name"]: i for i in meta["instruments"]}
    assert set(STOCK_IDS) <= set(by_id)
    assert set(EXTRA_NAMES) <= set(by_id)
    assert by_id["C0001"]["display_name"] == "ACC Ltd."
    assert by_id["C0001"]["include"] == "core"
    assert by_id["C0001"]["group"] == "Current member"
    # C0006 is never a membership True in this fixture, so meta must classify it as former/optional.
    assert by_id["C0006"]["include"] == "optional"
    assert by_id["C0006"]["group"] == "Former member"
    assert all(i["has_data"] for i in meta["instruments"])
    assert meta["defaults"]["cost_model"] == "itemised"
    assert meta["defaults"]["capital"] == 1_000_000.0
    assert meta["defaults"]["score"] == "ranksum"
    assert meta["defaults"]["portfolio"] == "buffer"
    json.dumps(meta, allow_nan=False)


def test_stock_meta_lists_the_four_extra_instruments(stock_client):
    """Gold/Silver/Cash (liquid fund)/Gilt 8-13 yr must appear in the stock-mode instrument list
    with the group/include tags ui_data.load_stock_dataset assigns them, and the stock dataset's
    default must be defensive="ranked" (the literal ask: they compete out of the box, not behind
    a toggle the user has to discover) - the ETF dataset's own default is untouched, see
    test_meta_lists_every_instrument_with_its_data_start."""
    meta = stock_client.get("/api/meta?dataset=stock").json()
    by_name = {i["name"]: i for i in meta["instruments"]}
    assert set(EXTRA_NAMES) <= set(by_name)
    for name in ("Gold", "Silver"):
        assert by_name[name]["group"] == "Commodity"
        assert by_name[name]["include"] == "core"
        assert by_name[name]["has_data"] is True
    for name in ("Cash (liquid fund)", "Gilt 8-13 yr"):
        assert by_name[name]["group"] == "Debt"
        assert by_name[name]["include"] == "defensive"
        assert by_name[name]["has_data"] is True
    assert meta["defaults"]["defensive"] == "ranked"
    json.dumps(meta, allow_nan=False)


def test_stock_defensive_ranked_lets_gold_fill_a_portfolio_slot(stock_client):
    """The literal ask this task implements: with defensive="ranked" (now the stock default),
    Gold competes in the SAME rank table as the 96 stocks, and when it ranks within top_n it
    fills a normal portfolio slot exactly like a stock would - not a separate side-allocation.
    Gold's deterministic uptrend in this fixture (see stock_client) makes it rank #1 for nearly
    the whole backtest once eligible, so it should end up an open position."""
    res = stock_client.post(
        "/api/backtest",
        json={
            "dataset": "stock",
            "universe": STOCK_IDS + EXTRA_NAMES,
            "start": "2016-01-01",
            "top_n": 2,
            "exit_rank": 3,
            "benchmark": "Nifty 50 TRI",
            "defensive": "ranked",
        },
    )
    assert res.status_code == 200, res.text
    body = res.json()
    # All 4 extras were offered to the ranker under "ranked" mode.
    assert set(EXTRA_NAMES) <= set(body["universe"])
    bought = {i["asset"] for rot in body["rotations"] for i in rot["ins"]}
    held = {p["asset"] for p in body["open_positions"]}
    assert "Gold" in bought
    assert "Gold" in held
    json.dumps(body, allow_nan=False)


def test_stock_defensive_off_still_ranks_gold_silver_but_not_cash_gilt(stock_client):
    """Getting this backwards is the easy mistake: "core"-tagged Gold/Silver are never gated by
    the defensive-mode toggle at all (they rank under defensive="off" exactly like any stock),
    while "defensive"-tagged Cash/Gilt only join the rank table under defensive="ranked" - the
    same distinction the ETF universe already draws for these two instruments (universe.csv)."""
    res = stock_client.post(
        "/api/backtest",
        json={
            "dataset": "stock",
            "universe": STOCK_IDS + EXTRA_NAMES,
            "start": "2016-01-01",
            "top_n": 2,
            "exit_rank": 3,
            "benchmark": "Nifty 50 TRI",
            "defensive": "off",
        },
    )
    assert res.status_code == 200, res.text
    ranked = set(res.json()["universe"])
    assert {"Gold", "Silver"} <= ranked
    assert "Cash (liquid fund)" not in ranked
    assert "Gilt 8-13 yr" not in ranked


def test_stock_backtest_runs_end_to_end_with_raw_ids_and_display_names(stock_client):
    res = stock_client.post(
        "/api/backtest",
        json={
            "dataset": "stock",
            "universe": STOCK_IDS,
            "start": "2016-01-01",
            "top_n": 2,
            "exit_rank": 3,
            "benchmark": "Nifty 50 TRI",
        },
    )
    assert res.status_code == 200, res.text
    body = res.json()
    for key in ("kpis", "series", "rotations", "trades", "instruments", "timeline", "latest"):
        assert key in body
    # The API's job: trades/timeline carry the engine's raw company_id. Display-name
    # substitution for people to read is the dashboard's job.
    assert "companies" in body
    assert body["companies"]["C0001"] == "ACC Ltd."
    assert all(t["asset"] in STOCK_IDS for t in body["trades"])
    assert all(seg["asset"] in STOCK_IDS for seg in body["timeline"])
    json.dumps(body, allow_nan=False)


def test_stock_membership_gates_fresh_buys_via_the_api(stock_client):
    """C0006 has the strongest deterministic uptrend in the fixture (so it would always rank
    top) but is never a membership True - mirrors
    tests/stocks/test_engine_stocks.py::test_membership_gate_blocks_a_new_buy_of_a_non_member,
    exercised through the API rather than run_backtest() directly."""
    res = stock_client.post(
        "/api/backtest",
        json={
            "dataset": "stock",
            "universe": STOCK_IDS,
            "start": "2016-01-01",
            "top_n": 2,
            "exit_rank": 3,
            "benchmark": "Nifty 50 TRI",
        },
    )
    assert res.status_code == 200, res.text
    body = res.json()
    bought = {i["asset"] for rot in body["rotations"] for i in rot["ins"]}
    assert "C0006" not in bought
    held = {p["asset"] for p in body["open_positions"]}
    assert "C0006" not in held


def test_stock_this_week_panel_never_recommends_buying_a_non_member(stock_client):
    """The advisory 'This week' panel must apply the same membership gate as the real trading
    loop - C0006 has the strongest uptrend in the fixture and would rank #1, but it's never an
    index member, so it must never show as BUY/ADD there either (the gap this test guards
    against: analysis.latest_signal used to rank-select buy candidates with no membership check
    at all, so it could recommend a trade the engine itself would refuse)."""
    res = stock_client.post(
        "/api/backtest",
        json={
            "dataset": "stock",
            "universe": STOCK_IDS,
            "start": "2016-01-01",
            "top_n": 2,
            "exit_rank": 3,
            "benchmark": "Nifty 50 TRI",
        },
    )
    assert res.status_code == 200, res.text
    rows = {r["asset"]: r["action"] for r in res.json()["latest"]["rows"]}
    assert rows["C0006"] not in ("BUY", "ADD", "BUY (make room)")
    assert rows["C0006"] == "NOT A MEMBER"


# --- "Custom Index" dataset (categories/compose.py's build_all_categories_price_table) --------
def _custom_index_request(**overrides) -> dict:
    req = {
        "dataset": "custom_index",
        "universe": list(SYNTHETIC_CATEGORIES),
        "start": "2017-01-01",
        "top_n": 2,
        "exit_rank": 3,
        "inner_top_n": 2,
        "inner_exit_rank": 3,
        "benchmark": "Nifty 50",
        "portfolio": "buffer",
    }
    req.update(overrides)
    return req


def test_custom_index_meta_missing_category_data_gives_a_clear_409(client):
    """`client` (not `custom_index_client`) never writes a data/categories/ dir."""
    res = client.get("/api/meta?dataset=custom_index")
    assert res.status_code == 409
    assert "mbt categories fetch" in res.json()["detail"]

    res2 = client.post("/api/backtest", json=_custom_index_request())
    assert res2.status_code == 409
    assert "mbt categories fetch" in res2.json()["detail"]


def test_custom_index_meta_lists_official_and_custom_categories(custom_index_client):
    meta = custom_index_client.get("/api/meta?dataset=custom_index").json()
    by_name = {i["name"]: i for i in meta["instruments"]}
    assert set(SYNTHETIC_CATEGORIES) <= set(by_name)
    for name in SYNTHETIC_CATEGORIES:
        assert by_name[name]["group"] == "Custom"
        assert by_name[name]["include"] == "core"
    # The real 16 official NSE categories are always listed (sources.available_categories() is
    # not tied to this fixture's data), even though this fixture has none of their data - a
    # backtest run against them would simply find them unresolvable (see build_all_categories_
    # price_table's graceful skip, exercised directly in tests/categories/test_compose.py).
    assert "Nifty Bank" in by_name
    assert by_name["Nifty Bank"]["group"] == "Official (NSE)"
    assert meta["benchmarks"] == ["Nifty 50"]
    # TODO.md 3.9.8: 8/16, not the ETF/stock-mode 5/10 - holding more categories at once
    # meaningfully cut real-backtest max drawdown without giving up CAGR (see api.py's
    # _custom_index_meta docstring/comment for the before/after numbers).
    assert meta["defaults"]["top_n"] == 8
    assert meta["defaults"]["exit_rank"] == 16
    assert meta["defaults"]["inner_top_n"] == 2
    assert meta["defaults"]["inner_exit_rank"] == 8
    # TODO.md 3.9.8 follow-up: an opt-in try-it toggle, not a new default like top_n/exit_rank
    # above - must stay False until the user has seen real before/after numbers.
    assert meta["defaults"]["momentum_sizing"] is False
    json.dumps(meta, allow_nan=False)


def test_custom_index_backtest_diversifies_across_categories(custom_index_client):
    """The whole point of this tab: holding the outer top_n at once structurally spreads a
    portfolio across that many different categories, rather than a user having to manually avoid
    over-concentrating in one thin category."""
    res = custom_index_client.post("/api/backtest", json=_custom_index_request())
    assert res.status_code == 200, res.text
    body = res.json()
    held = [row for row in body["instruments"] if row["weeks_held"] > 0]
    assert len(held) >= 2
    for row in held:
        assert row["asset"] in SYNTHETIC_CATEGORIES
        assert row["group"] == "Custom"
    assert body.get("skipped_categories")  # the 16 official categories, unresolvable here
    json.dumps(body, allow_nan=False)


def test_custom_index_backtest_accepts_momentum_sizing(custom_index_client):
    """Round-trips the new momentum_sizing request field through _config_kwargs into a real
    backtest (engine.py's Config.momentum_sizing, buffer rule only) without erroring, both on and
    off - the API-wiring half of the momentum-sizing feature (see test_engine.py for the
    win-rate-multiplier arithmetic and the buffer-rule wiring itself)."""
    off = custom_index_client.post(
        "/api/backtest", json=_custom_index_request(momentum_sizing=False)
    )
    on = custom_index_client.post("/api/backtest", json=_custom_index_request(momentum_sizing=True))
    assert off.status_code == 200, off.text
    assert on.status_code == 200, on.text
    json.dumps(off.json(), allow_nan=False)
    json.dumps(on.json(), allow_nan=False)


def test_custom_index_backtest_exposes_inner_stock_detail(custom_index_client):
    """The per-category stock-level detail api._inner_category_detail threads through: every
    category actually held at the outer level must show which of its own stocks (S1/S2 for
    Synthetic Alpha, etc. - see SYNTHETIC_CATEGORIES) it bought/sold and currently holds, not
    just the category-level rotation."""
    res = custom_index_client.post("/api/backtest", json=_custom_index_request())
    assert res.status_code == 200, res.text
    body = res.json()
    held = [row["asset"] for row in body["instruments"] if row["weeks_held"] > 0]
    held_now = [row["asset"] for row in body["instruments"] if row["held_now"]]
    assert held  # sanity: the diversification test above already asserts >= 2
    assert held_now  # sanity: at least one category is still held at the backtest's last week

    inner = body["inner_categories"]
    assert set(held) <= set(inner)  # every EVER-held category has its own inner detail
    # A category never held at the outer level (e.g. one of the 16 unresolvable official ones,
    # or a synthetic one this run's top_n/exit_rank never selected) has no entry at all - the
    # payload stays bounded to categories that were actually candidates, not all ~66.
    assert set(inner) <= set(SYNTHETIC_CATEGORIES)

    for category in held:
        detail = inner[category]
        own_stocks = set(SYNTHETIC_CATEGORIES[category])
        assert detail["trades"], f"{category} was held but has no inner trade history"
        actions = {row["action"] for row in detail["trades"]}
        assert "BUY" in actions
        for row in detail["trades"]:
            assert row["asset"] in own_stocks

    # holdings_now reflects the OUTER's own latest week - only meaningful (non-empty) for a
    # category the outer portfolio is STILL holding as of that week, not one it sold earlier and
    # walked away from (that category's inner rotation keeps running underneath regardless, since
    # every category's inner backtest spans the whole period unconditionally - see
    # build_all_categories_price_table - it's just no longer part of the outer portfolio).
    for category in held_now:
        holdings_now = inner[category]["holdings_now"]
        own_stocks = set(SYNTHETIC_CATEGORIES[category])
        assert holdings_now, f"{category} is held now but reports no current holdings"
        for holding in holdings_now:
            assert holding["asset"] in own_stocks
            assert 0 < holding["share"] <= 1
    json.dumps(body, allow_nan=False)


def test_custom_index_inner_trades_with_a_mixed_buy_sell_history_serialize(custom_index_client):
    """Regression test for a real bug this task found live (2026-09) against real category
    data, never hit by the fixture-driven test above: `inner_top_n=1, inner_exit_rank=1` forces
    each 2-stock synthetic category to actually rotate (only one of its two stocks held at a
    time, sold the moment it isn't ranked first), so a category's own inner `trades` mixes BUY
    rows (no `entry_week`) with SELL rows (a real `entry_week`) in the same column - pandas
    infers that column as datetime64, so a BUY row's missing `entry_week` comes back as `pd.NaT`,
    not plain `None`/NaN. `_inner_category_detail`'s (api.py) `analysis._clean` call used to leave
    `NaT` unconverted, which FastAPI/pydantic-core's response serializer rejected with
    `TypeError: 'float' object cannot be interpreted as an integer` (500) - `analysis._clean` now
    maps `NaT` to `None` (see its own docstring). This test would fail with that 500 if the fix
    ever regresses."""
    res = custom_index_client.post(
        "/api/backtest",
        json=_custom_index_request(inner_top_n=1, inner_exit_rank=1),
    )
    assert res.status_code == 200, res.text
    body = res.json()
    inner = body["inner_categories"]
    assert inner

    sell_rows = [
        row for detail in inner.values() for row in detail["trades"] if row["action"] == "SELL"
    ]
    buy_rows = [
        row for detail in inner.values() for row in detail["trades"] if row["action"] == "BUY"
    ]
    assert sell_rows, "inner_top_n=1/inner_exit_rank=1 should force at least one inner rotation"
    assert buy_rows
    # The specific bug: a BUY row's entry_week must come back JSON-null, not raise before this
    # response body could even be produced.
    assert all(row["entry_week"] is None for row in buy_rows)
    assert all(row["entry_week"] is not None for row in sell_rows)
    json.dumps(body, allow_nan=False)


def test_custom_index_backtest_rejects_too_few_categories_for_top_n(custom_index_client):
    res = custom_index_client.post(
        "/api/backtest", json=_custom_index_request(universe=["Synthetic Alpha"], top_n=2)
    )
    assert res.status_code == 422


def test_custom_index_backtest_rejects_mismatched_weights(custom_index_client):
    res = custom_index_client.post(
        "/api/backtest",
        json=_custom_index_request(weights=[1, 1]),  # 5 default lookbacks
    )
    assert res.status_code == 422


def test_custom_index_universe_cache_is_keyed_on_inner_params_only(custom_index_client):
    """An OUTER-only change (top_n here) must reuse the already-built AllCategoriesResult -
    changing an INNER change (inner_top_n) must build a fresh one. Verified via the cache dict
    directly (api.DATA.custom_index_cache), not just wall-clock time, so this stays fast and
    deterministic in CI."""
    custom_index_client.post("/api/backtest", json=_custom_index_request(top_n=2))
    assert len(api.DATA.custom_index_cache) == 1

    custom_index_client.post("/api/backtest", json=_custom_index_request(top_n=3, exit_rank=4))
    assert len(api.DATA.custom_index_cache) == 1  # same inner params -> reused, not rebuilt

    custom_index_client.post("/api/backtest", json=_custom_index_request(inner_top_n=1))
    assert len(api.DATA.custom_index_cache) == 2  # different inner params -> a second entry


# ---------------------------------------------------------------------------------------------
# dataset="broad" -- "Broad Momentum" (TODO.md 3.9.13): a 755-name universe in the real repo,
# synthesised here as a handful of symbols spread across two categories plus one "orphan" symbol
# that belongs to neither (proves the coverage floor/pool-membership gates actually filter, not
# just pass everything through).
# ---------------------------------------------------------------------------------------------

BROAD_CATEGORIES = {
    "Test Parent :: Alpha": ["BA1", "BA2", "BA3"],
    "Test Parent :: Beta": ["BB1", "BB2"],
}
BROAD_ORPHAN_SYMBOL = "BORPHAN"  # priced, Total-Market member, but in no stock_groups.csv row


def _broad_request(**overrides) -> dict:
    req = {"dataset": "broad", "universe": ["*"], "start": "2017-01-01"}
    req.update(overrides)
    return req


@pytest.fixture
def broad_client(tmp_path, monkeypatch):
    """Everything api._broad_meta/_broad_backtest read: weekly_closes.csv (CASH + the 4 atomic
    columns broad.ATOMIC_NAMES expects), data/categories/total_market_membership.csv (every
    BROAD_CATEGORIES symbol + the orphan, every year so the coverage-floor/pool-membership gates
    have something real to filter), a synthetic curated/stock_groups.csv (BROAD_CATEGORIES, in
    the real file's own column shape), and a synthetic daily.parquet for all of it."""
    weeks = pd.date_range("2016-01-01", periods=220, freq="W-FRI")
    rng = np.random.default_rng(29)

    prices = pd.DataFrame(index=weeks)
    for name in ("Gold", "Silver", "Nasdaq 100", "Hang Seng"):
        prices[name] = 100 * np.cumprod(1 + rng.normal(0.0008, 0.02, len(weeks)))
    prices["Nifty 50"] = 100 * np.cumprod(1 + rng.normal(0.0008, 0.02, len(weeks)))
    prices["Cash (liquid fund)"] = 100 * np.cumprod(np.full(len(weeks), 1.0012))
    prices.index.name = "week_ending"
    prices.to_csv(tmp_path / "weekly_closes.csv")

    all_symbols = [s for symbols in BROAD_CATEGORIES.values() for s in symbols] + [
        BROAD_ORPHAN_SYMBOL
    ]

    categories_dir = tmp_path / "categories"
    categories_dir.mkdir()
    membership_rows = [
        {
            "category": "Total Market",
            "year": year,
            "symbol": symbol,
            "source_tier": "constant_current",
            "wayback_timestamp": "",
        }
        for year in range(2016, 2027)
        for symbol in all_symbols
    ]
    pd.DataFrame(
        membership_rows, columns=["category", "year", "symbol", "source_tier", "wayback_timestamp"]
    ).to_csv(categories_dir / "total_market_membership.csv", index=False)

    curated_dir = tmp_path / "curated"
    curated_dir.mkdir()
    group_rows = "\n".join(
        f"Test Parent,{cid.split(' :: ')[1]},{symbol},{symbol} Ltd,test"
        for cid, symbols in BROAD_CATEGORIES.items()
        for symbol in symbols
    )
    (curated_dir / "stock_groups.csv").write_text(
        f"parent_group,subgroup,symbol,company_name,note\n{group_rows}\n"
    )

    stocks_dir = tmp_path / "stocks"
    stocks_dir.mkdir()
    rows = []
    for i, symbol in enumerate(all_symbols):
        series = 100 * np.cumprod(1 + rng.normal(0.0015 + 0.0004 * i, 0.03, len(weeks)))
        for date, close in zip(weeks, series, strict=True):
            rows.append(
                {
                    "date": date.strftime("%Y-%m-%d"),
                    "symbol": symbol,
                    "close": float(close),
                    "turnover": 1_000_000.0,
                }
            )
    pd.DataFrame(rows, columns=["date", "symbol", "close", "turnover"]).to_parquet(
        stocks_dir / "daily.parquet"
    )

    monkeypatch.setattr(api, "DATA_DIR", tmp_path)
    monkeypatch.setattr(api, "CATEGORIES_CURATED_DIR", curated_dir)
    monkeypatch.setattr(api, "DATA", api._Data())
    return TestClient(api.create_app())


def test_broad_meta_missing_universe_data_gives_a_clear_409(client):
    """`client` (not `broad_client`) never writes data/categories/total_market_membership.csv."""
    res = client.get("/api/meta?dataset=broad")
    assert res.status_code == 409
    assert "fetch-universe" in res.json()["detail"]

    res2 = client.post("/api/backtest", json=_broad_request())
    assert res2.status_code == 409


def test_broad_backtest_rejects_bad_rank_combinations_before_touching_any_data(client):
    """Validated up front, before the 409 data-existence check -- `client`'s fixture has no
    Total Market data at all, so a 422 here (not 409) proves the order."""
    assert (
        client.post(
            "/api/backtest",
            json=_broad_request(broad_category_top_n=8, broad_category_exit_rank=4),
        ).status_code
        == 422
    )
    assert (
        client.post(
            "/api/backtest",
            json=_broad_request(
                broad_category_mode="off", broad_off_top_n=20, broad_off_exit_rank=10
            ),
        ).status_code
        == 422
    )
    assert (
        client.post(
            "/api/backtest",
            json=_broad_request(broad_pool_top_n=300, broad_pool_exit_rank=200),
        ).status_code
        == 422
    )


def test_broad_meta_reports_no_instrument_picker_and_broad_defaults(broad_client):
    meta = broad_client.get("/api/meta?dataset=broad").json()
    assert meta["instruments"] == []  # no per-instrument sidebar picker for this tab
    assert meta["membership_quality"]["constant_current_years"] == list(range(2016, 2027))
    assert meta["defaults"]["broad_category_mode"] == "on"
    assert meta["defaults"]["broad_pool_top_n"] > 0
    assert meta["defaults"]["broad_category_top_n"] <= meta["defaults"]["broad_category_exit_rank"]
    # A new Broad run starts realistic: tradability gate and circuit-lock fills on (BL-010).
    assert meta["defaults"]["broad_liquidity_filter"] is True
    assert meta["defaults"]["broad_respect_circuits"] is True


def test_broad_meta_membership_warning_follows_file_provenance(broad_client, tmp_path):
    path = tmp_path / "categories" / "total_market_membership.csv"
    membership = pd.read_csv(path)
    membership.loc[membership["year"] == 2016, "source_tier"] = "historical_snapshot"
    membership.to_csv(path, index=False)

    meta = broad_client.get("/api/meta?dataset=broad").json()
    assert meta["membership_quality"]["constant_current_years"] == list(range(2017, 2027))


def test_broad_backtest_on_mode_returns_a_complete_payload(broad_client):
    res = broad_client.post(
        "/api/backtest",
        json=_broad_request(broad_coverage_floor=0.0, broad_pool_top_n=10, broad_pool_exit_rank=10),
    )
    assert res.status_code == 200, res.text
    body = res.json()
    for key in ("kpis", "series", "trades", "held_categories", "missing_symbols"):
        assert key in body
    json.dumps(body, allow_nan=False)  # no NaN/Infinity reaches the browser

    # The orphan symbol (in no stock_groups.csv row) must never appear in any held category's
    # picks -- proves the category membership gate actually filters, not just passes through.
    held_picks = {p for row in body["held_categories"] for p in row["picks"]}
    assert BROAD_ORPHAN_SYMBOL not in held_picks
    for row in body["held_categories"]:
        assert row["status"] in ("fresh", "lingering")
        assert row["position"] >= 1


def test_broad_backtest_off_mode_has_no_held_categories(broad_client):
    res = broad_client.post(
        "/api/backtest",
        json=_broad_request(
            broad_category_mode="off",
            broad_off_top_n=3,
            broad_off_exit_rank=6,
            broad_pool_top_n=10,
            broad_pool_exit_rank=10,
        ),
    )
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["held_categories"] == []
    json.dumps(body, allow_nan=False)


def test_broad_ranking_cache_is_keyed_on_step2_params_only(broad_client):
    """A Step-3/4-only change (coverage_floor here) must reuse the already-built
    UniverseRanking; a Step-2 change (pool_top_n) must build a fresh one."""
    broad_client.post(
        "/api/backtest",
        json=_broad_request(broad_coverage_floor=0.0, broad_pool_top_n=10, broad_pool_exit_rank=10),
    )
    assert len(api.DATA.broad_ranking_cache) == 1

    broad_client.post(
        "/api/backtest",
        json=_broad_request(broad_coverage_floor=0.9, broad_pool_top_n=10, broad_pool_exit_rank=10),
    )
    assert len(api.DATA.broad_ranking_cache) == 1  # same Step-2 params -> reused

    broad_client.post(
        "/api/backtest",
        json=_broad_request(broad_coverage_floor=0.0, broad_pool_top_n=15, broad_pool_exit_rank=15),
    )
    assert len(api.DATA.broad_ranking_cache) == 2  # different pool_top_n -> a second entry


# ---------------------------------------------------------------------------------------------
# TODO.md 3.9.15 -- fields newly threaded through to dataset="broad" (previously silently
# dropped or never passed at all by run_broad_backtest's own Config() call, even though the UI
# already sent them for every dataset). Each test proves the round trip with a real backtest
# (not just "the request doesn't 422") by showing the KPI numbers actually move, matching the
# session's own standard (see test_custom_index_backtest_accepts_momentum_sizing for the
# lighter-touch version of this pattern this section follows for the deterministic cases).
# ---------------------------------------------------------------------------------------------


def _broad_kpis(client, **overrides) -> dict:
    res = client.post(
        "/api/backtest",
        json=_broad_request(
            broad_coverage_floor=0.0, broad_pool_top_n=10, broad_pool_exit_rank=10, **overrides
        ),
    )
    assert res.status_code == 200, res.text
    body = res.json()
    json.dumps(body, allow_nan=False)
    return body["kpis"]


def test_broad_backtest_signal_delay_changes_the_result(broad_client):
    """signal_delay shifts the (externally-supplied) rank table before the buffer/slots
    simulation runs (engine.run_backtest applies this shift regardless of external_ranks - see
    that parameter's own docstring) - was silently dropped by run_broad_backtest before this
    fix even though the sidebar's "Trade" selector was already visible and sent on every tab."""
    no_delay = _broad_kpis(broad_client, signal_delay=0)
    delayed = _broad_kpis(broad_client, signal_delay=2)
    assert no_delay["final_value"] != delayed["final_value"]


def test_broad_backtest_itemised_cost_model_changes_cost(broad_client):
    """cost_model was never threaded to run_broad_backtest's own Config() call at all (always
    silently flat regardless of what the request sent) - itemised (STT/stamp duty/fees/
    slippage/DP) must now produce a different result than flat %."""
    flat = _broad_kpis(broad_client, cost_model="flat", cost_pct=0.10)
    itemised = _broad_kpis(
        broad_client, cost_model="itemised", capital=1_000_000.0, slippage_bps=5.0
    )
    assert flat["final_value"] != itemised["final_value"]


def test_broad_backtest_accepts_momentum_sizing(broad_client):
    """Round-trips momentum_sizing (buffer rule win-rate position sizing) through to a real
    broad backtest without erroring, both on and off - mirrors
    test_custom_index_backtest_accepts_momentum_sizing for this dataset. Doesn't assert the
    result differs (like that test, it doesn't either): the multiplier only bites once a real
    losing streak has closed, which this fixture's short window doesn't guarantee - the
    wiring itself (Config.momentum_sizing reaching run_backtest for this dataset, which it
    could not before this fix) is what this proves."""
    off = _broad_kpis(broad_client, momentum_sizing=False)
    on = _broad_kpis(
        broad_client, momentum_sizing=True, momentum_sizing_window=5, momentum_sizing_floor=0.2
    )
    assert off["final_value"] > 0 and on["final_value"] > 0


def test_broad_backtest_momentum_sizing_config_reaches_the_engine(broad_client):
    """Deterministic companion to the round-trip test above: proves `Config.momentum_sizing`
    (and its window/floor) actually reach `engine.run_backtest`'s `Config` for this dataset,
    independent of whether this fixture's short window happens to produce a losing streak."""
    from momentum_backtesting.categories import broad as broad_module

    outcome = broad_module.run_broad_backtest(
        outer_prices=api.DATA.get(),
        stocks_data_dir=api.DATA_DIR / "stocks",
        categories_data_dir=api.DATA_DIR / "categories",
        curated_dir=api.CATEGORIES_CURATED_DIR,
        start="2017-01-01",
        pool_top_n=10,
        pool_exit_rank=10,
        coverage_floor=0.0,
        momentum_sizing=True,
        momentum_sizing_window=7,
        momentum_sizing_floor=0.15,
    )
    assert outcome.result.config.momentum_sizing is True
    assert outcome.result.config.momentum_sizing_window == 7
    assert outcome.result.config.momentum_sizing_floor == 0.15


def test_broad_backtest_custom_weights_change_the_ranking(broad_client):
    """`weights` (one per lookback) feeds Step 1's ranksum score (broad.compute_universe_ranking)
    - was never threaded through at all before this fix, so the per-lookback weight table the
    sidebar already showed for this tab (score="ranksum" is its own default) had no effect."""
    equal = _broad_kpis(broad_client, lookbacks=[1, 4, 13, 26, 52], weights=[1, 1, 1, 1, 1])
    skewed = _broad_kpis(broad_client, lookbacks=[1, 4, 13, 26, 52], weights=[10, 1, 1, 1, 1])
    assert equal["final_value"] != skewed["final_value"]


def test_broad_backtest_mismatched_weights_is_a_clear_422(broad_client):
    res = broad_client.post(
        "/api/backtest",
        json=_broad_request(lookbacks=[1, 4, 13], weights=[1, 1]),
    )
    assert res.status_code == 422


# ---------------------------------------------------------------------------------------------
# Concentration caps + share-price ceiling for dataset="broad": max_position (per stock, already
# existed), max_category (everything held through one category), max_stock_price (skip stocks
# whose share price is above a rupee ceiling).
# ---------------------------------------------------------------------------------------------


def _run_broad(**overrides):
    from momentum_backtesting.categories import broad as broad_module

    kwargs = dict(
        outer_prices=api.DATA.get(),
        stocks_data_dir=api.DATA_DIR / "stocks",
        categories_data_dir=api.DATA_DIR / "categories",
        curated_dir=api.CATEGORIES_CURATED_DIR,
        start="2017-01-01",
        pool_top_n=10,
        pool_exit_rank=10,
        coverage_floor=0.0,
        category_top_n=2,
        category_exit_rank=2,
        picks_per_category=2,
    )
    kwargs.update(overrides)
    return broad_module.run_broad_backtest(**kwargs)


def _traded_stocks(outcome) -> set[str]:
    from momentum_backtesting.categories import broad as broad_module

    trades = outcome.result.trades
    return {a for a in trades["asset"] if a not in broad_module.ATOMIC_NAMES and a != api.CASH}


def _scale_stock_price(tmp_path, symbol: str, factor: float) -> None:
    path = tmp_path / "stocks" / "daily.parquet"
    daily = pd.read_parquet(path)
    daily.loc[daily["symbol"] == symbol, "close"] *= factor
    daily.to_parquet(path)


def test_broad_meta_defaults_carry_the_caps_and_price_ceiling(broad_client):
    defaults = broad_client.get("/api/meta?dataset=broad").json()["defaults"]
    # Tight enough to bind, loose enough to stay fully invested with the default 4 fresh
    # categories x 2 stocks (see broad.DEFAULT_MAX_*).
    top = defaults["broad_category_top_n"]
    picks = defaults["broad_picks_per_category"]
    assert defaults["max_position"] * top * picks >= 1
    assert defaults["max_category"] * top >= 1
    assert defaults["max_position"] < defaults["max_category"] < 1
    assert defaults["max_stock_price"] == 20_000


def test_broad_backtest_category_cap_holds_each_categorys_share_under_the_cap(broad_client):
    cap, band = 0.35, 0.05
    outcome = _run_broad(max_position=None, max_category=cap, cap_band=band)
    groups = outcome.effective.groups.reindex(outcome.result.weights.index)
    weights = outcome.result.weights.drop(columns=["Idle cash"], errors="ignore")
    assert len(outcome.result.trades)
    for week, row in weights.iterrows():
        shares: dict[str, float] = {}
        for stock, share in row[row > 1e-9].items():
            label = groups.at[week, stock] if stock in groups.columns else None
            if isinstance(label, str):
                shares[label] = shares.get(label, 0.0) + share
        assert all(s <= cap + band + 1e-9 for s in shares.values()), (week, shares)


def test_broad_backtest_category_cap_changes_the_result_and_is_recorded(broad_client):
    free = _run_broad(max_position=None, max_category=None)
    capped = _run_broad(max_position=None, max_category=0.3)
    assert capped.result.config.max_group == 0.3
    assert free.result.config.max_group is None
    assert free.result.equity.iloc[-1] != capped.result.equity.iloc[-1]


def test_broad_backtest_category_cap_needs_category_mode_on(broad_client):
    with pytest.raises(ValueError, match="max_category"):
        _run_broad(category_mode="off", max_category=0.3)
    # ...but the API just ignores it in OFF mode rather than failing a request the UI can send.
    res = broad_client.post(
        "/api/backtest",
        json=_broad_request(
            broad_category_mode="off",
            broad_off_top_n=3,
            broad_off_exit_rank=6,
            broad_pool_top_n=10,
            broad_pool_exit_rank=10,
            max_category=0.3,
        ),
    )
    assert res.status_code == 200, res.text


def test_broad_backtest_price_ceiling_skips_an_unaffordable_stock_in_off_mode(
    broad_client, tmp_path
):
    kw = dict(category_mode="off", off_top_n=3, off_exit_rank=6)
    control = _run_broad(**kw)
    stocks = _traded_stocks(control)
    assert stocks
    victim = sorted(stocks)[0]

    _scale_stock_price(tmp_path, victim, 1000.0)  # e.g. a Rs 1 lakh share
    api.DATA.broad_ranking_cache.clear()
    still_free = _run_broad(**kw)
    assert victim in _traded_stocks(still_free)  # sanity: scaling alone doesn't change momentum

    ceiling = _run_broad(**kw, max_stock_price=20_000)
    assert victim not in _traded_stocks(ceiling)
    assert len(ceiling.result.trades)  # the next-best names filled in; it isn't just empty


def test_broad_backtest_price_ceiling_never_buys_an_unaffordable_category_pick(
    broad_client, tmp_path
):
    control = _run_broad()
    picks_before = {p for row in _held(control) for p in row["picks"]}
    victim = sorted(p for p in picks_before if p.startswith("B"))[0]

    _scale_stock_price(tmp_path, victim, 1000.0)
    api.DATA.broad_ranking_cache.clear()
    ceiling = _run_broad(max_stock_price=20_000)
    assert victim not in _traded_stocks(ceiling)
    assert _traded_stocks(ceiling)  # the next-best stocks filled in


def _held(outcome) -> list[dict]:
    from momentum_backtesting.categories import broad as broad_module

    return broad_module.current_holdings_detail(
        outcome,
        broad_module.load_stock_groups(api.CATEGORIES_CURATED_DIR),
        category_top_n=2,
        picks_per_category=2,
    )


def test_broad_backtest_price_ceiling_zero_or_absent_is_off(broad_client, tmp_path):
    _scale_stock_price(tmp_path, "BA1", 1000.0)
    api.DATA.broad_ranking_cache.clear()
    none = _run_broad(max_stock_price=None)
    zero = _run_broad(max_stock_price=0.0)
    pd.testing.assert_series_equal(none.result.equity, zero.result.equity)


def test_broad_api_round_trips_caps_and_ceiling(broad_client):
    res = broad_client.post(
        "/api/backtest",
        json=_broad_request(
            broad_coverage_floor=0.0,
            broad_pool_top_n=10,
            broad_pool_exit_rank=10,
            max_position=0.2,
            max_category=0.4,
            max_stock_price=20000,
        ),
    )
    assert res.status_code == 200, res.text
    json.dumps(res.json(), allow_nan=False)
    assert (
        broad_client.post("/api/backtest", json=_broad_request(max_category=1.5)).status_code == 422
    )
    assert (
        broad_client.post("/api/backtest", json=_broad_request(max_stock_price=-1)).status_code
        == 422
    )


def test_broad_payload_carries_share_prices_for_the_trade_split_tab(broad_client):
    res = broad_client.post(
        "/api/backtest",
        json=_broad_request(broad_coverage_floor=0.0, broad_pool_top_n=10, broad_pool_exit_rank=10),
    )
    assert res.status_code == 200, res.text
    open_positions = res.json()["open_positions"]
    assert open_positions
    assert all(p["price"] is not None and p["price"] > 0 for p in open_positions)


def test_broad_every_week_never_skips_a_week(broad_client):
    """TODO 3.9.23/3.11.17: with broad_every_week the curve has one point per week.
    `broad_every_week=False` keeps the engine's original rule (thin weeks skipped), so it can
    only have as many or fewer weeks — but it is no longer the default: skipping thin weeks
    overstates CAGR/Sharpe, and (TODO 3.11.17) it also hid fresh data behind what looked like
    a stale backtest, since the thin trailing weeks right after an ingest gap are exactly the
    ones it drops."""
    request = _broad_request(broad_coverage_floor=0.0, broad_pool_top_n=10, broad_pool_exit_rank=10)
    skip_thin = broad_client.post(
        "/api/backtest", json={**request, "broad_every_week": False}
    ).json()
    every = broad_client.post("/api/backtest", json={**request, "broad_every_week": True}).json()
    weeks = pd.to_datetime(every["series"]["dates"])
    assert (weeks[1:] - weeks[:-1]).days.max() == 7
    assert len(every["series"]["dates"]) >= len(skip_thin["series"]["dates"])

    default = broad_client.post("/api/backtest", json=request).json()
    assert default["series"]["dates"] == every["series"]["dates"]
    meta = broad_client.get("/api/meta?dataset=broad").json()
    assert meta["defaults"]["broad_every_week"] is True


def test_broad_sell_every_week_is_accepted_and_rejected_without_the_buffer_rule(broad_client):
    request = _broad_request(
        broad_coverage_floor=0.0,
        broad_pool_top_n=10,
        broad_pool_exit_rank=10,
        rebalance_every=2,
        sell_every_week=True,
    )
    res = broad_client.post("/api/backtest", json=request)
    assert res.status_code == 200, res.text
    bad = broad_client.post("/api/backtest", json={**request, "portfolio": "slots"})
    assert bad.status_code == 422
    meta = broad_client.get("/api/meta?dataset=broad").json()
    assert meta["defaults"]["sell_every_week"] is False


def test_broad_reversal_tilt_changes_the_result_and_avoids_fresh_lows(broad_client):
    """TODO 3.9.23 owner follow-up: broad_reversal_tilt re-orders whatever stocks the category/
    pool funnel already selected - it must change the P&L, and it must never freshly buy a stock
    making a new 52-week low (same falling-knife guard as the ETF lever)."""
    from momentum_backtesting import levers

    request = _broad_request(broad_coverage_floor=0.0, broad_pool_top_n=10, broad_pool_exit_rank=10)
    plain = broad_client.post("/api/backtest", json=request).json()
    tilted = broad_client.post("/api/backtest", json={**request, "broad_reversal_tilt": 0.5}).json()
    assert tilted["kpis"] != plain["kpis"]

    off_request = _broad_request(
        broad_category_mode="off", broad_off_top_n=5, broad_off_exit_rank=10
    )
    off_plain = broad_client.post("/api/backtest", json=off_request).json()
    off_tilted = broad_client.post(
        "/api/backtest", json={**off_request, "broad_reversal_tilt": 0.5}
    ).json()
    assert off_tilted["kpis"] != off_plain["kpis"]

    meta = broad_client.get("/api/meta?dataset=broad").json()
    assert meta["defaults"]["broad_reversal_tilt"] == 0.0
    assert meta["defaults"]["broad_reversal_screen_pct"] == 0.0

    # Reconstruct the same price frame the fixture built, to check the falling-knife guard.
    from momentum_backtesting import api

    ranking = api.DATA.get_broad_ranking(
        lookbacks=(1, 4, 13, 26, 52),
        weights=None,
        score="ranksum",
        voladj_skip_recent_month=True,
        pool_top_n=10,
        pool_exit_rank=10,
    )
    low = levers.fresh_52w_low_mask(ranking.prices)
    # The no_buy gate only blocks a NEW entry - like every other such gate in this codebase
    # (exclude_high_vol, max_stock_price), a name already held may still be topped up (`ADD`)
    # even while sitting at a fresh low, by design.
    violations = []
    for label, payload in (("on", tilted), ("off", off_tilted)):
        for rotation in payload["rotations"]:
            week = pd.Timestamp(rotation["week"])
            for row in rotation["ins"]:
                if row["top_up"]:
                    continue
                asset = row["asset"]
                if asset in low.columns and week in low.index and bool(low.at[week, asset]):
                    violations.append((label, week, asset))
    assert not violations, violations[:5]


def test_meta_with_an_empty_catalog_and_no_csv_is_a_clear_409_not_a_500(tmp_path, monkeypatch):
    """The dashboard's first call (saved-runs) creates an EMPTY catalog.duckdb. `_Data.get()` saw
    a catalog, tried it (nothing in it), fell through to `pd.read_csv` on a file that does not
    exist, and the FileNotFoundError came back as HTTP 500. It should say what to run.
    (Deliberately not the `client` fixture: that one writes a weekly_closes.csv.)"""
    from trading_data.db import connect

    with connect():
        pass  # creates the empty catalog under the conftest-isolated TRADING_DATA_ROOT
    monkeypatch.setattr(api, "DATA_DIR", tmp_path)  # an empty folder: no weekly_closes.csv
    monkeypatch.setattr(api, "DATA", api._Data())

    res = TestClient(api.create_app()).get("/api/meta")

    assert res.status_code == 409, res.text
    assert "mbt" in res.json()["detail"]


def test_fresh_run_drops_every_server_cache_and_a_normal_run_keeps_them(client):
    """The dashboard's "re-run from scratch" icon sends `fresh: true`. The server caches rankings,
    trade-price tables and the loaded datasets (keyed on the settings, so a normal run is correct
    AND fast); `fresh` must drop all of it and recompute - and a normal run must not."""
    universe = core(client)
    body = {"universe": universe, "start": "2017-01-06"}
    assert client.post("/api/backtest", json=body).status_code == 200
    assert len(api.DATA.rank_cache) == 1  # the ranking was cached

    # Plant sentinels in every cache `_Data` owns - none may survive a fresh run
    api.DATA.rank_cache["sentinel"] = "x"
    api.DATA.stock_rank_cache["sentinel"] = "x"
    api.DATA.custom_index_cache["sentinel"] = "x"
    api.DATA.custom_index_rank_cache["sentinel"] = "x"
    api.DATA.broad_ranking_cache["sentinel"] = "x"
    api.DATA.broad_tilt_cache["sentinel"] = "x"
    api.DATA.fill_tables["sentinel"] = "x"
    unbuilt = RunParts({}, {"trades": lambda: []}, "t")  # a cached run with a section not built
    api.DATA.result_cache["sentinel"] = unbuilt
    sentinel_refs = pd.DataFrame()  # a real frame: a normal run reads it (`.empty`)
    api.DATA.references_cache = sentinel_refs

    assert client.post("/api/backtest", json=body).status_code == 200  # a normal run: kept
    assert "sentinel" in api.DATA.rank_cache and api.DATA.references_cache is sentinel_refs

    res = client.post("/api/backtest", json={**body, "fresh": True})
    assert res.status_code == 200, res.text
    for cache in (
        api.DATA.stock_rank_cache,
        api.DATA.custom_index_cache,
        api.DATA.custom_index_rank_cache,
        api.DATA.broad_ranking_cache,
        api.DATA.broad_tilt_cache,
        api.DATA.fill_tables,
        api.DATA.result_cache,
    ):
        assert "sentinel" not in cache
    assert "sentinel" not in api.DATA.rank_cache
    assert not unbuilt.complete  # a run dropped from the cache lets go of what it held
    assert len(api.DATA.rank_cache) == 1  # ...and the ranking was recomputed and cached again
    assert api.DATA.references_cache is not sentinel_refs  # reloaded


def test_fresh_run_gives_the_same_numbers_as_a_cached_one(client):
    """ "From scratch" must change how the answer is computed, never what it is."""
    body = {"universe": core(client), "start": "2017-01-06", "top_n": 4}
    cached = client.post("/api/backtest", json=body).json()["kpis"]
    fresh = client.post("/api/backtest", json={**body, "fresh": True}).json()["kpis"]
    assert fresh == cached


def test_get_momentum_universe_invalidates_when_only_the_catalog_changes(monkeypatch):
    """Bug fix (TODO.md 3.11.16): a write that only touches the shared catalog/lake (e.g.
    the Fyers Total Market top-up, which never touches daily.parquet or the membership
    CSV) must still invalidate this cache — it used to only watch those two files and
    silently kept serving pre-top-up data forever in a long-running process."""
    from momentum_backtesting import db_read

    data = api._Data()
    calls = []

    def fake_load(**kwargs):  # noqa: ARG001
        calls.append(1)
        return object()

    monkeypatch.setattr(api.broad, "load_stock_universe_frame", fake_load)
    monkeypatch.setattr(db_read, "data_version", lambda root=None: ("v1",))

    first = data.get_momentum_universe()
    assert len(calls) == 1

    # The watched files are unchanged; only the shared database's data changed (a write
    # elsewhere, e.g. the Fyers top-up) — this must still trigger a rebuild.
    monkeypatch.setattr(db_read, "data_version", lambda root=None: ("v2",))
    second = data.get_momentum_universe()

    assert len(calls) == 2
    assert first is not second


def _wait_for(job_id, client, *statuses, timeout=10.0):
    import time

    deadline = time.time() + timeout
    while time.time() < deadline:
        job = client.get(f"/api/backtest/jobs/{job_id}").json()["job"]
        if job["status"] in statuses:
            return job
        time.sleep(0.02)
    raise AssertionError(f"job {job_id} never reached {statuses}: {job['status']}")


def test_backtest_job_runs_in_the_background_and_matches_the_sync_result(client):
    body = {"universe": core(client), "start": "2017-01-06"}
    started = client.post("/api/backtest/jobs", json=body)
    assert started.status_code == 202
    job = started.json()["job"]
    assert "result" not in job  # the start response never carries the (large) result
    done = _wait_for(job["id"], client, "done", "failed")
    assert done["status"] == "done", done["error"]
    assert done["result"]["kpis"] == client.post("/api/backtest", json=body).json()["kpis"]
    assert job["id"] in [j["id"] for j in client.get("/api/backtest/jobs").json()["jobs"]]
    assert all("result" not in j for j in client.get("/api/backtest/jobs").json()["jobs"])


def test_backtest_job_failure_lands_in_the_job_not_the_http_response(client):
    # Passes request validation (so 202) but the computation rejects it.
    res = client.post("/api/backtest/jobs", json={"universe": core(client)[:2], "top_n": 5})
    assert res.status_code == 202
    job = _wait_for(res.json()["job"]["id"], client, "done", "failed")
    assert job["status"] == "failed" and job["error"]


def test_backtest_job_unknown_id_is_a_404(client):
    assert client.get("/api/backtest/jobs/deadbeef").status_code == 404


def test_backtest_jobs_run_concurrently_up_to_the_cap_and_queue_the_rest():
    import threading

    jobs = api._BacktestJobs()
    jobs.MAX_CONCURRENT = 2
    gate = threading.Event()
    running = []

    def work():
        running.append(1)
        gate.wait(5)
        return {"ok": True}

    ids = [jobs.start(work, False, {})["id"] for _ in range(3)]
    import time

    time.sleep(0.2)
    statuses = [jobs.get(i)["status"] for i in ids]
    assert sorted(statuses) == ["queued", "running", "running"]
    gate.set()
    for i in ids:
        for _ in range(100):
            if jobs.get(i)["status"] == "done":
                break
            time.sleep(0.02)
        assert jobs.get(i)["status"] == "done"


def test_fresh_backtest_job_runs_alone():
    import threading
    import time

    jobs = api._BacktestJobs()
    release = threading.Event()
    log = []

    def slow():
        log.append("slow-start")
        release.wait(5)
        log.append("slow-end")
        return {}

    def fresh():
        log.append("fresh")
        return {}

    first = jobs.start(slow, False, {})["id"]
    time.sleep(0.1)
    fresh_id = jobs.start(fresh, True, {})["id"]
    time.sleep(0.2)
    assert jobs.get(fresh_id)["status"] == "queued"  # waits for the running job
    release.set()
    for _ in range(100):
        if jobs.get(fresh_id)["status"] == "done":
            break
        time.sleep(0.02)
    assert log == ["slow-start", "slow-end", "fresh"]
    assert jobs.get(first)["status"] == "done"


# --- Whole-result cache and compression (BL-005) -----------------------------------------------


def _without_cache(payload: dict) -> dict:
    return {k: v for k, v in payload.items() if k != "cache"}


def _counting_engine(monkeypatch) -> list:
    calls: list = []
    real = api.run_backtest

    def counting(*args, **kwargs):
        calls.append(1)
        return real(*args, **kwargs)

    monkeypatch.setattr(api, "run_backtest", counting)
    return calls


def test_an_identical_request_is_served_from_the_result_cache(client, monkeypatch):
    calls = _counting_engine(monkeypatch)
    body = {"universe": core(client), "start": "2017-01-06", "top_n": 4}
    first = client.post("/api/backtest", json=body).json()
    ran = len(calls)
    assert ran >= 1 and first["cache"]["hit"] is False

    # The same settings in another order are the same request.
    second = client.post("/api/backtest", json=dict(reversed(list(body.items())))).json()
    assert len(calls) == ran  # nothing recomputed
    assert second["cache"] == {"hit": True, "computed_at": first["cache"]["computed_at"]}
    assert _without_cache(second) == _without_cache(first)


def test_a_changed_setting_or_a_fresh_run_is_computed_again(client, monkeypatch):
    calls = _counting_engine(monkeypatch)
    body = {"universe": core(client), "start": "2017-01-06", "top_n": 4}
    client.post("/api/backtest", json=body)
    ran = len(calls)
    other = client.post("/api/backtest", json={**body, "top_n": 3}).json()
    assert other["cache"]["hit"] is False and len(calls) > ran
    ran = len(calls)
    fresh = client.post("/api/backtest", json={**body, "fresh": True}).json()
    assert fresh["cache"]["hit"] is False and len(calls) > ran


def test_a_changed_input_file_is_computed_again(client):
    body = {"universe": core(client), "start": "2017-01-06", "top_n": 4}
    client.post("/api/backtest", json=body)
    path = api.DATA_DIR / "weekly_closes.csv"
    stat = path.stat()
    os.utime(path, ns=(stat.st_atime_ns, stat.st_mtime_ns + 60_000_000_000))
    assert client.post("/api/backtest", json=body).json()["cache"]["hit"] is False


def test_saving_a_run_keeps_every_cache_for_the_next_run(client, monkeypatch):
    """The bug BL-005 found: the dashboard saves each finished run into the catalog, and every
    cache used to be keyed on the catalog file's mtime, so the next run started cold."""
    from trading_data.db import catalog_path

    calls = _counting_engine(monkeypatch)
    body = {"universe": core(client), "start": "2017-01-06", "top_n": 4}
    saved = {
        "dataset": "etf",
        "name": "Run",
        "config": body,
        "kpis": {},
        "dates": [],
        "strategy": [],
    }
    assert client.post("/api/saved-runs", json=saved).status_code == 200  # creates the catalog
    client.post("/api/backtest", json=body)
    prices = api.DATA.prices
    ran = len(calls)

    assert client.post("/api/saved-runs", json=saved).status_code == 200
    catalog = catalog_path()
    stat = catalog.stat()
    os.utime(catalog, ns=(stat.st_atime_ns, stat.st_mtime_ns + 60_000_000_000))

    again = client.post("/api/backtest", json=body).json()
    assert again["cache"]["hit"] is True and len(calls) == ran
    assert client.post("/api/backtest", json={**body, "top_n": 3}).status_code == 200
    assert api.DATA.prices is prices  # the loaded prices survived the save as well


def test_responses_are_gzipped_when_the_client_accepts_it(client):
    body = {"universe": core(client), "start": "2017-01-06", "top_n": 4}
    res = client.post("/api/backtest", json=body, headers={"Accept-Encoding": "gzip"})
    assert res.status_code == 200
    assert res.headers["content-encoding"] == "gzip"
    assert res.json()["kpis"]  # the client decompresses transparently


@pytest.mark.parametrize("folder", ["daily", "daily_etf", "categories", "stocks"])
def test_a_new_file_in_any_input_folder_is_computed_again(client, folder):
    body = {"universe": core(client), "start": "2017-01-06", "top_n": 4}
    assert client.post("/api/backtest", json=body).json()["cache"]["hit"] is False
    assert client.post("/api/backtest", json=body).json()["cache"]["hit"] is True
    (api.DATA_DIR / folder).mkdir(exist_ok=True)
    (api.DATA_DIR / folder / "refreshed.csv").write_text("x")
    assert client.post("/api/backtest", json=body).json()["cache"]["hit"] is False


@pytest.mark.parametrize("constant", ["CATEGORIES_CURATED_DIR", "STOCKS_CURATED_DIR"])
def test_an_edit_in_a_curated_folder_is_computed_again(client, tmp_path, monkeypatch, constant):
    curated = tmp_path / "curated"
    curated.mkdir()
    (curated / "tags.csv").write_text("a")
    monkeypatch.setattr(api, constant, curated)
    body = {"universe": core(client), "start": "2017-01-06", "top_n": 4}
    client.post("/api/backtest", json=body)
    assert client.post("/api/backtest", json=body).json()["cache"]["hit"] is True
    (curated / "tags.csv").write_text("a, edited")
    assert client.post("/api/backtest", json=body).json()["cache"]["hit"] is False


def test_the_result_cache_keeps_only_the_most_recent_results(client, monkeypatch):
    monkeypatch.setattr(api.DATA, "RESULT_CACHE_SIZE", 2)
    body = {"universe": core(client), "start": "2017-01-06"}

    def run(top_n: int) -> bool:
        return client.post("/api/backtest", json={**body, "top_n": top_n}).json()["cache"]["hit"]

    assert [run(2), run(3), run(4)] == [False, False, False]
    assert len(api.DATA.result_cache) == 2
    assert run(4) is True  # the newest are kept
    assert run(2) is False  # the oldest was evicted


# --- Sections fetched on their own (BL-005 Phase 2) ---------------------------------------------

LAZY = ("trades", "instruments", "timeline", "latest")


def _job(client, body, **extra):
    started = client.post("/api/backtest/jobs", json={**body, **extra})
    assert started.status_code == 202, started.text
    job = _wait_for(started.json()["job"]["id"], client, "done", "failed", timeout=60)
    assert job["status"] == "done", job
    return job


def _as_json(value) -> str:
    return json.dumps(value, sort_keys=True)


def test_a_job_result_leaves_the_heavy_sections_out_and_names_them(client):
    body = {"universe": core(client), "start": "2017-01-06", "top_n": 4}
    result = _job(client, body)["result"]
    assert result["kpis"] and result["series"] and result["rotations"] is not None
    assert not set(LAZY) & set(result)
    assert result["sections_available"] == list(LAZY)


def test_each_section_equals_the_synchronous_result_built_separately(client):
    body = {"universe": core(client), "start": "2017-01-06", "top_n": 4}
    job = _job(client, body, fresh=True)
    sections = {}
    for name in LAZY:
        res = client.get(f"/api/backtest/jobs/{job['id']}/sections/{name}")
        assert res.status_code == 200, res.text
        assert res.json()["section"] == name
        sections[name] = res.json()["data"]
    # `fresh` drops every cache (and releases unbuilt sections), so this builds the whole result
    # again, independently of the job's.
    whole = client.post("/api/backtest", json={**body, "fresh": True}).json()
    drop = ("cache", "sections_available")
    assert {k: v for k, v in job["result"].items() if k not in drop} == {
        k: v for k, v in whole.items() if k not in ("cache", *LAZY)
    }
    for name in LAZY:
        assert _as_json(sections[name]) == _as_json(whole[name]), name


def test_a_section_is_built_when_first_asked_for_and_only_once(client, monkeypatch):
    from momentum_backtesting import analysis

    calls = []
    real = analysis.instrument_table
    monkeypatch.setattr(
        analysis, "instrument_table", lambda *a, **k: calls.append(1) or real(*a, **k)
    )
    job = _job(client, {"universe": core(client), "start": "2017-01-06", "top_n": 4})
    assert calls == []  # the run finished without building it
    for _ in range(2):
        res = client.get(f"/api/backtest/jobs/{job['id']}/sections/instruments")
        assert res.status_code == 200
    assert calls == [1]


def test_a_cached_run_keeps_the_sections_it_already_built(client, monkeypatch):
    from momentum_backtesting import analysis

    calls = []
    real = analysis.timeline
    monkeypatch.setattr(analysis, "timeline", lambda *a, **k: calls.append(1) or real(*a, **k))
    body = {"universe": core(client), "start": "2017-01-06", "top_n": 4}
    first = _job(client, body)
    client.get(f"/api/backtest/jobs/{first['id']}/sections/timeline")
    second = _job(client, body)  # identical request: served from the result cache
    assert second["result"]["cache"]["hit"] is True
    client.get(f"/api/backtest/jobs/{second['id']}/sections/timeline")
    assert calls == [1]


def test_the_synchronous_result_still_has_every_section(client):
    body = {"universe": core(client), "start": "2017-01-06", "top_n": 4}
    whole = client.post("/api/backtest", json=body).json()
    assert set(LAZY) <= set(whole) and "sections_available" not in whole


def test_asking_for_a_section_that_cannot_be_served_says_why(client, monkeypatch):
    import threading

    body = {"universe": core(client), "start": "2017-01-06", "top_n": 4}
    job = _job(client, body)
    assert client.get("/api/backtest/jobs/deadbeef/sections/trades").status_code == 404
    assert client.get(f"/api/backtest/jobs/{job['id']}/sections/nonsense").status_code == 422
    # circuit_exposure exists only for Broad Momentum runs
    res = client.get(f"/api/backtest/jobs/{job['id']}/sections/circuit_exposure")
    assert res.status_code == 404

    jobs = api._BacktestJobs()
    monkeypatch.setattr(api, "BACKTEST_JOBS", jobs)
    release = threading.Event()
    running = jobs.start(lambda: release.wait(5) and {"kpis": {}}, False, {})["id"]
    assert client.get(f"/api/backtest/jobs/{running}/sections/trades").status_code == 409
    release.set()
    _wait_for(running, client, "done")
    # a job whose work produced no sections (or whose sections were released)
    assert client.get(f"/api/backtest/jobs/{running}/sections/trades").status_code == 410


def test_only_the_newest_finished_jobs_keep_their_sections(client, monkeypatch):
    jobs = api._BacktestJobs()
    jobs.MAX_PARTS = 1
    monkeypatch.setattr(api, "BACKTEST_JOBS", jobs)
    body = {"universe": core(client), "start": "2017-01-06"}
    older = _job(client, {**body, "top_n": 3})
    newer = _job(client, {**body, "top_n": 4})
    assert client.get(f"/api/backtest/jobs/{older['id']}/sections/trades").status_code == 410
    assert client.get(f"/api/backtest/jobs/{newer['id']}/sections/trades").status_code == 200
    assert older["result"]["kpis"]  # the core result of the older job is still there


def test_older_cached_runs_let_go_of_sections_they_have_not_built(client, monkeypatch):
    """Unbuilt sections hold a run's frames (for Broad, its whole ranking): only the newest few
    runs may keep them, or memory grows with every different setting tried."""
    monkeypatch.setattr(api.DATA, "LIVE_RESULTS", 1)
    body = {"universe": core(client), "start": "2017-01-06"}
    first = _job(client, {**body, "top_n": 2})
    second = _job(client, {**body, "top_n": 3})
    third = _job(client, {**body, "top_n": 4})

    def served(job):
        return client.get(f"/api/backtest/jobs/{job['id']}/sections/trades").status_code

    assert [served(first), served(second), served(third)] == [410, 410, 200]
    # an older run that can no longer build its sections is no use as a cache hit
    assert _job(client, {**body, "top_n": 2})["result"]["cache"]["hit"] is False


def test_an_older_run_whose_sections_are_all_built_stays_cached(client, monkeypatch):
    monkeypatch.setattr(api.DATA, "LIVE_RESULTS", 1)
    body = {"universe": core(client), "start": "2017-01-06"}
    assert client.post("/api/backtest", json={**body, "top_n": 2}).json()["cache"]["hit"] is False
    _job(client, {**body, "top_n": 3})
    _job(client, {**body, "top_n": 4})
    assert client.post("/api/backtest", json={**body, "top_n": 2}).json()["cache"]["hit"] is True


def test_a_fresh_run_releases_every_unbuilt_section(client):
    body = {"universe": core(client), "start": "2017-01-06", "top_n": 4}
    job = _job(client, body)
    _job(client, body, fresh=True)
    res = client.get(f"/api/backtest/jobs/{job['id']}/sections/trades")
    assert res.status_code == 410


def test_the_newest_finished_job_keeps_its_sections_even_if_it_started_first():
    """Ordered by when a job finished, not started: a slow run that ends last is the newest."""
    import threading

    from momentum_backtesting.run_parts import RunParts

    jobs = api._BacktestJobs()
    jobs.MAX_PARTS = 1
    gate = threading.Event()

    def parts():
        return RunParts({"kpis": {}}, {"trades": lambda: []}, "t")

    def slow():
        gate.wait(5)
        return {"kpis": {}}, parts()

    slow_id = jobs.start(slow, False, {})["id"]
    quick_id = jobs.start(lambda: ({"kpis": {}}, parts()), False, {})["id"]
    import time

    for _ in range(100):
        if jobs.get(quick_id)["status"] == "done":
            break
        time.sleep(0.02)
    gate.set()
    for _ in range(100):
        if jobs.get(slow_id)["status"] == "done":
            break
        time.sleep(0.02)
    assert jobs.parts_for(slow_id)[0] == "ok"  # started first, finished last: the newest
    assert jobs.parts_for(quick_id)[0] == "gone"


def test_a_failed_job_says_it_failed(client, monkeypatch):
    jobs = api._BacktestJobs()
    monkeypatch.setattr(api, "BACKTEST_JOBS", jobs)

    def boom():
        raise RuntimeError("nope")

    job_id = jobs.start(boom, False, {})["id"]
    _wait_for(job_id, client, "failed")
    res = client.get(f"/api/backtest/jobs/{job_id}/sections/trades")
    assert res.status_code == 409 and "failed" in res.json()["detail"]


def test_a_running_job_says_which_step_it_has_reached():
    import threading
    import time

    jobs = api._BacktestJobs()
    reached, release = threading.Event(), threading.Event()

    def work(report):
        report("loading")
        report("ranking")
        reached.set()
        release.wait(5)
        return {"kpis": {}}

    job_id = jobs.start(work, False, {})["id"]
    assert reached.wait(5)
    assert jobs.get(job_id)["stage"] == "ranking"
    assert jobs.list()[0]["stage"] == "ranking"  # the job list shows it too
    release.set()
    for _ in range(100):
        if jobs.get(job_id)["status"] == "done":
            break
        time.sleep(0.02)
    assert jobs.get(job_id)["stage"] is None  # nothing left to report once it is done


def test_a_job_carries_the_ordered_steps_and_how_long_it_took_in_milliseconds():
    import time

    jobs = api._BacktestJobs()

    def work(report):
        report("loading")
        time.sleep(0.05)
        return {"kpis": {}}

    job_id = jobs.start(work, False, {})["id"]
    assert jobs.get(job_id)["stages"] == list(api.JOB_STAGES)
    assert jobs.get(job_id)["compute_ms"] is None  # not known until it ends
    for _ in range(100):
        if jobs.get(job_id)["status"] == "done":
            break
        time.sleep(0.02)
    assert 40 <= jobs.get(job_id)["compute_ms"] < 5000  # milliseconds, not whole seconds


def test_the_runner_only_hands_a_reporter_to_work_that_asks_for_one():
    import time

    jobs = api._BacktestJobs()
    seen = {}

    def optional_argument(retries=3):
        seen["retries"] = retries
        return {"kpis": {}}

    ids = [
        jobs.start(optional_argument, False, {})["id"],  # an optional parameter is not a reporter
        jobs.start(dict, False, {})["id"],  # a callable whose signature cannot be read
    ]
    for job_id in ids:
        for _ in range(100):
            if jobs.get(job_id)["status"] in ("done", "failed"):
                break
            time.sleep(0.02)
        assert jobs.get(job_id)["status"] == "done", jobs.get(job_id)["error"]
    assert seen["retries"] == 3


def test_a_job_that_fails_ends_with_no_stage():
    jobs = api._BacktestJobs()

    def work(report):
        report("simulating")
        raise RuntimeError("boom")

    job_id = jobs.start(work, False, {})["id"]
    import time

    for _ in range(100):
        if jobs.get(job_id)["status"] == "failed":
            break
        time.sleep(0.02)
    assert jobs.get(job_id)["stage"] is None and "boom" in jobs.get(job_id)["error"]


def test_the_etf_builder_reports_its_steps_in_order(client):
    seen: list[str] = []
    req = api.BacktestRequest(universe=core(client), start="2017-01-06", top_n=4)
    api._etf_parts(req, seen.append)
    assert seen == ["loading", "simulating", "analysing"]
    assert seen == [step for step in api.JOB_STAGES if step in seen]  # known steps, in job order
    seen.clear()  # the synchronous callers say nothing, and still work
    api._etf_parts(req)
    assert seen == []


def test_the_broad_builder_reports_its_steps_in_order(broad_client):
    seen: list[str] = []
    broad = api.BacktestRequest(
        **_broad_request(broad_coverage_floor=0.0, broad_pool_top_n=10, broad_pool_exit_rank=10)
    )
    api._broad_parts(broad, seen.append)
    assert seen == ["loading", "ranking", "simulating", "analysing"] == list(api.JOB_STAGES)


def test_the_job_route_runs_the_builders_with_a_reporter(client, monkeypatch):
    stages: list[str] = []
    real = api._etf_parts

    def recording(req, report=api._no_report):
        def both(stage):
            stages.append(stage)
            report(stage)

        return real(req, both)

    monkeypatch.setattr(api, "_etf_parts", recording)
    body = {"universe": core(client), "start": "2017-01-06", "top_n": 4}
    job = _job(client, body, fresh=True)
    assert stages == ["loading", "simulating", "analysing"] and job["stage"] is None


def test_circuit_realism_runs_the_opposite_setting_on_the_prices_it_is_given(
    broad_client, monkeypatch
):
    """The real second engine run (only the database read for lock masks is replaced). The run
    being asked about is reported as it ran, and the opposite setting is what was run again."""
    req = api.BacktestRequest(
        **_broad_request(broad_coverage_floor=0.0, broad_pool_top_n=10, broad_pool_exit_rank=10)
    )
    ranking = api._broad_ranking(req)
    outer = api.DATA.get()
    outcome = api._run_broad(req, ranking, outer)
    asked = []

    def no_locks(column_to_base, weeks, **_):
        asked.append(1)
        empty = pd.DataFrame(False, index=weeks, columns=list(column_to_base))
        return empty, empty

    monkeypatch.setattr(api.circuit_exposure_mod, "lock_masks", no_locks)
    realism = api._circuit_realism(req, ranking, outcome, outer)
    assert asked == [1]  # this run ignored locks, so the other setting (respect) ran
    assert realism["this_run_respects_locks"] is False
    assert set(realism["ignoring_locks"]) == {"cagr", "max_drawdown", "total_return", "trades"}
    assert realism["ignoring_locks"]["cagr"] == pytest.approx(
        float(api.metrics.cagr(outcome.result.equity))
    )
    assert realism["cagr_impact"] == pytest.approx(
        realism["respecting_locks"]["cagr"] - realism["ignoring_locks"]["cagr"]
    )


def test_the_circuit_section_builds_the_real_realism_comparison(broad_client, monkeypatch):
    """Through the section route, with only the two database reads replaced."""

    def no_locks(column_to_base, weeks, **_):
        empty = pd.DataFrame(False, index=weeks, columns=list(column_to_base))
        return empty, empty

    monkeypatch.setattr(api.circuit_exposure_mod, "lock_masks", no_locks)
    monkeypatch.setattr(
        api.circuit_exposure_mod, "circuit_exposure", lambda result, mapping: {"lc": []}
    )
    body = _broad_request(broad_coverage_floor=0.0, broad_pool_top_n=10, broad_pool_exit_rank=10)
    job = _job(broad_client, body, fresh=True)
    res = broad_client.get(f"/api/backtest/jobs/{job['id']}/sections/circuit_exposure")
    assert res.status_code == 200, res.text
    data = res.json()["data"]
    assert data["lc"] == [] and data["realism"]["this_run_respects_locks"] is False
    assert "respecting_locks" in data["realism"]


def test_broad_circuit_card_is_a_section_built_from_the_runs_own_prices(broad_client, monkeypatch):
    """The synthetic fixture has no daily bars, so the real card is empty (None): stub it, to give
    the section content, and check what matters here: it is built from the prices the run used,
    not whatever is loaded when the card is opened, and equals the synchronous result's."""
    seen = {}
    monkeypatch.setattr(
        api.circuit_exposure_mod, "circuit_exposure", lambda result, mapping: {"lc": [{"n": 1}]}
    )
    monkeypatch.setattr(
        api,
        "_circuit_realism",
        lambda req, ranking, outcome, outer_prices: (
            seen.update(outer=outer_prices) or {"cagr_impact": 0.5}
        ),
    )
    body = _broad_request(broad_coverage_floor=0.0, broad_pool_top_n=10, broad_pool_exit_rank=10)
    job = _job(broad_client, body, fresh=True)
    assert "circuit_exposure" not in job["result"]
    assert set(job["result"]["sections_available"]) == {*LAZY, "circuit_exposure"}
    at_run = api.DATA.get()
    api.DATA.prices = at_run.copy()  # later, newer data is loaded: a different frame
    assert api.DATA.get() is not at_run

    res = broad_client.get(f"/api/backtest/jobs/{job['id']}/sections/circuit_exposure")
    assert res.status_code == 200, res.text
    assert res.json()["data"] == {"lc": [{"n": 1}], "realism": {"cagr_impact": 0.5}}
    assert seen["outer"] is at_run
    sections = {}
    for name in LAZY:
        res = broad_client.get(f"/api/backtest/jobs/{job['id']}/sections/{name}")
        assert res.status_code == 200, (name, res.text)
        sections[name] = res.json()["data"]

    # a `fresh` run releases the job's sections, so compare after fetching them
    whole = broad_client.post("/api/backtest", json={**body, "fresh": True}).json()
    assert whole["circuit_exposure"] == {"lc": [{"n": 1}], "realism": {"cagr_impact": 0.5}}
    for name in LAZY:
        assert _as_json(sections[name]) == _as_json(whole[name]), name


def test_the_stock_drawer_endpoint_returns_history_and_404s_for_an_unscored_symbol(
    client, monkeypatch
):
    import pandas as pd

    from momentum_backtesting.categories import broad

    weeks = [pd.Timestamp("2020-01-03") + pd.Timedelta(weeks=i) for i in range(90)]
    frame = pd.DataFrame(
        {f"S{i}": [100 * (1 + 0.01 - i * 0.002) ** w for w in range(90)] for i in range(5)},
        index=weeks,
    )
    universe = broad.StockUniverseFrame(
        frame=frame,
        weeks=weeks,
        column_to_base_symbol={c: c for c in frame.columns},
        stock_membership=pd.DataFrame(True, index=weeks, columns=frame.columns),
        events=pd.DataFrame(),
        stale_columns={},
        missing_symbols=[],
    )
    monkeypatch.setattr(api.DATA, "get_momentum_universe", lambda: universe)

    ok = client.get("/api/momentum-scores/stock/S2")
    assert ok.status_code == 200
    body = ok.json()
    assert body["symbol"] == "S2" and len(body["closes"]) == 53 and len(body["ranks"]) == 26
    assert client.get("/api/momentum-scores/stock/NOPE").status_code == 404


def test_the_stock_circuits_endpoint_reads_the_52_weeks_to_the_pages_last_week(client, monkeypatch):
    import pandas as pd

    from momentum_backtesting.categories import broad

    weeks = [pd.Timestamp("2020-01-03") + pd.Timedelta(weeks=i) for i in range(90)]
    frame = pd.DataFrame({"S0": [100.0 + w for w in range(90)]}, index=weeks)
    universe = broad.StockUniverseFrame(
        frame=frame,
        weeks=weeks,
        column_to_base_symbol={"S0": "S0"},
        stock_membership=pd.DataFrame(True, index=weeks, columns=frame.columns),
        events=pd.DataFrame(),
        stale_columns={},
        missing_symbols=[],
    )
    monkeypatch.setattr(api.DATA, "get_momentum_universe", lambda: universe)
    asked = []

    def fake(symbol, as_of, **kwargs):
        asked.append((symbol, as_of))
        return {"symbol": symbol, "locks": [], "total": 0}

    monkeypatch.setattr(api.circuit_exposure_mod, "stock_circuit_locks", fake)

    ok = client.get("/api/momentum-scores/stock/S0/circuits")
    assert ok.status_code == 200 and ok.json()["symbol"] == "S0"
    assert asked == [("S0", weeks[-1])]
    # a symbol the page does not score is a 404 and never reads the bars
    assert client.get("/api/momentum-scores/stock/NOPE/circuits").status_code == 404
    assert len(asked) == 1

    def no_database(*args, **kwargs):
        raise FileNotFoundError("no catalog")

    monkeypatch.setattr(api.circuit_exposure_mod, "stock_circuit_locks", no_database)
    assert client.get("/api/momentum-scores/stock/S0/circuits").status_code == 503
