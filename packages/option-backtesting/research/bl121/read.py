"""BL-121: the read-out, exactly as registered in Phase 0.

    uv run --with pandas python research/bl121/read.py

Reads out/events.csv and out/sims.csv. Cells: arm (R1, R2) x period (P2, P3), each judged separately.
Net = after Rs 20 an order. Writes out/readout.md and out/readout.json. A simulation that is missing is
left out and counted, never zero.
"""

from __future__ import annotations

import json
import math
from pathlib import Path

import numpy as np
import pandas as pd
from design import N_DRAWS, build
from rule import ARMS

HERE = Path(__file__).parent
FLOOR = 30
T_BAR = 2.5


def per_event(arm: str, d: dict, sims: dict) -> tuple[pd.DataFrame, np.ndarray]:
    k = arm.lower()
    ev = d["events"]
    rows = []
    draw_net = np.full(d["draws"].shape, np.nan)
    for i, r in enumerate(ev.to_dict("records")):
        entry = int(r[f"{k}_entry"])
        own = sims.get((r["day"], entry))
        pl = [sims[(p, entry)]["net20"] for p in d["placebo"][r["day"]] if (p, entry) in sims]
        for q in range(d["draws"].shape[0]):
            s = sims.get((r["day"], int(d["draws"][q, i])))
            if s is not None:
                draw_net[q, i] = s["net20"]
        rows.append(
            {
                "day": r["day"],
                "dte": int(r["dte"]),
                "entry": entry,
                "high_minus_s0": r["high_minus_s0"],
                "switches": r[f"{k}_switches"],
                "outcome": own["outcome"] if own else None,
                "net20": own["net20"] if own else np.nan,
                "net0": own["net0"] if own else np.nan,
                "placebo_n": len(pl),
                "placebo_net20": float(np.mean(pl)) if pl else np.nan,
            }
        )
    df = pd.DataFrame(rows)
    df["diff"] = df.net20 - df.placebo_net20
    return df, draw_net


def tstat(x: pd.Series) -> float:
    x = x.dropna()
    if len(x) < 2 or x.std(ddof=1) == 0:
        return float("nan")
    return float(x.mean() / (x.std(ddof=1) / math.sqrt(len(x))))


def cell(df: pd.DataFrame, draw_net: np.ndarray, mask: np.ndarray | None = None) -> dict:
    if mask is not None:
        df, draw_net = df[mask], draw_net[:, mask]
    n = int(df.net20.notna().sum())
    nan = float("nan")
    if not n:
        return {"n": 0}
    win, loss = df.net20[df.net20 > 0], df.net20[df.net20 <= 0]
    dm = np.nanmean(draw_net, axis=1)
    mean = float(df.net20.mean())
    return {
        "n": n,
        "mean_net20": mean,
        "mean_net0": float(df.net0.mean()),
        "win_rate": float((df.net20 > 0).mean()),
        "mean_win": float(win.mean()) if len(win) else nan,
        "mean_loss": float(loss.mean()) if len(loss) else nan,
        "share_both_sl": float((df.outcome == "BOTH_SL").mean()),
        "share_one_sl": float((df.outcome == "ONE_SL").mean()),
        "share_held": float((df.outcome == "HELD").mean()),
        "placebo_mean": float(df.placebo_net20.mean()),
        "placebo_n_median": float(df.placebo_n.median()),
        "diff_mean": float(df["diff"].mean()),
        "diff_t": tstat(df["diff"]),
        "random_p95": float(np.nanpercentile(dm, 95)),
        "random_mean": float(np.nanmean(dm)),
        "share_draws_below_event": float((dm < mean).mean()),
    }


def tests(c: dict) -> dict[str, bool]:
    return {
        "1 mean net > 0": c["mean_net20"] > 0,
        f"2 diff > 0 with t >= {T_BAR}": c["diff_mean"] > 0 and c["diff_t"] >= T_BAR,
        "3 event mean above random-minute P95": c["mean_net20"] > c["random_p95"],
    }


def verdict(p2: dict, p3: dict) -> tuple[str, str]:
    if p2["n"] < FLOOR or p3["n"] < FLOOR:
        return "inconclusive", f"a cell has fewer than {FLOOR} events (P2 {p2['n']}, P3 {p3['n']})"
    for name, c in (("P2", p2), ("P3", p3)):
        if c["mean_net20"] <= 0 or c["diff_mean"] <= 0:
            return "killed", f"{name}: mean net or event-minus-placebo is not positive"
    failed = [f"{n} {k}" for n, c in (("P2", p2), ("P3", p3)) for k, v in tests(c).items() if not v]
    if not failed:
        return "pass (screen)", "all three tests in P2 and in P3"
    return "inconclusive", "positive in both periods but failed: " + "; ".join(failed)


def fmt(v: float, nd: int = 0) -> str:
    return "n/a" if v is None or (isinstance(v, float) and math.isnan(v)) else f"{v:,.{nd}f}"


def row(name: str, c: dict) -> str:
    return (
        f"| {name} | {c['n']} | {fmt(c['mean_net20'])} | {fmt(c['mean_net0'])} | "
        f"{fmt(100 * c['win_rate'])}% | {fmt(c['mean_win'])} / {fmt(c['mean_loss'])} | "
        f"{fmt(100 * c['share_held'])} / {fmt(100 * c['share_one_sl'])} / {fmt(100 * c['share_both_sl'])} | "
        f"{fmt(c['placebo_mean'])} | {fmt(c['diff_mean'])} | {fmt(c['diff_t'], 2)} | "
        f"{fmt(c['random_p95'])} | {fmt(100 * c['share_draws_below_event'])}% |"
    )


def main() -> int:
    events = pd.read_csv(HERE / "out" / "events.csv")
    sims_df = pd.read_csv(HERE / "out" / "sims.csv")
    sims_df = sims_df[sims_df.err.isna() & (sims_df.outcome != "NO_ENTRY")]
    sims = {(r["day"], int(r["minute"])): r for r in sims_df.to_dict("records")}
    design = build(events)

    head = (
        "| cell | events | mean net | mean gross | win rate | mean win / loss | held / 1 stopped / 2 stopped (%) | "
        "placebo mean | event - placebo | t | random-minute P95 | draws below event |\n"
        "|---|---|---|---|---|---|---|---|---|---|---|---|"
    )
    lines = [
        "# BL-121 read-out (rupees per long straddle, after Rs 20 an order; gross has no cost)\n",
        head,
    ]
    results, dfs = {}, {}
    for arm in ARMS:
        cs = {}
        for period in ("P2", "P3"):
            df, dn = per_event(arm, design[(arm, period)], sims)
            cs[period] = cell(df, dn)
            dfs[(arm, period)] = (df, dn)
            lines.append(row(f"{arm} {period}", cs[period]))
        v, why = verdict(cs["P2"], cs["P3"])
        results[arm] = {"verdict": v, "why": why, "P2": cs["P2"], "P3": cs["P3"]}
    lines.append("")
    for arm in ARMS:
        lines.append(f"**{arm}: {results[arm]['verdict']}** ({results[arm]['why']}).")
    lines += [
        "",
        f"Random-minute draws: {N_DRAWS} per cell. t bar {T_BAR} (two arms), floor {FLOOR} events.",
        "",
    ]
    lines.append("## Description only (not judged)\n")
    for arm in ARMS:
        for period in ("P2", "P3"):
            df, dn = dfs[(arm, period)]
            lines.append(f"### {arm} {period}\n")
            lines.append(
                "| split | events | mean net | win rate | event - placebo |\n|---|---|---|---|---|"
            )
            df = df.assign(year=df.day.str[:4])
            splits = {
                "entry before 10:30": (df.entry < 75).to_numpy(),
                "entry 10:30 to 12:00": ((df.entry >= 75) & (df.entry < 165)).to_numpy(),
                "entry 12:00 or later": (df.entry >= 165).to_numpy(),
                "H - S0 >= 10 already at 09:30": (df.high_minus_s0 >= 10).to_numpy(),
                "H - S0 < 10 at 09:30": (df.high_minus_s0 < 10).to_numpy(),
                "expiry day": (df.dte == 0).to_numpy(),
                "not expiry day": (df.dte > 0).to_numpy(),
            }
            for y in sorted(df.year.unique()):
                splits[f"year {y}"] = (df.year == y).to_numpy()
            for k, m in splits.items():
                if m.sum():
                    c = cell(df, dn, m)
                    lines.append(
                        f"| {k} | {c['n']} | {fmt(c['mean_net20'])} | {fmt(100 * c['win_rate'])}% | {fmt(c['diff_mean'])} |"
                    )
            lines.append(
                f"\nStrike switches in the window, median {df.switches.median():.0f}; entry minute median index {int(df.entry.median())}.\n"
            )
    out = HERE / "out"
    (out / "readout.md").write_text("\n".join(lines))
    (out / "readout.json").write_text(json.dumps(results, indent=1, default=str))
    print("\n".join(lines))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
