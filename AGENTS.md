# AGENTS.md

This repo's guidance is tool-agnostic and lives in one place: **`CLAUDE.md`**
(root) plus `.claude/project/overview.md` / `business.md` / `technical.md`
(auto-imported by it). Read `CLAUDE.md` first — everything in it applies to
any coding agent working here, not just Claude Code.

This file exists only because some agents (Codex, etc.) look for `AGENTS.md`
by convention rather than `CLAUDE.md`. It is deliberately not a second copy:
duplicating that content here would drift out of sync the first time only
one of the two got updated (see `CLAUDE.md`'s own "one fact, one file" rule).
An earlier version of this file *was* a full duplicate, already stale and
pointing at a nonexistent `.Codex/project/` directory — replaced by this
pointer on 2026-09-29.

Every package/app under `apps/` and `packages/` has the same pair: its own
`CLAUDE.md` with package-local context (commands, source layout, cross-package
links, gotchas), and its own `AGENTS.md` pointing at that `CLAUDE.md`. Start
at the package you're actually touching, not just this root file.

`TODO.md` (repo root) is the hand-maintained single source of truth for open
work items — read it for context, and update the relevant row in the same
commit as the code change that closes it.
