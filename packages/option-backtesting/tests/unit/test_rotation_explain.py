"""The "Why this pick?" breakdown and the rank-correlation view (rotation/explain.py, rankic.py).

A synthetic store in tmp_path (no lake data, no real results). The point of most tests is EQUALITY
with what the ranking code produces: the breakdown must add up to `score.composite`, its picks must
be `score.select`'s on the same history (checked through `pick.score_lists`, the morning code),
and for a recorded day it must reproduce the journal entry to four decimals.
"""

from __future__ import annotations

import csv
import dataclasses
import hashlib
import itertools
import json
from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo

import numpy as np
import pytest
from trading_data import lake

from option_backtesting.rotation import explain as ex
from option_backtesting.rotation import journal, pick, rankic, store
from option_backtesting.rotation.lists import LISTS, LOTS_PER, WARMUP
from option_backtesting.rotation.score import (
    composite,
    dte_matrix,
    family_index,
    skewed_fit,
    vix_band,
)
from option_backtesting.rotation.variants import variant_names

IST = ZoneInfo("Asia/Kolkata")
FAMILIES = ("wide", "p80", "dir", "ditm1", "buy")
SLOTS = ("0917", "0932", "1017", "1117", "1217", "1317", "1417", "1517")
NAMES = [
    f"{i}_{f}_{s}"
    for i, f, s in itertools.product("NS", FAMILIES, SLOTS)
    if not (f == "buy" and s == "1517")
]  # 78 variants: every family on both indexes, enough for a rank correlation
VIX = [10.0, 12.0, 14.0, 16.0, 20.0]
DTE_N = ["0", "1", "2", "3", "4", "5", "6"]


def _weekdays(start: date, n: int) -> list[date]:
    out, d = [], start
    while len(out) < n:
        if d.weekday() < 5:
            out.append(d)
        d += timedelta(days=1)
    return out


def _attrs(k: int, d: date) -> dict:
    vix = VIX[(k * 3) % len(VIX)]
    return {
        "day": d.isoformat(),
        "weekday": d.strftime("%a"),
        "vix_open": vix,
        "vix_band": vix_band(vix),
        "dte_n": DTE_N[k % 7],
        "dte_s": DTE_N[(k + 3) % 7],
    }


def _write_results(root, days, values: np.ndarray, names=NAMES, gross: np.ndarray | None = None):
    directory = store.results_dir(root)
    directory.mkdir(parents=True, exist_ok=True)
    gross = values if gross is None else gross
    for j, name in enumerate(names):
        with (directory / f"{name}.csv").open("w", newline="") as f:
            w = csv.writer(f)
            w.writerow(store.RESULT_COLUMNS)
            for i, d in enumerate(days):
                w.writerow([d.isoformat(), values[i, j], gross[i, j], 0.0, -100.0, "", 2])


def _write_days(root, days):
    with store.days_path(root).open("w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=store.DAY_COLUMNS)
        w.writeheader()
        for k, d in enumerate(days):
            w.writerow(_attrs(k, d))


def _collect(root, day):
    for u in ("NIFTY", "SENSEX"):
        for asset in ("option", "index"):
            p = lake.bars_1m_path(root, asset, u, day)
            p.parent.mkdir(parents=True, exist_ok=True)
            p.touch()


def _values(n: int, seed: int = 11) -> np.ndarray:
    rng = np.random.default_rng(seed)
    # a persistent per-variant level (some variants are simply better) plus daily noise
    level = rng.normal(0, 400, len(NAMES))
    return np.round(level + rng.normal(0, 1500, (n, len(NAMES))), 2)


@pytest.fixture
def env(tmp_path, monkeypatch):
    days = _weekdays(date(2026, 3, 2), 135)
    root = tmp_path
    store.rotation_dir(root).mkdir(parents=True, exist_ok=True)
    values = _values(len(days))
    _write_results(root, days, values)
    _write_days(root, days)
    for d in days:
        _collect(root, d)
    monkeypatch.setattr(pick, "variant_names", lambda: NAMES)
    monkeypatch.setattr(pick, "code_commit", lambda: "test")
    return root, days, values


def _at(day, hh, mm):
    return lambda: datetime(day.year, day.month, day.day, hh, mm, tzinfo=IST)


def _dte_for(root, day):
    a = store.read_days(root)[day]
    return {"dte_n": a["dte_n"], "dte_s": a["dte_s"]}


def _record(root, day, monkeypatch, hh=9, mm=16):
    """A real journal entry through pick.record, with the day's own attributes."""
    a = store.read_days(root)[day]
    monkeypatch.setattr(pick, "listed_dte_labels", lambda d: (_dte_for(root, d), "master"))
    return pick.record(day, root, vix_open=float(a["vix_open"]), now_fn=_at(day, hh, mm)).entry


# ---------------------------------------------------------------------------
# The breakdown equals the ranking
# ---------------------------------------------------------------------------


def test_the_rebuilt_history_digest_is_the_one_pick_computes(env):
    root, days, _ = env
    snap = ex.load_snapshot(root, NAMES)
    day = days[90]
    rows = ex._history_rows(snap, day)
    h = pick.load_history(day, root, NAMES)
    assert ex.history_digest(snap, rows) == h.digest
    assert [snap.days[i] for i in rows] == h.days


@pytest.mark.parametrize("key", list(LISTS))
def test_contributions_add_up_to_the_composite_and_the_picks_are_selects(env, key):
    root, days, _ = env
    snap = ex.load_snapshot(root, NAMES)
    for k in (70, 85, 100):
        day = days[k]
        out = ex.explain(snap, day, key, top=5)
        # the morning code, on the same history and the same day attributes
        want = pick.score_lists(
            day, float(_attrs(k, day)["vix_open"]), _dte_for(root, day), root, NAMES
        )[key]
        got_core = [p["variant"] for p in out["picks"] if p["role"] != "buy"]
        assert set(got_core) == set(want["core"])
        assert [p["variant"] for p in out["picks"] if p["role"] == "buy"] == want["buy"]
        assert out["boundary"]["override"]["fired"] == want["overridden"]
        for p in out["picks"]:
            assert p["composite"] == want["composite"][p["variant"]]  # 4 decimals, as recorded
            total = sum(c["contribution"] for c in p["criteria"].values())
            assert total == pytest.approx(p["composite"], abs=6e-4)
            for crit in p["criteria"].values():
                assert crit["contribution"] == pytest.approx(crit["weight"] * crit["pct"], abs=2e-4)


def test_percentiles_and_weights_follow_the_list(env):
    root, days, _ = env
    snap = ex.load_snapshot(root, NAMES)
    ref = ex.explain(snap, days[90], "REF")
    a = ex.explain(snap, days[90], "A")
    assert ref["list_info"]["weights"]["rfam"] == 0.0
    assert [w["days"] for w in ref["list_info"]["lookbacks"]] == [5, 21, 63]
    assert [w["days"] for w in a["list_info"]["lookbacks"]] == [5, 21, 63, 126]
    for p in ref["picks"]:
        assert len(p["criteria"]["weekday"]["windows"]) == 3
        assert p["criteria"]["rfam"]["contribution"] == 0.0
    for p in a["picks"]:
        assert len(p["criteria"]["weekday"]["windows"]) == 4
        assert all(0 < c["pct"] <= 1 for c in p["criteria"].values())


def test_matching_days_per_lookback_are_the_days_a_brute_force_count_finds(env):
    root, days, values = env
    snap = ex.load_snapshot(root, NAMES)
    k = 95
    day = days[k]
    out = ex.explain(snap, day, "A")
    attrs = {d: _attrs(i, d) for i, d in enumerate(days)}
    hist = days[:k]
    p = out["picks"][0]
    j = NAMES.index(p["variant"])
    own_dte = attrs[day]["dte_n" if p["index"] == "NIFTY" else "dte_s"]
    for crit, same in (
        ("weekday", lambda d: attrs[d]["weekday"] == attrs[day]["weekday"]),
        ("vix", lambda d: attrs[d]["vix_band"] == attrs[day]["vix_band"]),
        (
            "dte",
            lambda d: attrs[d]["dte_n" if p["index"] == "NIFTY" else "dte_s"] == own_dte,
        ),
    ):
        for w in p["criteria"][crit]["windows"]:
            recent = hist[-w["lookback"] :]
            match = [d for d in recent if same(d)]
            assert w["matching_days"] == len(match)
            if match:
                mean = np.mean([values[days.index(d), j] for d in match])
                assert w["mean"] == pytest.approx(mean, abs=0.01)
        # the window parts add up to the fit value (renormalised over the windows with days)
        parts = sum(w["part"] for w in p["criteria"][crit]["windows"])
        assert parts == pytest.approx(p["criteria"][crit]["value"], abs=0.05)


def test_the_decomposition_matches_score_composite_for_every_variant(env):
    root, days, _ = env
    snap = ex.load_snapshot(root, NAMES)
    prep = rankic._prepared(snap, "A")
    p = 80
    r = ex.rank_day(
        prep["net"][: p + 1],
        prep["weekday"][: p + 1],
        prep["band"][: p + 1],
        prep["dmat"][: p + 1],
        NAMES,
        LISTS["A"],
        prep["fam"],
    )
    want = composite(
        prep["net"][: p + 1],
        prep["weekday"][: p + 1],
        prep["band"][: p + 1],
        prep["dmat"][: p + 1],
        NAMES,
        LISTS["A"],
        prep["fam"],
    )
    assert np.allclose(r.comp, want, atol=1e-12)
    # and each fit equals skewed_fit alone
    match = (prep["weekday"][:, None] == prep["weekday"][p]).repeat(len(NAMES), axis=1)
    assert np.allclose(
        r.crit["weekday"], skewed_fit(prep["net"][: p + 1], match, p, LISTS["A"].lookbacks)
    )


# ---------------------------------------------------------------------------
# Recorded days: reproduce the entry
# ---------------------------------------------------------------------------


def test_a_recorded_day_is_reproduced_to_four_decimals_for_every_list(env, monkeypatch):
    root, days, _ = env
    entry = _record(root, days[100], monkeypatch)
    snap = ex.load_snapshot(root, NAMES)
    for key in LISTS:
        out = ex.explain(snap, days[100], key)
        rec = out["reconstruction"]
        assert rec["source"] == "recorded"
        assert rec["matches"] is True and rec["max_abs_diff"] == 0.0
        assert rec["picks_equal"] and rec["overridden_equal"]
        assert rec["inputs_match"] is True and rec["universe_match"] is True
        assert out["recorded"]["composite"] == entry["lists"][key]["composite"]
        assert out["provenance"]["source"] == "recorded"
        assert out["provenance"]["before_first_entry"] is True
        assert out["provenance"]["hash"] == entry["hash"]
        assert out["context"]["source"] == "journal"


def test_results_repaired_after_recording_are_flagged_not_hidden(env, monkeypatch):
    root, days, values = env
    _record(root, days[100], monkeypatch)
    # a stored day before the entry is repaired later: the entry's inputs are no longer on disk
    uniform = values.copy()
    uniform[60] += 7500.0  # the same shift for every variant leaves the ranking alone ...
    _write_results(root, days, uniform)
    out = ex.explain(ex.load_snapshot(root, NAMES), days[100], "A")
    assert out["reconstruction"]["inputs_match"] is False  # ... but the digest still says so
    assert out["reconstruction"]["matches"] is True

    skewed = values.copy()
    skewed[98:100, :30] += 40000.0  # a repair that moves some variants' recent scores
    _write_results(root, days, skewed)
    out = ex.explain(ex.load_snapshot(root, NAMES), days[100], "A")
    assert out["reconstruction"]["inputs_match"] is False
    assert out["reconstruction"]["matches"] is False
    assert out["reconstruction"]["max_abs_diff"] > 0 or not out["reconstruction"]["picks_equal"]


def test_a_late_entry_is_labelled_not_forward(env, monkeypatch):
    root, days, _ = env
    _record(root, days[100], monkeypatch, hh=9, mm=40)
    out = ex.explain(ex.load_snapshot(root, NAMES), days[100], "C")
    assert out["provenance"]["before_first_entry"] is False
    assert out["reconstruction"]["matches"] is True  # still a faithful breakdown of the entry


def test_a_research_day_is_reconstructed_with_nothing_to_match(env):
    root, days, _ = env
    out = ex.explain(ex.load_snapshot(root, NAMES), days[80], "A")
    assert out["reconstruction"]["source"] == "reconstructed"
    assert out["reconstruction"]["matches"] is None
    assert out["provenance"] == {"source": "reconstructed"}
    assert out["recorded"] is None
    assert out["context"]["source"] == "days.csv"


def test_a_later_day_does_not_change_an_earlier_days_breakdown(env):
    root, days, values = env
    before = ex.explain(ex.load_snapshot(root, NAMES), days[80], "A", top=3)
    changed = values.copy()
    changed[80:] = 9e6
    _write_results(root, days, changed)
    after = ex.explain(ex.load_snapshot(root, NAMES), days[80], "A", top=3)
    # the day's own realised result is the one thing allowed to differ (it is not ranked on)
    assert {k: v for k, v in before.items() if k != "scored"} == {
        k: v for k, v in after.items() if k != "scored"
    }
    assert before["scored"] != after["scored"]


# ---------------------------------------------------------------------------
# Boundary facts
# ---------------------------------------------------------------------------


def _skewed_store(root, days, favour: str, bonus: float = 6000.0):
    """Results where one family is persistently far better than the rest."""
    values = _values(len(days), seed=3)
    for j, n in enumerate(NAMES):
        if n.split("_")[1] in favour.split(","):
            values[:, j] += bonus
    _write_results(root, days, values)
    return values


def test_widesl_minimum_swaps_are_replayed_and_name_what_was_displaced(env):
    root, days, _ = env
    _skewed_store(root, days, "dir,ditm1")
    snap = ex.load_snapshot(root, NAMES)
    out = ex.explain(snap, days[100], "A")
    b = out["boundary"]
    assert b["override"]["fired"] is True
    assert b["override"]["wide_in_unconstrained"] == 0
    assert len(b["override"]["swaps"]) == 2
    core = {p["variant"] for p in out["picks"] if p["role"] != "buy"}
    dropped = {s["dropped"]["variant"] for s in b["override"]["swaps"]}
    added = {s["added"]["variant"] for s in b["override"]["swaps"]}
    assert dropped.isdisjoint(core) and added <= core
    assert {u["variant"] for u in b["unconstrained_core"]} == (core | dropped) - added
    # the best excluded alternative outscored the weakest pick and says why it was left out
    best = b["best_excluded"]
    assert best["kept_out_by"] == "widesl_minimum" and best["gap"] < 0
    assert {p["role"] for p in out["picks"] if p["variant"] in added} == {"core_override"}


def test_without_an_override_the_best_excluded_trails_the_weakest_pick(env):
    root, days, _ = env
    _skewed_store(root, days, "wide,p80")
    out = ex.explain(ex.load_snapshot(root, NAMES), days[100], "A")
    b = out["boundary"]
    assert b["override"]["fired"] is False and b["override"]["swaps"] == []
    assert b["best_excluded"]["gap"] >= 0
    assert b["best_excluded"]["kept_out_by"] is None
    assert b["weakest_pick"]["composite"] <= min(
        p["composite"] for p in out["picks"] if p["role"] != "buy"
    )


def test_buy_qualifies_only_in_the_overall_top_ten(env):
    root, days, _ = env
    _skewed_store(root, days, "buy", bonus=8000.0)
    out = ex.explain(ex.load_snapshot(root, NAMES), days[100], "A")
    buy = out["boundary"]["buy"]
    assert buy["qualified"] is True and buy["best_buy"]["rank"] <= 10
    assert [p["role"] for p in out["picks"]].count("buy") == 1
    assert buy["gap_to_top"] is None

    _skewed_store(root, days, "buy", bonus=-8000.0)
    out = ex.explain(ex.load_snapshot(root, NAMES), days[100], "A")
    buy = out["boundary"]["buy"]
    assert buy["qualified"] is False and buy["picked"] == []
    assert buy["best_buy"]["rank"] > 10
    assert buy["gap_to_top"] > 0
    assert all(p["role"] != "buy" for p in out["picks"])


# ---------------------------------------------------------------------------
# What cannot be explained
# ---------------------------------------------------------------------------


def test_a_day_with_too_little_history_is_refused_with_the_count(env):
    root, days, _ = env
    snap = ex.load_snapshot(root, NAMES)
    with pytest.raises(ex.ExplainError) as e:
        ex.explain(snap, days[WARMUP - 1], "A")
    assert e.value.code == "short_history" and str(WARMUP - 1) in e.value.message
    assert ex.explain(snap, days[WARMUP], "A")["history"]["days"] == WARMUP


def test_a_day_with_no_attributes_and_no_entry_is_refused(env):
    root, days, _ = env
    snap = ex.load_snapshot(root, NAMES)
    with pytest.raises(ex.ExplainError) as e:
        ex.explain(snap, days[-1] + timedelta(days=3), "A")
    assert e.value.code == "no_day"


def test_an_unscored_recorded_day_can_still_be_explained(env, monkeypatch):
    root, days, _ = env
    target = _weekdays(days[-1] + timedelta(days=1), 1)[0]
    # the entry day has day attributes but no results yet (the nightly update has not run)
    with store.days_path(root).open("a", newline="") as f:
        csv.DictWriter(f, fieldnames=store.DAY_COLUMNS).writerow(_attrs(len(days), target))
    _collect(root, target)
    entry = _record(root, target, monkeypatch)
    snap = ex.load_snapshot(root, NAMES)
    out = ex.explain(snap, target, "A")
    assert out["scored"] is None
    assert out["reconstruction"]["matches"] is True
    assert out["recorded"]["core"] == entry["lists"]["A"]["core"]


def test_explaining_writes_nothing(env, monkeypatch):
    root, days, _ = env
    _record(root, days[100], monkeypatch)

    def digest():
        h = hashlib.sha256()
        for p in sorted(store.rotation_dir(root).rglob("*")):
            if p.is_file():
                h.update(p.name.encode() + p.read_bytes())
        return h.hexdigest()

    before = digest()
    snap = ex.load_snapshot(root, NAMES)
    ex.explain(snap, days[100], "A")
    ex.explain(snap, days[70], "REF")
    rankic.analyse(snap, "A", "research")
    rankic.analyse(snap, "A", "forward")
    assert digest() == before
    assert journal.verify(store.journal_path(root)) == []


def test_the_range_offers_explainable_days_and_defaults_to_the_latest_recorded(env, monkeypatch):
    root, days, _ = env
    snap = ex.load_snapshot(root, NAMES)
    r = ex.explain_range(snap)
    assert r["first"] == days[WARMUP].isoformat() and r["last"] == days[-1].isoformat()
    assert r["recorded"] == [] and r["default"] == days[-1].isoformat()
    _record(root, days[80], monkeypatch)
    r = ex.explain_range(ex.load_snapshot(root, NAMES))
    assert r["recorded"] == [days[80].isoformat()] and r["default"] == days[80].isoformat()


# ---------------------------------------------------------------------------
# Rank correlation
# ---------------------------------------------------------------------------


def test_spearman_handles_ties_missing_values_and_a_constant_side():
    x = np.arange(40, dtype=float)
    assert rankic.spearman(x, x * 3 + 1) == pytest.approx(1.0)
    assert rankic.spearman(x, -x) == pytest.approx(-1.0)
    assert rankic.spearman(x, np.zeros(40)) is None  # no order on one side
    y = x.copy()
    y[:5] = np.nan  # a variant with no result is left out, not read as zero
    assert rankic.spearman(x, y) == pytest.approx(1.0)
    assert rankic.spearman(x[:20], x[:20]) is None  # too few to say anything
    tied = np.repeat(np.arange(20.0), 2)
    assert rankic.spearman(tied, tied) == pytest.approx(1.0)


def test_summary_is_a_mean_with_a_95_percent_t_band_over_days():
    s = rankic.summarise([0.1, 0.2, None, 0.3, 0.0])
    assert s["n"] == 4 and s["mean"] == pytest.approx(0.15)
    sd = float(np.std([0.1, 0.2, 0.3, 0.0], ddof=1))
    assert s["sd"] == pytest.approx(sd)
    assert s["t"] == pytest.approx(3.182)  # 3 degrees of freedom, not 1.96
    assert s["lo"] == pytest.approx(0.15 - 3.182 * sd / 2)
    assert s["hi"] == pytest.approx(0.15 + 3.182 * sd / 2)
    assert s["pos"] == pytest.approx(0.75)
    assert s["readable"] is False  # four days: a number, not a reading
    one = rankic.summarise([0.4])
    assert one["n"] == 1 and one["lo"] is None and one["readable"] is False
    assert rankic.summarise([None])["mean"] is None


def test_the_t_band_is_wider_than_the_normal_one_for_a_few_days_and_converges():
    # three forward days +0.10, +0.02, +0.08: the normal band sits above zero, the t band does not
    s = rankic.summarise([0.10, 0.02, 0.08])
    assert s["lo"] < 0 < s["hi"]
    normal_lo = s["mean"] - 1.96 * s["se"]
    assert normal_lo > 0
    assert [rankic.t_critical(d) for d in (1, 2, 5, 30, 31, 59, 60, 119, 120, 500)] == [
        12.706, 4.303, 2.571, 2.042, 2.042, 2.021, 2.0, 2.0, 1.98, 1.96,
    ]  # fmt: skip
    with pytest.raises(ValueError):
        rankic.t_critical(0)
    assert rankic.summarise(list(np.linspace(-0.1, 0.2, 10)))["readable"] is True
    assert rankic.summarise(list(np.linspace(-0.1, 0.2, 9)))["readable"] is False


def test_the_spread_is_top_thirty_minus_bottom_thirty():
    names = [f"N_wide_{i:04d}" for i in range(80)]
    comp = np.arange(80, dtype=float)
    gross = np.arange(80, dtype=float) * 10
    s = rankic.spread(comp, gross, names)
    assert s["top"] == pytest.approx(np.mean(gross[-30:]))
    assert s["bottom"] == pytest.approx(np.mean(gross[:30]))
    gross[:45] = np.nan  # too few variants left with a result: no spread, not zero
    assert rankic.spread(comp, gross, names)["spread"] is None


def test_one_correlation_per_day_never_pooled(env):
    root, days, _ = env
    snap = ex.load_snapshot(root, NAMES)
    out = rankic.analyse(snap, "A", "research", days[70], days[79])
    assert [r["day"] for r in out["days"]] == [d.isoformat() for d in days[70:80]]
    assert out["summary"]["composite"]["n"] == 10
    assert len(out["running"]) == 10
    assert out["running"][-1]["mean"] == pytest.approx(out["summary"]["composite"]["mean"])
    assert out["running"][0]["lo"] is None  # one day has no band
    # no running band is drawn before it can be read, only from the tenth day on
    assert [r["lo"] is None for r in out["running"]] == [True] * 9 + [False]
    assert out["summary"]["composite"]["readable"] is True and out["min_band_days"] == 10


def test_a_ranking_that_orders_the_days_results_scores_one(env):
    root, days, values = env
    snap = ex.load_snapshot(root, NAMES)
    prep = rankic._prepared(snap, "A")
    p = 90
    r = ex.rank_day(
        prep["net"][: p + 1], prep["weekday"][: p + 1], prep["band"][: p + 1],
        prep["dmat"][: p + 1], NAMES, LISTS["A"], prep["fam"],
    )  # fmt: skip
    planted = values.copy()
    planted[p] = r.comp * 1000.0  # the day pays exactly in the order of the morning composite
    _write_results(root, days, planted)
    out = rankic.analyse(ex.load_snapshot(root, NAMES), "A", "research", days[p], days[p])
    row = out["days"][0]
    assert row["composite"] == pytest.approx(1.0)
    assert row["spread"] > 0 and row["top"] > row["bottom"]


def test_a_later_day_does_not_move_an_earlier_days_correlation(env):
    root, days, values = env
    before = rankic.analyse(ex.load_snapshot(root, NAMES), "B", "research", days[85], days[85])
    changed = values.copy()
    changed[86:] = np.random.default_rng(0).normal(0, 9e5, changed[86:].shape)
    _write_results(root, days, changed)
    after = rankic.analyse(ex.load_snapshot(root, NAMES), "B", "research", days[85], days[85])
    assert before["days"] == after["days"]


def test_research_mode_defaults_to_the_last_63_days_with_results(env):
    root, days, _ = env
    out = rankic.analyse(ex.load_snapshot(root, NAMES), "A", "research")
    assert out["n_days"] == 63
    assert out["to"] == days[-1].isoformat() and out["from"] == days[-63].isoformat()
    assert {r["kind"] for r in out["days"]} == {"research"}
    assert out["reference"]["values"]["composite"] == 0.048
    assert rankic.analyse(ex.load_snapshot(root, NAMES), "B", "research")["reference"] is None


def test_the_window_needs_the_warmup_days(env):
    root, days, _ = env
    out = rankic.analyse(ex.load_snapshot(root, NAMES), "A", "research", days[0], days[WARMUP - 1])
    assert out["n_days"] == 0 and "earlier days of results" in out["reason"]


def test_forward_mode_counts_only_scored_entries_made_before_the_first_entry_time(env, monkeypatch):
    root, days, values = env
    empty = rankic.analyse(ex.load_snapshot(root, NAMES), "A", "forward")
    assert empty["n_days"] == 0 and "No journal entry yet" in empty["reason"]
    assert empty["summary"]["composite"]["mean"] is None  # missing, not zero

    # three recorded days: one on time and scored, one late and scored, one on time, unscored
    _record(root, days[100], monkeypatch)
    _record(root, days[101], monkeypatch, hh=9, mm=45)
    nxt = _weekdays(days[-1] + timedelta(days=1), 1)[0]
    with store.days_path(root).open("a", newline="") as f:
        csv.DictWriter(f, fieldnames=store.DAY_COLUMNS).writerow(_attrs(len(days), nxt))
    _collect(root, nxt)
    _record(root, nxt, monkeypatch)
    out = rankic.analyse(ex.load_snapshot(root, NAMES), "A", "forward")
    assert [r["day"] for r in out["days"]] == [days[100].isoformat()]
    assert out["days"][0]["kind"] == "forward" and out["days"][0]["matches_entry"] is True
    st = out["status"]
    assert (st["entries"], st["forward"], st["late"], st["forward_scored"]) == (3, 2, 1, 1)
    assert st["forward_waiting"] == [nxt.isoformat()]
    # in research mode the late day is shown, labelled, and counted apart
    res = rankic.analyse(ex.load_snapshot(root, NAMES), "A", "research", days[99], days[102])
    assert [r["kind"] for r in res["days"]] == ["research", "forward", "late", "research"]
    assert res["counts"] == {"forward": 1, "late": 1, "research": 2, "mismatch": 0}


def test_forward_mode_says_so_when_every_entry_is_late(env, monkeypatch):
    root, days, _ = env
    _record(root, days[100], monkeypatch, hh=9, mm=30)
    out = rankic.analyse(ex.load_snapshot(root, NAMES), "A", "forward")
    assert out["n_days"] == 0 and "late entries are not forward" in out["reason"]


def test_bad_arguments_are_refused(env):
    root, _, _ = env
    snap = ex.load_snapshot(root, NAMES)
    with pytest.raises(ValueError, match="mode"):
        rankic.analyse(snap, "A", "pooled")
    with pytest.raises(ValueError, match="list"):
        rankic.analyse(snap, "Z", "research")


def test_dte_matrix_and_family_index_are_what_the_ranking_uses(env):
    root, days, _ = env
    snap = ex.load_snapshot(root, NAMES)
    prep = rankic._prepared(snap, "A")
    n = len(prep["days"])
    dn = np.array([snap.attrs[d]["dte_n"] for d in prep["days"]])
    ds = np.array([snap.attrs[d]["dte_s"] for d in prep["days"]])
    assert np.array_equal(prep["dmat"], dte_matrix(dn, ds, NAMES))
    assert np.array_equal(prep["fam"], family_index(NAMES))
    assert prep["net"].shape == (n, len(NAMES))


# ---------------------------------------------------------------------------
# Review fixes: chain, mismatch, boundary figures, attributes, gross, weekends
# ---------------------------------------------------------------------------


def _ranked_composites(snap, day, key="A"):
    """Composite of every variant for `day`, from score.composite directly (not explain's path)."""
    rows = ex._history_rows(snap, day)
    attrs = snap.attrs
    hist = [snap.days[i] for i in rows]
    wd = np.array([*(attrs[d]["weekday"] for d in hist), attrs[day]["weekday"]])
    vb = np.array([*(attrs[d]["vix_band"] for d in hist), attrs[day]["vix_band"]])
    dn = np.array([*(attrs[d]["dte_n"] for d in hist), attrs[day]["dte_n"]])
    ds = np.array([*(attrs[d]["dte_s"] for d in hist), attrs[day]["dte_s"]])
    P = np.vstack([snap.net[rows], np.zeros((1, len(NAMES)))])
    return composite(P, wd, vb, dte_matrix(dn, ds, NAMES), NAMES, LISTS[key], family_index(NAMES))


def test_buy_threshold_and_gap_are_the_tenth_overall_composite(env):
    root, days, _ = env
    _skewed_store(root, days, "buy", bonus=-8000.0)
    snap = ex.load_snapshot(root, NAMES)
    comp = _ranked_composites(snap, days[100])
    order = sorted(range(len(NAMES)), key=lambda v: (-comp[v], NAMES[v]))
    tenth = comp[order[9]]  # exactly the 10th variant overall, not the 9th or the 11th
    best_buy = max(comp[v] for v, n in enumerate(NAMES) if "_buy_" in n)
    buy = ex.explain(snap, days[100], "A")["boundary"]["buy"]
    assert buy["qualified"] is False
    assert buy["tenth_composite"] == round(float(tenth), 4)
    assert buy["gap_to_top"] == round(float(tenth - best_buy), 4)


def test_a_composite_off_by_a_few_fourth_decimals_is_not_a_match(env, monkeypatch):
    root, days, _ = env
    _record(root, days[100], monkeypatch)
    snap = ex.load_snapshot(root, NAMES)
    assert ex.explain(snap, days[100], "A")["reconstruction"]["matches"] is True
    rec = snap.entries[days[100].isoformat()]["lists"]["A"]["composite"]
    name = next(iter(rec))
    rec[name] = round(rec[name] + 0.0003, 4)
    out = ex.explain(snap, days[100], "A")["reconstruction"]
    assert out["matches"] is False
    assert out["max_abs_diff"] == pytest.approx(0.0003, abs=1e-9)


def test_a_rebuild_that_differs_still_shows_the_recorded_picks_with_a_finite_difference(
    env, monkeypatch
):
    root, days, _ = env
    entry = _record(root, days[100], monkeypatch)
    snap = ex.load_snapshot(root, NAMES)
    built = ex.explain(snap, days[100], "A")
    kept = {p["variant"] for p in built["picks"]}
    stranger = next(n for n in NAMES if n not in kept and "_buy_" not in n)
    rec = snap.entries[days[100].isoformat()]["lists"]["A"]
    was = rec["core"][0]
    rec["core"][0] = stranger
    rec["composite"][stranger] = rec["composite"].pop(was)
    out = ex.explain(snap, days[100], "A")
    json.dumps(out, allow_nan=False)  # no inf / NaN anywhere: it must serialise
    r = out["reconstruction"]
    assert r["picks_equal"] is False and r["matches"] is False
    assert isinstance(r["max_abs_diff"], float) and np.isfinite(r["max_abs_diff"])
    assert r["max_abs_diff"] > 0 and r["missing_in_rebuild"] == []
    shown = {p["variant"]: p for p in out["recorded_picks"]}
    assert set(shown) == set(rec["core"]) | set(rec["buy"])
    odd = shown[stranger]
    assert odd["rebuilt_pick"] is False and odd["role"] == "core"
    assert odd["recorded_composite"] == rec["composite"][stranger]
    assert odd["row"]["role"] == "recorded_core" and odd["rebuilt_rank"] is not None
    assert entry["lists"]["A"]["core"][0] == was  # the file itself was not touched


def test_a_recorded_name_outside_the_rebuilt_universe_is_listed_not_infinite(env, monkeypatch):
    root, days, _ = env
    _record(root, days[100], monkeypatch)
    snap = ex.load_snapshot(root, NAMES)
    rec = snap.entries[days[100].isoformat()]["lists"]["A"]
    rec["composite"]["N_wide_9999"] = 0.5
    out = ex.explain(snap, days[100], "A")
    json.dumps(out, allow_nan=False)
    assert out["reconstruction"]["missing_in_rebuild"] == ["N_wide_9999"]
    assert out["reconstruction"]["matches"] is False


def test_a_journal_day_is_scored_on_the_entrys_attributes_not_days_csv(env, monkeypatch):
    root, days, _ = env
    k = 100
    a = store.read_days(root)[days[k]]
    # the live 09:15 read and the lake bar landed in different bands / the listed expiry differs
    monkeypatch.setattr(
        pick, "listed_dte_labels", lambda d: ({"dte_n": "5", "dte_s": "1"}, "master")
    )
    assert vix_band(20.0) != a["vix_band"] and a["dte_n"] != "5"
    entry = pick.record(days[k], root, vix_open=20.0, now_fn=_at(days[k], 9, 16)).entry
    assert (entry["vix_band"], entry["dte"]["NIFTY"]) == ("18+", "5")
    snap = ex.load_snapshot(root, NAMES)

    out = ex.explain(snap, days[k], "A")
    assert out["context"]["source"] == "journal" and out["context"]["vix_band"] == "18+"
    assert out["context"]["dte"] == {"NIFTY": "5", "SENSEX": "1"}
    assert out["reconstruction"]["matches"] is True

    # the rank correlation scores the same day on the entry's attributes: it reproduces the entry
    row = rankic.analyse(snap, "A", "research", days[k], days[k])["days"][0]
    assert row["kind"] == "forward" and row["matches_entry"] is True
    # ... which days.csv alone would not (the premise: the two attribute sets rank differently)
    bare = dataclasses.replace(snap, entries={})
    other = ex.explain(bare, days[k], "A")
    assert other["context"]["source"] == "days.csv"
    assert {p["variant"]: p["composite"] for p in other["picks"]} != {
        p["variant"]: p["composite"] for p in out["picks"]
    }


def test_the_correlation_is_against_gross_when_gross_differs_from_net(env):
    root, days, values = env
    snap = ex.load_snapshot(root, NAMES)
    p = 90
    comp = _ranked_composites(snap, days[p])
    gross = values.copy()
    gross[p] = comp * 1000.0  # gross pays in the composite's order; net (random) does not
    _write_results(root, days, values, gross=gross)
    out = rankic.analyse(ex.load_snapshot(root, NAMES), "A", "research", days[p], days[p])
    row = out["days"][0]
    assert row["composite"] == pytest.approx(1.0)
    assert row["spread"] > 0
    # the ranking itself is made from net: it is the same as before gross was touched
    assert (
        ex.explain(ex.load_snapshot(root, NAMES), days[p], "A")["history"]["digest"]
        == (ex.explain(snap, days[p], "A")["history"]["digest"])
    )


def test_weekend_sessions_are_left_out_of_history_digest_and_positions(env):
    root, days, values = env
    sat = next(d + timedelta(days=1) for d in days[50:] if d.weekday() == 4)
    sun = sat + timedelta(days=1)
    everything = sorted([*days, sat, sun])
    spiked = np.zeros((len(everything), len(NAMES)))
    for i, d in enumerate(everything):
        spiked[i] = 9e6 if d in (sat, sun) else values[days.index(d)]
    _write_results(root, everything, spiked)
    with store.days_path(root).open("w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=store.DAY_COLUMNS)
        w.writeheader()
        for k, d in enumerate(everything):
            w.writerow(_attrs(k, d))
    snap = ex.load_snapshot(root, NAMES)
    assert sat not in snap.days and sun not in snap.days
    day = days[90]
    rows = ex._history_rows(snap, day)
    assert all(snap.days[i].weekday() < 5 for i in rows)
    # the morning code (store.load_matrix) agrees to the digest
    h = pick.load_history(day, root, NAMES)
    assert sat not in h.days and ex.history_digest(snap, rows) == h.digest
    assert all(d.weekday() < 5 for d in rankic._prepared(snap, "A")["days"])


def test_the_result_reader_agrees_with_the_stores(env):
    root, _, _ = env
    for name in NAMES[:5]:
        mine = {d: net for d, (net, _g) in ex._read_net_gross(name, root).items()}
        assert mine == store.read_net(name, root)


def test_family_band_labels_group_exactly_as_family_index_does():
    names = variant_names()
    labels = ex._family_band_names(names)
    idx = family_index(names)
    by_label: dict[str, set[int]] = {}
    by_group: dict[int, set[int]] = {}
    for i, (label, g) in enumerate(zip(labels, idx, strict=True)):
        by_label.setdefault(label, set()).add(i)
        by_group.setdefault(int(g), set()).add(i)
    assert sorted(map(sorted, by_label.values())) == sorted(map(sorted, by_group.values()))
    assert len(by_label) == 12  # three strategy kinds x four start bands
    assert all(" " in label and "-" in label for label in labels)


def test_lots_per_strategy_is_the_lists_constant(env, monkeypatch):
    root, days, _ = env
    snap = ex.load_snapshot(root, NAMES)
    assert ex.explain(snap, days[90], "A")["list_info"]["lots_per_strategy"] == LOTS_PER
    monkeypatch.setattr(ex, "LOTS_PER", 5)
    assert ex.explain(snap, days[90], "A")["list_info"]["lots_per_strategy"] == 5


def test_boundary_sentences_can_quote_the_non_buy_pool_rank(env):
    root, days, _ = env
    _skewed_store(root, days, "dir,ditm1")
    b = ex.explain(ex.load_snapshot(root, NAMES), days[100], "A")["boundary"]
    assert [u["pool_rank"] for u in b["unconstrained_core"]] == [1, 2, 3]
    for s in b["override"]["swaps"]:
        assert s["dropped"]["pool_rank"] <= 3 < s["added"]["pool_rank"]
        assert s["added"]["rank"] >= s["added"]["pool_rank"]  # overall rank counts Buy too
    assert b["buy"]["best_buy"]["pool_rank"] is None


# -- the journal's chain ------------------------------------------------------


def _edit_journal(root, old: str, new: str) -> None:
    path = store.journal_path(root)
    text = path.read_text()
    assert old in text
    path.write_text(text.replace(old, new, 1))


def test_an_edited_entry_breaks_the_chain_and_is_not_counted_as_forward(env, monkeypatch):
    root, days, _ = env
    _record(root, days[100], monkeypatch, hh=9, mm=45)  # recorded late: not forward
    clean = rankic.analyse(ex.load_snapshot(root, NAMES), "A", "forward")
    assert clean["n_days"] == 0 and clean["chain"]["intact"] is True
    # someone flips the flag by hand: the picks and composites still agree, the hash does not
    _edit_journal(root, '"before_first_entry": false', '"before_first_entry": true')
    snap = ex.load_snapshot(root, NAMES)
    assert not snap.chain_intact and snap.journal_error is None
    out = rankic.analyse(snap, "A", "forward")
    assert out["n_days"] == 0
    assert "hash chain is broken" in out["reason"] and "No journal entry yet" not in out["reason"]
    assert out["status"]["chain"]["intact"] is False and out["status"]["forward"] == 0
    assert out["status"]["entries"] == 1  # listed, not counted
    explained = ex.explain(snap, days[100], "A")
    assert explained["chain"]["intact"] is False
    assert any("hash chain is broken" in w for w in explained["warnings"])
    assert ex.explain_range(snap)["recorded"] == []  # nothing offered as "latest recorded"


def test_an_intact_chain_is_reported_intact(env, monkeypatch):
    root, days, _ = env
    _record(root, days[100], monkeypatch)
    out = ex.explain(ex.load_snapshot(root, NAMES), days[100], "A")
    assert out["chain"] == {"intact": True, "problems": [], "error": None}


def test_an_unreadable_journal_is_reported_as_unreadable_not_as_empty(env, monkeypatch):
    root, days, _ = env
    _record(root, days[100], monkeypatch)
    with store.journal_path(root).open("a") as f:
        f.write("{not json\n")
    snap = ex.load_snapshot(root, NAMES)
    assert snap.journal_error and snap.entries == {}
    out = rankic.analyse(snap, "A", "forward")
    assert out["n_days"] == 0
    assert "could not be read" in out["reason"] and "No journal entry yet" not in out["reason"]
    assert out["status"]["journal_error"] == snap.journal_error
    assert out["status"]["chain"]["intact"] is False
    assert any("could not be read" in w for w in ex.explain(snap, days[90], "A")["warnings"])


# -- the trading calendar -----------------------------------------------------


def test_missing_days_follow_the_exchange_calendar_not_the_calendar_gap():
    wed, mon = date(2026, 10, 7), date(2026, 10, 12)
    shut = {date(2026, 10, 8), date(2026, 10, 9)}  # a Thursday and Friday holiday
    assert ex.missing_trading_days(wed, mon, lambda d: d.weekday() < 5 and d not in shut) == []
    only_thu = {date(2026, 10, 8)}
    assert ex.missing_trading_days(wed, mon, lambda d: d.weekday() < 5 and d not in only_thu) == [
        date(2026, 10, 9)
    ]
    assert ex.missing_trading_days(wed, wed + timedelta(days=1)) == []


def test_a_gap_warning_names_the_missing_trading_days_only(env, monkeypatch):
    root, days, _ = env
    far = days[-1] + timedelta(days=7)  # same weekday a week on
    with store.days_path(root).open("a", newline="") as f:
        csv.DictWriter(f, fieldnames=store.DAY_COLUMNS).writerow(_attrs(len(days) + 5, far))
    snap = ex.load_snapshot(root, NAMES)

    class Calendar:
        def __init__(self, shut):
            self.shut = shut

        def is_trading_day(self, d):
            return d.weekday() < 5 and d not in self.shut

    between = [days[-1] + timedelta(days=i) for i in range(1, 7)]
    monkeypatch.setattr(ex, "default_reference_data", lambda: Calendar(set()))
    warned = ex.explain(snap, far, "A")["warnings"]
    assert any("trading day(s) in between" in w for w in warned)
    monkeypatch.setattr(ex, "default_reference_data", lambda: Calendar(set(between)))
    assert ex.explain(snap, far, "A")["warnings"] == []


# ---------------------------------------------------------------------------
# The HTTP contract (what the dashboard reads)
# ---------------------------------------------------------------------------


@pytest.fixture
def client(env, monkeypatch):
    from fastapi.testclient import TestClient

    from option_backtesting.api import rotation_explain_routes as routes
    from option_backtesting.api.app import create_app

    root, _, _ = env
    monkeypatch.setenv("TRADING_DATA_ROOT", str(root))
    monkeypatch.setattr(routes, "CACHE_SECONDS", 0.0)  # every request reads fresh
    monkeypatch.setattr(routes, "variant_names", lambda: NAMES)
    return TestClient(create_app(root / "cache"))


def test_explain_defaults_to_the_latest_reconstructable_day_then_the_latest_recorded(
    client, env, monkeypatch
):
    root, days, _ = env
    body = client.get("/legwise/rotation/explain").json()
    assert body["day"] == days[-1].isoformat() and body["list"] == "A"
    assert body["available"]["recorded"] == []
    assert body["reconstruction"]["source"] == "reconstructed"
    assert len(body["picks"]) >= 3 and len(body["top"]) == 10
    _record(root, days[100], monkeypatch)
    body = client.get("/legwise/rotation/explain?list=ref").json()
    assert body["day"] == days[100].isoformat() and body["list"] == "REF"
    assert body["reconstruction"]["matches"] is True
    assert body["available"]["recorded"] == [days[100].isoformat()]


def test_explain_takes_a_day_a_list_and_a_top_count(client, env):
    _, days, _ = env
    body = client.get(f"/legwise/rotation/explain?day={days[80]}&list=C&top=0").json()
    assert (body["day"], body["list"], body["top"]) == (days[80].isoformat(), "C", [])
    assert [c["key"] for c in body["criteria"]] == ["recent", "weekday", "dte", "vix", "rfam"]


@pytest.mark.parametrize(
    ("query", "message"),
    [
        ("day=2026-13-01", "day must be YYYY-MM-DD"),
        ("list=Z", "list must be one of"),
        ("top=abc", "top must be a whole number"),
        ("top=500", "top must be between"),
    ],
)
def test_bad_explain_arguments_come_back_as_an_error_body(client, query, message):
    r = client.get(f"/legwise/rotation/explain?{query}")
    assert r.status_code == 422 and message in r.json()["error"]


def test_a_day_that_cannot_be_explained_says_why(client, env):
    _, days, _ = env
    short = client.get(f"/legwise/rotation/explain?day={days[10]}")
    assert short.status_code == 404 and "earlier days of results" in short.json()["error"]
    unknown = client.get("/legwise/rotation/explain?day=2030-01-07")
    assert unknown.status_code == 404 and "cannot be explained" in unknown.json()["error"]


def test_an_empty_store_is_a_404_with_the_command_to_run(tmp_path, monkeypatch):
    from fastapi.testclient import TestClient

    from option_backtesting.api import rotation_explain_routes as routes
    from option_backtesting.api.app import create_app

    monkeypatch.setenv("TRADING_DATA_ROOT", str(tmp_path))
    monkeypatch.setattr(routes, "CACHE_SECONDS", 0.0)
    monkeypatch.setattr(routes, "variant_names", lambda: NAMES)
    c = TestClient(create_app(tmp_path / "cache"))
    for url in ("/legwise/rotation/explain", "/legwise/rotation/ic?mode=research"):
        r = c.get(url)
        assert r.status_code == 404 and "obt rotation update" in r.json()["error"]


def test_ic_returns_the_series_summary_reference_and_status(client, env):
    body = client.get("/legwise/rotation/ic?mode=research&list=A").json()
    assert body["mode"] == "research" and body["n_days"] == 63
    assert set(body["summary"]) >= {"composite", "weekday", "dte", "vix", "recent", "spread"}
    assert body["reference"]["values"]["recent"] == 0.062
    assert body["status"]["entries"] == 0 and body["running"][-1]["n"] == 63
    fwd = client.get("/legwise/rotation/ic").json()  # forward is the default
    assert fwd["mode"] == "forward" and fwd["n_days"] == 0 and fwd["reason"]
    assert fwd["summary"]["composite"]["mean"] is None


def test_ic_window_and_argument_errors(client, env):
    _, days, _ = env
    body = client.get(
        f"/legwise/rotation/ic?mode=research&from={days[70]}&to={days[74]}&list=B"
    ).json()
    assert [r["day"] for r in body["days"]] == [d.isoformat() for d in days[70:75]]
    for query, message in [
        ("mode=pooled", "mode must be"),
        ("list=Q", "list must be one of"),
        ("from=yesterday", "from must be YYYY-MM-DD"),
        (f"from={days[80]}&to={days[70]}", "from must not be after to"),
    ]:
        r = client.get(f"/legwise/rotation/ic?{query}")
        assert r.status_code == 422 and message in r.json()["error"]
