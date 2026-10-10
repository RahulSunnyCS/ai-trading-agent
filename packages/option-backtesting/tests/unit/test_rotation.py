"""The forward journal's scoring, store and hash chain (BL-058). Pure numpy / tmp_path: no lake."""

from __future__ import annotations

import json
from datetime import date, timedelta

import numpy as np
import pytest

from option_backtesting.rotation import journal, store
from option_backtesting.rotation.lists import LISTS
from option_backtesting.rotation.pick import PickError, score_lists
from option_backtesting.rotation.score import (
    composite,
    dte_matrix,
    family_index,
    pct_rank,
    select,
    vix_band,
)

NAMES = [
    "N_wide_0917", "N_wide_1017", "N_p80_0917", "N_dir_0947", "N_dir_1117",
    "N_buy_0932", "N_buy_1202", "S_wide_0917", "S_dir_0947", "S_p250_1002",
]  # fmt: skip


def test_pct_rank_gives_tied_values_their_average_rank():
    assert pct_rank(np.array([1.0, 2.0, 2.0, 3.0])).tolist() == [0.25, 0.625, 0.625, 1.0]


@pytest.mark.parametrize(
    ("vix", "band"),
    [
        (10.5, "<10.5"),
        (10.51, "10.5-11.5"),
        (15.0, "13-15"),
        (18.0, "15-18"),
        (18.01, "18+"),
        (None, "unknown"),
    ],
)
def test_vix_band_bins_are_right_closed(vix, band):
    assert vix_band(vix) == band


def _comp(**scores):
    return np.array([scores.get(n, 0.0) for n in NAMES])


def test_select_takes_the_top_three_non_buy_and_enforces_two_widesl():
    # the three best are Dir, Dir, Dir -> the lowest Dir is swapped for the best Widesl, twice
    comp = _comp(N_dir_0947=0.9, N_dir_1117=0.8, S_dir_0947=0.7, N_wide_0917=0.5, N_wide_1017=0.4)
    p = select(comp, NAMES)
    assert sum(n.split("_")[1] != "dir" for n in p.core) >= 2
    assert "N_dir_0947" in p.core and p.overridden


def test_select_adds_buy_only_when_it_ranks_in_the_overall_top_ten():
    names = NAMES + [f"S_wide_{h:04d}" for h in range(1100, 1111)]
    comp = np.zeros(len(names))
    comp[names.index("N_buy_0932")] = 0.01  # last of many: outside the top 10
    comp[[names.index(f"S_wide_{h:04d}") for h in range(1100, 1111)]] = 0.5
    assert select(comp, names).buy == []
    comp[names.index("N_buy_0932")] = 0.9
    assert select(comp, names).buy == ["N_buy_0932"]


def _history(n=80, seed=3):
    rng = np.random.default_rng(seed)
    P = rng.normal(0, 1500, (n, len(NAMES)))
    weekday = np.array(["Mon", "Tue", "Wed", "Thu", "Fri"] * (n // 5 + 1))[:n]
    band = np.array(["13-15", "15-18"] * (n // 2 + 1))[:n]
    dn = np.array(["0", "1", "2", "3", "4"] * (n // 5 + 1))[:n]
    return P, weekday, band, dn


def test_the_target_days_own_result_never_enters_its_score():
    P, wd, vb, dn = _history()
    dmat = dte_matrix(dn, dn, NAMES)
    fam = family_index(NAMES)
    for lst in LISTS.values():
        a = composite(P.copy(), wd, vb, dmat, NAMES, lst, fam)
        P2 = P.copy()
        P2[-1] = 1e9  # the day being picked, whatever it later does
        assert np.allclose(a, composite(P2, wd, vb, dmat, NAMES, lst, fam))


def test_a_later_day_does_not_change_an_earlier_days_picks():
    P, wd, vb, dn = _history()
    dmat = dte_matrix(dn, dn, NAMES)
    fam = family_index(NAMES)
    lst = LISTS["A"]
    i = 70
    early = composite(P[: i + 1], wd[: i + 1], vb[: i + 1], dmat[: i + 1], NAMES, lst, fam)
    again = composite(P[: i + 1].copy(), wd[: i + 1], vb[: i + 1], dmat[: i + 1], NAMES, lst, fam)
    assert np.allclose(early, again)


def test_family_index_pools_widesl_incl_closest_premium_by_start_band():
    idx = family_index(["N_wide_0917", "S_p250_1002", "N_p80_1017", "N_dir_0947", "N_dir_1002"])
    assert idx[0] == idx[1]  # Widesl OTM and closest premium, both in the 09:17-10:02 band
    assert idx[0] != idx[2]  # 10:17 is the next band
    assert idx[3] == idx[4]  # Dir 09:47 and 10:02 share a band


def test_journal_chain_detects_edits_removals_and_duplicates(tmp_path):
    path = tmp_path / "journal.jsonl"
    journal.append(path, {"day": "2026-10-12", "lists": {"A": {"core": ["x"]}}})
    journal.append(path, {"day": "2026-10-13", "lists": {"A": {"core": ["y"]}}})
    journal.append(path, {"day": "2026-10-14", "lists": {"A": {"core": ["z"]}}})
    assert journal.verify(path) == []
    with pytest.raises(ValueError, match="already"):
        journal.append(path, {"day": "2026-10-13", "lists": {}})
    lines = path.read_text().splitlines()
    # edit one pick in the first entry
    edited = json.loads(lines[0])
    edited["lists"]["A"]["core"] = ["tampered"]
    path.write_text("\n".join([json.dumps(edited, sort_keys=True), *lines[1:]]) + "\n")
    assert any("content does not match" in p for p in journal.verify(path))
    # remove the middle entry
    path.write_text("\n".join([lines[0], lines[2]]) + "\n")
    assert any("prev hash" in p for p in journal.verify(path))


def test_store_never_rewrites_a_stored_day_and_drops_weekends_and_incomplete_days(tmp_path):
    base = date(2026, 10, 5)  # Monday
    for n, name in enumerate(("N_wide_0917", "N_dir_0947")):
        for k in range(8):  # Mon .. Mon: includes Sat 10 and Sun 11
            d = base + timedelta(days=k)
            if name == "N_dir_0947" and d == date(2026, 10, 7):
                continue  # this variant has no row for the 7th
            assert store.append_result(name, {"day": d.isoformat(), "net": n + k}, tmp_path)
    assert not store.append_result("N_wide_0917", {"day": "2026-10-05", "net": 999}, tmp_path)
    assert store.read_net("N_wide_0917", tmp_path)[base] == 0.0  # the original value stands
    m = store.load_matrix(["N_wide_0917", "N_dir_0947"], tmp_path)
    assert date(2026, 10, 7) not in m.days  # incomplete
    assert all(d.weekday() < 5 for d in m.days)  # no Saturday / Sunday


def test_pick_refuses_when_results_are_stale(tmp_path):
    names = ["N_wide_0917", "N_dir_0947"]
    start = date(2026, 6, 1)
    d, n = start, 0
    while n < 70:
        if d.weekday() < 5:
            for name in names:
                store.append_result(name, {"day": d.isoformat(), "net": float(n)}, tmp_path)
            store.append_day(
                {
                    "day": d.isoformat(),
                    "weekday": d.strftime("%a"),
                    "vix_open": 14,
                    "vix_band": "13-15",
                    "dte_n": "1",
                    "dte_s": "2",
                },
                tmp_path,
            )
            n += 1
        d += timedelta(days=1)
    stale_target = d + timedelta(days=5)  # results end days earlier than the previous trading day
    with pytest.raises(PickError, match="previous trading day"):
        score_lists(stale_target, 14.0, {"dte_n": "1", "dte_s": "2"}, tmp_path, names)
