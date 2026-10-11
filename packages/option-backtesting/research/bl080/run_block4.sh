#!/bin/sh
# BL-080 block 4: the 298 map and the pruned universe (unattended).
cd "$(dirname "$0")/../.." || exit 1
PY="uv run --with pandas --with numpy --with duckdb python"
log=research/bl080/block4.log
echo "== (b) pruned universe: 298 minus S_p250, S_p320" >> $log
$PY research/bl080/compare.py --ext-dir --drop S_p250,S_p320 > research/bl080/compare_pruned.log 2>&1
echo "== (a) the 100-weighting map on the 298 list" >> $log
$PY research/bl075/run_all.py --stage 1 --extdir --workers 4 > research/bl080/map_extdir.log 2>&1
echo "== BLOCK4 DONE" >> $log
