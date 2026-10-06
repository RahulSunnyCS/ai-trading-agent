# BL-025 — Live-money rules for Momentum: written before the first rupee, enforced by alerts

| | |
|---|---|
| **Priority** | P1 — becomes P0 the week real money goes into the strategy |
| **Status** | Planned |
| **Type** | feature |
| **Area** | momentum |
| **Created** | 2026-10-06 |
| **Depends on** | BL-024 (journal), BL-016 (validation status) |
| **TODO.md row** | — (filled in when started) |

## Context

The owner plans to put 10–20% of their portfolio into Momentum and accepts a 25–35% drawdown, with
a hard ceiling of 40% (BL-010, 2026-10-04). Those limits exist in a backlog file, not in the
system. The moment that tests them, a deep drawdown or a strategy that has quietly stopped working,
is when deciding calmly is hardest. The rules should be fixed in advance and the system should say
when one is hit.

This item does not choose the numbers; the owner does. It makes the owner's own numbers explicit
and checked.

## Goal

A `live_rules` file the owner writes once, and a weekly check that alerts when a rule is breached.

## Plan

### Phase 1 — Write the rules (owner, with Claude)
- **Draft, from the owner's own statements in BL-010 (2026-10-04/05):** about ₹5 lakh, 10–20% of
  the portfolio; drawdown limits per basket 25% / 30% / 35% with a hard ceiling of 40%. Every other
  number (how far live may trail the backtest, over how many weeks, and what each breach triggers)
  is still the owner's to set — Claude does not choose them.
- **Tasks:** capital allocated; maximum drawdown before reducing and before stopping; how far
  live may trail the backtest (from BL-024) over how many weeks before review; what "review" means;
  which validation status (BL-016) is required before money goes in.
- **Done when:** the file is committed and the owner has signed it off in the log.

### Phase 2 — Check and alert
- **Tasks:** a weekly job (BL-012) that reads the rules, the journal and the realised P&L, and
  sends a Telegram alert naming the rule breached and the action the owner wrote for it.
- **Done when:** a simulated breach produces the alert.

## Open questions

0. **Pending — discuss when this item is picked up.** The rule numbers: how far live may trail the
   backtest and over how many weeks before a review; the drawdown at which to reduce and at which
   to stop (within the stated 25/30/35% baskets and 40% ceiling); and what each breach triggers.
1. ~~Friends and the rules?~~ **Shown for information only** (owner delegated to the recommendation, 2026-10-06): friends see the owner's rules as an
   example, and each friend's own money is their decision; the alerts go to the owner only.

## Log

- 2026-10-06 — created in the overnight review; not discussed with the owner yet.
- 2026-10-06 — owner delegated the remaining open questions to Claude's recommendations: the draft carries the owner's own stated limits; friends see rules for information only.
  The remaining numbers still need the owner's sign-off before Phase 1 is done.
- 2026-10-06 — owner: pending decisions stay here as open questions and are settled when the item is picked up; the rule numbers are open question 0.
