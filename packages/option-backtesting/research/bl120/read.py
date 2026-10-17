"""BL-120 block 2: the read-out, exactly as registered in Phase 0b.

    uv run --with pandas python research/bl120/read.py

Reads out/events_b.csv and out/sims_b.csv. Judged cell: NIFTY, P2 and P3 pooled. SENSEX P2 is reported
and never judged. Net = after Rs 20 an order. Writes out/readout_b.md and out/readout_b.json.
A simulation that is missing is left out and counted, never zero.
"""

from __future__ import annotations

import json
import math
from pathlib import Path

import numpy as np
import pandas as pd
from design import N_DRAWS, build

HERE = Path(__file__).parent
FLOOR = 30
T_BAR = 2.0


def label(m: int) -> str:
    t = 9 * 60 + 15 + int(m)
    return f"{t // 60:02d}:{t % 60:02d}"


def per_event(und: str, d: dict, sims: dict) -> tuple[pd.DataFrame, np.ndarray]:
    ev = d["events"]
    rows = []
    draw_net = np.full(d["draws"].shape, np.nan)
    missing = 0
    for i, r in enumerate(ev.itertuples()):
        own = sims.get((und, r.day, int(r.entry)))
        if own is None:
            missing += 1
        pl = [
            sims[(und, p, int(r.entry))]["net20"]
            for p in d["placebo"][(r.period, r.day)]
            if (und, p, int(r.entry)) in sims
        ]
        for k in range(d["draws"].shape[0]):
            s = sims.get((und, r.day, int(d["draws"][k, i])))
            if s is not None:
                draw_net[k, i] = s["net20"]
        rows.append(
            {
                "period": r.period,
                "day": r.day,
                "dte": int(r.dte),
                "entry": int(r.entry),
                "held_before_1430": int(r.held_before_1430),
                "switches": int(r.switches),
                "outcome": own["outcome"] if own else None,
                "net20": own["net20"] if own else np.nan,
                "net0": own["net0"] if own else np.nan,
                "placebo_n": len(pl),
                "placebo_net20": float(np.mean(pl)) if pl else np.nan,
            }
        )
    df = pd.DataFrame(rows)
    df["diff"] = df.net20 - df.placebo_net20
    df.attrs["missing_own"] = missing
    return df, draw_net


def tstat(x: pd.Series) -> float:
    x = x.dropna()
    if len(x) < 2 or x.std(ddof=1) == 0:
        return float("nan")
    return float(x.mean() / (x.std(ddof=1) / math.sqrt(len(x))))


def cell(df: pd.DataFrame, draw_net: np.ndarray, mask: np.ndarray | None = None) -> dict:
    if mask is not None:
        df = df[mask]
        draw_net = draw_net[:, mask]
    n = int(df.net20.notna().sum())
    win = df.net20[df.net20 > 0]
    loss = df.net20[df.net20 <= 0]
    draw_means = np.nanmean(draw_net, axis=1) if n else np.array([np.nan])
    mean = float(df.net20.mean()) if n else float("nan")
    p95 = float(np.nanpercentile(draw_means, 95)) if n else float("nan")
    return {
        "n": n,
        "mean_net20": mean,
        "mean_net0": float(df.net0.mean()) if n else float("nan"),
        "win_rate": float((df.net20 > 0).mean()) if n else float("nan"),
        "mean_win": float(win.mean()) if len(win) else float("nan"),
        "mean_loss": float(loss.mean()) if len(loss) else float("nan"),
        "share_overall_sl": float((df.outcome == "OVERALL_SL").mean()) if n else float("nan"),
        "placebo_mean": float(df.placebo_net20.mean()) if n else float("nan"),
        "placebo_n_median": float(df.placebo_n.median()) if n else float("nan"),
        "diff_mean": float(df["diff"].mean()) if n else float("nan"),
        "diff_t": tstat(df["diff"]),
        "random_p95": p95,
        "random_mean": float(np.nanmean(draw_means)) if n else float("nan"),
        "share_draws_below_event": float((draw_means < mean).mean()) if n else float("nan"),
    }


def verdict(pooled: dict, p2: dict, p3: dict) -> tuple[str, str]:
    if pooled["n"] < FLOOR:
        return "inconclusive", f"{pooled['n']} events, below the floor of {FLOOR}"
    if pooled["mean_net20"] <= 0 or pooled["diff_mean"] <= 0:
        return "killed", "mean net or event-minus-placebo is not positive in the pooled cell"
    tests = {
        "1 mean net > 0": pooled["mean_net20"] > 0,
        f"2 diff > 0 with t >= {T_BAR}": pooled["diff_mean"] > 0 and pooled["diff_t"] >= T_BAR,
        "3 event mean above random-minute P95": pooled["mean_net20"] > pooled["random_p95"],
        "P2 sign (mean > 0, diff > 0)": p2["mean_net20"] > 0 and p2["diff_mean"] > 0,
        "P3 sign (mean > 0, diff > 0)": p3["mean_net20"] > 0 and p3["diff_mean"] > 0,
    }
    if all(tests.values()):
        return "pass (screen)", "; ".join(tests)
    failed = [k for k, v in tests.items() if not v]
    return "inconclusive", "positive but not all tests hold: failed " + ", ".join(failed)


def fmt(v: float, nd: int = 0) -> str:
    return "n/a" if v is None or (isinstance(v, float) and math.isnan(v)) else f"{v:,.{nd}f}"


def row(name: str, c: dict) -> str:
    return (
        f"| {name} | {c['n']} | {fmt(c['mean_net20'])} | {fmt(c['mean_net0'])} | "
        f"{fmt(100 * c['win_rate'], 0)}% | {fmt(c['mean_win'])} / {fmt(c['mean_loss'])} | "
        f"{fmt(100 * c['share_overall_sl'], 0)}% | {fmt(c['placebo_mean'])} | {fmt(c['diff_mean'])} | "
        f"{fmt(c['diff_t'], 2)} | {fmt(c['random_p95'])} | {fmt(100 * c['share_draws_below_event'], 0)}% |"
    )


def main() -> int:
    events = pd.read_csv(HERE / "out" / "events_b.csv")
    sims_df = pd.read_csv(HERE / "out" / "sims_b.csv")
    sims_df = sims_df[sims_df.err.isna() & (sims_df.outcome != "NO_ENTRY")]
    sims = {(r["underlying"], r["day"], int(r["minute"])): r for r in sims_df.to_dict("records")}
    design = build(events)
    nifty, nd = per_event("NIFTY", design["NIFTY"], sims)
    sensex, sd = per_event("SENSEX", design["SENSEX"], sims)

    pooled = cell(nifty, nd)
    p2 = cell(nifty, nd, (nifty.period == "P2").to_numpy())
    p3 = cell(nifty, nd, (nifty.period == "P3").to_numpy())
    sx = cell(sensex, sd)
    v, why = verdict(pooled, p2, p3)

    head = (
        "| cell | events | mean net | mean gross | win rate | mean win / loss | stopped | placebo mean | "
        "event - placebo | t | random-minute P95 | draws below event |\n|---|---|---|---|---|---|---|---|---|---|---|---|"
    )
    lines = [
        "# BL-120 block 2 read-out (rupees per Widesl strategy, after Rs 20 an order; gross has no cost)\n",
        head,
        row("NIFTY P2 + P3 pooled (judged)", pooled),
        row("NIFTY P2 (sign check)", p2),
        row("NIFTY P3 (sign check)", p3),
        row("SENSEX P2 (reported, not judged)", sx),
        "",
        f"**Verdict, NIFTY pooled: {v}** ({why}). SENSEX: reported only ({sx['n']} events).",
        f"Missing own simulations: NIFTY {nifty.attrs['missing_own']}, SENSEX {sensex.attrs['missing_own']}.",
        f"Random-minute draws: {N_DRAWS} per cell, drawn from the pooled events' own entry minutes.",
        "",
        "## Description only (not judged)\n",
    ]
    for name, df, dn in (("NIFTY", nifty, nd), ("SENSEX", sensex, sd)):
        lines.append(f"### {name}\n")
        lines.append(
            "| split | events | mean net | win rate | event - placebo |\n|---|---|---|---|---|"
        )
        splits = {
            "expiry day": (df.dte == 0).to_numpy(),
            "not expiry day": (df.dte > 0).to_numpy(),
            "hold completed before 14:30": (df.held_before_1430 == 1).to_numpy(),
            "hold completed at or after 14:30": (df.held_before_1430 == 0).to_numpy(),
            "entry before 14:45": (df.entry < 330).to_numpy(),
            "entry 14:45 or later": (df.entry >= 330).to_numpy(),
        }
        df = df.assign(year=df.day.str[:4])
        for y in sorted(df.year.unique()):
            splits[f"year {y}"] = (df.year == y).to_numpy()
        for k, m in splits.items():
            if m.sum():
                c = cell(df, dn, m)
                lines.append(
                    f"| {k} | {c['n']} | {fmt(c['mean_net20'])} | {fmt(100 * c['win_rate'], 0)}% | {fmt(c['diff_mean'])} |"
                )
        em = df.entry
        lines.append(
            f"\nEntry minute: earliest {label(em.min())}, median {label(int(em.median()))}, latest {label(em.max())}; "
            f"strike switches in the window, median {df.switches.median():.0f}.\n"
        )
        lines.append(
            "Outcomes: "
            + ", ".join(f"{k} {v}" for k, v in df.outcome.value_counts().items())
            + "\n"
        )
    out = HERE / "out"
    (out / "readout_b.md").write_text("\n".join(lines))
    (out / "readout_b.json").write_text(
        json.dumps(
            {"verdict": v, "why": why, "pooled": pooled, "p2": p2, "p3": p3, "sensex": sx},
            indent=1,
            default=str,
        )
    )
    nifty.assign(underlying="NIFTY").to_csv(out / "events_b_pnl_nifty.csv", index=False)
    sensex.assign(underlying="SENSEX").to_csv(out / "events_b_pnl_sensex.csv", index=False)
    print("\n".join(lines))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
