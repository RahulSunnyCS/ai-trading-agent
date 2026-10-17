# BL-111 — Lots by rank (2-2-1-1) and by range regime: more Dir when ranges expand, more Widesl when quiet

| | |
|---|---|
| **Priority** | P2 — owner's idea; builds on BL-110; a close cousin of BL-053 (killed) |
| **Status** | Planned |
| **Type** | research |
| **Area** | options |
| **Created** | 2026-10-15 |
| **Depends on** | BL-110 (range persistence), BL-058 (the lists), BL-109 (weekday DTE) |
| **TODO.md row** | — |

## Context

Owner (2026-10-15, chat): "if there is a big range happening … we can have directional or buy, which
is better during the large-range thing. If we are having six, we can increase the directional up to
three. And when the range contracts, switch to four or five wider sells." Then: the 6 lots should be
split **2-2-1-1** (top two strategies 2 lots each, next two 1 lot each) instead of 3 strategies × 2
lots; the owner trades **3 lots on ordinary days and 6 lots on expiry days** (cash), and asked the
assistant to take the open decisions and to stage the quiet mix "four, then five".

What the repo already says:

- **What "Dir" is.** The rotation's Dir strategies are **short** ATM (or ITM1) CE + PE with a 21%
  stop per leg and one re-entry, not long options (`strategies/rotation/N_dir_*.yaml`). Widesl is a
  short wide strangle. So the premise "directional buyers gain when the range is large" does not
  apply literally; only the measured per-lot behaviour matters.
- **BL-110 (as corrected in its review).** The day range persists in both directions. Against the
  all-session average, the next day's range is about 0.14 of the baseline higher after an expanded
  session (≥ 1.25× the 20-session median) and 0.12 to 0.15 lower after a quiet one (≤ 0.80×), for
  several days. The coefficient on the previous range roughly halves once VIX is in the model
  (R² 0.17 → 0.28 in the first period, 0.12 → 0.23 in the second).
- **BL-053 (killed).** A 10:00 VIX-**move** switch between 2 Dir + 2 Buy + 2 Widesl and 4 Widesl +
  1 Dir + 1 Buy beat each fixed mix by +7.6% (needed 10%) with a worse drawdown, and most of its
  gain came from the 10:00 start. Per lot at a 10:00 entry, VIX-up days vs quiet days: Widesl ₹66
  vs ₹241, Dir ₹453 vs ₹374, Buy −₹77 vs −₹17. Those are VIX-move states, not range states.
- **BL-081 / BL-083.** No hourly state variable passed; the Dir **trigger** lead (not Dir in
  general) appears from mid-2024.
- The lists already carry a VIX-band fit (20 to 24% of the score) and a days-to-expiry fit.

## Goal

An answer to two separate questions, at the owner's real sizes:

1. **Lots by rank:** does 2-2-1-1 over the top four (6 lots), or 2-1 over the top two (3 lots),
   earn more than today's equal split?
2. **Lots by range regime:** does moving lots between Dir and Widesl by the previous session's range
   state beat the same ladder held fixed?

## Out of scope

- Any change to the live lists, weights or the journal (this recombines stored results).
- A new entry time (BL-053: a later start is a separate question).
- Buy as a lever and the Buy add-on (decision below): every arm is Dir and Widesl only.
- SENSEX (the hold-out data is NIFTY only).

## Plan

### Phase 0 — Pre-register
Committed before any run. The decisions were taken by the assistant at the owner's request
(2026-10-15) and may be overruled by the owner before a run.

- **Hypotheses.** H1: the rank ladder earns more than the equal split. H2: the range-regime switch
  earns more than the fixed ladder, than the equal split, and than the always-expanded and
  always-quiet mixes.
- **Universe.** NIFTY variants only: the 149 `N_*` variants (both periods). Dir = `is_dir`
  (including ITM1 variants), Widesl = `is_wide` (including closest-premium). The Buy add-on is
  excluded from every arm, including the baseline, which is recomputed without it (the live list's
  own basket is shown for reference only).
- **List.** Ranking = **list C (Adaptive)**, the public one. List A is reported descriptively and
  is not part of the decision. Within a kind, "#k" is the k-th highest composite of that kind on
  that day (the 09:16 ranking, no new fit). The list's minimum of 2 Widesl strategies is kept in
  every ladder (a Dir slot is swapped for the next Widesl, as `score.select` does).
- **Sizes and ladders (lots per ranked slot).**

  | Size | Equal split (baseline) | Rank ladder (H1) | Expanded regime (H2) | Quiet regime (H2) |
  |---|---|---|---|---|
  | 6 lots (expiry days) | top 3 non-Buy × 2 | top 4 × (2, 2, 1, 1) | Dir#1 ×2, Widesl#1 ×2, Dir#2 ×1, Widesl#2 ×1 | Widesl#1 ×2, Widesl#2 ×2, Dir#1 ×1, Dir#2 ×1 |
  | 3 lots (ordinary days) | top 3 non-Buy × 1 | top 2 × (2, 1) | Dir#1 ×2, Widesl#1 ×1 | Widesl#1 ×2, Dir#1 ×1 |

  Quiet-regime staging: **4 Widesl lots first** (the arm above). 5 Widesl + 1 Dir is a second arm,
  descriptive, taken as a step only after the 4-lot step has held forward.
- **Signal, known at 09:16.** `E = R_{t-1} / median(R over the 20 sessions before t-1)` from the
  previous session's NIFTY index bars (BL-110). Expanded `E ≥ 1.25`, range-bound `E ≤ 0.80`,
  otherwise normal (the fixed ladder). If the previous session is missing or excluded the day is
  normal. Thresholds are BL-110's, not tuned.
- **Expiry day.** A day on which NIFTY expires: label `dte_n = 0` on the weekday basis (BL-109).
- **The book.** The owner's real sizing as one daily series: ordinary days at 3 lots, expiry days at
  6 lots. This is the **primary endpoint** for H1 and for H2. The two day types are reported
  separately, descriptively.
- **Data and periods.**
  - *In-sample (rule fixed here):* 2025-01-10 → 2026-10-08, the live rotation store (298 variants,
    NIFTY ones used).
  - *Confirmation, not a blind hold-out:* 2022-04-05 → 2024-10-08 (P3). P3 has been read for other
    questions (BL-071, BL-075, BL-081, BL-083, and BL-110's first sub-period measured this very
    signal); what it has not seen is P&L by range state and these lot ladders. Per-variant, per-lot
    P3 results already exist for the 149 NIFTY variants (`research/bl071/results/`, the Dir ITM1
    files from `research/bl080/results/`); no engine run is needed. They are read into a separate
    research root under `research/bl111/` with a P3 day file on the **weekday** DTE basis built
    from `rotation.score` / `rotation.dte` (not from `research/bl057/rotate.py`, which counts
    calendar days). Nothing is ever written to the live append-only store.
  - *Real confirmation:* forward journal days after this item is committed (Phase 3).
- **Costs.** Net of the repo's charge model (BL-063: flat per order, as in
  `research/options/common/charges.md`); the 4-slot ladder pays for more orders per lot.
- **Look-ahead check.** The signal uses only the previous session's bars; the ranking uses only
  results before day `t`; P3 is read once, after this block is committed; the placebo uses the
  same signal series shifted, not new data.
- **Comparators.** Equal split at the same size; the fixed rank ladder; always-expanded; always-
  quiet (the BL-053 lesson: a switch must beat both fixed mixes).
- **Placebo.** The regime labels circularly shifted by every offset of at least 20 sessions
  (keeps their persistence; BL-081's design). The switch must beat the **90th percentile** of the
  shifted totals.
- **Pass / kill rule.** H1 and H2 are each judged once, on the book, on the confirmation period,
  in the same units: pass only if (a) net total of the arm is at least 10% above each comparator
  (if a comparator's total is zero or negative, the arm must be positive and exceed it by at least
  10% of its absolute value), (b) maximum drawdown no worse, (c) the 90% circular block-bootstrap
  interval (5-day blocks, 2,000 resamples, seed 20261015) of the daily difference to the
  best comparator is above zero, and (d) for H2, it also beats the placebo P90. In-sample results
  are reported but never decide. Otherwise killed. Two endpoints (H1, H2) share one rule; no
  per-size or per-day-type cell decides.
- **Will not run:** other thresholds, ladders or lists, 2-day or VIX-based signals, intraday
  signals, Buy as a lever, SENSEX, the 5-Widesl arm as a decision arm. Each needs a new dated block
  and `override: <reason>`.

### Phase 0 — Amendment 1 (2026-10-18, before any run): H3, the expiring-index-only basket

Owner request (chat, 2026-10-18): "on expiry days we will be only using the expiry things; let me
know whether this increases or decreases" our result, and how much of the current basket is
non-expiring items.

`override: owner request 2026-10-18` for the two things this block does that Phase 0 excluded:
it adds a third hypothesis, and it uses SENSEX results ("Will not run" left SENSEX out because the
P3 confirmation period is NIFTY-only). H3 therefore has **no confirmation period**: it is
exploratory, in-sample, and cannot decide anything by itself.

- **H3:** on a day an index expires, a basket drawn only from that index's variants earns at least
  as much as the unrestricted Adaptive basket (list C) of the same size.
- **Expiry day for an index:** the day its nearest weekly expiry is that day (label `0` on the
  weekday basis: `dte_n = 0` for NIFTY, `dte_s = 0` for SENSEX). A day on which both expire is left
  unrestricted.
- **Arm EXP:** the list's composite is computed over the expiring index's variants only; the same
  selection rule (top by composite, at least 2 Widesl, same ladder and size, no Buy add-on) as the
  equal split. **Comparator:** the same list C, unrestricted, in the same ladder.
- **Context recorded before any outcome (picks only, no P&L):** on the reconstructed Adaptive picks
  of 2025-01-10 → 2026-10-16 (428 days), Core-298 takes 90.8 % of its NIFTY-expiry-day picks from
  NIFTY and 78.9 % of its SENSEX-expiry-day picks from SENSEX; T1 (Core-298 + 223) 89.3 % and 83.5 %.
  A day carries at least one non-expiring pick on 21 of 91 NIFTY-expiry days and 40 of 90 SENSEX-expiry
  days for Core (22 and 32 for T1). Only those days (about 60) can differ between EXP and the
  comparator, so the test is small.
- **Data / period:** 2025-01-10 → 2026-10-08 only (SENSEX results exist from 2024-10; before that
  the restriction is vacuous because P3 holds NIFTY only).
- **Read-out (exploratory):** on the days where EXP's basket differs from the comparator's, the daily
  gross per lot of EXP minus the comparator: mean and 90 % circular block-bootstrap interval (5-day
  blocks, 2,000 resamples, seed 20261015), NIFTY-expiry days, SENSEX-expiry days and both together
  (together is the primary). Outcomes: **positive** if the lower bound is above zero, **negative**
  if the upper bound is below zero, otherwise **inconclusive**. Net of charges reported beside it.
- **What follows:** nothing is adopted from this. A positive outcome earns a forward parallel track
  for EXP (a T1-style journal and results), read out after 60 on-time expiry days; a negative or
  inconclusive one is recorded and EXP is not pursued.
- **Will not run:** restrictions on non-expiry days, other index rules, other lists.

### Phase 1 — Build the research root and rerun the baseline
- **Tasks:** `research/bl111/` loader for the P3 per-variant results and the in-sample store; the
  weekday-basis P3 day file; a check that the equal-split baseline reproduces BL-100's / BL-071's
  Adaptive totals within rounding; peak margin per day with the repo's margin model (Dir and Widesl
  are both short premium, so lots moved between them are roughly margin-neutral; the cash limit is
  total lots, reported anyway).
- **Done when:** the baseline reproduces and the P3 day file passes a label check against BL-109's.

### Phase 2 — Run once and decide
- **Tasks:** run H1 and H2 on the confirmation period exactly as registered; record the table.
- **Done when:** the rule is applied and the owner has the table.

### Phase 3 — Forward read-out (only if Phase 2 passes)
- Record the signal and both arms' picks in a shadow log from the commit date; read out after 60
  journal days, as BL-058 does.

## Risks

- **BL-053 is a close precedent that failed** on a similar switch; VIX already carries part of the
  range information (BL-110), and the lists carry a VIX-band fit.
- **Low power.** Expiry days are about 1 in 5 and expanded days about 30% of sessions; the lot
  switch changes the basket on only a part of roughly 124 expiry days in P3. A failure may be
  "cannot tell", which the rule treats as killed.
- **Ranks inside a kind are close.** BL-090 found Widesl variants near-copies (0.85 to 0.92
  correlation); a 2-2-1-1 ladder over near-copies may be little more than 3 × 2 with fewer
  strategies.
- **Regime dependence.** The Dir trigger lead appears only from mid-2024 (BL-083); P3 may not have
  it.
- **Cash.** The cash limit is total lots, not the Dir/Widesl split; the real constraint is the
  number of lots on each day type, which this keeps at the owner's 3 and 6.

## Open questions

None for Phase 0: the owner delegated the decisions above. The owner may overrule any of them, and
should say if the 3-lot ordinary-day basket is not "top 3 non-Buy × 1 lot".

## Log

- 2026-10-15 — created from the owner's chat idea; drafted against BL-110 and BL-053.
- 2026-10-15 — owner clarified: today's basket is 3 strategies × 2 lots; the idea is 2-2-1-1 by
  rank; the owner trades 3 lots on ordinary days and 6 on expiry days because of cash, and asked
  the assistant to decide and to stage the quiet mix "four, then five".
- 2026-10-15 — Opus review (PR #235): P3 is not blind (reworded as confirmation, forward read-out
  added); the hold-out comes from `research/bl071/results` and `research/bl080/results`, not the
  live store; list C named; NIFTY-only; ladders tied to `score.select` (Widesl minimum kept, no
  Buy add-on); one primary endpoint (the book); net of charges; placebo made a circular shift
  with a P90 bar; the margin premise corrected (Dir is short premium too).
- 2026-10-18 — owner asked to add the expiring-index-only basket (H3) and to report how much of
  the current basket is non-expiring on expiry days. Amendment 1 registered before any run with an
  `override:` for SENSEX use; H3 is exploratory (no confirmation period). Composition measured
  (picks only): Core-298 non-expiring-index picks 9.2 % on NIFTY-expiry days and 21.1 % on
  SENSEX-expiry days; T1 10.7 % and 16.5 %.

