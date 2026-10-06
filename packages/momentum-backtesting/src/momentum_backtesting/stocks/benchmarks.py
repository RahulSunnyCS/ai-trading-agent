"""TRI + equal-weight price benchmarks (niftyindices.com) and the cash NAV backfill.

`fetch_tri` and `fetch_equal_weight_price` are thin wrappers over
`sources.niftyindices_tri_daily` / `sources.niftyindices_daily` — this module is where
the stocks data layer's specific index names, launch-date caveats, and date ranges
live, not a second HTTP client. (Contrary to this module's original T0 stub docstring,
plan.md §1's live probe found the TRI feed is a *separate* endpoint,
`POST /BackPage/getTotalReturnIndexString`, not `getHistoricaldatatabletoString` with
`NTR_Value` standing in for the total-return value — `NTR_Value` is net-of-tax and is
"-" for most indices. `sources.niftyindices_tri_daily`, added for this task, hits that
endpoint; `sources.niftyindices_daily` — the ETF path's existing function — still
supplies the plain price index.)
"""

from __future__ import annotations

from datetime import date

import pandas as pd

from .. import fetch
from ..sources import amfi_nav, niftyindices_daily, niftyindices_tri_daily, weekly

#: niftyindices.com index names, as accepted by sources.niftyindices_tri_daily /
#: sources.niftyindices_daily's `name` parameter.
NIFTY_50_TRI = "NIFTY 50"
NIFTY200_MOMENTUM_30_TRI = "NIFTY200 MOMENTUM 30"
NIFTY_50_EQUAL_WEIGHT_TRI = "NIFTY50 EQUAL WEIGHT"
NIFTY_50_EQUAL_WEIGHT_PRICE = "NIFTY50 EQUAL WEIGHT"

#: Comparison-only TRIs (BL-010 Phase 5), keyed by their benchmarks_weekly.csv column:
#: (niftyindices.com index name, raw snapshot filename under raw/benchmarks/). The display
#: names for the same columns are ui_data.REFERENCE_ONLY_COLUMNS - one place per fact.
EXTRA_TRI_INDICES = {
    "nifty_midcap150_tri": ("NIFTY MIDCAP 150", "NIFTY_MIDCAP_150_TRI.json"),
    "nifty_smallcap250_tri": ("NIFTY SMALLCAP 250", "NIFTY_SMALLCAP_250_TRI.json"),
    "nifty_midcap150_momentum50_tri": (
        "NIFTY MIDCAP150 MOMENTUM 50",
        "NIFTY_MIDCAP150_MOMENTUM_50_TRI.json",
    ),
    "nifty500_momentum50_tri": ("NIFTY500 MOMENTUM 50", "NIFTY500_MOMENTUM_50_TRI.json"),
}

#: NSE's publicly documented launch date for the Nifty200 Momentum 30 Index. The TRI
#: feed returns history back to 2011 regardless (plan.md §1), but every value dated
#: before this is NSE's own back-calculation, not an observed index level — callers
#: that fetch NIFTY200_MOMENTUM_30_TRI should label rows before this date accordingly
#: (e.g. via `is_back_calculated`).
NIFTY200_MOMENTUM_30_LAUNCH_DATE = date(2020, 8, 11)

#: AMFI scheme codes for UTI Liquid Fund Growth, one per plan. The Direct plan is the
#: series actually traded against (LIQUIDBEES-equivalent, see universe.csv); the
#: Regular plan only exists to extend history back before the Direct plan launched
#: (2013-01-01) — Direct and Regular NAVs diverge slowly over time (different expense
#: ratios), so splicing needs `fetch.backfill`'s scale-at-the-join logic, not a raw
#: concat.
UTI_LIQUID_DIRECT_GROWTH_SCHEME_CODE = "120304"
UTI_LIQUID_REGULAR_GROWTH_SCHEME_CODE = "102012"


def fetch_tri(name: str, start: date, end: date) -> pd.Series:
    """Total-return index daily closes for `name` (e.g. NIFTY_50_TRI), via
    sources.niftyindices_tri_daily. Verified (plan.md §1) to share the same 3,900-date
    session set as the corresponding price index back to 2011-01-03.
    """
    return niftyindices_tri_daily(name, start, end)


def is_back_calculated(
    index_dates: pd.Index, launch_date: date = NIFTY200_MOMENTUM_30_LAUNCH_DATE
) -> pd.Series:
    """Boolean series, aligned to `index_dates`, True for every date before an index's
    real launch (i.e. NSE-back-calculated history rather than an observed index level).
    Defaults to the Nifty200 Momentum 30 launch date since that's the one benchmark in
    this module whose early history is back-calculated.
    """
    return pd.Series(index_dates < pd.Timestamp(launch_date), index=index_dates)


def fetch_equal_weight_price(start: date, end: date) -> pd.Series:
    """NIFTY50 EQUAL WEIGHT price-index daily closes, via sources.niftyindices_daily.

    Used by validate.dividend_check (plan.md §4.1) as the price leg paired against
    fetch_tri(NIFTY_50_EQUAL_WEIGHT_PRICE's TRI counterpart, ...) to isolate the
    dividend spread, and by membership_check.run as the reference EW return series.
    """
    return niftyindices_daily(NIFTY_50_EQUAL_WEIGHT_PRICE, start, end)


def assert_same_session_set(tri: pd.Series, price: pd.Series) -> None:
    """Raise ValueError if `tri` and `price` don't share an identical date index.

    T4's regression test for the fact plan.md §1 records ("identical date set to
    its TRI") — called on every fetch, not just in the test, so a future NSE change
    to either feed is caught immediately rather than silently skewing validate.py.
    """
    if tri.index.equals(price.index):
        return
    only_tri = tri.index.difference(price.index)
    only_price = price.index.difference(tri.index)
    raise ValueError(
        "TRI and equal-weight price session sets differ: "
        f"{len(only_tri)} date(s) only in TRI (e.g. {list(only_tri[:3])}), "
        f"{len(only_price)} date(s) only in price (e.g. {list(only_price[:3])})"
    )


def cash_weekly(start: date) -> tuple[pd.Series, float]:
    """Direct-plan liquid-fund NAV, resampled to weekly closes, spliced onto the
    older AMFI Regular-plan series before the Direct plan's start (2013-01-01, see
    fetch.backfill, which this delegates to for the join-and-scale logic).

    Deviates from the T0 stub's `-> pd.Series` signature: QA F07 requires the
    level ratio at the splice join to be reported (locked-in acceptance criterion,
    "level ratio reported"), and no other module calls this function yet (grepped
    the tree before changing it), so the return type is widened to
    `(series, ratio)` — the same shape `fetch.backfill` itself already returns —
    rather than bolting on a side-channel logger for a single value.

    Despite the name, the "Direct plan" series (AMFI code 120304, from universe.csv)
    is what the rest of the pipeline trades against; the Regular-plan series
    (AMFI code 102012, found via mfapi.in/mf/search by fund name — verified its NAV
    history covers 2006 onward, well before the 2011 requirement) exists solely to
    extend history back before 2013-01-01.
    """
    direct = amfi_nav(UTI_LIQUID_DIRECT_GROWTH_SCHEME_CODE, start)
    regular = amfi_nav(UTI_LIQUID_REGULAR_GROWTH_SCHEME_CODE, start)
    combined, ratio = fetch.backfill(direct, regular)
    return weekly(combined), ratio
