# BL-014 — CI and merge gates: nothing reaches `main` while checks are red

| | |
|---|---|
| **Priority** | P0 — `main` CI failed 50 of 56 runs from 2026-09-29 to 2026-10-05; a red build stops warning about anything |
| **Status** | In progress |
| **Type** | chore |
| **Area** | infra |
| **Created** | 2026-10-06 |
| **Depends on** | none |
| **TODO.md row** | 3.5.8 |

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
- **Settings** (Settings → Branches → `main`, or this one call; `strict` = branches must be up
  to date; `enforce_admins: false` keeps the owner's docs-only pushes possible):

  ```bash
  gh api -X PUT repos/RahulSunnyCS/ai-trading-agent/branches/main/protection --input - <<'JSON'
  {"required_status_checks": {"strict": true, "contexts": [
     "Server — Typecheck · Lint · Unit Tests", "Dashboard — Build",
     "option-backtesting — Ruff · Pytest", "momentum-backtesting — Ruff · Pytest"]},
   "enforce_admins": false, "required_pull_request_reviews": null, "restrictions": null}
  JSON
  gh label create reviewed --color 0E8A16 --description "/code-review ran; its result is on the PR"
  ```

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
3. ~~How is "docs only may go straight to `main`" enforced?~~ **Admin bypass plus convention**
   (owner, 2026-10-06): GitHub branch protection cannot allow pushes by file path. Branch
   protection does not apply to the owner as admin; the Claude merge guard refuses a Claude
   push to `main` that changes anything but docs.
4. ~~Which checks are required?~~ **The four CI jobs that run on every PR** (owner, 2026-10-06):
   Server, Dashboard, option-backtesting, momentum-backtesting. Not Integration (nightly
   only). CI's `pull_request` trigger no longer has `paths-ignore`, so a PR that touches only
   `packages/broker-login` or `contract-notes` still reports the required checks instead of
   waiting on them forever.
5. ~~What counts as a "review note"?~~ **The `reviewed` label** (owner, 2026-10-06), added after
   `/code-review` has run and its result is posted on the PR. The merge guard checks for the
   label.

## Log

- 2026-10-06 — created from the process review of the week 2026-09-29 → 2026-10-05.
- 2026-10-06 — owner decisions on PR #27: both open questions answered (take everything); status Ready.
- 2026-10-06 — started. Questions 3–5 answered (owner approved the recommendations). Phase 3
  built: `.claude/hooks/merge-guard.sh` + `.claude/settings.json`, tested against real PRs —
  #8 and #17 (merged over red builds) are refused, naming the failing job; #29 and #27 are
  refused for size without the label; #23 passes (its 90k lines are fixture CSVs). Phase 2
  built: `lefthook.yml` pre-push runs Biome on the changed files, Ruff, and the server,
  shared-package and dashboard unit tests, each only when its package changed — a server lint
  error is refused in 17 s. Biome checks files rather than `.` because untracked Playwright
  output fails the formatter. pytest stays in CI (momentum's full suite takes ~4 min). The
  existing BL-001 `momentum-goldens` pre-push test took ~6 min on a momentum change, well over
  this item's one-minute aim — left as is, flagged to the owner. Phase 1 settings above.
