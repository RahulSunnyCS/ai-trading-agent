# BL-131 — A daily stop of ₹10,000 or ₹12,000 on each 3-lot book (Core-298 and T1)

| | |
|---|---|
| **Priority** | P2 — the owner trades both books with real money (3 lots each) |
| **Status** | In progress |
| **Type** | research |
| **Area** | options |
| **Created** | 2026-10-18 |
| **Depends on** | BL-058 (lists, results store), BL-095 (portfolio stop replay), BL-113 (T1) |
| **TODO.md row** | — (research only) |

## Context

Owner (2026-10-18): "I am currently trading 3 lot Core 298 and 3 lot T1"; "what if I put 3 core and 3 T1 10k SL or
what if 12k sl", "daily", "for T1 -> 10, 12k sl", "for core 10,12k SL". So each list's 3-lot book (one lot on each
of Adaptive's three core picks) gets its own daily portfolio stop: when the book's combined mark-to-market reaches
−₹10,000 (or −₹12,000) everything in that book closes and nothing else in it enters (BL-095's rule).

## Goal

Say what each stop would have done to each book and to the two together, against no stop. Nothing live changes.

## Plan

### Phase 0 — Pre-register (committed before any run)

- **Books:** each day, Adaptive list C (registered weights and lookbacks, no expiry rule) replayed from the stored
  results (`daylog.reconstruction(...).picks(d)["C"]`, as BL-129/130) over Core-298, and over T1 (Core-298 + the 223
  T1 variants); core picks only, one lot each (a Buy add-on left out). Two books: Core (3 lots) and T1 (3 lots).
- **Stops (owner's two levels, no search):** none, −₹10,000, −₹12,000 per book per day, no trailing. Applied by
  `rotation.portfolio.apply_book` to each pick's one-lot minute path, replayed with the nightly update's own engine
  call (`portfolio._replay`, the strategy file, `SIZING_DATE`). Each replayed path's end must equal the stored gross
  (checked; a day that does not match is reported and left out).
- **Windows:** 2025-01-10 → 2026-10-16 and the last year 2025-10-09 → 2026-10-16.
- **Read-out per book, window and level:** days the stop fired; per-day stop − none (gross) with a two-sided 90 %
  circular block bootstrap (5-day blocks, 2,000 resamples, seed 20261023); totals; max drawdown and worst day of the
  book with and without; the days the stop cut a book that ended better than the stop level ("cost") and the days
  it closed a book that ended worse ("saved"), with their sums. The two books together (6 lots, each with its own
  stop at the same level) as a descriptive line.
- **Charges:** gross throughout (the replayed paths carry no charges); a stopped book places no further orders, so
  charges with a stop are at most those without. Stated with the result.
- **Reading:** "positive" for a level = its interval above zero; "protective" = a shallower max drawdown and worst
  day than no stop. Descriptive, in-sample (days read by BL-115 and others; T1's two-year window overlaps its
  selection year). Either allows an owner decision; it changes no list.
- **Look-ahead check:** picks for day d come from results before d; the stop acts on the day's minute paths in time
  order only (the first minute at or below the level).
- **Will not run:** other levels, trailing or profit locks, a stop on the combined 6-lot book.

### Phase 0 — Amendment 1 (2026-10-18, before any result was read)

- Owner (2026-10-18), while the first run was replaying paths and before any figure had been printed or read: "then
  lets look from 6k, 7k, 8k, 9k also in T1 and core". Levels become **₹6,000, ₹7,000, ₹8,000, ₹9,000, ₹10,000 and
  ₹12,000** per book per day; everything else as above. The "Will not run: other levels" line is superseded for these
  four levels only.
- **Selection caveat, registered now:** with six levels read on the same days, the best-looking one is partly picked
  by chance. Every level is reported; none is called "best" from these in-sample figures. A level the owner wants to
  use is a judgement on the whole table (cost, protection, how often it fires), to be checked forward.

### Phase 1 — Run

- **Tasks:** `packages/option-backtesting/research/bl131/book_stop.py`; results JSON committed; Log entry.
- **Done when:** the Log has the read-out for both books, both windows and both levels.

## Log

- 2026-10-18 — Created; Phase 0 registered before any run (owner chose the levels and per-book stops).
- 2026-10-18 — Amendment 1 committed before any result was read: levels 6k–9k added at the owner's request.
