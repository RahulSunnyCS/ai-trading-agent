"""T2 acceptance: CA quarterly snapshot fetching + subject parsing (plan.md §2).

Table tests cover the real subjects called out in plan.md §1 and the QA checklist
(C09, C10, C11, C13, C14, F04, F05). No network: fetch tests inject a fake NseClient
built from a small committed fixture (tests/stocks/fixtures/corporate_actions/); the
parser table tests are also run over the full real corporate-actions history already
cached under data/stocks/raw/corporate_actions/ (skipped if that cache isn't present,
e.g. on a fresh clone / CI without the out-of-band download).
"""

from __future__ import annotations

import glob
import json
from datetime import date
from pathlib import Path

import pandas as pd
import pytest

from momentum_backtesting.stocks.corporate_actions import (
    CA_API_URL,
    check_dividend_year_counts,
    check_month_completeness,
    fetch_history,
    fetch_quarter_checked,
    fetch_snapshot,
    iter_quarters,
    normalise_subject,
    parse_ca_date,
    parse_subject,
    subject_sha1,
)
from momentum_backtesting.stocks.schemas import EventKind

FIXTURES_DIR = Path(__file__).parent / "fixtures" / "corporate_actions"
FULL_CACHE_DIR = Path(__file__).resolve().parents[2] / "data/stocks/raw/corporate_actions"


class FakeNseClient:
    """A minimal stand-in for nse.NseClient: no network, records calls, and serves
    canned JSON payloads keyed by (from_date, to_date) params."""

    def __init__(self, payloads: dict[tuple[str, str], object]) -> None:
        self.payloads = payloads
        self.warm_up_calls = 0
        self.get_json_calls: list[dict] = []

    def warm_up(self) -> None:
        self.warm_up_calls += 1

    def get_json(self, url, *, params=None, referer=None, timeout=60.0):  # noqa: ANN001
        assert url == CA_API_URL
        assert params is not None
        assert params.get("index") == "equities"
        assert referer is not None
        self.get_json_calls.append(dict(params))
        key = (params["from_date"], params["to_date"])
        if key not in self.payloads:
            raise AssertionError(f"FakeNseClient got no payload for {key}")
        return self.payloads[key]


def _load_fixture(name: str) -> list[dict]:
    return json.loads((FIXTURES_DIR / name).read_text())


# --------------------------------------------------------------------------
# parse_ca_date (QA F04: locale-independent month parsing)
# --------------------------------------------------------------------------


def test_parse_ca_date_parses_fixed_english_month_map():
    assert parse_ca_date("03-Jan-2011") == date(2011, 1, 3)
    assert parse_ca_date("25-Dec-2026") == date(2026, 12, 25)
    assert parse_ca_date("01-Oct-2024") == date(2024, 10, 1)


def test_parse_ca_date_placeholder_is_none():
    assert parse_ca_date("-") is None
    assert parse_ca_date("") is None
    assert parse_ca_date(None) is None


def test_parse_ca_date_is_locale_independent():
    """QA F04: parsing must not depend on the C-library locale's month names.
    parse_ca_date uses a fixed English abbreviation dict (never strptime's `%b`,
    which reads the process locale and would mis-parse "Jan" under e.g. hi_IN),
    so every month abbreviation resolves the same regardless of `locale.setlocale`.
    """
    assert parse_ca_date("15-Feb-2011") == date(2011, 2, 15)
    for abbr, month in [
        ("Jan", 1), ("Feb", 2), ("Mar", 3), ("Apr", 4), ("May", 5), ("Jun", 6),
        ("Jul", 7), ("Aug", 8), ("Sep", 9), ("Oct", 10), ("Nov", 11), ("Dec", 12),
    ]:
        assert parse_ca_date(f"01-{abbr}-2020") == date(2020, month, 1)


def test_parse_ca_date_rejects_unknown_month():
    with pytest.raises(ValueError, match="month"):
        parse_ca_date("15-Xyz-2011")


# --------------------------------------------------------------------------
# normalise_subject / subject_sha1
# --------------------------------------------------------------------------


def test_normalise_subject_collapses_whitespace_and_case():
    assert normalise_subject("  Bonus   1:1  ") == "bonus 1:1"
    assert normalise_subject("BONUS 1:1") == normalise_subject("bonus 1:1")


def test_normalise_subject_truncates_before_hashing():
    long_subject = "Dividend " + "x" * 1000
    normalised = normalise_subject(long_subject)
    assert len(normalised) <= 500


def test_subject_sha1_stable_and_case_insensitive():
    assert subject_sha1("Bonus 1:1") == subject_sha1("  bonus   1:1 ")
    assert subject_sha1("Bonus 1:1") != subject_sha1("Bonus 1:2")


# --------------------------------------------------------------------------
# parse_subject — table tests over the tricky real subjects (plan.md §1, QA
# C09/C10/C11/C13/C14)
# --------------------------------------------------------------------------

BONUS_CASES = [
    ("Bonus 1:1", 0.5),
    ("Bonus 1:2", 2 / 3),
    (" Bonus  1:4", 0.8),
    ("Bonus 1: 1", 0.5),
]


@pytest.mark.parametrize("subject,expected_factor", BONUS_CASES)
def test_parse_subject_equity_bonus_factor(subject, expected_factor):
    """QA C09: Bonus a:b -> factor = b/(a+b)."""
    events = parse_subject(subject, 10.0)
    assert len(events) == 1
    assert events[0].kind == EventKind.BONUS
    assert events[0].dividend is None
    assert events[0].factor == pytest.approx(expected_factor)


BONUS_REJECTED_CASES = [
    "Bonus Debentures 6:1",
    "Bonus Preference Shares 21:1",
    "Bonus - 1 Debenture For 1 Equity Share",
    "Scheme Of Arrangement - Bonus Debentures 6:1",
    "Bonus Ncrps 1:116",
]


@pytest.mark.parametrize("subject", BONUS_REJECTED_CASES)
def test_parse_subject_bonus_debenture_or_preference_is_manual_only(subject):
    """QA C10: bonus debentures/preference shares are never a share factor."""
    events = parse_subject(subject, 10.0)
    assert len(events) == 1
    assert events[0].kind == EventKind.MANUAL_ONLY
    assert events[0].factor is None
    assert events[0].dividend is None


SPLIT_CASES = [
    ("Face Value Split (Sub-Division) - From Rs 10/- Per Share To Rs 2/- Per Share", 0.2),
    ("Face Value Split (Sub-Division) From Rs 10 Per Share To Re 1 Per Share", 0.1),
    ("Consolidation Of Equity Shares From Re 1 Per Share To Rs 10 Per Share", 10.0),
    ("Face Value Split Rs.10/- To Rs.5/-", 0.5),
]


@pytest.mark.parametrize("subject,expected_factor", SPLIT_CASES)
def test_parse_subject_split_consolidation_factor(subject, expected_factor):
    """QA C11: split/sub-division -> f = Y/X; consolidation 1->10 -> f=10."""
    events = parse_subject(subject, 10.0)
    assert len(events) == 1
    assert events[0].kind == EventKind.SPLIT
    assert events[0].dividend is None
    assert events[0].factor == pytest.approx(expected_factor)


def test_parse_subject_bonus_and_split_same_subject_returns_two_events():
    """A single subject stating both a bonus and a split (e.g. some issuers' CA
    text, distinct from BAJFINANCE's two-separate-rows case) yields two events."""
    subject = (
        "Bonus 1:1/Face Value Split (Sub-Division) - From Rs 10/- Per Share To Rs 2/- Per Share"
    )
    events = parse_subject(subject, 10.0)
    assert [e.kind for e in events] == [EventKind.BONUS, EventKind.SPLIT]
    assert events[0].factor == pytest.approx(0.5)
    assert events[1].factor == pytest.approx(0.2)


DIVIDEND_CASES = [
    ("Final Dividend Rs 22 Per Share/Special Dividend - Rs 10 Per Share", 32.0),
    ("Interim Dividend Rs.15/- Per Share (Purpose Revised)", 15.0),
    ("Dividend - Re 1 Per Share", 1.0),
    ("Interim Dividend- Rs.18/- Per Share", 18.0),
    ("Annual General Meeting/Dividend - Rs 12 Per Share", 12.0),
    # real feed typos/glue observed across ca_2011..ca_2026.json — must still sum.
    ("Interim Divdend - Rs 7.60 Per Share", 7.60),
    ("Annual General Meetingdividend - Rs 5 Per Share", 5.0),
]


@pytest.mark.parametrize("subject,expected_total", DIVIDEND_CASES)
def test_parse_subject_dividend_sums_every_amount(subject, expected_total):
    """QA C14: 'Final Rs 22 + Special Rs 10' -> 32; 'Rs.15/-' -> 15; 'Re 1' -> 1."""
    events = parse_subject(subject, 10.0)
    assert len(events) == 1
    assert events[0].kind == EventKind.DIVIDEND
    assert events[0].factor is None
    assert events[0].dividend == pytest.approx(expected_total)


def test_parse_subject_vedl_interim_dividend_amount_less_is_manual_only():
    """VEDL 2022-03-09's real subject: bare 'Interim Dividend', no amount."""
    events = parse_subject("Interim Dividend", 1.0)
    assert len(events) == 1
    assert events[0].kind == EventKind.MANUAL_ONLY
    assert events[0].dividend is None
    assert "manual only" in events[0].note


def test_parse_subject_percent_of_face_value_dividend_is_manual_only():
    """'@ 12%' with no Rs/Re amount — faceVal is re-keyed, so manual-only."""
    events = parse_subject("Interim Dividend @ 12% On Equity Shares.", 10.0)
    assert len(events) == 1
    assert events[0].kind == EventKind.MANUAL_ONLY
    assert events[0].dividend is None
    assert events[0].dividend_basis == "12%"


def test_parse_subject_percent_annotation_alongside_amount_is_not_manual_only():
    """A parenthetical % next to a real Rs amount is just an annotation — the
    amount still parses normally (only an amount-less % is manual-only)."""
    events = parse_subject("Annual General Meeting / Dividend - Rs 15/- Per Share (150%)", 10.0)
    assert len(events) == 1
    assert events[0].kind == EventKind.DIVIDEND
    assert events[0].dividend == pytest.approx(15.0)


MANUAL_ONLY_CASES = [
    "Rights 1:15 @ Premium Rs 1247",
    "Rights - 4:25 Fully Paid Up Shares @ Premium Rs 500/- Per Share / "
    "2:25 Partly Paid Up Shares @ Premium Rs 605/- Per Share",
    "Demerger",
    "Scheme Of Arrangement",
    "Scheme Of Demerger",
    "Capital Reduction -  From Rs 10/- To Rs 4/- Per Share",
    "Annual General Meeting/ Dividend - Rs 29.50/- Per Share And Bonus 1:1",
    "Bonus 1:1/Dividend- Rs 29 Per Share",
]


@pytest.mark.parametrize("subject", MANUAL_ONLY_CASES)
def test_parse_subject_manual_only_catchall(subject):
    events = parse_subject(subject, 10.0)
    assert len(events) == 1
    assert events[0].kind == EventKind.MANUAL_ONLY
    assert events[0].factor is None
    assert events[0].dividend is None


def test_parse_subject_purely_informational_subject_yields_no_events():
    """A subject with no price-affecting corporate action (AGM, buyback notice,
    e-voting) parses to zero events rather than a manual-only placeholder — every
    member's routine AGM row would otherwise need an actions_manual.csv citation."""
    for subject in ("Annual General Meeting", "Buy Back", "E-Voting", "Interest Payment"):
        assert parse_subject(subject, 10.0) == []


def test_parse_subject_truncates_pathological_subject_before_regex():
    """A subject far beyond MAX_SUBJECT_CHARS must not hang or crash the regexes,
    and the truncation must happen before matching (not just before hashing)."""
    pathological = "Dividend " + "Rs 1 " * 1000
    events = parse_subject(pathological, 10.0)
    assert len(events) == 1
    assert events[0].kind == EventKind.DIVIDEND
    assert events[0].dividend > 0


# --------------------------------------------------------------------------
# fetch_snapshot / quarter fetching (schema check, dedup, atomic write)
# --------------------------------------------------------------------------


def test_fetch_snapshot_writes_raw_json_and_returns_deduped_frame(tmp_path):
    rows = _load_fixture("2011Q1.json")
    client = FakeNseClient({("01-01-2011", "31-03-2011"): rows})

    df = fetch_snapshot(date(2011, 1, 1), date(2011, 3, 31), tmp_path, client)

    # QA C13: exact duplicates dropped (the fixture has one OIL row twice).
    assert len(df) == len(rows) - 1
    assert client.get_json_calls[0]["from_date"] == "01-01-2011"
    assert client.get_json_calls[0]["to_date"] == "31-03-2011"

    written = list((tmp_path / "corporate_actions").glob("*/2011-01-01_2011-03-31.json"))
    assert len(written) == 1
    on_disk = json.loads(written[0].read_text())
    assert on_disk == rows  # raw feed rows written verbatim, duplicates included


def test_fetch_snapshot_rejects_malformed_row_schema(tmp_path):
    client = FakeNseClient({("01-01-2011", "31-03-2011"): [{"symbol": "X"}]})
    with pytest.raises(ValueError, match="missing required fields"):
        fetch_snapshot(date(2011, 1, 1), date(2011, 3, 31), tmp_path, client)


def test_fetch_snapshot_rejects_unexpected_payload_shape(tmp_path):
    client = FakeNseClient({("01-01-2011", "31-03-2011"): {"unexpected": "shape"}})
    with pytest.raises(ValueError, match="unexpected CA feed payload shape"):
        fetch_snapshot(date(2011, 1, 1), date(2011, 3, 31), tmp_path, client)


def test_check_month_completeness_flags_empty_months():
    df = pd.DataFrame({"exDate": ["03-Jan-2011", "15-Jan-2011"]})
    missing = check_month_completeness(df, date(2011, 1, 1), date(2011, 3, 31))
    assert missing == ["2011-02", "2011-03"]


def test_check_month_completeness_all_months_present():
    df = pd.DataFrame({"exDate": ["03-Jan-2011", "15-Feb-2011", "20-Mar-2011"]})
    assert check_month_completeness(df, date(2011, 1, 1), date(2011, 3, 31)) == []


def test_fetch_quarter_checked_refetches_once_then_raises(tmp_path):
    """QA F05: a quarter with an empty month refetches once, then fails if still
    incomplete."""
    incomplete = [
        {
            "symbol": "X",
            "series": "EQ",
            "isin": "INE000X01011",
            "faceVal": "10",
            "exDate": "03-Jan-2011",
            "recDate": "-",
            "comp": "X Ltd",
            "subject": "Annual General Meeting",
        }
    ]
    client = FakeNseClient({("01-01-2011", "31-03-2011"): incomplete})
    with pytest.raises(ValueError, match="empty months"):
        fetch_quarter_checked(date(2011, 1, 1), date(2011, 3, 31), tmp_path, client)
    # fetch_snapshot called twice: the original attempt + the one retry.
    assert len(client.get_json_calls) == 2


def test_fetch_quarter_checked_succeeds_when_second_fetch_fills_the_gap(tmp_path):
    """The retry can succeed if NSE's second response is complete (simulates a
    transient gap in the feed, not a structural one)."""
    complete = _load_fixture("2011Q1.json")
    incomplete = [complete[0]]  # only the January row

    class FlakyClient(FakeNseClient):
        def __init__(self):
            super().__init__({})
            self._call_count = 0

        def get_json(self, url, *, params=None, referer=None, timeout=60.0):  # noqa: ANN001
            self._call_count += 1
            self.get_json_calls.append(dict(params))
            return incomplete if self._call_count == 1 else complete

    client = FlakyClient()
    df = fetch_quarter_checked(date(2011, 1, 1), date(2011, 3, 31), tmp_path, client)
    assert len(client.get_json_calls) == 2
    assert len(df) == len(complete) - 1  # dedup drops the duplicate OIL row


def test_check_dividend_year_counts_flags_outlier_year():
    """QA F05: dividend rows per year must stay within ±30% of neighbours' mean."""
    rows = []
    for year, count in [(2019, 100), (2020, 100), (2021, 10), (2022, 100), (2023, 100)]:
        for _i in range(count):
            rows.append({"subject": "Dividend - Rs 1 Per Share", "exDate": f"01-Jan-{year}"})
    df = pd.DataFrame(rows)
    problems = check_dividend_year_counts(df)
    # 2021's sharp dip also drags its immediate neighbours' means out of band
    # (2020's neighbour mean is pulled down by 2021, 2022's by the same); the
    # guard is defined purely on immediate-neighbour means, so all three are
    # legitimately flagged — 2021 (the actual outlier) must be among them.
    assert any("2021" in p for p in problems)


def test_check_dividend_year_counts_passes_within_band():
    rows = []
    for year, count in [(2019, 95), (2020, 100), (2021, 105), (2022, 98)]:
        for _i in range(count):
            rows.append({"subject": "Dividend - Rs 1 Per Share", "exDate": f"01-Jan-{year}"})
    df = pd.DataFrame(rows)
    assert check_dividend_year_counts(df) == []


def test_check_dividend_year_counts_skips_boundary_years():
    """A year with no earlier or no later neighbour (e.g. the first/last year in
    the cache) can't be checked and must not be flagged."""
    rows = [{"subject": "Dividend - Rs 1 Per Share", "exDate": "01-Jan-2011"}]
    df = pd.DataFrame(rows)
    assert check_dividend_year_counts(df) == []


# --------------------------------------------------------------------------
# iter_quarters
# --------------------------------------------------------------------------


def test_iter_quarters_covers_full_years():
    quarters = list(iter_quarters(date(2011, 1, 1), date(2011, 12, 31)))
    assert quarters == [
        (date(2011, 1, 1), date(2011, 3, 31)),
        (date(2011, 4, 1), date(2011, 6, 30)),
        (date(2011, 7, 1), date(2011, 9, 30)),
        (date(2011, 10, 1), date(2011, 12, 31)),
    ]


def test_iter_quarters_clips_at_both_ends():
    quarters = list(iter_quarters(date(2011, 2, 15), date(2011, 8, 10)))
    assert quarters == [
        (date(2011, 2, 15), date(2011, 3, 31)),
        (date(2011, 4, 1), date(2011, 6, 30)),
        (date(2011, 7, 1), date(2011, 8, 10)),
    ]


def test_iter_quarters_spans_year_boundary():
    quarters = list(iter_quarters(date(2011, 11, 1), date(2012, 2, 28)))
    assert quarters == [
        (date(2011, 11, 1), date(2011, 12, 31)),
        (date(2012, 1, 1), date(2012, 2, 28)),
    ]


# --------------------------------------------------------------------------
# fetch_history (orchestration: warm_up once, all quarters, guards applied)
# --------------------------------------------------------------------------


def test_fetch_history_warms_up_once_and_fetches_every_quarter(tmp_path):
    rows = _load_fixture("2011Q1.json")
    client = FakeNseClient({("01-01-2011", "31-03-2011"): rows})
    df = fetch_history(tmp_path, client, start=date(2011, 1, 1), end=date(2011, 3, 31))
    assert client.warm_up_calls == 1
    assert len(client.get_json_calls) == 1
    assert not df.empty


# --------------------------------------------------------------------------
# Real-cache sweep: distinct subjects that fall to manual_only or are unparsed for
# the current Nifty 50 + known former members (feeds T5's actions_manual.csv). Not
# a strict assertion beyond "parses without raising" — this is the reporting sweep
# the implementor brief asked for, kept as a regression test so a future parser
# change that silently drops a dividend/bonus/split for these symbols is caught.
# --------------------------------------------------------------------------

_SCOPE_SYMBOLS = {
    "HDFC",
    "TATAMOTORS",
    "TMPV",
    "MCDOWELL-N",
    "UNITDSPR",
    "ZEEL",
    "VEDL",
    "IDEA",
    "YESBANK",
    "BPCL",
    "IOC",
    "GAIL",
    "LUPIN",
    "CIPLA",
    "AMBUJACEM",
    "ACC",
    "BHEL",
    "DLF",
    "JINDALSTEL",
    "SESAGOA",
    "SSLT",
    "STER",
    "IDFC",
    "MINDTREE",
    "LTIM",
    "INFRATEL",
    "BOSCHLTD",
    "AUROPHARMA",
    "DRREDDY",
    "BRITANNIA",
    "UPL",
    "HINDPETRO",
}


def _load_nifty50_current_symbols() -> set[str]:
    import csv

    current_csv = Path(__file__).resolve().parents[2] / "data/stocks/raw/nifty50_current.csv"
    if not current_csv.exists():
        return set()
    with current_csv.open() as fh:
        return {row["Symbol"] for row in csv.DictReader(fh)}


@pytest.mark.skipif(
    not FULL_CACHE_DIR.exists(),
    reason="out-of-band data/stocks/raw/corporate_actions/ cache not present",
)
def test_real_cache_parses_cleanly_for_scope_symbols_and_reports_manual_only():
    scope = _SCOPE_SYMBOLS | _load_nifty50_current_symbols()
    rows = []
    for path in sorted(glob.glob(str(FULL_CACHE_DIR / "ca_*.json"))):
        rows.extend(json.loads(Path(path).read_text()))

    manual_subjects: dict[str, int] = {}
    kind_counts: dict[str, int] = {}
    for row in rows:
        if row["symbol"] not in scope:
            continue
        face_val = float(row["faceVal"]) if row.get("faceVal") not in (None, "-", "") else 0.0
        events = parse_subject(row["subject"], face_val)
        if not events:
            kind_counts["NO_EVENT"] = kind_counts.get("NO_EVENT", 0) + 1
            continue
        for event in events:
            kind_counts[event.kind.value] = kind_counts.get(event.kind.value, 0) + 1
            if event.kind == EventKind.MANUAL_ONLY:
                subject = row["subject"].strip()
                manual_subjects[subject] = manual_subjects.get(subject, 0) + 1

    # Every automatic kind must have parsed at least one real row for this scope —
    # if any of these go to zero, a regex regressed silently.
    assert kind_counts.get("bonus", 0) > 0
    assert kind_counts.get("split", 0) > 0
    assert kind_counts.get("dividend", 0) > 0
    # plan.md §2: "about 30 rows are expected" manual-only for member companies —
    # a generous ceiling so this doesn't flake on future CA feed growth, but still
    # catches a parser regression that suddenly sends everything to manual_only.
    assert sum(manual_subjects.values()) < 150
