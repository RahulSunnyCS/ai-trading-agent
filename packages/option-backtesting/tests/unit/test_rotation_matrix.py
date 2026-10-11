"""The Strategy Matrix (`rotation/matrix.py`, `api/rotation_matrix_routes.py`): a read-only view of
the rotation store. Every figure is checked against an independent re-reading of the CSV files
written into a tmp TRADING_DATA_ROOT; nothing here touches the real store."""

from __future__ import annotations

import hashlib
from datetime import date, timedelta
from pathlib import Path

import numpy as np
import pytest
from fastapi.testclient import TestClient

from option_backtesting.api.app import create_app
from option_backtesting.rotation import journal, store
from option_backtesting.rotation import matrix as m

START = date(2025, 1, 6)  # a Monday: 60 weekdays reach 2025-03-28, inside P2 (from 2025-01-10)
BANDS = ["13-15", "15-18", "11.5-13"]
DTE = {"N": ["0", "1", "2", "3", "4"], "S": ["2", "3", "4", "0", "1"]}


def weekdays(n: int, start: date = START) -> list[date]:
    out, d = [], start
    while len(out) < n:
        if d.weekday() < 5:
            out.append(d)
        d += timedelta(days=1)
    return out


DAYS = weekdays(60)


def gross_of(name: str, i: int) -> float:
    """Deterministic, distinct per variant and day, with some zeros and negatives."""
    seed = int(hashlib.sha256(f"{name}:{i}".encode()).hexdigest()[:6], 16)
    return float((seed % 2001) - 900)


def write(
    root: Path,
    name: str,
    days=DAYS,
    gross=gross_of,
    stops=lambda n, i: "",
    blank=False,
    trades=lambda n, i: 2,
):
    for i, d in enumerate(days):
        g = gross(name, i)
        store.append_result(
            name,
            {
                "day": d.isoformat(),
                "net": g,
                "gross": "" if blank else g,
                "costs": 0.0,
                "worst_mtm": g - 100,
                "stopped_by": stops(name, i),
                "n_trades": trades(name, i),
            },
            root,
        )


def write_days(root: Path, days=DAYS) -> None:
    for i, d in enumerate(days):
        store.append_day(
            {
                "day": d.isoformat(),
                "weekday": d.strftime("%a"),
                "vix_open": 14.0,
                "vix_band": BANDS[i % 3],
                "dte_n": DTE["N"][i % 5],
                "dte_s": DTE["S"][i % 5],
            },
            root,
        )


NAMES = [
    "N_wide_0917", "N_wide_0932", "N_wide_1517", "N_dir_0917", "N_dir_0932", "N_buy_0917",
    "N_buy_0932", "S_wide_0917", "S_p250_0917", "S_dir_0917",
]  # fmt: skip


@pytest.fixture
def root(tmp_path: Path) -> Path:
    for n in NAMES:
        write(tmp_path, n, stops=lambda name, i: "overall SL at 10:00" if i % 7 == 0 else "")
    write_days(tmp_path)
    return tmp_path


def run(root: Path, journal_root: Path | None = None, **kw):
    cube = m._read_cube(root)
    return m.compute(cube, m.load_journal(journal_root or root), **kw)


def cell(resp, row: str, col: str, matrix: int = 0) -> dict:
    r = [x["key"] for x in resp["rows"]].index(row)
    c = [x["key"] for x in resp["cols"]].index(col)
    return resp["matrices"][matrix]["cells"][r][c]


def idx(name: str) -> int:
    return NAMES.index(name)


# --- the numbers equal a plain re-reading of the files -------------------------------------


def test_a_family_slot_cell_is_the_mean_of_that_variants_gross_in_the_period(root):
    resp = run(root, view="family_slot", period="P2")
    lo, hi = date(2025, 1, 10), date(2025, 8, 29)
    keep = [i for i, d in enumerate(DAYS) if lo <= d <= hi]
    expect = np.mean([gross_of("N_wide_0917", i) for i in keep])
    c = cell(resp, "N:wide", "0917")
    assert c["v"] == pytest.approx(round(float(expect), 2))
    assert c["n"] == c["nv"] == len(keep) == 56
    assert resp["matrices"][0]["sessions"] == 56


def test_every_cell_matches_an_independent_read_of_the_csv_files(root):
    resp = run(root, view="family_slot", period="P2")
    for r in resp["rows"]:
        for c in resp["cols"]:
            name = f"{r['key'].split(':')[0]}_{r['key'].split(':')[1]}_{c['key']}"
            got = cell(resp, r["key"], c["key"])
            if name not in NAMES:
                assert got["st"] == "na"
                continue
            lines = (store.results_dir(root) / f"{name}.csv").read_text().splitlines()[1:]
            vals = [
                float(x.split(",")[2])
                for x in lines
                if "2025-01-10" <= x.split(",")[0] <= "2025-08-29"
            ]
            assert got["v"] == pytest.approx(round(float(np.mean(vals)), 2)), name
            assert got["m"]["worst"] == pytest.approx(min(vals))
            assert got["m"]["win_rate"] == pytest.approx(
                round(float(np.mean(np.array(vals) > 0)), 4)
            )


def test_a_row_summary_is_a_pooled_mean_not_a_sum(root):
    resp = run(root, view="family_slot", period="P2")
    r = [x["key"] for x in resp["rows"]].index("N:wide")
    s = resp["matrices"][0]["row_summary"][r]
    keep = [i for i, d in enumerate(DAYS) if d >= date(2025, 1, 10)]
    pooled = [gross_of(n, i) for n in ("N_wide_0917", "N_wide_0932", "N_wide_1517") for i in keep]
    assert s["v"] == pytest.approx(round(float(np.mean(pooled)), 2))
    assert s["nv"] == 3 * len(keep)
    assert s["n"] == len(keep)  # sessions, not variant-days


def test_sessions_count_only_days_the_selected_strategies_have_results_on(root):
    extra = [DAYS[-1] + timedelta(days=3)]
    write(root, "S_wide_0917", days=extra)  # a day only SENSEX has
    both = run(root, view="family_slot", period="custom", lo=DAYS[-1], hi=extra[0])
    nifty = run(
        root,
        view="family_slot",
        period="custom",
        lo=DAYS[-1],
        hi=extra[0],
        filters=m.parse_filters(index="NIFTY"),
    )
    assert both["matrices"][0]["sessions"] == 2 and nifty["matrices"][0]["sessions"] == 1


def test_na_is_a_strategy_that_does_not_exist_not_a_zero(root):
    resp = run(root, view="family_slot", period="P2")
    assert cell(resp, "N:buy", "1517") == {
        "st": "na",
        "reason": "this strategy does not exist here",
    }
    assert "v" not in cell(resp, "N:buy", "1517")


def test_a_period_with_no_results_is_missing_and_a_real_zero_is_a_value(root):
    write(root, "N_wide_1002", gross=lambda n, i: 0.0)
    resp = run(root, view="family_slot", period="P1")  # the fixture days end in March 2025
    c = cell(resp, "N:wide", "0917")
    assert c["st"] == "missing" and c["n"] == 0 and "v" not in c
    resp = run(root, view="family_slot", period="P2")
    z = cell(resp, "N:wide", "1002")
    assert z["v"] == 0.0 and "st" not in z and z["m"]["win_rate"] == 0.0


def test_a_blank_gross_is_missing_never_zero(root):
    write(root, "N_wide_1017", blank=True)
    resp = run(root, view="family_slot", period="P2")
    c = cell(resp, "N:wide", "1017")
    assert c["st"] == "missing"


# --- metrics --------------------------------------------------------------------------------


def test_stop_rate_counts_days_with_a_stopped_by_text(root):
    resp = run(root, view="family_slot", metric="stop_rate", period="P2")
    keep = [i for i, d in enumerate(DAYS) if d >= date(2025, 1, 10)]
    expect = np.mean([i % 7 == 0 for i in keep])
    c = cell(resp, "N:wide", "0917")
    assert c["v"] == pytest.approx(round(float(expect), 4))
    assert resp["unit"] == "fraction" and resp["scale"]["kind"] == "sequential"


def test_worst_is_the_lowest_single_variant_day_and_win_rate_counts_above_zero(root):
    resp = run(root, view="vix_family", metric="worst", period="P2")
    keep = [i for i, d in enumerate(DAYS) if d >= date(2025, 1, 10)]
    both = [
        gross_of(n, i) for n in ("N_wide_0917", "N_wide_0932", "N_wide_1517") for i in keep if True
    ]
    # pooled over every band the worst is the overall minimum
    worst_all = min(cell(resp, b, "N:wide")["v"] for b in BANDS)
    assert worst_all == min(both)
    assert resp["scale"]["kind"] == "diverging"


# --- sessions, thin cells, conditions ----------------------------------------------------------


def test_n_is_distinct_sessions_and_nv_the_pooled_variant_days(root):
    resp = run(root, view="vix_family", period="P2")
    c = cell(resp, "13-15", "N:wide")
    assert c["nv"] == 3 * c["n"]
    total = sum(cell(resp, b, "N:wide")["n"] for b in BANDS)
    assert total == 56


def test_a_thin_cell_is_flagged_not_hidden(root):
    resp = run(root, view="family_slot", period="P2", min_n=57)
    c = cell(resp, "N:wide", "0917")
    assert c["thin"] is True and c["v"] is not None
    resp = run(root, view="family_slot", period="P2", min_n=56)
    assert "thin" not in cell(resp, "N:wide", "0917")


def test_weekday_and_vix_filters_reduce_the_sample_and_an_emptied_cell_is_excluded(root):
    f = m.parse_filters(weekday="Mon")
    resp = run(root, view="weekday_family", period="P2", filters=f)
    mon = cell(resp, "Mon", "N:wide")
    tue = cell(resp, "Tue", "N:wide")
    assert mon["n"] == len([d for d in DAYS if d.weekday() == 0 and d >= date(2025, 1, 10)])
    assert tue["st"] == "excluded" and "weekday" in tue["reason"]
    f = m.parse_filters(vix_band="15-18")
    resp = run(root, view="family_slot", period="P2", filters=f)
    expect = len([i for i, d in enumerate(DAYS) if d >= date(2025, 1, 10) and i % 3 == 1])
    assert cell(resp, "N:wide", "0917")["n"] == expect


def test_dte_uses_each_variants_own_index(root):
    resp = run(
        root, view="dte_slot", period="P2", filters=m.parse_filters(index="SENSEX", family="wide")
    )
    keep = [i for i, d in enumerate(DAYS) if d >= date(2025, 1, 10)]
    own = [i for i in keep if DTE["S"][i % 5] == "0"]
    c = cell(resp, "0", "0917")
    assert c["n"] == len(own)
    assert c["v"] == pytest.approx(
        round(float(np.mean([gross_of("S_wide_0917", i) for i in own])), 2)
    )
    # NIFTY's own DTE for the same days is a different set
    n = run(
        root, view="dte_slot", period="P2", filters=m.parse_filters(index="NIFTY", family="wide")
    )
    own_n = [i for i in keep if DTE["N"][i % 5] == "0"]
    assert cell(n, "0", "0917")["n"] == len(own_n)
    assert resp["filters"]["index"] == "SENSEX" and n["filters"]["family"] == ["wide"]


def test_the_dte_filter_applies_to_each_variants_own_index(root):
    f = m.parse_filters(index="both", family="wide", slot="0917", dte="0")
    resp = run(root, view="vix_family", period="P2", filters=f)
    keep = [i for i, d in enumerate(DAYS) if d >= date(2025, 1, 10)]
    got = sum(cell(resp, b, "S:wide")["n"] for b in BANDS if cell(resp, b, "S:wide").get("n"))
    assert got == len([i for i in keep if DTE["S"][i % 5] == "0"])


def test_the_date_view_needs_one_family_and_lists_each_session(root):
    resp = run(root, view="date_slot", period="P2")  # defaults: NIFTY Widesl
    assert resp["filters"]["index"] == "NIFTY" and resp["filters"]["family"] == ["wide"]
    assert [r["key"] for r in resp["rows"]][0] == "2025-01-10"
    d0 = cell(resp, "2025-01-10", "0917")
    assert d0["v"] == gross_of("N_wide_0917", 4) and d0["n"] == 1
    with pytest.raises(m.MatrixError, match="one family"):
        run(root, view="date_slot", filters=m.parse_filters(family="wide,dir"))


# --- periods ---------------------------------------------------------------------------------


def test_p3_is_unavailable_with_a_reason_not_an_error(root):
    resp = run(root, view="family_slot", period="P3")
    assert resp["matrices"][0]["status"] == "unavailable"
    assert "not in the rotation store" in resp["matrices"][0]["reason"]
    assert resp["scale"] is None
    both = run(root, view="family_slot", compare=("P2", "P3"))
    assert both["difference"]["status"] == "unavailable"
    assert both["matrices"][0]["status"] == "ok"


def test_compare_shares_axes_and_one_colour_scale_and_returns_the_difference(root):
    # P1 gets its own days so both periods have data
    p1_days = weekdays(30, date(2025, 12, 3))
    for n in NAMES:
        write(root, n, days=p1_days, gross=lambda name, i: gross_of(name, i + 100))
    store_days = p1_days
    write_days(root, store_days)
    resp = run(root, view="family_slot", compare=("P1", "P2"))
    a, b = resp["matrices"]
    assert a["period"] == "P1" and b["period"] == "P2" and a["status"] == b["status"] == "ok"
    assert len(a["cells"]) == len(b["cells"]) == len(resp["rows"])
    limit = resp["scale"]["limit"]
    vals = [
        abs(c["v"])
        for mat in (a, b)
        for row in mat["cells"]
        for c in row
        if c.get("v") is not None and not c.get("thin")
    ]
    assert limit == pytest.approx(max(vals))
    d = resp["difference"]
    r, c = 0, 0
    assert d["cells"][r][c]["v"] == pytest.approx(
        round(a["cells"][r][c]["v"] - b["cells"][r][c]["v"], 2)
    )
    assert d["cells"][r][c]["n"] == [a["cells"][r][c]["n"], b["cells"][r][c]["n"]]
    assert d["minuend"] == "P1" and d["subtrahend"] == "P2"


def test_a_custom_range_is_inclusive_and_from_to_alone_mean_custom(root):
    resp = run(
        root, view="family_slot", period="custom", lo=date(2025, 1, 13), hi=date(2025, 1, 17)
    )
    assert cell(resp, "N:wide", "0917")["n"] == 5


# --- the journal overlay ------------------------------------------------------------------------


def entry(day: date, picks: dict[str, list[str]], on_time: bool = True) -> dict:
    return {
        "v": 3,
        "day": day.isoformat(),
        "weekday": day.strftime("%a"),
        "vix_band": "13-15",
        "dte": {"NIFTY": "1", "SENSEX": "2"},
        "before_first_entry": on_time,
        "lists": {k: {"core": v, "buy": [], "overridden": False} for k, v in picks.items()},
    }


@pytest.fixture
def journaled(root) -> Path:
    path = store.journal_path(root)
    d = DAYS
    journal.append(
        path,
        entry(
            d[10],
            {
                "A": ["N_wide_0917", "N_dir_0917"],
                "B": ["N_wide_0932"],
                "C": [],
                "REF": ["N_wide_0917"],
            },
        ),
    )
    journal.append(
        path, entry(d[11], {"A": ["N_wide_0917"], "B": ["N_dir_0932"], "C": [], "REF": []})
    )
    journal.append(
        path, entry(d[12], {"A": ["N_wide_0917"], "B": [], "C": [], "REF": []}, on_time=False)
    )
    # recorded on time, results not stored yet
    journal.append(
        path, entry(date(2025, 6, 2), {"A": ["N_wide_0917"], "B": [], "C": [], "REF": []})
    )
    return root


def test_with_no_journal_the_overlay_is_unavailable_and_selection_is_not_zero(root):
    resp = run(root, view="family_slot", period="P2")
    assert resp["overlay"]["available"] is False and "no entry" in resp["overlay"]["reason"]
    assert "sel" not in cell(resp, "N:wide", "0917")
    sel = run(root, view="family_slot", period="P2", metric="selection", list_id="A")
    assert sel["matrices"][0]["status"] == "unavailable"
    assert run(root, view="family_slot", period="forward")["matrices"][0]["status"] == "unavailable"


def test_selection_frequency_is_picks_over_recorded_on_time_days_and_excludes_late(journaled):
    resp = run(journaled, view="family_slot", metric="selection", list_id="A", period="forward")
    c = cell(resp, "N:wide", "0917")
    # 3 on-time entries (two scored, one waiting) and one late one, which is not counted
    assert c["n"] == 3 and c["nv"] == 3
    assert c["v"] == pytest.approx(1.0)
    assert cell(resp, "N:dir", "0917")["v"] == pytest.approx(round(1 / 3, 4))
    assert cell(resp, "N:wide", "0932")["v"] == 0.0 and "st" not in cell(resp, "N:wide", "0932")
    assert resp["overlay"]["late"] == [DAYS[12].isoformat()]
    assert "opportunities" in resp["selection_denominator"]
    assert resp["scale"]["kind"] == "sequential"


def test_the_overlay_counts_recorded_picks_in_every_cell_and_names_days_waiting(journaled):
    resp = run(journaled, view="family_slot", period="forward", list_id="A")
    c = cell(resp, "N:wide", "0917")
    assert c["n"] == 2  # only the two scored on-time days carry a result
    assert c["sel"] == {"A": 2, "REF": 1} and c["rec"] == 2
    assert resp["overlay"]["waiting_on_results"] == ["2025-06-02"]
    fwd = [p for p in resp["periods"] if p["id"] == "forward"][0]
    assert fwd["waiting_on_results"] == ["2025-06-02"]


def test_selected_only_restricts_to_days_the_list_picked_and_shows_both_denominators(journaled):
    allv = run(journaled, view="family_slot", period="P2", list_id="A")
    sel = run(journaled, view="family_slot", period="P2", list_id="A", basis="selected")
    a, s = cell(allv, "N:wide", "0917"), cell(sel, "N:wide", "0917")
    assert s["n"] == 2 and a["n"] == 56  # the two denominators differ
    assert s["v"] == pytest.approx(
        round(np.mean([gross_of("N_wide_0917", 10), gross_of("N_wide_0917", 11)]), 2)
    )
    assert cell(sel, "N:wide", "0932")["st"] == "excluded"
    with pytest.raises(m.MatrixError, match="needs a list"):
        run(journaled, view="family_slot", basis="selected")


def test_the_date_view_marks_the_selecting_lists_and_flags_a_late_entry(journaled):
    resp = run(journaled, view="date_slot", period="P2")
    picks = resp["date_picks"]
    assert picks[DAYS[10].isoformat()]["cells"]["0917"] == ["A", "REF"]
    assert picks[DAYS[10].isoformat()]["cells"]["0932"] == ["B"]
    assert picks[DAYS[12].isoformat()]["late"] is True
    assert DAYS[5].isoformat() not in picks  # no entry: no overlay, never a reconstruction
    assert "Reconstructed picks are not shown" in resp["overlay"]["reconstructed"]


def test_an_unscored_forward_day_is_a_row_with_missing_cells(journaled):
    resp = run(journaled, view="date_slot", period="forward")
    keys = [r["key"] for r in resp["rows"]]
    assert "2025-06-02" in keys
    c = cell(resp, "2025-06-02", "0917")
    assert c["st"] == "missing"


def test_a_corrupt_journal_leaves_the_matrix_working(root):
    store.journal_path(root).write_text("{not json\n")
    resp = run(root, view="family_slot", period="P2")
    assert resp["overlay"]["available"] is False and "cannot be read" in resp["overlay"]["reason"]
    assert cell(resp, "N:wide", "0917")["v"] is not None


# --- the pulse ---------------------------------------------------------------------------------


def test_the_pulse_is_the_mean_over_the_last_n_sessions_with_counts(root):
    resp = run(root, view="pulse")
    assert [c["key"] for c in resp["cols"]] == ["5", "21", "63", "all"]
    c5 = cell(resp, "N:wide", "5")
    last5 = range(55, 60)
    pooled = [gross_of(n, i) for n in ("N_wide_0917", "N_wide_0932", "N_wide_1517") for i in last5]
    assert c5["v"] == pytest.approx(round(float(np.mean(pooled)), 2))
    assert c5["n"] == 5 and c5["nv"] == 15
    assert cell(resp, "N:wide", "63")["n"] == 60 and "thin" not in cell(resp, "N:wide", "63")
    assert resp["matrices"][0]["row_summary"] is None
    # the 5-session window is under the default minimum of 20: flagged thin, still shown
    assert cell(resp, "N:wide", "5")["thin"] is True and cell(resp, "N:wide", "5")["v"] is not None
    assert "thin" not in cell(run(root, view="pulse", min_n=5), "N:wide", "5")
    with pytest.raises(m.MatrixError):
        run(root, view="pulse", compare=("P1", "P2"))


def test_the_pulse_counts_sessions_the_family_has_results_on(root):
    # a day only SENSEX has: NIFTY's last-5 window must not spend a slot on it
    extra = DAYS[-1] + timedelta(days=3)
    write(root, "S_wide_0917", days=[extra])
    resp = run(root, view="pulse")
    assert cell(resp, "N:wide", "5")["n"] == 5
    assert cell(resp, "N:wide", "5")["v"] == pytest.approx(
        round(
            float(
                np.mean(
                    [
                        gross_of(n, i)
                        for n in ("N_wide_0917", "N_wide_0932", "N_wide_1517")
                        for i in range(55, 60)
                    ]
                )
            ),
            2,
        )
    )


# --- the drill-down -------------------------------------------------------------------------------


def test_the_cell_drill_down_lists_the_daily_values_and_the_running_total(journaled):
    d = m.drill(
        m._read_cube(journaled),
        m.load_journal(journaled),
        view="family_slot",
        row="N:wide",
        col="0917",
        period="P2",
    )
    keep = [i for i, dd in enumerate(DAYS) if dd >= date(2025, 1, 10)]
    assert [x["gross"] for x in d["days"]] == [gross_of("N_wide_0917", i) for i in keep]
    assert d["cumulative"][-1]["cum"] == pytest.approx(
        sum(gross_of("N_wide_0917", i) for i in keep)
    )
    assert d["stats"]["sessions"] == 56 and d["variants"][0]["name"] == "N_wide_0917"
    assert d["variants"][0]["settings"] == {} or "entry" in d["variants"][0]["settings"]
    assert d["days"][0]["stopped_by"] in ("", "overall SL at 10:00")
    picked = {x["day"]: x["picked_by"] for x in d["days"] if "picked_by" in x}
    assert picked[DAYS[10].isoformat()] == ["A", "REF"]
    peak = np.maximum.accumulate(np.array([c["cum"] for c in d["cumulative"]]))
    assert d["stats"]["max_drawdown"] == pytest.approx(
        round(float((np.array([c["cum"] for c in d["cumulative"]]) - peak).min()), 2)
    )


def test_a_pooled_cell_drill_down_is_a_daily_mean_and_says_so(root):
    d = m.drill(
        m._read_cube(root),
        m.load_journal(root),
        view="vix_family",
        row="13-15",
        col="N:wide",
        period="P2",
    )
    assert d["variants_total"] == 3 and "not a basket" in d["pooling"]
    first = d["days"][0]
    i = DAYS.index(date.fromisoformat(first["day"]))
    assert first["gross"] == pytest.approx(
        round(
            float(np.mean([gross_of(n, i) for n in ("N_wide_0917", "N_wide_0932", "N_wide_1517")])),
            2,
        )
    )
    assert first["n_variants"] == 3
    # the worst strategy-day is dated by the variant-day itself, not by the lowest daily mean
    keep = [i for i, dd in enumerate(DAYS) if dd >= date(2025, 1, 10) and i % 3 == 0]  # band 13-15
    names = ("N_wide_0917", "N_wide_0932", "N_wide_1517")
    low = min((gross_of(n, i), i) for n in names for i in keep)
    assert d["stats"]["worst"] == low[0]
    assert d["stats"]["worst_day"] == DAYS[low[1]].isoformat()
    with pytest.raises(m.MatrixError, match="not in this view"):
        m.drill(
            m._read_cube(root), m.load_journal(root), view="vix_family", row="nope", col="N:wide"
        )


# --- read-only and caching ------------------------------------------------------------------------


def snapshot(root: Path) -> dict[str, str]:
    return {
        str(p.relative_to(root)): hashlib.sha256(p.read_bytes()).hexdigest()
        for p in sorted(root.rglob("*"))
        if p.is_file()
    }


def test_computing_never_changes_a_stored_file(journaled):
    before = snapshot(journaled)
    cube, jr = m._read_cube(journaled), m.load_journal(journaled)
    for view in m.VIEWS:
        m.compute(cube, jr, view=view, period="P2", list_id="A")
    m.compute(cube, jr, view="family_slot", compare=("P1", "P2"))
    m.drill(cube, jr, view="family_slot", row="N:wide", col="0917", period="P2")
    assert snapshot(journaled) == before


def test_the_cube_is_reread_when_a_file_changes_and_cached_otherwise(root):
    a = m.load_cube(root)
    assert m.load_cube(root) is a
    write(root, "N_wide_1032")
    b = m.load_cube(root)
    assert b is not a and "N_wide_1032" in b.names


def test_an_empty_store_says_so(tmp_path):
    cube = m._read_cube(tmp_path)
    out = m.compute(cube, m.load_journal(tmp_path), view="family_slot")
    assert out["available"] is False and "no strategy" in out["reason"]


@pytest.mark.parametrize(
    ("kwargs", "message"),
    [
        ({"index": "BANKNIFTY"}, "index must be"),
        ({"weekday": "Funday"}, "weekday"),
        ({"slot": "9:17am"}, "HHMM"),
        ({"dte": "9"}, "dte"),
        ({"vix_band": "high"}, "vix_band"),
    ],
)
def test_bad_filters_are_refused_with_a_reason(kwargs, message):
    with pytest.raises(m.MatrixError, match=message):
        m.parse_filters(**kwargs)


def test_a_plus_arriving_as_a_space_is_read_back():
    assert m.parse_filters(dte="7 ,1", vix_band="18 ").dte == ("7+", "1")
    assert m.parse_filters(vix_band="18 ").vix_bands == ("18+",)


def test_family_aliases_expand_to_the_tags(root):
    f = m.parse_filters(family="widesl")
    assert set(f.families) == {"wide", "p80", "p100", "p250", "p320"}
    resp = run(root, view="family_slot", period="P2", filters=m.parse_filters(family="widesl"))
    assert [r["key"] for r in resp["rows"]] == ["N:wide", "S:wide", "S:p250"]


# --- the HTTP surface ---------------------------------------------------------------------------------


@pytest.fixture
def client(journaled, monkeypatch):
    monkeypatch.setenv("TRADING_DATA_ROOT", str(journaled))
    return TestClient(create_app(journaled / "cache"))


def test_the_matrix_route_returns_the_grid_and_period_defaults_to_p1(client):
    r = client.get("/legwise/rotation/matrix")
    assert r.status_code == 200
    body = r.json()
    assert body["view"] == "family_slot" and body["matrices"][0]["period"] == "P1"
    assert [m_["id"] for m_ in body["all_periods"]] == ["P1", "P2", "P3", "forward"]
    r = client.get("/legwise/rotation/matrix", params={"from": "2025-01-13", "to": "2025-01-17"})
    assert r.json()["matrices"][0]["period"] == "custom"
    assert r.json()["matrices"][0]["cells"][0][0]["n"] == 5


def test_the_matrix_route_compares_and_reports_p3_as_unavailable(client):
    body = client.get("/legwise/rotation/matrix", params={"compare": "P2,P3"}).json()
    assert body["matrices"][1]["status"] == "unavailable"
    assert client.get("/legwise/rotation/matrix", params={"compare": "P2"}).status_code == 422


@pytest.mark.parametrize(
    "params",
    [
        {"view": "nope"},
        {"metric": "selection"},  # needs a list
        {"basis": "selected"},
        {"from": "2025-13-40"},
        {"index": "X"},
        {"view": "pulse", "compare": "P1,P2"},
    ],
)
def test_bad_requests_are_422_with_an_error_message(client, params):
    r = client.get("/legwise/rotation/matrix", params=params)
    assert r.status_code == 422 and r.json()["error"]


def test_the_cell_route_returns_the_daily_values(client):
    r = client.get(
        "/legwise/rotation/matrix/cell",
        params={"view": "family_slot", "row": "N:wide", "col": "0917", "period": "P2", "list": "A"},
    )
    assert r.status_code == 200
    body = r.json()
    assert body["stats"]["sessions"] == 56 and len(body["cumulative"]) == 56
    assert (
        client.get(
            "/legwise/rotation/matrix/cell", params={"row": "../etc", "col": "0917"}
        ).status_code
        == 422
    )
    assert (
        client.get(
            "/legwise/rotation/matrix/cell", params={"row": "N:wide", "col": "0917", "period": "P3"}
        ).status_code
        == 422
    )


# --- review fixes: weekends, one pooling path, labels, denominators ------------------------------

SAT = date(2025, 2, 1)  # the Budget Saturday, inside P2
SUN = date(2026, 2, 1)  # the Budget Sunday, inside P1


def _independent_mean(root: Path, name: str, lo: str, hi: str) -> tuple[float, int]:
    """Mean gross of one variant file over Monday to Friday days in [lo, hi]."""
    rows = (store.results_dir(root) / f"{name}.csv").read_text().splitlines()[1:]
    vals = [
        float(r.split(",")[2])
        for r in rows
        if lo <= r.split(",")[0] <= hi
        and date.fromisoformat(r.split(",")[0]).weekday() < 5
        and r.split(",")[2] != ""
    ]
    return float(np.mean(vals)), len(vals)


@pytest.fixture
def with_weekend(root) -> Path:
    for n in NAMES:
        for d, v in ((SAT, 9000.0), (SUN, -9000.0)):
            store.append_result(
                n,
                {
                    "day": d.isoformat(),
                    "net": v,
                    "gross": v,
                    "costs": 0,
                    "worst_mtm": v,
                    "n_trades": 2,
                },
                root,
            )
    return root


def test_weekend_sessions_are_left_out_counted_and_never_become_rows(with_weekend):
    resp = run(with_weekend, view="family_slot", period="P2")
    c = cell(resp, "N:wide", "0917")
    mean, n = _independent_mean(with_weekend, "N_wide_0917", "2025-01-10", "2025-08-29")
    assert c["v"] == pytest.approx(round(mean, 2)) and c["n"] == n == 56
    assert resp["periods"][0]["weekend_excluded"] == [SAT.isoformat()]
    assert resp["meta"]["store"]["weekend_excluded"] == [SAT.isoformat(), SUN.isoformat()]
    wk = run(
        with_weekend,
        view="weekday_family",
        period="custom",
        lo=date(2025, 1, 1),
        hi=date(2026, 12, 31),
    )
    assert [r["key"] for r in wk["rows"]] == ["Mon", "Tue", "Wed", "Thu", "Fri"]
    assert run(with_weekend, view="date_slot", period="P2")["rows"][0]["key"] == "2025-01-10"
    with pytest.raises(m.MatrixError, match="weekday"):
        m.parse_filters(weekday="Sat")


def test_a_weekend_journal_entry_is_not_a_forward_day(root):
    path = store.journal_path(root)
    journal.append(path, entry(SAT, {"A": ["N_wide_0917"], "B": [], "C": [], "REF": []}))
    jr = m.load_journal(root)
    assert jr.forward == [] and jr.weekend == [SAT]


def test_p1_ends_on_8_october_and_a_day_on_the_boundary_is_in(tmp_path):
    days = [date(2026, 10, 7), date(2026, 10, 8), date(2026, 10, 9)]
    write(tmp_path, "N_wide_0917", days=days, gross=lambda n, i: [100.0, 200.0, 9000.0][i])
    write_days(tmp_path, days)
    c = cell(run(tmp_path, view="family_slot", period="P1"), "N:wide", "0917")
    assert c["n"] == 2 and c["v"] == 150.0


def test_a_dte_bucket_that_never_occurred_is_missing_not_excluded(root):
    # a "7+" day exists in the store, but not in P2
    far = date(2026, 1, 5)
    write(root, "N_wide_0917", days=[far])
    store.append_day(
        {
            "day": far.isoformat(),
            "weekday": "Mon",
            "vix_open": 14.0,
            "vix_band": "13-15",
            "dte_n": "7+",
            "dte_s": "2",
        },
        root,
    )
    resp = run(
        root, view="dte_slot", period="P2", filters=m.parse_filters(index="NIFTY", family="wide")
    )
    c = cell(resp, "7+", "0917")
    assert c["st"] == "missing" and "filter" not in c["reason"]
    # a user's condition that empties a cell is excluded, and says which one
    f = m.parse_filters(index="NIFTY", family="wide", weekday="Mon")
    resp = run(root, view="weekday_family", period="P2", filters=f)
    tue = cell(resp, "Tue", "N:wide")
    assert tue["st"] == "excluded" and tue["reason"] == "removed by the weekday filter"


def test_the_cell_and_its_drawer_always_agree(journaled):
    cube, jr = m._read_cube(journaled), m.load_journal(journaled)
    cases = [
        {"view": "family_slot", "period": "P2"},
        {"view": "vix_family", "period": "P2"},
        {"view": "weekday_family", "period": "P2"},
        {"view": "date_slot", "period": "P2"},
        {"view": "pulse"},
        {"view": "pulse", "filters": m.parse_filters(weekday="Mon,Tue")},
        {
            "view": "dte_slot",
            "period": "P2",
            "filters": m.parse_filters(index="NIFTY", family="wide"),
        },
        {
            "view": "family_slot",
            "period": "P2",
            "filters": m.parse_filters(weekday="Mon,Tue,Wed", dte="0,1", vix_band="13-15,15-18"),
        },
        {"view": "family_slot", "period": "P2", "list_id": "A", "basis": "selected"},
        {"view": "vix_family", "period": "P2", "list_id": "REF", "basis": "selected"},
        {"view": "family_slot", "period": "forward"},
    ]
    checked = 0
    for kw in cases:
        resp = m.compute(cube, jr, min_n=1, **kw)
        grid = resp["matrices"][0]
        for ri, row in enumerate(resp["rows"]):
            for ci, col in enumerate(resp["cols"]):
                c = grid["cells"][ri][ci]
                if c.get("v") is None:
                    continue
                d = m.drill(
                    cube,
                    jr,
                    view=kw["view"],
                    row=row["key"],
                    col=col["key"],
                    period=kw.get("period", "P1"),
                    filters=kw.get("filters"),
                    list_id=kw.get("list_id"),
                    basis=kw.get("basis", "all"),
                )
                where = (kw, row["key"], col["key"])
                assert d["stats"]["sessions"] == c["n"], where
                assert d["stats"]["variant_days"] == c["nv"], where
                assert d["stats"]["avg"] == c["m"]["avg"], where
                assert d["stats"]["stop_rate"] == c["m"]["stop_rate"], where
                assert sum(x["n_variants"] for x in d["days"]) == c["nv"], where
                checked += 1
    assert checked > 150


def test_the_drawer_running_total_is_the_sum_of_the_daily_means(root):
    d = m.drill(
        m._read_cube(root),
        m.load_journal(root),
        view="vix_family",
        row="13-15",
        col="N:wide",
        period="P2",
    )
    assert d["stats"]["cumulative"] == pytest.approx(
        round(sum(x["gross"] for x in d["days"]), 2), abs=0.05
    )
    assert d["cumulative"][-1]["cum"] == pytest.approx(d["stats"]["cumulative"])


def test_the_pulse_is_labelled_for_what_it_is_with_its_real_session_count(root):
    resp = run(root, view="pulse", period="P1")
    p = resp["periods"][0]
    assert p["id"] == "asof" and "P1" not in p["label"]
    assert p["label"].startswith(f"As of {DAYS[-1].isoformat()}")
    assert p["sessions"] == 60 and resp["matrices"][0]["sessions"] == 60
    assert resp["matrices"][0]["period"] == "asof"


def test_the_pulse_window_is_the_last_n_sessions_that_match_the_conditions(root):
    f = m.parse_filters(weekday="Mon", index="NIFTY", family="wide", slot="0917")
    resp = run(root, view="pulse", filters=f)
    mondays = [i for i, d in enumerate(DAYS) if d.weekday() == 0]
    c5 = cell(resp, "N:wide", "5")
    assert c5["n"] == 5
    assert c5["v"] == pytest.approx(
        round(float(np.mean([gross_of("N_wide_0917", i) for i in mondays[-5:]])), 2)
    )
    assert "matching" in resp["window_rule"] or "match" in resp["window_rule"]
    d = m.drill(
        m._read_cube(root), m.load_journal(root), view="pulse", row="N:wide", col="5", filters=f
    )
    assert [x["day"] for x in d["days"]] == [DAYS[i].isoformat() for i in mondays[-5:]]


def test_selected_only_keeps_the_all_opportunities_denominator_beside_it(journaled):
    sel = run(journaled, view="family_slot", period="P2", list_id="A", basis="selected")
    c = cell(sel, "N:wide", "0917")
    assert c["n"] == 2
    assert c["all"]["n"] == 56 and c["all"]["nv"] == 56
    keep = [i for i, d in enumerate(DAYS) if d >= date(2025, 1, 10)]
    assert c["all"]["v"] == pytest.approx(
        round(float(np.mean([gross_of("N_wide_0917", i) for i in keep])), 2)
    )
    assert c["rec"] == 2 and c["sel"] == {"A": 2, "REF": 1}  # of the recorded days that were scored
    d = m.drill(
        m._read_cube(journaled),
        m.load_journal(journaled),
        view="family_slot",
        row="N:wide",
        col="0917",
        period="P2",
        list_id="A",
        basis="selected",
    )
    assert d["stats"]["all_opportunities"]["sessions"] == 56
    assert "all" not in cell(run(journaled, view="family_slot", period="P2"), "N:wide", "0917")


def test_zero_trade_days_are_counted_not_dropped(tmp_path):
    write(
        tmp_path,
        "N_wide_0917",
        gross=lambda n, i: 0.0 if i % 10 == 0 else 100.0,
        trades=lambda n, i: 0 if i % 10 == 0 else 2,
    )
    write_days(tmp_path)
    resp = run(tmp_path, view="family_slot", period="P2")
    c = cell(resp, "N:wide", "0917")
    keep = [i for i, d in enumerate(DAYS) if d >= date(2025, 1, 10)]
    assert c["zt"] == len([i for i in keep if i % 10 == 0])
    assert c["n"] == len(keep)  # still pooled as zeros, like the research
    d = m.drill(
        m._read_cube(tmp_path),
        m.load_journal(tmp_path),
        view="family_slot",
        row="N:wide",
        col="0917",
        period="P2",
    )
    assert d["stats"]["zero_trade_days"] == c["zt"]
    assert sum(x["n_no_trade"] for x in d["days"]) == c["zt"]


def test_thin_cells_do_not_set_the_colour_scale_and_the_date_view_says_it_clips(tmp_path):
    write(tmp_path, "N_wide_0917", gross=lambda n, i: 100.0)
    write(tmp_path, "N_wide_0932", days=DAYS[10:13], gross=lambda n, i: 9000.0)  # 3 sessions: thin
    write_days(tmp_path)
    resp = run(tmp_path, view="family_slot", period="P2")
    assert cell(resp, "N:wide", "0932")["thin"] is True
    assert resp["scale"]["limit"] == 100.0 and resp["scale"]["thin_excluded"] is True
    only_thin = run(tmp_path, view="family_slot", period="P2", min_n=1000)
    assert only_thin["scale"]["limit"] == 9000.0  # nothing solid: the scale falls back to all
    date_view = run(tmp_path, view="date_slot", period="P2")
    assert date_view["scale"]["percentile"] == 95.0


def test_the_stop_rate_denominator_is_the_strategy_days_it_has_results_for(tmp_path):
    # results on 12 of the 30 days only; 3 of them stopped: the rate is 3 / 12, not 3 / 30
    days = DAYS[10:40]
    have = days[::2][:12]
    write(
        tmp_path,
        "N_wide_0917",
        days=have,
        stops=lambda n, i: "overall SL at 10:00" if i < 3 else "",
    )
    write(tmp_path, "N_wide_0932", days=days)  # defines the other days
    write_days(tmp_path)
    c = cell(run(tmp_path, view="family_slot", period="P2"), "N:wide", "0917")
    assert c["n"] == 12 and c["m"]["stop_rate"] == pytest.approx(0.25)
