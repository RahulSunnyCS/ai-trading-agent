"""The "tomorrow" section of the evening result: base rates from stored history, read-only."""

from datetime import date

from option_backtesting.rotation import tomorrow


def _row(day, weekday, dte_n, dte_s, a, b=None, c=None, scored=True):
    def block(v):
        return None if v is None else {"per_lot_day": v}

    return {
        "day": day,
        "weekday": weekday,
        "scored": scored,
        "source": "reconstructed",
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


def test_conditions_describe_an_expiry_day():
    labels = [c.label for c in tomorrow.conditions("Thu", "3", "0")]
    assert labels == ["all days", "Thu sessions", "SENSEX expiry day", "Thu and SENSEX expiry day"]
    plain = [c.label for c in tomorrow.conditions("Mon", "2", "1")]
    assert plain == ["all days", "Mon sessions", "NIFTY 2 / SENSEX 1 days to expiry"]


def test_build_counts_only_scored_days_before_the_target_day():
    rows = _history() + [
        _row("2026-03-30", "Thu", "3", "0", 9999.0),
        _row("2026-01-02", "Thu", "3", "0", None, scored=False),
    ]
    t = tomorrow.build(date(2026, 3, 1), rows, "Thu", "3", "0")
    by_label = {label: (n, stats) for label, n, stats in t.rows}
    n, stats = by_label["SENSEX expiry day"]
    assert n == 12  # the Thursdays; the 2026-03-30 row is after the day
    assert stats["A"] == (1.0, 100.0)
    assert by_label["all days"][0] == 59


def test_conditions_with_too_few_days_are_dropped():
    t = tomorrow.build(date(2026, 3, 1), _history(8), "Thu", "3", "0")
    assert t.rows == []  # 8 sessions < MIN_DAYS for every condition


def test_render_flags_thin_samples_and_says_it_is_not_a_forecast():
    t = tomorrow.build(date(2026, 3, 1), _history(), "Thu", "3", "0")
    text = tomorrow.render(t)
    assert "Tomorrow 2026-03-01 (Thu)" in text
    assert "SENSEX expiry day (12d (thin))" in text
    assert "not a forecast" in text
    assert "Steady" in text and "Adaptive" in text and "Calendar" not in text


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


def test_render_shows_the_picks_with_probabilities_and_no_vix_wording():
    order = ["low", "mid", "high"]
    base = _picks(["s1", "s2", "s3"], ["s1", "s2", "s4"])
    by_band = {"low": _picks(["s9", "s2", "s3"], ["s1", "s2", "s4"]), "mid": base, "high": base}
    e = tomorrow.build_expected(
        base, by_band, order, "mid", {"low": 0.25, "mid": 0.5, "high": 0.25}
    )
    t = tomorrow.Tomorrow(date(2026, 10, 15), "Thu", "4", "0", "calendar", [], {}, 10, e)
    text = tomorrow.render(t)
    assert "Expected picks if the conditions at the close stay the same:" in text
    assert "Steady: s1 (75%), s2 (100%), s3 (100%)" in text
    assert "calmer open (~25%): Steady +s9 -s1" in text
    assert "Adaptive +" not in text  # Adaptive does not change in that scenario
    assert "VIX" not in text and "Calendar" not in text
    assert "The final picks are recorded at 09:16." in text
