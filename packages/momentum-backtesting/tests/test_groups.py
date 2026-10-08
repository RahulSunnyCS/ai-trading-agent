"""BL-051: a favourite group's combined signal (`groups.py`)."""

import pandas as pd

from momentum_backtesting import choose, groups


def _member(id_, weights, target, rows, value=1.0, on_cadence=True):
    return {
        "id": id_,
        "name": f"Sleeve {id_}",
        "signal": {
            "weights": weights,
            "target_weights": target,
            "rows": rows,
            "sleeve_value": value,
            "rebalance": {"on_cadence": on_cadence, "every": 4, "next": "2026-12-11"},
        },
    }


def test_sleeves_are_weighted_by_their_value_since_the_last_reset():
    members = [
        _member("a", {"X": 1.0}, {"X": 1.0}, [{"asset": "X", "action": "HOLD", "rank": 1}], 1.5),
        _member("b", {"Y": 1.0}, {"Y": 1.0}, [{"asset": "Y", "action": "HOLD", "rank": 2}], 0.5),
    ]
    signal = groups.combine({"name": "G"}, members, "2026-12-04")
    assert signal["target_weights"] == {"X": 0.75, "Y": 0.25}
    assert [r["action"] for r in signal["rows"]] == ["HOLD", "HOLD"]


def test_actions_come_from_the_sleeves_that_trade_not_from_price_drift():
    members = [
        _member(
            "a",
            {"OLD": 0.5, "KEEP": 0.5},
            {"NEW": 0.5, "KEEP": 0.5},
            [
                {"asset": "OLD", "action": "SELL", "rank": 30},
                {"asset": "NEW", "action": "BUY", "rank": 4},
                {"asset": "KEEP", "action": "HOLD", "rank": 2},
            ],
        ),
        # Off week: its weights drifted with prices, but it made no trade.
        _member(
            "b",
            {"KEEP": 0.6, "IDLE": 0.4},
            {"KEEP": 0.7, "IDLE": 0.3},
            [{"asset": "KEEP", "action": "HOLD", "rank": 2}],
            on_cadence=False,
        ),
    ]
    signal = groups.combine({"name": "G"}, members, "2026-12-04")
    actions = {r["asset"]: r["action"] for r in signal["rows"]}
    assert actions == {"OLD": "SELL", "NEW": "BUY", "KEEP": "HOLD"}
    assert signal["cash"] == 0.15
    keep = next(r for r in signal["rows"] if r["asset"] == "KEEP")
    assert keep["sleeves"] == ["a", "b"]


def test_partial_sells_and_buys_are_trims_and_adds():
    members = [
        _member("a", {"X": 1.0}, {}, [{"asset": "X", "action": "SELL", "rank": 25}]),
        _member("b", {"X": 1.0}, {"X": 1.0}, [{"asset": "X", "action": "HOLD", "rank": 25}]),
    ]
    (row,) = groups.combine({"name": "G"}, members, "2026-12-04")["rows"]
    assert row["action"] == "TRIM" and row["before"] == 1.0 and row["after"] == 0.5


def test_the_message_says_which_sleeves_trade_or_when_the_next_one_does():
    trading = groups.combine(
        {"name": "Ensemble"},
        [
            _member(
                "a",
                {"X": 1.0},
                {"Y": 1.0},
                [
                    {"asset": "X", "action": "SELL", "rank": 22},
                    {"asset": "Y", "action": "BUY", "rank": 3},
                ],
            )
        ],
        "2026-12-04",
    )
    note = groups.notification(trading)
    assert note.severity == "action_required"
    assert "Sleeves trading: Sleeve a (every 4 wk)" in note.body
    assert "• X — SELL · rank 22" in note.body and "• Y — BUY · rank 3" in note.body
    assert note.title == "Momentum FINAL — Ensemble — week of 04 Dec 2026"

    quiet = groups.combine(
        {"name": "Ensemble"},
        [
            _member(
                "a",
                {"X": 1.0},
                {"X": 1.0},
                [{"asset": "X", "action": "HOLD", "rank": 2}],
                on_cadence=False,
            )
        ],
        "2026-12-04",
    )
    note = groups.notification(quiet)
    assert note.severity == "info"
    assert "No sleeve rebalances this week. Next: Sleeve a on 11 Dec." in note.body


def test_sleeve_value_uses_the_same_april_reset_as_the_ensemble_curve():
    dates = pd.date_range("2025-01-03", "2026-12-04", freq="W-FRI")
    values = [100 * 1.01**i for i in range(len(dates))]
    value = groups.sleeve_value([d.strftime("%Y-%m-%d") for d in dates], values)
    reset = groups.reset_weeks(dates)[-1]
    assert reset == dates[dates < pd.Timestamp("2026-04-01")][-1]
    assert value == values[-1] / values[list(dates).index(reset)]
    curves = pd.DataFrame({"a": values, "b": values}, index=dates)
    ensemble = choose.ensemble_curve(curves, ["a", "b"])
    assert ensemble.iloc[-1] / ensemble.loc[reset] == value


def test_sleeve_value_is_unknown_without_matching_dates():
    assert groups.sleeve_value([], [100.0, 101.0]) is None
    assert groups.sleeve_value(["2026-12-04"], [100.0, 101.0]) is None
