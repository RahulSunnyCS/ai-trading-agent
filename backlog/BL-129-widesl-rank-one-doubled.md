# BL-129 — Adaptive: does the first-ranked Widesl beat the second, and should it take both lots?

| | |
|---|---|
| **Priority** | P3 — owner's question; a cheaper book if it holds |
| **Status** | Done — informative, not adopted: Widesl rank 1 earned less than rank 2; doubling it lowers the book |
| **Type** | research |
| **Area** | options |
| **Created** | 2026-10-18 |
| **Depends on** | BL-058 (lists, results store), BL-113 (T1) |
| **TODO.md row** | — (research only) |

## Context

Owner (2026-10-18): each day Adaptive picks three strategies with at least two Widesl. Is the first-ranked Widesl making
more than the second? If so, what if the book were one Dir (or the third pick) and the first Widesl at two lots, so
the second Widesl's charges are saved? Asked for Core-298 and T1, over the last one and two years.

## Goal

Say, descriptively, whether Widesl rank 1 earns more than Widesl rank 2 among Adaptive's picks, and whether the
"rank 1 doubled" book earns more than the book as picked, after the brokerage it saves. Nothing live changes.

## Plan

### Phase 0 — Pre-register (committed before any run)

- **Universes and picks:** Adaptive list C (registered weights and lookbacks, no expiry rule), reconstructed day by
  day from the stored results (`daylog.reconstruction` + `pick._rank`, the replay used by BL-111/126/127), over
  Core-298 and over T1 (Core-298 + the 223 T1 track variants). Core picks only; a Buy add-on is left out of both books.
- **Ranks:** among the day's core picks, the Widesl picks (`variants.is_wide`) ordered by the day's composite (higher
  first): W1, W2 (and W3 on a three-Widesl day). The other core pick is "X" (the Dir, or W3 on a three-Widesl day).
- **Windows:** all reconstructable days 2025-01-10 → 2026-10-16 ("two years", after the 63-day warm-up), and the
  last year 2025-10-09 → 2026-10-16.
- **Q1:** per day W1 minus W2, gross per lot; mean, two-sided 90 % circular block bootstrap (5-day blocks, 2,000
  resamples, seed 20261021), share of days W1 > W2.
- **Q2 (books of three lots):** A = 1 lot each of W1, W2, X (as picked). B = 2 lots of W1 + 1 lot of X. Paired
  B minus A per day: gross = W1 − W2; net adds the brokerage B saves (W2's orders: 2 per trade × the stored
  `n_trades` × ₹20 × 1.18 GST); turnover charges (STT, exchange, stamp) are taken as equal in both books and stated
  as an approximation. Mean, the same bootstrap, max drawdown of each book's cumulative net, worst day.
- **Reading:** "positive" = the net B − A interval above zero and B's drawdown no deeper than A's. Descriptive,
  in-sample (these days were read by BL-115 and others); a positive reading only allows proposing a forward-only
  track or an owner decision with the evidence stated, not a change to the live list.
- **Look-ahead check:** the replay ranks day d on results before d only; W1/W2 come from that day's composite.
- **Will not run:** other lot splits, rank-based lots for Dir, the expiry rule, slot or day-type filters.

### Phase 1 — Run

- **Tasks:** `packages/option-backtesting/research/bl129/rank_double.py`; results JSON committed; Log entry.
- **Done when:** the Log has Q1 and Q2 for both universes and both windows, read under the rule above.

## Log

- 2026-10-18 — Created; Phase 0 registered before any run (owner's question; the windows and rules are Claude's).
- 2026-10-18 — **Run as registered** (`research/bl129/rank_double.py`; `rank_double_2026-10-18.json`). Gross per lot
  from the stored results; net B − A adds only the brokerage B saves (₹94–103 a day). Descriptive, in-sample.

  | Universe, window | Days (3-Widesl) | W1 / W2 / X mean | W1 − W2 (90 %) | W1 better | Book A / B per day | B − A net (90 %) | Max drawdown A / B |
  |---|---|---|---|---|---|---|---|
  | Core-298, 2025-01-10 → 2026-10-16 | 428 (78) | +227 / +409 / +580 | −183 [−339, −36] negative | 50 % | +1,216 / +1,034 | −89 [−245, +58] | −35,457 / −42,928 |
  | Core-298, last year | 244 (35) | +404 / +413 / +576 | −9 [−189, +177] | 50 % | +1,393 / +1,384 | +85 [−94, +271] | −31,486 / −32,987 |
  | T1, 2025-01-10 → 2026-10-16 | 428 (68) | +470 / +670 / +745 | −200 [−388, −1] negative | 47 % | +1,885 / +1,686 | −97 [−285, +101] | −23,300 / −40,583 |
  | T1, last year | 244 (37) | +478 / +805 / +817 | −327 [−569, −96] negative | 45 % | +2,100 / +1,773 | −223 [−465, +8] | −23,300 / −40,583 |

  **Read under the registered rule: not positive in any cell.** The first-ranked Widesl (highest composite) did not
  earn more than the second: on two years it earned less in both universes (interval below zero), and on the last
  year equal (Core) or less (T1). Doubling it saves about ₹100 a day of brokerage but gives up W2's result and deepens
  the drawdown (T1: −23k → −41k). The composite separates "picked" from "not picked", not the order inside the picks.
  Weaknesses: in-sample (these days were read by BL-115 and others); turnover charges assumed equal in both books;
  Buy add-on left out.
