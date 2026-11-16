# BL-230 — Re-score the options-overlay record after the PR #450–#454 review fixes

| | |
|---|---|
| **Priority** | P2 — the Momentum finish (BL-010, BL-001, BL-024, BL-025) comes first; this only corrects a research record |
| **Status** | Planned |
| **Type** | research |
| **Area** | momentum / options |
| **Created** | 2026-11-16 |
| **Depends on** | [BL-226](BL-226-fno-momentum-stock-options.md), [BL-228](BL-228-fno-falling-stock-puts.md), [BL-229](BL-229-options-overlay-sweep.md), [BL-227](BL-227-options-overlay-backtest.md); the TradingData lake (the Mac) |
| **TODO.md row** | — |

## Context

The code reviews of PRs #450–#454 (2026-11-16) found bugs that change recorded numbers, and the cloud
session that fixed them had no TradingData lake to re-run on. The code is fixed and tested; the results
below were merged marked "not re-scored" and need running on the Mac. No new rule is chosen here: every
re-run uses the item's own registered rule and grid.

## Goal

Each recorded result below is either re-run under the fixed code and its figures replaced (the verdict
confirmed or changed), or left marked void with the reason. No result stays "not re-scored".

## Out of scope

New strategies, new grids, a second look at hold-out or confirmation data an item has already read.

## Plan

### Phase 1 — Re-score (the Mac)
- **BL-226 (killed):** re-run `scripts/bl226_options_book.py` for the nine call books with the F&O ban-period
  rule now applied (`run_book(..., banned=...)`; counted under `banned`). Run the registered checks the
  record skipped, or record each as not run: the cut-off-copy look-ahead test of the stock sweep, deflated
  Sharpe and PBO beside the Phase 2 ranking, the Phase 3 fill check against the vendor's 1-minute data
  (200 entries and exits), and the split/bonus adjustment check of every F&O stock's ranking series. Phase 4
  (puts) was not run: its multi-sleeve crash is fixed, but its gate (a passing call book) is unchanged.
- **BL-228 (killed at learning):** re-run `learn` (its counts now stop at the learning end), and run the
  two registered extras it left out: Phase 0's market-switch book (Trio ATM calls above the 200-session
  average, these puts below) beside Trio ATM alone, and Phase 0b's same-top-N-stocks calls alone (one
  lot, ATM).
- **BL-229 (round 1):** re-run round 1 under a new sweep name with the same frozen grid and selection rule,
  on the fixed engine (exposure sizing is a share of the leg's weekly total; hold divides by new plus kept
  contracts; a held contract that does not continue is closed with exit costs; the refill trial no longer
  touches the hold state; positions of different sleeves no longer share an id). The old round's "hold
  helps most" and "exposure halves the drawdown" findings stay marked void until it does.
- **BL-227 (parity):** the overlay now enters a favourite's calls one rebalance day after its signal
  (`signal_delay >= 1`); re-read the BL-226 parity figure it was checked against.
- **Deliverables:** the item Results and `research/momentum/common/options-overlay.md` rows updated in the
  same commit; the verdict stated; `INDEX.md` and `TODO.md` in step.
- **Done when:** no row of that findings page says "not re-scored" or "void".

## Result

## Risks

- A re-run can change a verdict (BL-229 most of all). If it does, the item that carried the old verdict
  gets a dated Log line, not an edit of its pre-registration.

## Open questions

None.

## Log

- 2026-11-16 — Opened by the PR #450–#454 reviews (see each PR's summary comment).
