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
    name,
    pnl,
    *,
    source="tool",
    platform="algotest",
    broker="finvasia",
    mult=1,
    fills=None,
    pid="1",
    open_legs=0,
    traded=True,
):
    prefix, _, variant = name.partition(" · ")
    return {
        "kind": "strategy",
        "day": DAY.isoformat(),
        "platform": platform,
        "broker": broker,
        "name": name,
        "variant": variant if source == "tool" else None,
        "book": {"T1": "t1", "Core": "core"}.get(prefix) if source == "tool" else None,
        "addon": False,
        "source": source,
        "platform_id": pid,
        "multiplier": mult,
        "traded": traded,
        "pnl": pnl if traded else None,
        "status": "SquaredOff",
        "open_legs": open_legs,
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
    assert lines == ["💹 Live vs paper", "✋ Discretionary  −₹2,119 in all (2)"]


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
    assert lines[1] == "AlgoTest · Shoonya T1  +₹910 vs +₹790 a lot · slip +₹120"


def test_core_and_t1_copies_of_one_variant_stay_separate(root):
    _paper(root, "N_wide_1117", 2000.0)
    _capture(
        root,
        [
            _section("algotest", "all"),
            _line("Core · N_wide_1117", 1700.0, pid="a"),
            _line("T1 · N_wide_1117", 2100.0, pid="b"),
        ],
    )
    c = live_compare.compare(DAY, root)
    by = {x.book: x for x in c.compared}
    assert by["core"].slippage == pytest.approx(-300.0) and by["core"].lots == 1
    assert by["t1"].slippage == pytest.approx(100.0)
    assert [(g.book, g.slippage) for g in c.groups()] == [("core", -300.0), ("t1", 100.0)]


def test_a_copy_that_did_not_trade_or_has_open_legs_is_not_slippage(root):
    _capture(
        root,
        [
            _section("algotest", "all"),
            _line("T1 · N_p150-t1s11_1317", 910.0, pid="a"),
            _line("T1 · N_p150-t1s11_1317", None, pid="b", traded=False, fills=[]),
            _line("T1 · N_ditm1-t1s36_0947", 300.0, pid="c", open_legs=1),
        ],
    )
    c = live_compare.compare(DAY, root)
    [x] = c.compared
    assert (x.variant, x.copies, x.slippage) == (T1[2], 1, pytest.approx(120.25))
    assert [r["platform_id"] for r in c.not_traded] == ["b"]
    assert [r["platform_id"] for r in c.open_legs] == ["c"]
    lines = live_compare.message_lines(c, messages.rupees)
    assert f"⚠️ Legs still open, left out: {T1[0]}" in lines
    assert f"⛔ Did not trade: {T1[2]}" in lines
    # a capture written before `traded` existed: an AlgoTest copy with no fills did not trade
    old = _line("T1 · N_x_0917", 0, fills=[])
    del old["traded"]
    assert live_compare.traded(old) is False


def test_quantiply_times_are_utc_and_premium_counts_the_first_entry_only(root):
    _capture(
        root,
        [
            _section("quantiply", "angelone"),
            _line(
                "T1 · N_p150-t1s11_0917",
                -4095.0,
                platform="quantiply",
                broker="angelone",
                fills=[
                    _fill("2026-10-19T03:46:59.000Z", 150),  # 09:16:59 IST: on its slot
                    _fill("2026-10-19T03:46:30Z", 150),
                    _fill("2026-10-19T05:00:00Z", 999),  # a re-entry at 10:30: not the premium
                ],
            ),
        ],
    )
    c = live_compare.compare(DAY, root)
    assert not c.off_slot
    [x] = c.compared
    assert x.premium_per_lot == pytest.approx(300 * 65)


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
    assert "💹 Live vs paper\nAlgoTest · Shoonya T1  +₹910 vs +₹790 a lot · slip +₹120" in owner[0]
    assert "💹" not in group[0]
    # after T1's result, before tomorrow
    assert owner[0].index("🧪 Tuned Adaptive") < owner[0].index("💹")


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


def test_a_tool_line_with_no_readable_name_is_its_own_line_not_discretionary(root):
    odd = _line("T1 · N_p150-t1s11_1317", 400.0, pid="x")
    odd["name"], odd["variant"] = "T1 N_renamed", None  # the tool's (by ledger id), name unreadable
    _capture(
        root,
        [
            _section("algotest", "all"),
            odd,
            _line("N_mine", 100.0, source="discretionary", pid="y"),
        ],
    )
    c = live_compare.compare(DAY, root)
    assert [r["platform_id"] for r in c.unrecognised] == ["x"]
    assert c.discretionary_total == pytest.approx(100.0)
    lines = live_compare.message_lines(c, messages.rupees)
    assert "❓ Unrecognised tool copy: T1 N_renamed  +₹400 in all" in lines


def test_a_multiplier_the_platform_did_not_show_is_said_in_the_line(root):
    gone = _line("T1 · N_p150-t1s11_1317", 910.0, platform="quantiply", broker="angelone")
    gone["multiplier_assumed"] = True  # a back-filled day: the algo is no longer listed
    _capture(root, [_section("quantiply", "angelone"), gone])
    c = live_compare.compare(DAY, root)
    assert c.compared[0].multiplier_guessed
    lines = live_compare.message_lines(c, messages.rupees)
    assert f"1x assumed (multiplier not shown by the platform): {T1[2]}" in lines


# --- the range behind the Rotation page's card ---------------------------------------------------

DAY2 = date(2026, 10, 20)


def _two_days(root):
    _paper(root, T1[0], 1000.0, day=DAY2)
    _capture(
        root,
        [
            _section("algotest", "all"),
            _line("T1 · N_ditm1-t1s36_0947", 2795.0, fills=[_fill("2026-10-19 09:46:59", 100)]),
            _line("Core · N_p150-t1s11_1317", 910.0, platform="quantiply", broker="angelone"),
            _line("Discretionary", 300.0, source="owner"),
        ],
    )
    _capture(
        root,
        [
            _section("algotest", "all"),
            _line("T1 · N_ditm1-t1s36_0947", 1100.0, fills=[_fill("2026-10-20 09:46:59", 100)]),
        ],
        day=DAY2,
    )


def test_captured_days_lists_the_capture_files_oldest_first(root):
    assert live_compare.captured_days(root) == []
    _two_days(root)
    (live_compare.live_dir(root) / "notes.jsonl").write_text("{}")  # not a day: ignored
    assert live_compare.captured_days(root) == [DAY, DAY2]


def test_the_range_runs_totals_per_group_and_filters_by_day(root):
    _two_days(root)
    out = live_compare.compare_range(root=root)
    assert (out["from"], out["to"]) == (DAY.isoformat(), DAY2.isoformat())
    assert [d["day"] for d in out["days"]] == [DAY.isoformat(), DAY2.isoformat()]
    [t1] = [r for r in out["running"] if r["platform"] == "algotest"]
    # +81.25 on the 19th, +100 on the 20th (live 1100 vs paper 1000), added up
    assert [p["slippage"] for p in t1["points"]] == [pytest.approx(81.25), pytest.approx(181.25)]
    assert t1["slippage"] == pytest.approx(181.25) and t1["days"] == 2
    assert out["discretionary"]["total"] == pytest.approx(300.0)
    one = live_compare.compare_range(DAY2, DAY2, root)
    assert [d["day"] for d in one["days"]] == [DAY2.isoformat()]
    assert one["captured_days"] == [DAY.isoformat(), DAY2.isoformat()]


def test_slippage_by_shape_groups_sell_and_buy_by_entry_band(root):
    _two_days(root)
    shapes = {
        (s["platform"], s["position"], s["band"]): s
        for s in live_compare.compare_range(root=root)["shapes"]
    }
    sell_morning = shapes[("algotest", "sell", "09:30–12:00")]
    assert sell_morning["variant_days"] == 2
    assert sell_morning["slippage"] == pytest.approx(181.25)
    assert sell_morning["mean_slippage"] == pytest.approx(90.625)
    # Quantiply has no fills: the figure is there, the percentage is not
    assert shapes[("quantiply", "sell", "12:00 on")]["slippage_pct"] is None
    assert live_compare.shape_of("N_wide") == ("sell", "—")


def test_an_empty_store_gives_an_empty_range(root):
    out = live_compare.compare_range(root=root)
    assert out["days"] == [] and out["running"] == [] and out["from"] is None


def test_a_deliberate_multiplier_is_lots_in_the_range_not_slippage(root):
    _paper(root, "N_wide_1117", 1000.0)
    _capture(
        root,
        [_section("algotest", "all"), _line("T1 · N_wide_1117", 3000.0, mult=3)],
    )
    [d] = live_compare.compare_range(root=root)["days"]
    assert d["compared"][0]["slippage"] == pytest.approx(0.0)


# --- the route ---------------------------------------------------------------------------------


def test_the_live_route_answers_and_refuses_bad_days(root, monkeypatch):
    from fastapi.testclient import TestClient

    from option_backtesting.api import rotation_live_routes
    from option_backtesting.api.app import create_app

    _two_days(root)
    monkeypatch.setenv("TRADING_DATA_ROOT", str(root))
    rotation_live_routes._cache.clear()
    c = TestClient(create_app())
    ok = c.get("/legwise/rotation/live")
    assert ok.status_code == 200 and len(ok.json()["days"]) == 2
    window = c.get("/legwise/rotation/live", params={"from": "2026-10-20"})
    assert [d["day"] for d in window.json()["days"]] == ["2026-10-20"]
    assert c.get("/legwise/rotation/live", params={"from": "nope"}).status_code == 422
    backwards = c.get("/legwise/rotation/live", params={"from": "2026-10-21", "to": "2026-10-19"})
    assert backwards.status_code == 422 and "error" in backwards.json()


def test_the_live_route_answers_an_unmounted_root_as_an_error(monkeypatch):
    from fastapi.testclient import TestClient

    from option_backtesting.api import rotation_live_routes
    from option_backtesting.api.app import create_app

    monkeypatch.setenv("TRADING_DATA_ROOT", "/Volumes/NoSuchVolume-live/TradingData")
    rotation_live_routes._cache.clear()
    r = TestClient(create_app()).get("/legwise/rotation/live")
    assert r.status_code == 503 and "error" in r.json()


def test_the_range_json_lists_what_each_day_left_out(root):
    _paper(root, "N_wide_1117", 1000.0)
    _capture(
        root,
        [
            _section("algotest", "all"),
            _section("quantiply", "angelone", ok=False),
            _line("T1 · N_wide_1117", 1000.0, pid="a"),
            _line("T1 · N_nopaper_0917", 50.0, pid="b"),
            _line("T1 · N_p150-t1s11_1317", None, traded=False, pid="c"),
            _line("T1 · N_ditm1-t1s36_0947", 10.0, open_legs=1, pid="d"),
            _line(
                "T1 · N_p150-t1s11_0917",
                10.0,
                fills=[_fill("2026-10-19 11:30:00", 100)],
                pid="e",
            ),
        ],
    )
    [d] = live_compare.compare_range(root=root)["days"]
    assert d["no_paper"] == ["N_nopaper_0917"]
    assert d["not_traded"] == ["N_p150-t1s11_1317"]
    assert d["open_legs"] == ["N_ditm1-t1s36_0947"]
    assert d["off_slot"] == ["N_p150-t1s11_0917"]
    assert [s["platform"] for s in d["failed_sections"]] == ["quantiply"]


def test_a_long_history_keeps_the_newest_days_and_reads_each_result_file_once(root, monkeypatch):
    monkeypatch.setattr(live_compare, "MAX_RANGE_DAYS", 2)
    for n in (18, 19, 20):
        day = date(2026, 10, n)
        _paper(root, "N_wide_1117", 1000.0, day=day)
        line = _line("T1 · N_wide_1117", 1100.0)
        line["day"] = day.isoformat()
        _capture(root, [_section("algotest", "all"), line], day=day)
    reads = []
    real = live_compare.store.result_path

    def counting(variant, r=None):
        reads.append(variant)
        return real(variant, r)

    monkeypatch.setattr(live_compare.store, "result_path", counting)
    out = live_compare.compare_range(root=root)
    assert [d["day"] for d in out["days"]] == ["2026-10-19", "2026-10-20"]
    assert out["captured_days"] == ["2026-10-18", "2026-10-19", "2026-10-20"]
    assert reads.count("N_wide_1117") == 1


def test_the_live_route_cache_stays_small(root, monkeypatch):
    from fastapi.testclient import TestClient

    from option_backtesting.api import rotation_live_routes
    from option_backtesting.api.app import create_app

    _two_days(root)
    monkeypatch.setenv("TRADING_DATA_ROOT", str(root))
    rotation_live_routes._cache.clear()
    c = TestClient(create_app())
    for n in range(1, 25):
        c.get("/legwise/rotation/live", params={"to": f"2026-11-{n:02d}"})
    assert len(rotation_live_routes._cache) <= rotation_live_routes.CACHE_ENTRIES
