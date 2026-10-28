"""BL-139 Phase 2: a leg-wise strategy as the body of Quantiply's create call (`POST /algos`).

The fixtures in `tests/fixtures/quantiply/` are calls Quantiply's web app made on 2026-10-19, with
the user and broker ids removed: the owner's create of `N_OTM1_SL115_TSL15%10%_9_17`, Quantiply's
own sample algos (closest premium, re-entry at cost, range breakout) and the owner's own
`N_ITM1_SL21_3000`, whose execution settings every export copies."""

from __future__ import annotations

import json
from datetime import date
from pathlib import Path

import pytest

from option_backtesting.legwise.quantiply import (
    EXECUTION,
    Unmappable,
    comparable,
    leg_uid,
    to_quantiply,
)
from option_backtesting.legwise.schema import LegwiseStrategy, load_legwise
from option_backtesting.rotation import algtst_export as ax
from option_backtesting.rotation import quantiply_export as qx
from option_backtesting.rotation.variants import STRATEGIES_DIR

FIXTURES = Path(__file__).resolve().parents[1] / "fixtures" / "quantiply"


def _fixture(name: str) -> dict:
    return json.loads((FIXTURES / f"{name}.json").read_text())


def _spec(**over) -> LegwiseStrategy:
    leg = {
        "lots": 1,
        "position": "sell",
        "expiry": "weekly",
        "strike": {"strike_type": "OTM1"},
        "stop_loss": {"percent": 115},
    }
    leg.update(over.pop("leg", {}))
    s = {
        "id": "fixture",
        "underlying": "NIFTY",
        "entry_time": "09:17",
        "exit_time": "15:28",
        "legs": [
            {"id": "ce", "option_type": "CE", **leg},
            {"id": "pe", "option_type": "PE", **leg},
        ],
        "overall": {"stop_loss_inr": 2500},
    }
    s.update(over)
    return LegwiseStrategy.model_validate(s)


def _no_ids(legs: list[dict]) -> list[dict]:
    return [{k: v for k, v in leg.items() if k != "id"} for leg in legs]


def test_owners_capture_legs_and_times_match():
    """The algo the owner saved for the capture: OTM1, SL 115 %, trail 15 % / 10 %, MTM 2,500."""
    sent = _fixture("create_request")
    e = to_quantiply(_spec(leg={"trail_sl": {"percent": [15, 10]}}), sent["name"], ["TUE", "MON"])
    assert e.body["code"] == sent["code"] and e.body["day"] == ["TUE", "MON"]
    cfg, want = e.body["configurations"], sent["configurations"]
    assert _no_ids(cfg["legs"]) == _no_ids(want["legs"])
    for key in (
        "underlying",
        "startTime",
        "endTime",
        "stoploss",
        "legsAction",
        "tradingType",
        "trailingInterval",
        "isReEntryEnabled",
        "isWaitAndTradeEnabled",
        "endDay",
    ):
        assert cfg[key] == want[key], key
    assert e.unconfirmed == []


def test_execution_settings_are_the_owners_own_algo():
    """Owner, 2026-10-19: the execution settings of N_ITM1_SL21_3000."""
    owner = _fixture("owner_n_itm1_sl21_3000")["configurations"]
    for key, value in EXECUTION.items():
        assert owner[key] == value, key
    assert {leg["product"] for leg in owner["legs"]} == {"D"}


def test_owners_itm1_recost_algo_maps_leg_for_leg():
    owner = _fixture("owner_n_itm1_sl21_3000")["configurations"]
    e = to_quantiply(
        _spec(
            leg={
                "strike": {"strike_type": "ITM1"},
                "stop_loss": {"percent": 21},
                "reentry_on_sl": {"mode": "cost", "count": 1},
            },
            overall={"stop_loss_inr": 3000},
        ),
        "N_ITM1_SL21_3000",
        ["TUE"],
    )
    cfg = e.body["configurations"]
    assert _no_ids(cfg["legs"]) == _no_ids(owner["legs"])
    assert cfg["isReEntryEnabled"] is True and cfg["stoploss"] == owner["stoploss"]


def test_closest_premium_is_quantiplys_premium_selection():
    sample = _fixture("entry_by_premium")["configurations"]["legs"][0]
    leg = to_quantiply(_spec(leg={"strike": {"closest_premium": 80}}), days=["MON"]).body[
        "configurations"
    ]["legs"][0]
    assert leg["selectionType"] == sample["selectionType"] == "PREMIUM"
    assert leg["premium"] == sample["premium"]
    assert "strike" not in leg


def test_range_breakout_is_quantiplys_orb_on_the_instrument():
    sample = _fixture("range_breakout")["configurations"]
    spec = _spec(
        entry_time="09:35",
        exit_time="15:14",
        leg={
            "position": "buy",
            "strike": {"closest_premium": 100},
            "stop_loss": {"percent": 25},
            "range_breakout": {"until": "09:45", "side": "high"},
        },
    )
    cfg = to_quantiply(spec, days=["MON"]).body["configurations"]
    assert cfg["isORBEnabled"] is True and cfg["orbEndTime"] == "09:45:00"
    assert cfg["startTime"] == "09:35:00"
    buy_sample = next(leg for leg in sample["legs"] if leg["transactionType"] == "B")
    assert (
        cfg["legs"][0]["orb"] == buy_sample["orb"] == {"type": "ORB_INSTRUMENT", "entryAt": "HIGH"}
    )
    assert cfg["legs"][0]["transactionType"] == "B"


def test_re_entry_at_cost_is_quantiplys_recost():
    sample = _fixture("reentry_cost_mtm")["configurations"]["legs"][0]["reEntry"]
    leg = to_quantiply(
        _spec(leg={"reentry_on_sl": {"mode": "cost", "count": 2}}), days=["MON"]
    ).body["configurations"]["legs"][0]
    assert leg["reEntry"] == sample == {"repeat": 2, "type": "RE_ENTRY_COST"}


def test_trail_in_points_is_quantiplys_point_trail():
    """The owner's test1 (2026-10-19): a percent stop with a trail in points, saved as sent."""
    fix = _fixture("trail_points")
    assert fix["request_leg"]["trailingStoploss"] == fix["saved_leg"]["trailingStoploss"]
    e = to_quantiply(_spec(leg={"trail_sl": {"points": [10, 5]}}), days=["MON"])
    leg = e.body["configurations"]["legs"][0]
    assert leg["trailingStoploss"] == fix["saved_leg"]["trailingStoploss"]
    assert e.unconfirmed == []


def test_leg_ids_are_stable_and_distinct():
    a = leg_uid("N_wide_0917", "ce")
    assert a == leg_uid("N_wide_0917", "ce") != leg_uid("N_wide_0917", "pe")
    assert len(a) == 18 and a.isalnum()


@pytest.mark.parametrize(
    ("over", "field"),
    [
        ({"leg": {"target": {"percent": 50}}}, "target"),
        ({"leg": {"expiry": "monthly"}}, "expiry monthly"),
        ({"leg": {"reentry_on_sl": {"mode": "asap", "count": 1}}}, "mode asap"),
        ({"leg": {"roll": {"decay": 0.5}}}, "roll"),
        (
            {
                "leg": {
                    "position": "buy",
                    "trail_peak": {"activate_percent": 105, "exit_percent": 80},
                }
            },
            "trail_peak",
        ),
        ({"leg": {"stop_on": "close"}}, "stop_on: close"),
        ({"square_off": "complete"}, "square_off complete"),
        ({"no_reentry_after": "14:00"}, "no_reentry_after"),
        ({"overall": {"target_inr": 3000}}, "overall target_inr"),
        ({"execution": {"lot_sizing": "historical"}}, "lot_sizing historical"),
        (
            {"leg": {"range_breakout": {"until": "09:30", "side": "high", "source": "underlying"}}},
            "range_breakout source underlying",
        ),
        (
            {"leg": {"range_breakout": {"until": "09:30", "side": "high", "gap_percent": 2}}},
            "gap_percent",
        ),
    ],
)
def test_unmapped_settings_are_refused_by_name(over, field):
    with pytest.raises(Unmappable, match=field):
        to_quantiply(_spec(**over), days=["MON"])


def test_days_must_be_weekdays():
    with pytest.raises(ValueError, match="days"):
        to_quantiply(_spec(), days=[])
    with pytest.raises(ValueError, match="days"):
        to_quantiply(_spec(), days=["Monday"])


def test_every_core_variant_maps():
    """Core-298 uses only mapped settings, all seen saved; a new setting fails here."""
    files = sorted(STRATEGIES_DIR.glob("*.yaml"))
    assert len(files) == 298
    for path in files:
        assert to_quantiply(load_legwise(path), path.stem, ["MON"]).unconfirmed == []


def test_read_back_ignores_server_defaults_but_not_changed_fields():
    sent = to_quantiply(_spec(leg={"trail_sl": {"percent": [15, 10]}}), "x", ["TUE"]).body
    saved = json.loads(json.dumps(sent))
    saved.pop("day")
    saved.update({"_id": "a", "day": "TUE", "enabled": False, "status": "NOT_RUNNING"})
    saved["configurations"].update({"multiplier": 1, "calcBaseSlTgt": "AVG_PRICE"})
    assert comparable(sent, saved) == []
    saved["configurations"]["legs"][1]["stoploss"]["value"] = -100
    saved["configurations"]["startTime"] = "09:18:00"
    assert comparable(sent, saved) == [
        "configurations.startTime",
        "configurations.legs[1].stoploss.value",
    ]


def test_the_captured_save_reads_back_except_the_matching_list():
    """What the owner's save sent and what Quantiply answered: only the four inactive matching
    modes were dropped. Our bodies send the active one alone."""
    assert comparable(_fixture("create_request"), _fixture("create_response_first")) == [
        "configurations.matching"
    ]


def test_day_export_writes_bodies_and_manifest(tmp_path):
    picks = ax.DayPicks(
        date(2026, 10, 20), "core", "preview", ["N_ditm1_0917", "N_wide_1117"], ["N_buy_0932"]
    )
    built = qx.build(picks)
    manifest_path = qx.write(picks, built, tmp_path)
    manifest = json.loads(manifest_path.read_text())
    assert manifest["weekday"] == "TUE" and manifest["source"] == "preview"
    names = {s["variant"]: s["name"] for s in manifest["strategies"]}
    assert names["N_wide_1117"] == "Core · N_wide_1117"
    assert names["N_buy_0932"] == "Core · N_buy_0932 · add-on"
    body = json.loads((tmp_path / "N_wide_1117.json").read_text())
    assert body["day"] == ["TUE"] and body["configurations"]["startTime"] == "11:17:00"
    text = qx.render(picks, built, manifest_path)
    assert "Core · N_ditm1_0917" in text


def test_build_takes_t1_and_refuses_an_unknown_book():
    """BL-140: the dashboard settings may give Quantiply the T1 list too."""
    built = qx.build(ax.DayPicks(date(2026, 10, 21), "t1", "given", ["N_wide_0917"], []))
    assert built[0].export.name == "T1 · N_wide_0917"
    with pytest.raises(ValueError, match="core or t1"):
        qx.build(ax.DayPicks(date(2026, 10, 21), "momentum", "given", ["N_wide_0917"], []))


def test_automation_settings_choose_the_books(tmp_path, monkeypatch):
    from option_backtesting.rotation import automation_settings as auto

    monkeypatch.setenv("SCHEDULER_STATE_DIR", str(tmp_path))
    settings, source = auto.read()
    assert source.startswith("settings: defaults")
    assert auto.upload_books(settings, "quantiply") == ["core"]
    assert auto.upload_books(settings, "algotest") == ["t1"]
    saved = json.loads(json.dumps(auto.DEFAULT))
    saved["version"] = 3
    saved["rows"]["quantiply.finvasia"] = {"login": True, "list": "t1", "upload": True}
    (tmp_path / "automation-settings.json").write_text(json.dumps(saved))
    settings, source = auto.read()
    assert source == "settings v3"
    assert auto.upload_books(settings, "quantiply") == ["core", "t1"]
    assert auto.upload_books(settings, "quantiply", "finvasia") == ["t1"]
    saved["masters"]["uploads"] = False
    (tmp_path / "automation-settings.json").write_text(json.dumps(saved))
    assert auto.upload_books(auto.read()[0], "quantiply") == []
    (tmp_path / "automation-settings.json").write_text("{}")
    with pytest.raises(ValueError, match="not automation settings"):
        auto.read()
    saved["rows"]["algotest.finvasia"]["list"] = "classic"
    (tmp_path / "automation-settings.json").write_text(json.dumps(saved))
    with pytest.raises(ValueError, match="has list 'classic'"):
        auto.read()


def test_write_never_deletes_files_it_did_not_write(tmp_path):
    picks = ax.DayPicks(date(2026, 10, 20), "core", "given", ["N_wide_0917"], [])
    mine = tmp_path / "owners_own.json"
    mine.write_text("{}")
    with pytest.raises(FileExistsError):
        qx.write(picks, qx.build(picks), tmp_path)
    assert mine.exists()
