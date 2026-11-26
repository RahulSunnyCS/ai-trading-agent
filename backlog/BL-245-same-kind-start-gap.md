# BL-245 — A minimum start-time gap between picks of the same kind (15 or 30 minutes)

| | |
|---|---|
| **Priority** | P2 — a possible change to the live picks; earlier evidence leans against a gain |
| **Status** | Planned (Phase 0 drafted; open questions to be confirmed before any run) |
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

### Phase 0 — Pre-register (draft; confirm the open questions, then commit before any run)

- **Hypothesis:** requiring picks of the same kind to start at least G minutes apart changes return or
  drawdown against today's picks.
- **Arms:** FREE = list C's core picks as live (expiry-day rule and SL150% cap applied); G15, G30 = the same
  ranking walked in composite order, skipping a candidate whose start is less than G minutes from a pick of
  the same kind already taken, **on either index**. Widesl and Dir do not block each other. The minimum of
  2 Widesl is kept within the rule. A filter of the ranking, never a re-ranking.
- **Universe:** T1 (primary) and Core-298 (sign check). One lot a pick; Buy add-on left out.
- **Window:** 2025-01-10 → 2026-10-08. Halves split at 2025-11-30.
- **Outcome:** net per lot-day after estimated costs and 0.5 % slippage (gross beside it); maximum drawdown
  and worst day. A day with any arm's result missing is dropped from every arm.
- **Before any P&L:** count the days each arm changes. Under 20 changed days an arm cannot pass.
- **Pass rule (per gap, T1), either:**
  - *return:* the 95 % interval (two gaps; 5-day circular block bootstrap, 2,000, seed 20261126) of
    arm − FREE on changed days is above zero, positive in both halves, drawdown no more than 10 % deeper; or
  - *risk:* maximum drawdown at least 20 % shallower, mean net no more than 5 % lower, worst day no worse,
    and both hold in each half.
  - Core-298 must not point the other way. **Hurts:** the interval is below zero. Otherwise no difference.
- **Look-ahead check:** day D is ranked from results before D only; a gap of 0 must reproduce FREE on every
  day (asserted).
- **Hold-out:** sessions after 2026-10-08 are not read.
- **Known weaknesses:** in-sample, on a window read many times; start times are the only measure of "the
  same bet".
- **Will not run:** other gaps, different gaps per kind or time of day, gaps between a Widesl and a Dir,
  Dir ×2 or book stops on top.

### Phase 1 — Run
- **Tasks:** `packages/option-backtesting/research/bl245/`; the changed-day counts, then the arms.
- **Deliverables:** results JSON committed; verdict per gap; the same-index-only variant of the rule shown
  descriptively.
- **Done when:** the Log has the verdicts and `research/options/common/rotation-ranking.md` is updated.

## Risks

- Passing on drawdown alone can be one lucky stretch; hence both halves.

## Open questions

- Does a NIFTY 09:17 Widesl block a SENSEX 09:17 Widesl? Drafted as yes (either index).
- Is "at least 15 minutes" met by 09:17 and 09:32? Drafted as yes.
- Judge at one lot a pick, or at the lots actually traded (Dir ×2 on normal days)?

## Log

- 2026-11-26 — created from the owner's message; Phase 0 drafted, nothing run.
