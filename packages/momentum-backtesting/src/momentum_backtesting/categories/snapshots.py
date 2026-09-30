"""Point-in-time category membership via Wayback Machine snapshots of each
category's niftyindices.com constituent-list URL, with graceful degradation
when Wayback coverage for a category is thin or nonexistent.

**Wayback reachability, verified live from this environment (2026-09):**
`web.archive.org`'s CDX search API (`https://web.archive.org/cdx/search/cdx`)
and its snapshot-content endpoint (`https://web.archive.org/web/<ts>if_/<url>`)
both work reliably here, including through the bounded retry/backoff
`stocks.nse.NseClient` already provides (CDX occasionally 429s, which sits in
`NseClient._RETRYABLE_STATUSES`). The *other* Wayback endpoint,
`archive.org/wayback/available` (a single-snapshot lookup, the one the task
brief suggested), consistently 429ed here regardless of backoff/delay -- this
module deliberately never calls it. If Wayback is unreachable in a different
environment (the brief notes this was unverified in the original sandbox),
every function below degrades to the CONSTANT_CURRENT tier rather than
raising -- see `build_category_year_membership`.

**Design: one CDX query per category, not one per (category, year).** A CDX
search with `collapse=digest` returns a category's *entire* distinct-content
snapshot history in a single request. Verified live (2026-09, the original
12-slug set): niftyindices.com's category pages are crawled rarely by
Wayback -- 2 to 7 distinct captures per category, spanning roughly 2017-2026.
4 more categories (Capital Markets, Chemicals, India Defence, Private Bank)
were added to CATEGORY_SLUGS after that verification -- this module's
per-category logic applies to them unchanged, but their own Wayback coverage
hasn't specifically been re-checked; `run_fetch`'s per-category degrade path
(constant_current if a category has no usable history) covers that
automatically either way. Given a category's full snapshot list, the nearest
snapshot to 1 Jan of each requested year is picked locally
(`nearest_snapshot_for_year`) with no further network calls. Querying
`available` once per (category, year) instead -- more categories x ~10 years
-- would be slower, noisier, and hit the endpoint that's actually broken
here, for a dataset this small.

**Three source tiers**, recorded per (category, year) in the fetch report
(`fetch_report.csv`) so a downstream consumer can see exactly how reliable
each row is -- never silently:
  - `live_annual_snapshot` -- the nearest snapshot found is itself from the
    requested calendar year.
  - `nearest_fallback` -- no snapshot from the requested year; the nearest
    snapshot from a different year stands in.
  - `constant_current` -- Wayback has zero usable snapshots for this category
    at all (or the CDX lookup itself failed) -- the *current*, live-fetched
    constituent list is used for every requested year. This is an accepted
    simplification (a survivorship-bias tradeoff), not a failure.

Cached output lives under `data/categories/` (gitignored, matching
`data/stocks/`): a single consolidated long-format
`category_membership.csv` (columns: category, year, symbol, source_tier,
wayback_timestamp) rather than one file per category per year -- simpler to
build, read (`resolve.py`), and diff, and small enough (a few hundred
categories x years x constituents) that a single file has no real downside.
`fetch_report.csv` is the human-readable tier/coverage summary, one row per
(category, year) attempted, including categories that resolved to 0 rows.
"""

from __future__ import annotations

import logging
import time
from dataclasses import dataclass, field
from datetime import date
from enum import StrEnum
from pathlib import Path

import pandas as pd

from momentum_backtesting.categories import sources
from momentum_backtesting.stocks.nse import NseClient, NseError, atomic_write_bytes

logger = logging.getLogger(__name__)

CDX_URL = "https://web.archive.org/cdx/search/cdx"
WAYBACK_CONTENT_BASE = "https://web.archive.org/web"

MEMBERSHIP_FILENAME = "category_membership.csv"
FETCH_REPORT_FILENAME = "fetch_report.csv"

#: A CDX/content-fetch failure is fairly common on a flaky network path (see
#: module docstring); a short pause before the *next* category keeps a run
#: from hammering an already-429ing host. Separate from NseClient's own
#: per-request throttle/backoff, which already covers retries *within* one
#: category's requests.
_INTER_CATEGORY_PAUSE_SECONDS = 0.5


class SourceTier(StrEnum):
    LIVE_ANNUAL_SNAPSHOT = "live_annual_snapshot"
    NEAREST_FALLBACK = "nearest_fallback"
    CONSTANT_CURRENT = "constant_current"


@dataclass(frozen=True)
class Snapshot:
    """One CDX row: a Wayback capture of a category's constituent-list URL."""

    timestamp: str  # 14-digit YYYYMMDDHHMMSS, Wayback's own format
    original_url: str

    @property
    def snapshot_date(self) -> date:
        return date(int(self.timestamp[0:4]), int(self.timestamp[4:6]), int(self.timestamp[6:8]))


def fetch_cdx_snapshots(url: str, client: NseClient) -> list[Snapshot]:
    """Every distinct-content, HTTP-200 Wayback capture of `url`, oldest
    first. One request regardless of how many years the caller resolves
    against it (see module docstring). Returns `[]` if Wayback has never
    captured this URL, or if the CDX request itself fails after retries --
    neither is an error here; the caller's CONSTANT_CURRENT tier is exactly
    this case, so a network hiccup degrades gracefully rather than failing
    the whole run.
    """
    try:
        body = client.get_json(
            CDX_URL,
            params={
                "url": url,
                "output": "json",
                "filter": "statuscode:200",
                "collapse": "digest",
                "limit": "2000",
            },
            timeout=30.0,
        )
    except NseError as error:
        logger.warning(
            "CDX lookup failed for %s (%s) -- treating as no Wayback history", url, error
        )
        return []

    if not isinstance(body, list) or len(body) < 2:
        return []
    header = body[0]
    try:
        ts_idx = header.index("timestamp")
        orig_idx = header.index("original")
    except ValueError:
        logger.warning("unexpected CDX header shape for %s: %r", url, header)
        return []
    snaps = [Snapshot(timestamp=row[ts_idx], original_url=row[orig_idx]) for row in body[1:]]
    return sorted(snaps, key=lambda s: s.timestamp)


def nearest_snapshot_for_year(
    snapshots: list[Snapshot], year: int
) -> tuple[Snapshot, SourceTier] | None:
    """Pick the snapshot closest to 1 Jan `year` from `snapshots`. Tier is
    LIVE_ANNUAL_SNAPSHOT if the closest snapshot's own calendar year matches
    `year`, else NEAREST_FALLBACK. Returns None if `snapshots` is empty --
    the caller's cue to fall back to CONSTANT_CURRENT instead.
    """
    if not snapshots:
        return None
    target = date(year, 1, 1)
    best = min(snapshots, key=lambda s: abs((s.snapshot_date - target).days))
    tier = (
        SourceTier.LIVE_ANNUAL_SNAPSHOT
        if best.snapshot_date.year == year
        else SourceTier.NEAREST_FALLBACK
    )
    return best, tier


def fetch_snapshot_content(snapshot: Snapshot, client: NseClient) -> bytes:
    """Download one Wayback capture's raw body. `if_` selects Wayback's
    "identical" replay mode: the original response bytes, with no Wayback
    toolbar/banner injected (which a plain `/web/<ts>/<url>` fetch would
    include, corrupting the CSV).
    """
    url = f"{WAYBACK_CONTENT_BASE}/{snapshot.timestamp}if_/{snapshot.original_url}"
    return client.get_bytes(url, timeout=30.0)


@dataclass
class CategoryYearReport:
    """One row of fetch_report.csv: what happened resolving one
    (category, year) pair."""

    category: str
    year: int
    source_tier: str
    wayback_timestamp: str
    n_symbols: int
    note: str = ""


@dataclass
class FetchSummary:
    """Returned by `run_fetch` -- the CLI's/caller's at-a-glance result."""

    categories_fetched: list[str] = field(default_factory=list)
    categories_skipped: list[str] = field(default_factory=list)
    tier_counts: dict[str, int] = field(default_factory=dict)
    rows_written: int = 0
    elapsed_seconds: float = 0.0


def build_category_year_membership(
    category: str,
    slug: str,
    years: list[int],
    client: NseClient,
) -> tuple[list[dict], list[CategoryYearReport]]:
    """Membership rows for one category across `years`, applying the tier
    rules in the module docstring. Never raises for missing/thin Wayback
    history or a failed live fetch -- both degrade to fewer/zero rows plus a
    logged warning and a `note` in the returned report rows, per the task's
    "must degrade gracefully" requirement.

    Returns (membership_rows, report_rows). `membership_rows` are plain dicts
    with keys category/year/symbol/source_tier/wayback_timestamp, ready to
    become `category_membership.csv` rows.

    Generic over (category, slug) throughout, including the CONSTANT_CURRENT fallback below
    (`sources.fetch_by_slug_or_none`, not the CATEGORY_SLUGS-coupled `fetch_category_current`) --
    verified/fixed for `categories/broad.py`'s Total Market fetch (TODO.md 3.9.13 Step 1), which
    calls this with a (label, slug) pair that is never in `sources.CATEGORY_SLUGS` at all.
    """
    url = f"{sources.BASE_URL}/ind_{slug}.csv"
    history = fetch_cdx_snapshots(url, client)

    if not history:
        current = sources.fetch_by_slug_or_none(category, slug, client)
        if current is None:
            note = "no Wayback history and the live fetch also failed -- 0 rows"
            logger.warning("category %r: %s", category, note)
            return [], [CategoryYearReport(category, year, "", "", 0, note=note) for year in years]
        rows = [
            {
                "category": category,
                "year": year,
                "symbol": symbol,
                "source_tier": SourceTier.CONSTANT_CURRENT.value,
                "wayback_timestamp": "",
            }
            for year in years
            for symbol in current["symbol"]
        ]
        reports = [
            CategoryYearReport(
                category,
                year,
                SourceTier.CONSTANT_CURRENT.value,
                "",
                len(current),
                note="no Wayback snapshots for this category -- live list used for every year",
            )
            for year in years
        ]
        return rows, reports

    rows: list[dict] = []
    reports: list[CategoryYearReport] = []
    content_cache: dict[str, pd.DataFrame | None] = {}
    for year in years:
        picked = nearest_snapshot_for_year(history, year)
        assert picked is not None  # `history` is non-empty in this branch
        snapshot, tier = picked

        if snapshot.timestamp not in content_cache:
            try:
                body = fetch_snapshot_content(snapshot, client)
                content_cache[snapshot.timestamp] = sources.parse_constituent_csv(
                    body, snapshot.original_url
                )
            except (NseError, sources.CategorySourceError) as error:
                logger.warning(
                    "snapshot %s for %r failed to fetch/parse (%s) -- skipping year %d",
                    snapshot.timestamp,
                    category,
                    error,
                    year,
                )
                content_cache[snapshot.timestamp] = None

        parsed = content_cache[snapshot.timestamp]
        if parsed is None:
            reports.append(
                CategoryYearReport(
                    category,
                    year,
                    tier.value,
                    snapshot.timestamp,
                    0,
                    note="snapshot fetch/parse failed",
                )
            )
            continue

        for symbol in parsed["symbol"]:
            rows.append(
                {
                    "category": category,
                    "year": year,
                    "symbol": symbol,
                    "source_tier": tier.value,
                    "wayback_timestamp": snapshot.timestamp,
                }
            )
        reports.append(
            CategoryYearReport(category, year, tier.value, snapshot.timestamp, len(parsed))
        )

    return rows, reports


def _write_csv_atomic(df: pd.DataFrame, path: Path) -> None:
    """Write `df` to `path` as CSV, atomically (see stocks.nse.atomic_write_bytes'
    docstring for why: a process killed mid-write must never leave a partial
    file visible at `path`). Mirrors how bhavcopy.build_daily_parquet writes
    its own computed output.
    """
    atomic_write_bytes(path, df.to_csv(index=False).encode("utf-8"))


def run_fetch(data_dir: Path, client: NseClient, years: list[int]) -> FetchSummary:
    """Fetch/refresh `data_dir/category_membership.csv` and
    `data_dir/fetch_report.csv` for every mapped (slug is not None) category
    in `sources.CATEGORY_SLUGS`, across `years`. Never raises for a single
    category's failure -- see `build_category_year_membership`; a category
    that ends up with 0 rows is recorded in `categories_skipped`, not treated
    as a run failure.
    """
    start = time.monotonic()
    all_rows: list[dict] = []
    all_reports: list[CategoryYearReport] = []
    fetched: list[str] = []
    skipped: list[str] = []

    mapped = [(name, slug) for name, slug in sources.CATEGORY_SLUGS.items() if slug is not None]
    for i, (category, slug) in enumerate(mapped):
        rows, reports = build_category_year_membership(category, slug, years, client)
        all_reports.extend(reports)
        if rows:
            fetched.append(category)
            all_rows.extend(rows)
        else:
            skipped.append(category)
        if i < len(mapped) - 1:
            time.sleep(_INTER_CATEGORY_PAUSE_SECONDS)

    unmapped = [name for name, slug in sources.CATEGORY_SLUGS.items() if slug is None]
    skipped.extend(unmapped)
    for category in unmapped:
        for year in years:
            all_reports.append(
                CategoryYearReport(category, year, "", "", 0, note="no niftyindices.com slug known")
            )

    data_dir.mkdir(parents=True, exist_ok=True)
    membership_df = pd.DataFrame(
        all_rows, columns=["category", "year", "symbol", "source_tier", "wayback_timestamp"]
    )
    _write_csv_atomic(membership_df, data_dir / MEMBERSHIP_FILENAME)

    report_df = pd.DataFrame(
        [
            {
                "category": r.category,
                "year": r.year,
                "source_tier": r.source_tier,
                "wayback_timestamp": r.wayback_timestamp,
                "n_symbols": r.n_symbols,
                "note": r.note,
            }
            for r in all_reports
        ],
        columns=["category", "year", "source_tier", "wayback_timestamp", "n_symbols", "note"],
    )
    _write_csv_atomic(report_df, data_dir / FETCH_REPORT_FILENAME)

    tier_counts = report_df["source_tier"].replace("", pd.NA).dropna().value_counts().to_dict()

    return FetchSummary(
        categories_fetched=fetched,
        categories_skipped=skipped,
        tier_counts={str(k): int(v) for k, v in tier_counts.items()},
        rows_written=len(membership_df),
        elapsed_seconds=time.monotonic() - start,
    )
