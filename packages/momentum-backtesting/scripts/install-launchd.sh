#!/usr/bin/env bash
# Installs the four Friday momentum-weekly LaunchAgents (TODO.md 3.11.5) into
# ~/Library/LaunchAgents and loads them into the current user's launchd session.
# Safe to re-run, including after editing a plist: bootout-then-bootstrap so an
# edit is actually picked up (a bare re-bootstrap over an already-loaded label is a
# no-op in launchd, silently keeping the OLD file's content loaded).
set -euo pipefail
cd "$(dirname "$0")"

DEST="$HOME/Library/LaunchAgents"
mkdir -p "$DEST"

for plist in com.ai-trading-agent.momentum-weekly-preview.plist \
             com.ai-trading-agent.momentum-weekly-final.plist \
             com.ai-trading-agent.momentum-weekly-stock-ingest.plist \
             com.ai-trading-agent.momentum-weekly-journal-check.plist; do
  label="${plist%.plist}"
  launchctl bootout "gui/$(id -u)/$label" 2>&1 | grep -v 'Could not find specified service' || true
  cp "$plist" "$DEST/$plist"
  launchctl bootstrap "gui/$(id -u)" "$DEST/$plist"
  echo "installed: $DEST/$plist"
done

echo
echo "Check status any time with: launchctl print gui/\$(id -u)/com.ai-trading-agent.momentum-weekly-preview"
echo "Logs land in packages/momentum-backtesting/data/launchd-weekly-*.log"
echo "Uninstall with: scripts/uninstall-launchd.sh"
