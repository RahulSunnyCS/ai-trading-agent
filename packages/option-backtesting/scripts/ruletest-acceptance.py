"""BL-120 Phase 1 acceptance: the rule tester against BL-083's own research outputs.

    TRADING_DATA_ROOT=... uv run python scripts/ruletest-acceptance.py \
        [--rules t1,t2,t3,t4] [--trades]
        [--workers 4] [--research research/bl083/out/triggers.csv]
        [--events research/bl083/out/event_rows.csv]

1. FIRINGS: each of BL-083's four triggers, said in the rule grammar (tests/fixtures/rules/),
   fires on the same days at the same stamps as research/bl083/triggers.py, for every (set, index)
   it covers.
2. TRADES (--trades, T1 and T4): the Dir template entered at those events and at their placebo days
   gives the same gross P&L as the research event study's rows (research/bl083/out/event_rows.csv),
   to the rupee, and so the same event-minus-placebo.

Prints ACCEPTANCE OK when every compared item matches, else the differences and exit 1. The research
outputs are git-ignored; regenerate them with research/bl083/triggers.py, simulate.py and
event_study.py.
"""

from __future__ import annotations

import csv
import sys
from pathlib import Path

import numpy as np
import yaml

from option_backtesting.fyers.daily import data_dir
from option_backtesting.legwise.market import backtest_days
from option_backtesting.ruletest import frame as F
from option_backtesting.ruletest import sim, study
from option_backtesting.ruletest.spec import from_dict

HERE = Path(__file__).parent
FIXTURES = HERE.parent / "tests" / "fixtures" / "rules"
SETS = {"explore": study.PERIODS["learning"], "confirm": study.PERIODS["confirmation"]}


def arg(name: str, default: str) -> str:
    return sys.argv[sys.argv.index(name) + 1] if name in sys.argv else default


def rule_for(trigger: str, underlying: str):
    data = yaml.safe_load((FIXTURES / f"bl083_{trigger.lower()}_dir.yaml").read_text())["rule"]
    data["underlying"] = underlying
    return from_dict(data)


def main() -> int:
    triggers = [t.upper() for t in arg("--rules", "t1,t2,t3,t4").split(",")]
    workers = int(arg("--workers", "4"))
    root = data_dir()
    research = Path(arg("--research", str(HERE.parent / "research/bl083/out/triggers.csv")))
    events_csv = Path(arg("--events", str(HERE.parent / "research/bl083/out/event_rows.csv")))
    theirs: dict[tuple, int] = {}
    with research.open() as f:
        for r in csv.DictReader(f):
            theirs[(r["set"], r["underlying"], r["trigger"], r["day"])] = int(r["stamp"])
    bad = 0
    frames: dict[str, object] = {}
    for und in ("NIFTY", "SENSEX"):
        frames[und] = F.load_frame(root, und, study.DATA_CUTOFF)
        print(f"{und}: {len(frames[und].days)} sessions loaded", flush=True)
    for trig in triggers:
        for und in ("NIFTY", "SENSEX"):
            rule = rule_for(trig, und)
            for set_name, (lo, hi) in SETS.items():
                if set_name == "confirm" and und != "NIFTY":
                    continue
                events, _ = study.find_events(rule, frames[und], lo, hi)
                mine = {e["day"]: e["stamp"] for e in events}
                ref = {
                    k[3]: v
                    for k, v in theirs.items()
                    if k[0] == set_name and k[1] == und and k[2] == trig
                }
                missing = sorted(set(ref) - set(mine))
                extra = sorted(set(mine) - set(ref))
                moved = sorted(d for d in set(ref) & set(mine) if ref[d] != mine[d])
                ok = not (missing or extra or moved)
                bad += not ok
                print(
                    f"{trig} {und} {set_name}: research {len(ref)}, tester {len(mine)}"
                    f" -> {'same' if ok else f'MISSING {missing[:3]} EXTRA {extra[:3]} MOVED {moved[:3]}'}",  # noqa: E501
                    flush=True,
                )
    if "--trades" in sys.argv:
        ev_rows: dict[tuple, dict] = {}
        with events_csv.open() as f:
            for r in csv.DictReader(f):
                if r["template"] == "dir":
                    ev_rows[(r["set"], r["underlying"], r["trigger"], r["day"])] = r
        for trig in [t for t in triggers if t in ("T1", "T4")]:
            for set_name, (lo, hi) in SETS.items():
                und = "NIFTY"
                rule = rule_for(trig, und)
                days = [d.isoformat() for d in backtest_days(root, und, lo, hi)[0]]
                events, fired = study.find_events(rule, frames[und], lo, hi)
                events = [e for e in events if e["day"] in set(days)]
                wanted = set()
                for e in events:
                    wanted.add((e["day"], e["entry"], e["side"], 0.0))
                    for p in study.placebo_days(e["day"], days, fired):
                        wanted.add((p, e["entry"], e["side"], 0.0))
                got = sim.ensure(root, rule, wanted, workers, print)
                diffs, off = [], 0
                for e in events:
                    row = got.get((e["day"], e["entry"], e["side"], 0.0))
                    plc = [
                        float(got[(p, e["entry"], e["side"], 0.0)]["gross"])
                        for p in study.placebo_days(e["day"], days, fired)
                        if (p, e["entry"], e["side"], 0.0) in got
                    ]
                    ref = ev_rows.get((set_name, und, trig, e["day"]))
                    if row is None or ref is None or len(plc) < 10:
                        off += 1
                        continue
                    mine_event, mine_placebo = float(row["gross"]), float(np.mean(plc))
                    if (
                        abs(mine_event - float(ref["event"])) > 0.011
                        or abs(mine_placebo - float(ref["placebo"])) > 0.011
                    ):
                        off += 1
                        if off <= 3:
                            print(
                                f"  differs {e['day']}: {mine_event:.2f}/{mine_placebo:.2f}"
                                f" vs {ref['event']}/{ref['placebo']}"
                            )
                    diffs.append(mine_event - mine_placebo)
                mean, t = study.day_t({str(i): d for i, d in enumerate(diffs)})
                bad += bool(off)
                print(
                    f"{trig} Dir {und} {set_name}: {len(events)} events,"
                    f" {off} not equal to the research rows;"
                    f" event minus placebo {mean:+.0f} (t {t if t is None else round(t, 2)})",
                    flush=True,
                )
    print("ACCEPTANCE OK" if not bad else f"ACCEPTANCE FAILED ({bad} mismatches)")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
