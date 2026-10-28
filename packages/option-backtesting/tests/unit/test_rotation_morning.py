"""BL-172 Phase 4: the 09:16 pick changes only what starts after 09:17."""

from datetime import date

import numpy as np

from option_backtesting.rotation.algtst_export import DayPicks
from option_backtesting.rotation.morning import choose, is_early, select_keeping, unchanged

DAY = date(2026, 10, 29)

NAMES = [
    "S_ditm1_0917",  # dir, 09:17
    "N_ditm1_0947",  # dir
    "N_dir_0932",  # dir
    "S_p320_1302",  # wide
    "S_p250_1302",  # wide
    "N_p80_1202",  # wide
    "N_wide_0917",  # wide, 09:17
    "N_buy_1117",  # buy
    "S_buy_0917",  # buy, 09:17
]


def comp(**scores: float) -> np.ndarray:
    return np.array([scores.get(n, 0.0) for n in NAMES])


def picks(core, buy=(), source="recorded") -> DayPicks:
    return DayPicks(DAY, "t1", source, list(core), list(buy))


def test_early_is_09_17_and_before():
    assert is_early("S_ditm1_0917")
    assert not is_early("N_dir_0932")


def test_a_later_change_is_made():
    evening = picks(["N_ditm1_0947", "S_p320_1302", "S_p250_1302"], source="preview")
    scores = comp(N_dir_0932=9, S_p320_1302=8, S_p250_1302=7, N_ditm1_0947=1)
    recorded = picks(["N_dir_0932", "S_p320_1302", "S_p250_1302"])
    m = choose(evening, recorded, scores, NAMES)
    assert m.picks.core == ["N_dir_0932", "S_p320_1302", "S_p250_1302"]
    assert m.added == ["N_dir_0932"] and m.removed == ["N_ditm1_0947"]
    assert m.changed and not m.not_made


def test_a_new_0917_pick_is_not_made_and_the_evening_list_keeps_its_place():
    evening = picks(["N_ditm1_0947", "S_p320_1302", "S_p250_1302"], source="preview")
    scores = comp(S_ditm1_0917=9, S_p320_1302=8, S_p250_1302=7, N_ditm1_0947=5)
    recorded = picks(["S_ditm1_0917", "S_p320_1302", "S_p250_1302"])
    m = choose(evening, recorded, scores, NAMES)
    assert m.picks.core == ["S_p320_1302", "S_p250_1302", "N_ditm1_0947"]
    assert not m.changed
    assert m.not_made == ["S_ditm1_0917"]


def test_the_evening_0917_stays_and_the_rest_is_chosen_again_by_score():
    # Evening: 09:17 Dir + two Widesl. At 09:16 the Dir would go for a later Dir and a Widesl
    # changes: the 09:17 Dir keeps running, so the later Dir cannot also come in (2 W + 1 D).
    evening = picks(["S_ditm1_0917", "S_p320_1302", "S_p250_1302"], source="preview")
    scores = comp(N_dir_0932=9, N_p80_1202=8, S_p320_1302=7, S_p250_1302=6, S_ditm1_0917=1)
    recorded = picks(["N_dir_0932", "N_p80_1202", "S_p320_1302"])
    m = choose(evening, recorded, scores, NAMES)
    assert "S_ditm1_0917" in m.picks.core
    wide = [n for n in m.picks.core if "_p" in n or "_wide_" in n]
    assert len(wide) >= 2  # the Widesl minimum holds with the kept Dir
    assert set(m.picks.core) == {"S_ditm1_0917", "N_p80_1202", "S_p320_1302"}
    assert m.added == ["N_p80_1202"] and m.removed == ["S_p250_1302"]


def test_select_keeping_never_drops_the_kept_dir_for_the_widesl_minimum():
    scores = comp(N_dir_0932=9, N_ditm1_0947=8, S_ditm1_0917=1, S_p320_1302=0.5)
    core = select_keeping(scores, NAMES, ["S_ditm1_0917"], [True] * len(NAMES))
    assert "S_ditm1_0917" in core
    assert sum(1 for n in core if n.split("_")[1] in ("ditm1", "dir")) <= 1


def test_the_add_on():
    evening = picks(["N_ditm1_0947", "S_p320_1302", "S_p250_1302"], ["S_buy_0917"], "preview")
    scores = comp(N_ditm1_0947=9, S_p320_1302=8, S_p250_1302=7, N_buy_1117=20)
    recorded = picks(["N_ditm1_0947", "S_p320_1302", "S_p250_1302"], ["N_buy_1117"])
    # the evening's 09:17 add-on is running: it stays, the later one is not added
    assert choose(evening, recorded, scores, NAMES).picks.buy == ["S_buy_0917"]
    # no early add-on in the evening: the 09:16 pick's add-on follows
    evening2 = picks(evening.core, [], "preview")
    assert choose(evening2, recorded, scores, NAMES).picks.buy == ["N_buy_1117"]
    # a new 09:17 add-on at 09:16 is too late
    recorded3 = picks(recorded.core, ["S_buy_0917"])
    assert choose(evening2, recorded3, scores, NAMES).picks.buy == []


def test_expiry_rule_keeps_the_pool_on_the_index():
    evening = picks(["S_ditm1_0917", "S_p320_1302", "S_p250_1302"], source="preview")
    scores = comp(N_p80_1202=99, N_dir_0932=98, S_p320_1302=7, S_p250_1302=6, S_ditm1_0917=1)
    recorded = picks(["S_ditm1_0917", "S_p320_1302", "S_p250_1302"])
    m = choose(evening, recorded, scores, NAMES, rule_index="SENSEX")
    assert all(n.startswith("S_") for n in m.picks.core)


def test_unchanged_runs_the_evening_list():
    evening = picks(["N_ditm1_0947", "S_p320_1302", "S_p250_1302"], source="preview")
    m = unchanged(evening, picks(["N_dir_0932"]), "why")
    assert m.picks.core == evening.core and m.picks.source == "recorded" and not m.changed
