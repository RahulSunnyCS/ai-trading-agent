# Backlog

A Jira-style backlog for ideas and plans. One file per item, one index.

**Backlog vs `TODO.md`:** the backlog holds ideas and plans that are *not yet
committed to*. `TODO.md` stays the single source of truth for work that *is*
committed. When an item is started, it gets a row in `TODO.md` that links back
to its backlog file; the plan detail stays here (one fact, one file).

## Files

| File | Purpose |
|---|---|
| `INDEX.md` | The table of every item — ID, title, priority, status, type, area. Always kept in sync with the item files |
| `BL-NNN-short-slug.md` | One item: context, plan in phases, open questions, log |
| `_TEMPLATE.md` | Copy this for a new item |

IDs are sequential and never reused (`BL-001`, `BL-002`, …), even for dropped items.

## Workflow

### 1. "Let's plan X" / "I have an idea: X"
Discuss it, then add it to the backlog: create `BL-NNN-slug.md` from the
template and add a row to `INDEX.md`. An idea with no plan yet gets status
`Idea` and just the Context section filled in.

### 2. "Add this plan to the backlog"
Once a plan has been worked out in the conversation, write the **detailed plan**
into the item file: Context, Goal, then **Phases** — each with its tasks,
deliverables and an exit check ("done when…"). Set status to `Planned`.

### 3. "Start BL-NNN"
Do **not** start coding straight away:
1. Read the item file and the code it touches.
2. Analyse: is the plan still right, what has changed, what is risky?
3. **Ask the owner questions** — resolve the open questions and any gaps.
4. Update the item file with the answers, set status `In progress`, add the
   `TODO.md` row, then begin Phase 1.

## Priority

Claude assigns it unless the owner states one. Judged against this project's
goals (research-grade evidence on Indian weekly options/momentum strategies,
nothing trades live until the signal is measured, commercial SaaS billing).

| Priority | Meaning |
|---|---|
| **P0** | Blocks other work, protects correctness/money/credentials, or is time-critical. Do next |
| **P1** | High value for the core goals — measurement, evidence, or unblocking live execution. Soon |
| **P2** | Useful improvement; worth doing when P0/P1 are clear. The default |
| **P3** | Nice to have, speculative, or cheap polish. Pick up opportunistically |

A priority is a judgement, not a promise — re-rank in `INDEX.md` whenever the
picture changes, and note why in the item's log.

## Status

`Idea` → `Planned` → `Ready` (questions answered, can start) → `In progress` → `Done`.
Side exits: `Blocked` (say on what), `Dropped` (keep the file; record why).

## Type and area

- **Type:** `feature`, `improvement`, `bug`, `research`, `chore`.
- **Area:** `server`, `dashboard`, `options`, `momentum`, `trading-data`,
  `broker-login`, `contract-notes`, `infra`, `docs` — or `cross-cutting`.

## Index maintenance

Whenever an item is added, re-prioritised or changes status, update its row in
`INDEX.md` in the same change. Keep the table sorted by priority (P0 first),
then by ID. Move finished items to the **Done / Dropped** table at the bottom.
