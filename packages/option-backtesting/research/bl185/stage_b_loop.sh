#!/bin/bash
# Score every finished Stage A part with Stage B (about a minute each), every 10 minutes, until
# 07:35 or until Stage A is finished and everything is scored.
cd "$(dirname "$0")/../.."
while true; do
  nice -n 15 uv run python research/common/two_session/stage_b.py >> research/bl185/logs/stage_b.log 2>&1
  now=$(date +%H%M)
  if [ "$now" -ge 0735 ] && [ "$now" -lt 1200 ]; then break; fi
  if ! pgrep -f "two_session/run_grid.py" >/dev/null; then
    nice -n 15 uv run python research/common/two_session/stage_b.py >> research/bl185/logs/stage_b.log 2>&1
    break
  fi
  sleep 600
done
echo "$(date '+%F %T') stage_b_loop done" >> research/bl185/logs/stage_b.log
