"""BL-205 Phase 2: the margin each account had and needed, per day. Every figure, account and
scrip here is invented."""

from __future__ import annotations

import json
from datetime import date
from pathlib import Path

from option_backtesting.realised import margin, store

NORMAL = "2026-10-28"  # a Wednesday: neither index expires
NIFTY_EXPIRY = "2026-11-03"  # a Tuesday
SENSEX_EXPIRY = "2026-10-29"  # a Thursday


def _jsonl(path: Path, rows: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("".join(json.dumps(r) + "\n" for r in rows))


def _statement(day: str, broker: str, account: str, **total) -> dict:
    base = {
        "funds": 0,
        "securities": 0,
        "pledged": 0,
        "bank_guarantee": 0,
        "other": 0,
        "available": 0,
        "upfront": 0,
        "crystallised": 0,
        "delivery": 0,
        "requirement": 0,
        "excess": 0,
        "rms_additional": 0,
        "status": 0,
    }
    holdings = total.pop("holdings", [])
    return {
        "day": day,
        "broker": broker,
        "account": account,
        "kind": "margin_statement",
        "total": {**base, **total},
        "segments": None,
        "holdings": holdings,
    }


def _note(root: Path, day: str, broker: str, account: str) -> None:
    _jsonl(
        root / "contract-notes" / "days" / f"{day}.jsonl",
        [{"day": day, "broker": broker, "account": account, "status": "note", "fno": {}}],
    )


def _capture(root: Path, day: str, rows: list[dict]) -> None:
    _jsonl(root / "rotation" / "live" / f"{day}.jsonl", [{"kind": "strategy", **r} for r in rows])


def _fill(entry: str, exit_: str | None) -> dict:
    return {
        "entry": {"at": f"2026-10-28 {entry}:00"},
        "exit": {"at": f"2026-10-28 {exit_}:00"} if exit_ else None,
    }


SGB = {"isin": "IN0020990001", "name": "SOVEREIGN GOLD BONDS", "value": 100000}
LIQUID = {"isin": "INF000X01011", "name": "SOME ETF LIQUID BEES", "value": 50000}
LISTED_ETF = {"isin": "INF732E01037", "name": "NIPPON LIQUID", "value": 10000}
SHARE = {"isin": "INE000A01011", "name": "ACME STEEL", "value": 400000}


def test_cash_is_funds_plus_sgbs_and_liquid_funds():
    line = _statement(
        NORMAL, "finvasia", "F1", funds=30000, holdings=[SGB, LIQUID, SHARE, LISTED_ETF]
    )
    out = margin.split_collateral(line)
    assert out["cash"] == 30000 + 100000 + 50000 + 10000
    assert out["non_cash"] == 400000
    assert margin.is_cash({"isin": "INE000A01011", "name": "LIQUID STEEL"}) is False  # not a fund


def test_usable_under_the_strict_rule_is_at_most_twice_the_cash():
    assert margin.usable(1_000_000, 300_000) == 600_000
    assert margin.usable(400_000, 300_000) == 400_000
    assert margin.usable(400_000, -10_000) == 0


def test_day_types_come_from_the_expiry_calendar():
    assert margin.day_type(date.fromisoformat(NORMAL)) == "normal"
    assert margin.day_type(date.fromisoformat(NIFTY_EXPIRY)) == "nifty_expiry"
    assert margin.day_type(date.fromisoformat(SENSEX_EXPIRY)) == "sensex_expiry"


def test_lots_open_together_from_fills_and_from_the_schedule(tmp_path):
    _capture(
        tmp_path,
        NORMAL,
        [
            # AlgoTest rows with fills: 09:17-11:00 and 10:30-15:20 overlap; 12:00-12:30 does not
            {
                "broker": "finvasia",
                "variant": "A",
                "source": "tool",
                "traded": True,
                "multiplier": 2,
                "fills": [_fill("09:17", "11:00")],
            },
            {
                "broker": "finvasia",
                "variant": "B",
                "source": "tool",
                "traded": True,
                "multiplier": 1,
                "fills": [_fill("10:30", "15:20")],
            },
            {
                "broker": "finvasia",
                "variant": "C",
                "source": "tool",
                "traded": True,
                "multiplier": 1,
                "fills": [_fill("11:30", "11:45")],
            },
            {
                "broker": "finvasia",
                "variant": "D",
                "source": "tool",
                "traded": False,
                "multiplier": 5,
                "fills": [],
            },
            # Quantiply rows: no fills, open from the name's entry time (or the open) to the close
            {
                "broker": "angelone",
                "variant": "N_x_0917",
                "source": "tool",
                "traded": True,
                "multiplier": 2,
                "fills": [],
            },
            {
                "broker": "angelone",
                "variant": "S_y_1302",
                "source": "tool",
                "traded": True,
                "multiplier": 1,
                "fills": [],
            },
            {
                "broker": "angelone",
                "variant": None,
                "source": "discretionary",
                "traded": True,
                "multiplier": 3,
                "fills": [],
            },
        ],
    )
    out = margin.lots_open(date.fromisoformat(NORMAL), tmp_path)
    assert out["finvasia"] == {"lots": 3, "tool_lots": 3, "lots_from": "fills"}
    assert out["angelone"] == {"lots": 6, "tool_lots": 3, "lots_from": "schedule"}
    assert margin.lots_open(date(2026, 10, 27), tmp_path) is None


def test_days_take_the_larger_peak_and_divide_by_the_lots(tmp_path):
    d = NORMAL
    _jsonl(
        tmp_path / "contract-notes" / "margin" / f"{d}.jsonl",
        [
            _statement(d, "angelone", "R1", funds=80000, available=900000, upfront=600000),
            _statement(d, "finvasia", "F1", funds=40000, available=500000, holdings=[SGB]),
        ],
    )
    _jsonl(
        tmp_path / "contract-notes" / "ledger" / f"{d}.jsonl",
        [
            {
                "day": d,
                "broker": "angelone",
                "account": "R1",
                "kind": "margin_warning",
                "margin_used": 640000,
            },
            {
                "day": d,
                "broker": "angelone",
                "account": "R1",
                "kind": "margin_warning",
                "margin_used": 620000,
            },
        ],
    )
    _note(tmp_path, d, "angelone", "R1")
    _capture(
        tmp_path,
        d,
        [
            {
                "broker": "angelone",
                "variant": "N_x_0917",
                "source": "tool",
                "traded": True,
                "multiplier": 4,
                "fills": [],
            }
        ],
    )
    rows = {r["broker"]: r for r in margin.days(tmp_path)}
    angel = rows["angelone"]
    assert angel["peak"] == 640000  # the warning's 640k beats the statement's 600k
    assert angel["lots"] == 4
    assert angel["per_lot"] == 160000
    assert angel["cash_short"] == 640000 / 2 - 80000
    finvasia = rows["finvasia"]
    assert finvasia["peak"] is None and finvasia["per_lot"] is None
    assert finvasia["cash"] == 140000 and finvasia["usable"] == 280000


def test_the_table_keeps_the_last_n_days_of_each_type():
    rows = [
        {
            "broker": "angelone",
            "type": "normal",
            "day": f"2026-10-{d:02d}",
            "per_lot": p,
            "peak": p * 3,
            "lots": 3,
        }
        for d, p in [(1, 100.0), (2, 300.0), (5, 200.0), (6, 150.0)]
    ] + [
        {
            "broker": "finvasia",
            "type": "normal",
            "day": "2026-10-07",
            "per_lot": 999.0,
            "peak": 1,
            "lots": 1,
        }
    ]
    t = margin.table(rows, n=3)
    assert [x["day"] for x in t["normal"]["days"]] == ["2026-10-02", "2026-10-05", "2026-10-06"]
    assert t["normal"]["max"] == 300.0
    assert t["normal"]["median"] == 200.0
    assert t["nifty_expiry"] == {"days": [], "max": None, "median": None, "count": 0}


def test_interest_rate_is_the_newest_e_mails_with_the_months_total(tmp_path):
    for day, amount, shortfall in [
        ("2026-09-30", 50.0, 200000.0),
        ("2026-10-01", 60.0, 200000.0),
        ("2026-10-02", 90.0, 300000.0),
    ]:
        _jsonl(
            tmp_path / "contract-notes" / "ledger" / f"{day}.jsonl",
            [
                {
                    "day": day,
                    "broker": "angelone",
                    "kind": "collateral_interest",
                    "amount": amount,
                    "shortfall": shortfall,
                }
            ],
        )
    out = margin.interest_rate(store.load(tmp_path))
    assert out["day"] == "2026-10-02"
    assert out["rate"] == 0.0003
    assert out["month_total"] == 150.0


def test_the_margin_route(tmp_path, monkeypatch):
    from fastapi.testclient import TestClient

    from option_backtesting.api import contract_notes_routes
    from option_backtesting.api.app import create_app

    monkeypatch.setenv("TRADING_DATA_ROOT", str(tmp_path))
    contract_notes_routes._clear()
    _jsonl(
        tmp_path / "contract-notes" / "margin" / f"{NORMAL}.jsonl",
        [_statement(NORMAL, "angelone", "R1", funds=1, available=10, upfront=5)],
    )
    client = TestClient(create_app())
    body = client.get("/legwise/contract-notes/margin?days=3").json()
    assert body["days"][0]["account"] == "angelone/R1"
    assert set(body["table"]) == set(margin.DAY_TYPES)
    assert client.get("/legwise/contract-notes/margin?days=0").status_code == 422


def test_without_a_note_the_lots_go_to_the_brokers_biggest_account(tmp_path):
    d = NORMAL
    _jsonl(
        tmp_path / "contract-notes" / "margin" / f"{d}.jsonl",
        [
            _statement(d, "finvasia", "SMALL", funds=1000, available=1000),
            _statement(d, "finvasia", "BIG", funds=1000, available=900000),
        ],
    )
    _capture(
        tmp_path,
        d,
        [
            {
                "broker": "finvasia",
                "variant": "N_x_0917",
                "source": "tool",
                "traded": True,
                "multiplier": 3,
                "fills": [],
            }
        ],
    )
    lots = {r["account"]: r["lots"] for r in margin.days(tmp_path)}
    assert lots == {"finvasia/SMALL": None, "finvasia/BIG": 3}


def test_report_lists_the_asked_days_and_tables_everything_before(tmp_path):
    for d in ("2026-10-27", NORMAL):
        _jsonl(
            tmp_path / "contract-notes" / "margin" / f"{d}.jsonl",
            [_statement(d, "angelone", "R1", funds=1, available=10, upfront=5)],
        )
    out = margin.report(tmp_path, date.fromisoformat(NORMAL))
    assert [r["day"] for r in out["days"]] == [NORMAL]
