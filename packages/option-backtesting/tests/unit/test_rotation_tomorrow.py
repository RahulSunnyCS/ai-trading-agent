"""The "tomorrow" part of the evening result: expected picks and the stored-history helpers."""

from datetime import date

from option_backtesting.rotation import tomorrow


def _row(
    day, weekday, dte_n, dte_s, a, b=None, c=None, scored=True, source="reconstructed", status=""
):
    def block(v):
        return None if v is None else {"per_lot_day": v}

    return {
        "day": day,
        "weekday": weekday,
        "scored": scored,
        "source": source,
        "status": status,
        "dte": {"NIFTY": dte_n, "SENSEX": dte_s},
        "lists": {
            "A": block(a),
            "B": block(b if b is not None else a),
            "C": block(c if c is not None else a),
        },
    }


def _history(n=60):
    rows = []
    for i in range(n):
        d = date.fromordinal(date(2026, 1, 1).toordinal() + i).isoformat()
        thursday = i % 5 == 3
        rows.append(
            _row(
                d,
                "Thu" if thursday else "Mon",
                "3",
                "0" if thursday else "2",
                100.0 if thursday else -50.0,
            )
        )
    return rows


def test_next_session_skips_weekend_and_holidays():
    assert tomorrow.next_session(date(2026, 10, 15), {}) == date(2026, 10, 16)
    assert tomorrow.next_session(date(2026, 10, 16), {}) == date(2026, 10, 19)
    assert tomorrow.next_session(date(2026, 10, 16), {date(2026, 10, 19): "holiday"}) == date(
        2026, 10, 20
    )


def test_the_rows_are_fixed_in_advance_and_the_same_on_an_expiry_day():
    expiry = [c.label for c in tomorrow.conditions("Thu", "3", "0")]
    assert expiry == ["all days", "Thu sessions", "NIFTY 3 / SENSEX 0 weekdays to expiry"]
    plain = [c.label for c in tomorrow.conditions("Mon", "2", "1")]
    assert plain == ["all days", "Mon sessions", "NIFTY 2 / SENSEX 1 weekdays to expiry"]


def test_build_counts_only_scored_days_before_the_target_day():
    rows = _history() + [
        _row("2026-03-30", "Thu", "3", "0", 9999.0),
        _row("2026-01-02", "Thu", "3", "0", None, scored=False),
    ]
    t = tomorrow.build(date(2026, 3, 1), rows, "Thu", "3", "0")
    by_label = {label: (n, stats) for label, n, stats in t.rows}
    n, stats = by_label["NIFTY 3 / SENSEX 0 weekdays to expiry"]
    assert n == 12  # the Thursdays; the 2026-03-30 row is after the day
    assert stats["C"] == (1.0, 100.0)
    assert by_label["all days"][0] == 59


def test_conditions_with_too_few_days_are_dropped():
    t = tomorrow.build(date(2026, 3, 1), _history(8), "Thu", "3", "0")
    assert t.rows == []  # 8 sessions < MIN_DAYS for every condition


def _picks(a_core, c_core):
    return {"A": (a_core, []), "C": (c_core, [])}


def test_expected_picks_carry_probabilities_and_probable_changes():
    order = ["low", "mid", "high"]
    base = _picks(["s1", "s2", "s3"], ["s1", "s2", "s3"])
    by_band = {
        "low": _picks(["s9", "s2", "s3"], ["s9", "s2", "s3"]),
        "mid": base,
        "high": _picks(["s1", "s2", "s7"], ["s1", "s2", "s7"]),
    }
    e = tomorrow.build_expected(base, by_band, order, "mid", {"low": 0.2, "mid": 0.7, "high": 0.1})
    assert abs(e.same - 0.7) < 1e-9
    assert abs(e.likelihood["A"]["s1"] - 0.8) < 1e-9  # in mid and high
    assert abs(e.likelihood["A"]["s3"] - 0.9) < 1e-9  # in low and mid
    labels = {s.label: s for s in e.scenarios}
    assert abs(labels["calmer open"].probability - 0.2) < 1e-9
    assert labels["calmer open"].changes["A"] == (["s9"], ["s1"])
    assert labels["more volatile open"].changes["C"] == (["s7"], ["s3"])


def test_history_says_how_many_days_were_recorded_forward_and_how_many_re_scored():
    rows = _history()
    rows[-1] = {**rows[-1], "source": "recorded"}
    rows[-2] = {**rows[-2], "source": "recorded"}
    t = tomorrow.build(date(2026, 3, 2), rows, "Thu", "3", "0")
    assert (t.sessions, t.forward) == (60, 2)


def test_a_late_recording_and_a_day_missing_a_list_are_not_used():
    rows = _history() + [
        _row("2026-02-20", "Mon", "2", "2", 5000.0, source="recorded", status="late"),
        _row("2026-02-21", "Mon", "2", "2", 5000.0, c=None, source="recorded"),
    ]
    rows[-1]["lists"]["C"] = None
    t = tomorrow.build(date(2026, 3, 2), rows, "Mon", "2", "2")
    assert t.sessions == 60  # neither extra row counts
    assert t.forward == 0


def test_the_fixed_base_is_shown_next_to_the_lists_over_the_same_days():
    rows = _history()
    base = {r["day"]: 50.0 for r in rows}
    t = tomorrow.build(date(2026, 3, 2), rows, "Thu", "3", "0", base)
    by_label = {label: stats for label, _, stats in t.rows}
    assert by_label["all days"]["base"] == (1.0, 50.0)
    assert t.base_days == 60
    without = tomorrow.build(date(2026, 3, 2), rows, "Thu", "3", "0")
    assert all("base" not in stats for _, _, stats in without.rows)


def test_runners_up_are_the_best_unpicked_widesl_and_dir():
    import numpy as np

    from option_backtesting.rotation.score import Picks, runners_up

    names = ["N_wide_0917", "N_wide_0932", "N_ditm1_0917", "N_ditm1_0932", "N_buy_1117"]
    comp = np.array([5.0, 1.0, 4.0, 3.0, 9.0])
    picks = Picks(["N_wide_0917", "N_ditm1_0917"], ["N_buy_1117"], False, {})
    assert runners_up(comp, names, picks) == {"wide": "N_wide_0932", "dir": "N_ditm1_0932"}
    assert runners_up(comp, names[:3], Picks(["N_wide_0917", "N_wide_0932"], [], False, {})) == {
        "wide": None,
        "dir": "N_ditm1_0917",
    }


def test_the_expected_picks_rank_core_alone_or_with_a_tracks_variants(monkeypatch):
    """`expected_picks` ranks Core-298 alone, or Core-298 plus a track's variants, on one code
    path (the T1 universe is the only difference)."""
    import contextlib

    from option_backtesting.rotation import attrs as attrs_mod
    from option_backtesting.rotation import pick

    seen = []

    def fake_load_history(day, root, names):
        seen.append(list(names))
        raise RuntimeError("stop once the universe is chosen")

    monkeypatch.setattr(pick, "load_history", fake_load_history)
    monkeypatch.setattr(attrs_mod, "vix_close_from_lake", lambda r, d: 14.0)
    for track in (None, "t1"):
        with contextlib.suppress(RuntimeError):
            tomorrow.expected_picks(date(2026, 10, 19), None, "0", "2", date(2026, 10, 16), track)
    core, with_t1 = seen
    assert len(core) == 298 and len(with_t1) == 298 + 223
    assert set(core) < set(with_t1)
