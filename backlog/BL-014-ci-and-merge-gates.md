# BL-014 — CI and merge gates: nothing reaches `main` while checks are red

| | |
|---|---|
| **Priority** | P0 — `main` CI failed 50 of 56 runs from 2026-09-29 to 2026-10-05; a red build stops warning about anything |
| **Status** | Ready |
| **Type** | chore |
| **Area** | infra |
| **Created** | 2026-10-06 |
| **Depends on** | none |
| **TODO.md row** | — (filled in when started) |

## Context

A process review on 2026-10-06 found that `main` stayed red for most of a week. The server
unit test broke around 2026-10-01; its fix (PR #4) was opened on 2026-10-04 and merged only on
2026-10-05, while more than ten other PRs merged over the red build — eight of them (#8–#15)
within about two minutes. Sessions merged on request without checking CI, one of them noting
"I merged without waiting". Nothing in the repo enforces green checks: there is no branch
protection, no pre-push hook for the checks CI runs, and no Claude Code hook around merges.

## Goal

A PR cannot merge into `main` unless CI is green, enforced by tooling rather than memory, and
the failures CI catches are caught on the laptop before a push.

## Out of scope

- New tests or new CI jobs (see BL-008 for the dashboard e2e suite).
- CODEOWNERS (TODO 1.6).

## Plan

### Phase 1 — GitHub branch protection (owner)
- **Tasks:** on `main`, require the CI workflow's jobs to pass and require branches to be up to
  date before merging. Decide whether direct pushes to `main` stay allowed for docs.
- **Deliverables:** branch protection rule on `main`.
- **Done when:** a PR with a failing job shows the merge button blocked.

### Phase 2 — Pre-push checks on the laptop
- **Tasks:** add a `pre-push` section to `lefthook.yml` running Biome, Ruff for the Python
  packages that changed, and the server unit tests, scoped to changed packages so it stays fast.
- **Deliverables:** `lefthook.yml` change; a line in `technical.md` under Essential Commands.
- **Done when:** pushing a branch with a lint error is refused locally, in under about a minute
  on a typical change.

### Phase 3 — Claude Code merge guard
- **Tasks:** a `PreToolUse` hook in `.claude/settings.json` that runs `gh pr checks` before any
  `gh pr merge` and blocks the merge if any check is failing or pending.
- **Deliverables:** the hook script and settings entry.
- **Done when:** asking a session to "merge" a PR with a red check is refused with the failing
  job's name.

## Risks

- A slow pre-push hook gets bypassed with `--no-verify`. Keep it scoped to changed packages.
- Real-data tests that need `~/TradingData` must stay skipped in CI and in the hook.

## Open questions

1. ~~Allow direct pushes to `main` for docs-only commits?~~ **Yes** (owner, 2026-10-06): a push
   that touches only `*.md` outside `packages/*/src` may go straight to `main`; everything else
   through a PR.
2. ~~Require a `/code-review` pass above a size threshold?~~ **Yes** (owner, 2026-10-06): PRs
   over about 500 changed lines, excluding data and fixtures, need a review note in the PR
   before the merge guard lets them through.

## Log

- 2026-10-06 — created from the process review of the week 2026-09-29 → 2026-10-05.
- 2026-10-06 — owner decisions on PR #27: both open questions answered (take everything); status Ready.
