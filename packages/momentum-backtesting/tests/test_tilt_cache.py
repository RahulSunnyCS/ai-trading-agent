"""The tilt-rank caches must never serve one frame's ranks for another (BL-010 Phase 6).

`bias.Runner` and `api._Data` cached `grouped_momentum_ranks` under `id(frame)` without keeping the
frame. Once the frame was freed (a cache eviction, a temporary preview ranking) CPython could hand
its id to a new frame, and the new frame silently got the old one's ranks. Three of the four frozen
configs use `stock_tilt > 0`.
"""

from __future__ import annotations

import gc
import weakref
from collections import OrderedDict
from pathlib import Path

import pandas as pd

from momentum_backtesting import api, bias, levers, search
from momentum_backtesting.categories import broad
from momentum_backtesting.categories import circuit_exposure as cx

LOOKBACKS = (4, 13, 26)


def _frame(value: float) -> pd.DataFrame:
    return pd.DataFrame({"A": [value, value + 1.0]})


def test_an_entry_for_another_object_with_the_same_id_is_a_miss():
    cache: OrderedDict = OrderedDict()
    old, new = _frame(1.0), _frame(2.0)
    # What a recycled id looks like: the key is the new frame's id, the entry was stored for a
    # frame that no longer exists. An id-only cache would return "STALE".
    cache[(id(new), LOOKBACKS, 0.5, 0.0)] = (old, "STALE")
    assert levers.tilt_cache_get(cache, new, LOOKBACKS, 0.5, 0.0) is None
    levers.tilt_cache_put(cache, new, LOOKBACKS, 0.5, 0.0, "FRESH", limit=4)
    assert levers.tilt_cache_get(cache, new, LOOKBACKS, 0.5, 0.0) == "FRESH"


def test_a_cached_entry_keeps_its_frame_alive_so_its_id_cannot_be_reused():
    cache: OrderedDict = OrderedDict()
    frame = _frame(1.0)
    reference = weakref.ref(frame)
    levers.tilt_cache_put(cache, frame, LOOKBACKS, 0.5, 0.0, "R", limit=4)
    del frame
    gc.collect()
    assert reference() is not None  # still referenced by the entry
    cache.clear()
    gc.collect()
    assert reference() is None


def test_the_cache_is_bounded_oldest_out_and_keyed_on_every_input():
    cache: OrderedDict = OrderedDict()
    frames = [_frame(float(i)) for i in range(5)]
    for i, frame in enumerate(frames):
        levers.tilt_cache_put(cache, frame, LOOKBACKS, 0.5, 0.0, i, limit=3)
    assert len(cache) == 3
    assert levers.tilt_cache_get(cache, frames[0], LOOKBACKS, 0.5, 0.0) is None
    assert levers.tilt_cache_get(cache, frames[4], LOOKBACKS, 0.5, 0.0) == 4
    for other in ((4, 13), 1.0):
        args = (LOOKBACKS, 1.0, 0.0) if other == 1.0 else (other, 0.5, 0.0)
        assert levers.tilt_cache_get(cache, frames[4], *args) is None


class _Ranking:
    def __init__(self, prices):
        self.prices = prices


def test_the_api_cache_computes_for_a_new_frame_even_under_a_colliding_key(monkeypatch):
    data = api._Data()
    computed = []
    monkeypatch.setattr(
        levers,
        "grouped_momentum_ranks",
        lambda prices, config, **kw: computed.append(prices) or ("RANKS", id(prices)),
    )
    first, second = _Ranking(_frame(1.0)), _Ranking(_frame(2.0))
    data.get_broad_tilt_ranks(first, LOOKBACKS, 0.5, 0.0)
    # plant the collision: the second frame's key, the first frame's entry
    data.broad_tilt_cache[(id(second.prices), LOOKBACKS, 0.5, 0.0)] = (first.prices, "STALE")
    got = data.get_broad_tilt_ranks(second, LOOKBACKS, 0.5, 0.0)
    assert got == ("RANKS", id(second.prices))
    assert computed == [first.prices, second.prices]
    # and a repeat is served from the cache
    assert data.get_broad_tilt_ranks(second, LOOKBACKS, 0.5, 0.0) is got
    assert len(computed) == 2


def test_the_search_runner_cache_computes_for_a_new_frame_even_under_a_colliding_key(monkeypatch):
    space = search.load_space(Path(__file__).resolve().parents[1] / "search_spaces/round7_A.toml")
    runner = bias.Runner.__new__(bias.Runner)
    runner.api, runner.space, runner.refs = api, space, {}
    runner.universe_kind, runner.category_tags = "turnover_rank", "curated"
    runner.common = dict(
        outer_prices=None, stocks_data_dir=Path("s"), categories_data_dir=Path("c")
    )
    runner._tilt_cache = {}
    frame = _frame(2.0)
    ranking = _Ranking(frame)
    ranking.column_to_base_symbol = {}
    base = type("Base", (), {"full_frame": frame})()
    stale_owner = _frame(1.0)
    runner._tilt_cache[(id(frame), LOOKBACKS, 1.0, 0.0)] = (stale_owner, "STALE")

    seen = {}
    monkeypatch.setattr(broad, "finish_universe_ranking", lambda base, **kw: ranking)
    monkeypatch.setattr(broad, "run_broad_backtest", lambda **kw: seen.update(kw))
    monkeypatch.setattr(cx, "lock_masks", lambda *a, **k: ("UC", "LC"))
    monkeypatch.setattr(levers, "grouped_momentum_ranks", lambda *a, **k: "FRESH")
    heavy = {"lookbacks": list(LOOKBACKS), "weight_scheme": "equal", "score": "voladj"}
    runner.run(base, heavy, {"stock_tilt": 1.0, "pool_top_n": 10, "pool_exit_rank": 12})
    assert seen["stock_tilt_ranks"] == "FRESH"
    assert runner._tilt_cache[(id(frame), LOOKBACKS, 1.0, 0.0)][0] is frame
