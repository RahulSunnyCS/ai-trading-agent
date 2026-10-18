"""BL-051 Phase 2: This week's view from the journal, the kept message, the rules report."""

import json

import pandas as pd
from fastapi.testclient import TestClient

from momentum_backtesting import api, live_rules, this_week
from momentum_backtesting.engine import IDLE


def _entry(entry_id, config_id, run_kind, signal, week="2026-12-04"):
    return {
        "entry_id": entry_id,
        "config_id": config_id,
        "run_kind": run_kind,
        "week": week,
        "recorded_at": f"2026-12-04T13:{entry_id:02d}:00Z",
        "signal": json.dumps(signal),
    }


def _favourite(id_, name, status, dataset="etf", **extra):
    return {
        "id": id_,
        "name": name,
        "status": status,
        "active": extra.pop("active", False),
        "group": extra.pop("group", None),
        "member_of": extra.pop("member_of", None),
        "config": {"dataset": dataset, **extra},
    }


ETF_FINAL = {
    "week": "2026-12-04",
    "explain": "Rebalance week.",
    "rows": [
        {"asset": "Gold", "action": "BUY", "rank": 1, "previous_rank": 4, "held": False},
        {"asset": "IT", "action": "SELL", "rank": 9, "previous_rank": 3, "held": True},
        {"asset": "Bank", "action": "HOLD", "rank": 2, "previous_rank": 2, "held": True},
        {"asset": "Pharma", "action": "", "rank": 3, "previous_rank": 5, "held": False},
    ],
    "weights": {"IT": 0.5, "Bank": 0.5},
}
ETF_PREVIEW = {
    **ETF_FINAL,
    "rows": [*ETF_FINAL["rows"][1:3], {"asset": "Metal", "action": "BUY", "rank": 1}],
}


def test_an_ungrouped_favourite_card_has_its_trades_ranks_and_what_the_final_changed():
    etf = _favourite("e1", "ETF Core", "paper", exit_rank=5, active=True)
    rows = [_entry(1, "e1", "preview", ETF_PREVIEW), _entry(2, "e1", "final", ETF_FINAL)]
    (card,) = this_week.week_view("2026-12-04", rows, [], [etf], [])
    assert card["headline"] and card["run"] == "final" and card["trades"] == 2
    assert [(r["asset"], r["action"], r["rank_prev"]) for r in card["rows"]] == [
        ("Gold", "BUY", 4),
        ("IT", "SELL", 3),
        ("Bank", "HOLD", 2),
    ]
    assert card["exit_rank"] == 5
    assert card["since_preview"] == {
        "added": [{"asset": "Gold", "action": "BUY"}],
        "dropped": [{"asset": "Metal", "action": "BUY"}],
    }
    assert card["edge"]["weakest_held"][0]["asset"] == "IT"
    assert card["edge"]["strongest_not_held"][0]["asset"] == "Gold"


def test_a_group_card_is_combined_from_its_sleeves_and_names_the_next_sleeve_to_trade():
    def sleeve(target, on_cadence, nxt):
        return {
            "week": "2026-12-04",
            "rows": [
                {"asset": a, "action": "HOLD", "rank": i + 1, "held": True}
                for i, a in enumerate(target)
            ],
            "weights": target,
            "target_weights": target,
            "sleeve_value": 1.0,
            "rebalance": {"on_cadence": on_cadence, "every": 4, "next": nxt},
        }

    members = [
        _favourite("a", "Ens a", None, "broad", member_of="g"),
        _favourite("b", "Ens b", None, "broad", member_of="g"),
    ]
    group = {
        **_favourite("g", "Ensemble", "paper", "broad", active=True, group=["a", "b"]),
        "members": members,
    }
    rows = [
        _entry(1, "a", "final", sleeve({"X": 0.8, IDLE: 0.2}, True, "2027-01-01")),
        _entry(2, "b", "final", sleeve({"Y": 1.0}, False, "2026-12-11")),
    ]
    cards = this_week.week_view("2026-12-04", rows, [], [group, *members], [group])
    assert [c["id"] for c in cards] == ["g"]  # sleeves live inside their group
    (card,) = cards
    assert card["group"] and card["run"] == "final" and card["cash"] == 0.1
    assert card["held"] == ["X", "Y"]
    assert card["edge"]["sleeve"] == "Ens b" and card["edge"]["on"] == "2026-12-11"


def test_a_group_with_a_sleeve_not_recorded_yet_says_so():
    members = [
        _favourite("a", "Ens a", None, "broad", member_of="g"),
        _favourite("b", "Ens b", None, "broad", member_of="g"),
    ]
    group = {**_favourite("g", "Ensemble", "paper", "broad", group=["a", "b"]), "members": members}
    rows = [_entry(1, "a", "final", {"week": "2026-12-04", "rows": [], "weights": {}})]
    (card,) = this_week.week_view("2026-12-04", rows, [], [group, *members], [group])
    assert card["blocked"] == "Not recorded yet for 1 of 2 sleeves: Ens b"


def test_favourites_share_names_with_the_headline_and_the_headline_comes_first():
    head = _favourite("h", "Head", "paper", active=True)
    other = _favourite("o", "Other", "watching")
    rows = [
        _entry(
            1, "o", "final", {"week": "2026-12-04", "rows": [], "weights": {"A": 0.5, "C": 0.5}}
        ),
        _entry(
            2, "h", "final", {"week": "2026-12-04", "rows": [], "weights": {"A": 0.5, "B": 0.5}}
        ),
    ]
    cards = this_week.week_view("2026-12-04", rows, [], [other, head], [])
    assert [c["id"] for c in cards] == ["h", "o"]
    assert cards[0]["shared_with_headline"] is None and cards[1]["shared_with_headline"] == 1


def test_messages_are_kept_and_the_sent_one_wins(tmp_path):
    for sent, title in ((False, "Preview"), (True, "Final"), (False, "Rerun")):
        this_week.save_message(
            tmp_path, week="2026-12-04", run="final", title=title, body="b", sent=sent, headline="H"
        )
    messages = this_week.load_messages(tmp_path)
    assert [m["title"] for m in messages] == ["Preview", "Final", "Rerun"]
    assert this_week.message_for(messages, "2026-12-04")["title"] == "Final"
    assert this_week.message_for(messages, "2026-11-27") is None


def test_the_rules_report_carries_its_numbers_and_is_kept_for_the_dashboard(tmp_path):
    rules = live_rules.load()
    weeks = pd.date_range("2026-10-02", periods=6, freq="W-FRI")
    followed = pd.Series([1.0, 1.05, 1.1, 1.0, 1.02, 1.04], index=weeks)
    bench = pd.Series([1.0, 1.01, 1.02, 1.0, 1.01, 1.02], index=weeks)
    report = live_rules.evaluate(rules, followed, bench)
    assert report.numbers["weeks"] == report.weeks
    assert round(report.numbers["drawdown"], 4) == round(1.04 / 1.1 - 1, 4)
    assert report.numbers["min_paper_weeks"] == rules["money_gate"]["min_paper_weeks"]
    live_rules.save_last(report, "info", "ok", tmp_path)
    saved = live_rules.load_last(tmp_path)
    assert saved["numbers"]["exit_at"] == rules["drawdown"]["exit_at"]
    assert [f["rule"] for f in saved["findings"]] == ["drawdown", "trailing", "money_gate"]


def test_the_week_endpoint_works_before_anything_is_recorded():
    client = TestClient(api.create_app())
    body = client.get("/api/week").json()
    assert body["favourites"] == [] and body["message"] is None and body["weeks"] == []
    assert body["week"] == body["target_week"]
    assert client.get("/api/live-rules").json() == {"report": None, "job": None}


def test_weekly_status_carries_the_schedulers_exit_code(tmp_path, monkeypatch):
    import sqlite3

    monkeypatch.setenv("SCHEDULER_STATE_DIR", str(tmp_path))
    with sqlite3.connect(tmp_path / "scheduler.db") as db:
        db.execute(
            "CREATE TABLE runs (id INTEGER PRIMARY KEY, job TEXT, trigger TEXT, scheduled_for TEXT,"
            " started_at TEXT, ended_at TEXT, exit_code INTEGER, attempts INTEGER, pid INTEGER,"
            " log_path TEXT, error TEXT)"
        )
        db.execute(
            "INSERT INTO runs (job, started_at, ended_at, exit_code) VALUES "
            "('momentum-stock-ingest', 'a', '2026-12-04T13:58:00Z', 0),"
            "('momentum-stock-ingest', 'b', '2026-12-04T14:01:00Z', 1)"
        )
    runs = api._scheduler_last_runs()
    assert runs["momentum-stock-ingest"] == ("2026-12-04T14:01:00Z", 1)


def test_the_paper_start_week_is_all_buys_and_sleeves_are_numbered_from_it():
    def signal(on, nxt):
        return {
            "week": "2026-12-04",
            "rows": [
                {"asset": "AAA", "action": "ADD", "rank": 1, "held": True},
                {"asset": "OLD", "action": "SELL", "rank": 9, "held": True},
            ],
            "weights": {"AAA": 0.5, "OLD": 0.5},
            "target_weights": {"AAA": 1.0},
            "rebalance": {"on_cadence": on, "every": 2, "offset": 0 if on else 1, "next": nxt},
        }

    group = {
        **_favourite("g1", "Duo", "paper", "broad", group=["a", "b"], active=True),
        "members": [
            _favourite("a", "Duo · Friday 1 of 2", None, "broad", member_of="g1"),
            _favourite("b", "Duo · Friday 2 of 2", None, "broad", member_of="g1"),
        ],
    }
    # Sleeve "Friday 2 of 2" is the one that trades this Friday in the saved runs' own numbering.
    rows = [
        _entry(1, "a", "final", signal(False, "2026-12-11")),
        _entry(2, "b", "final", signal(True, "2026-12-18")),
    ]
    plain = this_week.week_view("2026-12-04", rows, [], [group], [group])[0]
    assert any(r["action"] == "SELL" for r in plain["rows"]) and not plain["first_week"]
    assert [s["name"] for s in plain["sleeves"]] == ["Duo · Friday 1 of 2", "Duo · Friday 2 of 2"]

    first = this_week.week_view("2026-12-04", rows, [], [group], [group], start_week="2026-12-04")[
        0
    ]
    assert first["first_week"] and [r["action"] for r in first["rows"]] == ["BUY"]
    assert first["trades"] == 1 and first["rows"][0]["asset"] == "AAA"
    # The sleeve that trades on the start Friday is now Friday 1; the saved names are unchanged.
    assert [(s["name"], s["on_cadence"]) for s in first["sleeves"]] == [
        ("Duo · Friday 1 of 2", True),
        ("Duo · Friday 2 of 2", False),
    ]
    assert first["sleeves"][0]["id"] == "b"

    # A later week keeps the numbering but is not a first week: its trades are the real ones.
    later = this_week.week_view("2026-12-04", rows, [], [group], [group], start_week="2026-11-27")[
        0
    ]
    assert not later["first_week"] and any(r["action"] == "SELL" for r in later["rows"])


def test_paper_start_is_stored_and_must_be_a_friday(tmp_path):
    assert this_week.paper_start(tmp_path) is None
    assert this_week.set_paper_start("2026-10-16", tmp_path) == "2026-10-16"
    assert this_week.paper_start(tmp_path) == "2026-10-16"
    try:
        this_week.set_paper_start("2026-10-15", tmp_path)
    except ValueError as error:
        assert "not a Friday" in str(error)
    else:
        raise AssertionError("a Thursday was accepted")
    assert this_week.set_paper_start(None, tmp_path) is None
    assert this_week.paper_start(tmp_path) is None


def test_the_journal_view_shows_the_paper_start_as_all_buys_and_leaves_other_weeks_alone():
    signal = {
        "rows": [
            {"asset": "AAA", "action": "ADD", "rank": 2},
            {"asset": "BBB", "action": "BUY", "rank": 1},
            {"asset": "OLD", "action": "SELL", "rank": 9},
        ],
        "weights": {"AAA": 0.5, "OLD": 0.5},
        "target_weights": {"AAA": 0.6, "BBB": 0.4},
        "rebalance": {"on_cadence": True, "every": 4, "offset": 3, "next": "2026-11-06"},
    }

    def row(week):
        return {
            "week": week,
            "source": "favourite",
            "config_name": "Quad · Friday 4 of 4",
            "signal": json.dumps(signal),
            "holdings_before": json.dumps({"AAA": 0.5, "OLD": 0.5}),
            "settings": "{}",
        }

    first = api._journal_entry_view(row("2026-10-16"), "2026-10-16")
    assert first["first_week"] and first["holdings_before"] == {}
    assert [(a["asset"], a["action"]) for a in first["actions"]] == [("BBB", "BUY"), ("AAA", "BUY")]
    assert first["config_name"] == "Quad · Friday 1 of 4"
    later = api._journal_entry_view(row("2026-10-23"), "2026-10-16")
    assert not later["first_week"] and later["holdings_before"] == {"AAA": 0.5, "OLD": 0.5}
    assert any(a["action"] == "SELL" for a in later["actions"])
    before = api._journal_entry_view(row("2026-10-09"), "2026-10-16")
    assert before["config_name"] == "Quad · Friday 4 of 4" and not before["first_week"]
    assert api._journal_entry_view(row("2026-10-16"))["holdings_before"]["OLD"] == 0.5


def test_sleeves_without_a_friday_suffix_or_cadence_are_left_alone_under_a_paper_start():
    def signal(rebalance):
        return {
            "week": "2026-12-04",
            "rows": [{"asset": "AAA", "action": "ADD", "rank": 1, "held": True}],
            "weights": {"AAA": 1.0},
            "target_weights": {"AAA": 1.0},
            "rebalance": rebalance,
        }

    group = {
        **_favourite("g1", "Mix", "paper", "broad", group=["a", "b", "c"], active=True),
        "members": [
            # An ensemble sleeve: a cadence but no "Friday n of K" in its name.
            _favourite("a", "Mix 1281e8ed (4w, ph0)", None, "broad", member_of="g1"),
            # A monthly sleeve: a "Friday" name but no weekly cadence (every is None).
            _favourite("b", "Mix · Friday 2 of 4", None, "broad", member_of="g1"),
            _favourite("c", "Mix · Friday 1 of 4", None, "broad", member_of="g1"),
        ],
    }
    rows = [
        _entry(1, "a", "final", signal({"on_cadence": True, "every": 4, "next": "2026-12-11"})),
        _entry(2, "b", "final", signal({"on_cadence": True, "every": None, "next": None})),
        _entry(3, "c", "final", signal({"on_cadence": False, "every": 4, "next": "2026-12-11"})),
    ]
    card = this_week.week_view("2026-12-04", rows, [], [group], [group], start_week="2026-12-04")[0]
    names = {s["id"]: s["name"] for s in card["sleeves"]}
    assert names["a"] == "Mix 1281e8ed (4w, ph0)"  # no suffix to renumber
    assert names["b"] == "Mix · Friday 2 of 4"  # no cadence to number from
    assert names["c"] == "Mix · Friday 2 of 4"  # trades a week after the start: Friday 2
    assert this_week.sleeve_number("Mix · Friday 3 of 4") == 3
    assert this_week.sleeve_number("Phase 6 (4w, ph0)") is None


def test_the_first_week_of_an_ungrouped_favourite_is_all_buys_from_its_own_target():
    etf = _favourite("e1", "ETF Core", "paper", exit_rank=5, active=True)
    rows = [_entry(1, "e1", "final", ETF_FINAL)]
    (plain,) = this_week.week_view("2026-12-04", rows, [], [etf], [])
    assert any(r["action"] == "SELL" for r in plain["rows"]) and not plain["first_week"]
    (first,) = this_week.week_view("2026-12-04", rows, [], [etf], [], start_week="2026-12-04")
    assert first["first_week"] is True and first["trades"] == len(first["rows"])
    assert {r["action"] for r in first["rows"]} == {"BUY"}
    # Exactly the names the card holds after the week, each at its target weight.
    assert {r["asset"]: r["after"] for r in first["rows"]} == ETF_FINAL["weights"]


def test_a_premium_skip_keeps_its_label_and_reason_on_the_card_and_in_the_journal_view():
    """BL-136: the gate's row reaches This week and the Journal page with why it was not bought."""
    skip = {
        "asset": "Nasdaq 100",
        "action": "SKIP (premium)",
        "rank": 1,
        "previous_rank": 4,
        "held": False,
        "premium": 0.1689,
        "premium_limit": 0.05,
        "reason": "MON100 trades +16.9% above NAV (2026-10-15), over the 5% limit.",
    }
    signal = {**ETF_FINAL, "rows": [skip, *ETF_FINAL["rows"]]}
    etf = _favourite("e1", "ETF Core", "paper", exit_rank=5, active=True)
    (card,) = this_week.week_view("2026-12-04", [_entry(1, "e1", "final", signal)], [], [etf], [])
    row = card["rows"][0]
    assert row["action"] == "SKIP (premium)" and row["reason"].startswith("MON100")
    assert row["premium"] == 0.1689 and row["premium_limit"] == 0.05 and not row["held"]
    assert card["trades"] == 3  # the skip counts as something to read, like a trade
    assert card["edge"]["strongest_not_held"][0]["asset"] == "Nasdaq 100"
    view = api._journal_entry_view(
        {
            "week": "2026-12-04",
            "source": "favourite",
            "config_name": "ETF Core",
            "signal": json.dumps(signal),
            "holdings_before": json.dumps({"IT": 0.5, "Bank": 0.5}),
            "settings": "{}",
        }
    )
    first = view["actions"][0]
    assert first["action"] == "SKIP (premium)" and first["reason"].startswith("MON100")
    assert first["premium"] == 0.1689
    assert "reason" not in view["actions"][1]  # ordinary actions carry no reason


def test_the_paper_start_week_keeps_a_premium_skip_instead_of_reading_it_as_a_buy():
    """BL-136: the model's weights are ungated, so on the start Friday the name the gate refused
    is in `target_weights`; the first-week views must show the recorded skip, not a BUY."""
    skip = {
        "asset": "Nasdaq 100",
        "action": "SKIP (premium)",
        "rank": 1,
        "held": False,
        "premium": 0.1689,
        "premium_limit": 0.05,
        "reason": "MON100 trades +16.9% above NAV (2026-10-15), over the 5% limit.",
    }
    signal = {
        "week": "2026-12-04",
        "rows": [skip, {"asset": "Gold", "action": "BUY", "rank": 2, "held": False}],
        "weights": {},
        "target_weights": {"Nasdaq 100": 0.5, "Gold": 0.5},
    }
    actions = this_week.first_week_actions(signal)
    assert [(a["asset"], a["action"]) for a in actions] == [
        ("Gold", "BUY"),
        ("Nasdaq 100", "SKIP (premium)"),
    ]
    assert actions[1]["reason"].startswith("MON100") and actions[1]["premium"] == 0.1689
    view = api._journal_entry_view(
        {
            "week": "2026-12-04",
            "source": "favourite",
            "config_name": "ETF Core",
            "signal": json.dumps(signal),
            "holdings_before": json.dumps({}),
            "settings": "{}",
        },
        "2026-12-04",
    )
    assert view["first_week"] and [a["action"] for a in view["actions"]] == [
        "BUY",
        "SKIP (premium)",
    ]
    etf = _favourite("e1", "ETF Core", "paper", exit_rank=5, active=True)
    (card,) = this_week.week_view(
        "2026-12-04", [_entry(1, "e1", "final", signal)], [], [etf], [], start_week="2026-12-04"
    )
    assert card["first_week"]
    by_asset = {r["asset"]: r for r in card["rows"]}
    assert by_asset["Gold"]["action"] == "BUY"
    assert by_asset["Nasdaq 100"]["action"] == "SKIP (premium)"
    assert by_asset["Nasdaq 100"]["reason"].startswith("MON100")
    assert not by_asset["Nasdaq 100"]["held"]
