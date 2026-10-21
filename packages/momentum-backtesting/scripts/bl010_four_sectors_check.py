"""BL-010 addendum 6: does Four Sectors Monthly, No Tilt, all Fridays hold up under the
assumptions of the real trade? The rules are search_spaces/bl010_criteria_addendum_6.json
(committed before this ran). The addendum states its gates in words, so the numbers they use are
the named constants below, each copied from that text; change one only by superseding the file.

    uv run python scripts/bl010_four_sectors_check.py variants    # A0-A3, Monday-open replay
    uv run python scripts/bl010_four_sectors_check.py neighbours  # G4: one-step neighbours
    uv run python scripts/bl010_four_sectors_check.py placebo     # G6: 100 random rankings
    uv run python scripts/bl010_four_sectors_check.py report      # apply the gates, write result

Intermediate output goes to data/search/round7_A/bl010_four_sectors/ (git-ignored); the final
result, written once, to search_spaces/bl010_four_sectors_result.json. Every stage is resumable.
"""

from __future__ import annotations

import dataclasses
import json
import multiprocessing as mp
import subprocess
import sys
import time
from datetime import date
from pathlib import Path

import numpy as np
import pandas as pd

PKG = Path(__file__).resolve().parent.parent
SPACE = PKG / "search_spaces" / "round7_A.toml"
RESULT = PKG / "search_spaces" / "bl010_four_sectors_result.json"
SUBJECT = "fbb7ab054238"
EVERY = 4
CAPITAL = 200_000.0
MOM30 = "Nifty200 Momentum 30 TRI"
N50 = "Nifty 50 TRI"
SMALL = "Nifty Smallcap 250 TRI"
MID = "Nifty Midcap 150 TRI"
N500 = "Nifty 500 TRI"
HALVES = (("2017-04-01", "2022-03-31"), ("2022-04-01", "2026-03-31"))
PLACEBO_SEEDS = 100
# The gates' numbers, from the addendum's wording.
G1_EXCESS_OVER_MOM30 = 0.05  # E CAGR minus Mom30 TRI CAGR, at least
G3_WORST_FY_VS_MOM30 = -0.10  # no complete financial year behind Mom30 TRI by more than this
G4_MEDIAN_GAP = -0.05  # median neighbour CAGR vs A0, at least
G4_SHARE_ABOVE = 0.75  # neighbours at least 5 pts above Mom30 TRI, at least this share
G4_ABOVE_MOM30 = 0.05
G5_ALPHA, G5_ABS_T = 0.05, 2.0
G6_MARGIN_OVER_P95 = 0.05
RUNS = {"count": 0}


def _dirs():
    from momentum_backtesting.config import DATA_DIR

    results = DATA_DIR / "search" / "round7_A"
    return results, results / "bl010_four_sectors"


def _record() -> dict:
    from momentum_backtesting import bias

    results, _ = _dirs()
    return bias.load_records(results, {SUBJECT})[SUBJECT]


def _runner(tags: str = "curated"):
    from momentum_backtesting import bias, search

    return bias.Runner(search.load_space(SPACE), universe_kind="turnover_rank", category_tags=tags)


def blend(
    runner,
    base,
    heavy: dict,
    light: dict,
    *,
    tags: str,
    taxed: bool,
    locks=None,
    every: int | None = None,
    keep: bool = False,
    window: dict | None = None,
):
    """The subject (or a neighbour) as the account follows it: `every` sleeves, one per
    rebalance Friday, equal capital reset each April. Returns (blended Result, locks, sleeves)."""
    from momentum_backtesting import tranches
    from momentum_backtesting.tax import TaxRules

    every = every or int(light["rebalance_every"])
    light0 = {k: v for k, v in light.items() if k != "rebalance_offset"}
    runner.category_tags = tags
    results, sleeves = [], []
    for offset in range(every):
        outcome, ranking = runner.run(
            base,
            heavy,
            light0,
            locks=locks,
            rebalance_offset=offset,
            capital=CAPITAL / every,
            tax=TaxRules() if taxed else None,
            **(window or {}),
        )
        RUNS["count"] += 1
        locks = locks or runner.locks(ranking)
        results.append(outcome.result)
        if keep:
            sleeves.append((outcome, ranking))
    return tranches.blend_reset(results), locks, sleeves


def _curve(result) -> pd.Series:
    equity = result.equity.astype("float64")
    return equity / equity.iloc[0]


def _stats(curve: pd.Series) -> dict:
    from momentum_backtesting import choose

    peak = curve.cummax()
    return {
        "cagr": float(choose.cagr(curve)),
        "mdd": float((curve / peak - 1).min()),
        "ulcer": float(choose.ulcer(curve.to_frame("x"))["x"]),
    }


def _bench(runner, span: pd.DatetimeIndex, name: str) -> pd.Series:
    from momentum_backtesting import reference_benchmarks

    return reference_benchmarks.aligned(runner.refs[name], span)


# --- stage 1: the variants and the Monday-open replay -----------------------------------------


def _monday_open(runner, rec: dict, base, locks) -> dict:
    """The audit replay of A1's decisions: close in fractional shares against the next open with
    whole shares, per sleeve at Rs 50,000, blended with the April reset."""
    from momentum_backtesting import choose
    from momentum_backtesting.audit import replay as rp
    from momentum_backtesting.audit import studies as st
    from momentum_backtesting.audit.bundle import build_bundle
    from momentum_backtesting.engine import CASH

    runner.category_tags = "extended"
    light0 = {k: v for k, v in rec["light"].items() if k != "rebalance_offset"}
    close_curves, open_curves, details = {}, {}, []
    for offset in range(EVERY):
        outcome, ranking = runner.run(
            base,
            rec["heavy"],
            light0,
            locks=locks,
            rebalance_offset=offset,
            capital=CAPITAL / EVERY,
        )
        RUNS["count"] += 1
        prices = ranking.prices.ffill()
        prices[CASH] = runner.common["outer_prices"].reindex(prices.index)[CASH]
        groups = outcome.effective.groups
        if groups is not None:
            groups = groups.reindex(prices.index).shift(outcome.result.config.signal_delay)
        bundle = build_bundle(
            outcome.result,
            prices=prices,
            column_to_base_symbol=ranking.column_to_base_symbol,
            events=ranking.events,
            label=f"sleeve{offset}",
            run_id=SUBJECT,
            variant="a1",
            params={"offset": offset},
            categories=groups,
        )
        market = rp.market_for(bundle)
        reconciled = rp.replay(bundle, market)
        shares = rp.decisions(reconciled)
        at_close = rp.replay(bundle, market, rp.Sizing(shares=shares))
        at_open = rp.replay(
            bundle, market, rp.Sizing(shares=shares, fill_at="next_open", whole_shares=True)
        )
        gaps = st.monday_open(bundle, market, reconciled)
        close_curves[offset] = pd.Series(at_close.equity)
        open_curves[offset] = pd.Series(at_open.equity)
        idle = [c / at_open.equity[w] for w, c in at_open.cash.items() if at_open.equity.get(w)]
        details.append(
            {
                "offset": offset,
                "sleeve_cagr_at_close": st.cagr(at_close.equity),
                "sleeve_cagr_at_open_whole_shares": st.cagr(at_open.equity),
                "average_gap_on_buys": gaps["average_gap_on_buys"],
                "average_gap_on_sells": gaps["average_gap_on_sells"],
                "orders_repriced": gaps["orders_repriced"],
                "orders_with_no_open_that_week": gaps["orders_with_no_open_that_week"],
                "idle_cash_share_mean": float(np.mean(idle)),
                "replay_problems": at_open.problems[:3],
            }
        )

    def combined(curves: dict) -> pd.Series:
        frame = pd.DataFrame(curves)
        frame.index = pd.to_datetime(frame.index)
        return choose.ensemble_curve(frame.sort_index(), list(frame.columns))

    at_close, at_open = combined(close_curves), combined(open_curves)
    c, o = _stats(at_close), _stats(at_open)
    return {
        "cagr_at_close": c["cagr"],
        "cagr_at_open_whole_shares": o["cagr"],
        "cagr_change": o["cagr"] - c["cagr"],
        "mdd_at_close": c["mdd"],
        "mdd_at_open_whole_shares": o["mdd"],
        "mdd_change": o["mdd"] - c["mdd"],
        "sleeves": details,
    }


def stage_variants() -> None:
    results, out = _dirs()
    out.mkdir(parents=True, exist_ok=True)
    dest = out / "variants.json"
    if dest.exists():
        print("variants: already done")
        return
    rec = _record()
    runner = _runner()
    base = runner.base(rec["heavy"])
    heavy, light = rec["heavy"], rec["light"]
    curves, stats, locks, kept = {}, {}, None, {}
    for name, tags, taxed in (
        ("A0_as_ranked", "curated", False),
        ("A1_extended_tags", "extended", False),
        ("A2_after_tax", "curated", True),
        ("A3_real_tags_and_tax", "extended", True),
    ):
        started = time.time()
        result, locks, sleeves = blend(
            runner,
            base,
            heavy,
            light,
            tags=tags,
            taxed=taxed,
            locks=locks,
            keep=name.startswith("A3"),
        )
        curve = _curve(result)
        curves[name] = curve
        stats[name] = _stats(curve)
        if sleeves:
            kept[name] = sleeves
        print(
            f"{name}: CAGR {stats[name]['cagr']:.4f}, max drawdown {stats[name]['mdd']:.4f} "
            f"({time.time() - started:.0f} s)",
            flush=True,
        )

    # per-Friday spread (A0), reported
    spread = []
    runner.category_tags = "curated"
    light0 = {k: v for k, v in light.items() if k != "rebalance_offset"}
    for offset in range(EVERY):
        outcome, _ = runner.run(
            base, heavy, light0, locks=locks, rebalance_offset=offset, capital=CAPITAL / EVERY
        )
        RUNS["count"] += 1
        curve = _curve(outcome.result)
        spread.append({"offset": offset, **_stats(curve)})

    # concentration, from A3's sleeves (realised profit; open positions are not counted)
    from momentum_backtesting import bias

    profit = pd.Series(dtype="float64")
    for outcome, ranking in kept["A3_real_tags_and_tax"]:
        profit = profit.add(bias.profit_by_stock(outcome, ranking), fill_value=0.0)
    profit = profit.sort_values(ascending=False)
    total = float(profit.sum())
    concentration = {
        "realised_profit_total_in_capital_units": total,
        "top5_share": float(profit.head(5).sum() / total) if total > 0 else None,
        "top5": {k: float(v / total) for k, v in profit.head(5).items()} if total > 0 else {},
        "flag_top5_above_50pct": bool(total > 0 and profit.head(5).sum() / total > 0.5),
    }

    monday = _monday_open(runner, rec, base, locks)
    print("monday-open:", {k: v for k, v in monday.items() if k != "sleeves"}, flush=True)

    pd.DataFrame(curves).to_parquet(out / "variant_curves.parquet")
    dest.write_text(
        json.dumps(
            {
                "stats": stats,
                "friday_spread_A0": spread,
                "concentration": concentration,
                "monday_open": monday,
                "backtests_run": RUNS["count"],
            },
            indent=1,
            default=str,
        )
    )
    print("variants: done", flush=True)


def stage_reproduce() -> None:
    """Addendum 6, A0: explain any gap to the 2026-10-08 ranking row (44.2%, 509 weeks to
    2026-10-02, the four Fridays averaged without an April reset)."""
    from momentum_backtesting import choose, tranches

    _, out = _dirs()
    dest = out / "reproduce.json"
    if dest.exists():
        print("reproduce: already done")
        return
    rec = _record()
    runner = _runner("curated")
    base = runner.base(rec["heavy"])
    light0 = {k: v for k, v in rec["light"].items() if k != "rebalance_offset"}
    rows = {}
    for label, window in (("to_2026-10-02", {"end": "2026-10-02"}), ("to_latest", {})):
        sleeves = []
        for offset in range(EVERY):
            outcome, _ = runner.run(
                base,
                rec["heavy"],
                light0,
                rebalance_offset=offset,
                capital=CAPITAL / EVERY,
                **window,
            )
            RUNS["count"] += 1
            sleeves.append(outcome.result)
        reset = _curve(tranches.blend_reset(sleeves))
        mean = pd.concat([_curve(r) for r in sleeves], axis=1).mean(axis=1)
        rows[label] = {
            "weeks": int(len(reset)),
            "blend_with_april_reset_cagr": float(choose.cagr(reset)),
            "plain_mean_of_sleeves_cagr": float(choose.cagr(mean)),
        }
        print(label, rows[label], flush=True)
    rows["ranking_row_2026-10-08"] = {
        "weeks": 509,
        "cagr": 0.442112465641596,
        "mdd": -0.2697938874508591,
    }
    dest.write_text(json.dumps(rows, indent=1))


# --- stage 2: G4, the one-step neighbours -----------------------------------------------------


def _neighbour_group(task: dict) -> list[dict]:
    from momentum_backtesting import robust

    runner = _runner()
    heavy = task["heavy"]
    base = runner.base(heavy)
    rows = []
    for nudge in task["nudges"]:
        started = time.time()
        light = nudge["light"]
        every = int(light["rebalance_every"])
        result, _, _ = blend(runner, base, heavy, light, tags="curated", taxed=False, every=every)
        curve = _curve(result)
        mom = _bench(runner, curve.index, MOM30)
        rows.append(
            {
                "label": nudge["label"],
                "kind": nudge["kind"],
                **_stats(curve),
                "mom30_cagr": float(_stats(mom)["cagr"]),
                "every": every,
                "secs": round(time.time() - started),
                "heavy_key": robust._heavy_key(heavy),
            }
        )
    return rows


def stage_neighbours(workers: int = 3) -> None:
    from momentum_backtesting import robust, search

    _, out = _dirs()
    out.mkdir(parents=True, exist_ok=True)
    dest = out / "neighbours.jsonl"
    rec = _record()
    space = search.load_space(SPACE)
    all_nudges = [n for n in robust.nudges(rec, space) if n["kind"] not in ("offset", "start")]
    done = (
        {json.loads(line)["label"] for line in dest.read_text().splitlines()}
        if dest.exists()
        else set()
    )
    groups: dict[str, dict] = {}
    for nudge in all_nudges:
        if nudge["label"] in done:
            continue
        key = robust._heavy_key(nudge["heavy"])
        groups.setdefault(key, {"heavy": nudge["heavy"], "nudges": []})["nudges"].append(nudge)
    print(
        f"neighbours: {len(all_nudges)} one-step neighbours, {len(done)} done, "
        f"{len(groups)} rankings to build, {workers} workers",
        flush=True,
    )
    if not groups:
        return
    ctx = mp.get_context("spawn")
    with ctx.Pool(workers, maxtasksperchild=1) as pool, dest.open("a") as sink:
        for rows in pool.imap_unordered(_neighbour_group, list(groups.values())):
            for row in rows:
                sink.write(json.dumps(row) + "\n")
                print(row["label"], f"{row['cagr']:.4f}", flush=True)
            sink.flush()


# --- stage 3: G6, the fair placebo ------------------------------------------------------------


def _placebo_chunk(task: dict) -> list[dict]:
    from momentum_backtesting import method

    rec = _record()
    runner = _runner("curated")
    base = runner.base(rec["heavy"])
    rows, locks = [], None
    for seed in task["seeds"]:
        fake = method.persistent_random_ranks(base.global_ranks, seed)
        used = dataclasses.replace(base, global_ranks=fake)
        # stock tilt stays off (it is 0.0 for the subject): it would let real momentum back in.
        light = {**rec["light"], "stock_tilt": 0.0}
        result, locks, _ = blend(
            runner, used, rec["heavy"], light, tags="curated", taxed=False, locks=locks
        )
        rows.append({"seed": seed, **_stats(_curve(result))})
    return rows


def stage_placebo(workers: int = 3) -> None:
    _, out = _dirs()
    out.mkdir(parents=True, exist_ok=True)
    dest = out / "placebo.jsonl"
    done = (
        {json.loads(line)["seed"] for line in dest.read_text().splitlines()}
        if dest.exists()
        else set()
    )
    todo = [s for s in range(PLACEBO_SEEDS) if s not in done]
    print(f"placebo: {len(todo)} of {PLACEBO_SEEDS} seeds to run, {workers} workers", flush=True)
    chunks = [
        {"seeds": todo[i :: workers * 4]} for i in range(workers * 4) if todo[i :: workers * 4]
    ]
    ctx = mp.get_context("spawn")
    with ctx.Pool(workers, maxtasksperchild=1) as pool, dest.open("a") as sink:
        for rows in pool.imap_unordered(_placebo_chunk, chunks):
            for row in rows:
                sink.write(json.dumps(row) + "\n")
            sink.flush()
            print(f"placebo: {len(rows)} seeds written", flush=True)


# --- stage 4: gates and the result ------------------------------------------------------------


def _selection_context() -> dict:
    """The config's place among the 8,003 point-in-time scored configs, whole window and in each
    half. Reported, not judged."""
    from momentum_backtesting import choose
    from momentum_backtesting.config import DATA_DIR

    folder = DATA_DIR / "search" / "round7_A" / "scored_pit"
    frames = [pd.read_parquet(p) for p in sorted(folder.glob("curves-*.parquet"))]
    curves = pd.concat(frames, axis=1)
    out = {"configs": int(curves.shape[1])}
    full = choose.cagr(curves)
    out["median_config_cagr"] = float(full.median())
    out["subject_cagr_in_search"] = float(full[SUBJECT])
    out["subject_percentile_full"] = float((full < full[SUBJECT]).mean())
    for label, (start, end) in zip(("first_half", "second_half"), HALVES, strict=True):
        window = curves.loc[start:end]
        window = window / window.iloc[0]
        c = choose.cagr(window)
        out[f"subject_percentile_{label}"] = float((c < c[SUBJECT]).mean())
        out[f"subject_cagr_{label}"] = float(c[SUBJECT])
        out[f"median_config_cagr_{label}"] = float(c.median())
    return out


def stage_report() -> None:
    from momentum_backtesting import choose, criteria, phase5

    if RESULT.exists():
        sys.exit(f"{RESULT.name} exists: the check runs once (addendum 6). Supersede, don't rerun.")
    _, out = _dirs()
    variants = json.loads((out / "variants.json").read_text())
    curves = pd.read_parquet(out / "variant_curves.parquet")
    a3 = curves["A3_real_tags_and_tax"]
    runner = _runner()
    span = a3.index
    bench = {n: _bench(runner, span, n) for n in (MOM30, N50, SMALL, MID, N500)}
    mom = bench[MOM30]
    mom_cagr = float(choose.cagr(mom))
    monday = variants["monday_open"]
    a3_stats = variants["stats"]["A3_real_tags_and_tax"]
    e = {
        "cagr": a3_stats["cagr"] + monday["cagr_change"],
        "mdd": a3_stats["mdd"] + monday["mdd_change"],
    }

    def g1(change: float) -> bool:
        return (a3_stats["cagr"] + change) - mom_cagr >= G1_EXCESS_OVER_MOM30

    indices = {SMALL: bench[SMALL], MID: bench[MID]}
    medium = criteria.basket_passes(a3, indices, "medium")
    aggressive = criteria.basket_passes(a3, indices, "aggressive")
    ceiling = criteria.load()["baskets"]["medium"]["hard_ceiling"]
    gates = {
        "G1_minimum_bar": {
            "pass": g1(monday["cagr_change"]),
            "e_cagr": e["cagr"],
            "mom30_cagr": mom_cagr,
            "excess_pts": (e["cagr"] - mom_cagr) * 100,
            "excess_pts_if_monday_change_were_zero": (a3_stats["cagr"] - mom_cagr) * 100,
        }
    }
    gates["G2_drawdown_basket"] = {
        "pass": bool(medium and e["mdd"] >= ceiling),
        "a3_passes_medium": bool(medium),
        "a3_passes_aggressive_reported": bool(aggressive),
        "a3_mdd": a3_stats["mdd"],
        "e_mdd": e["mdd"],
        "hard_ceiling": ceiling,
    }
    fys = choose.complete_fys(a3.index)
    fy = pd.DataFrame(
        {
            "A3": {y: choose.window_returns(a3, *choose.fy_bounds(y)) for y in fys},
            **{
                n: {y: choose.window_returns(s, *choose.fy_bounds(y)) for y in fys}
                for n, s in bench.items()
            },
        }
    )
    excess = fy["A3"] - fy[MOM30]
    gates["G3_no_bad_year"] = {
        "pass": bool(excess.min() >= G3_WORST_FY_VS_MOM30),
        "worst_fy": int(excess.idxmin()),
        "worst_fy_excess_pts": float(excess.min() * 100),
        "fy_table": {int(y): {k: float(v) for k, v in row.items()} for y, row in fy.iterrows()},
    }

    neigh = pd.DataFrame(
        [json.loads(line) for line in (out / "neighbours.jsonl").read_text().splitlines()]
    )
    base_cagr = variants["stats"]["A0_as_ranked"]["cagr"]
    median_gap = float((neigh["cagr"].median() - base_cagr) * 100)
    share_above = float(((neigh["cagr"] - neigh["mom30_cagr"]) >= G4_ABOVE_MOM30).mean())
    gates["G4_plateau"] = {
        "pass": bool(median_gap >= G4_MEDIAN_GAP * 100 and share_above >= G4_SHARE_ABOVE),
        "neighbours": int(len(neigh)),
        "median_neighbour_cagr": float(neigh["cagr"].median()),
        "a0_cagr": base_cagr,
        "median_gap_pts": median_gap,
        "share_5_pts_above_mom30": share_above,
        "worst_neighbour": neigh.loc[neigh["cagr"].idxmin()][["label", "cagr"]].to_dict(),
    }
    live = neigh[(neigh["cagr"] - base_cagr).abs() > 1e-4]  # not a copy of A0 by construction
    gates["G4_plateau"]["not_registered_without_copies_of_A0"] = {
        "neighbours": int(len(live)),
        "median_neighbour_cagr": float(live["cagr"].median()),
        "median_gap_pts": float((live["cagr"].median() - base_cagr) * 100),
        "share_5_pts_above_mom30": float(
            ((live["cagr"] - live["mom30_cagr"]) >= G4_ABOVE_MOM30).mean()
        ),
        "lowest": live.nsmallest(3, "cagr")[["label", "cagr", "mdd"]].to_dict("records"),
    }

    cash = runner.common["outer_prices"]["Cash (liquid fund)"]
    factors = choose.factor_regression(a3, cash, bench[N50], bench[SMALL], mom)
    gates["G5_alpha"] = {
        "pass": bool(factors["alpha_pa"] >= G5_ALPHA and abs(factors["alpha_t"]) >= G5_ABS_T),
        **factors,
    }

    placebo = pd.DataFrame(
        [json.loads(line) for line in (out / "placebo.jsonl").read_text().splitlines()]
    )
    cagrs = sorted(placebo["cagr"])
    p95 = cagrs[min(len(cagrs) - 1, int(0.95 * len(cagrs)))]
    gates["G6_fair_placebo"] = {
        "pass": bool(base_cagr - p95 >= G6_MARGIN_OVER_P95),
        "seeds": int(len(cagrs)),
        "a0_cagr": base_cagr,
        "placebo_median": float(np.median(cagrs)),
        "placebo_p95": float(p95),
        "margin_over_p95_pts": (base_cagr - p95) * 100,
    }

    def verdict(g1_pass: bool) -> str:
        soft_fails = sum(
            not gates[k]["pass"] for k in ("G4_plateau", "G5_alpha", "G6_fair_placebo")
        )
        if not g1_pass or soft_fails >= 2:
            return "DOES_NOT_HOLD_UP"
        if (
            gates["G2_drawdown_basket"]["pass"]
            and gates["G3_no_bad_year"]["pass"]
            and soft_fails <= 1
        ):
            return "HOLDS_UP"
        return "MIXED"

    final = verdict(gates["G1_minimum_bar"]["pass"])
    flipped = verdict(g1(0.0)) != final

    rolling = {}
    for years in (2, 3):
        mine, theirs = phase5._rolling(a3, years), phase5._rolling(mom, years)
        diff = (mine - theirs).dropna()
        rolling[f"{years}y"] = {
            "worst": float(mine.min()),
            "median": float(mine.median()),
            "best": float(mine.max()),
            "worst_vs_mom30_pts": float(diff.min() * 100),
            "share_above_mom30": float((diff > 0).mean()),
        }
    boot = {f"{b}w": choose.block_bootstrap(a3, mean_block=b) for b in (13, 26)}
    slices = {
        f"{int(s * 100)}pct_of_portfolio": float(a3_stats["mdd"] * s) for s in (0.10, 0.15, 0.20)
    }

    commit = subprocess.run(
        ["git", "rev-parse", "HEAD"], capture_output=True, text=True, cwd=PKG
    ).stdout.strip()
    dirty = bool(
        subprocess.run(
            ["git", "status", "--porcelain", "--untracked-files=no"],
            capture_output=True,
            text=True,
            cwd=PKG,
        ).stdout.strip()
    )
    try:
        from momentum_backtesting import db_read

        data_version = db_read.data_version()
    except Exception as exc:  # noqa: BLE001
        data_version = f"unavailable: {exc}"
    result = {
        "written": date.today().isoformat(),
        "criteria": "bl010_criteria_addendum_6.json",
        "subject": SUBJECT,
        "window": [str(span[0].date()), str(span[-1].date())],
        "weeks": int(len(span)),
        "commit": commit,
        "working_tree_dirty": dirty,
        "data_version": data_version,
        "verdict": final,
        "verdict_flips_if_monday_change_zero": flipped,
        "gates": gates,
        "variants": variants["stats"],
        "e_expected_case": e,
        "monday_open": monday,
        "friday_spread_A0": variants["friday_spread_A0"],
        "concentration": variants["concentration"],
        "rolling_windows_A3": rolling,
        "bootstrap_A3": boot,
        "drawdown_share_of_portfolio_A3": slices,
        "selection_context": _selection_context(),
        "a0_reproduction": json.loads((out / "reproduce.json").read_text()),
        "comparators_cagr": {n: float(choose.cagr(s)) for n, s in bench.items()},
        "backtests_run": variants["backtests_run"]
        + int(len(neigh)) * EVERY
        + int(len(placebo)) * EVERY,
    }
    RESULT.write_text(json.dumps(result, indent=1, default=str) + "\n")
    print(
        json.dumps(
            {
                "verdict": final,
                "flips_if_monday_zero": flipped,
                **{k: v["pass"] for k, v in gates.items()},
            },
            indent=1,
        )
    )


STAGES = {
    "reproduce": stage_reproduce,
    "variants": stage_variants,
    "neighbours": stage_neighbours,
    "placebo": stage_placebo,
    "report": stage_report,
}

if __name__ == "__main__":
    which = sys.argv[1] if len(sys.argv) > 1 else ""
    if which not in STAGES:
        sys.exit(f"usage: {sys.argv[0]} {'|'.join(STAGES)}")
    STAGES[which]()
