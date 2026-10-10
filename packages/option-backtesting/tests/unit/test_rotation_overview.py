"""The Rotation page's overview (health checks, baskets) and its two routes (BL-058 Phase 4).
Synthetic files in tmp_path; no lake, no engine."""

from __future__ import annotations

import csv
from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo

from fastapi.testclient import TestClient

from option_backtesting.api import rotation_routes
from option_backtesting.api.app import create_app
from option_backtesting.rotation import base, journal, overview, store
from option_backtesting.rotation.variants import variant_names

IST = ZoneInfo("Asia/Kolkata")
NAMES = variant_names()
D1, D2 = date(2026, 10, 12), date(2026, 10, 13)  # Mon, Tue


def _results(root, days: list[date], skip: str | None = None) -> None:
    directory = store.results_dir(root)
    directory.mkdir(parents=True, exist_ok=True)
    for n in NAMES:
        with (directory / f"{n}.csv").open("w", newline="") as f:
            w = csv.writer(f)
            w.writerow(store.RESULT_COLUMNS)
            for d in days:
                if n == skip and d == days[-1]:
                    continue
                w.writerow([d.isoformat(), 10, 10, 0, 10, "", 2])
    with store.days_path(root).open("w", newline="") as f:
        w = csv.writer(f)
        w.writerow(store.DAY_COLUMNS)
        for d in days:
            w.writerow([d.isoformat(), d.strftime("%a"), 14.0, "13-15", 1, 2])


def _entry(root, day: date, picks: dict, *, late=False, src="fyers", buy=None):
    journal.append(
        store.journal_path(root),
        {
            "v": 3,
            "day": day.isoformat(),
            "weekday": day.strftime("%a"),
            "vix_open": 14.1,
            "vix_source": src,
            "vix_band": "13-15",
            "dte": {"NIFTY": "1", "SENSEX": "2"},
            "before_first_entry": not late,
            "recorded_at": f"{day.isoformat()}T09:16:04+05:30",
            "lots_per_strategy": 2,
            "lists": {
                k: {
                    "core": v,
                    "buy": (buy or {}).get(k, []),
                    "overridden": k == "A",
                    "composite": {n: 0.8 for n in v + (buy or {}).get(k, [])},
                }
                for k, v in picks.items()
            },
        },
    )


CORE_A = ["N_wide_0932", "N_wide_1017", "N_dir_0947"]
CORE_B = ["N_wide_0932", "S_wide_0917", "S_dir_0947"]


def _picks(core_a=CORE_A):
    return {"A": core_a, "B": CORE_B, "C": CORE_A, "REF": CORE_B}


def _now(day: date, hh=19, mm=50) -> datetime:
    return datetime(day.year, day.month, day.day, hh, mm, tzinfo=IST)


def _state(h: dict, id_: str) -> dict:
    return next(c for c in h["checks"] if c["id"] == id_)


def test_before_the_first_entry_the_page_says_when_it_starts(tmp_path):
    h = overview.health(tmp_path, now=_now(date(2026, 10, 10)))
    assert _state(h, "entry")["state"] == "info"
    assert "Mon 12 Oct" in _state(h, "entry")["value"]
    assert overview.baskets(tmp_path)["entry"] is None
    assert set(overview.lists_spec()) == {"A", "B", "C", "REF"}


def test_a_complete_day_is_ok_and_a_missing_result_names_its_fix(tmp_path):
    _results(tmp_path, [D1])
    _entry(tmp_path, D1, _picks())
    h = overview.health(tmp_path, now=_now(D1))
    assert _state(h, "results")["value"] == "298 / 298" and _state(h, "results")["state"] == "ok"
    assert _state(h, "entry")["state"] == "ok"
    assert _state(h, "chain")["state"] == "ok"
    _results(tmp_path, [D1, D2], skip="N_wide_0917")
    h = overview.health(tmp_path, now=_now(D2))
    r = _state(h, "results")
    assert r["state"] == "bad" and "obt rotation update --day 2026-10-13" in r["detail"]
    assert h["state"] == "bad"


def test_a_missing_entry_after_the_deadline_is_bad_before_it_is_info(tmp_path):
    _results(tmp_path, [D1])
    _entry(tmp_path, D1, _picks())
    assert _state(overview.health(tmp_path, now=_now(D2, 9, 5)), "entry")["state"] == "info"
    assert _state(overview.health(tmp_path, now=_now(D2, 9, 30)), "entry")["state"] == "bad"
    sat = date(2026, 10, 17)
    assert "no session" in _state(overview.health(tmp_path, now=_now(sat, 10, 0)), "entry")["value"]


def test_a_late_entry_and_a_fallback_vix_source_are_flagged(tmp_path):
    _results(tmp_path, [D1])
    _entry(tmp_path, D1, _picks(), late=True, src="angelone")
    h = overview.health(tmp_path, now=_now(D1))
    assert _state(h, "entry")["state"] == "bad" and "LATE" in _state(h, "entry")["value"]
    assert _state(h, "vix")["state"] == "warn"


def test_a_broken_chain_is_reported(tmp_path):
    _results(tmp_path, [D1, D2])
    _entry(tmp_path, D1, _picks())
    _entry(tmp_path, D2, _picks())
    path = store.journal_path(tmp_path)
    path.write_text(path.read_text().replace('"vix_open": 14.1', '"vix_open": 99.9', 1))
    assert _state(overview.health(tmp_path, now=_now(D2)), "chain")["state"] == "bad"


def test_baskets_share_counts_and_what_changed_since_the_entry_before(tmp_path):
    _results(tmp_path, [D1, D2])
    _entry(tmp_path, D1, _picks())
    _entry(
        tmp_path,
        D2,
        _picks(core_a=["N_wide_0932", "N_wide_1017", "S_dir_0947"]),
        buy={"B": ["N_buy_0932"]},
    )
    b = overview.baskets(tmp_path)
    assert b["entry"]["day"] == D2.isoformat() and b["entry"]["on_time"] is True
    assert b["changed"]["A"] == {"added": ["S_dir_0947"], "removed": ["N_dir_0947"]}
    assert b["changed"]["B"] == {"added": ["N_buy_0932"], "removed": []}
    n = next(p for p in b["lists"]["B"]["core"] if p["name"] == "N_wide_0932")
    assert n["shared_by"] == 4 and n["family"] == "Widesl" and n["start"] == "09:32"
    assert b["lists"]["B"]["buy"][0]["kind"] == "buy"
    assert b["lists"]["A"]["overridden"] is True
    assert overview.baskets(tmp_path, D1)["entry"]["day"] == D1.isoformat()  # as of an earlier day


def test_routes_return_the_overview_and_the_summary_and_reject_bad_dates(tmp_path, monkeypatch):
    monkeypatch.setenv("TRADING_DATA_ROOT", str(tmp_path))
    monkeypatch.setattr(rotation_routes, "CACHE_SECONDS", 0.0)
    days = [D1 + timedelta(days=i) for i in range(4) if (D1 + timedelta(days=i)).weekday() < 5]
    _results(tmp_path, days)
    base_dir = base.base_dir(tmp_path)
    base_dir.mkdir(parents=True, exist_ok=True)
    with (base_dir / f"{base.DIR_NAME}.csv").open("w", newline="") as f:
        w = csv.writer(f)
        w.writerow(store.RESULT_COLUMNS)
        for d in days:
            w.writerow([d.isoformat(), 5, 5, 0, 5, "", 2])
    for d in days:
        _entry(tmp_path, d, _picks())
    c = TestClient(create_app(tmp_path / "cache"))
    o = c.get("/legwise/rotation/overview").json()
    assert (
        o["first_entry_day"] == "2026-10-12"
        and o["baskets"]["entry"]["day"] == days[-1].isoformat()
    )
    assert {x["id"] for x in o["health"]["checks"]} >= {
        "session",
        "results",
        "entry",
        "chain",
        "base",
    }
    s = c.get("/legwise/rotation/summary").json()
    assert s["n_days"] == len(days) and set(s["lists"]) == {"A", "B", "C", "REF"}
    assert c.get("/legwise/rotation/summary?from=nope").status_code == 422
    assert c.get("/legwise/rotation/overview?day=2026-13-40").json()["error"]


# --- review fixes: the session check follows the trading calendar --------------------------------

D12, D13, D14, D15 = (date(2026, 10, 12) + timedelta(days=i) for i in range(4))  # Mon..Thu
FRI16, MON19, WED21 = date(2026, 10, 16), date(2026, 10, 19), date(2026, 10, 21)  # 20 Oct: Dussehra


def test_a_skipped_nightly_run_is_a_problem_even_inside_three_calendar_days(tmp_path):
    _results(tmp_path, [D12])
    h = overview.health(tmp_path, now=_now(D15, 10, 0))  # Tue 13 and Wed 14 never stored
    s = _state(h, "session")
    assert s["state"] == "bad"
    assert "2026-10-13" in s["detail"] and "2026-10-14" in s["detail"]
    assert "obt rotation update --day 2026-10-13" in s["detail"]


def test_a_weekend_or_a_holiday_is_not_a_missing_session(tmp_path):
    _results(tmp_path, [D12, D13, D14, D15, FRI16])
    assert _state(overview.health(tmp_path, now=_now(MON19, 10, 0)), "session")["state"] == "ok"
    _results(tmp_path, [D12, D13, D14, D15, FRI16, MON19])
    # Tue 20 Oct is an exchange holiday: on Wed morning the last finished session is Mon 19
    assert _state(overview.health(tmp_path, now=_now(WED21, 8, 0)), "session")["state"] == "ok"


def test_tonights_session_is_awaited_until_the_update_is_overdue(tmp_path):
    _results(tmp_path, [D12])
    waiting = overview.health(tmp_path, now=_now(D13, 19, 50))
    assert _state(waiting, "session")["state"] == "info"
    assert _state(overview.health(tmp_path, now=_now(D13, 21, 0)), "session")["state"] == "bad"
    # before 19:45 the session still owed is yesterday's, which is stored
    assert _state(overview.health(tmp_path, now=_now(D13, 12, 0)), "session")["state"] == "ok"


def test_days_with_no_entry_are_named_never_silent(tmp_path):
    _results(tmp_path, [D12, D13, D14])
    _entry(tmp_path, D12, _picks())
    _entry(tmp_path, D14, _picks())
    h = overview.health(tmp_path, now=_now(D15, 10, 0))
    m = _state(h, "missing")
    assert m["state"] == "bad" and "2026-10-13" in m["detail"] and "2026-10-15" in m["detail"]
    assert "2026-10-12" not in m["detail"]
    assert not any(
        c["id"] == "missing" for c in overview.health(tmp_path, now=_now(D12, 9, 5))["checks"]
    )


def test_an_unreadable_journal_is_a_finding_not_a_crash(tmp_path):
    _results(tmp_path, [D12])
    path = store.journal_path(tmp_path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text('{"day": "2026-10-12", "hash": \n')
    h = overview.health(tmp_path, now=_now(D12, 20, 0))
    assert _state(h, "chain")["state"] == "bad" and "UNREADABLE" in _state(h, "chain")["value"]
    assert h["state"] == "bad"
    assert "error" in overview.baskets(tmp_path)
