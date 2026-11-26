# BL-245 — A minimum start-time gap between picks of the same kind (15 or 30 minutes)

| | |
|---|---|
| **Priority** | P2 — a possible change to the live picks; earlier evidence leans against a gain |
| **Status** | Done — killed: neither 15 nor 30 minutes passes; on T1 both earn less and deepen the worst drawdown |
| **Type** | research |
| **Area** | options |
| **Created** | 2026-11-26 |
| **Depends on** | BL-058 (ranking), BL-113 (T1); best run after BL-244 Phase 1 |
| **TODO.md row** | 3.10.80 |

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

## Result

Verdict: **killed** for both gaps. ₹ per lot-day (the book's mean pick), net of costs and 0.5 % slippage,
one lot a pick.

**T1, 2025-01-10 → 2026-10-09 (423 days, the deciding run)**

| | Today (FREE) | 15 minutes | 30 minutes |
|---|---|---|---|
| Days the book changes | — | 149 | 250 |
| Mean / median a day | 509 / 523 | 448 / 534 | 406 / 556 |
| Total per lot | 2,15,415 | 1,89,410 | 1,71,833 |
| Maximum drawdown | −8,628 | −9,887 (15 % deeper) | −10,763 (25 % deeper) |
| Drawdown, first / second half | −8,628 / −8,108 | −8,798 / −9,887 | −8,844 / −10,763 |
| Longest under water, days | 36 | 26 | 34 |
| Worst day / worst 5 days | −4,568 / −6,609 | −4,568 / −7,916 | −4,568 / −8,014 |
| Minus FREE on changed days (95 %) | — | −175 [−333, −8] | −174 [−304, −46] |
| Dir at 2 lots on non-expiry days: book mean / drawdown, ₹ | 1,676 / −36,648 | 1,460 / −40,332 | 1,346 / −40,388 |

- Neither route passes; by the registered rule both gaps **hurt** (interval below zero; G15 only just).
- Placebo (the same picks swapped at random for next-ranked Widesl): 80 % / 70 % of placebo books had a
  drawdown at least as shallow, and 74 % / 57 % a mean at least as high. The gap does no better than a
  random swap of the same picks: what costs money is giving up a better-ranked pick.

**Core-298 (sign check).** Mean falls too (−129 [−249, −11] and −102 [−219, +20] on changed days). Maximum
drawdown is 17 % / 15 % shallower, but the mean is 18 % / 22 % lower, time under water rises from 47 to 83–84
days, and 69 % / 32 % of placebos do as well. Risk route not met.

**2021-11 → 2024-10-08, NIFTY only (supporting).** Mean falls: T1-N −84 [−163, −3] and −28 [−93, +34]
(drawdown 6 % / 9 % shallower); Core-N −45 [−117, +29] and +6 [−53, +64] (drawdown 31 % / 5 % deeper).

**Reading.** The return is lower in seven of the eight period-by-gap cells and flat in the eighth (cells
share days and strategies). Drawdown goes either way, so the gap is not a dependable risk control. Nothing
changed live.

**Same index only (shown, not deciding).** T1: 15 minutes −128 [−304, +58] on 143 changed days, drawdown
15 % deeper; 30 minutes −194 [−323, −69] on 238 days, 43 % deeper. Core: −123 [−252, −5] and
−118 [−239, +4], drawdown 17 % / 15 % shallower. Neither passes.

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
- 2026-11-26 — changed days counted before any P&L: T1 149 (G15) / 250 (G30), Core 179 / 277, all above the 20
  needed. A blocked Widesl can let a Dir into a book that had none (21 / 42 changed days on T1).
- 2026-11-26 — **run as registered** (`research/bl245/start_gap.py`; `results_new.json`, `results_old.json`;
  per-day books git-ignored). The rebuilt ranking matched on every day and a gap of 0 reproduced today's
  book on every day. `pick.load_history` refuses 1 day of 2025-26 (September 2026's missing results) and 647
  days of BL-214's store (no lake); those are compared through the same two reads.
- 2026-11-26 — **verdict: killed**, 15 and 30 minutes alike (neither the return nor the risk route; both
  hurt return on T1). PR 470 review: status wording fixed, same-index figures added. The result files' pass
  flags leave out the Core-298 sign check; no arm passed on T1, so nothing turns on it.
