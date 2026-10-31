"""BL-176 Stage 3: the top decile per basket is taken over a tag ranking's folders pooled."""

import importlib.util
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
_spec = importlib.util.spec_from_file_location(
    "bl176_top_decile", ROOT / "scripts" / "bl176_top_decile.py"
)
top = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(top)


def _row(rid: str, lb: float, baskets: list[str], every: int = 1) -> dict:
    return {
        "id": rid,
        "light": {"rebalance_every": every},
        "metrics": {},
        "rank": {"lb_fy_excess": lb, "baskets": baskets},
    }


def test_the_decile_is_pooled_across_folders_and_written_back_per_folder():
    a = [_row(f"a{i}", i / 100, ["medium"]) for i in range(10)]  # 0.00 .. 0.09
    b = [_row(f"b{i}", 0.5 + i / 100, ["medium"]) for i in range(10)]  # 0.50 .. 0.59
    chosen = top.choose({"A": a, "B": b}, ["conservative", "medium"])
    assert chosen == {"A": set(), "B": {"b9", "b8"}}  # top 10% of 20 = 2, both from B


def test_non_weekly_configs_enter_from_the_top_fifth_weekly_ones_from_the_top_tenth():
    # 20 runs in one basket, best first: w0, f1, w2, f3, ... (weekly even, fortnightly/monthly odd)
    rows = [
        _row(f"r{i}", 1 - i / 100, ["medium"], 1 if i % 2 == 0 else (2, 4)[i % 4 == 3])
        for i in range(20)
    ]
    chosen = top.choose({"A": rows}, ["medium"])
    # top 10% = places 0-1, top 20% = places 0-3: weekly r0 only, non-weekly r1 and r3
    assert chosen == {"A": {"r0", "r1", "r3"}}


def test_a_run_in_two_baskets_is_chosen_once_and_an_empty_basket_adds_nothing():
    rows = [_row(f"r{i}", i / 10, ["medium", "aggressive"]) for i in range(10)]
    chosen = top.choose({"A": rows}, ["conservative", "medium", "aggressive"])
    assert chosen == {"A": {"r9"}}


def test_the_script_writes_one_id_file_per_folder_and_refuses_folders_without_rank(tmp_path):
    for name, rows in {
        "A": [_row("x", 0.3, ["medium"])],
        "B": [_row("y", 0.1, ["medium"])],
    }.items():
        folder = tmp_path / name
        folder.mkdir()
        (folder / "results-1.jsonl").write_text("\n".join(json.dumps(r) for r in rows))
    out = tmp_path / "ids"
    args = [str(tmp_path / "A"), str(tmp_path / "B"), "--name", "curated", "--out", str(out)]
    assert top.main(args) == 0
    assert (out / "curated__A.ids").read_text() == "x\n"
    assert (out / "curated__B.ids").read_text() == ""
    bare = tmp_path / "C"
    bare.mkdir()
    (bare / "results-1.jsonl").write_text(json.dumps({"id": "z", "metrics": {}}))
    assert top.main([str(bare), "--name", "curated", "--out", str(out)]) == 2


def test_the_decile_is_read_from_the_committed_criteria():
    keys = json.loads((ROOT / "search_spaces" / "bl176_criteria.json").read_text())["stage_3"]
    assert keys["keys"]["top_share"] == top.TOP_SHARE
