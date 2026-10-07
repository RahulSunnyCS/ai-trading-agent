#!/usr/bin/env bash
# Installs every LaunchAgent in deploy/launchd/jobs/ — today just the scheduler
# (BL-012) — into ~/Library/LaunchAgents and loads it. Safe to re-run, including after
# editing a plist: bootout-then-bootstrap so an edit is actually picked up (a bare
# re-bootstrap over an already-loaded label is a no-op in launchd, silently keeping the
# OLD file's content loaded).
#
# It first removes the per-job plists the scheduler replaced, so no job runs twice.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT/deploy/launchd/jobs"

DEST="$HOME/Library/LaunchAgents"
# launchd does not create the directory of StandardOutPath; a missing one means no log.
mkdir -p "$DEST" "$HOME/Library/Logs/ai-trading-agent"

# Replaced by apps/scheduler (BL-012 PR 5). Keep this list: it is what makes a re-install
# on a laptop that still has the old jobs safe.
RETIRED=(
  com.ai-trading-agent.broker-login
  com.ai-trading-agent.fyers-login
  com.ai-trading-agent.momentum-weekly-preview
  com.ai-trading-agent.momentum-weekly-final
  com.ai-trading-agent.momentum-weekly-stock-ingest
  com.ai-trading-agent.momentum-weekly-journal-check
)
for label in "${RETIRED[@]}"; do
  if [ -f "$DEST/$label.plist" ] || launchctl print "gui/$(id -u)/$label" >/dev/null 2>&1; then
    launchctl bootout "gui/$(id -u)/$label" 2>&1 | grep -v -E 'Could not find specified service|No such process' || true
    rm -f "$DEST/$label.plist"
    echo "retired: $label"
  fi
done

for plist in *.plist; do
  label="${plist%.plist}"
  launchctl bootout "gui/$(id -u)/$label" 2>&1 | grep -v -E 'Could not find specified service|No such process' || true
  cp "$plist" "$DEST/$plist"
  launchctl bootstrap "gui/$(id -u)" "$DEST/$plist"
  echo "installed: $label"
done

echo
# The scheduler ignores slots before its first start, and the old plists are gone: say which
# of today's slots that leaves un-run, so the owner can start them by hand.
(cd "$ROOT/apps/scheduler" && "${BUN:-$(command -v bun || echo "$HOME/.bun/bin/bun")}" src/cli.ts skipped) || true
echo "Jobs:      bun run --filter @ata/scheduler jobs status"
echo "Status:    launchctl print gui/\$(id -u)/com.ai-trading-agent.scheduler"
echo "Logs:      ~/Library/Logs/ai-trading-agent/ (scheduler.log + one folder per job)"
echo "Uninstall: deploy/launchd/uninstall.sh"
