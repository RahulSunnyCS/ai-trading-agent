"""The live Broad preview: the rebalance preview and the 14:40 weekly job rank on Fyers live
prices held in memory only, for the default and the turnover-ranked universes.

The parity tests are the safety net: with every live price equal to the stored close, the live
path must rebuild exactly the stored ranking's pool and make exactly the stored path's trades.
Anything else means the live preview and the backtest disagree about what the strategy holds.
"""

# ruff: noqa: F811 - the broad_client fixture is imported, then named as a test argument
from __future__ import annotations

import dataclasses
from datetime import datetime

import pandas as pd
import pytest
from test_api import _broad_request, broad_client  # noqa: F401 - the fixture
from test_saved_runs import _favourite, client  # noqa: F401 - the fixture

from momentum_backtesting import api, fyers, notify, rebalance, weekly
from momentum_backtesting.categories import broad
from momentum_backtesting.engine import Config
from momentum_backtesting.notify import IST, Notification

MARKET_HOURS = datetime(2026, 10, 9, 14, 40, tzinfo=IST)

# --- parity: live prices equal to the close reproduce the stored path --------------------------


def _quotes_equal_to_the_close(ranking: broad.UniverseRanking) -> dict[str, float]:
    """A Fyers quote per symbol equal to the stored close of the newest week, and the ETF
    reference files the two foreign atomics are priced against."""
    symbols = rebalance.broad_quote_symbols(ranking)
    last = ranking.prices.index[-1]
    raw = ranking.raw_prices if ranking.raw_prices is not None else ranking.prices
    etf_dir = api.DATA_DIR / "daily_etf"
    etf_dir.mkdir(exist_ok=True)
    quotes = {}
    for name, symbol in symbols.items():
        if name in ("Nasdaq 100", "Hang Seng"):
            pd.DataFrame({"close": [50.0]}).to_csv(etf_dir / f"{name}.csv")
            quotes[symbol] = 50.0
        elif name in broad.ATOMIC_NAMES:
            quotes[symbol] = float(ranking.prices.at[last, name])
        else:
            quotes[symbol] = float(raw.at[last, name])
    return quotes


@pytest.mark.parametrize("overrides", [{}, {"rebalance_every": 4, "rebalance_offset": 1}])
def test_live_prices_equal_to_the_close_give_the_stored_signal(broad_client, overrides):
    req = api.BacktestRequest(**_broad_request(**overrides))
    ranking = api._broad_ranking(req)
    last = ranking.prices.index[-1]
    quotes = _quotes_equal_to_the_close(ranking)

    live, _ltp, _symbols, week = api._broad_live_ranking(req, quotes, last.date())
    assert week == last
    for frame in ("global_ranks", "pool_membership", "stock_pool_ranks", "combined_pool_ranks"):
        stored, rebuilt = getattr(ranking, frame), getattr(live, frame)
        pd.testing.assert_series_equal(
            stored.loc[last], rebuilt.loc[last, stored.columns], check_names=False, obj=frame
        )

    stored_signal = api._broad_engine_signal(req)
    live_signal = api._broad_engine_signal(
        req, api._broad_live_sentinel_run(req, quotes, last.date())
    )
    assert live_signal["week"] == stored_signal["week"]
    assert live_signal["target_weights"] == stored_signal["target_weights"]
    actions = lambda s: [(r["asset"], r["action"], r["rank"]) for r in s["rows"] if r["action"]]  # noqa: E731
    assert actions(live_signal) == actions(stored_signal)


def test_a_live_price_moves_this_weeks_ranking_but_never_the_stored_data(broad_client):
    req = api.BacktestRequest(**_broad_request())
    ranking = api._broad_ranking(req)
    last = ranking.prices.index[-1]
    before = ranking.prices.copy()
    quotes = _quotes_equal_to_the_close(ranking)
    worst = ranking.global_ranks.loc[last].drop(list(broad.ATOMIC_NAMES)).idxmax()
    symbol = rebalance.broad_quote_symbols(ranking)[worst]
    quotes[symbol] *= 1.45  # the worst-ranked stock jumps today

    live, _ltp, _symbols, _week = api._broad_live_ranking(req, quotes, last.date())
    assert live.global_ranks.at[last, worst] < ranking.global_ranks.at[last, worst]
    pd.testing.assert_frame_equal(api._broad_ranking(req).prices, before)


# --- which universes go live -------------------------------------------------------------------


def test_turnover_rank_is_quoted_live_and_the_whole_market_is_not(monkeypatch):
    seen = {}
    monkeypatch.setattr(api, "_broad_ranking", lambda req: "RANKING")

    def live_ranking(ranking, quotes, today, config, **kwargs):
        seen.update(kwargs)
        return "LIVE", {}, {}

    monkeypatch.setattr(rebalance, "live_broad_ranking", live_ranking)
    req = api.BacktestRequest(universe=["*"], dataset="broad", broad_universe="turnover_rank")
    assert api._broad_live_ranking(req, {}, datetime(2026, 10, 9).date())[0] == "LIVE"
    assert seen["universe_kind"] == "turnover_rank" and seen["liquidity"] is not None

    whole = req.model_copy(update={"broad_universe": "all_liquid"})
    with pytest.raises(ValueError, match="whole-market"):
        api._broad_live_ranking(whole, {}, datetime(2026, 10, 9).date())


# --- the rebalance preview says why it was not live --------------------------------------------


def _preview(broad_client, monkeypatch, at: datetime):
    def no_token(**_kwargs):
        raise fyers.FyersCredentialsError("token expired at 06:00")

    monkeypatch.setattr(fyers, "resolve_credentials", no_token)
    monkeypatch.setattr(api, "load_repo_env", lambda: None)
    req = api.RebalanceRequest(**_broad_request(), portfolio_value=100000)
    return api.rebalance_preview(req, now=at)


def test_a_market_hours_preview_without_a_token_says_why_it_used_the_close(
    broad_client, monkeypatch
):
    result = _preview(broad_client, monkeypatch, datetime(2026, 10, 9, 11, 0, tzinfo=IST))
    assert result["price_mode"] == "last_close"
    assert "token expired" in result["live_unavailable"]


def test_an_after_hours_preview_uses_the_close_without_a_warning(broad_client, monkeypatch):
    result = _preview(broad_client, monkeypatch, datetime(2026, 10, 9, 18, 0, tzinfo=IST))
    assert result["price_mode"] == "last_close"
    assert result["live_unavailable"] is None


# --- the 14:40 weekly job ----------------------------------------------------------------------


def _broad_outcome(id_: str, active: bool) -> dict:
    return {
        "id": id_,
        "name": id_,
        "dataset": "broad",
        "active": active,
        "result": None,
        "blocked": "Weekly ingest is not yet available for this dataset.",
    }


def test_only_the_broad_headline_is_ranked_live(monkeypatch):
    outcomes = [_broad_outcome("head", True), _broad_outcome("other", False)]
    favorites = {o["id"]: {"id": o["id"], "name": o["id"], "config": {}} for o in outcomes}
    made = []

    def live_result(favorite, creds, now, cache):
        made.append(favorite["id"])
        return weekly.RunResult(Notification("t", "info", "t", ""), {"week": "2026-10-09"})

    monkeypatch.setattr(api, "_broad_live_weekly_result", live_result)
    api._broad_live_previews(outcomes, favorites, [], creds="CREDS", now=MARKET_HOURS)
    assert made == ["head"]
    assert outcomes[0]["result"] is not None and outcomes[0]["blocked"] is None
    assert outcomes[0]["journal"] is False
    assert outcomes[1]["result"] is None and "journal" not in outcomes[1]


def test_a_headline_groups_sleeves_are_all_ranked_live(monkeypatch):
    outcomes = [_broad_outcome("a", False), _broad_outcome("b", False), _broad_outcome("c", False)]
    favorites = {o["id"]: {"id": o["id"], "name": o["id"], "config": {}} for o in outcomes}
    group = {"id": "g", "active": True, "members": [{"id": "a"}, {"id": "b"}]}
    made = []
    monkeypatch.setattr(
        api,
        "_broad_live_weekly_result",
        lambda favorite, *a: made.append(favorite["id"]) or "RESULT",
    )
    api._broad_live_previews(outcomes, favorites, [group], creds="CREDS", now=MARKET_HOURS)
    assert made == ["a", "b"]


def test_without_a_token_the_headline_is_blocked_with_the_reason(monkeypatch):
    outcomes = [_broad_outcome("head", True)]
    api._broad_live_previews(outcomes, {"head": {}}, [], creds=None, now=MARKET_HOURS)
    assert "Fyers token" in outcomes[0]["blocked"]
    assert outcomes[0]["awaiting_data"] is False  # so the job reports it


def test_after_hours_the_headline_waits_for_the_1930_run_untouched():
    outcome = _broad_outcome("head", True)
    before = dict(outcome)
    after = datetime(2026, 10, 9, 16, 0, tzinfo=IST)
    api._broad_live_previews([outcome], {"head": {}}, [], creds="CREDS", now=after)
    assert outcome == before


def test_an_exchange_holiday_counts_as_closed(monkeypatch):
    monkeypatch.setattr(api, "_exchange_holiday", lambda day: True)
    assert not api._market_open(MARKET_HOURS)
    outcome = _broad_outcome("head", True)
    before = dict(outcome)
    api._broad_live_previews([outcome], {"head": {}}, [], creds="CREDS", now=MARKET_HOURS)
    assert outcome == before


def test_an_off_hours_group_headline_stays_quiet():
    """Its sleeves keep their 'waiting for 19:30' reason, so the group is awaiting data too."""
    outcomes = [_broad_outcome("a", False), _broad_outcome("b", False)]
    group = {
        "id": "g",
        "name": "Pair",
        "config": {"dataset": "broad"},
        "active": True,
        "members": [{"id": "a", "name": "a"}, {"id": "b", "name": "b"}],
    }
    after = datetime(2026, 10, 9, 16, 0, tzinfo=IST)
    api._broad_live_previews(outcomes, {}, [group], creds="CREDS", now=after)
    (combined,) = api._group_outcomes([group], outcomes, "preview")
    assert combined["result"] is None and combined["awaiting_data"] is True


def test_a_network_failure_is_reported_not_raised(monkeypatch):
    def offline(*_args):
        raise OSError("urlopen error [Errno 51] Network is unreachable")

    monkeypatch.setattr(api, "_broad_live_weekly_result", offline)
    outcomes = [_broad_outcome("head", True)]
    api._broad_live_previews(outcomes, {"head": {}}, [], creds="CREDS", now=MARKET_HOURS)
    assert "Network is unreachable" in outcomes[0]["blocked"]
    assert outcomes[0]["awaiting_data"] is False


def test_a_network_failure_in_the_rebalance_preview_falls_back_to_the_close(
    broad_client, monkeypatch
):
    monkeypatch.setattr(fyers, "resolve_credentials", lambda **_kwargs: "CREDS")
    monkeypatch.setattr(api, "load_repo_env", lambda: None)

    def offline(*_args):
        raise TimeoutError("timed out")

    monkeypatch.setattr(fyers, "quotes", offline)
    req = api.RebalanceRequest(**_broad_request(), portfolio_value=100000)
    result = api.rebalance_preview(req, now=MARKET_HOURS)
    assert result["price_mode"] == "last_close" and result["live_unavailable"] == "timed out"


def test_the_whole_market_universe_previews_from_the_close_without_a_warning(monkeypatch):
    req = api.RebalanceRequest(
        universe=["*"],
        dataset="broad",
        broad_universe="all_liquid",
        broad_liquidity_filter=True,
        portfolio_value=100000,
    )
    ranking = type("R", (), {"prices": pd.DataFrame(index=[pd.Timestamp("2026-10-02")])})()
    monkeypatch.setattr(api, "_broad_ranking", lambda r: ranking)
    monkeypatch.setattr(rebalance, "broad_quote_symbols", lambda r: {})
    monkeypatch.setattr(fyers, "resolve_credentials", lambda **_kwargs: "CREDS")
    monkeypatch.setattr(api, "load_repo_env", lambda: None)
    monkeypatch.setattr(fyers, "quotes", lambda *a: pytest.fail("the whole market was quoted"))

    class Stop(Exception):
        pass

    def persisted(r):
        raise Stop

    monkeypatch.setattr(rebalance, "persisted_broad_ranking", persisted)
    with pytest.raises(Stop):  # reached the last-close branch without quoting
        api.rebalance_preview(req, now=MARKET_HOURS)


def test_a_failed_live_preview_is_reported_not_raised(monkeypatch):
    def fail(*_args):
        raise ValueError("Fyers returned no LTP for 3 Broad instruments")

    monkeypatch.setattr(api, "_broad_live_weekly_result", fail)
    outcomes = [_broad_outcome("head", True)]
    api._broad_live_previews(outcomes, {"head": {}}, [], creds="CREDS", now=MARKET_HOURS)
    assert outcomes[0]["blocked"].startswith("Live Broad preview failed: Fyers returned no LTP")


def test_the_1440_job_sends_the_live_broad_headline_and_does_not_journal_it(client, monkeypatch):
    headline = _favourite(client, "Broad headline", "paper", "broad")
    client.patch(f"/api/saved-runs/{headline['id']}", json={"active": True})
    monkeypatch.setattr(
        weekly,
        "run_favorite_strategies",
        lambda *a, **k: [_broad_outcome(headline["id"], True) | {"name": "Broad headline"}],
    )
    monkeypatch.setattr(fyers, "resolve_credentials", lambda: "CREDS")
    monkeypatch.setattr(api, "_ist_now", lambda: MARKET_HOURS)
    note = Notification("momentum-weekly", "action_required", "Momentum PREVIEW — x", "body")
    monkeypatch.setattr(
        api,
        "_broad_live_weekly_result",
        lambda *a: weekly.RunResult(note, {"week": "2026-10-09", "rows": [], "weights": {}}),
    )
    sent = []
    monkeypatch.setattr(notify, "send", sent.append)

    result = api._execute_weekly_run(api.WeeklyRunBody(run="preview", send=True))
    assert result["sent_to_telegram"] is True
    assert sent[0].title == "Momentum PREVIEW — x"
    entries, _notes = api._journal_entries(
        "preview",
        [{"id": "x", "dataset": "broad", "journal": False, "result": weekly.RunResult(note, {})}],
        {},
        MARKET_HOURS,
        None,
    )
    assert entries == []


def test_the_live_rebuild_reuses_the_rankings_universe_instead_of_reloading_it(
    broad_client, monkeypatch
):
    """Reloading the universe costs ~150 s on the real data; the ranking already holds it."""
    req = api.BacktestRequest(**_broad_request())
    ranking = api._broad_ranking(req)
    assert ranking.stock_membership is not None
    last = ranking.prices.index[-1]
    quotes = _quotes_equal_to_the_close(ranking)

    def reload(**_kwargs):
        raise AssertionError("the universe was reloaded from disk")

    monkeypatch.setattr(broad, "load_stock_universe_frame", reload)
    live, *_ = api._broad_live_ranking(req, quotes, last.date())
    pd.testing.assert_series_equal(
        ranking.pool_membership.loc[last], live.pool_membership.loc[last], check_names=False
    )


def test_a_series_that_ended_leaves_the_live_pool_as_it_does_the_stored_one(broad_client):
    req = api.BacktestRequest(**_broad_request())
    ranking = api._broad_ranking(req)
    last = ranking.prices.index[-1]
    member = ranking.pool_membership.loc[last]
    ended = member[member].index[0]
    stale = dataclasses.replace(ranking, stale_columns={ended: last - pd.Timedelta(days=21)})
    quotes = _quotes_equal_to_the_close(ranking)
    live, _ltp, _symbols = rebalance.live_broad_ranking(
        stale,
        quotes,
        last.date(),
        Config(lookbacks=tuple(req.lookbacks)),
        pool_top_n=req.broad_pool_top_n,
        pool_exit_rank=req.broad_pool_exit_rank,
        data_dir=api.DATA_DIR,
    )
    assert not live.pool_membership.at[last, ended]


def test_a_headline_blocked_for_a_real_reason_keeps_that_reason(monkeypatch):
    outcome = _broad_outcome("head", True) | {"blocked": "tax needs tax_classes"}
    for at in (MARKET_HOURS, datetime(2026, 10, 9, 16, 0, tzinfo=IST)):
        api._broad_live_previews([outcome], {"head": {}}, [], creds="CREDS", now=at)
        assert outcome["blocked"] == "tax needs tax_classes" and "awaiting_data" not in outcome
