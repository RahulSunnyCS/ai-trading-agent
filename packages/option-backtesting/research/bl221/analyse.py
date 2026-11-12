"""BL-221: Friday against the other weekdays, per family and index, from replay.py's rows.

Every mean is over SESSIONS: a cell's strategy-days are first averaged within each session, then
the session means are averaged, and the standard error is over sessions (strategies on one day move
together, so strategy-days are not independent). A strategy-day whose replay does not reproduce the
stored slip-0.5 net (|diff| > ₹1) is left out and listed (BL-221 Phase 0).

    uv run python research/bl221/analyse.py [rows.csv.gz]
"""

from __future__ import annotations

import collections
import csv
import gzip
import math
import statistics as st
import sys
from pathlib import Path

OUT = Path(__file__).parent / "out"
BROKERAGE_PER_TRADE = 20 * 1.18 * 2  # rotation/lot_plans.py's rule
DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri"]
FAMILIES = ["Widesl", "Dir ATM", "Dir ITM1", "Buy"]
INDICES = ["NIFTY", "SENSEX"]
JAN_AUG, SEP_ON = "Jan–Aug 2025", "Sep 2025 – Nov 2026"
PERIOD = {"R-b": JAN_AUG, "R-c": SEP_ON}


def band(entry: str) -> str:
    return (
        "09:17-10:00" if entry <= "1000" else ("10:01-13:00" if entry <= "1300" else "13:01-15:17")
    )


def session_stats(rows, value) -> tuple[float, float, int]:
    by_day = collections.defaultdict(list)
    for r in rows:
        by_day[r["day"]].append(value(r))
    means = [st.mean(v) for v in by_day.values()]
    if not means:
        return math.nan, math.nan, 0
    se = st.stdev(means) / math.sqrt(len(means)) if len(means) > 1 else math.nan
    return st.mean(means), se, len(means)


def cell(rows, value) -> str:
    m, se, n = session_stats(rows, value)
    return "—" if n == 0 else f"{m:,.0f} ± {se:,.0f} ({n})"


def net(r) -> float:
    return float(r["net"])


def net_brk(r) -> float:
    return float(r["net"]) - BROKERAGE_PER_TRADE * int(r["n_trades"])


def main() -> None:
    src = Path(sys.argv[1]) if len(sys.argv) > 1 else max(OUT.glob("rows_2024-10-09_*.csv.gz"))
    every, bad, per_day = [], collections.Counter(), collections.Counter()
    with gzip.open(src, "rt") as fh:
        for r in csv.DictReader(fh):
            per_day[r["day"]] += 1
            if abs(float(r["net"]) - float(r["stored_net"])) > 1.0:
                bad[r["day"]] += 1
                r["_bad"] = True
            every.append(r)
    # A day with >= 5 % of its strategy-days not reproduced had its data changed after it was stored:
    # left out whole, so a session mean never mixes the two (clarified 2026-11-12, before the full read).
    whole = {d for d, n in bad.items() if n >= 0.05 * per_day[d]}
    rows = [r for r in every if r["day"] not in whole and not r.get("_bad")]
    # Owner, 2026-11-12: expiry Fridays out of every table. Every Friday from 2024-10-11 to 2025-01-03 was a
    # SENSEX expiry day, so that period (labelled R-a by replay.py) is left out whole; no later Friday was an
    # expiry day. Periods are named by their dates, not by letters.
    expiry_period = {r["day"] for r in rows if r["regime"] == "R-a"}
    rows = [dict(r, regime=PERIOD[r["regime"]]) for r in rows if r["regime"] != "R-a"]
    lines = [f"# BL-221 tables (from {src.name})", ""]
    lines.append(
        f"Strategy-days kept {len(rows):,}. Days left out whole (≥ 5 % not reproduced): "
        + (", ".join(f"{d} ({bad[d]}/{per_day[d]})" for d in sorted(whole)) or "none")
        + ". Single strategy-days left out: "
        + (", ".join(f"{d} ({n})" for d, n in sorted(bad.items()) if d not in whole) or "none")
        + "."
    )
    lines.append(
        f"Left out as the expiry-Friday period (2024-10-09 → 2025-01-09): {len(expiry_period)} sessions."
    )
    lines.append("")
    lines.append(
        "Cells: mean ± standard error (sessions), ₹ per strategy-day at 1 lot, 0.5 % slippage."
    )

    def emit(title, header, body):
        lines.extend(
            ["", f"## {title}", "", "| " + " | ".join(header) + " |", "|" + "---|" * len(header)]
        )
        lines.extend("| " + " | ".join(row) + " |" for row in body)

    for universe in ("core", "t1"):
        u = [r for r in rows if r["universe"] == universe]
        tag = "Core-298" if universe == "core" else "T1 extras (in-sample)"
        for reg in (JAN_AUG, SEP_ON):
            body = []
            for fam in FAMILIES:
                for idx in INDICES:
                    c = [
                        r
                        for r in u
                        if r["family"] == fam and r["index"] == idx and r["regime"] == reg
                    ]
                    if c:
                        body.append(
                            [f"{fam} {idx}"]
                            + [cell([r for r in c if r["weekday"] == d], net) for d in DAYS]
                        )
            emit(f"{tag}, {reg}: net by weekday", ["family"] + DAYS, body)

    core = [r for r in rows if r["universe"] == "core" and r["regime"] in (JAN_AUG, SEP_ON)]
    fri = [r for r in core if r["weekday"] == "Fri"]
    rest = [r for r in core if r["weekday"] != "Fri"]

    body = []
    for fam in FAMILIES:
        for idx in INDICES:
            f = [r for r in fri if r["family"] == fam and r["index"] == idx]
            o = [r for r in rest if r["family"] == fam and r["index"] == idx]
            body.append(
                [f"{fam} {idx}", cell(f, net), cell(o, net), cell(f, net_brk), cell(o, net_brk)]
            )
    emit(
        "Core-298, Jan 2025 – Nov 2026: Friday vs other days, before and after brokerage",
        ["family", "Fri net", "other net", "Fri after brokerage", "other after brokerage"],
        body,
    )

    body = []
    for fam in FAMILIES:
        for idx in INDICES:
            row = [f"{fam} {idx}"]
            for col in ("w_0915_1000", "w_1000_1300", "w_1300_close"):
                for part in (fri, rest):
                    c = [r for r in part if r["family"] == fam and r["index"] == idx]
                    row.append(cell(c, lambda r, k=col: float(r[k])))
            body.append(row)
    emit(
        "Core-298, Jan 2025 – Nov 2026: gross by session window (Friday | other)",
        [
            "family",
            "09:15-10:00 Fri",
            "other",
            "10:00-13:00 Fri",
            "other",
            "13:00-close Fri",
            "other",
        ],
        body,
    )

    body = []
    for fam in FAMILIES:
        for idx in INDICES:
            row = [f"{fam} {idx}"]
            for part in (fri, rest):
                c = [r for r in part if r["family"] == fam and r["index"] == idx]
                if not c:
                    row.append("—")
                    continue
                exits = collections.Counter()
                for r in c:
                    for item in filter(None, r["exits"].split(";")):
                        k, v = item.split(":")
                        exits[k] += int(v)
                total = sum(exits.values()) or 1
                mtm = sum(1 for r in c if r["stopped_by"]) / (len(c) or 1)
                row.append(
                    ", ".join(f"{k} {100 * v / total:.0f}%" for k, v in exits.most_common(4))
                    + f"; MTM stop {100 * mtm:.0f}% of days; trades/day {st.mean(int(r['n_trades']) for r in c):.2f}"
                )
            body.append(row)
    emit(
        "Core-298, Jan 2025 – Nov 2026: how trades exit (share of trades by reason)",
        ["family", "Friday", "other days"],
        body,
    )

    body = []
    for fam in FAMILIES:
        for idx in INDICES:
            row = [f"{fam} {idx}"]
            for part in (fri, rest):
                c = [
                    r
                    for r in part
                    if r["family"] == fam and r["index"] == idx and float(r["first_premium"]) > 0
                ]
                prem = st.median(float(r["first_premium"]) for r in c) if c else math.nan
                ratio = (
                    st.median(float(r["first_premium_exit"]) / float(r["first_premium"]) for r in c)
                    if c
                    else math.nan
                )
                row.append(f"premium {prem:,.0f}, exit/entry {ratio:.2f}")
            body.append(row)
    emit(
        "Core-298, Jan 2025 – Nov 2026: first-entry premium (median, points) and its value at exit",
        ["family", "Friday", "other days"],
        body,
    )

    body = []
    for fam in FAMILIES:
        for idx in INDICES:
            row = [f"{fam} {idx}"]
            for b in ("09:17-10:00", "10:01-13:00", "13:01-15:17"):
                for part in (fri, rest):
                    c = [
                        r
                        for r in part
                        if r["family"] == fam and r["index"] == idx and band(r["entry"]) == b
                    ]
                    row.append(cell(c, net))
            body.append(row)
    emit(
        "Core-298, Jan 2025 – Nov 2026: net by entry-time band (Friday | other)",
        ["family", "09:17-10:00 Fri", "other", "10:01-13:00 Fri", "other", "13:01- Fri", "other"],
        body,
    )

    body = []
    for reg in (JAN_AUG, SEP_ON):
        for d in DAYS:
            sess = {}
            for r in rows:
                if r["regime"] == reg and r["weekday"] == d and r["index"] == "NIFTY":
                    sess[r["day"]] = r
            vix = [float(r["vix_open"]) for r in sess.values() if r["vix_open"]]
            gap = [abs(float(r["gap_pct"])) for r in sess.values() if r["gap_pct"]]
            body.append(
                [
                    reg,
                    d,
                    str(len(sess)),
                    f"{st.mean(vix):.1f}" if vix else "—",
                    f"{st.median(gap):.2f}" if gap else "—",
                ]
            )
    emit(
        "Market context: sessions, mean opening VIX, median absolute NIFTY opening gap (%)",
        ["regime", "weekday", "sessions", "VIX open", "|gap| %"],
        body,
    )

    text = "\n".join(lines) + "\n"
    (OUT / "summary.md").write_text(text)
    print(text)


if __name__ == "__main__":
    main()
