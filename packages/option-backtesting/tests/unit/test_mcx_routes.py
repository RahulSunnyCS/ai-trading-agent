"""The Commodity Lab's read-only routes: `/legwise/mcx/overview` and `/forward` over a temp data
root with a calendar, a few lake days and a journal. Nothing is written."""

import json
from datetime import date

from option_backtesting import mcx_forward as mf
from option_backtesting.api import mcx_routes as mr
from option_backtesting.legwise.market import mcx_calendar_path
from option_backtesting.rotation import journal

TODAY = date(2026, 11, 24)


def _calendar(root, name, options):
    path = mcx_calendar_path(root, name)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({"options": options, "futures": {}}))


def _lake_day(root, name, day):
    folder = root / "lake" / "bars_1m" / "asset=option" / f"underlying={name}" / f"date={day}"
    folder.mkdir(parents=True)
    (folder / "data.parquet").write_bytes(b"")


def test_overview_names_the_next_expiry_or_where_the_calendar_ends(tmp_path):
    _calendar(
        tmp_path, "GOLDM", {"2026-11-27": "MCX:GOLDM26DECFUT", "2026-12-29": "MCX:GOLDM27JANFUT"}
    )
    _calendar(tmp_path, "SILVERM", {"2026-10-28": "MCX:SILVERM26NOVFUT"})
    _lake_day(tmp_path, "GOLDM", "2026-11-23")
    out = mr.overview(tmp_path, TODAY)
    rows = {r["root"]: r for r in out["roots"]}
    assert rows["GOLDM"]["nearest_expiry"] == "2026-11-27"
    assert rows["GOLDM"]["weekdays_to_expiry"] == 3
    assert rows["GOLDM"]["last_day"] == "2026-11-23"
    assert rows["SILVERM"]["nearest_expiry"] is None
    assert rows["SILVERM"]["calendar_ends"] == "2026-10-28"
    assert rows["CRUDEOILM"]["days_collected"] == 0
    assert out["errors"] == []


def test_forward_reads_the_journal_and_marks_the_window(tmp_path):
    _calendar(tmp_path, "GOLDM", {"2026-11-27": "MCX:GOLDM26DECFUT"})
    _lake_day(tmp_path, "GOLDM", "2026-11-23")
    entry = {
        "day": "2026-11-23",
        "expiry": "2026-11-27",
        "k": 4,
        "season": "winter",
        "gross": 100.0,
        "charges": 10.0,
        "net": 90.0,
        "net_0.5pct": 95.0,
        "net_0pct": 99.0,
        "stopped_by": None,
        "future_at_18": 124487.0,
        "recorded_at": "2026-11-24T01:30:27+05:30",
        "trades": [],
        "notes": [],
    }
    journal.append(mf.journal_path(tmp_path), entry)
    out = mr.forward(tmp_path, TODAY)
    assert out["chain"] == {"ok": True, "problems": []}
    assert out["summary"]["sessions"] == 1 and out["summary"]["net"] == 90.0
    assert out["entries"][0]["day"] == "2026-11-23"
    states = {s["day"]: s["state"] for s in out["window"]["sessions"]}
    assert states["2026-11-23"] == "journaled"
    assert states["2026-11-24"] == "today"
    assert states["2026-11-25"] == "to come"
    assert out["spreads"] == []


def test_forward_with_nothing_yet_is_empty_not_an_error(tmp_path):
    out = mr.forward(tmp_path, TODAY)
    assert out["entries"] == [] and out["window"] is None and out["chain"]["ok"] is True
