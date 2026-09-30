"""The local UI's API, on generated prices so it doesn't depend on downloaded data."""

import json

import numpy as np
import pandas as pd
import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

from momentum_backtesting import api
from momentum_backtesting.fetch import load_universe


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


def test_the_page_is_served(client):
    res = client.get("/")
    assert res.status_code == 200
    assert "Momentum backtest" in res.text
    assert client.get("/static/app.js").status_code == 200


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
    assert len(meta["instruments"]) == 95 + 4
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
    Gold competes in the SAME rank table as the 95 stocks, and when it ranks within top_n it
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
    # substitution for people to read is the frontend's job (see static/app.js's displayName()).
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
