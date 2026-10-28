"""BL-025: the registered drawdown-rule test, run once as written (backlog/BL-025, Experiments,
"2026-10-28 - Drawdown rules with a way back in"; numbers in
search_spaces/bl025_rules_criteria.json; mechanics in src/momentum_backtesting/drawdown_rules.py).

    uv run python scripts/bl025_rule_test.py build    # the engine runs: 4 sleeves, 72 ramp lots
    uv run python scripts/bl025_rule_test.py run      # look-ahead checks, then the scores

`build` caches the engine output under data/research/bl025/ (git-ignored). `run` first runs the
three look-ahead checks and stops, writing nothing, if any fails; then it scores the six
candidates (R0-R5; N is never scored) on the four sleeves, the blend and the 18 lot ramps over
2017-01-06 to 2026-10-23, applies the pass / kill rule, and writes the result once to
search_spaces/bl025_rules_result.json (the full detail to data/research/bl025/full.json). A
second run is refused unless `--rerun-reason` says why (a fixed implementation bug, never a
changed rule); the reason is stored in the result.

Read-only on the data: point MOMENTUM_DATA_DIR and TRADING_DATA_ROOT at copies. Nothing is sent,
saved as a favourite, or written to the live-rules file.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import pickle
import subprocess
import sys
import time
from datetime import UTC, datetime
from pathlib import Path

import numpy as np
import pandas as pd

from momentum_backtesting import choose, live_rules, search
from momentum_backtesting import drawdown_rules as dr
from momentum_backtesting.engine import CASH

PKG = Path(__file__).resolve().parent.parent
REPO = PKG.parent.parent
RESULT = PKG / "search_spaces" / "bl025_rules_result.json"
BACKLOG = REPO / "backlog" / "BL-025-live-money-rules.md"
SIGN_OFF = "**signed off** by the owner"
# The block's prose numbers (no numeric field in the criteria file holds them):
QUALIFYING_FALL = 0.20  # "ramps whose model curve falls 20% or more from its high"
FALL_DEPTH = 0.20  # "falls of 20% or more" (the falls each pass is attributed to)
EXIT_WINDOW_WEEKS = 8  # "exits within 8 weeks before that fall's lowest close"
LATE_WEEKS = 1  # "every action one week later"


def _dirs() -> Path:
    from momentum_backtesting.config import DATA_DIR

    out = DATA_DIR / "research" / "bl025"
    out.mkdir(parents=True, exist_ok=True)
    return out


def _commit() -> str:
    return subprocess.run(
        ["git", "rev-parse", "HEAD"], cwd=PKG, capture_output=True, text=True, check=True
    ).stdout.strip()


def _component(outcome) -> dict:
    from momentum_backtesting.categories import broad

    r = outcome.result
    return {
        "equity": r.equity,
        "weights": r.weights,
        "trades": r.trades,
        "tax_classes": broad._tax_classes(list(r.weights.columns)),
    }


def _run(runner, cfg: dict, base, **window):
    """One sleeve exactly as `tracker.run_config` runs it, keeping the whole Result."""
    light = {
        **cfg["light"],
        "rebalance_offset": cfg.get("rebalance_offset", cfg["light"].get("rebalance_offset", 0)),
    }
    outcome, _ = runner.run(base, cfg["heavy"], light, **window)
    return outcome


def build(echo=print) -> Path:
    from momentum_backtesting import bias

    crit = dr.load_criteria()
    followed = crit["followed"]
    configs = json.loads((PKG / followed["config_file"]).read_text())["configs"]
    runner = bias.Runner(
        search.load_space(live_rules.SPACE_PATH),
        universe_kind="turnover_rank",
        category_tags="curated",
    )
    heavy = {json.dumps(c["heavy"], sort_keys=True) for c in configs}
    assert len(heavy) == 1, "the four sleeves share their heavy settings"
    t0 = time.time()
    base = runner.base(configs[0]["heavy"])
    echo(f"universe base {time.time() - t0:.0f} s")
    sleeves = []
    for cfg in configs:
        echo(f"sleeve {cfg['id']} ...")
        sleeves.append({"id": cfg["id"], **_component(_run(runner, cfg, base))})
    every = configs[0]["rebalance_every"]
    by_offset = {c["rebalance_offset"]: c for c in configs}
    ramps = {}
    for first in crit["objects"]["lot_ramp"]["first_fridays"]:
        lots = []
        for start in live_rules.lot_starts(first, len(configs)):
            if start not in runner.common["outer_prices"].index:
                raise ValueError(f"lot start {start.date()} is not a week of the weekly table")
            cfg = by_offset[live_rules.lot_offset(start, every)]
            echo(f"ramp {first}: lot from {start.date()} = {cfg['id']}")
            outcome = _run(runner, cfg, base, start=str(start.date()))
            lots.append({"id": cfg["id"], "start": str(start.date()), **_component(outcome)})
        ramps[first] = lots
    cash = runner.common["outer_prices"][CASH]
    snapshot = search.data_snapshot()
    path = _dirs() / "objects.pkl"
    with path.open("wb") as fh:
        pickle.dump(
            {
                "sleeves": sleeves,
                "ramps": ramps,
                "cash": cash,
                "snapshot": snapshot,
                "built_at": datetime.now(UTC).isoformat(timespec="seconds"),
                "commit": _commit(),
            },
            fh,
        )
    echo(f"wrote {path}")
    return path


# --- the objects ------------------------------------------------------------------------------


def objects(built: dict, window: tuple[str, str], rates: dr.Rates) -> dict:
    """{name: (model curve, Book, components' curves for the rebuild check)}."""
    lo, hi = (pd.Timestamp(w) for w in window)
    out = {}
    comps = []
    curves = {}
    for k, s in enumerate(built["sleeves"]):
        eq = s["equity"].loc[lo:hi]
        comp = dr.Component(eq, s["weights"], s["trades"], s["tax_classes"])
        comps.append(comp)
        curves[k] = eq
        shares = pd.DataFrame({0: 1.0}, index=eq.index)
        out[f"sleeve_{k}"] = (eq / eq.iloc[0], dr.Book([comp], shares, rates), None)
    frame = pd.DataFrame(curves).ffill()
    frame = frame / frame.iloc[0]
    blend = choose.ensemble_curve(frame, list(frame.columns))
    out["blend"] = (blend, dr.Book(comps, dr.blend_shares(frame), rates), frame)
    for first, lots in built["ramps"].items():
        parts = [(lot["equity"] / lot["equity"].iloc[0]).loc[:hi] for lot in lots]
        model = live_rules.twr_index(parts).loc[:hi]
        lot_comps = [
            dr.Component(lot["equity"].loc[:hi], lot["weights"], lot["trades"], lot["tax_classes"])
            for lot in lots
        ]
        book = dr.Book(lot_comps, dr.lot_shares(parts, model.index), rates)
        out[f"ramp_{first}"] = (model, book, parts)
    for name, (model, _, _) in out.items():
        if model.index[-1] != hi:
            raise ValueError(f"{name} ends {model.index[-1].date()}, not {hi.date()}")
        if not name.startswith("ramp") and model.index[0] != lo:
            raise ValueError(f"{name} starts {model.index[0].date()}, not {lo.date()}")
    return out


# --- look-ahead -------------------------------------------------------------------------------


def lookahead(objs: dict, cands: list[dr.Candidate], echo=print) -> dict:
    """The block's three checks, plus the model curves rebuilt from components cut at t."""
    report: dict = {"check_1_prefix": {}, "check_2_changed_future": {}, "rebuild": {}}
    scored = [c for c in cands if c.back != "none"]
    for name, (model, _, parts) in objs.items():
        bad = {c.label: dr.prefix_check(model, c) for c in scored}
        report["check_1_prefix"][name] = {k: len(v) for k, v in bad.items()}
        # check 2 on the real curves: replace every week after t with the reversed path
        c = model.to_numpy()
        diffs = 0
        for t in np.linspace(40, len(c) - 2, 12).astype(int):
            other = c.copy()
            tail = c[t + 1 :][::-1]
            other[t + 1 :] = tail / tail[0] * c[t] * 0.6
            for cand in scored:
                a, _ = dr.decide(c, cand)
                b, _ = dr.decide(other, cand)
                diffs += int(not np.array_equal(a[: t + 1], b[: t + 1]))
        report["check_2_changed_future"][name] = diffs
        # the curve itself: the blend and the ramps rebuilt from components cut at t
        worst = 0.0
        if name == "blend":
            for t in parts.index[1:]:
                cut = parts.loc[:t]
                again = choose.ensemble_curve(cut, list(cut.columns))
                worst = max(worst, float((again - model.loc[:t]).abs().max()))
        elif name.startswith("ramp"):
            for t in model.index[1:]:
                cut = [p.loc[:t] for p in parts if len(p.loc[:t])]
                again = live_rules.twr_index(cut)
                worst = max(worst, float((again - model.loc[:t]).abs().max()))
        report["rebuild"][name] = worst
        echo(
            f"look-ahead {name}: prefix {sum(len(v) for v in bad.values())}, future {diffs}, "
            f"rebuild {worst:.1e}"
        )
    report["check_3_assertion"] = (
        "drawdown_rules.simulate asserts, on every week of every run, that the size applied to "
        "the return ending at t was decided before t"
    )
    report["passed"] = bool(
        all(not any(v.values()) for v in report["check_1_prefix"].values())
        and not any(report["check_2_changed_future"].values())
        and max(report["rebuild"].values()) < 1e-9
    )
    return report


# --- scoring ----------------------------------------------------------------------------------

_SUMMARY = (
    "end_wealth",
    "cagr",
    "give_up_pts",
    "worst_fall",
    "worst_fall_peak",
    "worst_fall_date",
    "weeks",
    "weeks_half",
    "weeks_zero",
    "share_half",
    "share_zero",
    "size_changes",
    "costs_rs",
    "tax_rs_estimated",
    "cuts_not_followed_by_exit",
)


def score(objs: dict, cands: list[dr.Candidate], cash: pd.Series, capital: float, echo=print):
    full: dict = {"main": {}, "late": {}}
    for cand in cands:
        full["main"][cand.key], full["late"][cand.key] = {}, {}
    for name, (model, book, _) in objs.items():
        r0_sizes, _ = dr.decide(model, cands[0])
        reference = dr.simulate(model, cash, r0_sizes, book, capital)
        for cand in cands:
            sizes, actions = dr.decide(model, cand)
            for variant, path in (("main", sizes), ("late", dr.delayed(sizes, LATE_WEEKS))):
                money = dr.simulate(model, cash, path, book, capital)
                full[variant][cand.key][name] = dr.measures(
                    model,
                    money,
                    path,
                    actions,
                    reference,
                    fall_depth=FALL_DEPTH,
                    exit_window_weeks=EXIT_WINDOW_WEEKS,
                )
        echo(f"scored {name}")
    return full


def qualifying(objs: dict) -> list[str]:
    out = []
    for name, (model, _, _) in objs.items():
        if (
            name.startswith("ramp")
            and float((model / model.cummax() - 1).min()) <= -QUALIFYING_FALL
        ):
            out.append(name)
    return out


def verdict_text(judged: dict, scores: dict) -> str:
    named, passing = judged["named"], judged["passing"]
    lines = ["6 candidates were scored (R0-R5); N (alert and review) is never scored."]
    if named:
        others = [p for p in passing if p != named]
        lines.append(
            f"{named.split('_', 1)[0]} passes and is the one named by the rule: its results are "
            "consistent with keeping the worst fall of the money held within 35% on every sleeve, "
            "the blend and every ramp, at no more than 3 points of CAGR a year against holding "
            "through. Consistent with, not proven: the sample holds about three independent falls "
            "of 20% or more."
            + (f" Also passing: {', '.join(o.split('_', 1)[0] for o in others)}." if others else "")
        )
        lines.append(
            "Replacing the live rules is the owner's decision; live_rules.toml is unchanged."
        )
    else:
        lines.append(
            "No candidate passes. The current lines stay, and the owner chooses R1 (as written) or "
            "N (alert and review) as the re-entry text."
        )
    if judged["r0_passes_a"]:
        lines.append(
            "R0 passes condition (a) on its own: dropping the lines is consistent with your "
            "limits, for the owner to weigh."
        )
    else:
        lines.append("R0 (hold through) fails condition (a): holding through breaks the 35% limit.")
    return " ".join(lines)


def _compact(m: dict, detail: bool) -> dict:
    out = {k: m[k] for k in _SUMMARY}
    if detail:
        out["actions"] = m["actions"]
        out["trades"] = m["trades"]
        out["falls"] = m["falls"]
        out["before_first_fall"] = m["before_first_fall"]
    else:
        out["actions"] = [f"{a['week']} {a['kind']}" for a in m["actions"]]
        out["falls"] = [
            {k: f[k] for k in ("peak", "low", "depth", "give_up_pts_allocated")} for f in m["falls"]
        ]
    return out


def run(rerun_reason: str | None, echo=print) -> int:
    if SIGN_OFF not in BACKLOG.read_text():
        echo("BL-025's Log has no owner sign-off: nothing runs")
        return 1
    if RESULT.exists() and not rerun_reason:
        echo(f"{RESULT.name} exists: the test runs once (a rerun needs --rerun-reason)")
        return 1
    crit = dr.load_criteria()
    cands = dr.candidates(crit)
    space = search.load_space(live_rules.SPACE_PATH)
    rates = dr.Rates(float(space.fixed["slippage_bps"]))
    capital = float(space.fixed["capital"])
    with (_dirs() / "objects.pkl").open("rb") as fh:
        built = pickle.load(fh)
    window = (crit["followed"]["window"]["from"], crit["followed"]["window"]["to"])
    objs = objects(built, window, rates)
    echo(f"{len(objs)} objects: {', '.join(objs)}")

    look = lookahead(objs, cands, echo)
    if not look["passed"]:
        echo("a look-ahead check failed: the run is killed, nothing is written")
        (_dirs() / "lookahead_failed.json").write_text(json.dumps(look, indent=1, default=str))
        return 2

    full = score(objs, cands, built["cash"], capital, echo)
    qual = qualifying(objs)
    judged = dr.judge(full["main"], crit, qual)
    late = dr.judge(full["late"], crit, qual)
    r1 = full["main"]["R1_as_written"]
    max_give = crit["pass"]["replaces_current_rules_only_if_all"][
        "cagr_give_up_vs_hold_through_max_pts"
    ]
    h2 = {o: m["give_up_pts"] for o, m in r1.items()}
    result = {
        "name": "BL-025 drawdown-rule test: result",
        "pre_registration": "backlog/BL-025-live-money-rules.md (Experiments, 2026-10-28) and "
        "search_spaces/bl025_rules_criteria.json, signed off 2026-10-28",
        "rule": "Written once by scripts/bl025_rule_test.py run. Never edited; a rerun (a fixed "
        "bug, never a changed rule) carries its reason.",
        "written_at": datetime.now(UTC).isoformat(timespec="seconds"),
        "rerun_reason": rerun_reason,
        "code_commit": _commit(),
        "engine_built_at_commit": built["commit"],
        "criteria_sha1": hashlib.sha1(
            (PKG / "search_spaces" / "bl025_rules_criteria.json").read_bytes()
        ).hexdigest(),
        "data_snapshot": built["snapshot"],
        "window": list(window),
        "data_last_week_used": window[1],
        "candidates_scored": len(cands),
        "objects": list(objs),
        "qualifying_ramps": qual,
        "lookahead": look,
        "verdict": verdict_text(judged, full["main"]),
        "judged": judged,
        "h1_some_candidate_passes": bool(judged["passing"]),
        "h2_r1_gives_up_more_than_x_everywhere": all(v > max_give for v in h2.values()),
        "h2_r1_give_up_pts": h2,
        "late_by_one_week_reported_only": {
            "note": "every action one week later; reported, never judged",
            "would_be": late,
        },
        "hold_out": "no week after 2026-10-23 exists in the data yet; none reported",
        "known_bias": crit["look_ahead"]["known_bias"],
        "scores": {
            cand: {o: _compact(m, detail=not o.startswith("ramp")) for o, m in objs_scores.items()}
            for cand, objs_scores in full["main"].items()
        },
        "scores_late": {
            cand: {o: {k: m[k] for k in _SUMMARY} for o, m in objs_scores.items()}
            for cand, objs_scores in full["late"].items()
        },
    }
    (_dirs() / "full.json").write_text(json.dumps(full, indent=1, default=str))
    RESULT.write_text(json.dumps(result, indent=1, default=str) + "\n")
    echo(f"wrote {RESULT}")
    echo(result["verdict"])
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    sub = parser.add_subparsers(dest="cmd", required=True)
    sub.add_parser("build")
    r = sub.add_parser("run")
    r.add_argument("--rerun-reason")
    args = parser.parse_args(argv)
    if args.cmd == "build":
        build()
        return 0
    return run(args.rerun_reason)


if __name__ == "__main__":
    sys.exit(main())
