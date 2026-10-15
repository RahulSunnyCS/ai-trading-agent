# BL-108 — Overnight context: GIFT Nifty and global closes for the 09:17 entries

| | |
|---|---|
| **Priority** | — (dropped) |
| **Status** | Dropped — redundant with the 09:15 VIX open and the spot bars (2026-10-14) |
| **Type** | research |
| **Area** | options / trading-data |
| **Created** | 2026-10-14 |
| **Depends on** | none |
| **TODO.md row** | — (filled in when started) |

## Context

The rotation lists enter at 09:17 and the lake has nothing that explains the open: no
GIFT Nifty, no overnight US close, no USDINR or crude. Daily bars are enough, so the cost is
low. Whether it is worth anything is a research question: the research gate in `CLAUDE.md`
applies, so a Phase 0 pre-registration comes before any run.

## Goal

A daily table of overnight context keyed by the Indian trading date (as known at 09:15), and
one pre-registered test of whether any of it predicts the 09:17 strategies' day P&L beyond what
the lake already holds.

## Out of scope

Intraday global data, news, and anything that needs a paid feed.

## Plan

### Phase 0 — Pre-register
Fill in the template's Phase 0 before collecting: the hypothesis, the point-in-time rule (a
value counts only if it was published before 09:15 IST of the trading date), the pass or kill
rule against the lake-only baseline, a hold-out, and the tests that will not be run.

### Phase 1 — Source and collect
- **Tasks:** pick a free daily source per series (GIFT Nifty, S&P 500, Nasdaq, USDINR, Brent),
  store the raw responses, and write a daily table under the lake.
- **Done when:** the table is filled forward daily with no look-ahead (each row's source
  timestamp is before 09:15 IST).

### Phase 2 — The test
- **Tasks:** one run of the Phase 0 test; the result is recorded as informative, adopted or
  killed.

## Risks

- Look-ahead: a daily close stamped with its calendar date can be after the Indian open.
- Free sources vanish or restate; the raw archive is the defence.

## Open questions

- Is there a source the owner already trusts for GIFT Nifty?
- Which 09:17 strategies is this meant to help, and against which comparator?

## Log

- 2026-10-14 — created from the data-gap discussion; stock spot 1-minute bars, the third idea
  listed there, are already in [BL-038](BL-038-monthly-expiry-stock-options-collection.md)
  (Phase 1 collects each stock's spot), so no separate item.
- 2026-10-14 — **Dropped** by the owner. The 09:16 pick already reads today's 09:15 India VIX
  open (`rotation/pick.py`), and by then GIFT Nifty and the overnight global moves are priced
  into the open. The gap (open vs previous close) is derivable from the NIFTY spot 1-minute
  bars already in the lake, so no new ingestion is needed. If the gap is ever worth testing, it
  is a feature test on existing data, not a collection item.
