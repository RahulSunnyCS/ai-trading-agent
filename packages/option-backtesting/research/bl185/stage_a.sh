#!/bin/bash
# BL-185 Stage A: N workers over the base grid, parts claimed by lock files, no new part after
# --not-after (07:00 IST, so nothing runs past the 07:30 contract-notes retry and the 08:02 login).
#   research/bl185/stage_a.sh [workers=6] [not_after=07:00]
set -u
cd "$(dirname "$0")/../.."
W=${1:-6}; NA=${2:-07:00}
mkdir -p research/bl185/logs
for i in $(seq 1 "$W"); do
  nohup caffeinate -i nice -n 10 uv run python research/common/two_session/run_grid.py --not-after "$NA" \
    > "research/bl185/logs/worker_$i.log" 2>&1 &
  sleep 3
done
echo "started $W workers (not after $NA); logs in research/bl185/logs/"
