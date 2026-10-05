# BL-021 — End of the Max month: make the project cheap to run on Pro

| | |
|---|---|
| **Priority** | P1 — time-bound: the owner moves from Max to Pro after about a month, and Pro's limits are much lower |
| **Status** | Planned |
| **Type** | chore |
| **Area** | cross-cutting |
| **Created** | 2026-10-06 |
| **Depends on** | BL-014, BL-019; BL-012 for the jobs |
| **TODO.md row** | — (filled in when started) |

## Context

The owner bought Claude Max for a fast month (from 2026-10-06) and plans to continue slowly on
Pro afterwards. A codebase growing by about 30k lines a week, with a large always-loaded
context, will hit Pro's limits quickly unless the last week of the month leaves it cheap to
maintain.

## Goal

At the switch, routine work needs little or no Claude time, and a typical change fits in one
short Pro session.

## Plan

### Phase 1 — Downgrade checklist (week 4)
- **Tasks:** check each of these, and fix what fails:
  - CI on `main` green for a week, with BL-014's gates on.
  - Every daily or weekly job runs on its own with failure alerts (BL-012).
  - No P0 backlog item open.
  - Always-loaded context trimmed (root `CLAUDE.md` + `.claude/project/*` under an agreed size).
  - A runbook per recurring task (data refresh, weekly signal, broker login, backups).
- **Done when:** every check passes. If not, stay on Max another month rather than maintain a
  half-finished product on Pro.

## Open questions

1. What size target for the always-loaded context?

## Log

- 2026-10-06 — created from the month-plan discussion.
