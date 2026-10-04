#!/usr/bin/env bash
# Unloads and removes every LaunchAgent installed by install.sh. Safe to re-run.
set -euo pipefail
cd "$(dirname "$0")/jobs"

DEST="$HOME/Library/LaunchAgents"

for plist in *.plist; do
  label="${plist%.plist}"
  launchctl bootout "gui/$(id -u)/$label" 2>&1 | grep -v -E 'Could not find specified service|No such process' || true
  rm -f "$DEST/$plist"
  echo "removed: $label"
done
