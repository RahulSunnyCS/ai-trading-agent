# BL-130 — Adaptive: merge two Widesl picks entered within 30 minutes into one two-lot entry

| | |
|---|---|
| **Priority** | P3 — owner's idea; fewer orders and less brokerage if it holds |
| **Status** | Done — informative, not adopted: Core-298 no effect; T1 gains from the earlier entry, one cell passes, partly in T1's selection year |
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
- 2026-10-18 — **Run as registered** (`research/bl130/merge_close.py`; `merge_close_2026-10-18.json`). One lot per
  pick, core only; net = gross minus brokerage (turnover charges taken as equal). Descriptive, in-sample.

  | Universe, window | A net / day (drawdown) | M1 identical: days merged, M − A net (90 %), gross part, drawdown | M2 any Widesl: days merged, M − A net (90 %), gross part, drawdown |
  |---|---|---|---|
  | Core-298, 2025-01-10 → 2026-10-16 (428 d) | +903 (−42,326) | 104 d, +6 [−43, +57], gross −18, −44,633 | 282 d, −3 [−122, +120], gross −75, −50,035 |
  | Core-298, last year (244 d) | +1,079 (−35,929) | 60 d, +27 [−24, +77], gross +3, −35,929 | 152 d, +80 [−51, +222], gross +12, −42,888 |
  | T1, 2025-01-10 → 2026-10-16 (428 d) | +1,529 (−25,887) | 109 d, **+107 [+30, +186]**, gross +79, −25,659 | 264 d, **+290 [+141, +437]**, gross +218, −28,303 |
  | T1, last year (244 d) | +1,746 (−25,672) | 68 d, +90 [−27, +223], gross +60, −25,659 | 142 d, **+217 [+50, +403]**, gross +151, −27,430 |

  Brokerage saved: about ₹23–30 a day for M1 and ₹66–72 for M2 (per one-lot book).

  **Read under the registered rule.** Positive in one cell only: **T1, two years, M1** (interval above zero, drawdown
  no deeper). T1 M2 has its interval above zero in both windows but a deeper drawdown, so not positive; every
  Core-298 cell is inconclusive. **What it says:** on Core-298 merging changes nothing beyond the brokerage, which is
  within noise. On T1 the gain comes mostly from the gross part, not the charges: the earlier of two close Widesl
  picks earned more than the later one, so taking both lots at the earlier time added return, with somewhat bigger
  swings for M2. **Weaknesses:** in-sample; T1's two-year window overlaps the year its settings were chosen on
  (2024-10-09 → 2025-10-08), and on the last year alone M1 is inconclusive; one gap (30 minutes) and one rule (keep
  the earlier) were tested; turnover charges approximated as equal; one-lot framing (the live book trades two lots a
  strategy, which doubles the gross part but not the brokerage saving). Nothing adopted; a forward-only check on the
  T1 track would be the next step if wanted.
- 2026-10-18 — **Review notes (Opus, PR #251; no number changes, the reading stands).**
  - The JSON's per-cell "reading" now applies both registered conditions (interval and drawdown); the interval alone
    is `interval_reading`. Regenerated with identical numbers; only T1 two-years M1 reads positive.
  - **Three lots at one time:** the anchor rule lets a third pick join the same anchor. M1: 2 Core days and 4 T1 days;
    M2: 46 Core days and 43 T1 days in two years (about 10 %), part of M2's deeper drawdown.
  - **The T1 gain sits partly in T1's selection year** (split of the two-year window at 2025-10-09; the part before is
    inside 2024-10-09 → 2025-10-08):

    | T1 | before 2025-10-09 (184 days) | from 2025-10-09 (244 days) |
    |---|---|---|
    | M1, M − A net per day | +130 [+45, +217] | +90 [−27, +223] |
    | M2, M − A net per day | +387 [+132, +650] | +217 [+50, +403] |
    | Earlier minus later pick, gross per pair (M1) | +446 (43 pairs) | +209 (70 pairs) |

    On Core-298 the same per-pair figure is −189 before and +11 after; 90 of the 109 T1 M1 merges are T1's own
    variants. So the effect belongs to the T1 variants and roughly halves outside their selection year, where M1 is
    inconclusive: treat it as at least partly an artefact of that selection.
  - From 2026-10-19 the T1 track applies the BL-122 expiry rule, so a forward check would test a slightly different
    picker from this replay.
