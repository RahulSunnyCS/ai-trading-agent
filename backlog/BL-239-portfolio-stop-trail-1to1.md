# BL-239 — Portfolio stop with a stepped 1:1 trail (every ₹3,000 of profit moves the stop up ₹3,000)

| | |
|---|---|
| **Priority** | P2 — one pre-registered test, no live change |
| **Status** | In progress |
| **Type** | research |
| **Area** | options |
| **Created** | 2026-11-20 |
| **Depends on** | BL-208 (tested trail 3:2, stepped 3:2 and a continuous 1:1; not the stepped 1:1), BL-194, BL-238 (its fresh picks) |
| **TODO.md row** | — |

## Context

The owner (2026-11-20) asks about a trailing portfolio SL on T1's book: for every ₹3,000 of profit the
stop moves up ₹3,000. BL-208 read a continuous 1:1 trail as a neighbour (−₹70 a lot-day [−221, +58] on the
Dir ×2 book, −₹44 on the 3-lot book, deeper drawdown) and the stepped form (`Trail("sl", x=3000, y=3000)`) was
never run. Findings page: `research/options/common/portfolio-stop.md`.

## Goal

One answer, read once: does the stepped 1:1 trail on top of today's book stop beat today's stop on either
T1 book, without a deeper drawdown.

## Out of scope

Any live change; a trail on each strategy's own MTM SL (a different stop, untested); other steps or ratios as
candidates; a break-even lock; other windows.

## Plan

### Phase 0 — Pre-register (committed before any run, 2026-11-20)

- **Picks:** T1 list C from the BL-238 from-scratch ranking (`research/bl238/picks_by_day.csv`: fresh results only,
  expiry rule from 2026-10-19, SL150% cap from 2026-10-30), core picks and any Buy add-on as listed. This avoids
  the stale stored results of 6 and 18 Nov that BL-238 found.
- **Books, read apart (Settings v10, as BL-208):** **Dir ×2** (`live_lots.lots_for_day`; base stop ₹9,000, plus the
  doubled Dir's own MTM SL on 4-lot days) and **3 lots** (one lot per pick; base stop ₹9,000).
- **Replay:** `portfolio.one_lot_path` from the lake (a path cache keyed on the day's files is a fingerprint, not a
  result), `portfolio.apply_book(members, stop, trail)`, fills at the minute close the level is crossed.
- **Arms (on top of the day's base stop S):**
  - **base**: S alone (comparator).
  - **trail 1:1 stepped (owner, the only adoptable arm)**: `Trail("sl", x=3000, y=3000)`.
  - Neighbours, descriptive only: stepped 3:2 (`x=3000, y=2000`), stepped 3:1 (`x=3000, y=1000`), continuous 1:1.
- **Money:** net = gross − brokerage (2 orders × stored `n_trades` × ₹20 × 1.18 per pick, as BL-194/208). Primary at 0%
  slippage; the 0.5% reading (the fixed method: paths kept, fills moved against the trade) is shown beside, a check not
  a second test.
- **Windows:** all = 2025-01-10 → 2026-11-19; last year = 2025-11-20 → 2026-11-19.
- **Measures per book, arm, window:** net per lot-day; change vs base per day with a 90% circular block bootstrap (5-day
  blocks, 2,000 resamples, seed 20261120); deepest drawdown; worst day; mean of the worst 5% of days; days the arm
  fired before the base stop, the sum given up and saved.
- **Pass rule (per book, read once):** the owner arm beats base only if (1) its change vs base has a 90% interval wholly
  above zero in BOTH windows at 0% slippage, and (2) its deepest drawdown over all days is no deeper than base's.
  Two books, one adoptable arm: a single interval above zero in one window does not count. Otherwise killed for
  that book; the choice then is protection against cost, the owner's judgement, not a finding.
- **Red-team:** look-ahead: day d's picks use only results before d (BL-238 asserts it); `best` and the level use minute
  closes up to the current minute. Minute closes understate the peak (a live trail ratchets sooner and fires earlier
  than here) and a live stop fills past its level (BL-066: 7–26%): both make a live trail look worse than this. The
  picks' pool is in-sample for T1's settings (BL-238), and the window was read before (BL-208); exploratory in the
  sense that no hold-out exists, and the forward days (from 2026-10-19) are too few to decide.
- **Will not run:** other steps or ratios as candidates, a trail on each strategy's own MTM SL, a lock, a second pass.
  Each needs `override: <reason>` in the Log first.

### Phase 1 — Script
- `packages/option-backtesting/research/bl239/trail.py`; writes its figures beside itself.

### Phase 2 — Run and record
- Run once; record result and verdict here, in `INDEX.md` and `research/options/common/portfolio-stop.md`.

## Log

- 2026-11-20 — created from the owner's question; Phase 0 registered before any run.
