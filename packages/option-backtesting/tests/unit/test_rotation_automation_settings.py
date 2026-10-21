"""BL-140 Phase 4: the Python reader of the scheduler's settings snapshot agrees with the
TypeScript one (`packages/broker-login/src/automation-settings.ts`): both read the same two
fixture files, and a bad multiplier, add-on or pause date is refused, never guessed."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from option_backtesting.rotation import automation_settings as a

FIXTURES = Path(__file__).resolve().parents[3] / "broker-login" / "src" / "fixtures"


def test_a_snapshot_written_before_phase_4_means_one_yes_and_no_pause():
    data, source = a.read(FIXTURES / "automation-settings-v1.json")
    assert source == "settings v1"
    assert all(r["multiplier"] == 1 and r["addon"] is True for r in data["rows"].values())
    assert data["pause"] == {"until": None}
    assert a.paused_for(data, "2026-10-23") is None
    assert a.upload_books(data, "quantiply", "angelone") == ["core"]


def test_it_reads_what_the_owner_set_and_a_pause_is_inclusive():
    data, _ = a.read(FIXTURES / "automation-settings-v2.json")
    assert data["rows"]["quantiply.angelone"]["multiplier"] == 3
    assert data["rows"]["quantiply.angelone"]["addon"] is False
    assert data["rows"]["algotest.finvasia"]["multiplier"] == 2
    assert a.paused_for(data, "2026-10-26") == "2026-10-27"
    assert a.paused_for(data, "2026-10-27") == "2026-10-27"
    assert a.paused_for(data, "2026-10-28") is None


def test_no_file_is_todays_setup_with_the_defaults():
    data, source = a.read(Path("/nonexistent/automation-settings.json"))
    assert source.startswith("settings: defaults")
    assert data["rows"]["quantiply.angelone"]["multiplier"] == 1
    assert a.paused_for(data, "2026-10-23") is None


@pytest.mark.parametrize(
    ("row", "field", "value"),
    [
        ("quantiply.angelone", "multiplier", 0),
        ("quantiply.angelone", "multiplier", 11),
        ("quantiply.angelone", "multiplier", 1.5),
        ("quantiply.angelone", "multiplier", "3"),
        ("quantiply.angelone", "multiplier", True),
        ("algotest.finvasia", "addon", "no"),
    ],
)
def test_a_bad_row_value_is_an_error(tmp_path, row, field, value):
    data = json.loads((FIXTURES / "automation-settings-v2.json").read_text())
    data["rows"][row][field] = value
    path = tmp_path / "automation-settings.json"
    path.write_text(json.dumps(data))
    with pytest.raises(ValueError):
        a.read(path)


def test_a_bad_pause_date_is_an_error(tmp_path):
    data = json.loads((FIXTURES / "automation-settings-v2.json").read_text())
    data["pause"] = {"until": "tomorrow"}
    path = tmp_path / "automation-settings.json"
    path.write_text(json.dumps(data))
    with pytest.raises(ValueError):
        a.read(path)
