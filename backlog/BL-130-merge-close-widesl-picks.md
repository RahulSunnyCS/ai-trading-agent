# BL-130 — Adaptive: merge two Widesl picks entered within 30 minutes into one two-lot entry

| | |
|---|---|
| **Priority** | P3 — owner's idea; fewer orders and less brokerage if it holds |
| **Status** | In progress |
| **Type** | research |
| **Area** | options |
| **Created** | 2026-10-18 |
| **Depends on** | BL-058 (lists, results store), BL-113 (T1), BL-129 (same replay; rank 1 vs rank 2) |
| **TODO.md row** | — (research only) |

## Context

Owner (2026-10-18): some days Adaptive picks two Widesl only minutes apart (for example 11:02 and 11:17); "what do you
think of combining if it is a 30 minute gap?". Before the run Claude counted (picks only, no returns compared): on
66 % of days (Core-298) and 62 % (T1), 2025-01 → 2026-10, two same-index Widesl picks were within 30 minutes; 110 /
118 of those pairs were the identical strategy at two times; their day results correlate 0.80 / 0.71 and differ by
₹890 / ₹1,372 on an average day (a description of how alike they are, not a comparison of books). Owner: "Yes" to the
test below.

## Goal

Say whether merging such pairs into one two-lot entry at the earlier time gives a better book after the brokerage it
saves. Nothing live changes.

## Plan

### Phase 0 — Pre-register (committed before any run)

- **Picks:** Adaptive list C (registered weights and lookbacks, no expiry rule) replayed day by day over Core-298 and
  over T1 (Core-298 + the 223 T1 variants), as in BL-129; core picks only (a Buy add-on is left out of every book),
  one lot per pick, three lots a day.
- **Books:** A = as picked. M1 = identical strategies merged: the Widesl picks sorted by entry time; a pick on the same
  index, the same strategy apart from its time, and within 30 minutes (inclusive) of the earliest unmerged pick before
  it (the anchor) becomes a second lot of that anchor; otherwise it becomes a new anchor. M2 = the same with any two
  Widesl picks on the same index (different strategies allowed). The Dir pick is never merged.
- **Charges:** gross per lot from the stored results; each book pays brokerage of 2 orders × the stored `n_trades` ×
  ₹20 × 1.18 GST per entry it places (a two-lot entry pays once). Turnover charges (STT, exchange, stamp) are taken
  as equal in all books, an approximation stated with the result.
- **Windows:** 2025-01-10 → 2026-10-16 and the last year 2025-10-09 → 2026-10-16.
- **Read-out per universe, window and merge book:** days affected; per-day M − A net (gross change minus the
  brokerage difference) with a two-sided 90 % circular block bootstrap over all days (5-day blocks, 2,000 resamples,
  seed 20261022); the net max drawdown and worst day of A and M; the same in gross.
- **Reading:** "positive" = the net M − A interval above zero and M's net drawdown no deeper than A's. Descriptive,
  in-sample (days read by BL-115, BL-129 and others); a positive reading allows an owner decision or a forward-only
  track, not a change to the live list.
- **Look-ahead check:** the replay ranks day d on results before d only; the merge uses only that day's picks.
- **Will not run:** other gaps than 30 minutes, keeping the later time or the higher-ranked pick, merging Dir picks.

### Phase 1 — Run

- **Tasks:** `packages/option-backtesting/research/bl130/merge_close.py`; results JSON committed; Log entry.
- **Done when:** the Log has the read-out for both universes, both windows and both merge books.

## Log

- 2026-10-18 — Created; Phase 0 registered before any return of the books was compared (pick counts above only).
