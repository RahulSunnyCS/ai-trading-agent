# BL-020 — Claude Code working set-up: model per role, saved commands, session habits

| | |
|---|---|
| **Priority** | P2 — makes the month on Max faster and cheaper; nothing breaks without it |
| **Status** | Ready |
| **Type** | chore |
| **Area** | cross-cutting |
| **Created** | 2026-10-06 |
| **Depends on** | BL-014 (the merge guard is part of `/safe-merge`) |
| **TODO.md row** | — (filled in when started) |

## Context

Patterns from the sessions of 2026-09-27 → 2026-10-05:

- Two sessions ran past 100 prompts, with 8 context compactions and 4 usage-limit stops.
  Compaction summaries kept the decisions but dropped the caveats.
- Hand-offs between cloud planning sessions and local sessions were copied and pasted by hand.
- The owner asked for a way to run some phases on Fable/Opus and others on Sonnet.
- Secrets were moved from `.env` to GitHub through chat, so their values sit in transcripts.

## Goal

Model choice per role is configured, the repeated flows are one command each, and sessions stay
short and on one topic.

## Plan

### Phase 1 — Subagents with a model per role
- **Tasks:** `.claude/agents/` definitions with a `model:` line: a planner/reviewer on
  Opus or Fable, an implementer on Sonnet, a research red-teamer on Opus.
- **Done when:** a plan can delegate its phases to the Sonnet implementer.

### Phase 2 — Saved commands
- **Tasks:** `/handoff` (writes a hand-off note: branch, state, next steps, open caveats),
  `/experiment` (creates a pre-registered spec from BL-015's template), `/safe-merge` (checks,
  then review, then merge, via BL-014's guard).
- **Done when:** each command has been used once on real work.

### Phase 3 — Habits, written down
- **Tasks:** a short "Working with Claude" section in `CLAUDE.md`: one topic per session; a
  hand-off note and a new session at about 40 prompts; "restate my asks as a numbered list"
  for dictated messages; set secrets with `gh secret set NAME < file`, never through chat;
  overnight requests open PRs and leave a summary, never merge.
- **Done when:** the section is in place.

### Phase 4 — Credentials (owner-approved 2026-10-06)
- **Tasks:** rotate the credentials whose values passed through Claude sessions (broker logins and
  TOTP secrets, Fyers app secret, Telegram bot token, AlgoTest), since transcripts keep them on
  disk under `~/.claude/projects/`; then do TODO 1.2 — move the broker secrets into a GitHub
  Environment with required reviewers.
- **Done when:** each rotated secret is updated in GitHub and `.env`, and the next broker-login
  run passes.

## Open questions

1. ~~Implementer model?~~ **Sonnet 5.5** (owner delegated to the recommendation, 2026-10-06): cheapest for bulk implementation; planning,
   review and research red-teaming stay on Opus or Fable.

## Log

- 2026-10-06 — created from the process review.
- 2026-10-06 — owner decisions on PR #27: credential rotation and TODO 1.2 approved — added as Phase 4.
- 2026-10-06 — owner delegated the remaining open questions to Claude's recommendations: Sonnet 5.5 for the implementer. Status Ready.
- 2026-10-08 — second process review (`docs/process-reviews/2026-10-08.md`): Phases 1–3 not
  started; `code-review-merge` covers part of `/safe-merge`. A weekly `process-review` skill,
  its stats script and a Saturday 08:55 IST Routine now measure follow-through on this item
  and on BL-014/BL-015/BL-021.
