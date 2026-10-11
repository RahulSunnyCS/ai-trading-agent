#!/bin/sh
# BL-080: the steps of run_everything.sh after the batches (re-run after fixing the day alignment).
cd "$(dirname "$0")/../.." || exit 1
PY="uv run --with pandas --with numpy --with duckdb python"
log=research/bl080/everything2.log
echo "== E1/E2: 348 list" >> $log
$PY research/bl080/compare.py --ext-closest > research/bl080/compare_closest.log 2>&1
echo "== E5/E6: 298 list (Dir ITM1 only)" >> $log
$PY research/bl080/compare.py --ext-dir > research/bl080/compare_dir.log 2>&1
echo "== E5/E6: 398 list (everything)" >> $log
$PY research/bl080/compare.py --ext-closest --ext-dir > research/bl080/compare_all.log 2>&1
echo "== block 3: leave one category out" >> $log
$PY research/bl080/ablate.py 4 > research/bl080/ablate.log 2>&1
echo "== E3: the 100-weighting map on the 348 list" >> $log
rm -rf research/bl075/out_ext/runs/*_P1.txt research/bl075/out_ext/runs/*_P2.txt
$PY research/bl075/run_all.py --stage 1 --ext --workers 4 > research/bl080/map_ext.log 2>&1
echo "== ALL DONE" >> $log
