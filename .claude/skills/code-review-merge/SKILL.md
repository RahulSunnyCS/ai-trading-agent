---
name: code-review-merge
description: Review, fix and merge pull requests end to end. Use when the owner says "code review", "code review PR 123" or "review and merge". With a PR number it handles only that PR; without one it handles every open PR in the repo. Reviews with Opus, watches CI with a Haiku poller every 5 minutes, merges when green, then syncs local main.
---

# code-review-merge

Runs from a Sonnet 5 session (the **driver**). The driver orchestrates; it does not review code itself.

## Scope

| Owner says | PRs handled |
|---|---|
| `code review 123` / `review PR 123` | **Only** #123. Never touch another PR |
| `code review` (no number) | **Every** open PR, oldest first. Skip drafts and PRs labelled `do-not-merge` (list them in the final report) |

List PRs with `mcp__github__list_pull_requests` (state `open`). Never act outside `RahulSunnyCS/ai-trading-agent`.

## Models

- **Review: Opus**, unless the owner names another model in the request ("review with sonnet"). Spawn one reviewer per PR with `Agent` (`model: "opus"`), several in one message when there are several PRs. Brief each with the PR number and tell it to follow the built-in `/code-review` recipe, read `CLAUDE.md` first, and apply the Research gate if the PR touches a backtest or search.
- **Driver: Sonnet 5**: fetches PRs, posts results, applies fixes, merges, syncs.
- **Poller: Haiku**: only reads status (see Step 3).

## Steps

1. **Review.** Each Opus reviewer posts its findings on the PR (inline where it can, one summary comment). Findings that are real bugs go to Step 2. Optional nits are left as a comment, not fixed. Once the result is on the PR, add the `reviewed` label (the merge guard requires it above 500 changed lines; add it always, it is cheap). PRs are issues, so use `mcp__github__issue_write` to set labels.

2. **Fix.** The driver fixes real findings and any CI failure on the PR's own branch: check it out, fix, run the repo's fast checks for what changed (see `technical.md` → Essential Commands; the pre-push hook does the same), push. Never skip, disable or loosen a test to get green, never `--no-verify`, never force-push someone else's branch. A branch that is behind or conflicted: `mcp__github__update_pull_request_branch` or merge `main` in locally.

3. **Watch (Haiku, every 5 minutes).** Create the schedule with `CronCreate` (`*/5 * * * *`). Each tick runs one `Agent` call with `model: "haiku"`. Its prompt asks it to report, for each PR in scope and nothing else: head SHA, merge state (clean/behind/conflict), each check's state, whether `reviewed` is present, and whether anything changed since the last tick. It never edits, pushes or merges. The driver acts on the report:
   - any check **failed** → Step 2 for that PR;
   - all checks **green**, review done, no conflict → Step 4;
   - **pending** → wait for the next tick;
   - the poller reports nothing new for a PR that needs the owner → Step 5.

4. **Merge.** One PR at a time, oldest first, with `mcp__github__merge_pull_request` using the repo's usual method (the existing history uses merge commits). Do not use the admin bypass; branch protection and `.claude/hooks/merge-guard.py` rules still apply (green checks, `reviewed` label over 500 lines). After each merge the other PRs are behind `main`: update their branches and let CI re-run before merging them.

5. **Ask the owner only when needed.** Default is to decide and proceed. Ask (with `AskUserQuestion`, one batched message) only for: a secret or access the sandbox lacks, a finding that changes behaviour or design where both options are reasonable, a failure that is red on `main` too and has no obvious fix, or a conflict where both sides changed the same logic. Say what is blocked and which PRs carry on meanwhile.

6. **Finish.** When every PR in scope is merged or closed:
   - `git fetch origin main && git checkout main && git merge --ff-only origin/main` (sync local to origin/main; if the working tree is dirty, stop and tell the owner rather than stash);
   - **then** delete the Haiku schedule (`CronDelete`). The schedule stops last, only after local is synced;
   - report in a few lines: PRs merged, PRs left open and why, fixes pushed.

## Rules

- Anything the owner must do (a decision, a secret, a manual merge) is reported as a short list; the schedule keeps running while any PR in scope is still open.
- If the schedule has run 12 ticks (an hour) with no change on any PR, tell the owner once and keep going.
- Record nothing in `TODO.md` unless a merged PR's own change requires it.
