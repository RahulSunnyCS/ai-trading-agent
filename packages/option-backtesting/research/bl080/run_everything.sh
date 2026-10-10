#!/bin/sh
# BL-080: after the closest-premium batch and BL-075 stage 3 are done, run the rest unattended.
#   sh research/bl080/run_everything.sh   (from packages/option-backtesting, TRADING_DATA_ROOT set)
cd "$(dirname "$0")/../.." || exit 1
PY="uv run --with pandas --with numpy --with duckdb python"
log=research/bl080/everything.log
echo "== wait for the closest-premium batch" >> $log
while pgrep -f "bl080/run_batch.py" > /dev/null; do sleep 20; done
echo "== batch: Dir ITM1 (resumable: only files without results)" >> $log
uv run python research/bl080/run_batch.py >> $log 2>&1
echo "== E4 family by year" >> $log
$PY research/bl080/family_years.py >> $log 2>&1
echo "== E1/E2: 348 list" >> $log
$PY research/bl080/compare.py --ext-closest >> research/bl080/compare_closest.log 2>&1
echo "== E5/E6: 298 list (Dir ITM1 only)" >> $log
$PY research/bl080/compare.py --ext-dir >> research/bl080/compare_dir.log 2>&1
echo "== E5/E6: 398 list (everything)" >> $log
$PY research/bl080/compare.py --ext-closest --ext-dir >> research/bl080/compare_all.log 2>&1
echo "== E3: the 100-weighting map on the 348 list" >> $log
$PY research/bl075/run_all.py --stage 1 --ext --workers 4 > research/bl080/map_ext.log 2>&1
echo "== block 3: leave one category out" >> $log
$PY research/bl080/ablate.py 4 > research/bl080/ablate.log 2>&1
echo "== ALL DONE" >> $log
