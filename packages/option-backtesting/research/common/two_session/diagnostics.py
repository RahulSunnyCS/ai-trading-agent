"""BL-185 post-hoc diagnostics (descriptive, no pass rule): how the frozen winners transferred from the
selection year to the test year, and the replay arms split by the pick's own index expiry day.

    uv run python research/common/two_session/diagnostics.py [--winners PATH]
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np

HERE = Path(__file__).parent
sys.path.insert(0, str(HERE.parent))
sys.path.insert(0, str(HERE))
import grid  # noqa: E402
import replay as rp  # noqa: E402
import stage_b as sb  # noqa: E402

from option_backtesting.fyers.daily import data_dir  # noqa: E402
from option_backtesting.rotation import store  # noqa: E402


def transfer(winners: list[dict], attrs: dict) -> list[str]:
    L = [
        "| Cohort | Mode / half | Band | Stratum | Selection-year net / lot-day (the winner's score table) | Test-year net / lot-day | Test days |",
        "|---|---|---|---|---|---|---|",
    ]
    s_all, t_all, pos = [], [], 0
    rows = []
    for w in winners:
        win = w["winner"]
        if win is None:
            continue
        u = w["underlying"]
        key = "dte_n" if u == "NIFTY" else "dte_s"
        slots = [s for s in grid.SLOTS if grid.BAND[s] == w["band"]]
        vals = []
        for slot in slots:
            ser = rp.winner_series(w, slot)
            if ser is None:
                continue
            for d, (_, net, _, _) in ser.rows.items():
                if d < sb.S_END or d < rp.T_START:
                    pass
                if (
                    d >= rp.T_START
                    and d in attrs
                    and ((attrs[d][key] == "0") == (w["stratum"] == "expiry"))
                ):
                    vals.append(net)
        if not vals:
            continue
        t = float(np.mean(vals))
        rows.append((w, win["net_per_lot_day"], t, len(vals) / max(len(slots), 1)))
        s_all.append(win["net_per_lot_day"])
        t_all.append(t)
        pos += t > 0
        L.append(
            f"| {w['underlying'][0]}-{w['cohort']} | {w['mode']} {w['half']} | {w['band']} | {w['stratum']} | {win['net_per_lot_day']:+.0f} | {t:+.0f} | {rows[-1][3]:.0f} |"
        )
    L.append("")
    L.append(
        f"Over {len(rows)} winners: mean selection-year net {np.mean(s_all):+.0f}, mean test-year net {np.mean(t_all):+.0f} ({100 * np.mean(t_all) / np.mean(s_all):.0f} % of it); {pos} of {len(rows)} positive in the test year."
    )
    return L


def by_expiry(attrs: dict, winners: list[dict]) -> list[str]:
    pools = {
        "A0": rp.pool_from_csv(rp.ROOT / "a0"),
        "A1": rp.pool_from_winners(winners, "whole", None, grid.SLOTS),
        "AM": rp.pool_from_winners(winners, "half", "morning", grid.SLOTS_AM),
        "PM": rp.pool_from_winners(winners, "half", "afternoon", grid.SLOTS_PM),
    }
    days_all = sorted(attrs)
    reps = {k: rp.replay(p, attrs, days_all) for k, p in pools.items()}
    test = [
        d
        for d in sorted(set.intersection(*(set(r["picks"]) for r in reps.values())))
        if d >= rp.T_START
    ]
    L = [
        "| Pool (3 picks) | Expiry-day picks: net per pick | n | Other-day picks: net per pick | n | Share of picks on expiry days |",
        "|---|---|---|---|---|---|",
    ]
    for k, p in pools.items():
        e, o = [], []
        for d in test:
            for v in reps[k]["picks"][d]:
                s = p[v]
                key = "dte_n" if s.u == "NIFTY" else "dte_s"
                (e if attrs[d][key] == "0" else o).append(s.rows[d][1])
        L.append(
            f"| {k} | {np.mean(e):+.0f} | {len(e)} | {np.mean(o):+.0f} | {len(o)} | {100 * len(e) / (len(e) + len(o)):.0f} % |"
        )
    return L


def main() -> None:
    args = sys.argv[1:]
    wpath = (
        Path(args[args.index("--winners") + 1]) if "--winners" in args else rp.ROOT / "winners.json"
    )
    winners = json.loads(wpath.read_text())
    attrs = store.read_days(data_dir(), "weekdays")
    out = [
        "# BL-185 diagnostics (post-hoc, descriptive)",
        "",
        "## Winners: selection year to test year",
        "",
    ]
    out += transfer(winners, attrs)
    out += ["", "## Picks by the pick's own index expiry day (test year)", ""]
    out += by_expiry(attrs, winners)
    text = "\n".join(out) + "\n"
    (rp.ROOT / "out" / "diagnostics.md").write_text(text)
    print(text)


if __name__ == "__main__":
    main()
