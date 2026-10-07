# BL-025 — Live-money rules for Momentum: written before the first rupee, enforced by alerts

| | |
|---|---|
| **Priority** | P1 — becomes P0 the week real money goes into the strategy |
| **Status** | In progress (Phase 2) |
| **Type** | feature |
| **Area** | momentum |
| **Created** | 2026-10-06 |
| **Depends on** | BL-024 (journal), BL-016 (validation status) |
| **TODO.md row** | [§3.22](../TODO.md) |

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

0. ~~The rule numbers~~ **Answered when the item started (owner, 2026-10-07):**
   - **Paper-track first.** BL-010's frozen ensemble failed its 2012–16 backcast (+7.8 points
     over the Nifty 500 TRI, +2.5 over the Midcap 150 TRI; the bar was +5 over both). It is
     tracked in the journal before any money goes in.
   - **Drawdown:** cut half at a 20% fall from the peak, exit fully at 30%. These are stricter
     than the 25–35% tolerance and 40% ceiling stated in BL-010.
   - **Trailing:** review when live is 5 points behind the backtest over 13 weeks.
   - **Claude's drafted details (signed off by the owner, 2026-10-07):**
     - the money gate is at least 13 paper weeks, beating the Nifty200 Momentum 30 TRI, and
       neither drawdown rule hit;
     - after "cut half" the signal is followed at half size;
     - re-entry after an exit only by a logged review;
     - "review" means no new money, a check of what changed, and a logged decision (carry on,
       pause or stop).
1. ~~Friends and the rules?~~ **Shown for information only** (owner delegated to the recommendation, 2026-10-06): friends see the owner's rules as an
   example, and each friend's own money is their decision; the alerts go to the owner only.

## Log

- 2026-10-06 — created in the overnight review; not discussed with the owner yet.
- 2026-10-06 — owner delegated the remaining open questions to Claude's recommendations: the draft carries the owner's own stated limits; friends see rules for information only.
  The remaining numbers still need the owner's sign-off before Phase 1 is done.
- 2026-10-06 — owner: pending decisions stay here as open questions and are settled when the item is picked up; the rule numbers are open question 0.
- 2026-10-07 — started. Owner's answers under Open questions 0. Phase 1:
  `packages/momentum-backtesting/src/momentum_backtesting/live_rules.toml` drafted with those
  numbers (stage `paper`). It waits for the owner's sign-off of the drafted details, then
  Phase 2 (the weekly check and alert, a BL-012 scheduler job).
- 2026-10-07 — owner signed off the drafted details ("yes, signed off"). Phase 1 done. Phase 2
  (the weekly check and alert) started.
