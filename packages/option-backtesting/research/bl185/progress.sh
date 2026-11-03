#!/bin/bash
# Stage A progress: parts done / claimed / total, and each worker's last line.
P=${BL185_PATHS:-/Volumes/TradingData/research/bl185/paths}
total=80; done_=$(ls "$P"/*/DONE 2>/dev/null | wc -l | tr -d ' '); locked=$(ls "$P"/*/LOCK 2>/dev/null | wc -l | tr -d ' ')
echo "parts: $done_ done, $((locked - done_)) running, $((total - locked)) unclaimed of $total  ($(date '+%H:%M'))"
for f in "$(dirname "$0")"/logs/worker_*.log; do echo "$(basename "$f"): $(tail -1 "$f" | cut -c1-90)"; done
pgrep -fc "run_grid.py" | sed 's/^/workers alive: /'
