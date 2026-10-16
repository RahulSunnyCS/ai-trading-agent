"""The T1 forward shadow: shadow variant names, their own results folder and journal, Adaptive only,
and the read-out against the live list. tmp_path only: no lake, the live store is never touched."""

from __future__ import annotations

from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo

import numpy as np
import pytest

from option_backtesting.rotation import journal, pick, shadow_universe, store, update, variants
from option_backtesting.rotation.pick import record
from option_backtesting.rotation.score import family_index

from .test_rotation import ATTRS, NAMES, _collect, _weekdays

IST = ZoneInfo("Asia/Kolkata")
SHADOW = ["N_wide-t1s4_0917", "S_p285-t1s22_1017", "N_ditm1-t1s36_0947", "N_buy-t1s47_0932"]


def test_shadow_names_parse_to_their_base_family_and_core_names_are_unchanged():
    assert variants.shadow_of("S_p285-t1s22_1017") == "t1"
    assert variants.shadow_of("S_p250_1002") is None
    assert variants.base_family("N_wide-t1s4_0917") == "wide"
    assert variants.is_wide("S_p285-t1s22_1017") and variants.is_wide("N_p80_0917")
    assert variants.is_dir("N_ditm1-t1s36_0947") and not variants.is_wide("N_ditm1-t1s36_0947")
    assert variants.is_buy("N_buy-t1s47_0932")
    assert variants.strategy_path("N_wide-t1s4_0917").parent.name == "rotation_t1"
    assert variants.strategy_path("N_wide_0917").parent.name == "rotation"
    with pytest.raises(ValueError, match="unknown shadow"):
        variants.shadow_of("N_wide-zz9_0917")


def test_a_shadow_buy_pools_with_core_buy_in_the_family_band_index():
    idx = family_index(["N_buy_0932", "N_buy-t1s47_0932", "N_wide_0917", "N_wide-t1s4_0917"])
    assert idx[0] == idx[1] and idx[2] == idx[3] and idx[0] != idx[2]


def test_shadow_results_live_in_their_own_folder_never_the_live_one(tmp_path):
    store.append_result("N_wide-t1s4_0917", {"day": "2026-10-05", "net": 10.0}, tmp_path)
    store.append_result("N_wide_0917", {"day": "2026-10-05", "net": 20.0}, tmp_path)
    live_files = sorted(p.name for p in store.results_dir(tmp_path).glob("*.csv"))
    assert live_files == ["N_wide_0917.csv"]
    assert (store.shadow_dir("t1", tmp_path) / "results" / "N_wide-t1s4_0917.csv").exists()
    assert store.read_net("N_wide-t1s4_0917", tmp_path) == {date(2026, 10, 5): 10.0}
    assert store.journal_path(tmp_path, "t1") != store.journal_path(tmp_path)


def _seed(root, days, seed=5):
    rng = np.random.default_rng(seed)
    for d in days:
        for name in NAMES + SHADOW:
            g = float(rng.normal(0, 1500))
            store.append_result(name, {"day": d.isoformat(), "net": g, "gross": g}, root)
        store.append_day({"day": d.isoformat(), "weekday": d.strftime("%a"), **ATTRS}, root)
        _collect(root, d)


@pytest.fixture
def shadow_seeded(tmp_path, monkeypatch):
    days = _weekdays(date(2026, 6, 1), 70)
    _seed(tmp_path, days)
    monkeypatch.setattr(pick, "variant_names", lambda: NAMES)
    monkeypatch.setattr(pick, "shadow_names", lambda u: SHADOW)
    monkeypatch.setattr(pick, "code_commit", lambda: "test")
    monkeypatch.setattr(
        pick, "listed_dte_labels", lambda d: ({"dte_n": "1", "dte_s": "2"}, "master")
    )
    target = days[-1] + timedelta(days=1)
    while target.weekday() >= 5:
        target += timedelta(days=1)
    return tmp_path, target


def _at(day, hh, mm):
    return lambda: datetime(day.year, day.month, day.day, hh, mm, tzinfo=IST)


def test_a_shadow_entry_goes_to_its_own_journal_with_adaptive_only(shadow_seeded):
    root, target = shadow_seeded
    r = record(target, root, vix_open=14.2, now_fn=_at(target, 9, 16), universe="t1")
    e = r.entry
    assert e["shadow"] == "t1" and list(e["lists"]) == ["C"]
    assert e["universe"]["variants"] == len(NAMES) + len(SHADOW)
    assert not store.journal_path(root).exists()  # the live journal is untouched
    assert journal.verify(store.journal_path(root, "t1")) == []
    assert r.text.startswith("SHADOW T1 picks (not traded)")
    # the live list still records on its own, the same morning, unaffected
    live = record(target, root, vix_open=14.2, now_fn=_at(target, 9, 16))
    assert "shadow" not in live.entry and set(live.entry["lists"]) == {"A", "B", "C", "REF"}


def test_the_readout_compares_the_shadow_with_the_live_adaptive_on_shared_days(tmp_path):
    days = [date(2026, 10, 12), date(2026, 10, 13)]
    vals = {"N_wide_0917": [100, -50], "N_dir_0947": [300, 200], "S_wide_0917": [0, 100],
            "N_wide-t1s4_0917": [400, 100]}  # fmt: skip
    for name, v in vals.items():
        for d, g in zip(days, v, strict=True):
            store.append_result(name, {"day": d.isoformat(), "net": g, "gross": g}, tmp_path)
    live_c = {"core": ["N_wide_0917", "N_dir_0947", "S_wide_0917"], "buy": []}
    shadow_c = {"core": ["N_wide-t1s4_0917", "N_dir_0947", "S_wide_0917"], "buy": []}
    for d in days:
        base = {"day": d.isoformat(), "before_first_entry": True}
        journal.append(store.journal_path(tmp_path), {**base, "lists": {"C": live_c}})
        journal.append(store.journal_path(tmp_path, "t1"), {**base, "lists": {"C": shadow_c}})
    r = shadow_universe.build("t1", tmp_path)
    assert r["n"] == 2 and r["pending"] == []
    # live: (100+300+0)/3, (-50+200+100)/3; shadow: (400+300+0)/3, (100+200+100)/3
    assert r["live_per_lot_day"] == pytest.approx((400 / 3 + 250 / 3) / 2)
    assert r["shadow_per_lot_day"] == pytest.approx((700 / 3 + 400 / 3) / 2)
    assert r["diff"] == pytest.approx(r["shadow_per_lot_day"] - r["live_per_lot_day"])
    assert r["passes"] is False  # 2 of 60 days: never judged early
    assert "2 of 60 forward days" in shadow_universe.render(r)


def test_backfill_covers_exactly_the_core_days_the_shadow_lacks(tmp_path, monkeypatch):
    monkeypatch.setattr(update, "variant_names", lambda: ["N_wide_0917"])
    for d in (date(2026, 10, 5), date(2026, 10, 6), date(2026, 10, 7)):
        store.append_result("N_wide_0917", {"day": d.isoformat(), "net": 1.0}, tmp_path)
    store.append_result("N_wide-t1s4_0917", {"day": "2026-10-06", "net": 1.0}, tmp_path)
    assert update.backfill_days(["N_wide-t1s4_0917"], tmp_path) == [date(2026, 10, 5), date(2026, 10, 7)]
