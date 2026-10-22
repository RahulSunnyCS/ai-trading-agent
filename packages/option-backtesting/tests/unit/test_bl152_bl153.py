"""BL-152 / BL-153: the pre-registered verdict logic (research/bl152, research/bl153) and its inputs.

The scripts are one-off research, but they decide two registered verdicts, so the gates are pinned:
the 192 specs, the candidate and plateau rules, Holm, the permutation test, the support marking,
the grid runner's ledger recovery and the safe confirmation reuse.
"""

from __future__ import annotations

import importlib.util
import json
import math
import sys
from pathlib import Path
from types import SimpleNamespace

import numpy as np
import pytest

from option_backtesting.analytics.overfit import deflated_sharpe_of_series
from option_backtesting.ruletest import expr as E
from option_backtesting.ruletest import store
from option_backtesting.ruletest.spec import from_dict

RESEARCH = Path(__file__).resolve().parents[2] / "research"
sys.path.insert(0, str(RESEARCH / "common"))
import breakout_specs  # noqa: E402


def load(name: str, relative: str):
    spec = importlib.util.spec_from_file_location(name, RESEARCH / relative)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


judge = load("bl152_judge", "bl152/judge.py")
run_grid = load("bl152_run_grid", "bl152/run_grid.py")
support = load("bl153_support", "bl153/support.py")

FIRST = "bl152_or30_lvl_atm_eod"


# --- the registered grid ------------------------------------------------------------------------


def test_the_192_registered_specs_compile_to_distinct_rules():
    rules = breakout_specs.grid()
    assert len(rules) == 192
    hashes = {from_dict(rule).spec_hash for _vid, rule in rules}
    assert len(hashes) == 192
    ids = {vid for vid, _rule in rules}
    assert FIRST in ids and len(ids) == 192
    by_id = dict(rules)
    # an index stop or a Supertrend / 60-minute exit is an exit_when; prem30 with eod has none
    assert "exit_when" not in by_id["bl152_or30_prem30_atm_eod"]
    assert "exit_when" in by_id["bl152_or30_lvl_atm_eod"]
    assert "exit_when" in by_id["bl152_or30_prem30_atm_trail"]
    assert by_id["bl152_or30_prem30_sellopp_tgt2r"]["template"]["legs"][0]["target"] == {
        "percent": 60
    }


# --- BL-152's judge -----------------------------------------------------------------------------

GOOD = {
    "thin": False,
    "events": 100,
    "net_mean": 10.0,
    "net_t": 2.1,
    "random_percentile": 0.95,
}


def test_a_candidate_needs_every_registered_condition():
    assert judge.is_candidate(GOOD)
    for change in (
        {"thin": True},
        {"events": 39},
        {"net_mean": 0.0},
        {"net_mean": float("nan")},
        {"net_t": 1.99},
        {"net_t": None},
        {"random_percentile": 0.89},
        {"random_percentile": None},
    ):
        assert not judge.is_candidate({**GOOD, **change}), change


def test_a_variant_has_eleven_neighbours_one_setting_away():
    ids = {vid for vid, _ in breakout_specs.grid()}
    near = judge.neighbours(FIRST, ids)
    assert len(near) == 3 + 3 + 2 + 3
    mine = judge.axes_of(FIRST)
    for other in near:
        differing = sum(a != b for a, b in zip(mine, judge.axes_of(other), strict=True))
        assert differing == 1
    assert FIRST not in near
    assert judge.neighbours(FIRST, {FIRST}) == []  # only variants that were run count


def test_the_judge_deflated_sharpe_is_the_shared_formula():
    rng = np.random.default_rng(3)
    noise = rng.normal(0, 1, size=(300, 20))
    quiet = judge.deflated_sharpe(noise, [f"v{k}" for k in range(20)])
    assert quiet["n"] == 20 and quiet["days"] == 300 and 0 <= quiet["dsr"] < 0.99
    strong = noise.copy()
    strong[:, 4] += 0.5  # one variant with a real edge
    loud = judge.deflated_sharpe(strong, [f"v{k}" for k in range(20)])
    assert loud["best"] == "v4" and loud["dsr"] > 0.99
    series = {f"v{k}": strong[:, k].tolist() for k in range(20)}
    assert deflated_sharpe_of_series(series).deflated_sharpe == pytest.approx(loud["dsr"])


def test_deflated_sharpe_of_series_refuses_what_it_cannot_judge():
    with pytest.raises(ValueError, match="at least 2 trials"):
        deflated_sharpe_of_series({"a": [1.0, 2.0, 3.0]})
    with pytest.raises(ValueError, match="same sessions"):
        deflated_sharpe_of_series({"a": [1.0, 2.0], "b": [1.0, 2.0, 3.0]})
    with pytest.raises(ValueError, match="at least 2 sessions"):
        deflated_sharpe_of_series({"a": [1.0], "b": [2.0]})


# --- BL-152's grid runner -----------------------------------------------------------------------


def _result(vid: str, test_id: str, spec_hash: str) -> dict:
    rows = [
        {"day": f"2026-01-{d:02d}", "net": 100.0 * (d % 3 - 1), "gross": 120.0, "side": "up",
         "entry": "10:01", "exit": "11:00", "stopped_by": "", "expiry_day": False}
        for d in range(1, 31)
    ]  # fmt: skip
    return {
        "id": test_id,
        "spec_hash": spec_hash,
        "periods": {
            "learning": {
                "events": 30,
                "thin": True,
                "rows": rows,
                "net_total": sum(r["net"] for r in rows),
                "gross_mean": 120.0,
                "win_rate": 0.33,
                "random_time": {"event_percentile": 0.5, "mean": 1.0, "minutes_used": 40},
                "placebo": {"placebo_mean": 0.0, "diff_mean": 1.0, "events": 30},
                "slippage": {"0.5": {"net_mean": -5.0}, "1": {"net_mean": -9.0}},
                "by_side": {}, "by_expiry_day": {},
            }
        },
    }  # fmt: skip


def test_a_variant_in_the_ledger_but_not_in_done_is_recovered_not_run_again(tmp_path, monkeypatch):
    out = tmp_path / "out"
    (out / "nets").mkdir(parents=True)
    monkeypatch.setattr(run_grid, "OUT", out)
    root = tmp_path / "root"
    rule = dict(breakout_specs.grid())[FIRST]
    h = from_dict(rule).spec_hash
    other = dict(breakout_specs.grid())["bl152_or30_lvl_atm_trail"]
    store.record_test(
        root,
        {"id": "20261022-000001-aaaa", "spec_hash": h, "periods": ["learning"], "mode": "locked"},
        _result(FIRST, "20261022-000001-aaaa", h),
    )
    store.record_test(  # a confirmation-only test is not a learning result
        root,
        {"id": "20261022-000002-bbbb", "spec_hash": from_dict(other).spec_hash,
         "periods": ["confirmation"], "mode": "locked"},
        _result("x", "20261022-000002-bbbb", "z"),
    )  # fmt: skip
    finished: set[str] = set()
    assert run_grid.recover(root, finished) == [FIRST]
    assert finished == {FIRST}
    line = json.loads((out / "done.jsonl").read_text().splitlines()[0])
    assert (
        line["id"] == FIRST and line["test_id"] == "20261022-000001-aaaa" and line["events"] == 30
    )
    assert len(json.loads((out / "nets" / f"{FIRST}.json").read_text())) == 30
    assert run_grid.recover(root, finished) == []  # already finished: nothing more written
    assert len((out / "done.jsonl").read_text().splitlines()) == 1


# --- BL-153's comparison ------------------------------------------------------------------------


def test_holm_adjusts_in_order_and_keeps_missing_values_missing():
    got = support.holm({"a": 0.01, "b": 0.04, "c": 0.03, "d": None})
    assert got["a"] == pytest.approx(0.03)
    assert got["c"] == pytest.approx(0.06)  # max(0.03, 2 * 0.03)
    assert got["b"] == pytest.approx(0.06)  # never below the one before it
    assert got["d"] is None
    assert support.holm({"x": 0.9})["x"] == 0.9 and support.holm({"x": 0.6, "y": 0.7})["y"] <= 1.0


def _marked(nets_supported, nets_unsupported):
    rows = [{"net": n, "support": 3, "excluded": False} for n in nets_supported]
    rows += [{"net": n, "support": 0, "excluded": False} for n in nets_unsupported]
    return rows


def test_permutation_comparison_separates_a_real_gap_from_noise():
    gap = support.compare(
        _marked([100.0] * 30 + [90.0] * 30, [-100.0] * 30 + [-90.0] * 30), 2000, 1
    )
    assert gap["D"] == pytest.approx(190.0) and gap["p"] < 0.01
    assert (gap["supported"], gap["unsupported"], gap["share_supported"]) == (60, 60, 0.5)
    rng = np.random.default_rng(5)
    same = support.compare(_marked(rng.normal(0, 100, 60), rng.normal(0, 100, 60)), 2000, 1)
    assert same["p"] > 0.05
    assert support.compare(_marked([1.0] * 5, []), 100, 1)["D"] is None  # one side empty
    excluded = [{"net": 1.0, "support": None, "excluded": True}]
    assert support.compare(_marked([1.0, 2.0], [3.0, 4.0]) + excluded, 100, 1)["excluded"] == 1


def test_passes_applies_the_registered_rule_in_order():
    base = {
        "supported": 30, "unsupported": 30, "share_supported": 0.5, "D": 50.0,
        "mean_supported": 10.0,
    }  # fmt: skip
    assert support.passes(base, 0.04) == (True, "passes")
    assert support.passes({**base, "share_supported": 0.81}, 0.01)[1] == "non-selective"
    assert support.passes({**base, "supported": 19}, 0.01)[1] == "too few trades on a side"
    assert support.passes({**base, "unsupported": 19}, 0.01)[1] == "too few trades on a side"
    assert support.passes({**base, "D": 0.0}, 0.01)[1] == "D not above zero"
    assert support.passes({**base, "D": None}, 0.01)[1] == "D not above zero"
    assert support.passes(base, 0.051)[1] == "p above 0.05 after Holm"
    assert support.passes(base, None)[1] == "p above 0.05 after Holm"
    assert support.passes({**base, "mean_supported": 0.0}, 0.01)[1] == "supported trades lose"


def _frame(days, close_at_decision, prev_high=101.0, decided=45):
    """Sessions of flat prices; session 1's close at the decision stamp is `close_at_decision`."""
    n = len(days)
    arr = np.full((n, E.N_BARS), 100.0)
    high = np.full((n, E.N_BARS), prev_high)
    arr[1, decided] = close_at_decision
    return E.Frame(days=days, O=arr.copy(), H=high, L=arr - 1.0, C=arr)


def test_support_counts_the_instruments_beyond_their_own_level_at_the_decision_minute():
    days = ["2026-01-05", "2026-01-06", "2026-01-07"]
    frames = {
        "BANKNIFTY": _frame(days, 105.0),  # above the previous day's high of 101
        "NIFTYIT": _frame(days, 102.0),  # above it too
        "RELIANCE": _frame(days, 100.0),  # not beyond it
    }
    rows = [
        {"day": "2026-01-06", "side": "up", "entry": "10:01", "net": 1.0},
        {"day": "2026-01-06", "side": "down", "entry": "10:01", "net": 2.0},
        {"day": "2026-01-09", "side": "up", "entry": "10:01", "net": 3.0},  # not in any frame
    ]
    marked = support.mark(rows, "prevday", frames)
    assert marked[0]["support"] == 2 and not marked[0]["excluded"]
    assert marked[1]["support"] == 0  # none is below its previous day's low
    assert marked[2]["excluded"] and marked[2]["support"] is None
    assert support.passes({"supported": 2, "unsupported": 1, "D": 1.0, "mean_supported": 1.0,
                           "share_supported": 0.67}, 0.01)[0] is False  # too few trades  # fmt: skip


# --- BL-153's confirmation reuse ----------------------------------------------------------------


def _ledger_with(monkeypatch, rows, result):
    monkeypatch.setattr(store, "ledger", lambda root: rows)
    monkeypatch.setattr(store, "read_result", lambda root, test_id: result)


def test_a_looked_at_confirmation_period_is_reused_with_its_mode_never_run_again(monkeypatch):
    h = from_dict(dict(breakout_specs.grid())[FIRST]).spec_hash
    rows = [{"id": "t1", "spec_hash": h, "periods": ["confirmation"], "mode": "exploratory"}]
    result = {"periods": {"confirmation": {"rows": [{"day": "2024-01-02", "net": 5.0}]}}}
    _ledger_with(monkeypatch, rows, result)
    got, how = support.confirmation_rows(Path("/nonexistent"), FIRST)
    assert got == [{"day": "2024-01-02", "net": 5.0}] and how == "reused t1 (exploratory)"
    _ledger_with(monkeypatch, rows, None)  # the result file is gone
    with pytest.raises(SystemExit, match="not running a second look"):
        support.confirmation_rows(Path("/nonexistent"), FIRST)
    _ledger_with(monkeypatch, rows, {"periods": {"learning": {}}})  # a result without the period
    with pytest.raises(SystemExit, match="not running a second look"):
        support.confirmation_rows(Path("/nonexistent"), FIRST)


def test_support_frames_load_only_the_registered_window(monkeypatch, tmp_path):
    from datetime import date, timedelta

    asked = {}

    def fake_days(root, asset, symbol):
        return [date(2015, 1, 1) + timedelta(days=k) for k in range(5000)]

    def fake_grid(root, symbol, end, sessions, asset):
        asked.update(end=end, sessions=sessions, asset=asset)
        n = 2
        a = np.full((n, E.N_BARS), 1.0)
        return SimpleNamespace(days=["a", "b"], O=a, H=a, L=a, C=a)

    from trading_data import lake

    monkeypatch.setattr(lake, "available_days", fake_days)
    monkeypatch.setattr(support.T, "load_grid", fake_grid)
    frame = support.load_frame(tmp_path, "RELIANCE", "stock", date(2022, 1, 3), date(2022, 6, 30))
    assert frame.n == 2 and asked["asset"] == "stock" and asked["end"] == date(2022, 6, 30)
    # from 15 days before the first registered day, not from 2015
    assert (
        asked["sessions"] == (date(2022, 6, 30) - (date(2022, 1, 3) - timedelta(days=15))).days + 1
    )
    assert math.isfinite(asked["sessions"]) and asked["sessions"] < 250
