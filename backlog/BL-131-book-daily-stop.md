# BL-131 — A daily stop of ₹6,000 to ₹12,000 on each 3-lot book (Core-298 and T1)

| | |
|---|---|
| **Priority** | P2 — the owner trades both books with real money (3 lots each) |
| **Status** | Done — informative: no level clearly changes the result; a book stop trims the worst day; ₹9k+ never binds on Core |
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
- **Done when:** the Log has the read-out for both books, both windows and every registered level.

## Log

- 2026-10-18 — Created; Phase 0 registered before any run (owner chose the levels and per-book stops).
- 2026-10-18 — Amendment 1 committed before any result was read: levels 6k–9k added at the owner's request.
- 2026-10-18 — **Run as registered with Amendment 1** (`research/bl131/book_stop.py`; `book_stop_2026-10-18.json`).
  2,151 pick-days replayed minute by minute; every replayed path ended at the stored gross (none left out). Gross per
  3-lot book, one lot per pick. Change = with stop − no stop, per day, 90 % interval.

  **Core-298 book** (no stop: two years +1,216/day, drawdown −35,457, worst day −10,532; last year +1,393, −31,486, −9,919)

  | Stop | Two years: fired, change (90 %), drawdown, worst day | Last year: fired, change (90 %), drawdown, worst day |
  |---|---|---|
  | ₹6k | 57 d, +16 [−50, +81], −40,516, −8,258 | 24 d, +24 [−30, +80], −30,922, −8,258 |
  | ₹7k | 38 d, +6 [−47, +56], −44,496, −8,721 | 12 d, **+37 [+10, +65]**, −29,956, −8,721 |
  | ₹8k | 22 d, +3 [−30, +31], −41,289, −9,040 | 7 d, +13 [−2, +31], −30,858, −8,843 |
  | ₹9k / ₹10k / ₹12k | 6 / 1 / 0 d, 0 (no change) | 2 / 0 / 0 d, 0 |

  **T1 book** (no stop: two years +1,885/day, drawdown −23,300, worst day −13,809; last year +2,100, −23,300, −13,809)

  | Stop | Two years: fired, change (90 %), drawdown, worst day | Last year: fired, change (90 %), drawdown, worst day |
  |---|---|---|
  | ₹6k | 60 d, −72 [−187, +39], −27,137, −8,752 | 31 d, −116 [−277, +38], −27,137, −8,752 |
  | ₹7k | 39 d, −12 [−85, +54], −27,098, −9,005 | 18 d, −36 [−139, +61], −27,098, −8,990 |
  | ₹8k | 30 d, −5 [−57, +44], −23,492, −9,040 | 11 d, +18 [−54, +86], −21,049, −8,990 |
  | ₹9k | 18 d, −2 [−37, +33], −22,057, −9,919 | 7 d, +20 [−23, +63], −21,741, −9,919 |
  | ₹10k | 5 d, +6 [−3, +19], −23,300, −13,809 | 3 d, +4 [+0, +9], −23,300, −13,809 |
  | ₹12k | 2 d, +2 [+0, +6], −23,300, −13,809 | 1 d, 0 |

  **Both books, each with its own stop** (no stop: two years +3,102/day, drawdown −44,957, worst day −22,802): ₹6k
  +3,047 / −45,193 / −14,820; ₹7k +3,096 / −43,753 / −17,248; ₹8k +3,099 / −46,777 / −18,080; ₹9k +3,100 / −48,460 /
  −19,838; ₹10k and ₹12k as no stop (worst day −22,802).

  **Read under the rule.** One cell of 24 has its interval above zero (Core, last year, ₹7k), which six levels read on
  the same days can produce by chance (Amendment 1's caveat): not positive. "Protective" (shallower drawdown and worst
  day) holds only for T1 at ₹9k over two years and ₹8k / ₹9k on the last year, and Core at ₹6k / ₹7k on the last year.
  **What it says:** (1) on Core a book stop of ₹9k or more never changes anything: each Core pick already stops at
  ₹2,500–3,000, so three picks cap the book near −₹9k (the stop "fires" on days the book is already flat at that loss).
  (2) A book stop does not add money in either book; tight stops (₹6k–7k) cost T1 money (they close days that
  recover: at ₹6k, 33 such days −₹95k against 27 days saved +₹64k). (3) What a stop reliably does is trim the single
  worst day: T1's −13.8k becomes about −9k at ₹6k–9k, and both books' −22.8k becomes −14.8k to −19.8k; the maximum
  drawdown, a run of ordinary losing days, mostly does not improve. Weaknesses: in-sample, gross (a stop can only
  lower charges), T1's window overlaps its selection year, fills at the stop minute's close (no slippage).
- 2026-10-18 — **Review corrections (Opus, PR #252; no number changes).** The reading above is superseded where it
  differs:
  - "Protective" also holds for **Core ₹8k on the last year** (drawdown −30,858 vs −31,486, worst day −8,843 vs
    −9,919), which the list above left out.
  - The two directions are read the same way: **no level clearly adds or costs money** in either book. Every Core
    point estimate at ₹6k–8k is ≥ 0 and T1's at ₹6k–7k are < 0, but every interval except one (Core, last year, ₹7k,
    chance-level) includes zero, so "tight stops cost T1" is a tendency, not a finding.
  - Mechanism: Core's per-pick stops are ₹2,000 (48 variants), ₹2,500 (150) and ₹3,000 (100), and one-lot losses
    overshoot them to about −₹4,700, so three picks cap the book near −₹9k to −₹10.5k; that is why ₹9k+ never changes
    Core's result.
  - "Two years" means 2025-01-10 → 2026-10-16 (about 21 months), as registered.
  - Both books, last year (244 days; no stop +3,493/day, drawdown −44,957, worst day −22,802): ₹6k +3,401 / −40,451 /
    −14,820; ₹7k +3,494 / −43,753 / −17,248; ₹8k +3,524 / −46,777 / −17,248; ₹9k +3,513 / −48,460 / −19,838; ₹10k
    +3,497 and ₹12k +3,493 / −44,957 / −22,802.
- 2026-10-18 — **Owner's combination, descriptive (after the results were read):** Core ₹6k + T1 ₹9k on the 6-lot book.
  Two years: +3,117/day vs +3,102, change +15 [−69, +101], max drawdown −47,898 vs −44,957, worst five days −17.5k to
  −16.0k vs −22.8k to −18.4k. Last year: +3,537 vs +3,493, +44 [−27, +118]. Chosen after seeing the table, so this is
  a description of that choice, not a test of it.
- Code note: `research/bl131/results/paths.pkl` is keyed by (day, variant) only; delete it before re-running after any
  change to a strategy file, the data or the engine.
