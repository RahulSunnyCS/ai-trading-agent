"""BL-168 Phase 4: the contract-notes store read as the owner's sheet. Every figure, account
and contract here is invented."""

from __future__ import annotations

import json
from datetime import date, timedelta
from decimal import Decimal
from pathlib import Path

import pytest

from option_backtesting.realised import ratios, sources, store, trips


def _write(root: Path, day: str, lines: list[dict]) -> None:
    path = root / "contract-notes" / "days" / f"{day}.jsonl"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("".join(json.dumps(ln) + "\n" for ln in lines))


def _manual(root: Path, day: str, **fields) -> None:
    path = root / "contract-notes" / "manual" / f"{day}.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({"day": day, **fields}))


def _note(day: str, account: str, final_net: float, charges: float = 10.0, **extra) -> dict:
    return {
        "day": day,
        "broker": "finvasia",
        "account": account,
        "status": "note",
        "fno": {
            "payin_payout_obligation": final_net + charges,
            "net_brokerage": 0,
            "other_charges": charges,
            "total_charges": charges,
            "final_net": final_net,
        },
        **extra,
    }


def _none(day: str, account: str) -> dict:
    return {"day": day, "broker": "finvasia", "account": account, "status": "no_trade"}


# --- the sheet's formulas ------------------------------------------------------------------


@pytest.mark.parametrize(
    ("algos", "fee"), [(None, 0), (0, 0), (1, 38), (3, 63), (4, 75), (10, 150)]
)
def test_algo_fee_is_the_sheets_roundup(algos, fee):
    # ROUNDUP((algos - 3) * 12.5 + 62.5, 0)
    assert ratios.algo_fee(algos) == Decimal(fee)


def test_a_day_adds_the_accounts_and_takes_off_the_algo_fees(tmp_path):
    _write(
        tmp_path,
        "2026-04-01",
        [_note("2026-04-01", "A1", 1000, 20), _note("2026-04-01", "A2", -300, 15)],
    )
    _manual(tmp_path, "2026-04-01", algos=4, capital_total=500000)
    (row,) = ratios.daily(store.load(tmp_path))
    assert row.net == Decimal(700)
    assert row.algo_fees == Decimal(75)
    assert row.profit == Decimal(625)  # Q = net - O
    assert row.charges == Decimal(110)  # P = notes' charges + O
    assert row.capital == Decimal(500000)


def test_summary_note_charges_leave_out_the_algo_fees_of_a_day_with_no_note(tmp_path):
    _write(tmp_path, "2026-04-01", [_note("2026-04-01", "A1", 1000, 20)])
    _manual(tmp_path, "2026-04-01", algos=4)  # fee 75
    _write(tmp_path, "2026-04-02", [_none("2026-04-02", "A1")])
    _manual(tmp_path, "2026-04-02", algos=10)  # fee 150, no note: not in charges
    s = ratios.summary(ratios.daily(store.load(tmp_path)))
    assert s["algo_fees"] == 225
    assert s["charges"] == 95  # 20 + 75: a day without a note has no charges
    assert s["note_charges"] == 20  # not charges - algo_fees (-130)


def test_a_day_with_no_note_has_no_profit_and_the_averages_skip_it(tmp_path):
    start = date(2026, 1, 1)
    for i in range(100):
        d = (start + timedelta(days=i)).isoformat()
        line = _none(d, "A1") if i % 2 else _note(d, "A1", 200 if i < 50 else 400, 10)
        _write(tmp_path, d, [line])
        _manual(tmp_path, d, capital_total=100000)
    rows = ratios.daily(store.load(tmp_path))
    assert rows[1].profit is None and rows[1].charges is None
    assert rows[48].avg_profit_50 is None  # 49 rows: not yet
    last = rows[-1]
    assert last.avg_profit_50 == 400  # T: the last 50 rows' notes only
    assert last.avg_profit_100 == 300  # U
    assert last.avg_charges_100 == 10  # V
    assert last.charge_profit_pct == 3.3  # W = V * 100 / U
    assert last.avg_capital_100 == 100000  # Y
    assert last.profit_capital_bps == 30  # Z = U * 10000 / Y


def test_drawdown_and_its_longest_run(tmp_path):
    for d, net in [
        ("2026-04-01", 100),
        ("2026-04-02", -50),
        ("2026-04-03", -30),
        ("2026-04-06", 200),
    ]:
        _write(tmp_path, d, [_note(d, "A1", net, 0)])
    rows = ratios.daily(store.load(tmp_path))
    assert [float(r.drawdown) for r in rows] == [0, -50, -80, 0]
    s = ratios.summary(rows)
    assert s["max_drawdown"] == -80
    assert s["longest_drawdown"] == 2
    assert (s["win_days"], s["loss_days"]) == (2, 2)
    assert s["net"] == 220


def test_capital_carries_each_broker_and_adds_them_once_both_are_known(tmp_path):
    for d in ["2026-04-01", "2026-04-02", "2026-04-03", "2026-04-06"]:
        _write(tmp_path, d, [_note(d, "A1", 100)])
    _manual(tmp_path, "2026-04-01", capital_total=300000)
    _manual(tmp_path, "2026-04-02", capital={"angelone": 90000})  # one broker: not yet a total
    _manual(tmp_path, "2026-04-03", capital={"finvasia": 110000})  # now both are known
    _manual(tmp_path, "2026-04-06", capital={"angelone": 95000})  # Finvasia's carried
    rows = ratios.daily(store.load(tmp_path))
    assert [(float(r.capital), r.capital_source) for r in rows] == [
        (300000, "manual"),
        (300000, "carried"),
        (200000, "manual"),
        (205000, "manual"),
    ]


def test_no_note_in_100_rows_leaves_the_ratios_blank_never_a_crash(tmp_path):
    start = date(2026, 1, 1)
    for i in range(100):
        d = (start + timedelta(days=i)).isoformat()
        _write(tmp_path, d, [_none(d, "A1")])
    _manual(tmp_path, "2026-01-01", capital_total=100000)
    last = ratios.daily(store.load(tmp_path))[-1]
    assert (last.avg_profit_100, last.profit_capital_bps, last.charge_profit_pct) == (
        None,
        None,
        None,
    )


def test_rounding_is_the_sheets_half_away_from_zero(tmp_path):
    # 50 rows averaging exactly 10.5 (a float mean can land just under), W = 2.25 -> 2.3.
    start = date(2026, 1, 1)
    for i in range(100):
        d = (start + timedelta(days=i)).isoformat()
        _write(tmp_path, d, [_note(d, "A1", 10 if i % 2 else 11, 0.045 if i % 2 else 0.405)])
    last = ratios.daily(store.load(tmp_path))[-1]
    assert last.avg_profit_50 == 11  # 10.5 rounds up
    assert last.avg_charges_100 == 0


def test_a_weekend_deposit_counts_on_the_next_session(tmp_path):
    for d in ["2026-04-03", "2026-04-06"]:
        _write(tmp_path, d, [_note(d, "A1", 100)])
    path = tmp_path / "contract-notes" / "ledger" / "2026-04-04.jsonl"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(
            {
                "day": "2026-04-04",
                "broker": "angelone",
                "account": "R1",
                "kind": "deposit",
                "amount": 5000,
            }
        )
        + "\n"
    )
    rows = ratios.daily(store.load(tmp_path))
    assert [float(r.deposits) for r in rows] == [0, 5000]


def test_other_debits_accrue_per_broker_and_calendar_day(tmp_path):
    _write(tmp_path, "2026-04-01", [_note("2026-04-01", "A1", 100)])
    _write(tmp_path, "2026-04-06", [_note("2026-04-06", "A1", 100)])  # Wed -> Mon: 5 days
    angel = _note("2026-04-07", "B1", 100) | {"broker": "angelone"}
    _write(tmp_path, "2026-04-07", [_note("2026-04-07", "A1", 100), angel])
    book = store.load(tmp_path)
    rows = ratios.daily(book)
    per_day = Decimal(1000) / 365
    assert [r.other_debits for r in rows] == [
        per_day.quantize(Decimal("0.01")),
        (per_day * 5).quantize(Decimal("0.01")),
        (per_day * 2).quantize(Decimal("0.01")),  # Finvasia's day and Angel One's first
    ]
    s = ratios.summary(rows)
    assert s["net"] == 400.0  # never inside the sheet's figures
    assert s["net_after_debits"] == pytest.approx(400 - float(sum(r.other_debits for r in rows)))
    one = ratios.daily(book, account="angelone/B1")
    assert [r.other_debits for r in one] == [per_day.quantize(Decimal("0.01"))]


def test_months_and_financial_years(tmp_path):
    for d, net in [("2026-03-31", 100), ("2026-04-01", 200), ("2026-05-04", -50)]:
        _write(tmp_path, d, [_note(d, "A1", net, 0)])
        _manual(tmp_path, d, capital_total=10000)
    rows = ratios.daily(store.load(tmp_path))
    assert [(m["month"], m["profit"], m["pct"]) for m in ratios.months(rows)] == [
        ("2026-03", 100.0, 1.0),
        ("2026-04", 200.0, 2.0),
        ("2026-05", -50.0, -0.5),
    ]
    assert [(f["fy"], f["profit"]) for f in ratios.fiscal_years(rows)] == [
        ("2025-26", 100.0),
        ("2026-27", 150.0),
    ]


def test_a_damaged_line_is_reported_not_fatal(tmp_path):
    _write(tmp_path, "2026-04-01", [_note("2026-04-01", "A1", 100)])
    path = tmp_path / "contract-notes" / "days" / "2026-04-01.jsonl"
    path.write_text(path.read_text() + '{"day": "2026-04\x00\x00\n')
    book = store.load(tmp_path)
    assert len(book.lines[date(2026, 4, 1)]) == 1
    assert book.problems == ["days/2026-04-01.jsonl line 2 is damaged"]


# --- round trips ---------------------------------------------------------------------------


def _fill(side, qty, total, time, strike=22400, kind="PE", expiry="2026-04-07"):
    return {
        "instrument": "OPTIDX",
        "underlying": "NIFTY",
        "expiry": expiry,
        "strike": strike,
        "kind": kind,
        "side": side,
        "qty": qty,
        "net_total": total,
        "time": time,
    }


def _book(tmp_path, days: dict[str, list[dict]]):
    for d, lines in days.items():
        _write(tmp_path, d, lines)
    return store.load(tmp_path)


def test_fills_pair_from_flat_to_flat_and_trips_add_up_to_the_note(tmp_path):
    fills = [
        _fill("sell", 75, 3000, "09:17:05"),  # trip 1 opens short
        _fill("buy", 75, -2250, "11:02:40"),  # and closes: +750
        _fill("sell", 75, 2700, "13:00:00"),  # trip 2 opens
        _fill("buy", 75, -3300, "14:10:00"),  # and closes: -600
        _fill("buy", 75, -1500, "10:00:00", strike=22600, kind="CE"),  # long, held to expiry
    ]
    # the fills sum to -1350; the note's other charges are 50 more
    line = _note("2026-04-07", "A1", -1400, 50, trades=fills, trades_check="fills")
    out = trips.trips(_book(tmp_path, {"2026-04-07": [line]}))
    closed = [t for t in out if t.status == "closed"]
    assert [(t.direction, float(t.pnl), t.entry_time, t.exit_time) for t in closed] == [
        ("short", 750.0, "09:17:05", "11:02:40"),
        ("short", -600.0, "13:00:00", "14:10:00"),
    ]
    assert closed[0].holding_minutes == 105
    (expired,) = [t for t in out if t.status == "expired"]
    assert float(expired.pnl) == -1500 and expired.direction == "long"
    assert sum(t.net for t in out) == Decimal("-1400")  # the note's final net
    assert all(t.dte == 0 for t in out)


def test_a_fill_through_zero_closes_the_trip_and_opens_the_other_way(tmp_path):
    fills = [
        _fill("sell", 75, 3000, "09:20:00"),
        _fill("buy", 150, -3000, "10:00:00"),  # closes 75 short (-1500), opens 75 long (-1500)
        _fill("sell", 75, 1800, "11:00:00"),  # closes the long: +300
    ]
    line = _note("2026-04-07", "A1", 1800, 0, trades=fills, trades_check="fills")
    out = trips.trips(_book(tmp_path, {"2026-04-07": [line]}))
    assert [(t.direction, t.qty, float(t.pnl), t.status) for t in out] == [
        ("short", 75, 1500.0, "closed"),
        ("long", 75, 300.0, "closed"),
    ]


def test_a_position_carried_overnight_closes_on_the_next_note(tmp_path):
    day1 = _note(
        "2026-04-06",
        "A1",
        1000,
        0,
        trades=[_fill("sell", 75, 1000, "15:10:00")],
        trades_check="fills",
    )
    day2 = _note(
        "2026-04-07",
        "A1",
        -400,
        0,
        trades=[_fill("buy", 75, -400, "09:30:00")],
        trades_check="fills",
    )
    (t,) = trips.trips(_book(tmp_path, {"2026-04-06": [day1], "2026-04-07": [day2]}))
    assert (t.direction, t.status, float(t.pnl)) == ("short", "closed", 600.0)
    assert (t.entry_day, t.day, t.holding_minutes) == (date(2026, 4, 6), date(2026, 4, 7), None)
    assert t.dte == 1  # from the entry day


def test_still_open_after_the_last_note_is_open_with_no_pnl(tmp_path):
    line = _note(
        "2026-04-06",
        "A1",
        990,
        10,
        trades=[_fill("sell", 75, 1000, "09:30:00")],
        trades_check="fills",
    )
    (t,) = trips.trips(_book(tmp_path, {"2026-04-06": [line]}))
    assert t.status == "open" and t.pnl is None and t.dte == 1


def test_a_carried_position_whose_note_did_not_read_is_unresolved(tmp_path):
    day1 = _note(
        "2026-04-06",
        "A1",
        1000,
        0,
        trades=[_fill("sell", 75, 1000, "15:10:00")],
        trades_check="fills",
    )
    day2 = _note(
        "2026-04-08",
        "A1",
        -400,
        0,
        trades=[_fill("buy", 75, -1, "09:30:00", expiry="2026-04-14")],
        trades_check="unmatched",
    )
    (t,) = trips.trips(_book(tmp_path, {"2026-04-06": [day1], "2026-04-08": [day2]}))
    assert t.status == "expired"  # expired 7 Apr, before the unread note
    day1b = _note(
        "2026-04-06",
        "A1",
        1000,
        0,
        trades=[_fill("sell", 75, 1000, "15:10:00", expiry="2026-04-14")],
        trades_check="fills",
    )
    (t,) = trips.trips(_book(tmp_path, {"2026-04-06": [day1b], "2026-04-08": [day2]}))
    assert (t.status, t.pnl) == ("unresolved", None)


def test_summary_rows_pair_by_side_without_times(tmp_path):
    rows = [
        {**_fill("sell", 150, 6000, None), "time": None},
        {**_fill("buy", 150, -4500, None), "time": None},
    ]
    line = _note("2026-04-01", "A1", 1480, 20, trades=rows, trades_check="summary")
    (t,) = trips.trips(_book(tmp_path, {"2026-04-01": [line]}))
    assert (t.status, t.direction, float(t.pnl), t.entry_time) == ("closed", None, 1500.0, None)
    assert t.net == Decimal("1480")


def test_unmatched_trades_give_no_trips(tmp_path):
    line = _note(
        "2026-04-01", "A1", 100, trades=[_fill("sell", 75, 1, "09:30:00")], trades_check="unmatched"
    )
    assert trips.trips(_book(tmp_path, {"2026-04-01": [line]})) == []


def test_angel_one_trips_start_where_its_notes_read(tmp_path):
    fills = [_fill("sell", 75, 3000, "09:20:00"), _fill("buy", 75, -2000, "10:00:00")]

    def angel(day):
        line = _note(day, "B1", 990, 10, trades=fills, trades_check="fills")
        return line | {"broker": "angelone"}

    before = trips.TRADES_FROM["angelone"] - timedelta(days=1)
    book = _book(tmp_path, {str(before): [angel(str(before))], "2026-02-02": [angel("2026-02-02")]})
    (t,) = trips.trips(book)
    assert t.day == date(2026, 2, 2)
    assert trips.coverage(book) == {"before_trades_from": 1, "fills": 1}
    # the day figures still read every note
    assert [r.net for r in ratios.daily(book)] == [Decimal("990"), Decimal("990")]


def test_a_position_held_across_trades_from_pairs_and_is_left_out(tmp_path):
    def angel(day, fills, net):
        line = _note(day, "B1", net, 0, trades=fills, trades_check="fills")
        return line | {"broker": "angelone"}

    sell = _fill("sell", 75, 3000, "15:00:00", expiry="2026-02-03")
    buy = _fill("buy", 75, -2000, "09:30:00", expiry="2026-02-03")
    book = _book(
        tmp_path,
        {
            "2026-01-30": [angel("2026-01-30", [sell], 3000)],
            "2026-02-02": [angel("2026-02-02", [buy], -2000)],
        },
    )
    assert trips.trips(book) == []  # opened before 2 Feb: no trip, and no false "expired" one
    assert trips.partial_years() == {"2025-26": ["angelone"]}


def test_weekdays_between_skips_the_weekend():
    assert trips.weekdays_between(date(2026, 10, 23), date(2026, 10, 27)) == 2  # Fri -> Tue
    assert trips.weekdays_between(date(2026, 10, 27), date(2026, 10, 27)) == 0


def test_turnover_by_financial_year(tmp_path):
    line = _note(
        "2026-04-07",
        "A1",
        140,
        10,
        trades=[_fill("sell", 75, 300, "09:17:00"), _fill("buy", 75, -150, "10:00:00")],
        trades_check="fills",
    )
    out = trips.turnover([t for t in trips.trips(_book(tmp_path, {"2026-04-07": [line]}))])
    assert out == {"2026-27": {"turnover": 150.0, "profit": 150.0, "charges": 10.0, "trips": 1}}


# --- sources -------------------------------------------------------------------------------


def _capture(root: Path, day: str, rows: list[dict]) -> None:
    path = root / "rotation" / "live" / f"{day}.jsonl"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("".join(json.dumps({"kind": "strategy", "day": day, **r}) + "\n" for r in rows))


def _trip(day="2026-10-21", strike=22400.0, entry="09:17:05", broker="finvasia", direction="short"):
    d = date.fromisoformat(day)
    return trips.Trip(
        day=d,
        entry_day=d,
        broker=broker,
        account="A1",
        underlying="NIFTY",
        instrument="OPTIDX",
        expiry=date(2026, 10, 27),
        strike=strike,
        kind="PE",
        direction=direction,
        qty=75,
        entry_time=entry,
        exit_time="11:00:00",
        entry_price=40.0,
        exit_price=30.0,
        pnl=Decimal(750),
        charges=Decimal(10),
        status="closed",
        fills=2,
        source_check="fills",
        dte=4,
    )


FILL = {
    "symbol": "NIFTY26O2722400PE",
    "side": "S",
    "qty": 75,
    "entry": {"price": 40, "at": "2026-10-21T09:17:30+05:30"},
    "exit": None,
}


def _t1(fills):
    return {
        "broker": "finvasia",
        "traded": True,
        "source": "tool",
        "book": "t1",
        "name": "T1 · x",
        "fills": fills,
    }


def test_sources(tmp_path):
    _capture(tmp_path, "2026-10-21", [_t1([FILL])])
    assert sources.source_of(tmp_path, _trip())["source"] == "t1"
    assert sources.source_of(tmp_path, _trip(strike=22500.0))["source"] == "manual"
    assert sources.source_of(tmp_path, _trip(entry="10:30:00"))["source"] == "manual"
    assert sources.source_of(tmp_path, _trip(direction="long"))["source"] == "manual"  # a sell
    assert sources.source_of(tmp_path, _trip(entry=None))["source"] == "unattributed"
    assert sources.source_of(tmp_path, _trip(day="2026-10-16"))["source"] == "unknown"
    _capture(
        tmp_path,
        "2026-10-22",
        [
            {
                "broker": "finvasia",
                "traded": True,
                "source": "discretionary",
                "name": "mine",
                "fills": None,
            }
        ],
    )
    assert sources.source_of(tmp_path, _trip(day="2026-10-22"))["source"] == "unattributed"


def test_a_fill_labels_one_trip_and_a_failed_section_is_never_manual(tmp_path):
    _capture(tmp_path, "2026-10-21", [_t1([FILL])])
    labels = sources.label(tmp_path, [_trip(), _trip()])
    assert [x["source"] for x in labels] == ["t1", "manual"]
    path = tmp_path / "rotation" / "live" / "2026-10-21.jsonl"
    path.write_text(
        path.read_text() + json.dumps({"kind": "section", "broker": "finvasia", "ok": False}) + "\n"
    )
    assert sources.source_of(tmp_path, _trip(strike=22500.0))["source"] == "unattributed"


def test_day_context_lists_events_and_reads_the_iv_percentile(tmp_path, monkeypatch):
    from option_backtesting.realised import context

    assert [e["event"] for e in context.events(date(2026, 2, 1))] == ["UNION_BUDGET"]
    assert context.events(date(2026, 2, 2)) == []
    monkeypatch.setattr(context, "_index_bars", lambda root, name, day: [(None, 100, 110, 95, 105)])
    monkeypatch.setattr(context, "_index_days", lambda root, name: [])
    rows = {"NIFTY": {"iv_7d_1500": 0.123, "iv_7d_pct_1y": 0.84}}
    monkeypatch.setattr(context.derived, "iv_for_day", lambda root, u, day: rows.get(u))
    out = context.day_context(tmp_path, date(2026, 10, 7))
    assert out["events"][0]["event"] == "RBI_POLICY"
    assert (out["indices"]["NIFTY"]["iv_7d"], out["indices"]["NIFTY"]["iv_pct"]) == (12.3, 84.0)
    assert out["indices"]["SENSEX"]["iv_pct"] is None  # not built: blank, never zero


def test_symbols_parse_weekly_and_monthly():
    assert sources.parse_symbol("SENSEX26O2273500CE") == {
        "underlying": "SENSEX",
        "strike": 73500.0,
        "kind": "CE",
        "expiry": date(2026, 10, 22),
    }
    assert sources.parse_symbol("NIFTY26OCT22400PE")["expiry"] is None
    assert sources.parse_symbol("garbage") is None


# --- capital -------------------------------------------------------------------------------


def test_the_closing_reading_is_the_next_sessions_capital(tmp_path):
    from option_backtesting.realised import capital

    nxt = capital.record_capital(tmp_path, date(2026, 10, 23), "angelone", 95000, "test")
    assert nxt == date(2026, 10, 26)  # Friday -> Monday
    base = tmp_path / "contract-notes" / "manual"
    assert json.loads((base / "2026-10-23.json").read_text())["closing_funds"] == {
        "angelone": 95000
    }
    assert json.loads((base / "2026-10-26.json").read_text())["capital"] == {"angelone": 95000}


def test_a_damaged_manual_file_is_kept_aside_and_rewritten(tmp_path):
    from option_backtesting.realised import capital

    base = tmp_path / "contract-notes" / "manual"
    base.mkdir(parents=True)
    (base / "2026-10-23.json").write_text('{"algos": 4')
    capital.write_manual(tmp_path, date(2026, 10, 23), lambda m: {**m, "algos": 5})
    assert json.loads((base / "2026-10-23.json").read_text()) == {"algos": 5}
    assert (base / "2026-10-23.json.damaged").exists()


# --- the routes ----------------------------------------------------------------------------


def test_routes_read_and_the_inputs_route_writes(tmp_path, monkeypatch):
    from fastapi.testclient import TestClient

    from option_backtesting.api import contract_notes_routes
    from option_backtesting.api.app import create_app

    monkeypatch.setenv("TRADING_DATA_ROOT", str(tmp_path))
    contract_notes_routes._clear()
    _write(tmp_path, "2026-04-01", [_note("2026-04-01", "A1", 1000, 20)])
    client = TestClient(create_app())
    body = client.get("/legwise/contract-notes/summary").json()
    assert body["summary"]["net"] == 1000
    r = client.put(
        "/legwise/contract-notes/inputs/2026-04-01", json={"algos": 4, "capital_total": 200000}
    )
    assert r.status_code == 200
    days = client.get("/legwise/contract-notes/days").json()["days"]
    assert (days[0]["algo_fees"], days[0]["profit"], days[0]["capital"]) == (75.0, 925.0, 200000.0)
    assert (
        client.put("/legwise/contract-notes/inputs/2026-04-01", json={"algos": -1}).status_code
        == 422
    )
    assert (
        client.put("/legwise/contract-notes/inputs/2026-04-01", json={"note": "x"}).status_code
        == 422
    )
    assert client.get("/legwise/contract-notes/days?from=x").status_code == 422
    r = client.put("/legwise/contract-notes/inputs/2026-04-01", json={"algos": None})
    assert "algos" not in r.json()["manual"]


def test_the_inputs_route_refuses_bad_values(tmp_path, monkeypatch):
    from fastapi.testclient import TestClient

    from option_backtesting.api.app import create_app

    monkeypatch.setenv("TRADING_DATA_ROOT", str(tmp_path))
    client = TestClient(create_app())
    put = lambda day, body: client.put(f"/legwise/contract-notes/inputs/{day}", json=body)  # noqa: E731
    assert put("2026-04-01", {"algos": True}).status_code == 422  # a bool is not a count
    assert put("2099-01-01", {"algos": 1}).status_code == 422  # far in the future
    assert put("2026-04-01", {"capital": {"finvasia": "x"}}).status_code == 422
    r = put("2026-04-01", {"capital": {"finvasia": 100000, "angelone": 90000}})
    r = put("2026-04-01", {"capital": {"angelone": None}})  # a null inside capital removes it
    assert r.json()["manual"]["capital"] == {"finvasia": 100000}
    assert client.get("/legwise/contract-notes/trips?extremes=true").status_code == 422
    ok = client.get("/legwise/contract-notes/trips?extremes=true&from=2026-04-01&to=2026-04-30")
    assert ok.status_code == 200


# --- the cache ------------------------------------------------------------------------------


def _ledger(root: Path, day: str, events: list[dict]) -> None:
    path = root / "contract-notes" / "ledger" / f"{day}.jsonl"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("".join(json.dumps(e) + "\n" for e in events))


def test_a_cached_book_is_the_fresh_one_and_a_repeat_reads_nothing(tmp_path, monkeypatch):
    from option_backtesting.realised import views

    store.forget()
    _write(tmp_path, "2026-04-01", [_note("2026-04-01", "A1", 1000, 20)])
    _write(tmp_path, "2026-04-02", [_note("2026-04-02", "A1", -400, 12)])
    with (tmp_path / "contract-notes" / "days" / "2026-04-02.jsonl").open("a") as f:
        f.write("not json\n")  # a damaged line: a problem, cached like the rest
    _ledger(tmp_path, "2026-04-02", [{"kind": "deposit", "amount": 50000}])
    _manual(tmp_path, "2026-04-01", algos=4, capital_total=500000)
    assert store.load_cached(tmp_path) == store.load(tmp_path)
    for view in (views.summary, views.days, views.months, views.money, views.momentum):
        got = view(tmp_path)
        store.forget()
        assert got == view(tmp_path)  # a cached answer is the one from a fresh read
    store.load_cached(tmp_path)
    monkeypatch.setattr(store, "load", lambda root: pytest.fail("read again with nothing changed"))
    assert store.load_cached(tmp_path) is store.load_cached(tmp_path)


def test_a_changed_note_ledger_or_manual_file_is_read_again(tmp_path):
    store.forget()
    _write(tmp_path, "2026-04-01", [_note("2026-04-01", "A1", 1000, 20)])
    assert ratios.summary(ratios.daily(store.load_cached(tmp_path)))["net"] == 1000
    _write(tmp_path, "2026-04-01", [_note("2026-04-01", "A1", 12345, 20)])
    assert ratios.summary(ratios.daily(store.load_cached(tmp_path)))["net"] == 12345
    _write(tmp_path, "2026-04-02", [_note("2026-04-02", "A1", 5, 1)])  # a new file
    assert len(store.load_cached(tmp_path).days) == 2
    _ledger(tmp_path, "2026-04-02", [{"kind": "deposit", "amount": 1}])
    assert store.load_cached(tmp_path).ledger[date(2026, 4, 2)][0]["amount"] == 1
    _manual(tmp_path, "2026-04-01", algos=4)
    assert store.load_cached(tmp_path).manual[date(2026, 4, 1)]["algos"] == 4
    (tmp_path / "contract-notes" / "manual" / "2026-04-01.json").unlink()
    assert date(2026, 4, 1) not in store.load_cached(tmp_path).manual
    assert store.load_cached(tmp_path) == store.load(tmp_path)


def test_the_routes_see_a_changed_note_or_input_at_once(tmp_path, monkeypatch):
    from fastapi.testclient import TestClient

    from option_backtesting.api import contract_notes_routes
    from option_backtesting.api.app import create_app

    monkeypatch.setenv("TRADING_DATA_ROOT", str(tmp_path))
    contract_notes_routes._clear()
    _write(tmp_path, "2026-04-01", [_note("2026-04-01", "A1", 1000, 20)])
    client = TestClient(create_app())

    def first_day() -> dict:
        return client.get("/legwise/contract-notes/days").json()["days"][0]

    assert first_day()["net"] == 1000
    # Inside the response cache's 20 s: a note file the nightly run rewrote is seen at once.
    _write(tmp_path, "2026-04-01", [_note("2026-04-01", "A1", 2500, 20)])
    assert first_day()["net"] == 2500
    # So is an input written outside the page (the 15:50 capital reading writes manual/).
    _manual(tmp_path, "2026-04-01", algos=4)
    assert first_day()["algo_fees"] == 75.0
    # And one saved through the page.
    r = client.put("/legwise/contract-notes/inputs/2026-04-01", json={"algos": 10})
    assert r.status_code == 200
    assert first_day()["algo_fees"] == 150.0
    summary = client.get("/legwise/contract-notes/summary").json()
    contract_notes_routes._clear()
    assert client.get("/legwise/contract-notes/summary").json() == summary
