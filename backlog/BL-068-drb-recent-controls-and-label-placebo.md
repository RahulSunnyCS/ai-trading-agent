# BL-068 — Is DRB's "recent return" edge real? Lookback ladder, lag, reverse, and a label placebo

| | |
|---|---|
| **Priority** | P2 — options research; follows BL-067 |
| **Status** | Done — recent return is momentum and stable; the fit criteria are not shown to be real |
| **Type** | research |
| **Area** | options |
| **Created** | 2026-10-10 |
| **Depends on** | BL-067 (weight map), BL-065 (DRB-6W3L2) |
| **TODO.md row** | — |

## Context

BL-067's 16-row weight map said one thing clearly: the recent-return criterion carries DRB's edge
(without it net falls 59%), and weekday / days-to-expiry / VIX-band fit are dead weight alone. The owner
(2026-10-10 chat) asked what else to run so that this stands up rather than being a preference read off
one map. Three groups, all on the same already-seen year, each pre-registered here with its read-out.

## Goal

Answers to: (1) is "recent" short-term momentum or long-run variant quality; (2) do the three fit
criteria beat scrambled labels; (3) does the recent-vs-no-recent gap hold in both halves of the year,
and what does a block bootstrap and the CSCV/PBO overfit guard say about the 16 BL-067 rows.

## Out of scope

New criteria (family-pooled recent, overnight gap, longer fit lookbacks, a diversification rule) — a
fourth group, added as a dated block only if the owner asks. Unseen years (2022–2025). Any change to the
live strategies.

## Plan

### Phase 0 — Pre-register
Everything is DRB-6W3L2 as BL-065 (248 variants, 3 × 2 lots, at least 2 Widesl, Buy add-on, window
2025-09-01 → 2026-10-08, 202 selection days from 2025-12-03), weights 33/25/25/17 unless stated. Gross
before charges: BL-067's charges were ₹80.2–82.7k on every row, so net ≈ gross − ₹81k, and the trade
re-simulation is skipped for these 31 runs. Random-pick P90 (≈ ₹2.6–2.7 lakh) is the floor for "better
than nothing".

**Group 1 — the recent criterion** (`rotate.py --basket DRB-6W3L2 ...`)
- *Lookback ladder*: recent = plain sum of the last N days, N ∈ {5, 10, 21, 42, 63, 126}
  (`--recent-window N`); the baseline's shape (2/3 × last 5 + 1/3 × the 5 before) is row 0.
- *Lag*: the baseline's recent read with the latest 5 and 10 days skipped (`--recent-lag 5|10`).
- *Reverse*: the baseline and recent-only pick the **lowest** composite (`--reverse`).
- **Read-out:** recent is *momentum* if gross falls steadily as N grows past 21 and the lag-5 run loses
  ≥ 25% of the baseline's gross; it is *quality* if N = 63 or 126 is within 10% of the best and lag-5 is
  within 10% of the baseline. The reverse runs must be below the random P50 for the signal to count as
  real; a reverse run above P50 means the ranking is not informative in that direction.

**Group 2 — label placebo**
- 20 runs of the baseline with the days' weekday, VIX band and days-to-expiry labels permuted together
  (`--shuffle-labels S`, S = 0..19; one permutation per run over every row). P&L is untouched, so the
  recent criterion is unchanged and only the three fit criteria are scrambled.
- **Read-out:** the fit criteria are *real* if the true-label baseline (₹4,30,868 gross) is above the
  95th percentile of the 20 shuffled totals (i.e. above all of them, with 20 draws); *noise* if it is
  inside the shuffled range. The shuffled runs' mean is the expected total when the three fit criteria
  contribute nothing but tie-breaking around recent; the recent-only row (₹3,15,861) is a second
  reference.

**Group 3 — stability of the BL-067 rows** (no new runs; daily picks files of BL-067)
- Halves: 2025-12-03 → 2026-04-30 and 2026-05-01 → 2026-10-08 for rows 0 (baseline), 1 (recent only),
  6 (no recent), 7 (no VIX): gross and drawdown in each half.
- Block bootstrap (5-day blocks, 2,000 resamples) of the daily difference baseline − no-recent and
  baseline − no-VIX: 90% interval of the total difference.
- CSCV / PBO (`option_backtesting.analytics.overfit`) over the 16 rows' daily P&L matrix.
- **Read-out:** the recent edge is *stable* if the baseline beats no-recent in both halves and the
  bootstrap 90% interval of the gap excludes zero. The weight map is *overfit* if PBO > 0.5.

- **Look-ahead:** unchanged (scores read only earlier rows); the shuffle moves labels across days but
  each day's scoring still reads only earlier rows.
- **Hold-out:** none (owner override, as BL-053 → BL-067). **Will not run:** other lags or windows,
  shuffling the P&L instead of the labels, more than 20 shuffles, any new criterion (fourth group needs a
  dated block).
- **Result (2026-10-10, gross, 202 selection days; baseline reproduces ₹4,30,868 / −₹68,294):**
  - **Group 1 — recent is short-term momentum, not quality.** Lookback ladder (plain sum of the last N
    days): 5 d ₹4,16,677 · 10 d ₹4,03,911 · 21 d ₹3,02,439 · 42 d ₹2,60,132 · 63 d ₹2,55,242 · 126 d
    ₹2,37,930 (steady decay; corrected 2026-10-10 in BL-069: the first run read an empty window on the
    first 63 selection days and gave ₹1,97,194; the baseline's 2/3 × 5 d + 1/3 × the 5 before shape is ₹4,30,868, the
    5-day-only version is within noise of it). Lag: skipping the latest 5 days ₹2,01,273 (−53%, drawdown
    −₹1,21,292), latest 10 days ₹2,21,923 (−48%). Both registered momentum conditions hold; neither
    quality condition does. Reverse: baseline picks the lowest composite ₹1,43,919 (drawdown −₹1,40,249)
    and recent-only reversed ₹1,23,912 (−₹1,93,986), both below the random P50 (₹1.68 / ₹1.63 lakh) —
    the ranking is informative in both directions.
  - **Group 2 — the fit criteria are not shown to be real.** 20 label shuffles (weekday / VIX band / dte
    permuted together over all days): min ₹85,455, mean ₹2,39,636, sd ₹1,07,880, max ₹4,44,293. The
    true baseline ₹4,30,868 is beaten by 1 of 20 (shuffle 7, ₹4,44,293): inside the shuffled range, so
    by the registered rule *noise*, at the boundary (95th percentile; +1.8 sd above the shuffle mean).
    5 of 20 shuffles beat recent-only (₹3,15,861). The three fit criteria are worth ₹1.15 lakh over
    recent-only in the true labels, but the bootstrap interval of that lead is [−₹41k, +₹2.82 lakh],
    P(≤ 0) = 0.12. One shuffle sd (₹1.08 lakh) is the noise yardstick for BL-069 (not the ₹1.05 lakh
    estimated before the run).
  - **Group 3 — stability.** Halves (Dec–Apr / May–Oct): baseline ₹2,28,512 / ₹2,02,356; recent-only
    ₹1,32,403 / ₹1,83,458; no-recent ₹75,698 / ₹1,50,408; no-VIX ₹1,79,164 / ₹2,56,042. Baseline beats
    no-recent in both halves. Block bootstrap (5-day blocks, 2,000 resamples): baseline − no-recent
    ₹2,04,763, 90% interval [₹62,441, ₹3,43,327], P(≤ 0) 0.006 — the recent edge is *stable*. Baseline −
    no-VIX −₹4,339, interval [−₹1,17,075, +₹1,10,745], P(≤ 0) 0.49: indistinguishable, and no-VIX
    flips between halves (worse in H1, better in H2). CSCV / PBO over the 16 BL-067 rows: **0.49** (8
    blocks, 70 splits), **0.42** (16 blocks, 12,870 splits) — below the 0.5 line but near a coin flip:
    picking the best of the 16 weightings in-sample is about as likely as not to land at or below the
    out-of-sample median.
  - **Read-across:** recent return is the one criterion with an edge that survives a lag control, a
    reverse control, a half-split and a bootstrap. Weekday / dte / VIX add ₹1.15 lakh over recent-only in
    this year but do not clear a scrambled-label placebo or the bootstrap; whether they are worth their
    complexity is open. Which of the 16 weightings is best is not reliably knowable from this year
    (PBO 0.42–0.49). Nothing adopted. Scripts: `research/bl068/run_all.py`, `analyse.py`; outputs
    `research/bl068/out/`.

## Risks

Twenty shuffles give a coarse 95th percentile; a true baseline just above the top shuffle is weak
evidence. The lookback ladder changes the recent criterion's scale, not only its window, so compare
rows by rank rather than rupees.

## Open questions

Whether to add the fourth group (family-pooled recent, overnight-gap label, 21/63-only fit lookbacks,
a same-family-within-60-minutes rule) — owner to say.

## Log

- 2026-10-10 — created; groups 1–3 registered before any run.
- 2026-10-10 — groups 1–2 (31 runs) and group 3 ran; Result above. The fourth group (new criteria) moves to BL-069.
- 2026-10-10 — 126-day row re-run after fixing a negative-index slice in `recent_score` / `skewed_fit`: ₹2,37,930 (was ₹1,97,194); the finding is unchanged.
