"""BL-209 Phase 2: the AlgoTest T1 export under the split. Every copy either layout needs, a copy
above 1 lot named with its lots, and the manifest's `accounts` / `alone` as the one record of
which account trades what. With the switch off the export is exactly what it was."""

from __future__ import annotations

import json
from datetime import date

from option_backtesting.rotation import algtst_export as ax
from option_backtesting.rotation import automation_settings as a
from option_backtesting.rotation.cli import _with_split

DIR, W1, W2 = "N_ditm1-t1s36_0947", "N_p150-t1s11_0917", "N_p150-t1s11_1317"
BUY = "N_buy-t1s47_0917"
NORMAL = {"NIFTY": "2", "SENSEX": "4"}
EXPIRY = {"NIFTY": "0", "SENSEX": "2"}


def _settings(split=True, angel_boost=False):
    s = json.loads(json.dumps(a.DEFAULT))
    for b in a.BROKERS:
        s["rows"][f"algotest.{b}"].update(upload=True, list="t1", addon=True)
    s["rows"]["algotest.finvasia"]["dirBoost"] = True
    s["rows"]["algotest.angelone"]["dirBoost"] = angel_boost
    s["splitT1"] = split
    return s


def _picks(dte=NORMAL, buy=()):
    return ax.DayPicks(date(2026, 11, 6), "t1", "preview", [W1, DIR, W2], list(buy), dte=dte)


def _lots(doc):
    return {leg["LotConfig"]["Value"] for leg in doc["strategy"]["ListOfLegConfigs"]}


def test_a_normal_day_exports_every_copy_and_records_the_accounts(tmp_path):
    picks = _with_split(_picks(), "t1", _settings())
    assert picks.accounts == {"finvasia": {W1: 2, DIR: 2}, "angelone": {DIR: 1, W2: 2}}
    exports = ax.build(picks)
    assert [e.name for _, e in exports] == [
        f"T1 · {W1}",
        f"T1 · {W1} · ×2",
        f"T1 · {DIR}",
        f"T1 · {DIR} · ×2",
        f"T1 · {W2}",
        f"T1 · {W2} · ×2",
    ]
    ax.write(picks, exports, tmp_path)
    m = json.loads((tmp_path / "manifest.json").read_text())
    assert m["split"] == "BL-209" and m["dte"] == NORMAL
    assert m["accounts"] == {
        "finvasia": [f"T1 · {W1} · ×2", f"T1 · {DIR} · ×2"],
        "angelone": [f"T1 · {DIR}", f"T1 · {W2} · ×2"],
    }
    assert m["alone"] == {
        "finvasia": [f"T1 · {W1}", f"T1 · {DIR} · ×2", f"T1 · {W2}"],
        "angelone": [f"T1 · {W1}", f"T1 · {DIR}", f"T1 · {W2}"],
    }
    by_name = {s["name"]: s for s in m["strategies"]}
    assert by_name[f"T1 · {W2} · ×2"] == {
        "variant": W2,
        "name": f"T1 · {W2} · ×2",
        "addon": False,
        "file": f"{W2}-x2.algtst",
        "lots": 2,
    }
    two = json.loads((tmp_path / f"{W2}-x2.algtst").read_text())
    one = json.loads((tmp_path / f"{W2}.algtst").read_text())
    assert _lots(two) == {2} and _lots(one) == {1}
    # AlgoTest scales the overall MTM SL by the leg lots itself: the 1-lot figure in both
    assert two["strategy"]["OverallSL"] == one["strategy"]["OverallSL"]
    every = {n for layout in (m["accounts"], m["alone"]) for ns in layout.values() for n in ns}
    assert every == set(by_name)


def test_an_expiry_day_has_no_dir_x2_copy_and_the_add_on_goes_to_shoonya(tmp_path):
    picks = _with_split(_picks(EXPIRY, buy=[BUY]), "t1", _settings())
    ax.write(picks, ax.build(picks), tmp_path)
    m = json.loads((tmp_path / "manifest.json").read_text())
    assert len(m["strategies"]) == 6  # five core copies and the add-on
    assert m["accounts"]["finvasia"][-1] == f"T1 · {BUY} · add-on"
    assert all("add-on" not in n for n in m["accounts"]["angelone"])
    assert all(ns[-1] == f"T1 · {BUY} · add-on" for ns in m["alone"].values())


def test_off_or_one_row_the_export_is_as_before(tmp_path):
    assert _with_split(_picks(), "t1", _settings(split=False)) is None
    one = _settings()
    one["rows"]["algotest.angelone"]["upload"] = False
    assert _with_split(_picks(), "t1", one) is None
    assert _with_split(_picks(), "core", _settings()) is None
    plain = _picks()
    ax.write(plain, ax.build(plain), tmp_path)
    m = json.loads((tmp_path / "manifest.json").read_text())
    assert "accounts" not in m and "split" not in m
    assert [s["file"] for s in m["strategies"]] == [f"{v}.algtst" for v in plain.core]


def test_both_rows_on_dir_x2_split_the_doubled_lot_per_account():
    picks = _with_split(_picks(), "t1", _settings(angel_boost=True))
    assert picks.accounts == {"finvasia": {W1: 2, DIR: 2}, "angelone": {DIR: 2, W2: 2}}
    names = [e.name for _, e in ax.build(picks)]
    assert f"T1 · {DIR}" not in names and f"T1 · {DIR} · ×2" in names
