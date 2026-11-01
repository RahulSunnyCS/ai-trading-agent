"""BL-176 Stage 3: a saved favourite becomes a search record the ordinary scorer can run."""

import importlib.util
import json
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
_spec = importlib.util.spec_from_file_location(
    "bl176_favourites", ROOT / "scripts" / "bl176_favourites.py"
)
fav = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(fav)

from momentum_backtesting import search  # noqa: E402

SPACE = ROOT / "search_spaces" / "round8_A_curated.toml"
#: Four Sectors Monthly, No Tilt's first sleeve as the dashboard saved it.
MEMBER = {
    "dataset": "broad",
    "universe": ["broad_momentum"],
    "end": None,
    "portfolio": "buffer",
    "rebalance": "weekly",
    "broad_category_mode": "on",
    "broad_category_tags": "curated",
    "broad_universe": "turnover_rank",
    "broad_liquidity_filter": True,
    "start": "2017-01-01",
    "cost_model": "itemised",
    "cost_pct": 0.1,
    "slippage_bps": 15.0,
    "capital": 50000.0,
    "broad_respect_circuits": True,
    "broad_every_week": True,
    "momentum_sizing": False,
    "momentum_sizing_window": 10,
    "momentum_sizing_floor": 0.0,
    "signal_delay": 1,
    "cap_band": 0.05,
    "max_stock_price": 10000,
    "sell_every_week": False,
    "broad_series_breaks": "verified",
    "lookbacks": [4, 13, 26, 52],
    "weights": [1.0, 2.0, 3.0, 4.0],
    "score": "voladj",
    "voladj_skip_recent_month": True,
    "broad_liq_min_turnover_cr": 2.0,
    "broad_liq_floor_ratio": 0.25,
    "broad_liq_min_price": 30.0,
    "broad_liq_circuit": True,
    "broad_liq_circuit_run": 3,
    "broad_liq_max_circuit_days": None,
    "broad_coverage_floor": 0.0313,
    "broad_pool_top_n": 193,
    "broad_pool_exit_rank": 364,
    "broad_category_top_n": 4,
    "broad_category_exit_rank": 11,
    "broad_picks_per_category": 1,
    "max_position": 0.25,
    "max_category": None,
    "rebalance_every": 4,
    "rebalance_offset": 0,
    "entry": "wait",
    "broad_reversal_tilt": 0.0,
    "broad_reversal_screen_pct": 0.0,
    "split_fridays": False,
}


def test_a_favourite_member_maps_to_the_search_settings_it_ran_with():
    fixed = search.load_space(SPACE).fixed
    heavy, light, notes = fav.search_record(MEMBER, fixed)
    assert heavy["lookbacks"] == [4, 13, 26, 52] and heavy["weight_scheme"] == "long"
    assert heavy["score"] == "voladj" and heavy["voladj_lookbacks"] is False
    assert light["category_top_n"] == 4 and light["category_exit_rank"] == 11
    assert light["pool_top_n"] == 193 and light["pool_exit_rank"] == 364
    assert light["fill"] == "next_fri_close" and light["top_sector_weight"] == 1.0
    assert light["stock_tilt"] == 0.0 and light["rebalance_every"] == 4
    assert not {"capital", "max_stock_price", "signal_delay"} & set(light)
    assert notes == ["max_stock_price 10000 -> round 8's 5000"]


@pytest.mark.parametrize(
    "change, message",
    [
        ({"broad_category_mode": "off"}, "broad_category_mode"),
        ({"weights": [3.0, 1.0, 2.0, 4.0]}, "weight scheme"),
        ({"signal_delay": 0}, "no search form"),
        ({"broad_new_lever": 1}, "no search setting"),
    ],
)
def test_a_favourite_the_search_cannot_express_is_refused_by_name(change, message):
    with pytest.raises(ValueError, match=message):
        fav.search_record({**MEMBER, **change}, search.load_space(SPACE).fixed)


def test_prepare_writes_one_scorable_record_per_group_and_notes_what_it_skipped(tmp_path):
    groups = [
        {"id": "g" * 32, "name": "Four", "status": "invested", "members": [{"config": MEMBER}]},
        {
            "id": "h" * 32,
            "name": "Odd",
            "status": "watching",
            "members": [{"config": {**MEMBER, "signal_delay": 0}}],
        },
        {"id": "i" * 32, "name": "Not a favourite", "status": None, "members": []},
    ]
    index = fav.prepare(groups, SPACE, tmp_path)
    rows = [
        json.loads(x) for x in (tmp_path / "results-favourites.jsonl").read_text().split("\n") if x
    ]
    assert [r["id"] for r in rows] == ["fav-gggggggggggg"]
    assert "metrics" in rows[0]  # the scorer only takes finished records
    assert [e["name"] for e in index] == ["Four", "Odd"] and "skipped" in index[1]
