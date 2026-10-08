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
