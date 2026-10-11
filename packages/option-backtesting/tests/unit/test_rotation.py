"""The forward journal's scoring, store and hash chain (BL-058). Pure numpy / tmp_path: no lake."""

from __future__ import annotations

import json
from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo

import numpy as np
import pytest
from trading_data import lake

from option_backtesting.rotation import attrs, journal, live, pick, store, update
from option_backtesting.rotation.lists import LISTS
from option_backtesting.rotation.pick import PickError, previous_data_day, record, score_lists
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


IST = ZoneInfo("Asia/Kolkata")
ATTRS = {"vix_open": 14, "vix_band": "13-15", "dte_n": "1", "dte_s": "2"}


def _weekdays(start: date, n: int) -> list[date]:
    out, d = [], start
    while len(out) < n:
        if d.weekday() < 5:
            out.append(d)
        d += timedelta(days=1)
    return out


def _collect(root, day):
    """Mark `day` collected for both indices (empty files: only existence is read)."""
    for u in ("NIFTY", "SENSEX"):
        for asset in ("option", "index"):
            p = lake.bars_1m_path(root, asset, u, day)
            p.parent.mkdir(parents=True, exist_ok=True)
            p.touch()


def _store(root, days, names=NAMES, seed=5):
    rng = np.random.default_rng(seed)
    for d in days:
        for name in names:
            store.append_result(
                name, {"day": d.isoformat(), "net": float(rng.normal(0, 1500))}, root
            )
        store.append_day({"day": d.isoformat(), "weekday": d.strftime("%a"), **ATTRS}, root)
        _collect(root, d)


@pytest.fixture
def seeded(tmp_path, monkeypatch):
    days = _weekdays(date(2026, 6, 1), 70)
    _store(tmp_path, days)
    monkeypatch.setattr(pick, "variant_names", lambda: NAMES)
    monkeypatch.setattr(pick, "code_commit", lambda: "test")
    monkeypatch.setattr(
        pick, "listed_dte_labels", lambda d: ({"dte_n": "1", "dte_s": "2"}, "master")
    )
    return tmp_path, days


def _at(day, hh, mm):
    return lambda: datetime(day.year, day.month, day.day, hh, mm, tzinfo=IST)


def test_previous_data_day_skips_weekends_holidays_and_excluded_days(tmp_path, monkeypatch):
    fri, mon_target = date(2026, 10, 9), date(2026, 10, 12)
    for d in (date(2026, 10, 7), date(2026, 10, 8), fri):
        _collect(tmp_path, d)
    _collect(tmp_path, date(2026, 10, 10))  # a Saturday session
    assert previous_data_day(tmp_path, mon_target) == fri
    # Friday excluded by data_quality -> the Thursday before it
    monkeypatch.setattr(attrs.quality, "excluded_days", lambda root, asset, name: {fri: "bad"})
    assert previous_data_day(tmp_path, mon_target) == date(2026, 10, 8)


def test_pick_refuses_when_results_lag_the_last_collected_day(seeded):
    root, days = seeded
    collected, target = _weekdays(days[-1] + timedelta(days=1), 2)
    _collect(root, collected)  # collected but never stored: the picks would be a day stale
    with pytest.raises(PickError, match="last collected trading day"):
        score_lists(target, 14.0, {"dte_n": "1", "dte_s": "2"}, root, NAMES)


def test_picks_use_only_days_before_the_target(seeded):
    root, days = seeded
    target = days[-1] + timedelta(days=1)
    while target.weekday() >= 5:
        target += timedelta(days=1)
    dte = {"dte_n": "1", "dte_s": "2"}
    before = score_lists(target, 14.0, dte, root, NAMES)
    # the target day and the day after get extreme stored results; neither may move the picks
    for d in (target, target + timedelta(days=1)):
        if d.weekday() >= 5:
            continue
        for name in NAMES:
            store.append_result(name, {"day": d.isoformat(), "net": 1e7}, root)
        store.append_day({"day": d.isoformat(), "weekday": d.strftime("%a"), **ATTRS}, root)
    assert score_lists(target, 14.0, dte, root, NAMES) == before


def test_record_writes_one_forward_entry_and_a_retry_is_refused(seeded):
    root, days = seeded
    target = days[-1] + timedelta(days=1)
    while target.weekday() >= 5:
        target += timedelta(days=1)
    result = record(target, root, vix_open=14.2, now_fn=_at(target, 9, 16))
    e = result.entry
    assert e["before_first_entry"] is True
    assert (e["vix_source"], e["dte_source"], e["commit"]) == ("given", "master", "test")
    assert e["universe"]["variants"] == len(NAMES)
    assert journal.verify(store.journal_path(root)) == []
    with pytest.raises(journal.AlreadyRecorded):
        record(target, root, vix_open=14.2, now_fn=_at(target, 9, 16))


def test_a_late_entry_is_flagged_not_forward_and_a_past_day_is_refused(seeded):
    root, days = seeded
    target = days[-1] + timedelta(days=1)
    while target.weekday() >= 5:
        target += timedelta(days=1)
    late = record(target, root, vix_open=14.2, now_fn=_at(target, 9, 40))
    assert late.entry["before_first_entry"] is False
    assert "NOT forward" in late.text
    with pytest.raises(PickError, match="not today"):
        record(target + timedelta(days=1), root, vix_open=14.2, now_fn=_at(target, 9, 16))
    # a dry run may name any day
    record(target + timedelta(days=1), root, vix_open=14.2, now_fn=_at(target, 9, 16), dry_run=True)


def test_nothing_is_recorded_when_the_vix_open_cannot_be_read(seeded, monkeypatch):
    root, days = seeded
    target = days[-1] + timedelta(days=1)
    while target.weekday() >= 5:
        target += timedelta(days=1)
    monkeypatch.setattr(pick, "vix_open_with_source", lambda d: (None, ""))
    with pytest.raises(PickError, match="could not be read"):
        record(target, root, now_fn=_at(target, 9, 16))
    assert journal.read(store.journal_path(root)) == []


def _fake_clock():
    state = {"t": 0.0, "sleeps": 0}

    def sleep(s):
        state["t"] += s
        state["sleeps"] += 1

    return state, sleep, lambda: state["t"]


def test_vix_open_polls_fyers_then_succeeds_without_calling_angel_one(monkeypatch):
    answers = iter([None, None, 15.28])
    monkeypatch.setattr(live, "_fyers_attempt", lambda d, client=None: next(answers))
    monkeypatch.setattr(
        live, "vix_open_angel", lambda d: pytest.fail("Angel One must not be called")
    )
    state, sleep, monotonic = _fake_clock()
    got = live.vix_open_with_source(date(2026, 10, 12), sleep=sleep, monotonic=monotonic)
    assert got == (15.28, "fyers") and state["sleeps"] == 2


def test_vix_open_goes_to_angel_one_at_once_without_a_fyers_token(monkeypatch):
    def no_token(d, client=None):
        raise live.FyersCredentialsError("no token")

    monkeypatch.setattr(live, "_fyers_attempt", no_token)
    monkeypatch.setattr(live, "vix_open_angel", lambda d: 15.3)
    state, sleep, monotonic = _fake_clock()
    got = live.vix_open_with_source(date(2026, 10, 12), sleep=sleep, monotonic=monotonic)
    assert got == (15.3, "angelone") and state["sleeps"] == 0


def test_vix_open_retries_through_fyers_errors_then_falls_back(monkeypatch):
    def flaky(d, client=None):
        raise ConnectionError("reset")

    monkeypatch.setattr(live, "_fyers_attempt", flaky)
    monkeypatch.setattr(live, "vix_open_angel", lambda d: None)
    state, sleep, monotonic = _fake_clock()
    got = live.vix_open_with_source(
        date(2026, 10, 12), wait_s=20, poll_s=5, sleep=sleep, monotonic=monotonic
    )
    assert got == (None, "") and state["sleeps"] == 4  # polled for the whole window, then gave up


def test_cli_exits_zero_on_a_retry_and_alerts_then_exits_two_on_a_crash(monkeypatch):
    from typer.testing import CliRunner

    from option_backtesting import notify
    from option_backtesting.rotation.cli import rotation_app

    sent = []
    monkeypatch.setattr(notify, "send", lambda n: sent.append(n))
    runner = CliRunner()

    def already(*a, **k):
        raise journal.AlreadyRecorded("2026-10-12 is already in the journal")

    monkeypatch.setattr(pick, "record", already)
    r = runner.invoke(rotation_app, ["pick", "--day", "2026-10-12"])
    assert r.exit_code == 0 and "already recorded" in r.output and sent == []

    def boom(*a, **k):
        raise KeyError("dte_n")

    monkeypatch.setattr(pick, "record", boom)
    r = runner.invoke(rotation_app, ["pick", "--day", "2026-10-12"])
    assert r.exit_code == 2
    assert len(sent) == 1 and "FAILED" in sent[0].title


def test_update_default_day_is_the_newest_collected_day_not_yet_stored(tmp_path, monkeypatch):
    monkeypatch.setattr(update, "variant_names", lambda: NAMES)
    days = _weekdays(date(2026, 10, 1), 6)  # Thu 1 .. Thu 8 (Oct 2026)
    _store(tmp_path, days[:-1])
    _collect(tmp_path, days[-1])
    assert update.default_day(tmp_path, today=days[-1] + timedelta(days=1)) == days[-1]
    _store(tmp_path, [days[-1]])
    assert update.default_day(tmp_path, today=days[-1] + timedelta(days=1)) is None


def test_a_torn_journal_line_is_reported_not_crashed_on_and_nothing_is_appended(tmp_path):
    path = tmp_path / "journal.jsonl"
    journal.append(path, {"day": "2026-10-12", "lists": {}})
    with path.open("a") as f:
        f.write('{"day": "2026-10-13", "lis')  # killed mid-write
    problems = journal.verify(path)
    assert len(problems) == 1 and "line 2" in problems[0]
    with pytest.raises(journal.JournalCorrupt):
        journal.append(path, {"day": "2026-10-14", "lists": {}})
    assert path.read_text().count("\n") == 1  # untouched


def test_an_entry_carries_a_digest_of_the_history_it_was_scored_on(seeded):
    root, days = seeded
    target = _weekdays(days[-1] + timedelta(days=1), 1)[0]
    first = record(target, root, vix_open=14.2, now_fn=_at(target, 9, 16), dry_run=True).entry
    again = record(target, root, vix_open=14.2, now_fn=_at(target, 9, 16), dry_run=True).entry
    assert first["inputs_sha"] == again["inputs_sha"] and first["inputs_days"] == len(days)
    # editing one stored result changes the digest
    path = store.results_dir(root) / f"{NAMES[0]}.csv"
    lines = path.read_text().splitlines()
    cells = lines[5].split(",")
    cells[1] = "123456.0"
    lines[5] = ",".join(cells)
    path.write_text("\n".join(lines) + "\n")
    edited = record(target, root, vix_open=14.2, now_fn=_at(target, 9, 16), dry_run=True).entry
    assert edited["inputs_sha"] != first["inputs_sha"]


def test_the_slow_reads_happen_before_the_vix_poll(seeded, monkeypatch):
    root, days = seeded
    target = _weekdays(days[-1] + timedelta(days=1), 1)[0]
    order = []
    monkeypatch.setattr(
        pick,
        "listed_dte_labels",
        lambda d: (order.append("dte") or {"dte_n": "1", "dte_s": "2"}, "master"),
    )
    monkeypatch.setattr(pick, "code_commit", lambda: order.append("commit") or "test")
    monkeypatch.setattr(
        pick, "vix_open_with_source", lambda d: (order.append("vix") or 14.2, "fyers")
    )
    record(target, root, now_fn=_at(target, 9, 16), dry_run=True)
    assert order == ["dte", "commit", "vix"]


def test_two_writers_cannot_both_append_the_same_variant_day(tmp_path):
    import threading

    wrote = []
    barrier = threading.Barrier(6)

    def go():
        barrier.wait()
        wrote.append(
            store.append_result("N_wide_0917", {"day": "2026-10-12", "net": 1.0}, tmp_path)
        )

    threads = [threading.Thread(target=go) for _ in range(6)]
    [t.start() for t in threads]
    [t.join() for t in threads]
    assert wrote.count(True) == 1
    assert (tmp_path / "rotation" / "results" / "N_wide_0917.csv").read_text().count(
        "2026-10-12"
    ) == 1


def _parquet(path, rows, columns):
    import duckdb

    path.parent.mkdir(parents=True, exist_ok=True)
    con = duckdb.connect()
    con.execute(f"CREATE TABLE t ({columns})")
    for r in rows:
        con.execute("INSERT INTO t VALUES (" + ",".join("?" * len(r)) + ")", list(r))
    con.execute(f"COPY t TO '{path}' (FORMAT parquet)")
    con.close()


def test_vix_open_is_the_0915_bar_and_a_gap_gives_none_not_a_later_bar(tmp_path):
    day = date(2026, 10, 12)
    vix = lake.bars_1m_path(tmp_path, "index", "INDIAVIX", day)
    t0915 = datetime(2026, 10, 12, 9, 15, tzinfo=IST)
    cols = "ts TIMESTAMPTZ, open DOUBLE"
    _parquet(vix, [(t0915, 15.28), (t0915 + timedelta(minutes=1), 15.31)], cols)
    assert attrs.vix_open_from_lake(tmp_path, day) == 15.28
    _parquet(
        vix, [(t0915 + timedelta(minutes=1), 15.31), (t0915 + timedelta(minutes=5), 15.4)], cols
    )
    assert attrs.vix_open_from_lake(tmp_path, day) is None  # 09:15 missing: not the 09:16 open
    row = attrs.day_attributes(tmp_path, day)
    assert row["vix_band"] == "unknown" and row["dte_n"] == "unknown"


def test_day_attributes_reads_the_nearest_listed_expiry_with_bars(tmp_path):
    day = date(2026, 10, 12)
    cols = "ts TIMESTAMPTZ, open DOUBLE, expiry DATE"
    ts = datetime(2026, 10, 12, 9, 15, tzinfo=IST)
    rows = [
        (ts, 1.0, date(2026, 10, 9)),  # already expired: not an upcoming expiry
        (ts, 1.0, date(2026, 10, 13)),
        (ts, 1.0, date(2026, 10, 20)),
    ]
    _parquet(lake.bars_1m_path(tmp_path, "option", "NIFTY", day), rows, cols)
    _parquet(
        lake.bars_1m_path(tmp_path, "option", "SENSEX", day), [(ts, 1.0, date(2026, 10, 15))], cols
    )
    _parquet(
        lake.bars_1m_path(tmp_path, "index", "INDIAVIX", day),
        [(ts, 14.0)],
        "ts TIMESTAMPTZ, open DOUBLE",
    )
    row = attrs.day_attributes(tmp_path, day)
    assert (row["dte_n"], row["dte_s"], row["vix_band"], row["weekday"]) == (
        "1",
        "3",
        "13-15",
        "Mon",
    )


def test_listed_dte_labels_reads_the_symbol_master(monkeypatch):
    from types import SimpleNamespace

    def master(segment):
        return segment

    def parse(text, names):
        exp = {"NSE_FO": date(2026, 10, 13), "BSE_FO": date(2026, 10, 15)}[text]
        return [
            SimpleNamespace(expiry=exp, option_type="CE"),
            SimpleNamespace(expiry=date(2026, 10, 9), option_type="PE"),
            SimpleNamespace(expiry=date(2026, 11, 26), option_type="FUT"),
        ]

    monkeypatch.setattr(live, "download_master", master)
    monkeypatch.setattr(live, "parse_master", parse)
    labels, source = live.listed_dte_labels(date(2026, 10, 12))
    assert (labels, source) == ({"dte_n": "1", "dte_s": "3"}, "master")


def test_update_day_writes_every_variant_once_and_the_day_row_last(tmp_path, monkeypatch):
    from types import SimpleNamespace

    day = date(2026, 10, 12)
    _collect(tmp_path, day)
    ts = datetime(2026, 10, 12, 9, 15, tzinfo=IST)
    _parquet(
        lake.bars_1m_path(tmp_path, "index", "INDIAVIX", day),
        [(ts, 15.0)],
        "ts TIMESTAMPTZ, open DOUBLE",
    )
    for u, e in (("NIFTY", date(2026, 10, 13)), ("SENSEX", date(2026, 10, 15))):
        _parquet(
            lake.bars_1m_path(tmp_path, "option", u, day),
            [(ts, 1.0, e)],
            "ts TIMESTAMPTZ, open DOUBLE, expiry DATE",
        )
    monkeypatch.setattr(update, "load_day", lambda root, u, d: u)
    monkeypatch.setattr(update, "load_legwise", lambda p: p.stem)
    monkeypatch.setattr(update, "default_reference_data", lambda: None)
    monkeypatch.setattr(
        update,
        "simulate_day",
        lambda strat, loaded, ref, sizing: SimpleNamespace(
            gross=100.0, costs=13.0, worst_mtm=-5.0, stopped_by=None, trades=[1, 2]
        ),
    )
    first = update.update_day(day, tmp_path, log=lambda s: None, names=NAMES)
    assert (first["written"], first["already"], first["errors"]) == (len(NAMES), 0, [])
    assert store.read_net("N_wide_0917", tmp_path) == {day: 87.0}
    assert store.read_days(tmp_path)[day]["dte_n"] == "1"
    again = update.update_day(day, tmp_path, log=lambda s: None, names=NAMES)
    assert (again["written"], again["already"]) == (0, len(NAMES))


def test_update_day_skips_a_day_either_index_lacks(tmp_path):
    day = date(2026, 10, 12)  # nothing in the lake
    r = update.update_day(day, tmp_path, log=lambda s: None, names=NAMES)
    assert r["skipped"] and r["written"] == 0
    assert store.read_days(tmp_path) == {}
