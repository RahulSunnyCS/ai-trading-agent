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
