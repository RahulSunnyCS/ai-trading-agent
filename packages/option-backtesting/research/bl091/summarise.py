"""BL-091 Phase 1: the census and R0 tables (counts only; no rule, no interpretation).

    uv run --with pandas python research/bl091/summarise.py

Reads out/days.csv, out/episodes.csv and results/r0_attempts.csv; writes out/census.md and
out/r0_summary.md. Every table is split by period x index. Rupees are per Widesl strategy (one of
the owner's four), net0 at the engine's cost 0, net20 at an assumed ₹20 per order.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pandas as pd

HERE = Path(__file__).parent
OUT = HERE / "out"
GROUP = ["period", "underlying"]


def md(df: pd.DataFrame, index: bool = True) -> str:
    if index:
        df = df.reset_index()
    cols = [str(c) for c in df.columns]
    lines = ["| " + " | ".join(cols) + " |", "|" + "---|" * len(cols)]
    for row in df.itertuples(index=False):
        cells = []
        for v in row:
            if isinstance(v, float):
                cells.append("" if pd.isna(v) else f"{v:,.1f}" if abs(v) < 1e6 else f"{v:,.0f}")
            else:
                cells.append(str(v))
        lines.append("| " + " | ".join(cells) + " |")
    return "\n".join(lines)


def crosstab(df: pd.DataFrame, col: str) -> pd.DataFrame:
    return pd.crosstab([df.period, df.underlying], df[col])


def census(days: pd.DataFrame, eps: pd.DataFrame) -> str:
    out = ["# BL-091 Phase 1 — episode census (P2 + P3)", ""]
    loaded = days[days.status == "loaded"]
    cov = days.groupby(GROUP).agg(
        index_days=("day", "count"),
        loaded=("status", lambda s: (s == "loaded").sum()),
        skipped=("status", lambda s: (s != "loaded").sum()),
    )
    cov["episodes"] = eps.groupby(GROUP).size()
    cov["episodes_per_day"] = cov.episodes / cov.loaded
    out += ["## Coverage", "", md(cov), ""]
    reasons = days[days.status != "loaded"].groupby([*GROUP, "reason"]).size().rename("days")
    if len(reasons):
        out += ["Skipped days by reason:", "", md(reasons.to_frame()), ""]
    per_day = loaded.assign(
        n=loaded.n_episodes.clip(upper=3).astype(int).astype(str).replace("3", "3+")
    )
    out += ["## Days by number of episodes", "", md(crosstab(per_day, "n")), ""]
    if eps.empty:
        out.append("No episodes.")
        return "\n".join(out)
    out += ["## Outcome", "", md(crosstab(eps, "outcome")), ""]
    out += ["## Episodes by days to expiry", "", md(crosstab(eps, "dte_label")), ""]
    out += ["## Outcome by days to expiry", "",
            md(pd.crosstab([eps.period, eps.underlying, eps.dte_label], eps.outcome)), ""]  # fmt: skip
    out += ["## Episodes by trigger hour", "", md(crosstab(eps, "trigger_hour")), ""]
    out += ["## Outcome by trigger hour", "",
            md(pd.crosstab([eps.period, eps.underlying, eps.trigger_hour], eps.outcome)), ""]  # fmt: skip
    q = eps.groupby(GROUP).rise.describe(percentiles=[0.1, 0.25, 0.5, 0.75, 0.9])
    out += [
        "## Rise in points (low to high)",
        "",
        md(q[["count", "10%", "25%", "50%", "75%", "90%", "max"]]),
        "",
    ]
    bins = pd.cut(
        eps.rise, [25, 40, 60, 100, 1e9], right=False, labels=["25-40", "40-60", "60-100", "100+"]
    )
    out += ["Rise buckets:", "", md(pd.crosstab([eps.period, eps.underlying], bins)), ""]
    out += ["## Episodes by VIX band at the open", "", md(crosstab(eps, "vix_band")), ""]
    dec = eps[eps.outcome == "decayed"].copy()
    if len(dec):

        def half_hour(col: str) -> pd.Series:
            m = dec[col].astype(int) + 555
            return ((m // 30) * 30).map(lambda t: f"{t // 60:02d}:{t % 60:02d}")

        dec["high_half_hour"] = half_hour("high_min")
        dec["decay_half_hour"] = half_hour("decay_min")
        out += [
            "## Decayed episodes: half-hour of the high",
            "",
            md(crosstab(dec, "high_half_hour")),
            "",
        ]
        out += ["## Decayed episodes: half-hour the 15-point give-back was reached", "",
                md(crosstab(dec, "decay_half_hour")), ""]  # fmt: skip
        late = dec.groupby(GROUP).apply(lambda g: pd.Series({
            "decayed": len(g),
            "high_at_or_after_1430": int((g.high_min >= 315).sum()),
            "giveback_at_or_after_1430": int((g.decay_min >= 315).sum()),
        }), include_groups=False)  # fmt: skip
        out += ["Share at or after 14:30:", "", md(late), ""]
    out += ["## NIFTY / SENSEX path after the high, by outcome", "",
            md(pd.crosstab([eps.period, eps.underlying, eps.outcome], eps.spot_path)), ""]  # fmt: skip
    moves = eps.groupby([*GROUP, "outcome"]).agg(
        median_spot_move_in_rise=("spot_move_rise", "median"),
        median_spot_move_after_high=("spot_move_after", "median"),
        median_giveback=("giveback", "median"),
    )
    out += ["Medians (points):", "", md(moves), ""]
    qual = eps.groupby(GROUP).agg(
        episodes=("day", "count"),
        with_stale=("stale_minutes", lambda s: int((s > 0).sum())),
        with_fallback=("n_fallbacks", lambda s: int((s > 0).sum())),
        with_missing=("missing_minutes", lambda s: int((s > 0).sum())),
        median_switches=("n_switches", "median"),
        late_trigger=("late_trigger", lambda s: int(s.astype(bool).sum())),
    )
    out += ["## Data quality inside episodes", "", md(qual), ""]
    return "\n".join(out)


def r0_summary(eps: pd.DataFrame, att: pd.DataFrame) -> str:
    out = ["# BL-091 Phase 1 — R0 replay (the owner's re-entry habit, ₹650 MTM stop per Widesl)", "",
           "Rupees per Widesl strategy (the owner runs four). net0 = engine cost 0; net20 = ₹20 per order (assumption).",
           ""]  # fmt: skip
    key = [*GROUP, "day", "episode_idx"]
    att = att[att.outcome != "ERR"].copy()
    att = att.sort_values([*key, "attempt"])
    eps = eps[~eps.late_trigger.astype(bool)]
    per_ep = (
        att.groupby(key)
        .agg(
            attempts=("attempt", "max"),
            held=("outcome", lambda s: int((s == "HELD").any())),
            last=("outcome", "last"),
            net0=("net0", "sum"),
            net20=("net20", "sum"),
            first_entry=("entry_min", "min"),
            last_exit=("exit_min", "max"),
        )
        .reset_index()
    )
    out += [f"Episodes (trigger before 15:12): {len(eps)}; replayed: {len(per_ep)}.", ""]
    out += [
        "## Attempts per episode",
        "",
        md(pd.crosstab([per_ep.period, per_ep.underlying], per_ep.attempts)),
        "",
    ]
    out += [
        "## Attempt outcomes",
        "",
        md(pd.crosstab([att.period, att.underlying], att.outcome)),
        "",
    ]
    by_k = att.groupby([*GROUP, "attempt"]).agg(
        attempts=("outcome", "size"),
        held=("outcome", lambda s: int((s == "HELD").sum())),
        stopped=("outcome", lambda s: int((s == "OVERALL_SL").sum())),
        mean_net0=("net0", "mean"),
    )
    by_k["held_rate"] = by_k.held / by_k.attempts
    out += ["## By attempt number", "", md(by_k), ""]
    held_eps = per_ep[per_ep.held == 1]
    before = att.merge(held_eps[key], on=key)
    loss_before = (
        before[before.outcome == "OVERALL_SL"].groupby(key).net0.sum().rename("loss_before")
    )
    held_eps = held_eps.merge(loss_before.reset_index(), on=key, how="left").fillna(
        {"loss_before": 0.0}
    )
    winner = (
        before[before.outcome == "HELD"].groupby(key).net0.sum().rename("winner_net0").reset_index()
    )
    held_eps = held_eps.merge(winner, on=key, how="left")
    ep_tab = per_ep.groupby(GROUP).agg(
        episodes=("held", "size"),
        with_a_held_attempt=("held", "sum"),
        mean_net0=("net0", "mean"),
        median_net0=("net0", "median"),
        sum_net0=("net0", "sum"),
        mean_net20=("net20", "mean"),
        sum_net20=("net20", "sum"),
    )
    ep_tab["share_no_held"] = 1 - ep_tab.with_a_held_attempt / ep_tab.episodes
    out += ["## Per episode (₹ per Widesl)", "", md(ep_tab), ""]
    if len(held_eps):
        hb = held_eps.groupby(GROUP).agg(
            episodes_with_winner=("net0", "size"),
            mean_loss_before=("loss_before", "mean"),
            median_loss_before=("loss_before", "median"),
            mean_winner=("winner_net0", "mean"),
            median_winner=("winner_net0", "median"),
            winner_covers_losses=("net0", lambda s: int((s > 0).sum())),
        )
        out += ["## Episodes with a held attempt: loss before the winner", "", md(hb), ""]
    # overlapping ladders on a multi-episode day
    per_ep = per_ep.sort_values([*GROUP, "day", "episode_idx"])
    prev_end = per_ep.groupby([*GROUP, "day"]).last_exit.shift()
    per_ep["overlaps_prev"] = per_ep.first_entry <= prev_end
    day_raw = per_ep.groupby([*GROUP, "day"]).net0.sum()
    day_clean = per_ep[~per_ep.overlaps_prev].groupby([*GROUP, "day"]).net0.sum()
    worst = pd.DataFrame({
        "days_with_episodes": day_raw.groupby(GROUP).size(),
        "worst_day_raw": day_raw.groupby(GROUP).min(),
        "worst_day_no_overlap": day_clean.groupby(GROUP).min(),
        "overlapping_episodes": per_ep.groupby(GROUP).overlaps_prev.sum(),
    })  # fmt: skip
    out += ["## Days", "", md(worst), ""]
    held = att[att.outcome == "HELD"]
    if len(held):
        hm = held.groupby(GROUP).held_minutes.describe(percentiles=[0.25, 0.5, 0.75])
        out += ["## Held attempts: minutes held", "", md(hm[["count", "25%", "50%", "75%"]]), ""]
    entry_bar = att[att.outcome == "OVERALL_SL"].assign(at_entry=lambda d: d.held_minutes == 0)
    eb = entry_bar.groupby(GROUP).agg(stops=("at_entry", "size"), on_entry_bar=("at_entry", "sum"))
    out += ["## Overall stops on the entry bar itself", "", md(eb), ""]
    one_leg = att[att.legs_entered < 2].groupby(GROUP).size().rename("attempts_with_one_leg")
    if len(one_leg):
        out += ["One-leg attempts (a strike not priced at entry):", "", md(one_leg.to_frame()), ""]
    return "\n".join(out)


def main() -> int:
    days = pd.read_csv(OUT / "days.csv")
    eps = pd.read_csv(OUT / "episodes.csv")
    (OUT / "census.md").write_text(census(days, eps))
    print(f"wrote {OUT / 'census.md'}")
    res = HERE / "results" / "r0_attempts.csv"
    if res.exists():
        (OUT / "r0_summary.md").write_text(r0_summary(eps, pd.read_csv(res)))
        print(f"wrote {OUT / 'r0_summary.md'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
