# BL-244 — Does the ranking's order predict results? Top against bottom, rank by rank, and who fills the bottom

| | |
|---|---|
| **Priority** | P1 — real money follows T1's ranking; this asks whether its order means anything |
| **Status** | Planned (Phase 0 drafted; open questions to be confirmed before any run) |
| **Type** | research |
| **Area** | options |
| **Created** | 2026-11-26 |
| **Depends on** | BL-058 (ranking, results store), BL-113 (T1); BL-214 (older NIFTY store, for Phase 3) |
| **TODO.md row** | — (filled in when started) |

## Context

Owner (chat, 2026-11-26), two parts, over "the last two years or a couple of years":

1. Each day take the top 10 Widesl and top 5 Dir ("YSL" in the dictated message is read as Widesl), and
   the worst 10 Widesl and worst 5 Dir, see how each set does day by day, and judge whether the top
   predictions make sense. Also see whether the worst performers come from a particular strategy; that may
   need further research.
2. For ranks 1 to 5 of each kind, find the median, the performance and the drawdown of each rank, and
   judge whether the order makes sense (rank 1 should be the better preference).

What already touches this (none answers it for today's T1 list):

- BL-068: picking the **lowest** composite earned ₹1.44 lakh against ₹4.31 lakh for the highest, below the
  random median of ₹1.68 lakh (older weights 33/25/25/17, 248 variants, 202 days, gross).
- `rotation/rankic.py` (Rotation page, "Does rank predict results?"): daily Spearman between composite and
  gross, and the top 30 minus bottom 30. Not split by Widesl / Dir, no per-rank view.
- BL-129: among Adaptive's picks, Widesl rank 1 earned **less** than rank 2 (−₹200 [−388, −1] a lot-day on
  T1; rank 2 is usually the Widesl the minimum swapped in).
- BL-210: an absolute confidence figure beside the rank was killed (ρ +0.07 to +0.08).

## View before the run (2026-11-26, an expectation, not a finding)

- Top against bottom will probably show a real gap, given BL-068's reverse control.
- Ranks 1 to 5 will probably not be cleanly ordered: the gaps between neighbours are small against daily
  noise, and neighbouring ranks are often the same strategy a few minutes apart.
- A median alone flatters option selling (many small wins, a few large losses), so mean, total, drawdown
  and worst day are read beside it.
- A bad bottom set does not show a good top set; both are also compared with the average of all strategies
  of that kind that day.
- Removing a strategy because it filled the bottom, then scoring on the same days, would be data-snooping.

## Goal

Say, per kind (Widesl, Dir): whether the top set beats the bottom set and the pool average; whether ranks
1 to 5 are ordered; and whether some families, indices or start times are over-represented at the bottom.

## Out of scope

Any change to the live lists, weights, universe or journal.

## Plan

### Phase 0 — Pre-register (draft; confirm the open questions, then commit before any run)

- **Hypothesis:** on a given day, a higher composite goes with a higher net result per lot.
- **Universe and books:** T1 (list C over Core-298 + the T1 variants; primary) and Core-298 (sign check).
  Widesl and Dir ranked separately; Buy left out. The ranking is the plain composite order: no Widesl
  minimum, expiry-day rule or SL150% cap.
- **Sets:** top 10 and bottom 10 Widesl; top 5 and bottom 5 Dir; single ranks 1 to 5 of each kind. Equal
  weight, one lot each.
- **Window:** 2025-01-10 → 2026-10-09 (about 430 days; all that the stored results allow after the 63-day
  warm-up, about 21 months). Halves split at 2025-11-30.
- **Outcome:** net per lot after estimated costs and 0.5 % slippage; gross beside it. A strategy with no
  result that day is left out of that day's set, never zero; the count of such cases is reported.
- **Per set and rank:** mean, median, total, win rate, worst day, maximum drawdown of the running total.
  Also top − pool average and pool average − bottom, and the number of distinct strategies (ignoring start
  time) in the top 5.
- **Clones:** the per-rank table is repeated with only the best-ranked start time of each strategy kept.
- **Pass rule, set level (per kind, T1):** the 95 % interval (two kinds; 5-day circular block bootstrap,
  2,000, seed 20261126) of top − bottom a day is above zero, positive in both halves, and still positive
  without the 10 most favourable days.
- **Pass rule, order (per kind, T1):** the 95 % interval of (mean of ranks 1–2 − mean of ranks 4–5) is above
  zero and positive in both halves. Otherwise "no usable order inside the top 5".
- **Look-ahead check:** day D is ranked from results before D only (`daylog.reconstruction` /
  `explain.rank_day`); the rebuild must match the registered pick function on every day (asserted).
- **Hold-out:** sessions after 2026-10-09 are not read (BL-174's forward read-out).
- **Known weaknesses:** in-sample (Core-298 and T1 were chosen on this history; the lists' weights too);
  the research ranks on the day's opening VIX, live on the previous close (BL-180).
- **Will not run:** other set sizes, other weights or lists, dropping or re-weighting any strategy.

### Phase 1 — Top against bottom, and rank by rank
- **Tasks:** `packages/option-backtesting/research/bl244/`; the two tables per book, with the verdicts.
- **Deliverables:** results JSON committed; a day-by-day CSV (git-ignored) and a running-total chart of top,
  pool and bottom per kind.
- **Done when:** both pass rules have a verdict per kind in the Log.

### Phase 2 — Who fills the bottom (descriptive)
- **Tasks:** for (a) the bottom-ranked sets and (b) each day's worst realised 10 Widesl and 5 Dir: share by
  family, index and start band against that group's share of the pool; the same for the top set; each half
  separately.
- **Deliverables:** a table of over-represented groups, and which of them hold in both halves.
- **Done when:** the Log names the groups, or says none holds. A group that holds is a **lead**: acting on it
  needs a new item that picks it on the first half and tests it on the second.

### Phase 3 — Older period check
- **Tasks:** Phase 1 on BL-214's NIFTY-only store, 2021-11 → 2024-10-08, if it is still on disk.
- **Done when:** the Log says whether each Phase 1 verdict repeats. NIFTY only, and already read by BL-214 /
  BL-215, so it supports a verdict but does not make it a clean out-of-sample test.

Closing the item updates `research/options/common/rotation-ranking.md` in the same commit.

## Risks

- A rank 1–5 table invites reading noise as order. The pass rule above is the only reading.

## Open questions

- "Worst" is registered two ways: bottom by rank (Phase 1) and worst by the day's result (Phase 2). Is that
  what was meant?
- Both books, or T1 only?
- "Top 10 / top 5" taken from the plain ranking, not from the three strategies actually traded. Right?

## Log

- 2026-11-26 — created from the owner's message; Phase 0 drafted, nothing run.
