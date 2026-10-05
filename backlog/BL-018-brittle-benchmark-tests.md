# BL-018 — Momentum benchmark tests fail when the data is refreshed

| | |
|---|---|
| **Priority** | P2 — two local failures that will turn red again on every data refresh |
| **Status** | Planned |
| **Type** | bug |
| **Area** | momentum |
| **Created** | 2026-10-06 |
| **Depends on** | none |
| **TODO.md row** | — (filled in when started) |

## Context

On 2026-10-06 the full momentum suite ran 766 passed, 2 failed, both in
`tests/stocks/test_benchmarks.py`:

- `test_nifty_50_equal_weight_tri_and_price_share_an_identical_date_set`
- `test_nifty_50_tri_and_nifty200_momentum_30_tri_fixtures_share_the_same_session_set`

Both assert `len(series) == 3900`; the refreshed series has 3,904 sessions (data now runs to
2026-10-01). The tests check a hard-coded row count against data that grows every week.

## Goal

The tests check what they mean (the series share an identical date set, with no gaps) and pass
after any data refresh.

## Plan

### Phase 1 — Fix the assertion
- **Tasks:** compare the date sets with each other and against the trading calendar instead of
  a fixed length; keep a minimum-length floor.
- **Done when:** the suite passes on today's data and on the committed fixtures.

## Log

- 2026-10-06 — created; found while running every suite for the codebase review.
