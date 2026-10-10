"""The Family pulse (`rotation/pulse.py`, `api/rotation_pulse_routes.py`): read-only over a tmp
TRADING_DATA_ROOT with a synthetic store. Most tests are EQUALITY tests: a cell mean equals an
independent re-reading of the CSV files and the Strategy Matrix's own pooling, the 12 cells are
`score.family_index`'s groups, and "ranking sees" equals the `rfam` value Why this pick reports."""

from __future__ import annotations

import csv
import itertools
from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo

import numpy as np
import pytest
from fastapi.testclient import TestClient
from trading_data import lake

from option_backtesting.api import rotation_explain_routes, rotation_pulse_routes
from option_backtesting.api.app import create_app
from option_backtesting.rotation import daylog, journal, pick, store
from option_backtesting.rotation import explain as ex
from option_backtesting.rotation import matrix as mx
from option_backtesting.rotation import pulse as pl
from option_backtesting.rotation.lists import LISTS, WARMUP
from option_backtesting.rotation.score import family_index, vix_band
from option_backtesting.rotation.variants import variant_names

IST = ZoneInfo("Asia/Kolkata")
FAMILIES = ("wide", "p80", "dir", "ditm1", "buy")
#: the first and last start time of each band are both here, so the cut-offs are exercised
SLOTS = ("0917", "1002", "1017", "1202", "1217", "1402", "1417", "1517")
NAMES = [
    f"{i}_{f}_{s}"
    for i, f, s in itertools.product("NS", FAMILIES, SLOTS)
    if not (f == "buy" and s == "1517")
]
VIX = [10.0, 12.0, 14.0, 16.0, 20.0]
DTE = ["0", "1", "2", "3", "4", "5", "6"]


def weekdays(start: date, n: int) -> list[date]:
    out, d = [], start
    while len(out) < n:
        if d.weekday() < 5:
            out.append(d)
        d += timedelta(days=1)
    return out


def attrs_of(k: int, d: date) -> dict:
    v = VIX[(k * 3) % len(VIX)]
    return {
        "day": d.isoformat(),
        "weekday": d.strftime("%a"),
        "vix_open": v,
        "vix_band": vix_band(v),
        "dte_n": DTE[k % 7],
        "dte_s": DTE[(k + 3) % 7],
    }


def write_results(root, days, values, names=NAMES, blank_gross=()):
    directory = store.results_dir(root)
    directory.mkdir(parents=True, exist_ok=True)
    for j, name in enumerate(names):
        with (directory / f"{name}.csv").open("w", newline="") as f:
            w = csv.writer(f)
            w.writerow(store.RESULT_COLUMNS)
            for i, d in enumerate(days):
                v = values[i, j]
                if np.isnan(v):
                    continue  # no stored result for that variant-day
                gross = "" if (name, d) in blank_gross else v
                w.writerow([d.isoformat(), v, gross, 0.0, -100.0, "", 2])


def write_days(root, days):
    with store.days_path(root).open("w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=store.DAY_COLUMNS)
        w.writeheader()
        for k, d in enumerate(days):
            w.writerow(attrs_of(k, d))


def collect(root, day):
    for u in ("NIFTY", "SENSEX"):
        for asset in ("option", "index"):
            p = lake.bars_1m_path(root, asset, u, day)
            p.parent.mkdir(parents=True, exist_ok=True)
            p.touch()


def make_values(n: int, seed: int = 5) -> np.ndarray:
    rng = np.random.default_rng(seed)
    level = rng.normal(0, 300, len(NAMES))
    return np.round(level + rng.normal(0, 1200, (n, len(NAMES))), 2)


@pytest.fixture
def env(tmp_path, monkeypatch):
    # June 2025 .. July 2026: P2 (Jan-Aug 2025) and P1 (from 2025-12-03) both have sessions
    days = weekdays(date(2025, 6, 2), 300)
    root = tmp_path
    store.rotation_dir(root).mkdir(parents=True, exist_ok=True)
    values = make_values(len(days))
    write_results(root, days, values)
    write_days(root, days)
    for d in days:
        collect(root, d)
    monkeypatch.setattr(pick, "variant_names", lambda: NAMES)
    monkeypatch.setattr(pick, "code_commit", lambda: "test")
    return root, days, values


def at(day, hh, mm):
    return lambda: datetime(day.year, day.month, day.day, hh, mm, tzinfo=IST)


def record(root, day, monkeypatch, hh=9, mm=16):
    a = store.read_days(root)[day]
    labels = {"dte_n": a["dte_n"], "dte_s": a["dte_s"]}
    monkeypatch.setattr(pick, "listed_dte_labels", lambda d: (labels, "master"))
    return pick.record(day, root, vix_open=float(a["vix_open"]), now_fn=at(day, hh, mm)).entry


def run(root, **kw):
    cube = mx._read_cube(root)
    snap = ex.load_snapshot(root, NAMES)
    return pl.compute(cube, snap, **kw)


def by_key(out) -> dict:
    return {c["key"]: c for c in out["cells"]}


def reread(root) -> dict[str, dict[date, float]]:
    """Every variant's gross by day, read straight from the files (no module code)."""
    out: dict[str, dict[date, float]] = {}
    for name in NAMES:
        with (store.results_dir(root) / f"{name}.csv").open() as f:
            out[name] = {
                date.fromisoformat(r["day"]): float(r["gross"])
                for r in csv.DictReader(f)
                if r["gross"] != ""
            }
    return out


def cell_variants(key: str, index: str | None = None) -> list[str]:
    kind, band = key.split("_")
    out = []
    for n in NAMES:
        i, family, tag = n.split("_")
        k = "wide" if family in ("wide", "p80") else "dir" if family in ("dir", "ditm1") else "buy"
        m = int(tag[:2]) * 60 + int(tag[2:])
        b = "A" if m <= 602 else "B" if m <= 722 else "C" if m <= 842 else "D"
        if k == kind and b == band and (index is None or i == index):
            out.append(n)
    return out


# --- the grouping is the ranking's ---------------------------------------------------------


def test_the_twelve_cells_are_score_family_indexs_groups_for_the_real_universe():
    names = variant_names()
    groups = pl.check_grouping(names)
    assert len(groups) == 12 and set(groups.values()) == set(pl.cell_keys())
    # and per variant: the same partition, no variant in a different group than its cell says
    fam = family_index(names)
    for n, g in zip(names, fam, strict=True):
        assert groups[int(g)] == pl.cell_of(n)


def test_the_synthetic_universe_edges_fall_in_the_bands_the_ranking_uses():
    assert pl.band_of("1002") == "A" and pl.band_of("1017") == "B"
    assert pl.band_of("1202") == "B" and pl.band_of("1217") == "C"
    assert pl.band_of("1402") == "C" and pl.band_of("1417") == "D"
    assert pl.check_grouping(NAMES)  # raises PulseError when the partition differs


def test_a_drifted_grouping_is_refused(monkeypatch):
    monkeypatch.setattr(pl, "band_of", lambda tag: "A")
    with pytest.raises(pl.PulseError, match="drifted"):
        pl.check_grouping(NAMES)


# --- the figures equal a plain re-reading of the files ---------------------------------------


def test_cell_means_equal_an_independent_reading_of_the_files(env):
    root, days, _ = env
    gross = reread(root)
    out = run(root)
    assert out["as_of"] == days[-1].isoformat()
    cells = by_key(out)
    assert len(cells) == 12
    for key, c in cells.items():
        names = cell_variants(key)
        assert c["variants"] == len(names)
        for n in (5, 21, 63):
            window = days[-n:]
            vals = [gross[v][d] for v in names for d in window]
            w = c["windows"][str(n)]
            assert w["st"] == "ok"
            assert w["avg"] == pytest.approx(np.mean(vals), abs=0.006)
            assert w["n"] == n and w["nv"] == n * len(names) and w["variants"] == len(names)
        for pid, (lo, hi) in {
            "p1": (date(2025, 12, 3), date(2026, 10, 8)),
            "p2": (date(2025, 1, 10), date(2025, 8, 29)),
        }.items():
            keep = [d for d in days if lo <= d <= hi]
            vals = [gross[v][d] for v in names for d in keep]
            assert c[pid]["avg"] == pytest.approx(np.mean(vals), abs=0.006)
            assert c[pid]["n"] == len(keep)


def test_a_cell_mean_is_the_strategy_matrix_pooled_over_the_same_variants_and_days(env):
    root, days, _ = env
    cube = mx._read_cube(root)
    snap = ex.load_snapshot(root, NAMES)
    out = pl.compute(cube, snap, index="N")
    # the matrix's pulse view has one row per index and family: NIFTY Dir and NIFTY Dir ITM1 at
    # 09:17 are the whole of "dir_A" restricted to NIFTY at that slot; the cell also holds 10:02
    resp = mx.compute(
        cube,
        mx.Journal(),
        view="pulse",
        filters=mx.parse_filters(index="NIFTY", slot="0917,1002"),
    )
    rows = {r["key"]: i for i, r in enumerate(resp["rows"])}
    cols = {c["key"]: i for i, c in enumerate(resp["cols"])}
    grid = resp["matrices"][0]["cells"]
    for window in ("5", "21", "63"):
        a, b = (grid[rows[f"N:{f}"]][cols[window]] for f in ("dir", "ditm1"))
        assert a["n"] == b["n"] == int(window) and a["nv"] == b["nv"]
        # both rows pool the same number of strategy-days, so the cell is their plain mean
        assert by_key(out)["dir_A"]["windows"][window]["avg"] == pytest.approx(
            (a["v"] + b["v"]) / 2, abs=0.006
        )


def test_the_index_filter_moves_the_means_but_never_the_rank(env):
    root, days, _ = env
    both, nifty, sensex = (run(root, index=i) for i in ("both", "N", "S"))
    assert nifty["index"] == "NIFTY" and sensex["index"] == "SENSEX"
    for k in pl.cell_keys():
        assert by_key(both)[k]["rank"] == by_key(nifty)[k]["rank"] == by_key(sensex)[k]["rank"]
    n_vals = [by_key(nifty)[k]["windows"]["21"]["avg"] for k in pl.cell_keys()]
    b_vals = [by_key(both)[k]["windows"]["21"]["avg"] for k in pl.cell_keys()]
    assert n_vals != b_vals
    assert by_key(nifty)["wide_A"]["variants"] == len(cell_variants("wide_A", "N"))


def test_an_earlier_as_of_ignores_later_sessions_and_snaps_to_the_last_session_on_or_before(env):
    root, days, _ = env
    gross = reread(root)
    target = days[-40]
    sunday = target + timedelta(days=(6 - target.weekday()))
    out = run(root, as_of=sunday)
    last = [d for d in days if d <= sunday][-1]
    assert out["as_of"] == last.isoformat() and out["as_of_requested"] == sunday.isoformat()
    names = cell_variants("dir_B")
    vals = [gross[v][d] for v in names for d in [d for d in days if d <= last][-21:]]
    assert by_key(out)["dir_B"]["windows"]["21"]["avg"] == pytest.approx(np.mean(vals), abs=0.006)
    with pytest.raises(pl.PulseError, match="no stored session"):
        run(root, as_of=date(2020, 1, 1))


# --- missing is never zero ---------------------------------------------------------------


def test_a_window_with_no_stored_result_is_missing_not_zero(env):
    root, days, _ = env
    out = run(root)  # P2 ended 2025-08-29: days from June 2025 are in it; use a store that lacks it
    assert by_key(out)["wide_A"]["p2"]["st"] == "ok"
    # a store that starts after P2 has no P2 result
    late = weekdays(date(2026, 1, 5), 90)
    root2 = root / "late"
    store.rotation_dir(root2).mkdir(parents=True)
    write_results(root2, late, make_values(len(late)))
    write_days(root2, late)
    c = run(root2)
    cell = by_key(c)["wide_A"]
    assert cell["p2"] == {
        "st": "missing",
        "reason": "no stored result in this window",
        "avg": None,
        "n": 0,
        "nv": 0,
        "variants": 0,
    }
    assert cell["p2"]["avg"] is None  # never 0.0


def test_a_blank_gross_is_not_a_zero_and_a_variant_missing_a_day_pools_fewer_days(env):
    root, days, _ = env
    gross = reread(root)
    # the cell's window loses exactly the variant-days with no stored gross
    blank = {("N_wide_0917", days[-1]), ("N_wide_0917", days[-2]), ("S_p80_1002", days[-3])}
    values = make_values(len(days))
    root2 = root / "blank"
    store.rotation_dir(root2).mkdir(parents=True)
    write_results(root2, days, values, blank_gross=blank)
    write_days(root2, days)
    out = run(root2)
    w = by_key(out)["wide_A"]["windows"]["5"]
    names = cell_variants("wide_A")
    assert w["nv"] == 5 * len(names) - 3 and w["n"] == 5
    expected = [
        values[days.index(d), NAMES.index(v)]
        for v in names
        for d in days[-5:]
        if (v, d) not in blank
    ]
    assert w["avg"] == pytest.approx(np.mean(expected), abs=0.006)
    assert gross  # (the independent reader is exercised in the equality test)


def test_a_cell_with_no_variants_is_na_with_a_reason_and_nothing_is_dropped(env):
    root, days, values = env
    names = [n for n in NAMES if "_buy_" not in n]
    keep = [NAMES.index(n) for n in names]
    root2 = root / "nobuy"
    store.rotation_dir(root2).mkdir(parents=True)
    write_results(root2, days[:100], values[:100][:, keep], names)
    write_days(root2, days[:100])
    out = pl.compute(mx._read_cube(root2), ex.load_snapshot(root2, names))
    assert [c["key"] for c in out["cells"]] == pl.cell_keys()
    buy = by_key(out)["buy_A"]
    assert buy["st"] == "na" and buy["variants"] == 0 and "windows" not in buy
    assert by_key(out)["wide_A"]["st"] == "ok"
    assert out["rank"]["available"] is True and buy.get("rank") is None


def test_an_empty_store_says_so(tmp_path):
    cube = mx._read_cube(tmp_path)
    snap = ex.Snapshot(NAMES, [], np.zeros((0, len(NAMES))), np.zeros((0, len(NAMES))), {}, {})
    out = pl.compute(cube, snap)
    assert out["available"] is False and "no strategy" in out["reason"]


# --- ranking sees = Why this pick's rfam --------------------------------------------------


def test_rank_values_equal_the_rfam_why_this_pick_reports_for_a_recorded_day(env, monkeypatch):
    root, days, _ = env
    target = days[-30]
    record(root, target, monkeypatch)
    snap = ex.load_snapshot(root, NAMES)
    out = pl.compute(mx._read_cube(root), snap, as_of=days[-31])
    assert out["rank"]["for"] == target.isoformat()
    explained = ex.explain(snap, target, "A", top=60)
    rows = [*explained["picks"], *explained["top"]]
    seen = set()
    for row in rows:
        key = pl.cell_of(row["variant"])
        rfam = row["criteria"]["rfam"]["value"]
        assert by_key(out)[key]["rank"]["value"] == pytest.approx(rfam, abs=0.006)
        seen.add(key)
    assert seen == set(pl.cell_keys())
    # and the rank is the descending order of those values
    values = {k: c["rank"]["value"] for k, c in by_key(out).items()}
    for k, c in by_key(out).items():
        assert c["rank"]["rank"] == 1 + sum(1 for v in values.values() if v > values[k])
    assert sorted(c["rank"]["rank"] for c in out["cells"]) == list(range(1, 13))


def test_rank_is_identical_for_every_list_and_the_weights_are_the_lists(env):
    root, days, _ = env
    a, ref = run(root, list_id="A"), run(root, list_id="REF")
    assert [c["rank"] for c in a["cells"]] == [c["rank"] for c in ref["cells"]]
    assert a["rank"]["weights"] == {k: lst.weights.get("rfam", 0.0) for k, lst in LISTS.items()}
    assert a["rank"]["weights"]["REF"] == 0.0 and a["rank"]["weights"]["A"] == 0.05


def test_the_rank_waits_for_the_rankings_warmup(env):
    root, days, values = env
    root2 = root / "short"
    store.rotation_dir(root2).mkdir(parents=True)
    n = WARMUP - 1
    write_results(root2, days[:n], values[:n])
    write_days(root2, days[:n])
    out = run(root2)
    assert out["rank"]["available"] is False and "63" in out["rank"]["reason"]
    assert all(c["rank"] is None for c in out["cells"])
    assert by_key(out)["wide_A"]["windows"]["21"]["avg"] is not None  # the means still show


def test_a_later_session_does_not_change_the_rank_as_of_an_earlier_one(env):
    root, days, _ = env
    snap = ex.load_snapshot(root, NAMES)
    cube = mx._read_cube(root)
    early = pl.compute(cube, snap, as_of=days[-20])
    # the same pulse from a store that ends there
    root2 = root / "ends"
    store.rotation_dir(root2).mkdir(parents=True)
    keep = len(days) - 19
    write_results(root2, days[:keep], make_values(len(days))[:keep])
    write_days(root2, days[:keep])
    cut = run(root2)
    assert [c["rank"] for c in early["cells"]] == [c["rank"] for c in cut["cells"]]
    assert [c["windows"]["21"]["avg"] for c in early["cells"]] == [
        c["windows"]["21"]["avg"] for c in cut["cells"]
    ]


# --- the drift flag ------------------------------------------------------------------------


def test_a_cell_above_its_own_p1_band_is_flagged_and_inside_is_not(env):
    root, days, _ = env
    values = make_values(len(days))
    cols = [NAMES.index(n) for n in cell_variants("dir_A")]
    values[-21:, cols] += 4000.0  # the last 21 sessions far above anything in P1
    cols_b = [NAMES.index(n) for n in cell_variants("dir_B")]
    values[-21:, cols_b] -= 4000.0
    cols_c = [NAMES.index(n) for n in cell_variants("wide_C")]
    p1_rows = [i for i, d in enumerate(days) if date(2025, 12, 3) <= d <= date(2026, 10, 8)]
    values[-21:, cols_c] = values[p1_rows][:, cols_c].mean(axis=0)  # an ordinary stretch
    root2 = root / "flag"
    store.rotation_dir(root2).mkdir(parents=True)
    write_results(root2, days, values)
    write_days(root2, days)
    cells = by_key(run(root2))
    assert cells["dir_A"]["flag"]["state"] == "above"
    assert cells["dir_B"]["flag"]["state"] == "below"
    assert cells["wide_C"]["flag"]["state"] == "inside"
    f = cells["dir_A"]["flag"]
    assert f["p10"] < f["p90"] < f["last21"]
    # the band is the P10-P90 of rolling-21 means whose windows lie inside P1
    gross = reread(root2)
    names = cell_variants("dir_A")
    p1_days = [d for d in days if date(2025, 12, 3) <= d <= date(2026, 10, 8)]
    means = [
        np.mean([gross[v][d] for v in names for d in p1_days[i : i + 21]])
        for i in range(len(p1_days) - 20)
    ]
    assert f["p10"] == pytest.approx(np.percentile(means, 10), abs=0.006)
    assert f["p90"] == pytest.approx(np.percentile(means, 90), abs=0.006)


def test_too_few_p1_windows_give_no_flag_and_say_why(env):
    root, days, values = env
    stop = days.index(date(2025, 12, 3)) + 30  # 30 P1 sessions: 10 rolling windows
    root2 = root / "young"
    store.rotation_dir(root2).mkdir(parents=True)
    write_results(root2, days[:stop], values[:stop])
    write_days(root2, days[:stop])
    f = by_key(run(root2))["wide_A"]["flag"]
    assert f["state"] == "unknown" and f["windows"] == 10 and "only 10" in f["reason"]


def test_the_sparkline_is_the_rolling_21_session_mean_and_ends_on_the_last_21(env):
    root, days, _ = env
    gross = reread(root)
    c = by_key(run(root))["wide_B"]
    s = c["spark"]
    assert len(s["values"]) == 126 and s["days"][-1] == days[-1].isoformat()
    names = cell_variants("wide_B")
    for back in (0, 1, 50, 125):
        end = len(days) - 1 - back
        expect = np.mean([gross[v][d] for v in names for d in days[end - 20 : end + 1]])
        assert s["values"][125 - back] == pytest.approx(expect, abs=0.006)
    assert s["values"][-1] == c["windows"]["21"]["avg"]
    p1 = [d for d in days if date(2025, 12, 3) <= d <= date(2026, 10, 8)]
    assert s["p1_mean"] == pytest.approx(
        np.mean([gross[v][d] for v in names for d in p1]), abs=0.006
    )


# --- picks, share, recorded vs reconstructed -----------------------------------------------


def test_chips_are_the_recorded_entry_of_the_next_pick_and_a_late_entry_is_labelled(
    env, monkeypatch
):
    root, days, _ = env
    d_on, d_late = days[-30], days[-29]
    e = record(root, d_on, monkeypatch)
    record(root, d_late, monkeypatch, hh=9, mm=41)
    out = run(root, as_of=days[-31])
    assert out["picks"]["source"] == "recorded" and out["picks"]["day"] == d_on.isoformat()
    assert out["picks"]["late"] is False
    placed = [
        (c["key"], chip["list"], chip["variant"], chip["role"])
        for c in out["cells"]
        for chip in c["chips"]
    ]
    expected = []
    for lk in LISTS:
        p = e["lists"][lk]
        expected += [(pl.cell_of(v), lk, v, "core") for v in p["core"]]
        expected += [(pl.cell_of(v), lk, v, "buy") for v in p["buy"]]
    assert sorted(placed) == sorted(expected)
    # the late day's entry is shown, labelled, when it is the one for the next pick
    late = run(root, as_of=days[-30])
    assert late["picks"]["day"] == d_late.isoformat() and late["picks"]["late"] is True
    assert d_late.isoformat() in late["journal"]["late"]


def test_share_counts_recorded_on_time_core_picks_only_and_never_mixes_in_reconstructed(
    env, monkeypatch
):
    root, days, _ = env
    entries = {}
    for d, (hh, mm) in zip(days[-6:-2], [(9, 16), (9, 16), (9, 40), (9, 16)], strict=True):
        entries[d] = record(root, d, monkeypatch, hh, mm)
    out = run(root)
    on_time = [d for d in entries if d != days[-4]]
    share = out["share"]["recorded"]
    assert share["sessions"] == len(on_time) == 3
    assert share["core_total"] == 9
    cells = by_key(out)
    for key in pl.cell_keys():
        count = sum(
            1 for d in on_time for v in entries[d]["lists"]["A"]["core"] if pl.cell_of(v) == key
        )
        assert cells[key]["share"]["recorded"]["core"] == count
        if key.startswith("buy_"):
            assert cells[key]["share"]["recorded"]["share"] is None
        elif count:
            assert cells[key]["share"]["recorded"]["share"] == pytest.approx(count / 9, abs=1e-4)
    buys = {
        k: sum(1 for d in on_time for v in entries[d]["lists"]["A"]["buy"] if pl.cell_of(v) == k)
        for k in pl.cell_keys()
    }
    for key in pl.cell_keys():
        assert cells[key]["share"]["recorded"]["buy_days"] == buys[key]


def test_without_a_journal_the_share_is_reconstructed_and_says_so(env):
    root, days, _ = env
    rec = daylog.reconstruction(root, NAMES)
    out = run(root, picks_fn=rec.picks, reconstructable=rec.days_available)
    assert out["share"]["recorded"] is None
    r = out["share"]["reconstructed"]
    assert r["sessions"] == 21 and r["core_total"] == 63
    assert out["picks"]["source"] == "reconstructed"
    window = [d for d in rec.days_available() if d <= days[-1]][-21:]
    assert r["from"] == window[0].isoformat() and r["to"] == window[-1].isoformat()
    for key in pl.cell_keys():
        want = sum(1 for d in window for v in rec.picks(d)["A"]["core"] if pl.cell_of(v) == key)
        assert by_key(out)[key]["share"]["reconstructed"]["core"] == want
        assert by_key(out)[key]["share"]["recorded"] is None
    # the reconstructed pick of a day is the 09:16 job's own (pick.score_lists)
    d = window[-1]
    a = store.read_days(root)[d]
    live = pick.score_lists(
        d, float(a["vix_open"]), {"dte_n": a["dte_n"], "dte_s": a["dte_s"]}, root, NAMES
    )
    assert live["A"]["core"] == rec.picks(d)["A"]["core"]


def test_a_broken_chain_is_not_counted_as_forward(env, monkeypatch):
    root, days, _ = env
    record(root, days[-6], monkeypatch)
    record(root, days[-5], monkeypatch)
    path = store.journal_path(root)
    text = path.read_text()
    old = '"before_first_entry": true'
    assert old in text
    path.write_text(text.replace(old, '"before_first_entry": false', 1))
    assert journal.verify(path)  # the edit is detected
    out = run(root)
    assert out["journal"]["chain"]["intact"] is False
    assert out["share"]["recorded"] is None and out["picks"]["source"] != "recorded"
    assert out["journal"]["on_time"] == 0 and out["journal"]["late"] == []


def test_forward_sessions_in_a_window_are_counted_so_the_page_can_label_research_vs_forward(
    env, monkeypatch
):
    root, days, _ = env
    # nothing recorded: the 21-session window is all research
    assert by_key(run(root))["wide_A"]["windows"]["21"]["forward"] == 0
    for d in days[-3:]:
        record(root, d, monkeypatch)
    out = run(root)
    assert by_key(out)["wide_A"]["windows"]["21"]["forward"] == 3
    assert by_key(out)["wide_A"]["windows"]["5"]["forward"] == 3


def test_a_weekend_session_is_left_out_of_every_window(env):
    root, days, _ = env
    assert days[-1].weekday() == 4  # 300 weekdays from a Monday end on a Friday
    sunday = days[-1] + timedelta(days=2)
    for name in NAMES:
        with (store.results_dir(root) / f"{name}.csv").open("a", newline="") as f:
            csv.writer(f).writerow([sunday.isoformat(), 99999, 99999, 0, 0, "", 2])
    out = run(root)
    assert sunday.isoformat() in out["store"]["weekend_excluded"]
    assert out["as_of"] == days[-1].isoformat()
    assert by_key(out)["dir_A"]["windows"]["5"]["avg"] < 50000


def test_picks_after_as_of_are_not_counted_in_the_share(env, monkeypatch):
    root, days, _ = env
    for d in days[-4:]:
        record(root, d, monkeypatch)
    out = run(root, as_of=days[-3])
    assert out["share"]["recorded"]["sessions"] == 2
    assert out["share"]["recorded"]["from"] == days[-4].isoformat()
    assert out["share"]["recorded"]["to"] == days[-3].isoformat()


# --- the route --------------------------------------------------------------------------


@pytest.fixture
def client(env, monkeypatch):
    root, days, _ = env
    monkeypatch.setenv("TRADING_DATA_ROOT", str(root))
    monkeypatch.setattr(rotation_pulse_routes, "variant_names", lambda: NAMES)
    monkeypatch.setattr(rotation_explain_routes, "variant_names", lambda: NAMES)
    monkeypatch.setattr(daylog, "variant_names", lambda: NAMES)
    rotation_pulse_routes._snap_cache.update(at=0.0, root=None, value=None)
    mx._CUBE_CACHE.update(key=None, cube=None)
    return TestClient(create_app(root / "cache")), root, days


def test_the_route_returns_the_pulse_and_validates_its_arguments(client):
    c, root, days = client
    r = c.get("/legwise/rotation/pulse")
    assert r.status_code == 200
    body = r.json()
    assert body["available"] and body["as_of"] == days[-1].isoformat() and len(body["cells"]) == 12
    assert body["basis"] == "gross"
    ok = c.get("/legwise/rotation/pulse", params={"as_of": days[-10].isoformat(), "list": "c"})
    assert ok.status_code == 200 and ok.json()["list"] == "C"
    assert ok.json()["as_of"] == days[-10].isoformat()
    for params, text in [
        ({"list": "Z"}, "list must be"),
        ({"as_of": "yesterday"}, "YYYY-MM-DD"),
        ({"index": "FTSE"}, "index must be"),
        ({"as_of": "2001-01-01"}, "no stored session"),
    ]:
        bad = c.get("/legwise/rotation/pulse", params=params)
        assert bad.status_code == 422 and text in bad.json()["error"]


def test_the_route_writes_nothing_under_the_rotation_store(client):
    c, root, _ = client
    before = {
        p: (p.stat().st_mtime_ns, p.stat().st_size)
        for p in store.rotation_dir(root).rglob("*")
        if p.is_file()
    }
    assert c.get("/legwise/rotation/pulse").status_code == 200
    after = {
        p: (p.stat().st_mtime_ns, p.stat().st_size)
        for p in store.rotation_dir(root).rglob("*")
        if p.is_file()
    }
    assert before == after
