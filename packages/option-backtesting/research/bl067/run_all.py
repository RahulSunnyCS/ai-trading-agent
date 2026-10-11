"""BL-067: run DRB-6W3L2 under each of the 16 criteria-weight combinations (research/bl067/combos.py).

    uv run --with pandas --with numpy --with duckdb python research/bl067/run_all.py [parallel]

Each row is one `rotate.py --basket DRB-6W3L2 --weights R,W,D,V` run (picks file
`daily_picks_min3_core6_buy2L2_whole_day_wR_W_D_V.csv`). Writes out/summary.csv (gross, drawdown,
worst week, win %, random P50/P90 and the three conditions per row)."""

from __future__ import annotations

import re
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pandas as pd

HERE = Path(__file__).parent
ROTATE = HERE.parent / "bl057" / "rotate.py"
sys.path.insert(0, str(HERE))
from combos import COMBOS  # noqa: E402

NUM = r"(-?[\d,]+(?:\.\d+)?)"


def run(item) -> dict:
    name, w = item
    tag = ",".join(map(str, w))
    out = subprocess.run(
        [
            sys.executable,
            str(ROTATE),
            "--basket",
            "DRB-6W3L2",
            "--weights",
            tag,
        ],
        capture_output=True,
        text=True,
        cwd=HERE.parent.parent,
    ).stdout
    (HERE / "out").mkdir(exist_ok=True)
    (HERE / "out" / f"run_{tag.replace(',', '_')}.txt").write_text(out)
    case_a = out.split("CASE A")[1].split("CASE B")[0]
    row = re.search(r"ROTATION case A[^\n]*?\)\s+" + r"\s+".join([NUM] * 8), case_a)
    assert row, name
    total, avg, win, mdd, worst_day, worst_wk, lots, per_lot = (
        float(x.replace(",", "")) for x in row.groups()
    )
    rand = re.search(r"P50 " + NUM + r" \| P90 " + NUM, case_a)
    conds = re.search(r"\(1\) total >= R P90: (\w+) \| \(2\) beats E on total and DD: (\w+) \| \(3\) beats B2 on total and DD: (\w+)", case_a)
    verdict = re.search(r"VERDICT: (\w+)", case_a).group(1)
    spear = re.search(r"composite\s+mean ([+-][\d.]+)", out).group(1)
    return dict(
        name=name,
        weights="/".join(map(str, w)),
        gross=total,
        max_dd=mdd,
        win_pct=win,
        worst_day=worst_day,
        worst_week=worst_wk,
        per_lot_day=per_lot,
        r_p50=float(rand.group(1).replace(",", "")),
        r_p90=float(rand.group(2).replace(",", "")),
        c1=conds.group(1),
        c2=conds.group(2),
        c3=conds.group(3),
        verdict=verdict,
        composite_spearman=float(spear),
    )


def main() -> None:
    workers = int(sys.argv[1]) if len(sys.argv) > 1 else 4
    with ThreadPoolExecutor(workers) as pool:
        rows = list(pool.map(run, COMBOS))
    df = pd.DataFrame(rows)
    df.to_csv(HERE / "out" / "summary.csv", index=False)
    print(df.to_string(float_format=lambda x: f"{x:,.0f}" if abs(x) >= 100 else f"{x:,.2f}"))


if __name__ == "__main__":
    main()
