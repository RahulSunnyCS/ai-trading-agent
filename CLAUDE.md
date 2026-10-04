# CLAUDE.md

Guidance for Claude Code (claude.ai/code) when working in this repository.

All project-specific facts live in `.claude/project/` and are auto-loaded via
the `@import` lines below.

**Discipline (keeps the split files from drifting):**

- One fact lives in exactly one file — never duplicate a fact across the
  project files.
- Update the relevant `.claude/project/` file in the **same commit** as the
  code change that affects it.
- If you move or rename a project file, update its `@import` line here in the
  same change — a broken import fails **silently** (no error, just missing
  context).

## Project Context (auto-loaded)

@.claude/project/overview.md
@.claude/project/business.md
@.claude/project/technical.md

---

## Workflow

No formal phase pipeline for this project — work directly, the normal Claude
Code way: read what's relevant, make the change, run tests, report back.
Don't invent phases, human gates, red-team loops, specialist hand-offs, or
report templates for this repo; that entire ceremony is retired as of
2026-09-29 (it used to live in this file). If you're unsure whether something
needs a check-in first, just ask.

`TODO.md` (repo root) is the hand-maintained single source of truth for open
work items — read it for context, and update the relevant row in the same
commit as the code change that closes it.

## Backlog

`backlog/` is a Jira-style backlog of ideas and plans not yet committed to; its
rules live in `backlog/README.md` and its table in `backlog/INDEX.md`. In short:

- **"Plan X" / "I have an idea"** — discuss, then add it as `backlog/BL-NNN-slug.md`
  (from `_TEMPLATE.md`) plus an `INDEX.md` row. You assign the priority (P0–P3)
  against the project's goals unless the owner states one.
- **"Add this plan to the backlog"** — write the detailed plan into the item file,
  split into phases (tasks, deliverables, "done when"), status `Planned`.
- **"Start BL-NNN"** — read the item and the code it touches, analyse it, **ask the
  owner questions before writing any code**, record the answers in the item, add a
  `TODO.md` row, then begin Phase 1.

Keep `INDEX.md` in sync in the same change as any item edit.
