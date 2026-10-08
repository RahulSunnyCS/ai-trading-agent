"""The live Broad weekly signal is the engine's own decision (BL-010 Phase 6, step 1).

The research path (`bias.Runner`, what the search and the Phase 6 freeze measured) and the live
path (`api._broad_backtest` -> `_research_weekly_result` -> Telegram and the forward journal) must
trade the same way. These tests do not need real data:

  * the frozen configs map onto request fields with nothing left to an API default;
  * the two paths hand `run_broad_backtest` identical arguments;
  * the live signal for week t, computed on data that ends at t (a flat sentinel week appended so
    the engine trades t), equals what a backtest on later data traded at t - on and off cadence;
  * the old advisory panel (`analysis.latest_signal`) did not.
"""

# ruff: noqa: F811 - the broad_client fixture is imported, then named as a test argument
from __future__ import annotations

import inspect
import json
from pathlib import Path

import numpy as np
import pandas as pd
import pytest
from test_api import _broad_request, broad_client  # noqa: F401 - the fixture

from momentum_backtesting import api, bias, phase6, search
from momentum_backtesting.categories import broad
from momentum_backtesting.categories import circuit_exposure as cx

PACKAGE = Path(__file__).resolve().parents[1]
FROZEN = json.loads((PACKAGE / "search_spaces" / "bl010_phase6_frozen.json").read_text())
SPACE = search.load_space(PACKAGE / "search_spaces" / "round7_A.toml")


# --- the frozen configs as requests ------------------------------------------------------------


def test_every_search_parameter_of_a_frozen_config_has_a_request_field():
    for config in FROZEN["configs"]:
        params = phase6.effective_parameters(FROZEN["fixed_settings"], config)
        assert set(params) <= set(phase6.REQUEST_FIELDS), config["id"]
        assert set(phase6.REQUEST_FIELDS.values()) <= set(api.BacktestRequest.model_fields)


def test_the_requests_validate_and_use_the_top_level_rebalance_offset():
    requests = phase6.favourite_requests(FROZEN)
    assert len(requests) == len(FROZEN["configs"])
    for request, config in zip(requests, FROZEN["configs"], strict=True):
        req = api.BacktestRequest(**request)  # validates
        assert req.rebalance_offset == config["rebalance_offset"]  # not light's raw sample
        assert req.rebalance_every == config["rebalance_every"]
        assert req.broad_universe == "turnover_rank" and req.broad_liquidity_filter
        assert req.broad_category_mode == "on" and req.broad_category_tags == "curated"
        assert req.broad_every_week and req.broad_respect_circuits
        assert req.signal_delay == 1 and req.slippage_bps == 15 and req.capital == 200000
        assert req.cost_model == "itemised" and req.max_stock_price == 10000
    # The light dict's own offset really is a different number for at least one config.
    assert any(c["light"]["rebalance_offset"] != c["rebalance_offset"] for c in FROZEN["configs"])


def test_a_parameter_with_no_request_field_is_refused_not_defaulted():
    config = json.loads(json.dumps(FROZEN["configs"][0]))
    config["light"]["mass_exit_response"] = "throttle"
    with pytest.raises(ValueError, match="mass_exit_response"):
        phase6.favourite_request(FROZEN["fixed_settings"], config)


def test_weights_are_expanded_the_way_the_search_expands_them():
    for request, config in zip(phase6.favourite_requests(FROZEN), FROZEN["configs"], strict=True):
        n = len(config["heavy"]["lookbacks"])
        assert request["weights"] == list(search.weights_for(config["heavy"]["weight_scheme"], n))


# Both paths with the data stubbed out: what `run_broad_backtest` is called with must be the same
# in every argument, with the defaults filled in on both sides.


def _stub_ranking():
    prices = pd.DataFrame({"AAA": [1.0, 2.0]}, index=pd.to_datetime(["2020-01-03", "2020-01-10"]))
    return type(
        "Ranking", (), {"prices": prices, "column_to_base_symbol": {"AAA": "AAA"}, "name": "R"}
    )()


@pytest.mark.parametrize("index", range(len(FROZEN["configs"])))
def test_search_and_live_paths_call_the_engine_with_the_same_arguments(index, monkeypatch):
    config = FROZEN["configs"][index]
    request = api.BacktestRequest(**phase6.favourite_requests(FROZEN)[index])
    ranking = _stub_ranking()
    calls: dict[str, list[dict]] = {"base": [], "run": []}
    real_signature = inspect.signature(broad.run_broad_backtest)

    monkeypatch.setattr(
        broad, "compute_universe_base", lambda **kw: calls["base"].append(kw) or _Base(ranking)
    )
    monkeypatch.setattr(broad, "finish_universe_ranking", lambda base, **kw: ranking)
    monkeypatch.setattr(broad, "run_broad_backtest", lambda **kw: calls["run"].append(kw))
    monkeypatch.setattr(cx, "lock_masks", lambda *a, **k: ("UC", "LC"))
    from momentum_backtesting import levers

    monkeypatch.setattr(levers, "grouped_momentum_ranks", lambda *a, **k: "TILT")
    monkeypatch.setattr(api.DATA, "get_broad_tilt_ranks", lambda *a, **k: "TILT")
    ranking_calls: list[dict] = []
    monkeypatch.setattr(
        api.DATA, "get_broad_ranking", lambda **kw: ranking_calls.append(kw) or ranking
    )

    # The research path.
    runner = bias.Runner.__new__(bias.Runner)
    runner.api, runner.space, runner.refs, runner._tilt_cache = api, SPACE, {}, {}
    runner.universe_kind, runner.category_tags = "turnover_rank", "curated"
    runner.common = dict(
        outer_prices="OUTER",
        stocks_data_dir=api.DATA_DIR / "stocks",
        categories_data_dir=api.DATA_DIR / "categories",
    )
    base = runner.base(config["heavy"])
    runner.run(base, config["heavy"], config["light"], rebalance_offset=config["rebalance_offset"])

    # The live path.
    api._run_broad(request, api._broad_ranking(request), "OUTER")

    (research_base,), (research_run,) = calls["base"], calls["run"][:1]
    (live_ranking,) = ranking_calls
    live_run = calls["run"][1]

    # Ranking side: what builds the global ranks.
    assert research_base["lookbacks"] == live_ranking["lookbacks"]
    assert research_base["weights"] == live_ranking["weights"]
    assert research_base["score"] == live_ranking["score"]
    assert research_base["voladj_skip_recent_month"] == live_ranking["voladj_skip_recent_month"]
    assert research_base["liquidity"] == live_ranking["liquidity"] is not None
    assert research_base["universe_kind"] == live_ranking["universe_kind"] == "turnover_rank"
    assert research_base["series_breaks"] == live_ranking["series_breaks"]
    assert (live_ranking["pool_top_n"], live_ranking["pool_exit_rank"]) == (
        config["light"]["pool_top_n"],
        config["light"]["pool_exit_rank"],
    )

    # Everything after it: every parameter, the signature's defaults filled in on both sides.
    defaults = {
        name: p.default
        for name, p in real_signature.parameters.items()
        if p.default is not inspect.Parameter.empty
    }
    research_args = {**defaults, **research_run}
    live_args = {**defaults, **live_run}
    different = {
        k: (research_args.get(k), live_args.get(k))
        for k in sorted(set(research_args) | set(live_args))
        if research_args.get(k) != live_args.get(k)
    }
    assert not different, different
    assert live_args["rebalance_offset"] == config["rebalance_offset"]
    assert live_args["uc_locked"] == "UC" and live_args["lc_locked"] == "LC"
    assert live_args["stock_tilt_ranks"] == ("TILT" if config["light"]["stock_tilt"] else None)


class _Base:
    def __init__(self, ranking):
        self.full_frame = ranking.prices


# --- turnover_rank in the API --------------------------------------------------------------------


def test_turnover_rank_is_a_gated_universe_like_all_liquid():
    plain = api.BacktestRequest(universe=["x"])
    assert api._liquidity_config(plain) is None  # unchanged default
    for universe in ("all_liquid", "turnover_rank"):
        req = api.BacktestRequest(universe=["x"], broad_universe=universe)
        assert api._liquidity_config(req) is not None, universe
    gated = api.BacktestRequest(
        universe=["x"],
        broad_universe="turnover_rank",
        broad_liq_min_turnover_cr=2.0,
        broad_liq_min_price=30.0,
    )
    cfg = api._liquidity_config(gated)
    assert (cfg.min_turnover_cr, cfg.min_price, cfg.floor_ratio) == (2.0, 30.0, 0.25)


def test_turnover_rank_reaches_the_ranking_builder(monkeypatch):
    seen = {}

    def fake(**kw):
        seen.update(kw)
        raise RuntimeError("stop")

    monkeypatch.setattr(api, "DATA", api._Data())
    monkeypatch.setattr(api.DATA, "get", lambda: pd.DataFrame())
    monkeypatch.setattr(broad, "compute_universe_ranking", fake)
    req = api.BacktestRequest(universe=["x"], broad_universe="turnover_rank")
    with pytest.raises(RuntimeError, match="stop"):
        api._broad_ranking(req)
    assert seen["universe_kind"] == "turnover_rank" and seen["liquidity"] is not None


# --- the live signal is the engine's decision ----------------------------------------------------

#: Delay 1 as in the frozen configs; a small synthetic universe; no circuit locks (the synthetic
#: bars carry no highs and lows).
CASES = [
    {"rebalance_every": 2, "rebalance_offset": 0, "entry": "make_room"},
    {"rebalance_every": 2, "rebalance_offset": 1, "entry": "wait", "broad_reversal_tilt": 0.5},
    {"rebalance_every": 4, "rebalance_offset": 0, "entry": "wait"},
    {"rebalance_every": 4, "rebalance_offset": 1, "entry": "make_room"},
    {"rebalance_every": 4, "rebalance_offset": 2, "entry": "wait", "sell_every_week": True},
    {"rebalance_every": 4, "rebalance_offset": 3, "entry": "make_room", "max_position": 0.4},
]
#: Indices into the backtest's weeks. The step is odd so both phases of a 2-weekly cadence, and
#: every phase of a 4-weekly one, are hit.
CHECK_WEEKS = range(40, 160, 5)


def _request(case: dict) -> api.BacktestRequest:
    return api.BacktestRequest(
        **_broad_request(
            broad_coverage_floor=0.0,
            broad_pool_top_n=10,
            broad_pool_exit_rank=10,
            broad_category_top_n=2,
            broad_category_exit_rank=2,
            broad_picks_per_category=2,
            lookbacks=[4, 13, 26],
            signal_delay=1,
            **case,
        )
    )


class _Cutter:
    """Rewrites the synthetic data folder so it ends at a given week, as it would on that day."""

    def __init__(self, tmp_path, monkeypatch):
        self.dir = tmp_path
        self.monkeypatch = monkeypatch
        self.weekly = pd.read_csv(tmp_path / "weekly_closes.csv", index_col=0, parse_dates=True)
        self.daily = pd.read_parquet(tmp_path / "stocks" / "daily.parquet")
        self.daily_dates = pd.to_datetime(self.daily["date"])

    def to(self, last: pd.Timestamp | None) -> None:
        weekly, daily = self.weekly, self.daily
        if last is not None:
            weekly = weekly[weekly.index <= last]
            daily = daily[self.daily_dates <= last]
        weekly.to_csv(self.dir / "weekly_closes.csv")
        daily.to_parquet(self.dir / "stocks" / "daily.parquet")
        self.monkeypatch.setattr(api, "DATA", api._Data())


def _trades_at(result, week) -> list[tuple]:
    trades = result.trades
    rows = trades[trades["week"] == week]
    return sorted(
        (r.asset, r.action, None if pd.isna(r.rank) else int(r.rank), round(float(r.value), 9))
        for r in rows.itertuples()
    )


def _held(result, week) -> dict[str, float]:
    """The holdings after the week's trades; {} when the engine wrote no row (it holds nothing)."""
    if week not in result.weights.index:
        return {}
    row = result.weights.loc[week]
    return {n: round(float(w), 9) for n, w in row.items() if w > 1e-6}


def _sweep(tmp_path, monkeypatch, case, *, with_old=False):
    """week -> trades and holdings from the full-data backtest and from the live path on data that
    ends that week (plus the live signal rows, and the old advisory panel if asked)."""
    cutter = _Cutter(tmp_path, monkeypatch)
    req = _request(case)
    cutter.to(None)
    full = api._run_broad(req, api._broad_ranking(req), api.DATA.get())
    weeks = list(full.result.equity.index)
    out = {}
    for i in CHECK_WEEKS:
        week = weeks[i]
        cutter.to(week)
        outcome, decided = api._broad_sentinel_run(req)
        assert decided == week
        signal = api._broad_engine_signal(req)
        old = api._broad_backtest(req)["latest"] if with_old else None
        out[week] = {
            "full": (_trades_at(full.result, week), _held(full.result, week)),
            "live": (_trades_at(outcome.result, week), _held(outcome.result, week)),
            "signal": signal,
            "old": old,
        }
    return out


@pytest.mark.parametrize(
    "case", CASES, ids=lambda c: f"every{c['rebalance_every']}-o{c['rebalance_offset']}"
)
def test_the_live_signal_equals_the_backtests_trades_and_holdings_every_week(
    case, broad_client, tmp_path, monkeypatch
):
    swept = _sweep(tmp_path, monkeypatch, case)
    traded = 0
    for week, got in swept.items():
        trades_full, held_full = got["full"]
        trades_live, held_live = got["live"]
        assert trades_live == trades_full, f"{week:%Y-%m-%d} trades"
        assert set(held_live) == set(held_full), f"{week:%Y-%m-%d} holdings"
        for name, weight in held_full.items():
            assert held_live[name] == pytest.approx(weight, abs=1e-9), (week, name)
        # the rows Telegram and the journal read say the same as the engine's trades
        actions = {
            r["asset"]: r["action"]
            for r in got["signal"]["rows"]
            if r["action"] not in ("", "HOLD")
        }
        assert actions == {a: act for a, act, _rank, _v in trades_full if a != api.CASH}, week
        traded += bool(trades_full)
    assert traded >= 3  # the sweep is not vacuous


def test_off_cadence_weeks_show_no_buys_and_the_old_panel_did(broad_client, tmp_path, monkeypatch):
    case = {"rebalance_every": 4, "rebalance_offset": 0, "entry": "wait"}
    swept = _sweep(tmp_path, monkeypatch, case, with_old=True)
    buying = {"BUY", "ADD", "BUY (make room)", "WAIT"}
    off_weeks = [w for w in swept if round((w - pd.Timestamp("2016-01-01")).days / 7) % 4 != 0]
    assert off_weeks
    old_recommended_a_buy = []
    for week in off_weeks:
        engine_actions = {a for _asset, a, _r, _v in swept[week]["live"][0]}
        assert not engine_actions & {"BUY", "ADD"}, week  # nothing is bought off cadence
        assert "Not a rebalance week" in swept[week]["signal"]["explain"]
        old_actions = {r["action"] for r in swept[week]["old"]["rows"]}
        if old_actions & buying:
            old_recommended_a_buy.append(week)
    # the bug the test exists for: the advisory panel recommended buys on weeks the engine
    # does not trade
    assert old_recommended_a_buy


def test_the_signal_rows_keep_the_shape_telegram_and_the_journal_read(
    broad_client, tmp_path, monkeypatch
):
    case = {"rebalance_every": 2, "rebalance_offset": 0, "entry": "make_room"}
    cutter = _Cutter(tmp_path, monkeypatch)
    cutter.to(cutter.weekly.index[120])
    signal = api._broad_engine_signal(_request(case))
    # sleeve_value (BL-051): the sleeve's value since the April reset, for weighting a group.
    assert set(signal) == {"week", "rows", "explain", "target_weights", "sleeve_value"}
    assert signal["sleeve_value"] > 0
    assert signal["week"] == cutter.weekly.index[120].strftime("%Y-%m-%d")
    assert signal["rows"], "no rows"
    for row in signal["rows"]:
        assert {"asset", "rank", "score", "returns", "held", "action"} <= set(row)
    ranked = [r["rank"] for r in signal["rows"] if r["rank"] is not None]
    assert ranked == sorted(ranked)
    json.dumps(signal, allow_nan=False)  # plain JSON types, as the journal stores them
    assert sum(signal["target_weights"].values()) == pytest.approx(1.0, abs=1e-3)
    assert np.isfinite(list(signal["target_weights"].values())).all()


def test_the_weekly_result_for_broad_uses_the_engine_rows_not_the_advisory_panel(monkeypatch):
    class Stock:
        last_week = pd.Timestamp("2026-10-09")

    advisory = {"week": "2026-10-09", "rows": [{"asset": "INFY", "action": "BUY", "rank": 1}]}
    engine = {
        "week": "2026-10-09",
        "rows": [{"asset": "INFY", "action": "HOLD", "rank": 1, "held": True}],
        "target_weights": {"INFY": 1.0},
    }
    monkeypatch.setattr(api.DATA, "get_stock", lambda: Stock())
    monkeypatch.setattr(api, "_broad_backtest", lambda req: {"latest": advisory})
    monkeypatch.setattr(api, "_broad_engine_signal", lambda req: engine)
    favourite = {"name": "Broad", "config": {"dataset": "broad", "universe": ["x"]}}
    result, blocked = api._research_weekly_result(favourite, pd.Timestamp("2026-10-09"))
    assert blocked is None
    assert result.signal["rows"] == engine["rows"]
    assert "No trades this week." in result.notification.body
    assert "BUY" not in result.notification.body


# --- BL-051 Phase 3: the 14:15 decision, a week ahead ------------------------------------------


@pytest.mark.parametrize(
    "case", CASES, ids=lambda c: f"every{c['rebalance_every']}-o{c['rebalance_offset']}"
)
def test_with_a_signal_delay_the_week_ahead_buys_and_sells_what_the_backtest_did(
    case, broad_client, tmp_path, monkeypatch
):
    """At 14:15 on Friday t the stored data ends at t-1. With delay 1, which names are bought and
    which are sold outright at t come from t-1's ranks, so deciding "ahead" on data that ends at
    t-1 must name exactly the backtest's buys and full exits at t. Trims and top-ups read t's own
    prices (the stand-in is a flat copy of t-1), so they are not compared."""
    cutter = _Cutter(tmp_path, monkeypatch)
    req = _request(case)
    cutter.to(None)
    full = api._run_broad(req, api._broad_ranking(req), api.DATA.get())
    weeks = list(full.result.equity.index)
    compared = 0
    for i in CHECK_WEEKS:
        week, before = weeks[i], weeks[i - 1]
        cutter.to(before)
        outcome, decided = api._broad_sentinel_run(req, ahead=True)
        assert decided == week, (decided, week)

        def entries_and_exits(result, at):
            held_before = set(_held(result, weeks[weeks.index(at) - 1]) if at in weeks else ())
            held_after = set(_held(result, at))
            return held_after - held_before, held_before - held_after

        assert entries_and_exits(outcome.result, week) == entries_and_exits(full.result, week), (
            f"{week:%Y-%m-%d}"
        )
        compared += bool(set().union(*entries_and_exits(full.result, week)))
    assert compared >= 3  # the sweep is not vacuous


def test_the_week_ahead_signal_is_for_the_next_friday(broad_client, tmp_path, monkeypatch):
    cutter = _Cutter(tmp_path, monkeypatch)
    req = _request(CASES[0])
    cutter.to(None)
    last = api._broad_ranking(req).prices.index[-1]
    signal = api._broad_engine_signal(req, ahead=True)
    assert pd.Timestamp(signal["week"]) == last + pd.Timedelta(days=7)
