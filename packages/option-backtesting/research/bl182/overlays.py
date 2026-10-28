"""BL-182 E3: profit targets and profit locks on the morning sets (owner override, descriptive).

    uv run python research/bl182/overlays.py [--smoke] [--analyse-only]

Simulates the morning variants once at their files' stop keeping each day's MTM path
(`split_replay.simulate_paths`), applies every target and lock to the paths (`apply_overlay`,
as the engine applies an overall target), re-runs the ranking per overlay and prints one row an
overlay: Adaptive's morning book alone, the split against the comparator, and the fixed 09:17
morning halves. The plain morning (no overlay) is the registered run.
"""

from __future__ import annotations

import sys
import tempfile
from dataclasses import replace
from pathlib import Path

HERE = Path(__file__).parent
sys.path.insert(0, str(HERE.parent / "common"))
sys.path.insert(0, str(HERE))
import split_replay as sr  # noqa: E402
from phase2_spec import SPEC  # noqa: E402

TARGETS = [500, 750, 1000, 1250, 1500, 1750, 2000, 2250, 2500, 3000, 4000]
LOCKS = [(2000, 1000), (3000, 1500), (3000, 2000), (4000, 2000), (4000, 3000)]
LOCKTRAILS = [
    (2000, 1, 100),
    (3000, 1, 100),
    (4000, 1, 100),
]  # arm, lock (1 = breakeven: 0 reads as none), 1:1 step
OVERLAYS = (
    [f"tgt{t}" for t in TARGETS]
    + [f"lock{a}-{b}" for a, b in LOCKS]
    + [f"lt{a}-{b}-{s}" for a, b, s in LOCKTRAILS]
)
FIXED = ("N_wide", "S_wide")


def fmt(x: float) -> str:
    return f"{x:+,.0f}"


def main() -> None:
    smoke = "--smoke" in sys.argv
    am = {n: (u, p) for n, (u, p) in sr.make_variants(SPEC).items() if "-am_" in n}
    spec = SPEC
    if smoke:  # a scratch folder, so nothing of the registered run is touched
        spec = replace(SPEC, here=Path(tempfile.mkdtemp(prefix="overlays-smoke-")))
        spec.results_half.mkdir(exist_ok=True)
    if "--analyse-only" not in sys.argv:
        for underlying in ("NIFTY", "SENSEX"):
            todo = {
                n: p
                for n, (u, p) in am.items()
                if u == underlying and not (spec.paths_dir / f"{n}.npz").exists()
            }
            if smoke:
                todo = dict(list(todo.items())[:2])
            if todo:
                print(f"{underlying}: {len(todo)} morning variants with paths", flush=True)
                hi = sr.date(2024, 10, 16) if smoke else sr.END
                sr.simulate_paths(spec, underlying, todo, hi=hi)
        if smoke:
            z = sr.np.load(next(spec.paths_dir.glob("*.npz")))
            print("smoke paths", z["path"].shape, "last values", z["path"][:, -1][:3])
            for ov in ("tgt1000", "lock2000-1000"):
                o = sr.replace_overlay(spec, ov)
                sr.write_overlay(o, list(todo))
                first = next(iter(todo))
                print(
                    ov,
                    [
                        r["gross"] + "/" + r["stopped_by"]
                        for r in list(sr.read(o, first).values())[:6]
                    ],
                )
            return
        for ov in OVERLAYS:
            sr.write_overlay(sr.replace_overlay(SPEC, ov), list(am))
    rows = []
    for ov in [None, *OVERLAYS]:
        spec = sr.replace_overlay(SPEC, ov)
        _, st = sr.analyse(spec)
        fixed = {f: sr.fixed_half(spec, f, "0917") for f in FIXED}
        rows.append((ov, st, fixed))
    head = ["Morning overlay", "AM net / mlot-day", "AM gross", "AM days in profit", "AM max DD",
            "AM fired / day", "Split − comparator net [90 %]", "Split max DD"]  # fmt: skip
    head += [f"{f} 09:17 AM net / DD / fired" for f in FIXED]
    L = ["| " + " | ".join(head) + " |", "|" + "---|" * len(head)]
    for ov, st, fixed in rows:
        a = st["per_lot"]["am"]
        m, lo, hi = st["diff"]["net"]
        if ov is None:
            label = "plain (files' stop)"
        elif ov.startswith("tgt"):
            label = f"target ₹{int(ov[3:]):,}"
        elif ov.startswith("lt"):
            a_, b_, st_ = ov[2:].split("-")
            label = f"lock-trail: at ₹{int(a_):,} lock ₹{int(b_):,}, then 1:1 (₹{st_} steps)"
        else:
            a_, b_ = ov[4:].split("-")
            label = f"lock: at ₹{int(a_):,} lock ₹{int(b_):,}"
        cells = [label, fmt(a["net"]), fmt(a["gross"]), f"{100 * st['in_profit']['am']:.0f} %",
                 fmt(st["dd"]["am"]), f"{st['stops_hit_per_day']['am']:.2f}",
                 f"{fmt(m)} [{fmt(lo)}, {fmt(hi)}]", fmt(st["dd"]["split"])]  # fmt: skip
        cells += [
            f"{fmt(v['net'])} / {fmt(v['dd'])} / {100 * v['stopped']:.0f} %" for v in fixed.values()
        ]
        L.append("| " + " | ".join(cells) + " |")
    text = "\n".join(L) + "\n"
    (SPEC.out / "morning_overlays_summary.md").write_text(text)
    print(text)


if __name__ == "__main__":
    main()
