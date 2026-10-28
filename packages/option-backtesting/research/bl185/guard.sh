#!/bin/bash
# Stop Stage A's workers if the system disk (where swap grows) has under 8 GB free; they resume later
# (a killed part's lock is reclaimed). Runs until then, or until the workers are gone.
while pgrep -f "two_session/run_grid.py" >/dev/null; do
  avail=$(df -g / | awk 'NR==2 {print $4}')
  if [ "$avail" -lt 8 ]; then
    pkill -f "two_session/run_grid.py"
    echo "$(date '+%F %T') guard: system disk $avail GB free, workers stopped" | tee -a "$(dirname "$0")/guard.log"
    exit 1
  fi
  sleep 60
done
echo "$(date '+%F %T') guard: workers gone, exiting" >> "$(dirname "$0")/guard.log"
