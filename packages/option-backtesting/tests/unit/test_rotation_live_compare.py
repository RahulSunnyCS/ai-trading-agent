"""BL-141 Phase 3: live (the 15:40 capture) beside paper, and its lines in the owner's message."""

from __future__ import annotations

import json
from datetime import date

import pytest

from option_backtesting.rotation import deliver, journal, live_compare, messages, store, tomorrow

DAY = date(2026, 10, 19)
T1 = ["N_ditm1-t1s36_0947", "N_p150-t1s11_0917", "N_p150-t1s11_1317"]


def _paper(root, name, net, costs=0.0, day=DAY):
    store.append_result(
        name, {"day": day.isoformat(), "net": net, "gross": net + costs, "costs": costs}, root
    )


def _fill(at, price, qty=65, side="S"):
    return {
        "leg": "leg_1",
        "symbol": "X",
        "side": side,
        "qty": qty,
        "entry": {"price": price, "at": at},
        "exit": None,
    }


def _line(
    name, pnl, *, source="tool", platform="algotest", broker="finvasia", mult=1, fills=None, pid="1"
):
    variant = name.split(" · ")[1] if source == "tool" else None
    return {
        "kind": "strategy",
        "day": DAY.isoformat(),
        "platform": platform,
        "broker": broker,
        "name": name,
        "variant": variant,
        "book": "t1" if source == "tool" else None,
        "addon": False,
        "source": source,
        "platform_id": pid,
        "multiplier": mult,
        "pnl": pnl,
        "status": "SquaredOff",
        "open_legs": 0,
        "fills": fills,
        "pnl_source": "legs",
    }


def _section(platform, broker, ok=True):
    return {
        "kind": "section",
        "day": DAY.isoformat(),
        "platform": platform,
        "broker": broker,
        "ok": ok,
        "error": None if ok else "login failed",
        "strategies": 0,
        "captured_at": "2026-10-19T10:10:00Z",
    }


def _capture(root, lines, day=DAY):
    path = live_compare.live_path(day, root)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("".join(json.dumps(x) + "\n" for x in lines) + '{"kind":"stra')  # a torn tail


@pytest.fixture
def root(tmp_path):
    r = tmp_path / "TradingData"
    _paper(r, T1[0], 2713.75)
    _paper(r, T1[1], -4260.75)
    _paper(r, T1[2], 789.75)
    return r


def test_slippage_per_lot_is_live_minus_paper_signed(root):
    _capture(
        root,
        [
            _section("algotest", "all"),
            _line("T1 · N_ditm1-t1s36_0947", 2795.0, fills=[_fill("2026-10-19 09:46:59", 100)]),
            _line("T1 · N_p150-t1s11_1317", 910.0, fills=[_fill("2026-10-19 13:16:59", 50)]),
        ],
    )
    c = live_compare.compare(DAY, root)
    by = {x.variant: x for x in c.compared}
    assert by[T1[0]].slippage == pytest.approx(81.25)  # live beat paper: +
    assert by[T1[2]].slippage == pytest.approx(120.25)
    # % of the entry premium per lot: 100 x 65
    assert by[T1[0]].slippage_pct == pytest.approx(81.25 / 6500 * 100)
    [g] = c.groups()
    assert (g.platform, g.book, g.variants) == ("algotest", "t1", 2)
    assert g.slippage == pytest.approx(201.5)
    assert g.slippage_pct == pytest.approx(201.5 / (6500 + 3250) * 100)


def test_copies_are_lots_not_slippage_and_costs_come_off_live_too(root):
    _paper(root, "N_wide_1117", 1000.0, costs=50.0)
    _capture(
        root,
        [
            _section("algotest", "all"),
            _line("T1 · N_wide_1117", 1900.0, pid="a"),
            _line("T1 · N_wide_1117", 2000.0, mult=2, pid="b"),
        ],
    )
    [x] = live_compare.compare(DAY, root).compared
    assert (x.copies, x.lots) == (2, 3.0)
    assert x.live_per_lot == pytest.approx(1300.0)
    # (1300 − 50) − 1000: the same costs both sides
    assert x.slippage == pytest.approx(250.0)
    assert x.slippage_pct is None  # no fills, no premium


def test_a_copy_away_from_its_entry_minute_is_off_slot_not_slippage(root):
    _capture(
        root,
        [
            _section("algotest", "all"),
            _line(
                "T1 · N_p150-t1s11_0917",
                -4095.0,
                fills=[_fill("2026-10-19 09:16:59", 150)],
                pid="a",
            ),
            _line(
                "T1 · N_p150-t1s11_0917", 5206.5, fills=[_fill("2026-10-19 09:45:59", 150)], pid="b"
            ),
        ],
    )
    c = live_compare.compare(DAY, root)
    [x] = c.compared
    assert x.copies == 1 and x.slippage == pytest.approx(165.75)
    assert [o["platform_id"] for o in c.off_slot] == ["b"]


def test_discretionary_lines_are_summed_apart_and_never_compared(root):
    _capture(
        root,
        [
            _section("quantiply", "angelone"),
            _line(
                "N_ITM1_SL21_3000",
                -3129.75,
                source="discretionary",
                platform="quantiply",
                broker="angelone",
            ),
            _line(
                "N_OTM1_SL115",
                1010.75,
                source="discretionary",
                platform="quantiply",
                broker="angelone",
            ),
        ],
    )
    c = live_compare.compare(DAY, root)
    assert c.compared == [] and c.discretionary_total == pytest.approx(-2119.0)
    lines = live_compare.message_lines(c, messages.rupees)
    assert lines == ["💹 Live vs paper · per lot", "✋ Discretionary  −₹2,119 (2)"]


def test_no_capture_a_failed_section_and_a_missing_paper_result_are_said(root):
    assert live_compare.message_lines(live_compare.compare(DAY, root), messages.rupees) == [
        "💹 Live · not captured"
    ]
    _capture(
        root,
        [
            _section("algotest", "all"),
            _line("T1 · N_unknown_0917", 10.0),
            _section("quantiply", "angelone", ok=False),
        ],
    )
    lines = live_compare.message_lines(live_compare.compare(DAY, root), messages.rupees)
    assert "Quantiply · Angel One  live not captured" in lines
    assert "AlgoTest · Shoonya N_unknown_0917  no paper result" in lines


def test_the_message_line_per_platform_and_list(root):
    _capture(root, [_section("algotest", "all"), _line("T1 · N_p150-t1s11_1317", 910.0)])
    lines = live_compare.message_lines(live_compare.compare(DAY, root), messages.rupees)
    assert lines[1] == "AlgoTest · Shoonya T1  +₹910 vs +₹790 · slip +₹120"


# -- in the 16:00 message ------------------------------------------------------------------------


@pytest.fixture
def evening(root, monkeypatch):
    monkeypatch.setenv("TELEGRAM_CHAT_ID", "123")
    monkeypatch.setenv("TELEGRAM_ROTATION_CHAT_ID", "-456")
    core = ["N_ditm1_0917", "N_wide_1117", "N_p100_1202"]
    for track, names in ((None, core), ("t1", T1)):
        journal.append(
            store.journal_path(root, track),
            {
                "day": DAY.isoformat(),
                "weekday": "Mon",
                "before_first_entry": True,
                "lists": {"C": {"core": names, "buy": []}},
            },
        )
    for name in core:
        _paper(root, name, 100.0)
    monkeypatch.setattr(tomorrow, "next_session_picks", lambda today, root=None, track=None: None)
    return root


class Sent:
    def __init__(self):
        self.messages: list[tuple[str | None, str]] = []

    def __call__(self, text, severity="info", chat_id=None):
        self.messages.append((chat_id, text))
        return True


def _send(root):
    sent = Sent()
    code = deliver.send_result(
        DAY, root=root, send=sent, echo=lambda m: None, alert=lambda t, b: None
    )
    assert code == 0
    return [t for c, t in sent.messages if c is None], [t for c, t in sent.messages if c == "-456"]


def test_before_the_capture_ever_ran_the_message_is_unchanged(evening):
    owner, group = _send(evening)
    assert "💹" not in owner[0] and "💹" not in group[0]


def test_the_owner_gets_the_live_lines_and_the_group_never_does(evening):
    _capture(evening, [_section("algotest", "all"), _line("T1 · N_p150-t1s11_1317", 910.0)])
    owner, group = _send(evening)
    assert (
        "💹 Live vs paper · per lot\nAlgoTest · Shoonya T1  +₹910 vs +₹790 · slip +₹120" in owner[0]
    )
    assert "💹" not in group[0]
    # after T1's result, before tomorrow
    assert owner[0].index("🧪 T1") < owner[0].index("💹")


def test_a_day_with_no_capture_says_live_not_captured(evening):
    live_compare.live_dir(evening).mkdir(parents=True)
    owner, _ = _send(evening)
    assert "💹 Live · not captured" in owner[0]


def test_an_unreadable_capture_never_stops_the_message(evening, monkeypatch):
    live_compare.live_dir(evening).mkdir(parents=True)

    def broken(day, root=None):
        raise ValueError("bad file")

    monkeypatch.setattr(live_compare, "compare", broken)
    owner, group = _send(evening)
    assert "💹 Live · could not be read" in owner[0] and group
