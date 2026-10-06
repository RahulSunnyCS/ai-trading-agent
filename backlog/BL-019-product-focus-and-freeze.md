# BL-019 — Product focus: rewrite the overview, freeze the dormant parts

| | |
|---|---|
| **Priority** | P1 — every session reads `overview.md` first, and it describes a product that is not the one being built |
| **Status** | Ready |
| **Type** | chore |
| **Area** | docs |
| **Created** | 2026-10-06 |
| **Depends on** | none |
| **TODO.md row** | — (filled in when started) |

## Context

`.claude/project/overview.md` and `business.md` describe a commercial SaaS: 10 paper-trading
personalities behind a Razorpay paywall. The owner's plan (2026-10-06) is different:

- **This month:** finish the Momentum strategy, for the owner and two or three friends. No paying
  users.
- **Next 2–3 months:** an options and momentum research workbench, used by the same few people,
  to learn what to improve.
- **Later, undecided:** personalities running over the backtest data (BL-023). Paid users are
  not planned for now.

`apps/server`'s personality engine and the payment layer have had only maintenance commits for a
month, and nothing is deployed.

## Goal

The project docs describe the real product and its current users; dormant parts are clearly
marked frozen, so sessions and readers stop treating them as in flight.

## Out of scope

- Deleting code. Frozen means kept, tested in CI, not extended.

## Plan

### Phase 1 — Rewrite the overview
- **Tasks:** rewrite `overview.md` (what the product is, who uses it, what is active vs frozen)
  and trim the Momentum detail that belongs in the package's own `CLAUDE.md`. Update
  `business.md`'s framing (personal tool now; SaaS later, if at all).
- **Done when:** `overview.md` is under about 80 lines and a new session can say what is active
  from it alone.

### Phase 2 — Mark the frozen parts
- **Tasks:** a "Frozen" note at the top of `apps/server/CLAUDE.md` (personalities, retrospection)
  and the payment routes, with the condition for unfreezing (a validated edge to build on).
- **Done when:** the notes are in place and TODO.md rows for frozen work are marked as such.

## Risks

- If the workbench is ever offered to others, selling signals has regulatory implications in
  India. Record that in `business.md`; it is a check for later, not legal advice.

## Open questions

1. ~~Keep Razorpay tested in CI while frozen?~~ **Yes** (owner, 2026-10-06).

## Log

- 2026-10-06 — created from the product discussion.
- 2026-10-06 — owner decisions on PR #27: approved; status Ready.
