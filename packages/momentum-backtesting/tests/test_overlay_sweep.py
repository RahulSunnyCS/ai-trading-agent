"""BL-229: the overlay sweep's grid expansion and resume bookkeeping (no data needed)."""

import json

from momentum_backtesting import overlay_sweep as sweep


def test_grid_expands_and_puts_runs_collapse_across_strategies():
    grid = {
        "name": "t",
        "base": {"capital": 1_000_000, "split": "2023-12-31"},
        "axes": {
            "strategy": [
                {"label": "Trio", "favourite_id": "a"},
                {"label": "Mine", "custom": {"lookbacks": [26], "top_n": 5}},
            ],  # fmt: skip
            "direction": ["calls", "puts"],
            "bundle": [{}, {"stop": 0.5, "target": 1.0}],
        },
    }
    bodies = sweep.expand(grid)
    calls = [b for b in bodies if b["direction"] == "calls"]
    puts = [b for b in bodies if b["direction"] == "puts"]
    assert len(calls) == 4 and len(puts) == 2  # puts read no strategy: one per bundle
    assert all("favourite_id" not in b and "custom" not in b for b in puts)
    assert {b["_label"] for b in calls} == {"Trio", "Mine"}
    assert len({b["_id"] for b in bodies}) == 6
    assert sweep.expand(grid)[0]["_id"] == bodies[0]["_id"]  # stable ids, for resuming


def test_done_ids_read_every_worker_file(tmp_path):
    (tmp_path / "results-w0.jsonl").write_text(json.dumps({"id": "a"}) + "\n")
    (tmp_path / "results-w1.jsonl").write_text(json.dumps({"id": "b"}) + "\nnot json\n")
    assert sweep.done_ids(tmp_path) == {"a", "b"}
