"""BL-205 Phase 3: the evening message's margin block. Every figure and account is invented."""

from __future__ import annotations

import copy
import json
from datetime import date
from pathlib import Path

from option_backtesting.rotation import automation_settings as auto
from option_backtesting.rotation import margin_lines, tomorrow

TODAY = date(2026, 10, 29)  # a Thursday (SENSEX expiry)
NEXT = date(2026, 10, 30)  # a Friday: neither index expires
NORMAL_DTE = {"NIFTY": "2", "SENSEX": "4"}
CORE = ["N_dir_0917", "N_wide_0917", "S_wide_0947"]


def _settings(**rows) -> dict:
    s = copy.deepcopy(auto.DEFAULT)
    for key in s["rows"]:
        s["rows"][key].update(upload=False, list="none")
    for key, fields in rows.items():
        s["rows"][key.replace("_", ".")].update(fields)
    return s


def _picks(core=CORE, buy=(), dte=NORMAL_DTE, day=NEXT):
    return tomorrow.NextPicks(day, day.strftime("%a"), list(core), list(buy), None, None, dte)


def test_lots_follow_the_export_dir_boost_add_on_and_multiplier():
    settings = _settings(
        algotest_finvasia={
            "upload": True,
            "list": "t1",
            "dirBoost": True,
            "multiplier": 2,
            "addon": False,
        },
        quantiply_angelone={"upload": True, "list": "core", "dirBoost": False, "addon": True},
    )
    picks = {"t1": _picks(), "core": _picks(buy=["N_buy_1047"])}
    out = margin_lines.tomorrow_lots(settings, picks)
    assert out["finvasia"].lots == (2 + 1 + 1) * 2  # the Dir doubled, times the multiplier
    assert out["angelone"].lots == 3 + 1  # no boost, the Buy add-on in
    assert out["finvasia"].uses == ["T1 8 lots (AlgoTest)"]


def test_no_boost_on_an_expiry_day_and_nothing_when_uploads_are_off():
    settings = _settings(algotest_finvasia={"upload": True, "list": "t1", "dirBoost": True})
    expiry = {"t1": _picks(dte={"NIFTY": "0", "SENSEX": "2"})}
    assert margin_lines.tomorrow_lots(settings, expiry)["finvasia"].lots == 3
    settings["masters"]["uploads"] = False
    assert margin_lines.tomorrow_lots(settings, expiry) == {}


def test_margin_settings_default_and_refuse_bad_values():
    assert auto.margin({}) == {"bufferPct": 10, "days": 6}
    assert auto.margin({"margin": {"bufferPct": 5, "days": 3}}) == {"bufferPct": 5, "days": 3}
    assert auto.margin({"margin": {"bufferPct": 99, "days": True}}) == {"bufferPct": 10, "days": 6}


# --- the block on a store ---------------------------------------------------------------------


def _jsonl(path: Path, rows: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("".join(json.dumps(r) + "\n" for r in rows))


def _statement(day, broker, account, funds, available, upfront=0, holdings=()):
    total = dict.fromkeys(
        [
            "securities",
            "pledged",
            "bank_guarantee",
            "other",
            "crystallised",
            "delivery",
            "requirement",
            "excess",
            "rms_additional",
            "status",
        ],
        0,
    )
    total.update(funds=funds, available=available, upfront=upfront)
    return {
        "day": day,
        "broker": broker,
        "account": account,
        "total": total,
        "segments": None,
        "holdings": list(holdings),
    }


SGB = {"isin": "IN0020990001", "name": "SOVEREIGN GOLD BONDS", "value": 200000}


def _store(root: Path, finvasia_cash_only: float = 100000) -> None:
    cn = root / "contract-notes"
    # 28 Oct, a non-expiry day: Angel One needed 600k with 3 lots open together (200k a lot)
    _jsonl(
        cn / "margin" / "2026-10-28.jsonl",
        [
            _statement("2026-10-28", "angelone", "R1", 50000, 900000, upfront=600000),
            _statement("2026-10-28", "finvasia", "F1", finvasia_cash_only, 1000000, holdings=[SGB]),
        ],
    )
    _jsonl(
        cn / "days" / "2026-10-28.jsonl",
        [{"day": "2026-10-28", "broker": "angelone", "account": "R1", "status": "note"}],
    )
    _jsonl(
        root / "rotation" / "live" / "2026-10-28.jsonl",
        [
            {
                "kind": "strategy",
                "broker": "angelone",
                "variant": "N_x_0917",
                "source": "tool",
                "traded": True,
                "multiplier": 3,
                "fills": [],
                "pnl": 0,
            }
        ],
    )
    # today: the capture says Finvasia lost 20k; Angel One's 15:50 reading is 700k
    _jsonl(
        root / "rotation" / "live" / "2026-10-29.jsonl",
        [
            {
                "kind": "strategy",
                "broker": "finvasia",
                "variant": "S_y_0947",
                "source": "tool",
                "traded": True,
                "multiplier": 1,
                "fills": [],
                "pnl": -20000,
            }
        ],
    )
    manual = cn / "manual" / "2026-10-30.json"
    manual.parent.mkdir(parents=True, exist_ok=True)
    manual.write_text(
        json.dumps(
            {
                "day": "2026-10-30",
                "capital": {"angelone": 700000},
                "capital_read_at": {"angelone": {"after_close_of": "2026-10-29"}},
            }
        )
    )
    _jsonl(
        cn / "ledger" / "2026-10-28.jsonl",
        [
            {
                "day": "2026-10-28",
                "broker": "angelone",
                "kind": "collateral_interest",
                "amount": 30.0,
                "shortfall": 100000.0,
            }
        ],
    )


def test_the_block_says_what_fits_and_what_does_not(tmp_path):
    _store(tmp_path)
    settings = _settings(
        algotest_finvasia={"upload": True, "list": "t1"},
        algotest_angelone={"upload": True, "list": "t1"},
    )
    lines = margin_lines.owner_lines(TODAY, {"t1": _picks()}, tmp_path, settings=settings)
    text = "\n".join(lines)
    assert lines[0] == "🏦 Margin for Fri 30 Oct (non-expiry)"
    # 3 lots × ₹2 L a lot + 10% = ₹6.6 L
    assert "needs ≈ ₹6.6 L: 3 × ₹2 L a lot (the one non-expiry day so far) +10%" in text
    # Angel One: the 15:50 reading, ₹7 L free: fits; cash ₹0.5 L of the ₹3.3 L 50:50 wants
    assert "free ₹7 L (15:50 reading)" in text
    assert "✅ fits, ₹0.4 L spare" in text
    assert "cash ₹0.5 L of the ₹3.3 L 50:50 wants: add ₹2.8 L to clear about ₹84 a day" in text
    # Shoonya: the 28 Oct statement less today's ₹20k; cash ₹0.8 L + SGB ₹2 L = ₹2.8 L, so at
    # most ₹5.6 L usable under the strict 50:50 rule: short of ₹6.6 L, 2 lots fit
    assert "free ₹9.8 L (28 Oct statement, today −₹20,000)" in text
    assert "cash ₹2.8 L, so ₹5.6 L usable under 50:50" in text
    assert "⚠️ short ₹1 L · 2 lots fit" in text
    assert text.endswith("Your own strategies on these accounts come on top of these needs.")


def test_no_block_before_any_statement_and_a_line_when_paused(tmp_path):
    settings = _settings(algotest_finvasia={"upload": True, "list": "t1"})
    assert margin_lines.owner_lines(TODAY, {"t1": _picks()}, tmp_path, settings=settings) is None
    settings["pause"] = {"until": "2026-10-30"}
    assert margin_lines.owner_lines(TODAY, {"t1": _picks()}, tmp_path, settings=settings) == [
        "🏦 Margin for Fri 30 Oct: uploads are paused, nothing to check"
    ]


def test_a_type_with_no_day_yet_uses_the_most_of_any_type(tmp_path):
    _store(tmp_path)
    settings = _settings(algotest_angelone={"upload": True, "list": "t1"})
    picks = {"t1": _picks(dte={"NIFTY": "0", "SENSEX": "1"}, day=date(2026, 11, 3))}
    text = "\n".join(margin_lines.owner_lines(TODAY, picks, tmp_path, settings=settings))
    assert "(NIFTY expiry)" in text
    assert "no NIFTY expiry day yet: the most of any day type" in text
