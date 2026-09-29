"""sources.py: the category->slug map, current-constituent-list fetch, and the
soft-404 detection niftyindices.com needs (HTTP 200 with an "Error 404" HTML
body, not a real 404 status). No network -- `NseClient._opener.open` is
replaced with a fake in-memory transport, same seam `tests/stocks/test_nse.py`
uses.
"""

from __future__ import annotations

import io

import pytest

from momentum_backtesting.categories import sources
from momentum_backtesting.stocks.nse import NseClient

_CSV_BODY = (
    b"Company Name,Industry,Symbol,Series,ISIN Code\r\n"
    b"Axis Bank Ltd.,Financial Services,AXISBANK,EQ,INE238A01034\r\n"
    b"Bank of Baroda,Financial Services,BANKBARODA,EQ,INE028A01039\r\n"
)

_SOFT_404_BODY = b"<html><body><h1>Error 404</h1><p>Page not found</p></body></html>"


class _FakeResponse:
    def __init__(self, body: bytes):
        self._buf = io.BytesIO(body)

    def read(self, n: int = -1) -> bytes:
        return self._buf.read(n)

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


def _client_with_response(body: bytes) -> tuple[NseClient, list[str]]:
    client = NseClient()
    seen: list[str] = []

    def fake_open(req, timeout=None):  # noqa: ARG001
        seen.append(req.full_url)
        return _FakeResponse(body)

    client._opener.open = fake_open
    return client, seen


# --------------------------------------------------------------------------
# CATEGORY_SLUGS map
# --------------------------------------------------------------------------


def test_all_12_confirmed_categories_have_a_slug():
    confirmed = [
        "Nifty Bank",
        "Nifty IT",
        "Nifty PSU Bank",
        "Nifty Pharma",
        "Nifty Metal",
        "Nifty Infrastructure",
        "Nifty CPSE",
        "Nifty Realty",
        "Nifty FMCG",
        "Nifty Auto",
        "Nifty Energy",
        "Nifty Healthcare",
    ]
    for name in confirmed:
        assert sources.CATEGORY_SLUGS[name] is not None


def test_the_remaining_4_categories_also_have_a_slug():
    # Found 2026-09 by reading each index's own page for its real
    # constituent-list href -- each uses its own inconsistent naming, unlike
    # the 12 above's uniform ind_<name>list.csv pattern (see CATEGORY_SLUGS).
    also_confirmed = {
        "Nifty Capital Markets": "niftyCapitalMarkets_list",
        "Nifty Chemicals": "niftyChemicals_list",
        "Nifty India Defence": "niftyindiadefence_list",
        "Nifty Private Bank": "nifty_privatebanklist",
    }
    for name, slug in also_confirmed.items():
        assert sources.CATEGORY_SLUGS[name] == slug


def test_available_categories_returns_all_16():
    assert len(sources.available_categories()) == 16
    assert "Nifty Bank" in sources.available_categories()
    assert "Nifty Chemicals" in sources.available_categories()


# --------------------------------------------------------------------------
# parse_constituent_csv
# --------------------------------------------------------------------------


def test_parse_constituent_csv_happy_path():
    df = sources.parse_constituent_csv(_CSV_BODY, "http://example/x.csv")

    assert list(df.columns) == list(sources.CONSTITUENT_COLUMNS)
    assert len(df) == 2
    assert df.iloc[0]["symbol"] == "AXISBANK"
    assert df.iloc[1]["symbol"] == "BANKBARODA"


def test_parse_constituent_csv_raises_on_zero_data_rows():
    header_only = b"Company Name,Industry,Symbol,Series,ISIN Code\r\n"
    with pytest.raises(sources.CategorySourceError):
        sources.parse_constituent_csv(header_only, "http://example/x.csv")


def test_parse_constituent_csv_skips_rows_with_blank_symbol():
    body = _CSV_BODY + b",,,,\r\n"
    df = sources.parse_constituent_csv(body, "http://example/x.csv")
    assert len(df) == 2  # the blank-symbol row is dropped


# --------------------------------------------------------------------------
# fetch_slug / soft-404 detection
# --------------------------------------------------------------------------


def test_fetch_slug_happy_path_hits_the_expected_url():
    client, seen = _client_with_response(_CSV_BODY)

    df = sources.fetch_slug("niftybanklist", client)

    assert seen == [f"{sources.BASE_URL}/ind_niftybanklist.csv"]
    assert len(df) == 2


def test_fetch_slug_raises_categorysourceerror_on_soft_404():
    client, _ = _client_with_response(_SOFT_404_BODY)

    with pytest.raises(sources.CategorySourceError):
        sources.fetch_slug("niftycapitalmarketslist", client)


# --------------------------------------------------------------------------
# fetch_total_market / fetch_nifty200 / fetch_nifty500
# --------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("fn", "slug"),
    [
        (sources.fetch_total_market, sources.TOTAL_MARKET_SLUG),
        (sources.fetch_nifty200, sources.NIFTY200_SLUG),
        (sources.fetch_nifty500, sources.NIFTY500_SLUG),
    ],
)
def test_universe_fetch_functions_hit_the_right_slug(fn, slug):
    client, seen = _client_with_response(_CSV_BODY)

    fn(client)

    assert seen == [f"{sources.BASE_URL}/ind_{slug}.csv"]


# --------------------------------------------------------------------------
# fetch_category_current: the graceful-degradation entry point
# --------------------------------------------------------------------------


def test_fetch_category_current_returns_dataframe_for_a_mapped_category():
    client, seen = _client_with_response(_CSV_BODY)

    df = sources.fetch_category_current("Nifty Bank", client)

    assert df is not None
    assert len(df) == 2
    assert seen == [f"{sources.BASE_URL}/ind_niftybanklist.csv"]


def test_fetch_category_current_returns_none_for_none_slug_without_any_network_call(monkeypatch):
    # All 16 real categories are mapped as of 2026-09 (see CATEGORY_SLUGS), so the
    # slug=None branch is exercised with a synthetic entry rather than depending on
    # a real category staying unresolved -- that's exactly the fragility that made
    # this test break when Capital Markets got a real slug.
    monkeypatch.setitem(sources.CATEGORY_SLUGS, "Fake Category With No Slug", None)
    client = NseClient()

    def _boom(req, timeout=None):  # noqa: ARG001
        raise AssertionError("should never fetch a category with slug=None")

    client._opener.open = _boom

    assert sources.fetch_category_current("Fake Category With No Slug", client) is None


def test_fetch_category_current_returns_none_for_an_unmapped_category_name():
    client = NseClient()

    def _boom(req, timeout=None):  # noqa: ARG001
        raise AssertionError("should never fetch an unmapped category")

    client._opener.open = _boom

    assert sources.fetch_category_current("Not A Real Category", client) is None


def test_fetch_category_current_returns_none_on_soft_404():
    client, _ = _client_with_response(_SOFT_404_BODY)

    assert sources.fetch_category_current("Nifty Bank", client) is None
