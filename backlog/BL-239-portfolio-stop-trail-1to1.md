# BL-239 — Portfolio stop with a stepped 1:1 trail (every ₹3,000 of profit moves the stop up ₹3,000)

| | |
|---|---|
| **Priority** | P2 — one pre-registered test, no live change |
| **Status** | Done — killed on both books (interval includes zero); the trail cuts the deepest drawdown by about a third at no clear cost |
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

## Result (2026-11-20)

Run once as registered: 450 days (2025-01-10 → 2026-11-19; seven days 16-24 Sep 2026 skipped, a stored trade count
missing), net of brokerage, one lot a pick, 0% slippage primary. Per lot-day, change of the stepped 1:1 trail vs the
₹9k book stop alone, with the 90% block-bootstrap interval:

| Book | Window | Base ₹/day | Trail 1:1 stepped vs base | Deepest drawdown base → trail |
|---|---|---|---|---|
| Dir ×2 | all (450 d) | +1,766 | −16 [−115, +81] | ₹51,428 → ₹36,433 (−29%) |
| Dir ×2 | last year (239 d) | +2,011 | −76 [−242, +70] | |
| 3 lots | all | +1,429 | +33 [−41, +110] | ₹37,565 → ₹25,530 (−32%) |
| 3 lots | last year | +1,574 | +10 [−95, +102] | |

**Verdict by the registered rule: killed on both books.** Every interval includes zero, so the trail does not beat
the stop on return. It was not asked to: the second half of the rule (drawdown no deeper) holds easily.

Neighbours (descriptive): stepped 3:2 −4 / +3 a day, stepped 3:1 −3 / −3, continuous 1:1 −44 / +8, with
drawdown cut 18% / 11% (Dir ×2), 19% / 10% (3 lots) for 3:2 / 3:1. At 0.5% slippage (the fixed method): trail 1:1
stepped +1 [−86, +93] (Dir ×2) and +47 [−13, +114] (3 lots) over all days, −78 and −1 over the last year; the stepped
3:1 reads +16 [−3, +37] and +16 [+1, +35] all days and +22 [+0, +51] and +17 [+0, +42] last year: the only arm whose lower bound reaches zero, a neighbour that cannot be adopted from this item.

Reading: the stepped 1:1 trail fires early on 26 days (Dir ×2) and 23 days (3 lots) of 450. It gave up
₹52.9k on 12 of them and saved ₹45.5k on 14 (Dir ×2); ₹28.1k given up on 9 and ₹43.1k saved on 14 (3 lots). The
deepest drawdown falls by about a third because a few bad runs are cut earlier. The cost or gain per day is within
noise either way, so this is protection bought at an unknown price, the owner's call, not a finding. Caveats as
registered: minute closes understate the peak, a live stop fills past its level, the pool and window are in-sample.

## Log

- 2026-11-20 — created from the owner's question; Phase 0 registered before any run.
- 2026-11-20 — run once; killed on both books by the registered rule (intervals include zero); drawdown −29% / −32% at no clear cost.
