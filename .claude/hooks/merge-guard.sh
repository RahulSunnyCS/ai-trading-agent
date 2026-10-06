#!/usr/bin/env bash
# Claude Code PreToolUse hook (Bash) — BL-014 Phase 3.
#
# Refuses, before they run:
#   - `gh pr merge` while any of the PR's checks is failing, pending or
#     cancelled, or when the PR reports no checks at all;
#   - `gh pr merge --admin` (it bypasses branch protection);
#   - `gh pr merge` on a PR over REVIEW_THRESHOLD changed lines (data, fixtures
#     and lockfiles excluded) that has no `reviewed` label;
#   - `git push` to main of anything but docs-only commits (`*.md` outside
#     `packages/*/src/`), and any force push to main.
#
# Exit 2 blocks the tool call; stderr is shown to Claude as the reason.
# Fails closed: if gh cannot answer, the merge is refused.

set -uo pipefail

REVIEW_THRESHOLD=500
REVIEW_LABEL=reviewed
# Paths that do not count towards the review threshold.
EXCLUDE_RE='(^|/)(data|fixtures|__fixtures__|golden|goldens|__snapshots__)/|(^|/)(bun[.]lock|uv[.]lock|package-lock[.]json)$|[.](csv|parquet|jsonl)$'

block() {
  echo "merge-guard (BL-014): $*" >&2
  exit 2
}

input=$(cat)
cmd=$(jq -r '.tool_input.command // empty' <<<"$input")
cwd=$(jq -r '.cwd // empty' <<<"$input")
[ -n "$cmd" ] || exit 0
[ -n "$cwd" ] && [ -d "$cwd" ] && cd "$cwd"

# Split compound commands so `cd x && gh pr merge 12` is still seen.
segments=$(sed -E 's/(&&|\|\||;|\|)/\n/g' <<<"$cmd")

check_merge() {
  local seg=$1
  # shellcheck disable=SC2086
  set -- $seg
  while [ $# -gt 0 ] && ! { [ "$1" = gh ] && [ "${2:-}" = pr ] && [ "${3:-}" = merge ]; }; do shift; done
  shift 3

  local selector="" repo_args=()
  while [ $# -gt 0 ]; do
    case $1 in
      --admin) block "\`gh pr merge --admin\` bypasses branch protection. Merge without it once checks are green." ;;
      -R|--repo) repo_args=(--repo "$2"); shift ;;
      --repo=*) repo_args=(--repo "${1#--repo=}") ;;
      -t|--subject|-b|--body|-F|--body-file|--match-head-commit|-A|--author-email) shift ;;
      -*) ;;
      *) [ -z "$selector" ] && selector=$1 ;;
    esac
    shift
  done

  local checks
  # gh exits non-zero when checks fail or are pending; the JSON is still printed.
  checks=$(gh pr checks $selector ${repo_args[@]+"${repo_args[@]}"} --json name,bucket 2>/dev/null)
  if [ -z "$checks" ] || ! jq -e 'type == "array"' >/dev/null 2>&1 <<<"$checks"; then
    block "could not read the checks for PR ${selector:-of this branch}. Run \`gh pr checks ${selector}\` and merge only when every check passes."
  fi
  [ "$(jq 'length' <<<"$checks")" -gt 0 ] ||
    block "PR ${selector:-of this branch} reports no checks yet. Wait for CI to start and pass."

  local bad
  bad=$(jq -r '[.[] | select(.bucket == "fail" or .bucket == "pending" or .bucket == "cancel")
                | "\(.name) (\(.bucket))"] | unique | join(", ")' <<<"$checks")
  [ -z "$bad" ] || block "PR ${selector:-of this branch} is not green: ${bad}. Wait for, or fix, these checks before merging."

  local view nwo number size has_label
  view=$(gh pr view $selector ${repo_args[@]+"${repo_args[@]}"} --json number,url,labels 2>/dev/null) ||
    block "could not read PR ${selector:-of this branch} to measure its size."
  number=$(jq -r .number <<<"$view")
  nwo=$(jq -r '.url | capture("github\\.com/(?<r>[^/]+/[^/]+)/pull").r' <<<"$view")
  # The REST files endpoint paginates; `gh pr view --json files` stops at 100.
  size=$(gh api --paginate "repos/${nwo}/pulls/${number}/files?per_page=100" \
           --jq '.[] | "\(.additions + .deletions)\t\(.filename)"' 2>/dev/null |
         awk -F'\t' -v re="$EXCLUDE_RE" '$2 !~ re { s += $1 } END { print s + 0 }') ||
    block "could not list the files of PR ${number}."
  has_label=$(jq --arg l "$REVIEW_LABEL" '[.labels[].name] | index($l) != null' <<<"$view")
  if [ "$size" -gt "$REVIEW_THRESHOLD" ] && [ "$has_label" != true ]; then
    block "PR ${selector:-of this branch} changes ${size} lines (excluding data, fixtures and lockfiles), over the ${REVIEW_THRESHOLD}-line review threshold. Run /code-review, post its result on the PR, then add the \`${REVIEW_LABEL}\` label."
  fi
}

check_push() {
  local seg=$1
  # shellcheck disable=SC2086
  set -- $seg
  while [ $# -gt 0 ] && ! { [ "$1" = git ] && [ "${2:-}" = push ]; }; do shift; done
  shift 2

  local force=false positional=()
  while [ $# -gt 0 ]; do
    case $1 in
      -f|--force|--force-with-lease|--force-with-lease=*|--force-if-includes) force=true ;;
      -o|--push-option|--repo|--receive-pack|--exec) shift ;;
      -*) ;;
      +*) force=true; positional+=("${1#+}") ;;
      *) positional+=("$1") ;;
    esac
    shift
  done

  # positional[0] is the remote, the rest are refspecs. With no refspec git
  # pushes the current branch to its upstream.
  local refspecs=(${positional[@]+"${positional[@]:1}"}) src="" ref
  if [ ${#refspecs[@]} -eq 0 ]; then
    [ "$(git rev-parse --abbrev-ref HEAD 2>/dev/null)" = main ] && src=HEAD
  else
    for ref in "${refspecs[@]}"; do
      case $ref in
        main|refs/heads/main) src=main ;;
        *:main|*:refs/heads/main) src=${ref%%:*} ;;
      esac
    done
  fi
  [ -n "$src" ] || return 0

  $force && block "force push to main is not allowed."

  git fetch -q origin main 2>/dev/null
  local files offending
  files=$(git diff --name-only "origin/main...${src}" 2>/dev/null) ||
    block "could not tell what this push to main contains. Push a branch and open a PR."
  offending=$(grep -vE '\.md$' <<<"$files" | sed '/^$/d'; grep -E '^packages/[^/]+/src/.*\.md$' <<<"$files")
  [ -z "$offending" ] ||
    block "only docs-only commits (*.md outside packages/*/src) may go straight to main. This push also changes: $(head -5 <<<"$offending" | paste -sd ' ' -). Push a branch and open a PR."
}

while IFS= read -r seg; do
  if grep -qE '(^|[[:space:]])gh[[:space:]]+pr[[:space:]]+merge([[:space:]]|$)' <<<"$seg"; then
    check_merge "$seg"
  elif grep -qE '(^|[[:space:]])git[[:space:]]+push([[:space:]]|$)' <<<"$seg"; then
    check_push "$seg"
  fi
done <<<"$segments"

exit 0
