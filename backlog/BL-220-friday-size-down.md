# BL-220 — Friday size-down: trade fewer Adaptive picks on Fridays, tested on days not used to find it

| | |
|---|---|
| **Priority** | P2 — a possible cost saving on one day in five; the evidence so far is a post-hoc look, under the noise bar |
| **Status** | Planned |
| **Type** | research |
| **Area** | options |
| **Created** | 2026-11-12 |
| **Depends on** | none; [BL-221](BL-221-friday-by-family.md) is the descriptive companion and must not read this item's hold-out |
| **TODO.md row** | — (filled in when started) |

## Context

On 2026-11-12 the owner asked for each book's return by weekday. The Rotation "Day by day" data (1 lot per
pick, no book stop, 0.5 % slippage after costs; T1 and Core 2025-01-10 → 2026-11-11, 444 days; the fixed
base 2024-11-12 → 2026-11-11, 486 days) gave Friday as the weakest day for all three books:

| ₹ a day | Mon | Tue | Wed | Thu | Fri |
|---|---|---|---|---|---|
| Tuned Adaptive (T1) | 1,071 | 2,992 | 971 | 1,510 | **64** |
| Classic Adaptive (Core) | 537 | 1,924 | 22 | 999 | **58** |
| Fixed base | 728 | 1,438 | 554 | 608 | **85** |

A follow-up read the same days three ways (scripts in the session scratchpad, not committed):

- **Friday is the one day far from both expiries in both expiry regimes.** Weekdays to expiry
  (NIFTY / SENSEX) on a Friday were 6 / 4 before Sep 2025 and 4 / 6 after. Tuesday and Thursday hold an
  expiry in both regimes and carry 68 % of T1's total, 82 % of Core's, 60 % of the base's.
- **The whole universe makes about nothing on Fridays, not a loss.** The 298 stored strategies average
  ₹6 a strategy-day on Friday (0.5 % slippage), against −₹78 on Wednesday, the universe's weakest day.
  Friday was +₹118 before Sep 2025 and −₹55 after.
- **The ranking's edge vanishes on Fridays.** A T1 pick beats that day's universe mean by ₹300–800 on other
  weekdays but by ₹32 (before Sep 2025) and ₹8 (after) on Fridays. Core: −₹294 / +₹178; the base +₹124 / +₹46.

**This is a hint, not a result.** After Sep 2025 T1's Friday is −₹157 ± 649 a day against Monday's
+₹1,233 ± 569, about 1.6 standard errors. Earlier items put the noise bar at about ₹700 a day
([days to expiry](../research/options/strategies/widesl/days-to-expiry.md)). The pattern was found by
looking at 5 weekdays × 3 books (15 cells) after the fact, and BL-159 read 8's Monday screen found no
lead. So every day above is spent: none of it may be used for the verdict.

## Goal

A yes / no, on days not used to find it, on whether trading fewer Adaptive picks on Fridays improves
T1's result per rupee of risk without giving up more than a set share of its net.

## Out of scope

- Any other weekday (Wednesday is the universe's weakest day): its own item if wanted.
- Changing the ranking itself (its weekday / days-to-expiry ingredients).
- Turning a rule on in Settings › Automation. A pass ends in a proposal to the owner, not a switch.

## Plan

### Phase 0 — Pre-register (DRAFT: the owner confirms or edits it at "Start BL-220", before any run)
Filled in and committed **before any run**. A rule is never edited after a run: a new, dated rule
supersedes it with a logged reason, and both stay here.
- **Hypothesis:** on Fridays, when neither index is within 4 weekdays of expiry, Adaptive's picks earn
  about the universe mean (≈ zero), so trading fewer of them raises net per unit of drawdown.
- **Candidate rules (fixed now, no others):**
  - **R0** — as now: every pick, every Friday (the comparator).
  - **R1** — Friday: drop the lowest-ranked pick (trade 2 of 3; Dir ×2 and the Buy add-on off).
  - **R2** — Friday: trade nothing.
- **Universe:** T1's journal picks as recorded (forward), and for the mechanism test the 124 NIFTY
  variants BL-071 ran over 2022–24, with the expiry list of that time (NIFTY Thursday), not today's.
- **Look-ahead check:** the rule reads only the calendar date and the point-in-time expiry list
  (`ref_expiries` in the trading-data catalog, holiday-shifted expiries included), both known the evening before. A
  holiday-shifted week where Friday is within 1 weekday of an expiry is reported apart.
- **Pass / kill rule (proposed numbers, owner to confirm):**
  - *Mechanism (hold-out A):* the universe's Friday mean per variant-day is below its other-days mean by
    ₹100 or more, one-sided p ≤ 0.05 by a 5-day block bootstrap with days as the unit. Fails → **killed**,
    Phase 2 not run.
  - *Book (hold-out B):* after 40 forward Fridays, R1 or R2 against R0 on the same weeks: net per lot-day
    of the week not lower by more than 5 %, and the worst 20-day drawdown at least 10 % smaller. Neither
    passes → **killed**. Both pass → the one with the higher net is proposed.
- **Hold-out:**
  - *A:* NIFTY 2022-04-05 → 2024-10-08, BL-071's per-day results. BL-071 read rankings there, never a
    weekday split, so Friday is unseen. NIFTY only (no SENSEX in the lake for those years).
  - *B:* T1 journal Fridays from 2026-11-13 (paper; the R1/R2 results are recorded as a shadow each week).
  - Spent (never used for the verdict): everything from 2024-10-09 → 2026-11-12, including BL-221's reads.
- **Will not run:** other weekdays, other drop counts, threshold tuning, any read of hold-out A or B
  before this block is committed. Running one needs `override: <reason>` in the Log.
- **Tests counted:** this item makes 3 (A; R1 vs R0; R2 vs R0), on top of the 15 cells that suggested it.

### Phase 1 — Mechanism on hold-out A (no engine runs)
- **Tasks:** weekday table of the 124 NIFTY variants' per-day results over 2022-04-05 → 2024-10-08, by
  family and by weekdays to expiry; the bootstrap test above; a NIFTY-only rotation book's Friday from
  BL-071's best row, reported but not part of the verdict.
- **Deliverables:** a short table in this file and the verdict on the mechanism.
- **Done when:** the mechanism test is read and logged as pass or kill.

### Phase 2 — Forward shadow (only if Phase 1 passes)
- **Tasks:** each Friday record R0 / R1 / R2 for T1's recorded picks from the stored results (after
  costs, 0.5 % slippage); nothing changes what trades.
- **Deliverables:** a running table and, after 40 Fridays (about September 2027), the verdict.
- **Done when:** the book rule is read and logged as pass or kill.

### Phase 3 — Close
- **Tasks:** update `research/options/strategies/widesl/weekday.md`, `directional/weekday.md`,
  `buy-breakout/weekday.md` and the days-to-expiry pages with the result; a pass becomes a proposal to the
  owner for a Settings › Automation rule.
- **Done when:** the pages cite this item and INDEX shows Done or Dropped.

## Risks

- 40 Fridays is thin; a 1.6-SE gap may not resolve in that time. The kill rule then decides by default.
- 2022–24 NIFTY had a different expiry weekday and rupee levels; hold-out A tests the mechanism, not
  today's book.
- Another weekday item running at the same time would add tests; count them here.

## Open questions

1. Are R1 and R2 the right candidates, or should one be "Friday at half lots" instead?
2. Are the proposed thresholds (₹100 gap; −5 % net; −10 % drawdown) acceptable?
3. Should Core be shadowed as well, or T1 only?
4. Is 40 Fridays the right forward length, given it runs into late 2027?

## Log

- 2026-11-12 — created from the weekday read (owner: "Yes, add it"). Phase 0 is a draft; nothing has been
  run on either hold-out.
