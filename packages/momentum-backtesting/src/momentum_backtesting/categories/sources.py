"""Category -> official NSE index-constituent CSV, and the base stock universe.

niftyindices.com serves each Nifty sector/thematic index's *current*
constituent list at a fixed URL pattern:
`https://niftyindices.com/IndexConstituent/ind_<slug>.csv`, a 5-column CSV
(Company Name, Industry, Symbol, Series, ISIN Code). The same host and schema
serve the base stock universe this feature ranks against: "Total Market"
(Nifty 500 + Nifty Microcap 250, verified 755 rows, 2026-09) plus Nifty 200
and Nifty 500 (verified exact subsets: 200 rows subset of 501 rows subset of
755 rows) for later filtering.

Fetching goes through `stocks.nse.NseClient` for its throttle/retry/size-cap
machinery -- verified live (2026-09) that niftyindices.com needs no cookie
warm-up (unlike nseindia.com, which `NseClient.warm_up` targets specifically):
a plain browser User-Agent gets HTTP 200 with no prior homepage visit. NEVER
call `warm_up()` before a niftyindices.com fetch -- it hits nseindia.com and
is unnecessary overhead here (and, per the task brief, may hang). Also
verified live: niftyindices.com itself is occasionally slow/flaky from a
sandboxed network path (a handful of individual requests time out even with a
60s cap) but is reliable on retry -- exactly the transient-failure shape
`NseClient`'s bounded-retry-with-backoff already handles, so no extra retry
logic is added here.

All 16 of universe.csv's Sector/Thematic categories have a working slug as of
2026-09 -- 12 follow the plain `ind_<name>list.csv` pattern, and 4 (Capital
Markets, Chemicals, India Defence, Private Bank) use their own inconsistent
naming, found by reading each index's own page for its real constituent-list
href rather than guessing (see the comment above those 4 entries in
CATEGORY_SLUGS). `slug=None` is still a supported state in the type and in
every fetch function below -- niftyindices.com returns HTTP 200 with an HTML
"Error 404" page body instead of a real 404 status for a constituent-list URL
that doesn't exist (`_is_soft_404` below detects this from the body, not the
status), and a category could regress to unavailable if niftyindices.com
reorganises its URLs again. Every fetch function here skips a None-slug (or
an otherwise-failing) category by returning None and logging a warning, never
by raising -- the feature is designed to degrade gracefully if any category
becomes unavailable, not just today's 16/16.
"""

from __future__ import annotations

import csv
import io
import logging

import pandas as pd

from momentum_backtesting.stocks.nse import NseClient, NseError

logger = logging.getLogger(__name__)

BASE_URL = "https://niftyindices.com/IndexConstituent"

#: The base stock universe (Nifty 500 + Nifty Microcap 250 = "Total Market",
#: 755 names verified 2026-09) plus two smaller, verified-subset lists kept
#: around for later filtering (e.g. "only rank Total Market names that are
#: also in the Nifty 500" for liquidity reasons -- not decided by this task).
TOTAL_MARKET_SLUG = "niftytotalmarket_list"
NIFTY200_SLUG = "nifty200list"
NIFTY500_SLUG = "nifty500list"

#: universe.csv `index` column value -> niftyindices.com slug (the
#: `ind_<slug>.csv` filename, no extension). `None` means "confirmed
#: unavailable as of 2026-09" (see module docstring), not "not yet checked" --
#: every one of universe.csv's 16 Sector/Thematic rows is listed here
#: (verified against universe.csv, 2026-09); a category silently missing from
#: this dict entirely would be a real bug, not an intentional gap. Re-check by
#: hand occasionally: niftyindices.com does add new constituent-list URLs
#: over time, and a `None` here might become resolvable later.
CATEGORY_SLUGS: dict[str, str | None] = {
    "Nifty Bank": "niftybanklist",
    "Nifty IT": "niftyitlist",
    "Nifty PSU Bank": "niftypsubanklist",
    "Nifty Pharma": "niftypharmalist",
    "Nifty Metal": "niftymetallist",
    "Nifty Infrastructure": "niftyinfralist",
    "Nifty CPSE": "niftycpselist",
    "Nifty Realty": "niftyrealtylist",
    "Nifty FMCG": "niftyfmcglist",
    "Nifty Auto": "niftyautolist",
    "Nifty Energy": "niftyenergylist",
    "Nifty Healthcare": "niftyhealthcarelist",
    # These 4 don't follow the ind_<name>list.csv pattern the other 12 use --
    # each has its own inconsistent naming (mixed case, underscore placement)
    # on niftyindices.com. Found 2026-09 by reading the *_list.csv href out of
    # each index's own page HTML (systematic slug-guessing missed all 4;
    # the page source has the real link even though the constituent CSV link
    # isn't in a plain static <a> tag reachable by a simple grep of the raw
    # page -- it's rendered client-side, but the href string itself is still
    # present in the page's embedded JS/data, which is how these were found).
    "Nifty Capital Markets": "niftyCapitalMarkets_list",
    "Nifty Chemicals": "niftyChemicals_list",
    "Nifty India Defence": "niftyindiadefence_list",
    "Nifty Private Bank": "nifty_privatebanklist",
}

#: The columns `parse_constituent_csv` produces, in order -- the on-the-wire
#: header ("Company Name", "Industry", "Symbol", "Series", "ISIN Code")
#: snake_cased, since this is a computed frame (pandas), not a curated file.
CONSTITUENT_COLUMNS = ("company_name", "industry", "symbol", "series", "isin_code")


class CategorySourceError(Exception):
    """A genuine fetch/parse failure for a *mapped* slug (e.g. malformed CSV,
    an HTTP error `NseClient` couldn't recover from). Never raised for a
    category whose slug is `None` or that soft-404s -- both are the expected
    "not available" outcome, signalled by returning `None`, not raising (see
    `fetch_category_current`).
    """


def _is_soft_404(body: bytes) -> bool:
    """niftyindices.com returns HTTP 200 with an HTML error page, not a real
    404 status, for a constituent-list URL that doesn't exist. Detected from
    the body rather than the status code -- verified live (2026-09): every
    one of the 4 unresolved CATEGORY_SLUGS entries 200s with the literal
    string "Error 404" in the response body.
    """
    return b"Error 404" in body


def parse_constituent_csv(body: bytes, url: str) -> pd.DataFrame:
    """Parse one `ind_<slug>.csv` body (live or a Wayback-archived capture of
    the same URL -- byte-identical schema either way) into a DataFrame with
    CONSTITUENT_COLUMNS. Raises CategorySourceError if no data rows parse --
    a 0-row constituent list is never legitimate for any of these indices.
    """
    text = body.decode("utf-8-sig", errors="replace")
    reader = csv.DictReader(io.StringIO(text))
    rows = [row for row in reader if (row.get("Symbol") or "").strip()]
    if not rows:
        raise CategorySourceError(f"no data rows parsed from {url}")
    return pd.DataFrame(
        {
            "company_name": [r.get("Company Name", "").strip() for r in rows],
            "industry": [r.get("Industry", "").strip() for r in rows],
            "symbol": [r.get("Symbol", "").strip() for r in rows],
            "series": [r.get("Series", "").strip() for r in rows],
            "isin_code": [r.get("ISIN Code", "").strip() for r in rows],
        }
    )


def fetch_slug(slug: str, client: NseClient) -> pd.DataFrame:
    """Fetch and parse the *current* constituent list at `ind_<slug>.csv`.
    Raises CategorySourceError on a soft 404 or an unparsable body, NseError
    on a transport failure `NseClient` couldn't recover from after retries.
    """
    url = f"{BASE_URL}/ind_{slug}.csv"
    body = client.get_bytes(url)
    if _is_soft_404(body):
        raise CategorySourceError(f"soft 404 (Error 404 HTML body) from {url}")
    return parse_constituent_csv(body, url)


def fetch_total_market(client: NseClient) -> pd.DataFrame:
    """The base stock universe: Nifty Total Market (Nifty 500 + Nifty
    Microcap 250), 755 names verified 2026-09."""
    return fetch_slug(TOTAL_MARKET_SLUG, client)


def fetch_nifty200(client: NseClient) -> pd.DataFrame:
    """Nifty 200 -- a verified subset of fetch_total_market's rows."""
    return fetch_slug(NIFTY200_SLUG, client)


def fetch_nifty500(client: NseClient) -> pd.DataFrame:
    """Nifty 500 -- a verified subset of fetch_total_market's rows, superset
    of fetch_nifty200's."""
    return fetch_slug(NIFTY500_SLUG, client)


def fetch_by_slug_or_none(label: str, slug: str, client: NseClient) -> pd.DataFrame | None:
    """Current constituent list at `ind_<slug>.csv`, or None (after logging a warning) rather
    than raising, for any reason the live fetch can fail (soft-404, transport error, unparsable
    body). `label` is used only for the warning message -- this is the slug-generic core that
    both `fetch_category_current` (CATEGORY_SLUGS-coupled, universe.csv's 16 Sector/Thematic
    categories) and `snapshots.build_category_year_membership`'s own CONSTANT_CURRENT fallback
    (any (label, slug) pair, e.g. Total Market -- see categories/broad.py) share, so the
    "degrade gracefully, never fail the run" contract lives in exactly one place regardless of
    which caller is asking.
    """
    try:
        return fetch_slug(slug, client)
    except (CategorySourceError, NseError) as error:
        logger.warning("%r live fetch failed (%s) -- skipping", label, error)
        return None


def fetch_category_current(category: str, client: NseClient) -> pd.DataFrame | None:
    """Current constituent list for one universe.csv Sector/Thematic
    category. Returns None (after logging a warning) rather than raising, for
    any reason a category can be unavailable: `category` isn't in
    CATEGORY_SLUGS at all, its slug is `None` (confirmed-unavailable -- see
    module docstring), or the live fetch fails (soft-404, transport error,
    unparsable body) despite a mapped slug. This is the intended "degrade
    gracefully, never fail the run" behaviour the category-momentum feature
    needs -- see snapshots.py, which is the caller that matters.
    """
    slug = CATEGORY_SLUGS.get(category, "__unmapped__")
    if slug == "__unmapped__":
        logger.warning("category %r is not in CATEGORY_SLUGS at all -- skipping", category)
        return None
    if slug is None:
        logger.warning("category %r has no known niftyindices.com slug -- skipping", category)
        return None
    return fetch_by_slug_or_none(category, slug, client)


def available_categories() -> list[str]:
    """universe.csv category names with a working slug (16 of 16 as of
    2026-09), in CATEGORY_SLUGS's own order."""
    return [name for name, slug in CATEGORY_SLUGS.items() if slug is not None]
