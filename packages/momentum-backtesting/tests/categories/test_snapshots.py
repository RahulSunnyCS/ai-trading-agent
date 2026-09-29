"""snapshots.py: Wayback CDX history lookup, nearest-snapshot-per-year
selection, and the three source-tier fallback rules (module docstring).
No network -- `NseClient._opener.open` is replaced with a URL-dispatching
fake, same seam `tests/stocks/test_nse.py` uses for nse.py itself.
"""

from __future__ import annotations

import io
import json

import pandas as pd

from momentum_backtesting.categories import snapshots, sources
from momentum_backtesting.categories.sources import BASE_URL
from momentum_backtesting.stocks.nse import NseClient, NseError

_CATEGORY_URL = f"{BASE_URL}/ind_niftybanklist.csv"

_CSV_BODY = (
    b"Company Name,Industry,Symbol,Series,ISIN Code\r\n"
    b"Axis Bank Ltd.,Financial Services,AXISBANK,EQ,INE238A01034\r\n"
    b"Bank of Baroda,Financial Services,BANKBARODA,EQ,INE028A01039\r\n"
)


def _cdx_body(rows: list[tuple[str, str]]) -> bytes:
    """rows: (timestamp, original_url) pairs -> a CDX JSON response body."""
    header = ["urlkey", "timestamp", "original", "mimetype", "statuscode", "digest", "length"]
    payload = [header] + [
        ["x", ts, url, "text/csv", "200", "DIGEST", "100"] for ts, url in rows
    ]
    return json.dumps(payload).encode("utf-8")


class _FakeResponse:
    def __init__(self, body: bytes):
        self._buf = io.BytesIO(body)

    def read(self, n: int = -1) -> bytes:
        return self._buf.read(n)

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


def _dispatching_client(rules: list[tuple[str, bytes | Exception]]) -> tuple[NseClient, list[str]]:
    """`rules` is (url_substring, body_or_exception) checked in order; the
    first substring match wins. Every matched URL is recorded in `seen`."""
    client = NseClient()
    seen: list[str] = []

    def fake_open(req, timeout=None):  # noqa: ARG001
        seen.append(req.full_url)
        for substring, outcome in rules:
            if substring in req.full_url:
                if isinstance(outcome, Exception):
                    raise outcome
                return _FakeResponse(outcome)
        raise AssertionError(f"no rule matched {req.full_url}")

    client._opener.open = fake_open
    return client, seen


# --------------------------------------------------------------------------
# fetch_cdx_snapshots
# --------------------------------------------------------------------------


def test_fetch_cdx_snapshots_parses_and_sorts_oldest_first():
    body = _cdx_body([("20230101000000", _CATEGORY_URL), ("20180101000000", _CATEGORY_URL)])
    client, seen = _dispatching_client([(snapshots.CDX_URL, body)])

    result = snapshots.fetch_cdx_snapshots(_CATEGORY_URL, client)

    assert [s.timestamp for s in result] == ["20180101000000", "20230101000000"]
    assert seen[0].startswith(snapshots.CDX_URL)


def test_fetch_cdx_snapshots_returns_empty_when_no_snapshots_exist():
    body = json.dumps([]).encode("utf-8")  # CDX returns [] for a never-crawled URL
    client, _ = _dispatching_client([(snapshots.CDX_URL, body)])

    assert snapshots.fetch_cdx_snapshots(_CATEGORY_URL, client) == []


def test_fetch_cdx_snapshots_degrades_to_empty_on_request_failure():
    client, _ = _dispatching_client([(snapshots.CDX_URL, NseError("boom"))])

    # No history is treated the same as "never crawled" -- the caller falls
    # back to constant_current rather than the whole run failing.
    assert snapshots.fetch_cdx_snapshots(_CATEGORY_URL, client) == []


# --------------------------------------------------------------------------
# nearest_snapshot_for_year
# --------------------------------------------------------------------------


def test_nearest_snapshot_for_year_exact_year_is_live_annual_snapshot():
    snaps = [snapshots.Snapshot("20200615000000", _CATEGORY_URL)]

    picked = snapshots.nearest_snapshot_for_year(snaps, 2020)

    assert picked is not None
    snap, tier = picked
    assert snap.timestamp == "20200615000000"
    assert tier == snapshots.SourceTier.LIVE_ANNUAL_SNAPSHOT


def test_nearest_snapshot_for_year_different_year_is_nearest_fallback():
    snaps = [snapshots.Snapshot("20180101000000", _CATEGORY_URL)]

    picked = snapshots.nearest_snapshot_for_year(snaps, 2021)

    assert picked is not None
    snap, tier = picked
    assert snap.timestamp == "20180101000000"
    assert tier == snapshots.SourceTier.NEAREST_FALLBACK


def test_nearest_snapshot_for_year_picks_the_closer_of_two_candidates():
    snaps = [
        snapshots.Snapshot("20180101000000", _CATEGORY_URL),
        snapshots.Snapshot("20221201000000", _CATEGORY_URL),
    ]

    _, tier = snapshots.nearest_snapshot_for_year(snaps, 2023)

    # 2022-12-01 is much closer to 2023-01-01 than 2018-01-01 is.
    assert tier == snapshots.SourceTier.NEAREST_FALLBACK


def test_nearest_snapshot_for_year_returns_none_for_empty_history():
    assert snapshots.nearest_snapshot_for_year([], 2020) is None


# --------------------------------------------------------------------------
# fetch_snapshot_content
# --------------------------------------------------------------------------


def test_fetch_snapshot_content_uses_the_if_replay_mode_url():
    snap = snapshots.Snapshot("20200615000000", _CATEGORY_URL)
    client, seen = _dispatching_client([("web.archive.org/web/", _CSV_BODY)])

    body = snapshots.fetch_snapshot_content(snap, client)

    assert body == _CSV_BODY
    assert seen == [f"{snapshots.WAYBACK_CONTENT_BASE}/20200615000000if_/{_CATEGORY_URL}"]


# --------------------------------------------------------------------------
# build_category_year_membership: the three-tier orchestration
# --------------------------------------------------------------------------


def test_build_category_year_membership_uses_wayback_history():
    cdx_body = _cdx_body([("20200101000000", _CATEGORY_URL)])
    client, _ = _dispatching_client(
        [
            (snapshots.CDX_URL, cdx_body),
            ("web.archive.org/web/", _CSV_BODY),
        ]
    )

    rows, reports = snapshots.build_category_year_membership(
        "Nifty Bank", "niftybanklist", [2020, 2025], client
    )

    row_df = pd.DataFrame(rows)
    assert set(row_df.loc[row_df["year"] == 2020, "symbol"]) == {"AXISBANK", "BANKBARODA"}
    assert (row_df.loc[row_df["year"] == 2020, "source_tier"] == "live_annual_snapshot").all()
    assert (row_df.loc[row_df["year"] == 2025, "source_tier"] == "nearest_fallback").all()
    assert len(reports) == 2


def test_build_category_year_membership_fetches_snapshot_content_once_per_distinct_snapshot():
    """Two requested years resolving to the SAME nearest snapshot must only
    fetch that snapshot's content once (content_cache)."""
    cdx_body = _cdx_body([("20200101000000", _CATEGORY_URL)])
    fetch_count = {"n": 0}
    client = NseClient()

    def fake_open(req, timeout=None):  # noqa: ARG001
        if snapshots.CDX_URL in req.full_url:
            return _FakeResponse(cdx_body)
        if "web.archive.org/web/" in req.full_url:
            fetch_count["n"] += 1
            return _FakeResponse(_CSV_BODY)
        raise AssertionError(f"unexpected url {req.full_url}")

    client._opener.open = fake_open

    snapshots.build_category_year_membership("Nifty Bank", "niftybanklist", [2021, 2022], client)

    assert fetch_count["n"] == 1  # both years picked the same (only) snapshot


def test_build_category_year_membership_falls_back_to_constant_current_when_no_history():
    empty_cdx = json.dumps([]).encode("utf-8")
    client, _ = _dispatching_client(
        [
            (snapshots.CDX_URL, empty_cdx),
            (_CATEGORY_URL, _CSV_BODY),  # the live current-list fetch
        ]
    )

    rows, reports = snapshots.build_category_year_membership(
        "Nifty Bank", "niftybanklist", [2018, 2019], client
    )

    row_df = pd.DataFrame(rows)
    assert (row_df["source_tier"] == "constant_current").all()
    assert set(row_df.loc[row_df["year"] == 2018, "symbol"]) == {"AXISBANK", "BANKBARODA"}
    assert set(row_df.loc[row_df["year"] == 2019, "symbol"]) == {"AXISBANK", "BANKBARODA"}
    assert len(reports) == 2


def test_build_category_year_membership_returns_empty_when_wayback_and_live_both_fail():
    empty_cdx = json.dumps([]).encode("utf-8")
    client, _ = _dispatching_client(
        [
            (snapshots.CDX_URL, empty_cdx),
            (_CATEGORY_URL, NseError("connection refused")),
        ]
    )

    rows, reports = snapshots.build_category_year_membership(
        "Nifty Bank", "niftybanklist", [2018, 2019], client
    )

    assert rows == []
    assert len(reports) == 2
    assert all(r.n_symbols == 0 for r in reports)
    assert all(r.note for r in reports)  # every report row explains why


# --------------------------------------------------------------------------
# run_fetch: the full orchestration + CSV outputs
# --------------------------------------------------------------------------


def test_run_fetch_writes_membership_and_report_csvs(tmp_path, monkeypatch):
    """Every mapped category resolves via constant_current (empty CDX history
    everywhere, a valid live list everywhere) so this stays a fast, fully
    mocked test. All 16 of universe.csv's Sector/Thematic categories are
    mapped (see sources.CATEGORY_SLUGS) -- the "category isn't mapped at all"
    skip path is covered separately and name-agnostically by
    test_sources.test_fetch_category_current_returns_none_for_an_unmapped_category_name.
    """
    empty_cdx = json.dumps([]).encode("utf-8")

    def fake_open(req, timeout=None):  # noqa: ARG001
        if snapshots.CDX_URL in req.full_url:
            return _FakeResponse(empty_cdx)
        if req.full_url.startswith(f"{BASE_URL}/ind_"):
            return _FakeResponse(_CSV_BODY)
        raise AssertionError(f"unexpected url {req.full_url}")

    client = NseClient()
    client._opener.open = fake_open
    monkeypatch.setattr(snapshots.time, "sleep", lambda _s: None)  # skip inter-category pauses

    summary = snapshots.run_fetch(tmp_path, client, [2020, 2021])

    assert len(summary.categories_fetched) == 16
    assert summary.categories_skipped == []
    # tier_counts is per (category, year) report row, not per symbol: 16 cats x 2 yrs.
    assert summary.tier_counts == {"constant_current": 16 * 2}

    membership_path = tmp_path / snapshots.MEMBERSHIP_FILENAME
    report_path = tmp_path / snapshots.FETCH_REPORT_FILENAME
    assert membership_path.exists()
    assert report_path.exists()

    membership = pd.read_csv(membership_path)
    expected_columns = {"category", "year", "symbol", "source_tier", "wayback_timestamp"}
    assert set(membership.columns) == expected_columns
    assert len(membership) == summary.rows_written

    report = pd.read_csv(report_path)
    # 16 mapped categories x 2 years = 32 report rows, all resolved (none unmapped).
    assert len(report) == 32
    assert (report["note"] != "no niftyindices.com slug known").all()


def test_run_fetch_never_touches_network_for_unmapped_categories(tmp_path, monkeypatch):
    # All 16 real categories are mapped as of 2026-09 (see CATEGORY_SLUGS), so this
    # injects a synthetic None-slug entry rather than depending on a real category
    # staying unresolved forever -- see the same fix in test_sources.py for why.
    monkeypatch.setitem(sources.CATEGORY_SLUGS, "Fake Category With No Slug", None)
    empty_cdx = json.dumps([]).encode("utf-8")
    seen_urls: list[str] = []

    def fake_open(req, timeout=None):  # noqa: ARG001
        seen_urls.append(req.full_url)
        if snapshots.CDX_URL in req.full_url:
            return _FakeResponse(empty_cdx)
        return _FakeResponse(_CSV_BODY)

    client = NseClient()
    client._opener.open = fake_open
    monkeypatch.setattr(snapshots.time, "sleep", lambda _s: None)

    summary = snapshots.run_fetch(tmp_path, client, [2020])

    assert "Fake Category With No Slug" in summary.categories_skipped
    for url in seen_urls:
        assert "fake" not in url.lower()
