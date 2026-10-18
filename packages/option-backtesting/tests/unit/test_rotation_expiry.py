"""BL-122, the expiring-index rule: on a day when exactly one index expires, Adaptive (list C) takes
only that index's strategies, from Mon 2026-10-19 (`rotation/expiry.py`).

The rule must be a FILTER of the unrestricted ranking, applied identically by everything that
records or re-derives a pick (the 09:16 job, the T1 track, the daily log's re-score, "Why this
pick?", the rank correlation, the evening "Tomorrow" section), and must leave every day before the
effective date exactly as it was. tmp_path stores only; the real TRADING_DATA_ROOT is never read.
"""

from __future__ import annotations

from datetime import date, datetime, timedelta

import numpy as np
import pytest

from option_backtesting.rotation import attrs as attrs_mod
from option_backtesting.rotation import (
    daylog,
    expiry,
    journal,
    messages,
    pick,
    rankic,
    result,
    store,
)
from option_backtesting.rotation import explain as ex
from option_backtesting.rotation import tomorrow as tomorrow_mod
from option_backtesting.rotation import variants as variants_mod
from option_backtesting.rotation.lists import LISTS, MIN_WIDE_N
from option_backtesting.rotation.score import runners_up, select
from option_backtesting.rotation.variants import is_buy, is_wide, underlying_of

from . import rotation_synth as syn

PRE = date(2026, 10, 16)  # Friday: the last session before the rule
MONDAY = date(2026, 10, 19)  # the first session the rule applies to
T1 = ["N_p150-t1s11_0917", "S_p285-t1s22_1017", "N_wide-t1s4_1217", "S_dir-t1s5_1417"]


@pytest.fixture(autouse=True)
def _no_env(monkeypatch):
    """The switch is read at call time: no test inherits one from the shell."""
    monkeypatch.delenv(expiry.ENV, raising=False)


# --- which index expires ----------------------------------------------------------------------


@pytest.mark.parametrize(
    ("dte_n", "dte_s", "want"),
    [
        ("0", "2", "NIFTY"),
        ("3", "0", "SENSEX"),
        ("0", "0", None),  # both expire: unrestricted
        ("1", "4", None),  # neither
        ("7+", "0", "SENSEX"),
        ("unknown", "0", None),  # NIFTY might expire too: cannot show only one does
        ("0", "unknown", None),
        ("unknown", "unknown", None),
        (None, "0", None),
        (0, 2, "NIFTY"),  # a number is read as its label
    ],
)
def test_expiring_index_is_exactly_one_index_at_label_zero(dte_n, dte_s, want):
    assert expiry.expiring_index(dte_n, dte_s) == want


def test_the_rule_starts_on_monday_19_october_2026():
    assert expiry.EXPIRY_ONLY_FROM == MONDAY
    nifty = {"dte_n": "0", "dte_s": "2"}
    assert expiry.rule_index(PRE, nifty) is None
    assert expiry.rule_index(MONDAY, nifty) == "NIFTY"
    assert expiry.rule_index(MONDAY + timedelta(days=2), {"dte_n": "2", "dte_s": "0"}) == "SENSEX"
    assert expiry.rule_index(MONDAY, {"dte_n": "0", "dte_s": "0"}) is None
    assert expiry.rule_index(MONDAY, {"dte_n": "1", "dte_s": "2"}) is None


def test_the_switch_moves_the_start_or_turns_the_rule_off_and_a_bad_value_fails(monkeypatch):
    nifty = {"dte_n": "0", "dte_s": "2"}
    monkeypatch.setenv(expiry.ENV, "off")
    assert expiry.rule_index(MONDAY, nifty) is None
    monkeypatch.setenv(expiry.ENV, "OFF")
    assert expiry.rule_index(MONDAY, nifty) is None
    monkeypatch.setenv(expiry.ENV, "2026-10-16")
    assert expiry.rule_index(PRE, nifty) == "NIFTY"
    monkeypatch.setenv(expiry.ENV, "2026-10-26")
    assert expiry.rule_index(MONDAY, nifty) is None
    monkeypatch.setenv(expiry.ENV, "19-10-2026")
    with pytest.raises(expiry.ExpiryRuleError, match="neither YYYY-MM-DD nor 'off'"):
        expiry.rule_index(MONDAY, nifty)
    monkeypatch.setenv(expiry.ENV, "")  # empty = the registered date
    assert expiry.rule_index(MONDAY, nifty) == "NIFTY"


def test_a_monkeypatched_start_date_is_read_at_call_time(monkeypatch):
    monkeypatch.setattr(expiry, "EXPIRY_ONLY_FROM", date(2026, 1, 1))
    assert expiry.rule_index(PRE, {"dte_n": "0", "dte_s": "2"}) == "NIFTY"


# --- the filter -------------------------------------------------------------------------------

NAMES = [
    "N_wide_0917",
    "N_wide_1017",
    "N_p80_0917",
    "N_dir_0917",
    "N_ditm1_0917",
    "N_buy_0932",
    "S_wide_0917",
    "S_p250_1017",
    "S_dir_0917",
    "S_ditm1_1017",
    "S_buy_0932",
]


def _comp(order: list[str], names: list[str] = NAMES) -> np.ndarray:
    """A composite that ranks `order` first, in that order, and everything else below."""
    score = {n: 1.0 - 0.01 * i for i, n in enumerate(order)}
    rest = [n for n in names if n not in score]
    score.update({n: 0.5 - 0.01 * i for i, n in enumerate(rest)})
    return np.array([score[n] for n in names])


def test_a_basket_already_from_the_expiring_index_is_unchanged():
    comp = _comp(["N_wide_0917", "N_dir_0917", "N_wide_1017", "N_buy_0932", "S_wide_0917"])
    picks = select(comp, NAMES)
    assert all(underlying_of(n) == "NIFTY" for n in [*picks.core, *picks.buy])
    assert expiry.filter_picks(comp, NAMES, picks, "NIFTY") == picks


def test_a_basket_already_from_the_index_after_a_widesl_swap_is_unchanged():
    # unconstrained top 3 holds a SENSEX Dir that the Widesl minimum swaps out anyway
    comp = _comp(["N_dir_0917", "S_dir_0917", "N_ditm1_0917", "N_wide_0917", "N_wide_1017"])
    picks = select(comp, NAMES)
    assert picks.overridden and picks.core == ["N_dir_0917", "N_wide_0917", "N_wide_1017"]
    assert expiry.filter_picks(comp, NAMES, picks, "NIFTY").core == picks.core


def test_a_non_expiring_core_pick_is_replaced_by_the_next_best_of_the_expiring_index():
    comp = _comp(["S_wide_0917", "N_wide_0917", "N_dir_0917", "N_wide_1017", "S_p250_1017"])
    picks = select(comp, NAMES)
    assert picks.core == ["S_wide_0917", "N_wide_0917", "N_dir_0917"]
    got = expiry.filter_picks(comp, NAMES, picks, "NIFTY")
    assert got.core == ["N_wide_0917", "N_dir_0917", "N_wide_1017"]
    # a filter of the same ranking: every composite is the unrestricted one, never recomputed
    for n, c in got.composite.items():
        assert c == comp[NAMES.index(n)]


def test_the_widesl_minimum_holds_inside_the_expiring_index():
    comp = _comp(["S_wide_0917", "N_dir_0917", "N_ditm1_0917", "S_p250_1017", "N_wide_1017"])
    picks = select(comp, NAMES)
    got = expiry.filter_picks(comp, NAMES, picks, "NIFTY")
    assert sum(is_wide(n) for n in got.core) >= MIN_WIDE_N
    assert got.overridden
    # the best NIFTY Dir stays; the weaker Dir gives way to the best two NIFTY Widesl
    assert got.core == ["N_dir_0917", "N_wide_1017", "N_wide_0917"]
    assert all(underlying_of(n) == "NIFTY" for n in got.core)


def test_a_non_expiring_buy_is_dropped_and_never_replaced_an_expiring_one_is_kept():
    comp = _comp(["S_buy_0932", "N_wide_0917", "N_wide_1017", "N_dir_0917", "N_buy_0932"])
    picks = select(comp, NAMES)
    assert picks.buy == ["S_buy_0932"]
    nifty = expiry.filter_picks(comp, NAMES, picks, "NIFTY")
    assert nifty.buy == []  # N_buy_0932 is in the top 10 too, but nothing replaces the Buy
    assert "S_buy_0932" not in nifty.composite
    sensex = expiry.filter_picks(comp, NAMES, picks, "SENSEX")
    assert sensex.buy == ["S_buy_0932"]
    assert sensex.composite["S_buy_0932"] == comp[NAMES.index("S_buy_0932")]
    assert all(underlying_of(n) == "SENSEX" for n in sensex.core)


def test_t1_track_names_are_filtered_by_their_index():
    names = NAMES + T1
    assert [underlying_of(n) for n in T1] == ["NIFTY", "SENSEX", "NIFTY", "SENSEX"]
    comp = _comp(["S_p285-t1s22_1017", "N_p150-t1s11_0917", "S_dir-t1s5_1417", "N_dir_0917"], names)
    picks = select(comp, names)
    got = expiry.filter_picks(comp, names, picks, "NIFTY")
    assert got.core[:2] == ["N_p150-t1s11_0917", "N_dir_0917"]
    assert all(underlying_of(n) == "NIFTY" for n in got.core)
    got_s = expiry.filter_picks(comp, names, picks, "SENSEX")
    assert got_s.core[:2] == ["S_p285-t1s22_1017", "S_dir-t1s5_1417"]


def test_the_runners_up_on_a_rule_day_come_from_the_expiring_index():
    comp = _comp(["S_wide_0917", "S_dir_0917", "N_wide_0917", "N_dir_0917", "N_wide_1017"])
    picks = expiry.filter_picks(comp, NAMES, select(comp, NAMES), "NIFTY")
    options = expiry.filtered_runners_up(comp, NAMES, picks, "NIFTY")
    assert options == {"wide": "N_p80_0917", "dir": "N_ditm1_0917"}
    assert runners_up(comp, NAMES, picks)["wide"] == "S_wide_0917"  # what it would say unfiltered


def test_an_unknown_index_or_an_index_with_no_variant_is_refused():
    comp = _comp([])
    picks = select(comp, NAMES)
    with pytest.raises(expiry.ExpiryRuleError, match="unknown index"):
        expiry.filter_picks(comp, NAMES, picks, "BANKNIFTY")
    only_n = [n for n in NAMES if n.startswith("N_")]
    with pytest.raises(expiry.ExpiryRuleError, match="no SENSEX variant"):
        expiry.filter_picks(
            comp[: len(only_n)], only_n, select(comp[: len(only_n)], only_n), "SENSEX"
        )


# --- score_history ----------------------------------------------------------------------------


def _history(n: int = 80, seed: int = 3) -> pick.History:
    rng = np.random.default_rng(seed)
    names = syn.NAMES
    days = syn.weekdays(date(2026, 5, 4), n)
    attrs = [syn.attrs_for(d) for d in days]
    return pick.History(
        days,
        names,
        np.round(rng.normal(200, 1500, (n, len(names))), 2),
        [a["weekday"] for a in attrs],
        [a["vix_band"] for a in attrs],
        [a["dte_n"] for a in attrs],
        [a["dte_s"] for a in attrs],
        "",
    )


def _old_score_history(hist, day, vix, dte) -> dict:
    """The output `score_history` gave before BL-122, built straight from the ranking."""
    return {
        key: {
            "core": p.core,
            "buy": p.buy,
            "overridden": p.overridden,
            "composite": {k: round(v, 4) for k, v in p.composite.items()},
        }
        for key, _cols, _comp, p in pick._rank(hist, day, vix, dte)
    }


def test_score_history_without_the_rule_is_what_it_always_was():
    hist = _history()
    day = date(2026, 8, 24)
    for dte in (
        {"dte_n": "0", "dte_s": "2"},
        {"dte_n": "3", "dte_s": "0"},
        {"dte_n": "1", "dte_s": "2"},
    ):
        for vix in (11.0, 14.2, 19.5):
            got = pick.score_history(hist, day, vix, dte)
            assert got == _old_score_history(hist, day, vix, dte)
            assert got == pick.score_history(hist, day, vix, dte, expiry_only=None)


def test_score_history_with_the_rule_filters_adaptive_only_and_keeps_the_unfiltered_picks():
    hist = _history()
    day = date(2026, 8, 24)
    changed = 0
    for index, dte in (
        ("NIFTY", {"dte_n": "0", "dte_s": "2"}),
        ("SENSEX", {"dte_n": "3", "dte_s": "0"}),
    ):
        for vix in (11.0, 12.5, 14.2, 16.0, 19.5):
            plain = pick.score_history(hist, day, vix, dte)
            ruled = pick.score_history(hist, day, vix, dte, expiry_only=index)
            for key in ("A", "B", "REF"):
                assert ruled[key] == plain[key]
            c = ruled["C"]
            assert c["expiry_only"] == index
            assert c["unfiltered"] == {"core": plain["C"]["core"], "buy": plain["C"]["buy"]}
            assert all(underlying_of(n) == index for n in [*c["core"], *c["buy"]])
            assert sum(is_wide(n) for n in c["core"]) >= MIN_WIDE_N
            assert set(c["composite"]) == {*c["core"], *c["buy"]}
            assert all(not is_buy(n) for n in c["core"])
            changed += c["core"] != plain["C"]["core"]
    assert changed  # the data does exercise a basket the rule changes


def test_score_history_refuses_an_index_it_does_not_know():
    with pytest.raises(ValueError, match="expiry_only"):
        pick.score_history(_history(), date(2026, 8, 24), 14.0, {"dte_n": "0", "dte_s": "2"}, "X")


# --- through the real pick.record on a synthetic store ----------------------------------------


def _store_to(root, last: date, names=None, n: int = 70) -> list[date]:
    days = []
    d = last
    while len(days) < n:
        if d.weekday() < 5:
            days.insert(0, d)
        d -= timedelta(days=1)
    syn.build_store(root, days, names)
    return days


def _labels(index: str) -> dict[str, str]:
    return {"dte_n": "0", "dte_s": "2"} if index == "NIFTY" else {"dte_n": "2", "dte_s": "0"}


def _changing_index(root, day: date, vix: float, names=None) -> str:
    """An expiring index whose rule changes the day's Adaptive basket on this store (the test
    must exercise a real replacement, not a basket that already is from one index)."""
    hist = pick.load_history(day, root, names or syn.NAMES)
    for index in ("NIFTY", "SENSEX"):
        plain = pick.score_history(hist, day, vix, _labels(index))["C"]
        if any(underlying_of(n) != index for n in plain["core"]):
            return index
    raise AssertionError("no index whose rule changes the basket: change the seed")


@pytest.fixture
def rule_store(tmp_path):
    """Results to Thu 15 Oct; Fri 16 Oct recorded as a NIFTY expiry day BEFORE the rule; then the
    16th's results; Monday 19 Oct is ready to record."""
    root = tmp_path / "TradingData"
    _store_to(root, date(2026, 10, 15))
    pre = syn.record_entry(root, PRE, dte={"dte_n": "0", "dte_s": "2"}, vix_open=14.1)
    syn.build_store(root, [PRE])
    return root, pre


def test_a_day_before_the_rule_records_exactly_as_before(rule_store):
    root, pre = rule_store
    assert "expiry_only" not in pre
    assert all("unfiltered" not in b and "expiry_only" not in b for b in pre["lists"].values())
    hist = pick.load_history(PRE, root, syn.NAMES)
    assert pre["lists"] == _old_score_history(hist, PRE, 14.1, {"dte_n": "0", "dte_s": "2"})
    assert set(pre) == {
        "v", "day", "weekday", "vix_open", "vix_source", "vix_band", "dte", "dte_source",
        "dte_basis", "lists", "commit", "universe", "inputs_sha", "inputs_days",
        "lots_per_strategy", "recorded_at", "before_first_entry", "prev", "hash",
    }  # fmt: skip


def test_a_rule_day_records_the_filtered_adaptive_and_the_unfiltered_picks(rule_store, monkeypatch):
    root, pre = rule_store
    index = _changing_index(root, MONDAY, 14.01)
    entry = syn.record_entry(root, MONDAY, dte=_labels(index), vix_open=14.01)
    assert entry["expiry_only"] == index
    c = entry["lists"]["C"]
    assert c["expiry_only"] == index
    assert all(underlying_of(n) == index for n in [*c["core"], *c["buy"]])
    assert any(underlying_of(n) != index for n in c["unfiltered"]["core"])
    assert sum(is_wide(n) for n in c["core"]) >= MIN_WIDE_N
    # the other lists are recorded unfiltered, exactly as the ranking gives them
    hist = pick.load_history(MONDAY, root, syn.NAMES)
    plain = _old_score_history(hist, MONDAY, 14.01, _labels(index))
    for key in ("A", "B", "REF"):
        assert entry["lists"][key] == plain[key]
    assert c["unfiltered"] == {"core": plain["C"]["core"], "buy": plain["C"]["buy"]}
    # the chain holds across a pre-rule and a rule entry, and the new fields are hashed content
    path = store.journal_path(root)
    assert journal.verify(path) == []
    assert [e["day"] for e in journal.read(path)] == [PRE.isoformat(), MONDAY.isoformat()]
    tampered = {
        **entry,
        "lists": {**entry["lists"], "C": {**c, "unfiltered": {"core": [], "buy": []}}},
    }
    assert journal.entry_hash(tampered) != entry["hash"]


def test_the_rule_day_message_says_so_once_and_its_next_best_is_from_the_index(rule_store):
    root, _ = rule_store
    index = _changing_index(root, MONDAY, 14.01)
    hist = pick.load_history(MONDAY, root, syn.NAMES)
    options = pick.next_best(hist, MONDAY, 14.01, _labels(index), expiry_only=index)
    assert all(underlying_of(n) == index for n in options["C"].values() if n)
    entry = syn.record_entry(root, MONDAY, dte=_labels(index), vix_open=14.01)
    text = pick.render(entry, options)
    line = f"⚡ Expiry day · {index} only"
    assert text.count(line) == 1
    assert text.splitlines()[1] == line
    other = "SENSEX" if index == "NIFTY" else "NIFTY"
    # every strategy line (the numbered picks, the Buy, the optional line) names the expiring index
    assert f" {other[0]}_" not in text
    assert "Expiry rule" not in pick.render({**entry, "expiry_only": None}, options)
    assert "Expiry day" not in pick.render({**entry, "expiry_only": None}, options)


def test_the_switch_off_records_monday_unfiltered(rule_store, monkeypatch):
    root, _ = rule_store
    monkeypatch.setenv(expiry.ENV, "off")
    entry = syn.record_entry(root, MONDAY, dte={"dte_n": "0", "dte_s": "2"}, vix_open=14.01)
    assert "expiry_only" not in entry and "unfiltered" not in entry["lists"]["C"]


def test_a_bad_switch_value_records_nothing(rule_store, monkeypatch):
    root, _ = rule_store
    monkeypatch.setenv(expiry.ENV, "monday")
    with pytest.raises(expiry.ExpiryRuleError):
        syn.record_entry(root, MONDAY, dte={"dte_n": "0", "dte_s": "2"}, vix_open=14.01)
    assert [e["day"] for e in journal.read(store.journal_path(root))] == [PRE.isoformat()]


def test_the_daylog_rescore_explain_and_rank_ic_agree_with_a_rule_day(rule_store, monkeypatch):
    root, _ = rule_store
    index = _changing_index(root, MONDAY, 14.01)
    entry = syn.record_entry(root, MONDAY, dte=_labels(index), vix_open=14.01)
    syn.build_store(root, [MONDAY])  # the evening update has run

    got = daylog._rescore(entry, root, syn.NAMES)
    assert got == {"checked": True, "same_inputs": True, "same_picks": True, "differs": []}
    # without the recorded rule the re-score would report a false mismatch on Adaptive only
    assert daylog._rescore({**entry, "expiry_only": None}, root, syn.NAMES)["differs"] == ["C"]

    monkeypatch.setattr(daylog, "variant_names", lambda: syn.NAMES)
    monkeypatch.setattr(daylog, "now_ist", lambda: datetime(2026, 10, 19, 18, 0, tzinfo=syn.IST))
    daylog._recon_cache.clear()
    day = daylog.build_day(MONDAY, root, names=syn.NAMES)
    assert day["rescore"]["same_picks"] is True
    block = day["lists"]["C"]
    assert block["expiry_only"] == index
    assert block["unfiltered"] == entry["lists"]["C"]["unfiltered"]
    assert "expiry_only" not in day["lists"]["A"] and "unfiltered" not in day["lists"]["A"]
    pre_day = daylog.build_day(PRE, root, names=syn.NAMES)
    assert "unfiltered" not in pre_day["lists"]["C"] and pre_day["rescore"]["same_picks"]

    snap = ex.load_snapshot(root, syn.NAMES)
    out = ex.explain(snap, MONDAY, "C")
    rec = out["reconstruction"]
    assert rec["matches"] is True and rec["picks_equal"] and rec["overridden_equal"]
    assert out["expiry_rule"] == {"index": index, "unfiltered": entry["lists"]["C"]["unfiltered"]}
    assert [p["variant"] for p in out["picks"]] == [
        *entry["lists"]["C"]["core"],
        *entry["lists"]["C"]["buy"],
    ]
    assert all(r["index"] == index for r in out["boundary"]["unconstrained_core"])
    for key in ("A", "B", "REF"):
        other = ex.explain(snap, MONDAY, key)
        assert other["expiry_rule"] is None and other["reconstruction"]["matches"] is True
    assert ex.explain(snap, PRE, "C")["expiry_rule"] is None

    prep = rankic._prepared(snap, "C")
    row = rankic.day_row(snap, "C", prep["days"].index(MONDAY))
    assert row["matches_entry"] is True


def test_the_evening_result_reports_the_recorded_filtered_picks(rule_store):
    root, _ = rule_store
    index = _changing_index(root, MONDAY, 14.01)
    entry = syn.record_entry(root, MONDAY, dte=_labels(index), vix_open=14.01)
    syn.build_store(root, [MONDAY])
    r = result.calculate(MONDAY, root)
    names = [n for n, _ in r.strategies["C"]]
    assert names == [*entry["lists"]["C"]["core"], *entry["lists"]["C"]["buy"]]
    assert all(underlying_of(n) == index for n in names)


def test_the_t1_track_applies_the_same_rule(tmp_path, monkeypatch):
    root = tmp_path / "TradingData"
    names = syn.NAMES + T1
    _store_to(root, PRE, names)
    monkeypatch.setattr(pick, "variant_names", lambda: syn.NAMES)
    monkeypatch.setattr(pick, "track_names", lambda t: T1)
    monkeypatch.setattr(pick, "code_commit", lambda: "synth01")
    index = _changing_index(root, MONDAY, 14.01, names)
    monkeypatch.setattr(pick, "listed_dte_labels", lambda d: (_labels(index), "master"))
    at = datetime(2026, 10, 19, 9, 16, 5, tzinfo=syn.IST)
    r = pick.record(MONDAY, root, vix_open=14.01, now_fn=lambda: at, track="t1")
    e = r.entry
    assert e["track"] == "t1" and list(e["lists"]) == ["C"] and e["expiry_only"] == index
    c = e["lists"]["C"]
    assert all(underlying_of(n) == index for n in [*c["core"], *c["buy"]])
    assert any(underlying_of(n) != index for n in c["unfiltered"]["core"])
    assert journal.verify(store.journal_path(root, "t1")) == []
    assert not store.journal_path(root).exists()
    assert r.text.startswith("🧪 T1 · TESTING PHASE · not traded")
    assert f"⚡ Expiry day · {index} only" in r.text
    # the live list, the same morning, gets the same rule from the same code path
    live = pick.record(MONDAY, root, vix_open=14.01, now_fn=lambda: at)
    assert live.entry["expiry_only"] == index
    assert all(underlying_of(n) == index for n in live.entry["lists"]["C"]["core"])


def test_a_dry_run_on_a_rule_day_writes_nothing(rule_store, monkeypatch):
    root, _ = rule_store
    before = store.journal_path(root).read_bytes()
    monkeypatch.setattr(pick, "variant_names", lambda: syn.NAMES)
    monkeypatch.setattr(pick, "code_commit", lambda: "synth01")
    monkeypatch.setattr(pick, "listed_dte_labels", lambda d: ({"dte_n": "0", "dte_s": "2"}, "m"))
    r = pick.record(MONDAY, root, vix_open=14.01, dry_run=True)
    assert r.entry["expiry_only"] == "NIFTY" and r.entry["hash"] == "(dry run)"
    assert store.journal_path(root).read_bytes() == before


# --- the evening "Tomorrow" section -------------------------------------------------------------


def test_tomorrow_expects_the_filtered_picks_on_a_rule_day(rule_store, monkeypatch):
    root, _ = rule_store
    index = _changing_index(root, MONDAY, 14.0)
    monkeypatch.setattr(attrs_mod, "vix_close_from_lake", lambda r, d: 14.0)
    monkeypatch.setattr(tomorrow_mod, "vix_transitions", lambda r, d: {})
    monkeypatch.setattr(variants_mod, "variant_names", lambda: syn.NAMES)
    labels = _labels(index)
    e = tomorrow_mod.expected_picks(MONDAY, root, labels["dte_n"], labels["dte_s"], PRE)
    assert e is not None and e.expiry_only == index
    core, buy = e.picks["C"]
    assert all(underlying_of(n) == index for n in [*core, *buy])
    assert set(e.likelihood["C"]) == {*core, *buy}
    assert all(underlying_of(n) == index for n in e.next_best["C"].values() if n)
    hist = pick.load_history(MONDAY, root, syn.NAMES)
    ruled = pick.score_history(hist, MONDAY, 14.0, labels, expiry_only=index)["C"]
    assert (core, buy) == (ruled["core"], ruled["buy"])
    # the evening message lists these picks in full, with the rule on a line of its own
    monkeypatch.setattr(tomorrow_mod, "next_session", lambda d: MONDAY)
    monkeypatch.setattr("option_backtesting.rotation.live.calendar_dte_labels", lambda d: labels)
    nxt = tomorrow_mod.next_session_picks(PRE, root)
    assert nxt is not None and nxt.expiry_only == index and nxt.day == MONDAY
    assert (nxt.core, nxt.buy) == (core, buy)
    text = messages.render_result(PRE, None, None, nxt)
    assert text.count(f"⚡ {index} only") == 1

    # a session that is not a rule day (before the date, same labels) is expected unfiltered
    early = tomorrow_mod.expected_picks(
        PRE, root, labels["dte_n"], labels["dte_s"], PRE - timedelta(days=1)
    )
    assert early is not None and early.expiry_only is None


def test_reconstructed_history_stays_unfiltered_after_the_effective_date(monkeypatch, tmp_path):
    """The rule is never applied to re-scored history: reconstruction passes no `expiry_only`, so a
    research replay of a day after 19 Oct gives the old, unrestricted list (BL-122)."""
    root = tmp_path / "TradingData"
    days = _store_to(root, date(2026, 10, 30), n=80)
    rec = daylog.reconstruction(root, syn.NAMES)
    seen = 0
    for d in days:
        a = store.read_days(root)[d]
        if d < MONDAY or expiry.expiring_index(a["dte_n"], a["dte_s"]) is None:
            continue
        assert rec.reconstructable(d)
        got = rec.picks(d)
        assert "unfiltered" not in got["C"] and "expiry_only" not in got["C"]
        seen += 1
    assert seen


def test_the_rule_names_adaptive_only_a_registered_list():
    assert expiry.RULE_LISTS == ("C",) and set(expiry.RULE_LISTS) <= set(LISTS)


def test_explain_buy_line_does_not_call_a_rule_dropped_buy_outside_the_top_ten():
    """The other index's Buy sits in the overall top 10 and the rule drops it: the boundary says
    the rule dropped it, never "short of the top 10" with a negative gap."""
    from option_backtesting.rotation.expiry import filter_picks

    names = [
        "S_buy_0917", "S_wide_0917", "S_wide_1117", "S_ditm1_0917",
        "N_wide_0917", "N_wide_1117", "N_ditm1_0917", "N_wide_1202", "N_ditm1_0947", "N_buy_0917",
    ]  # fmt: skip
    comp = np.array([0.99, 0.95, 0.94, 0.93, 0.90, 0.89, 0.88, 0.40, 0.35, 0.30])
    unfiltered = select(comp, names)
    assert unfiltered.buy == ["S_buy_0917"]
    picks = filter_picks(comp, names, unfiltered, "NIFTY")
    assert picks.buy == []
    r = ex.Ranking(names, {}, {}, {}, comp, {})
    order = sorted(range(len(names)), key=lambda v: (-comp[v], names[v]))
    allowed = {v for v, n in enumerate(names) if underlying_of(n) == "NIFTY"}
    buy = ex._boundary(r, order, picks, LISTS["C"], allowed)["buy"]
    assert buy["qualified"] is False and buy["dropped_by_rule"] is True
    assert buy["gap_to_top"] is None
    # the unfiltered list, and a Buy genuinely outside the top 10, are unchanged
    plain = ex._boundary(r, order, unfiltered, LISTS["C"])["buy"]
    assert plain["qualified"] is True and plain["dropped_by_rule"] is False
