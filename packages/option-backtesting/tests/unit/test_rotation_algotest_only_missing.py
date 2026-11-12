"""`obt rotation algotest-export --only-missing` (2026-11-05): the 08:11 catch-up exports only a list
the 16:40 run did not, so a row switched to another list after 16:40 still trades in the morning,
and a normal morning (every list exported) does nothing and exits 3."""

from __future__ import annotations

import json

import pytest
from typer.testing import CliRunner

from option_backtesting.rotation import algtst_export as ax
from option_backtesting.rotation import cli

NAMES = ["N_ditm1-t1s36_0947", "N_p150-t1s11_0917", "N_p150-t1s11_1317"]


@pytest.fixture
def world(tmp_path, monkeypatch):
    root = tmp_path / "TradingData"
    root.mkdir()
    monkeypatch.setenv("TRADING_DATA_ROOT", str(root))
    today = cli._day(None)
    exported: list[str] = []

    def resolve(day, book, *a, **k):
        exported.append(book)
        return ax.DayPicks(today, book, "preview", NAMES, [])

    monkeypatch.setattr(cli, "_settings_books", lambda platform, session=None: (["core", "t1"], {}))
    monkeypatch.setattr(cli, "_resolve_picks", resolve)
    monkeypatch.setattr(cli, "_without_addon", lambda picks, *a, **k: picks)
    monkeypatch.setattr(cli, "_with_lots", lambda picks, *a, **k: picks)
    return root, today, exported


def run(*args):
    return CliRunner().invoke(cli.rotation_app, ["algotest-export", "--from-settings", *args])


def pointer(root, book):
    return json.loads((root / "rotation" / "algotest" / f"latest-{book}.json").read_text())


def test_a_normal_morning_exports_nothing_and_exits_3(world):
    root, today, exported = world
    assert run("--preview").exit_code == 0  # the 16:40 run, in effect
    assert sorted(exported) == ["core", "t1"]
    exported.clear()
    again = run("--preview", "--only-missing")
    assert again.exit_code == 3, again.output
    assert exported == [] and "already exported for the session: core, t1" in again.output


def test_a_list_switched_in_after_the_evening_is_exported(world):
    root, today, exported = world
    assert run("--preview").exit_code == 0
    (root / "rotation" / "algotest" / "latest-core.json").unlink()  # no row had Classic at 16:40
    exported.clear()
    result = run("--preview", "--only-missing")
    assert result.exit_code == 0, result.output
    assert exported == ["core"]
    assert pointer(root, "core")["day"] == today.isoformat()
    assert pointer(root, "core")["source"] == "preview"


def test_an_older_or_recorded_export_does_not_count(world):
    root, today, exported = world
    assert run("--preview").exit_code == 0
    p = root / "rotation" / "algotest" / "latest-t1.json"
    stale = {**pointer(root, "t1"), "day": "2026-11-04"}
    p.write_text(json.dumps(stale))
    recorded = root / "rotation" / "algotest" / "latest-core.json"
    recorded.write_text(json.dumps({**pointer(root, "core"), "source": "recorded"}))
    exported.clear()
    assert run("--preview", "--only-missing").exit_code == 0
    assert sorted(exported) == ["core", "t1"]


def test_an_export_older_than_a_layout_change_is_exported_again(world, monkeypatch):
    """2026-11-06: the owner turned the T1 split on after the evening export; the 08:11 catch-up
    kept that export (nothing was "missing") and the activation put every strategy on both
    accounts. An export now carries the settings version and layout it was made under."""
    root, today, exported = world
    state = {"version": 12, "dirBoost": False, "capital": 850000}

    def settings(platform, session=None):
        row = {"upload": True, "list": "t1", "dirBoost": state["dirBoost"], "multiplier": 1}
        s = {
            "version": state["version"],
            "splitT1": False,
            "capital": state["capital"],
            "rows": {"algotest.finvasia": row},
        }
        return ["t1"], s

    monkeypatch.setattr(cli, "_settings_books", settings)
    assert run("--preview").exit_code == 0
    path = root_manifest(root, today, "t1")
    assert json.loads(path.read_text())["settings_version"] == 12
    exported.clear()

    same = run("--preview", "--only-missing")
    assert same.exit_code == 3 and exported == []  # same settings: nothing to do

    # a save that changes nothing the export reads: the picks stay, only the stamp moves
    state.update(version=13, capital=900000)
    quiet = run("--preview", "--only-missing")
    assert quiet.exit_code == 3 and exported == []
    assert json.loads(path.read_text())["settings_version"] == 13

    state.update(version=14, dirBoost=True)  # a row's Dir x2: the export is exported again
    changed = run("--preview", "--only-missing")
    assert changed.exit_code == 0, changed.output
    assert exported == ["t1"]
    assert json.loads(path.read_text())["settings_version"] == 14


def root_manifest(root, today, book):
    return root / "rotation" / "algotest" / today.isoformat() / book / "manifest.json"
