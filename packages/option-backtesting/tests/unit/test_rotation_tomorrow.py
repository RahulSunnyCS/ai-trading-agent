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
    assert "Steady" in text and "Calendar" in text and "Adaptive" in text
