"""BL-184 E1: the morning sets' overall stop sweep (owner override, descriptive).

    uv run python research/bl184/stops.py [--levels 500,750] [--smoke] [--analyse-only]

Each level is a full split replay with only the morning sets at that stop (`Spec(mtm=level,
mtm_halves=("am",))`); the afternoon sets and the whole-day comparator keep their files' stop. Runs
the levels given (so several processes can share the grid), then prints one row a level: Adaptive's
morning book alone, the split against the comparator, and the fixed 09:17 morning halves. The files'
own stop (₹3,000) is the registered run, read from its own results.
"""

from __future__ import annotations

import sys
from dataclasses import replace
from pathlib import Path

HERE = Path(__file__).parent
sys.path.insert(0, str(HERE.parent / "common"))
sys.path.insert(0, str(HERE))
import split_replay as sr  # noqa: E402
from run import SPEC  # noqa: E402

LEVELS = [500, 1000, 1500, 2000, 2500, 3500, 4000]
FIXED = ("N_dir", "S_dir")


def spec_for(level: int | None) -> sr.Spec:
    return SPEC if level is None else replace(SPEC, mtm=level, mtm_halves=("am",))


def fmt(x: float) -> str:
    return f"{x:+,.0f}"


def main() -> None:
    smoke = "--smoke" in sys.argv
    levels = (
        [int(x) for x in sys.argv[sys.argv.index("--levels") + 1].split(",")]
        if "--levels" in sys.argv
        else LEVELS
    )
    if "--analyse-only" not in sys.argv:
        for level in levels:
            print(f"== morning stop {level}", flush=True)
            sr.run_all(spec_for(level), smoke)
    if smoke:
        return
    rows = []
    for level in [None, *levels]:
        spec = spec_for(level)
        _, st = sr.analyse(spec)
        fixed = {f: sr.fixed_half(spec, f, "0917") for f in FIXED}
        rows.append((level, st, fixed))
    head = ["Morning stop", "AM net / mlot-day", "AM gross", "AM days in profit", "AM max DD",
            "AM stop hit / day", "Split − comparator net [90 %]", "Split max DD"]  # fmt: skip
    head += [f"{f} 09:17 AM net / DD / stopped" for f in FIXED]
    L = ["| " + " | ".join(head) + " |", "|" + "---|" * len(head)]
    for level, st, fixed in rows:
        am = st["per_lot"]["am"]
        m, lo, hi = st["diff"]["net"]
        label = "files (₹3,000)" if level is None else f"₹{level:,}"
        cells = [label, fmt(am["net"]), fmt(am["gross"]), f"{100 * st['in_profit']['am']:.0f} %",
                 fmt(st["dd"]["am"]), f"{st['stops_hit_per_day']['am']:.2f}",
                 f"{fmt(m)} [{fmt(lo)}, {fmt(hi)}]", fmt(st["dd"]["split"])]  # fmt: skip
        cells += [
            f"{fmt(v['net'])} / {fmt(v['dd'])} / {100 * v['stopped']:.0f} %" for v in fixed.values()
        ]
        L.append("| " + " | ".join(cells) + " |")
    text = "\n".join(L) + "\n"
    (SPEC.out / "morning_stops_summary.md").write_text(text)
    print(text)


if __name__ == "__main__":
    main()
