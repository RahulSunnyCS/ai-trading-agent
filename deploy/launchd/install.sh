#!/usr/bin/env bash
# Installs every LaunchAgent in deploy/launchd/jobs/ into ~/Library/LaunchAgents and
# loads it into the current user's launchd session (BL-011). Safe to re-run, including
# after editing a plist: bootout-then-bootstrap so an edit is actually picked up (a
# bare re-bootstrap over an already-loaded label is a no-op in launchd, silently
# keeping the OLD file's content loaded).
#
# The Friday momentum jobs still install from packages/momentum-backtesting/scripts/
# until BL-011 Phase 2 moves them here.
set -euo pipefail
cd "$(dirname "$0")/jobs"

DEST="$HOME/Library/LaunchAgents"
# launchd does not create the directory of StandardOutPath; a missing one means no log.
mkdir -p "$DEST" "$HOME/Library/Logs/ai-trading-agent"

for plist in *.plist; do
  label="${plist%.plist}"
  launchctl bootout "gui/$(id -u)/$label" 2>&1 | grep -v -E 'Could not find specified service|No such process' || true
  cp "$plist" "$DEST/$plist"
  launchctl bootstrap "gui/$(id -u)" "$DEST/$plist"
  echo "installed: $label"
done

echo
echo "Status:    launchctl print gui/\$(id -u)/<label>"
echo "Run now:   launchctl kickstart gui/\$(id -u)/<label>"
echo "Logs:      ~/Library/Logs/ai-trading-agent/"
echo "Uninstall: deploy/launchd/uninstall.sh"
