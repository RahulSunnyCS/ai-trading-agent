# BL-241 — Portfolio stop variants: trail, lock, lock-and-trail (33 arms), fit then confirm

| | |
|---|---|
| **Priority** | P2 — a registered sweep, no live change |
| **Status** | In progress |
| **Type** | research |
| **Area** | options |
| **Created** | 2026-11-20 |
| **Depends on** | BL-208, BL-239 (the stepped 1:1 trail cut the deepest drawdown by about a third at no clear cost), BL-238 |
| **TODO.md row** | — |

## Context

The owner (2026-11-20): a shallower drawdown is itself a good thing, so try more portfolio-stop forms on T1's
book: a trail (every ₹1,000 of profit moves the stop ₹500, and others), a lock (at +₹5,000 lock ₹0 or ₹1), and a
lock-and-trail (lock, then keep trailing). And can the deploy side do it?

**Platform support (read from `docs/algotest-execution.md`, BL-172):** the Quantiply clientwise "Stoploss & Target"
dialog posts `POST /brokers/<id>/config` with `stoploss`, `target` and, when chosen, one of `trailingStoploss`,
`lockProfit`, `trailProfit` or `lockTrailProfit` plus `trailingInterval`: the same four families. The tool has never
sent that call and what its numbers mean (step, trail-by, per day) is not captured, so nothing here is deployable
until a manual save is read back. AlgoTest has no portfolio-wide stop. Replay semantics are `portfolio.Trail`.

## Goal

Which form and numbers, if any, give a clearly shallower drawdown at a small, bounded cost in return, confirmed on
days the choice never saw.

## Out of scope

Any live change or deploy call; a per-strategy MTM SL trail; a different base stop; other books; a second pass.

## Plan

### Phase 0 — Pre-register (committed before any run, 2026-11-20)

- **Picks, books, replay, money:** as BL-239 (BL-238 fresh picks; Dir ×2 and 3-lot books read apart; base stop ₹9,000,
  plus the doubled Dir's own MTM SL on 4-lot days; `portfolio.one_lot_path` / `apply_book`; net of brokerage). Primary at
  0% slippage, the 0.5% reading (fixed method) beside, a check not a test.
- **Arms: 33 plus the base, fixed now, K = 33 comparisons.** Each on top of the day's base stop:
  - **Trail** `sl:X,Y` (every X of profit moves the stop up Y), X ∈ {1,000, 2,000, 3,000, 5,000} × Y/X ∈ {¼, ½, 1}: 12 arms
    (the owner's "every ₹1,000, ₹500" is 1000:500).
  - **Lock** `lock:A,B` (once profit reaches A, the stop is at least B), A ∈ {3,000, 5,000, 8,000} × B ∈ {0, 1,000, 2,500}: 9 arms
    (B = ₹1 equals B = 0 within a rupee and is not a separate arm).
  - **Lock and trail** `locktrail:A,B,X,Y` (at A lock B, then every X above A moves it up Y), A ∈ {3,000, 5,000} × B ∈ {0, 1,000}
    × (X,Y) ∈ {(1,000, 500), (2,000, 1,000), (3,000, 1,500)}: 12 arms.
- **Windows:** **F** (fit) = 2025-01-10 → 2025-10-08; **K** (confirm) = 2025-10-09 → 2026-11-19. K is read once, after F.
- **Selection on F, per book, by a fixed rule:** keep the arms whose mean change vs base is at least −₹25 per lot-day (the cost
  bound), rank them by how much shallower their deepest drawdown on F is than base's, and advance the **top three** to K.
  An arm that is deeper than base on F is never advanced. If fewer than three qualify, fewer advance.
- **Pass rule on K (per advanced arm, per book, read once):** all three: (1) mean change vs base at least −₹25 per lot-day;
  (2) deepest drawdown on K at least 15% shallower than base's on K; (3) the mean of the worst 5% of days no worse than base's.
  An arm passing on a book is a candidate for that book only; six comparisons (3 per book) are read, and "one of three"
  is optimistic by construction, so a pass is reported with the winner's-curse caveat.
- **Descriptive, not a test:** the full 33-arm table on F, on K and on all days, per book, with the 90% circular block
  bootstrap (5-day blocks, 2,000 resamples, seed 20261120) of the change vs base.
- **Red-team:** look-ahead: the picks use only earlier results (BL-238); `best` and the level use minute closes up to the
  current minute. Minute closes understate the peak and live stops fill past their level (BL-066), both flattering the
  replay's cost of a trail the other way, so live results will read worse. Data snooping: 33 arms, the F-then-K split is the
  guard; K is not virgin (BL-208 and BL-239 read the same days for other trail arms, never these) and the T1 pool is
  in-sample for 2024-10-09 → 2025-10-08, which is F. A drawdown on a 13-month K rests on one or two episodes (the Oct–Nov 2026
  fall dominates it): the 15% rule is a screen, not a measurement.
- **Will not run:** other arms, other thresholds or windows, a per-strategy MTM SL trail, a re-fit on K, a second pass.
  Each needs `override: <reason>` in the Log first.

### Phase 1 — Script
- `packages/option-backtesting/research/bl241/sweep.py` with stages `F` and `K` (K refuses a second read).

### Phase 2 — Run and record
- Run F, write the selected arms, run K once; record both here, in `INDEX.md` and `research/options/common/portfolio-stop.md`.

## Log

- 2026-11-20 — created from the owner's request; Phase 0 registered before any run.
