# BL-245 — A minimum start-time gap between picks of the same kind (15 or 30 minutes)

| | |
|---|---|
| **Priority** | P2 — a possible change to the live picks; earlier evidence leans against a gain |
| **Status** | In progress — Phase 0 committed |
| **Type** | research |
| **Area** | options |
| **Created** | 2026-11-26 |
| **Depends on** | BL-058 (ranking), BL-113 (T1); best run after BL-244 Phase 1 |
| **TODO.md row** | — (filled in when started) |

## Context

Owner (chat, 2026-11-26): a 09:17 Widesl and a 09:17 Dir together are fine; but once a strategy of one kind
is taken at 09:17, no other of that kind may be taken at that time. The next best one must start at least
15, or at least 30, minutes apart.

What already touches this:

- BL-130: on 62 % of days (T1) and 66 % (Core-298) two same-index Widesl picks start within 30 minutes;
  identical-strategy pairs' day results correlate 0.80 / 0.71. On T1 the **earlier** of two close picks
  earned more than the later one.
- BL-069 (B4): a 90-minute gap for the same index and family had no effect on the list of the time
  (+₹1,144 over 202 days) and was worse on a second base. Older universe and weights.
- BL-090: capping correlation between picks was killed in all 12 cells (smaller drawdowns, less money).
- BL-207: taking the doubled Dir's second lot 30 / 60 minutes later earned ₹259–564 a day less.

## View before the run (2026-11-26, an expectation, not a finding)

The idea is sound as a risk control: two entries of one kind minutes apart are close to one bet taken
twice, and the rule would apply on most days. Earlier evidence suggests it will not add return, because it
swaps a better-ranked pick for a lower-ranked one; at best it may soften bad days. 15 and 30 minutes under
today's T1 rules have not been tested, so it is worth one registered run, judged on drawdown as well as
return.

## Goal

For each gap (15, 30 minutes), whether the book earns more, or loses less in bad stretches at about the same
return, than today's picks.

## Out of scope

Any change to the live picks, lists or journal. A gap between a Widesl and a Dir.

## Plan

### Phase 0 — Pre-register (final; committed before any run)

- **Hypothesis:** requiring picks of the same kind to start at least G minutes apart changes return or
  drawdown against today's picks.
- **Where it can act:** the book is 3 picks with at least 2 Widesl, so at most one Dir. The rule only ever
  separates Widesl picks from each other. A Widesl and a Dir may start together. Starts sit on a 15-minute
  grid, so G15 only forbids two Widesl in the same start slot; G30 also forbids neighbouring slots.
- **Arms:** FREE = list C's core picks as live (expiry-day rule and SL150% cap applied, on every day of the
  window); G15, G30 = the same selection, skipping a candidate that starts less than G minutes from a pick of
  the same kind already taken, **on either index** (a gap of exactly G is allowed). The Widesl minimum, the
  expiry-day rule and the cap apply inside the rule. A filter of the ranking, never a re-ranking. Shown but
  not deciding: the same with only same-index picks blocking.
- **Universe:** T1 (primary) and Core-298 (sign check). One lot a pick; Buy left out. Shown but not
  deciding: the Dir pick at 2 lots on days neither index expires.
- **Window:** 2025-01-10 → 2026-10-09 (the days BL-244 used). Halves split at 2025-10-09, where T1's
  setting-selection year ends.
- **Outcome:** the book's net per lot-day (mean of its picks) after estimated costs and 0.5 % slippage, gross
  beside it; the ranking itself reads the stored unslipped net, as live does. A day with any arm's result
  missing is dropped from every arm.
- **Drawdown, reported for every arm, whole window and each half:** maximum drawdown of the running total,
  longest time under water in days, worst day and worst 5-day stretch.
- **Before any P&L:** count the days each arm changes. Under 20 changed days an arm cannot pass.
- **Pass rule (per gap, T1), either:**
  - *return:* the 95 % interval (two gaps; 5-day circular block bootstrap, 2,000, seed 20261126) of
    arm − FREE on changed days is above zero, positive in both halves, and maximum drawdown no more than
    10 % deeper over the window; or
  - *risk:* maximum drawdown at least 10 % shallower, mean net no more than 5 % lower and worst day no worse,
    over the window **and** in each half.
  - Core-298 must not point the other way (return: its arm − FREE is not negative; risk: its drawdown is
    not deeper). **Hurts:** the interval is below zero. Otherwise no difference.
- **How easily chance does the same (descriptive, read beside a risk pass):** 1,000 placebo books that change
  the same days and the same picks as the arm, but take a random one of the 15 next-ranked Widesl of that
  day whatever its start time. Reported: the share of placebos whose drawdown is at least as shallow.
- **Supporting, not part of the rule:** the same arms on BL-214's NIFTY-only store (2021-11 → 2024-10-08),
  a period T1's settings were not chosen on.
- **Look-ahead check:** day D is ranked from results before D only; the rebuild must match the pick
  function on every day, and a gap of 0 must reproduce FREE on every day (both asserted).
- **Hold-out:** sessions after 2026-10-09 are not read.
- **Known weaknesses:** in-sample (the pool and weights were chosen on this history) on a window read many
  times, last by BL-244; the risk route's 10 % bar is low for a statistic that rests on one stretch of days;
  start times are the only measure of "the same bet".
- **Will not run:** other gaps, different gaps per kind or time of day, gaps between a Widesl and a Dir,
  book stops on top.

### Phase 1 — Run
- **Tasks:** `packages/option-backtesting/research/bl245/`; the changed-day counts, then the arms.
- **Deliverables:** results JSON committed; verdict per gap; the same-index-only variant of the rule shown
  descriptively.
- **Done when:** the Log has the verdicts and `research/options/common/rotation-ranking.md` is updated.

## Risks

- Passing on drawdown alone can be one lucky stretch; hence both halves.

## Open questions

None open. Answered by the owner, 2026-11-26:

- A Widesl blocks a Widesl on **either index**.
- Judged at **one lot a pick**.
- Risk route: drawdown at least **10 %** shallower (the draft had 20 %), mean no more than 5 % lower.
- "At least 15 minutes" is read from the owner's own wording: 09:17 and 09:32 are allowed.

## Log

- 2026-11-26 — created from the owner's message; Phase 0 drafted, nothing run.
- 2026-11-26 — started ("lets do bl-245, check drawdown also"); owner answered the open questions. Before any
  run the evaluation was red-teamed and Phase 0 changed: window and half split aligned with BL-244
  (2026-10-09, split 2025-10-09 instead of 2025-11-30); drawdown measures listed; a placebo for the
  drawdown added; the 2021-24 store added as support. No P&L of any arm has been computed.
