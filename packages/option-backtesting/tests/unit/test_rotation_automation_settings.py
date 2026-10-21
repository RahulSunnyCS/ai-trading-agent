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


# --- the Buy add-on in the exports (BL-140 Phase 4) -----------------------------------------------


def _write(tmp_path, monkeypatch, mutate=None, base="automation-settings-v2.json"):
    data = json.loads((FIXTURES / base).read_text())
    if mutate:
        mutate(data)
    (tmp_path / "automation-settings.json").write_text(json.dumps(data))
    monkeypatch.setenv("SCHEDULER_STATE_DIR", str(tmp_path))
    return data


def _picks(book):
    from datetime import date

    from option_backtesting.rotation import algtst_export as ax

    return ax.DayPicks(
        date(2026, 10, 23),
        book,
        "recorded",
        ["N_ditm1-t1s36_0947", "N_p150-t1s11_0917", "N_p150-t1s11_1317"],
        ["N_buy-t1s47_0917"],
    )


def test_addon_wanted_follows_the_rows_that_upload_the_list(tmp_path, monkeypatch):
    data, _ = a.read(FIXTURES / "automation-settings-v2.json")
    # v2: quantiply.angelone (core) has the add-on off; algotest.finvasia (t1) has it on
    assert a.addon_wanted(data, "quantiply", "core") is False
    assert a.addon_wanted(data, "algotest", "t1") is True
    # a list nothing uploads, or uploads switched off, is left as it always was
    assert a.addon_wanted(data, "quantiply", "t1") is True
    off = json.loads(json.dumps(data))
    off["masters"]["uploads"] = False
    assert a.addon_wanted(off, "quantiply", "core") is True
    # a second account on the same list that wants the add-on keeps it in the export
    both = json.loads(json.dumps(data))
    both["rows"]["quantiply.finvasia"].update(list="core", upload=True, addon=True)
    assert a.addon_wanted(both, "quantiply", "core") is True
    assert a.addon_mixed(both, "quantiply", "core") is True  # said by the export command
    assert a.addon_mixed(data, "quantiply", "core") is False


def test_from_settings_leaves_the_addon_out_only_when_no_row_wants_it(tmp_path, monkeypatch):
    from option_backtesting.rotation import algtst_export as ax
    from option_backtesting.rotation import cli

    settings = _write(tmp_path, monkeypatch)
    core = _picks("core")
    cut = cli._without_addon(core, "quantiply", "core", settings)
    assert cut.buy == [] and cut.core == core.core
    assert [name for _, e in ax.build(cut) for name in [e.name]] == [
        f"Core · {v}" for v in core.core
    ]
    t1 = _picks("t1")
    assert cli._without_addon(t1, "algotest", "t1", settings) is t1  # the row keeps it
    # no --from-settings: never touched, whatever the settings say
    assert cli._without_addon(core, "quantiply", "core", None) is core


def test_defaults_and_old_snapshots_export_exactly_as_before(tmp_path, monkeypatch):
    from option_backtesting.rotation import algtst_export as ax
    from option_backtesting.rotation import cli

    settings = _write(tmp_path, monkeypatch, base="automation-settings-v1.json")
    for platform, book in (("algotest", "t1"), ("quantiply", "core")):
        picks = _picks(book)
        same = cli._without_addon(picks, platform, book, settings)
        assert same is picks
        assert [e.text() for _, e in ax.build(same)] == [e.text() for _, e in ax.build(picks)]
    monkeypatch.setenv("SCHEDULER_STATE_DIR", str(tmp_path / "nothing-saved"))  # no file: defaults
    picks = _picks("core")
    nothing, _ = a.read()
    assert cli._without_addon(picks, "quantiply", "core", nothing) is picks


def test_the_export_commands_leave_the_addon_out_under_from_settings(tmp_path, monkeypatch):
    from typer.testing import CliRunner

    from option_backtesting.rotation import cli

    (tmp_path / "state").mkdir()
    _write(tmp_path / "state", monkeypatch)
    monkeypatch.setattr(cli, "_resolve_picks", lambda day, book, *a, **k: _picks(book))
    runner = CliRunner()

    def manifest(command, out):
        result = runner.invoke(
            cli.rotation_app, [command, "--from-settings", "--out", str(tmp_path / out)]
        )
        assert result.exit_code == 0, result.output
        return json.loads((tmp_path / out / "manifest.json").read_text()), result.output

    # v2: Quantiply · Angel One (core) has the add-on off; AlgoTest · Shoonya (t1) has it on
    q, out = manifest("quantiply-export", "q")
    assert [s["addon"] for s in q["strategies"]] == [False, False, False]
    assert "Buy add-on left out" in out
    t, _ = manifest("algotest-export", "t")
    assert [s["addon"] for s in t["strategies"]] == [False, False, False, True]


def test_a_shared_list_with_mixed_addon_settings_says_so(tmp_path, monkeypatch, capsys):
    from option_backtesting.rotation import cli

    settings = _write(tmp_path, monkeypatch)
    settings["rows"]["quantiply.finvasia"].update(list="core", upload=True, addon=True)
    picks = _picks("core")
    assert cli._without_addon(picks, "quantiply", "core", settings) is picks
    assert "Buy add-on KEPT" in capsys.readouterr().out
