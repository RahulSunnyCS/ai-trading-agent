"""BL-137 Phase 1: a leg-wise strategy as an AlgoTest `.algtst` file.

The fixtures in `tests/fixtures/algtst/` are exports AlgoTest itself wrote: the owner's
`Nifty_Widesl_917_OTM1` (2026-10-18) and three strategies the owner built by hand on 2026-10-19 to
settle the closest-premium strike, re-entry at cost, buy legs, trail in points and range breakout.
Each test states the settings the owner actually entered (a few differ from the rotation YAML of
the same name: entry 11:37 on the OTM1 file, exit and trail on the p150 one, exit on the Buy one),
and the export must equal AlgoTest's, leg ids and name aside."""

from __future__ import annotations

import json
import zipfile
from datetime import date
from pathlib import Path

import pytest

from option_backtesting.legwise.algtst import Unmappable, leg_uid, to_algtst
from option_backtesting.legwise.schema import LegwiseStrategy, load_legwise
from option_backtesting.rotation import algtst_export as ax
from option_backtesting.rotation.variants import STRATEGIES_DIR, TRACK_DIRS

FIXTURES = Path(__file__).resolve().parents[1] / "fixtures" / "algtst"


def _spec(entry, exit_, *, position="sell", strike, sl, trail, reentry=None, rb=None, mtm):
    legs = []
    for side in ("CE", "PE"):
        leg = {
            "id": side.lower(),
            "lots": 1,
            "position": position,
            "option_type": side,
            "expiry": "weekly",
            "strike": strike,
            "stop_loss": {"percent": sl},
            "trail_sl": trail,
        }
        if reentry:
            leg["reentry_on_sl"] = reentry
        if rb:
            leg["range_breakout"] = rb
        legs.append(leg)
    return LegwiseStrategy.model_validate(
        {
            "id": "fixture",
            "underlying": "NIFTY",
            "entry_time": entry,
            "exit_time": exit_,
            "legs": legs,
            "overall": {"stop_loss_inr": mtm},
        }
    )


def _strip(doc: dict) -> dict:
    doc = json.loads(json.dumps(doc))
    doc.pop("name")
    for leg in doc["strategy"]["ListOfLegConfigs"]:
        leg.pop("id")
    return doc


AS_ENTERED = {
    "nifty_widesl_917_otm1.algtst": _spec(
        "11:37", "15:28", strike={"strike_type": "OTM1"}, sl=115,
        trail={"percent": [15, 10]}, mtm=2500,
    ),
    "n_p150-t1s11_917.algtst": _spec(
        "09:17", "15:14", strike={"closest_premium": 150}, sl=60,
        trail={"percent": [10, 5]}, mtm=4000,
    ),
    "n_ditm1-t1s36_0947.algtst": _spec(
        "09:47", "15:28", strike={"strike_type": "ITM1"}, sl=20,
        trail={"percent": [10, 5]}, reentry={"mode": "cost", "count": 2}, mtm=4000,
    ),
    "n_buy-t1s47_0917.algtst": _spec(
        "09:17", "15:28", position="buy", strike={"closest_premium": 75}, sl=20,
        trail={"points": [1, 1]}, rb={"until": "09:27", "side": "high", "source": "instrument"},
        mtm=2000,
    ),
}  # fmt: skip


@pytest.mark.parametrize("fixture", sorted(AS_ENTERED))
def test_export_equals_algotests_own(fixture):
    algotest = json.loads((FIXTURES / fixture).read_text())
    mine = to_algtst(AS_ENTERED[fixture]).doc
    assert _strip(mine) == _strip(algotest)
    # the same key order too, so a file reads like AlgoTest's
    for ours, theirs in zip(
        mine["strategy"]["ListOfLegConfigs"], algotest["strategy"]["ListOfLegConfigs"], strict=True
    ):
        assert list(ours) == list(theirs)
    assert list(mine["strategy"]) == list(algotest["strategy"])


def test_leg_ids_are_stable_and_distinct():
    a = leg_uid("N_p150-t1s11_0917", "ce")
    assert a == leg_uid("N_p150-t1s11_0917", "ce")
    assert a != leg_uid("N_p150-t1s11_0917", "pe")
    assert len(a) == 8 and a.isalnum() and a == a.lower()


def test_name_defaults_to_the_spec_id_and_text_is_json():
    e = to_algtst(AS_ENTERED["n_ditm1-t1s36_0947.algtst"])
    assert e.name == "fixture"
    assert json.loads(e.text()) == e.doc
    assert e.text().endswith("\n")


def _base(**over) -> dict:
    s = {
        "id": "x",
        "underlying": "NIFTY",
        "entry_time": "09:17",
        "exit_time": "15:28",
        "legs": [
            {
                "id": "ce",
                "lots": 1,
                "position": "sell",
                "option_type": "CE",
                "strike": {"strike_type": "ATM"},
                "stop_loss": {"percent": 20},
            }
        ],
    }
    leg_over = over.pop("leg", {})
    s["legs"][0].update(leg_over)
    s.update(over)
    return s


@pytest.mark.parametrize(
    ("over", "field"),
    [
        ({"leg": {"target": {"percent": 50}}}, "target"),
        ({"leg": {"stop_loss": {"points": 30}}}, "stop_loss in points"),
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
        ({"leg": {"reverse_on_sl": {"time_stop_minutes": 30}}}, "reverse_on_sl"),
        ({"square_off": "complete"}, "square_off complete"),
        ({"no_reentry_after": "14:00"}, "no_reentry_after"),
        ({"overall": {"target_inr": 3000}}, "overall target_inr"),
        ({"execution": {"lot_sizing": "historical"}}, "lot_sizing historical"),
        (
            {"leg": {"range_breakout": {"until": "09:30", "side": "low"}}},
            "range_breakout side low",
        ),
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
    spec = LegwiseStrategy.model_validate(_base(**over))
    with pytest.raises(Unmappable, match=field):
        to_algtst(spec)


def test_every_rotation_variant_exports():
    """Core-298 and the T1 track use only mapped settings; a new setting in either fails here."""
    files = sorted(STRATEGIES_DIR.glob("*.yaml")) + sorted(TRACK_DIRS["t1"].glob("*.yaml"))
    assert len(files) == 298 + 223
    for path in files:
        to_algtst(load_legwise(path), path.stem)


def test_range_breakout_time_is_minutes_after_entry():
    spec = load_legwise(TRACK_DIRS["t1"] / "N_buy-t1s48_1417.yaml")
    leg = to_algtst(spec).doc["strategy"]["ListOfLegConfigs"][0]
    until = spec.legs[0].range_breakout.until
    h0, m0 = map(int, spec.entry_time.split(":"))
    h1, m1 = map(int, until.split(":"))
    assert leg["LegMomentum"]["Time"] == (h1 * 60 + m1) - (h0 * 60 + m0)


def test_day_export_writes_files_manifest_and_zip(tmp_path):
    picks = ax.DayPicks(
        date(2026, 10, 19),
        "t1",
        "preview",
        ["N_ditm1-t1s36_0947", "N_p150-t1s11_0917", "N_p150-t1s11_1317"],
        ["N_buy-t1s47_0917"],
    )
    exports = ax.build(picks)
    zip_path = ax.write(picks, exports, tmp_path)

    assert sorted(p.name for p in tmp_path.glob("*.algtst")) == sorted(
        f"{v}.algtst" for v in picks.core + picks.buy
    )
    manifest = json.loads((tmp_path / "manifest.json").read_text())
    assert manifest["source"] == "preview"
    names = {s["variant"]: s["name"] for s in manifest["strategies"]}
    assert names["N_p150-t1s11_0917"] == "T1 · N_p150-t1s11_0917"
    assert names["N_buy-t1s47_0917"] == "T1 · N_buy-t1s47_0917 · add-on"
    with zipfile.ZipFile(zip_path) as zf:
        assert sorted(zf.namelist()) == sorted(p.name for p in tmp_path.glob("*.algtst"))
    doc = json.loads((tmp_path / "N_p150-t1s11_1317.algtst").read_text())
    assert doc["name"] == "T1 · N_p150-t1s11_1317"
    assert doc["strategy"]["EntryIndicators"]["Value"][0]["Value"]["Parameters"] == {
        "Hour": 13,
        "Minute": 17,
    }
    text = ax.render(picks, exports, zip_path)
    assert "T1 · N_ditm1-t1s36_0947" in text and "cost x2" in text


def test_recorded_picks_read_the_tracks_journal(tmp_path, monkeypatch):
    entry = {"day": "2026-10-19", "lists": {"C": {"core": ["N_wide_0917"], "buy": []}}}
    seen = {}

    def fake_read(path):
        seen["path"] = path
        return [entry]

    monkeypatch.setattr(ax.journal, "read", fake_read)
    picks = ax.recorded_picks(date(2026, 10, 19), "t1", tmp_path)
    assert picks.core == ["N_wide_0917"] and picks.source == "recorded"
    assert seen["path"] == tmp_path / "rotation" / "track_t1" / "journal.jsonl"
    assert ax.recorded_picks(date(2026, 10, 20), "t1", tmp_path) is None


def test_write_never_deletes_files_it_did_not_write(tmp_path):
    """BL-137 review: `--out ~/Downloads` must not delete the owner's other exports."""
    picks = ax.DayPicks(date(2026, 10, 19), "t1", "given", ["N_p150-t1s11_0917"], [])
    exports = ax.build(picks)
    mine = tmp_path / "owners_own.algtst"
    mine.write_text("{}")
    with pytest.raises(FileExistsError):
        ax.write(picks, exports, tmp_path)
    assert mine.exists()

    folder = tmp_path / "export"
    ax.write(picks, exports, folder)
    (folder / "kept.algtst").write_text("{}")  # dropped in later by hand
    later = ax.DayPicks(date(2026, 10, 19), "t1", "given", ["N_ditm1-t1s36_0947"], [])
    ax.write(later, ax.build(later), folder)
    names = sorted(p.name for p in folder.glob("*.algtst"))
    assert names == ["N_ditm1-t1s36_0947.algtst", "kept.algtst"]
