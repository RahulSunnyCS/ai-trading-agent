#!/usr/bin/env bash
# Unloads and removes the two Friday momentum-weekly LaunchAgents installed by
# install-launchd.sh. Safe to re-run.
set -euo pipefail

DEST="$HOME/Library/LaunchAgents"

for label in com.ai-trading-agent.momentum-weekly-preview \
             com.ai-trading-agent.momentum-weekly-final; do
  launchctl bootout "gui/$(id -u)/$label" 2>&1 | grep -v 'Could not find specified service' || true
  rm -f "$DEST/$label.plist"
  echo "removed: $label"
done
