"""Parse rotate.py's printed report into one summary row (shared by the BL-067/068 runners)."""

from __future__ import annotations

import re

NUM = r"(-?[\d,]+(?:\.\d+)?)"


def parse_case_a(out: str) -> dict:
    case_a = out.split("CASE A")[1].split("CASE B")[0]
    row = re.search(r"ROTATION case A[^\n]*?\)\s+" + r"\s+".join([NUM] * 8), case_a)
    assert row, "no ROTATION line in the report"
    total, avg, win, mdd, worst_day, worst_wk, lots, per_lot = (
        float(x.replace(",", "")) for x in row.groups()
    )
    rand = re.search(r"P50 " + NUM + r" \| P90 " + NUM, case_a)
    conds = re.search(
        r"\(1\) total >= R P90: (\w+) \| \(2\) beats E on total and DD: (\w+) \| \(3\) beats B2 on total and DD: (\w+)",
        case_a,
    )
    verdict = re.search(r"VERDICT: (\w+)", case_a).group(1)
    spear = re.search(r"composite\s+mean ([+-][\d.]+)", out).group(1)
    return dict(
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
