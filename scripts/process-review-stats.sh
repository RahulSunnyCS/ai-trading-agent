#!/usr/bin/env bash
# Raw numbers for the weekly process review (.claude/skills/process-review/SKILL.md).
# Git only, no network beyond a deepen of a shallow clone. Prints a Markdown report to stdout.
#
#   scripts/process-review-stats.sh                 # last 7 days
#   scripts/process-review-stats.sh 2026-10-05      # since a date (inclusive)
#   scripts/process-review-stats.sh 2026-10-05 2026-10-08
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

SINCE="${1:-$(date -u -d '7 days ago' +%F 2>/dev/null || date -u -v-7d +%F)}"
UNTIL="${2:-$(date -u +%F)}"
RANGE=(--since="${SINCE}T00:00:00" --until="${UNTIL}T23:59:59")

# A cloud session clones shallow; the window needs real parents for shortstat to be honest.
if [ "$(git rev-parse --is-shallow-repository)" = "true" ]; then
  git fetch --quiet --shallow-since="$(date -u -d "$SINCE -3 days" +%F 2>/dev/null || echo "$SINCE")" origin main 2>/dev/null || true
fi

echo "# Process-review stats: $SINCE → $UNTIL"
echo
echo "## Commits per day (non-merge) and lines"
echo
echo "| Day | Commits | Insertions | Deletions |"
echo "|---|---|---|---|"
git log "${RANGE[@]}" --no-merges --format='__%ad' --date=short --shortstat \
  | awk '/^__/{d=substr($1,3); n[d]+=0} /files? changed/{i[d]+=$4; del[d]+=$6; n[d]++} END{for(k in n) printf "| %s | %d | %d | %d |\n", k, n[k], i[k], del[k]}' | sort
echo
echo "## Merges per day: PR merges vs sync merges (origin/main into a feature branch)"
echo
echo "| Day | PR merges | Sync merges |"
echo "|---|---|---|"
git log "${RANGE[@]}" --merges --format='%ad %s' --date=short \
  | awk '{d=$1; if ($0 ~ /Merge pull request/) pr[d]++; else sync[d]++; seen[d]=1} END{for(k in seen) printf "| %s | %d | %d |\n", k, pr[k]+0, sync[k]+0}' | sort
echo
echo "## Commit type prefixes"
echo
git log "${RANGE[@]}" --no-merges --format='%s' \
  | sed -E 's/^([a-zA-Z+]+)(\(.*\))?:.*/\1/; t; s/.*/none/' | sort | uniq -c | sort -rn | awk '{printf "- %s: %s\n", $2, $1}'
echo
echo "## Review follow-through"
echo
printf -- "- Commits that are review fixes: %s\n" "$(git log "${RANGE[@]}" --no-merges --format='%s' | grep -ciE 'review (fix|finding)|address.*review|follow-?up|second review|code-review' || true)"
echo
echo "## File touches by kind (sum over commits)"
echo
TOUCH=$(mktemp); git log "${RANGE[@]}" --no-merges --name-only --format='' > "$TOUCH"
TESTS=$(grep -cE '(/tests?/|/__tests__/|/e2e/|\.test\.|\.spec\.|/test_)' "$TOUCH" || true)
DOCS=$(grep -cE '\.md$' "$TOUCH" || true)
SRC=$(grep -vE '(/tests?/|/__tests__/|/e2e/|\.test\.|\.spec\.|/test_|\.md$|\.lock$|\.csv$|\.json$|\.txt$)' "$TOUCH" | wc -l | tr -d ' ')
printf -- "- Source: %s\n- Tests: %s\n- Markdown: %s\n- Test files added: %s\n" "$SRC" "$TESTS" "$DOCS" \
  "$(git log "${RANGE[@]}" --diff-filter=A --name-only --format='' | grep -E '(/tests?/|/__tests__/|/e2e/|\.test\.|\.spec\.|/test_)' | sort -u | wc -l | tr -d ' ')"
echo
echo "## Areas (top 12 by touches)"
echo
awk -F/ '{print $1"/"$2}' "$TOUCH" | sort | uniq -c | sort -rn | head -12 | awk '{printf "- %s: %s\n", $2, $1}'
rm -f "$TOUCH"
echo
echo "## Largest non-merge commits (lines changed, files)"
echo
git log "${RANGE[@]}" --no-merges --format='%h %ad %s' --date=short --shortstat \
  | awk '/^[0-9a-f]{7} /{h=$0} /files? changed/{printf "- %d lines, %d files: %s\n", $4+$6, $1, h}' | sort -t' ' -k2 -rn | head -10
echo
echo "## Commit hours, IST (hour:count)"
echo
TZ=Asia/Kolkata git log "${RANGE[@]}" --no-merges --format='%ad' --date=format-local:'%H' | sort | uniq -c | awk '{printf "%s:%s ", $2, $1} END{print ""}'
echo
echo "## Always-loaded context (BL-021 target: about 400 lines)"
echo
wc -l CLAUDE.md .claude/project/*.md | awk '{printf "- %s: %s\n", $2, $1}'
echo
echo "## Backlog"
echo
printf -- "- Open P0: %s\n" "$(grep -cE '\| P0 \|' backlog/INDEX.md || true)"
printf -- "- Open items: %s\n" "$(awk '/^## Open/{p=1} /^## Done/{p=0} p && /^\| \[BL-/' backlog/INDEX.md | wc -l | tr -d ' ')"
printf -- "- Closed in window: %s\n" "$(awk '/^## Done/{p=1} p && /^\| \[BL-/' backlog/INDEX.md | awk -F'|' -v s="$SINCE" -v u="$UNTIL" '{d=$5; gsub(/ /,"",d); if (d>=s && d<=u) c++} END{print c+0}')"
echo
echo "## Pending merged-but-unverified owner steps (TODO.md rows marked owner)"
echo
grep -E '^\| [0-9]+\.[0-9]+ .*\| (owner|claude→owner) \|' TODO.md | awk -F'|' '{gsub(/^ +| +$/,"",$2); gsub(/^ +| +$/,"",$3); printf "- %s %s\n", $2, $3}' | head -15
