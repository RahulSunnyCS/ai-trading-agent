"""BL-183: the picked Dir at 2 lots on a non-expiry day, in the rule, the settings and both exports.
Off (the default) every export is exactly what it was."""

from __future__ import annotations

import json
from datetime import date

import pytest

from option_backtesting.legwise.schema import load_legwise
from option_backtesting.rotation import algtst_export as ax
from option_backtesting.rotation import automation_settings as a
from option_backtesting.rotation import live_lots
from option_backtesting.rotation import quantiply_export as qx
from option_backtesting.rotation.variants import strategy_path

DIR, W1, W2 = "N_dir_0917", "N_wide_0917", "S_wide_0947"
NORMAL = {"NIFTY": "2", "SENSEX": "4"}
NIFTY_EXPIRY = {"NIFTY": "0", "SENSEX": "2"}
SENSEX_EXPIRY = {"NIFTY": "3", "SENSEX": "0"}


def _walk(node, key):
    """Every value under `key` anywhere in a JSON tree."""
    if isinstance(node, dict):
        for k, v in node.items():
            if k == key:
                yield v
            yield from _walk(v, key)
    elif isinstance(node, list):
        for v in node:
            yield from _walk(v, key)


# --- the rule ---------------------------------------------------------------------------------


def test_the_picked_dir_doubles_on_a_normal_day_only():
    assert live_lots.lots_for_day([W1, DIR, W2], NORMAL) == {W1: 1, DIR: 2, W2: 1}
    assert live_lots.lots_for_day([W1, DIR, W2], NIFTY_EXPIRY) == {W1: 1, DIR: 1, W2: 1}
    assert live_lots.lots_for_day([W1, DIR, W2], SENSEX_EXPIRY) == {W1: 1, DIR: 1, W2: 1}


def test_no_dir_picked_stays_at_three_lots():
    assert live_lots.lots_for_day([W1, W2, "N_p100_0917"], NORMAL) == {
        W1: 1,
        W2: 1,
        "N_p100_0917": 1,
    }
    assert live_lots.summary([W1, W2], NORMAL) == "no Dir picked"


def test_unknown_days_to_expiry_double_nothing():
    for dte in (None, {"NIFTY": "unknown", "SENSEX": "2"}, {"NIFTY": "2"}):
        assert live_lots.lots_for_day([W1, DIR], dte) == {W1: 1, DIR: 1}
    assert live_lots.lots_for_day([W1, DIR], NORMAL, on=False) == {W1: 1, DIR: 1}
    assert live_lots.summary([DIR], NORMAL) == "Dir ×2"
    assert live_lots.summary([DIR], NIFTY_EXPIRY) == "expiry day"


def test_scaled_doubles_the_lots_and_the_rupee_stop_only():
    spec = load_legwise(strategy_path(DIR))
    assert live_lots.scaled(spec, 1) is spec
    two = live_lots.scaled(spec, 2)
    assert [leg.lots for leg in two.legs] == [2 * leg.lots for leg in spec.legs]
    assert two.overall.stop_loss_inr == 2 * spec.overall.stop_loss_inr == 6000
    assert [leg.stop_loss for leg in two.legs] == [leg.stop_loss for leg in spec.legs]
    with pytest.raises(ValueError):
        live_lots.scaled(spec, 0)


# --- the exports ------------------------------------------------------------------------------


def _picks(lots=None, dte=NORMAL, buy=()):
    return ax.DayPicks(date(2026, 10, 29), "core", "preview", [W1, DIR, W2], list(buy), dte, lots)


def test_quantiply_body_carries_two_lots_and_a_doubled_mtm_sl():
    picks = _picks(lots=live_lots.lots_for_day([W1, DIR, W2], NORMAL))
    by = {b.variant: json.loads(b.export.text()) for b in qx.build(picks)}
    assert set(_walk(by[DIR], "quantity")) == {2}
    assert set(_walk(by[W1], "quantity")) == {1}
    one = {b.variant: json.loads(b.export.text()) for b in qx.build(_picks())}
    stops = [v for v in _walk(by[DIR], "value") if isinstance(v, (int, float)) and v <= -1000]
    stops_one = [v for v in _walk(one[DIR], "value") if isinstance(v, (int, float)) and v <= -1000]
    assert stops == [2 * s for s in stops_one] and -6000 in stops
    assert by[W1] == one[W1]


def test_algotest_strategy_carries_two_lots_and_keeps_the_one_lot_overall_sl():
    """AlgoTest scales the overall MTM SL by the leg lots itself (owner, 2026-10-28), so the export
    keeps ₹3,000 with 2-lot legs (AlgoTest applies ₹6,000)."""
    picks = _picks(lots={W1: 1, DIR: 2, W2: 1})
    by = {v: json.loads(e.text()) for v, e in ax.build(picks)}
    one = {v: json.loads(e.text()) for v, e in ax.build(_picks())}
    lots = [c["Value"] for c in _walk(by[DIR], "LotConfig")]
    assert lots and set(lots) == {2}
    assert by[W1] == one[W1]
    assert list(_walk(by[DIR], "OverallSL")) == list(_walk(one[DIR], "OverallSL"))
    assert "6000" not in json.dumps(by[DIR]) and "3000" in json.dumps(by[DIR])
    spec = load_legwise(strategy_path(DIR))
    kept = live_lots.scaled(spec, 2, overall_per_lot=True)
    assert kept.overall == spec.overall and [leg.lots for leg in kept.legs] == [2, 2]


def test_off_the_exports_and_manifests_are_exactly_as_before(tmp_path):
    before = [(v, e.text()) for v, e in ax.build(_picks(dte=None))]
    with_dte = [(v, e.text()) for v, e in ax.build(_picks())]
    assert before == with_dte
    ax.write(_picks(), ax.build(_picks()), tmp_path / "a")
    m = json.loads((tmp_path / "a" / "manifest.json").read_text())
    assert "dir_boost" not in m and "dte" not in m
    assert all("lots" not in s for s in m["strategies"])
    qx.write(_picks(), qx.build(_picks()), tmp_path / "q")
    m = json.loads((tmp_path / "q" / "manifest.json").read_text())
    assert "dir_boost" not in m and all("lots" not in s for s in m["strategies"])


def test_on_the_manifests_record_the_lots(tmp_path):
    picks = _picks(lots={W1: 1, DIR: 2, W2: 1})
    qx.write(picks, qx.build(picks), tmp_path / "q")
    m = json.loads((tmp_path / "q" / "manifest.json").read_text())
    assert m["dir_boost"] is True and m["dte"] == NORMAL
    assert {s["variant"]: s["lots"] for s in m["strategies"]} == {W1: 1, DIR: 2, W2: 1}
    ax.write(picks, ax.build(picks), tmp_path / "a")
    m = json.loads((tmp_path / "a" / "manifest.json").read_text())
    assert {s["variant"]: s["lots"] for s in m["strategies"]} == {W1: 1, DIR: 2, W2: 1}


# --- the settings -----------------------------------------------------------------------------


def _settings(**rows):
    s = json.loads(json.dumps(a.DEFAULT))
    for key, fields in rows.items():
        s["rows"][key.replace("_", ".")].update(fields)
    return s


def test_dir_boost_needs_every_row_that_uploads_the_list():
    off = _settings()
    assert not a.dir_boost_wanted(off, "quantiply", "core")
    on = _settings(quantiply_angelone={"dirBoost": True})
    assert a.dir_boost_wanted(on, "quantiply", "core")
    assert not a.dir_boost_wanted(on, "algotest", "t1")  # that row is off
    mixed = _settings(
        quantiply_angelone={"dirBoost": True},
        quantiply_finvasia={"list": "core", "upload": True, "dirBoost": False},
    )
    assert not a.dir_boost_wanted(mixed, "quantiply", "core")
    assert a.dir_boost_mixed(mixed, "quantiply", "core")
    no_uploads = _settings(quantiply_angelone={"dirBoost": True})
    no_uploads["masters"]["uploads"] = False
    assert not a.dir_boost_wanted(no_uploads, "quantiply", "core")


def test_the_reader_takes_old_snapshots_as_off_and_refuses_a_bad_value(tmp_path):
    s = json.loads(json.dumps(a.DEFAULT))
    for row in s["rows"].values():
        row.pop("dirBoost")
    path = tmp_path / "automation-settings.json"
    path.write_text(json.dumps(s))
    data, _ = a.read(path)
    assert all(r["dirBoost"] is False for r in data["rows"].values())
    s["rows"]["quantiply.angelone"]["dirBoost"] = "yes"
    path.write_text(json.dumps(s))
    with pytest.raises(ValueError, match="dirBoost"):
        a.read(path)


def test_cli_with_lots_follows_the_flag_then_the_settings(capsys):
    from option_backtesting.rotation.cli import _with_lots

    picks = _picks()
    assert _with_lots(picks, "quantiply", "core", None, None) is picks
    assert _with_lots(picks, "quantiply", "core", _settings(), None) is picks
    on = _with_lots(
        picks, "quantiply", "core", _settings(quantiply_angelone={"dirBoost": True}), None
    )
    assert on.lots == {W1: 1, DIR: 2, W2: 1}
    assert _with_lots(picks, "quantiply", "core", None, True).lots == on.lots
    assert (
        _with_lots(
            picks, "quantiply", "core", _settings(quantiply_angelone={"dirBoost": True}), False
        )
        is picks
    )
    expiry = _with_lots(_picks(dte=NIFTY_EXPIRY), "quantiply", "core", None, True)
    assert expiry.lots == {W1: 1, DIR: 1, W2: 1}
    assert "every pick 1 lot (expiry day)" in capsys.readouterr().out


# --- the messages -----------------------------------------------------------------------------


def _entry(dte, core=None, track=None):
    from option_backtesting.rotation.dte import DTE_BASIS

    e = {
        "day": "2026-10-29",
        "weekday": "Thu",
        "lists": {"C": {"core": core or ["N_p100_1202", "N_ditm1_0917", "N_wide_1117"], "buy": []}},
        "hash": "f1a772478960abcd1111",
        "recorded_at": "2026-10-29T09:16:25+05:30",
        "before_first_entry": True,
        "dte": dte,
        "dte_basis": DTE_BASIS,
    }
    if track:
        e["track"] = track
    return e


def test_the_0916_message_says_the_lots_only_for_a_list_that_trades_them():
    from option_backtesting.rotation import messages

    entry = _entry(NORMAL)
    plain = messages.render_morning(entry, None, _entry(NORMAL, track="t1"), None)
    assert "lots" not in plain
    text = messages.render_morning(
        entry, None, _entry(NORMAL, track="t1"), None, boost={"adaptive": True, "t1": False}
    )
    adaptive, t1 = text.split(messages.SEPARATOR)
    assert "🔢 4 lots · Dir ×2" in adaptive
    assert "09:17  N_dir_ITM1 · 2 lots" in adaptive
    assert "lots" not in t1
    expiry = messages.render_morning(
        _entry(NIFTY_EXPIRY), None, None, None, boost={"adaptive": True}
    )
    assert "🔢 3 lots · expiry day" in expiry and "· 2 lots" not in expiry
    no_dir = _entry(NORMAL, core=["N_p100_1202", "N_wide_1117", "S_wide_0947"])
    assert "🔢 3 lots · no Dir picked" in messages.render_entry(no_dir, None, {"adaptive": True})


def test_the_evening_result_adds_what_the_lots_made():
    from option_backtesting.rotation import result

    r = result.DailyResult(
        date(2026, 10, 29),
        "Thu",
        {"C": 1500.0},
        "f1a772478960abcd1111",
        {"C": [("N_ditm1_0917", 1000.0), ("N_wide_1117", 700.0), ("N_p100_1202", -200.0)]},
        None,
        NORMAL,
    )
    assert result.as_traded(r) == (4, 2500.0)
    text = result.render(r, None, boost={"adaptive": True})
    assert "1 lot per strategy, after costs" in text
    assert "As traded (Dir ×2, 4 lots): " in text
    assert "As traded" not in result.render(r, None)
    expiry = result.DailyResult(
        r.day, "Thu", r.gains, r.entry_hash, r.strategies, None, NIFTY_EXPIRY
    )
    assert result.as_traded(expiry) is None
    assert "As traded" not in result.render(expiry, None, boost={"adaptive": True})


def test_tomorrows_tentative_list_says_the_lots():
    from option_backtesting.rotation import messages
    from option_backtesting.rotation.tomorrow import NextPicks

    nxt = NextPicks(
        date(2026, 10, 30),
        "Fri",
        ["N_ditm1_0917", "N_wide_1117", "N_p100_1202"],
        [],
        None,
        None,
        NORMAL,
    )
    text = messages.render_result(
        "2026-10-29", (0.0, []), None, nxt, None, boost={"adaptive": True}
    )
    assert "🔢 4 lots · Dir ×2" in text and "N_dir_ITM1 · 2 lots" in text
    assert "lots ·" not in messages.render_result("2026-10-29", (0.0, []), None, nxt, None)


def test_the_messages_follow_only_platforms_whose_uploads_are_switched_on():
    on = _settings(quantiply_angelone={"dirBoost": True})
    assert a.dir_boost_lists(on) == {"adaptive": True, "t1": False}
    off = a.env_uploads_on({"QUANTIPLY_UPLOAD": "off", "ALGOTEST_UPLOAD": "on"})
    assert a.dir_boost_lists(on, off) == {"adaptive": False, "t1": False}
    assert a.env_uploads_on({"QUANTIPLY_UPLOAD": " On "}) == {"algotest": False, "quantiply": True}
