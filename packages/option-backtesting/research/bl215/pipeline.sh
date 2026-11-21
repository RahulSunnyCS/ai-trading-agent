#!/bin/bash
# BL-215 overnight driver: wait for the extra-cells sweep, check nothing is missing, select every remaining fold,
# COMMIT the selections (so they are on record before any test window is read), simulate, score.
# Run from packages/option-backtesting:  nohup caffeinate -i bash research/bl215/pipeline.sh > research/bl215/results/pipeline.log 2>&1 &
set -u
cd "$(dirname "$0")/../.."
export TRADING_DATA_ROOT=/Volumes/TradingData/_bl215
LOG=research/bl104/results/bl215_extra.log
say() { echo "[$(date '+%a %H:%M')] $*"; }

say "waiting for the bl215_extra sweep"
while pgrep -f "bl104/run_grid.py" > /dev/null; do sleep 60; done
DONE=$(grep -c '^done' "$LOG"); say "sweep ended: $DONE of 36 cohorts done"
if [ "$DONE" -ne 36 ] || grep -qiE 'traceback|failed' "$LOG"; then say "STOP: sweep incomplete or failed (re-run the same run_grid command to resume)"; exit 1; fi

say "needed cells check"
uv run python research/bl215/needed_cells.py 2>&1 | grep -v Warning | grep -E "missing" || true
MISSING=$(uv run python research/bl215/needed_cells.py 2>&1 | grep -oE '^[0-9]+ missing' | cut -d' ' -f1)
if [ "${MISSING:-1}" -ne 0 ]; then say "STOP: $MISSING cells still missing"; exit 2; fi

say "selecting the remaining folds (tuning windows only)"
uv run python research/bl215/select_all.py --out research/bl215/selected.json 2>&1 | grep -E "^(12m|6m):" || { say "STOP: selection failed"; exit 3; }

say "committing the selections before any test window is read"
git add research/bl215/selected.json
git commit -q -m "BL-215: selected settings for every fold, recorded before any test window was read

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>" && say "committed $(git rev-parse --short HEAD)" || say "WARNING: commit failed"

say "simulating every selected setting at 25 entry times"
mkdir -p /Volumes/TradingData/_bl215/rotation
uv run python research/bl215/build_and_sim.py --selected research/bl215/selected.json --workers 6 2>&1 | grep -vE "written, .* already, 0 errors" | tail -20
say "scoring"
uv run python research/bl215/score.py --selected research/bl215/selected.json --json research/bl215/results/score.json 2>&1 | grep -v Warning
say "pipeline finished"
