# BL-018 — Momentum tests fail when the live data is refreshed

| | |
|---|---|
| **Priority** | P2 — local failures that turned red again on every data refresh |
| **Status** | Done |
| **Type** | bug |
| **Area** | momentum |
| **Created** | 2026-10-06 |
| **Depends on** | none |
| **TODO.md row** | 3.14.5 |

## Context

On 2026-10-06 the full momentum suite ran 766 passed, 2 failed, both in
`tests/stocks/test_benchmarks.py`:

- `test_nifty_50_equal_weight_tri_and_price_share_an_identical_date_set`
- `test_nifty_50_tri_and_nifty200_momentum_30_tri_fixtures_share_the_same_session_set`

Both assert `len(series) == 3900`; the refreshed series has 3,904 sessions (data now runs to
2026-10-01). The tests check a hard-coded row count against data that grows every week.

On 2026-10-07 four more tests in the same class failed on `main` (af608c2) with the live
`data/` and `.env` present. CI has neither, so all six skip or pass there:

| Test | Root cause |
|---|---|
| `tests/test_extra_benchmarks.py::test_load_references_reads_the_extras_from_the_database` | `load_references()` with no `data_dir` falls back to the live `data/stocks/benchmarks_weekly.csv` for any series the (isolated, seeded) catalog lacks, so every other reference leaked in |
| `tests/test_reference_benchmarks.py::test_load_references_reads_the_database_when_a_catalog_exists` | Same |
| `tests/stocks/test_membership.py::test_real_membership_invariants` | The committed curation records the Sep-2026 review (BSE in, WIPRO out, effective 2026-09-30; commit 4412bad), but the hand-downloaded `data/stocks/raw/nifty50_current.csv` is from 2026-09-27, before it. The test compared the open-ended rows with that snapshot |
| `tests/stocks/test_engine_stocks.py::test_load_stock_dataset_smoke` (KeyError `C0096`) | `ds.companies` is the committed `companies.csv` (BSE added as C0096); `ds.tax_classes` is keyed on the built data's columns (built 2026-09-28, no BSE yet). The test looked up every company's tax class |

None is a code bug. `api._stock_classification` and `_stock_meta` already handle a company
with no price column (it shows as a former member until the next build).

## Goal

The tests check what they mean, and pass after any data refresh.

## Plan

### Phase 1 — Fix the assertions
- **Tasks:** compare the date sets with each other and against NSE's session calendar instead
  of a fixed length; keep a minimum-length floor. Point the database tests at an empty data
  dir. Check the current-list snapshot matches the curated members on some day.
  Check tax classes over the companies the built data prices.
- **Done when:** the suite passes on today's data and with no `data/`.

## Log

- 2026-10-06 — created; found while running every suite for the codebase review.
- 2026-10-07 — four more data-dependent failures found on `main` (table above) and folded in.
  Fixed, tests only, `tests/golden/` untouched:
  - Benchmarks: `_assert_full_session_history` checks the TRIs and the EW price share one
    index, unique and increasing, starting 2011-01-03, at least 3,900 sessions, and equal to
    the `ok` days of `data/stocks/raw/bhavcopy_manifest.csv` (NSE's own per-session files)
    up to the manifest's last day. Days after it only get a 6-day gap bound (the longest
    closure, 2014-10-01 → 07). PR #102 review: a max-gap bound alone let a missing ordinary
    weekday through.
  - Reference tests pass `tmp_path` to `load_references`.
  - Membership: counts checked over every session as before; the snapshot must equal the
    curated members on some day (it carries no date, and a file time moves on any copy:
    PR #102 review).
  - Stock smoke test: tax classes checked over priced companies only.
  - Result: the six pass on live data; 68 passed / 5 skipped without `data/`; full suite
    1,142 passed on live data.
  - **Still open, owner:** `mbt stocks fetch`'s guard compares the open rows with the same
    stale snapshot and is severity F, so `mbt stocks sync` (the Friday 19:30 job) exits 1
    until `data/stocks/raw/nifty50_current.csv` is downloaded again (TODO 3.14.6).
