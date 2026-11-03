"""BL-176: the round 8 settings the API takes (`voladj_lookbacks`, `voladj_skip`,
`broad_top_sector_weight`) and the frozen ensemble's requests built from them."""

from __future__ import annotations

import importlib.util
import json
from pathlib import Path

import pytest
from fastapi import HTTPException

from momentum_backtesting import api, search
from momentum_backtesting.saved_identity import fingerprint

SPACES = Path(__file__).resolve().parents[1] / "search_spaces"
BROAD = {"broad_universe": "turnover_rank", "score": "voladj", "lookbacks": [13, 26, 52]}


def test_new_fields_at_their_defaults_keep_every_saved_fingerprint():
    base = fingerprint("broad", BROAD)
    defaults = {"voladj_lookbacks": False, "voladj_skip": "long", "broad_top_sector_weight": 1.0}
    assert fingerprint("broad", {**BROAD, **defaults}) == base
    # voladj_skip is read only with voladj_lookbacks on
    assert fingerprint("broad", {**BROAD, "voladj_skip": "none"}) == base


def test_each_new_field_set_is_a_different_strategy():
    on = {**BROAD, "voladj_lookbacks": True}
    seen = {
        fingerprint("broad", BROAD),
        fingerprint("broad", on),
        fingerprint("broad", {**on, "voladj_skip": "none"}),
        fingerprint("broad", {**BROAD, "broad_top_sector_weight": 1.5}),
    }
    assert len(seen) == 4


def test_other_datasets_ignore_the_new_fields():
    etf = {"universe": ["Nifty 50"], "score": "voladj"}
    assert fingerprint("etf", {**etf, "voladj_lookbacks": True}) == fingerprint("etf", etf)


def test_a_top_sector_weight_needs_the_category_layer():
    req = api.BacktestRequest(
        dataset="broad",
        universe=["_"],
        broad_category_mode="off",
        broad_top_sector_weight=1.5,
    )
    # `_run_broad` is what every Broad path (backtest, weekly signal, orders, previews) calls.
    with pytest.raises(HTTPException) as caught:
        api._run_broad(req, ranking=None, outer_prices=None)
    assert caught.value.status_code == 422


def test_ranksum_ignores_the_voladj_settings():
    ranksum = {**BROAD, "score": "ranksum"}
    on = {**ranksum, "voladj_lookbacks": True, "voladj_skip": "none"}
    assert fingerprint("broad", on) == fingerprint("broad", ranksum)


def test_the_save_script_refuses_an_api_that_lacks_the_fields(tmp_path):
    script = _save_script()
    old = {"components": {"schemas": {"BacktestRequest": {"properties": {"score": {}}}}}}
    (tmp_path / "openapi.json").write_text(json.dumps(old))
    assert script.live_api_missing((tmp_path / "openapi.json").as_uri()) == list(
        script.NEEDED_FIELDS
    )
    assert script.live_api_missing("http://127.0.0.1:9/openapi.json") is None


def _save_script():
    path = SPACES.parent / "scripts" / "bl176_save_ensemble.py"
    spec = importlib.util.spec_from_file_location("bl176_save_ensemble", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.mark.parametrize("ranking", ["curated", "extended"])
def test_the_frozen_ensembles_become_complete_requests(ranking):
    frozen = json.loads((SPACES / f"bl176_frozen_{ranking}.json").read_text())
    script = _save_script()
    for config in frozen["configs"]:
        space = search.load_space(SPACES.parent / config["space"])
        request = script.sleeve_request(config)  # what --apply saves
        req = api.BacktestRequest.model_validate(request)  # nothing the model refuses
        heavy, light = config["heavy"], config["light"]
        assert req.broad_universe == search.universe_of(space)
        assert req.broad_category_tags == ranking
        assert (req.signal_delay, req.execution) == search.FILLS[light["fill"]]
        assert req.voladj_lookbacks == heavy["voladj_lookbacks"]
        assert req.voladj_skip == heavy["voladj_skip"]
        assert req.broad_top_sector_weight == light["top_sector_weight"]
        assert req.broad_reversal_screen_pct == light["stock_tilt_screen_pct"]
        assert req.rebalance_offset == config["rebalance_offset"]
        assert req.capital == 200_000 and req.max_stock_price == 10_000


def test_the_all_liquid_member_runs_on_the_all_liquid_universe():
    frozen = json.loads((SPACES / "bl176_frozen_extended.json").read_text())
    c1 = next(c for c in frozen["configs"] if c["arm"] == "round8_C1")
    space = search.load_space(SPACES.parent / c1["space"])
    assert search.universe_of(space) == "all_liquid"
