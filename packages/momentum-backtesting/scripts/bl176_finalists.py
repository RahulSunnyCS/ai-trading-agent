"""BL-176 finalist checks: the two Stage 3 ensembles against gates G1-G6, as
search_spaces/bl176_criteria_addendum_1.json reads them for an ensemble (committed before this
ran). The gate numbers are addendum 8's and the verdict rule addendum 6's, both reused from
scripts/bl010_four_sectors_check.py, never restated here.

    uv run python scripts/bl176_finalists.py variants   --ranking curated   # P0..T_real, M
    uv run python scripts/bl176_finalists.py neighbours --ranking curated   # G4
    uv run python scripts/bl176_finalists.py placebo    --ranking curated   # G6
    uv run python scripts/bl176_finalists.py report     --ranking curated   # gates, result

Intermediate output goes to data/search/round8_stage3/finalists/<ranking>/ (git-ignored); the
result, written once per ranking, to search_spaces/bl176_finalists_<ranking>.json. Every stage
is resumable: a finished task's files are not redone.
"""

from __future__ import annotations

import argparse
import dataclasses
import importlib.util
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
SPACES = PKG / "search_spaces"
ADDENDUM = SPACES / "bl176_criteria_addendum_1.json"
CAPITAL = 200_000.0  # owner override 2026-11-01: Rs 2 lakh a Friday sleeve
CEILING = 10_000.0  # and a Rs 10,000 price ceiling
SEEDS = 100
#: The arms each tag ranking pooled in Stage 3 (bl176_criteria.json stage_1 / stage_2).
ARMS = {
    "curated": ["round8_A_curated", "round8_B", "round8_A_curated_focus"],
    "extended": [
        "round8_A_extended",
        "round8_B",
        "round8_C1",
        "round8_A_extended_focus",
        "round8_C1_focus",
    ],
}
MOM30 = "Nifty200 Momentum 30 TRI"
N50 = "Nifty 50 TRI"
SMALL = "Nifty Smallcap 250 TRI"
MID = "Nifty Midcap 150 TRI"
N500 = "Nifty 500 TRI"

_spec = importlib.util.spec_from_file_location(
    "bl010_four_sectors_check", PKG / "scripts" / "bl010_four_sectors_check.py"
)
four = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(four)  # the gate numbers (addendum 8) and the verdict rule (addendum 6)

RUNS = {"count": 0}


# --- where things are ---------------------------------------------------------------------------


def _search_dir() -> Path:
    from momentum_backtesting.config import DATA_DIR

    return DATA_DIR / "search"


#: `--dest` (a smoke run in a scratch folder) replaces the finalists folder.
DEST: dict[str, Path] = {}
#: `--only` (a smoke run) keeps one member.
ONLY: dict[str, str] = {}


def _out(ranking: str) -> Path:
    root = DEST.get("root") or _search_dir() / "round8_stage3" / "finalists"
    path = root / ranking
    path.mkdir(parents=True, exist_ok=True)
    return path


def result_path(ranking: str) -> Path:
    return SPACES / f"bl176_finalists_{ranking}.json"


def members(ranking: str) -> list[dict]:
    """The ensemble addendum 4 picked on the full history, in its order, each config with its
    stored record and the arm folder it came from (arm B appears in both rankings: first found)."""
    from momentum_backtesting import bias

    report = _search_dir() / "round8_stage3" / "phase6" / ranking / "ensemble.json"
    picks = json.loads(report.read_text())["pick"]["configs"]
    wanted = {p["id"] for p in picks}
    found: dict[str, dict] = {}
    for folder in ARMS[ranking]:
        for cid, rec in bias.load_records(_search_dir() / folder, wanted - set(found)).items():
            found[cid] = {"folder": folder, "rec": rec}
    missing = sorted(wanted - set(found))
    if missing:
        sys.exit(f"{ranking}: no stored record for {missing}")
    team = [{"id": p["id"], "phase_slot": int(p["phase_slot"]), **found[p["id"]]} for p in picks]
    return [m for m in team if m["id"] == ONLY["id"]] if ONLY else team


def space_of(folder: str):
    """The arm's space with Stage 3's money: Rs 2 lakh a sleeve, Rs 10,000 ceiling."""
    from momentum_backtesting import search

    space = search.load_space(SPACES / f"{folder}.toml")
    return dataclasses.replace(
        space, fixed={**space.fixed, "capital": CAPITAL, "max_stock_price": CEILING}
    )


def runner_for(folder: str):
    from momentum_backtesting import bias

    return bias.Runner(space_of(folder))


# --- one config on all its Fridays --------------------------------------------------------------


def every_of(runner, light: dict) -> int:
    return int({**runner.space.fixed, **light}.get("rebalance_every", 1))


def blend_member(
    runner,
    base,
    heavy: dict,
    light: dict,
    *,
    tags: str | None,
    taxed: bool,
    locks=None,
    window: dict | None = None,
    keep: bool = False,
):
    """A config as the account follows it: one whole sleeve per Friday, blended with equal
    capital restored each April (`method.blend_phases(per_sleeve=True)`, the Stage 3 scorer's
    own rule). `tags` None keeps the space's tags. Returns (blend, sleeve curves, locks, kept)."""
    from momentum_backtesting import method
    from momentum_backtesting.tax import TaxRules

    light0 = {k: v for k, v in light.items() if k != "rebalance_offset"}
    runner.category_tags = tags
    sleeves, kept = [], []
    for offset in range(every_of(runner, light)):
        outcome, ranking = runner.run(
            base,
            heavy,
            light0,
            locks=locks,
            rebalance_offset=offset,
            tax=TaxRules() if taxed else None,
            **(window or {}),
        )
        RUNS["count"] += 1
        locks = locks or runner.locks(ranking)
        sleeves.append(outcome.result.equity.astype("float64"))
        if keep:
            kept.append((outcome, ranking))
    blend = method.blend_phases(sleeves, per_sleeve=True)
    return blend / blend.iloc[0], sleeves, locks, kept


def ensemble(curves: dict[str, pd.Series]) -> pd.Series:
    """Equal capital per config, reset each April (`choose.ensemble_curve`)."""
    from momentum_backtesting import choose

    frame = pd.DataFrame(curves).dropna()
    return choose.ensemble_curve(frame, list(frame.columns))


# --- stage 1: the variants and the Monday-open replay ----------------------------------------


def _variant_plan(ranking: str) -> list[tuple[str, str | None, bool, dict]]:
    """(name, tags, taxed, window). None tags = the ranking's own (the space's)."""
    from momentum_backtesting import search

    registered = search.load_space(SPACES / f"{ARMS[ranking][0]}.toml").fixed
    small = {
        "capital": float(registered["capital"]),
        "max_stock_price": registered["max_stock_price"],
    }
    plan = [("P0_as_ranked", None, False, {}), ("T0_after_tax", None, True, {})]
    if ranking == "curated":
        plan += [("P1_extended_tags", "extended", False, {}), ("T_real", "extended", True, {})]
    plan.append(("T_real_50k", "extended", True, small))
    return plan


#: Variants that are another one by definition in the extended ranking (addendum 1).
ALIASES = {"extended": {"P1_extended_tags": "P0_as_ranked", "T_real": "T0_after_tax"}}


def _monday_open(runner, member: dict, base, locks) -> dict:
    """Addendum 6's M on every sleeve of one config: P1's decisions replayed at the close in
    fractional shares and at the next open in whole shares (audit/replay.py)."""
    from momentum_backtesting import method
    from momentum_backtesting.audit import replay as rp
    from momentum_backtesting.audit import studies as st
    from momentum_backtesting.audit.bundle import build_bundle
    from momentum_backtesting.engine import CASH

    rec = member["rec"]
    runner.category_tags = "extended"
    light0 = {k: v for k, v in rec["light"].items() if k != "rebalance_offset"}
    close, opened, details = [], [], []
    for offset in range(every_of(runner, rec["light"])):
        outcome, ranking = runner.run(
            base, rec["heavy"], light0, locks=locks, rebalance_offset=offset
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
            run_id=member["id"],
            variant="p1",
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
        for into, done in ((close, at_close), (opened, at_open)):
            curve = pd.Series(done.equity)
            curve.index = pd.to_datetime(curve.index)
            into.append(curve.sort_index())
        details.append(
            {
                "offset": offset,
                "sleeve_cagr_at_close": st.cagr(at_close.equity),
                "sleeve_cagr_at_open_whole_shares": st.cagr(at_open.equity),
                "average_gap_on_buys": gaps["average_gap_on_buys"],
                "average_gap_on_sells": gaps["average_gap_on_sells"],
                "orders_with_no_open_that_week": gaps["orders_with_no_open_that_week"],
                "replay_problems": at_open.problems[:3],
            }
        )
    return {
        "close": method.blend_phases(close, per_sleeve=True),
        "open": method.blend_phases(opened, per_sleeve=True),
        "sleeves": details,
    }


def stage_variants(ranking: str) -> None:
    from momentum_backtesting import bias, metrics

    out = _out(ranking)
    dest = out / "variants.json"
    if dest.exists():
        print(f"{ranking} variants: already done")
        return
    curves: dict[str, pd.Series] = {}
    turnover: dict[str, list[float]] = {}
    profit = pd.Series(dtype="float64")
    monday: dict[str, dict] = {}
    plan = _variant_plan(ranking)
    team = members(ranking)
    for member in team:
        cid, rec = member["id"], member["rec"]
        runner = runner_for(member["folder"])
        base = runner.base(rec["heavy"])
        locks = None
        every = every_of(runner, rec["light"])
        for name, tags, taxed, window in plan:
            started = time.time()
            keep = name == ("T_real" if ranking == "curated" else "T0_after_tax")
            blend, sleeves, locks, kept = blend_member(
                runner,
                base,
                rec["heavy"],
                rec["light"],
                tags=tags,
                taxed=taxed,
                locks=locks,
                window=window,
                keep=keep,
            )
            curves[f"{name}|{cid}"] = blend
            for offset, sleeve in enumerate(sleeves):
                curves[f"{name}|{cid}|{offset}"] = sleeve / sleeve.iloc[0]
            for outcome, ranking_ in kept:
                # each sleeve's share of the ensemble: 1 / (configs x its Fridays)
                share = 1.0 / (len(team) * every)
                profit = profit.add(bias.profit_by_stock(outcome, ranking_) * share, fill_value=0)
                turnover.setdefault(cid, []).append(float(metrics.turnover(outcome.result)))
            print(
                f"{ranking} {cid} {name}: CAGR {four._stats(blend)['cagr']:.4f} "
                f"({time.time() - started:.0f} s)",
                flush=True,
            )
        started = time.time()
        m = _monday_open(runner, member, base, locks)
        curves[f"M_close|{cid}"], curves[f"M_open|{cid}"] = m["close"], m["open"]
        monday[cid] = {"sleeves": m["sleeves"]}
        print(f"{ranking} {cid} monday-open replay ({time.time() - started:.0f} s)", flush=True)
    profit = profit.sort_values(ascending=False)
    total = float(profit.sum())
    concentration = {
        "realised_profit_total_in_sleeve_units": total,
        "top5_share": float(profit.head(5).sum() / total) if total > 0 else None,
        "top5": {k: float(v / total) for k, v in profit.head(5).items()} if total > 0 else {},
        "flag_top5_above_50pct": bool(total > 0 and profit.head(5).sum() / total > 0.5),
    }
    frame = pd.DataFrame(curves)
    frame.columns = [str(c) for c in frame.columns]
    frame.to_parquet(out / "variant_curves.parquet")
    dest.write_text(
        json.dumps(
            {
                "members": [{k: m[k] for k in ("id", "folder", "phase_slot")} for m in team],
                "variants": [p[0] for p in plan],
                "turnover_real": {cid: float(np.mean(v)) for cid, v in turnover.items()},
                "concentration_real": concentration,
                "monday_open": monday,
                "backtests_run": RUNS["count"],
            },
            indent=1,
            default=str,
        )
    )
    print(f"{ranking} variants: done ({RUNS['count']} backtests)", flush=True)


# --- stage 2: G4, every member's one-step neighbours ------------------------------------------


def _neighbour_tasks(ranking: str) -> list[dict]:
    from momentum_backtesting import robust

    groups: dict[str, dict] = {}
    for member in members(ranking):
        space = space_of(member["folder"])
        for nudge in robust.nudges(member["rec"], space):
            if nudge["kind"] in ("offset", "start"):
                continue  # every Friday is in the blend already; no later starts (addendum 1)
            key = f"{member['folder']}|{member['id']}|{robust._heavy_key(nudge['heavy'])}"
            group = groups.setdefault(
                key,
                {
                    "folder": member["folder"],
                    "member": member["id"],
                    "heavy": nudge["heavy"],
                    "nudges": [],
                },
            )
            group["nudges"].append(
                {"label": nudge["label"], "kind": nudge["kind"], "light": nudge["light"]}
            )
    return [{**groups[k], "index": i} for i, k in enumerate(sorted(groups))]


def _neighbour_task(task: dict) -> dict:
    from momentum_backtesting import reference_benchmarks

    runner = runner_for(task["folder"])
    base = runner.base(task["heavy"])
    rows, curves, locks = [], {}, None
    for nudge in task["nudges"]:
        started = time.time()
        row = {"member": task["member"], "label": nudge["label"], "kind": nudge["kind"]}
        try:
            blend, _, locks, _ = blend_member(
                runner, base, task["heavy"], nudge["light"], tags=None, taxed=False, locks=locks
            )
            mom = reference_benchmarks.aligned(runner.refs[MOM30], blend.index)
            row.update(
                four._stats(blend),
                mom30_cagr=float(four._stats(mom)["cagr"]),
                every=every_of(runner, nudge["light"]),
            )
            curves[f"{task['member']}|{nudge['label']}"] = blend
        except Exception as error:  # noqa: BLE001 - recorded, the rest still runs
            row["error"] = f"{type(error).__name__}: {error}"[:300]
        row["secs"] = round(time.time() - started)
        rows.append(row)
    dest = Path(task["dest"])
    if curves:
        pd.DataFrame(curves).to_parquet(dest / f"neighbours-{task['index']:03d}.parquet")
    with (dest / f"neighbours-{task['index']:03d}.jsonl").open("w") as sink:
        sink.writelines(json.dumps(r) + "\n" for r in rows)
    return {"index": task["index"], "runs": len(rows), "runs_backtests": RUNS["count"]}


def _pool_run(fn, tasks: list[dict], workers: int, label: str) -> None:
    print(f"{label}: {len(tasks)} tasks to run, {workers} workers", flush=True)
    if not tasks:
        return
    started = time.time()
    ctx = mp.get_context("spawn")
    with ctx.Pool(workers, maxtasksperchild=1) as pool:
        for done in pool.imap_unordered(fn, tasks):
            print(
                f"  {label} task {done['index']}: {done['runs']} done "
                f"(elapsed {time.time() - started:.0f} s)",
                flush=True,
            )


def stage_neighbours(ranking: str, workers: int) -> None:
    out = _out(ranking)
    tasks = [
        {**t, "dest": str(out)}
        for t in _neighbour_tasks(ranking)
        if not (out / f"neighbours-{t['index']:03d}.jsonl").exists()
    ]
    _pool_run(_neighbour_task, tasks, workers, f"{ranking} neighbours")


# --- stage 3: G6, the fair placebo -------------------------------------------------------------

PLACEBO_CHUNKS = 10  # seeds per member are split into this many tasks


def _placebo_task(task: dict) -> dict:
    from momentum_backtesting import method

    member = next(m for m in members(task["ranking"]) if m["id"] == task["member"])
    rec = member["rec"]
    runner = runner_for(member["folder"])
    base = runner.base(rec["heavy"])
    light = {**rec["light"], "stock_tilt": 0.0}  # tilt would let real momentum back in
    curves, locks = {}, None
    for seed in task["seeds"]:
        fake = method.persistent_random_ranks(base.global_ranks, seed)
        used = dataclasses.replace(base, global_ranks=fake)
        blend, _, locks, _ = blend_member(
            runner, used, rec["heavy"], light, tags=None, taxed=False, locks=locks
        )
        curves[str(seed)] = blend
    pd.DataFrame(curves).to_parquet(
        Path(task["dest"]) / f"placebo-{task['member']}-{task['chunk']:02d}.parquet"
    )
    return {"index": f"{task['member']}/{task['chunk']}", "runs": len(task["seeds"])}


def stage_placebo(ranking: str, workers: int) -> None:
    out = _out(ranking)
    tasks = []
    for member in members(ranking):
        for chunk in range(PLACEBO_CHUNKS):
            if (out / f"placebo-{member['id']}-{chunk:02d}.parquet").exists():
                continue
            tasks.append(
                {
                    "ranking": ranking,
                    "member": member["id"],
                    "chunk": chunk,
                    "seeds": list(range(SEEDS))[chunk::PLACEBO_CHUNKS],
                    "dest": str(out),
                }
            )
    _pool_run(_placebo_task, tasks, workers, f"{ranking} placebo")


# --- stage 4: gates and the result -------------------------------------------------------------


def g4_pooled(neigh: pd.DataFrame, own: dict[str, float]) -> dict:
    """Addendum 1's G4: every neighbour against its own member's P0, pooled over the members."""
    gap = (neigh["cagr"] - neigh["member"].map(own)) * 100
    above = (neigh["cagr"] - neigh["mom30_cagr"]) >= four.G4_ABOVE_MOM30
    median_gap, share = float(gap.median()), float(above.mean())
    per_member = {
        cid: {
            "neighbours": int(len(g)),
            "median_gap_pts": float(gap[g.index].median()),
            "share_5_pts_above_mom30": float(above[g.index].mean()),
            "worst": g.loc[g["cagr"].idxmin(), ["label", "cagr"]].to_dict(),
        }
        for cid, g in neigh.groupby("member")
    }
    return {
        "pass": four.g4_passes(median_gap, share),
        "neighbours": int(len(neigh)),
        "median_gap_pts": median_gap,
        "share_5_pts_above_mom30": share,
        "per_member": per_member,
    }


def placebo_ensembles(frames: dict[str, pd.DataFrame]) -> pd.Series:
    """One placebo ensemble per seed (every member on that seed), CAGR by seed."""
    from momentum_backtesting import choose

    seeds = sorted(set.intersection(*(set(f.columns) for f in frames.values())), key=int)
    return pd.Series(
        {int(s): float(choose.cagr(ensemble({m: f[s] for m, f in frames.items()}))) for s in seeds}
    )


def trial_count(ranking: str) -> int:
    """Configs tried in this ranking's Stage 1 and 2 arms (every stored run with metrics; arm B
    counts in both rankings, since each chose among it)."""
    return sum(
        sum('"metrics"' in line for line in results.read_text().splitlines())
        for folder in ARMS[ranking]
        for results in (_search_dir() / folder).glob("results-*.jsonl")
    )


def stage_report(ranking: str) -> None:
    from momentum_backtesting import choose, criteria, final, method, phase5, reference_benchmarks

    smoke = bool(DEST or ONLY)  # a smoke run never writes the registered result
    target = _out(ranking) / "smoke_result.json" if smoke else result_path(ranking)
    if target.exists():
        sys.exit(f"{target.name} exists: the check runs once (addendum 1). Supersede, don't rerun.")
    out = _out(ranking)
    meta = json.loads((out / "variants.json").read_text())
    curves = pd.read_parquet(out / "variant_curves.parquet")
    ids = [m["id"] for m in meta["members"]]

    def variant(name: str) -> pd.Series:
        name = ALIASES.get(ranking, {}).get(name, name)
        return ensemble({cid: curves[f"{name}|{cid}"] for cid in ids})

    names = ["P0_as_ranked", "P1_extended_tags", "T0_after_tax", "T_real", "T_real_50k"]
    ens = {n: variant(n) for n in names}
    m_close = ensemble({cid: curves[f"M_close|{cid}"] for cid in ids})
    m_open = ensemble({cid: curves[f"M_open|{cid}"] for cid in ids})
    m_change = {
        "cagr": four._stats(m_open)["cagr"] - four._stats(m_close)["cagr"],
        "mdd": four._stats(m_open)["mdd"] - four._stats(m_close)["mdd"],
    }
    stats = {n: four._stats(c) for n, c in ens.items()}
    real = ens["T_real"]
    e = {
        "cagr": stats["T_real"]["cagr"] + m_change["cagr"],
        "mdd": stats["T_real"]["mdd"] + m_change["mdd"],
    }

    refs = reference_benchmarks.load_references()
    span = real.index
    cutoff = min(refs[n].dropna().index[-1] for n in (N50, SMALL, MID, N500))
    short = span[span <= cutoff]
    bench = {MOM30: reference_benchmarks.aligned(refs[MOM30], span)}
    bench.update({n: reference_benchmarks.aligned(refs[n], short) for n in (N50, SMALL, MID, N500)})
    mom_cagr = float(choose.cagr(bench[MOM30]))

    def g1(change: float) -> bool:
        return (stats["T_real"]["cagr"] + change) - mom_cagr >= four.G1_EXCESS_OVER_MOM30

    gates = {
        "G1_minimum_bar": {
            "pass": g1(m_change["cagr"]),
            "e_cagr": e["cagr"],
            "mom30_cagr": mom_cagr,
            "excess_pts": (e["cagr"] - mom_cagr) * 100,
            "excess_pts_if_monday_change_were_zero": (stats["T_real"]["cagr"] - mom_cagr) * 100,
        }
    }
    indices = {SMALL: bench[SMALL], MID: bench[MID]}
    real_short = real.loc[:cutoff]
    medium = criteria.basket_passes(real_short, indices, "medium")
    ceiling = criteria.load()["baskets"]["medium"]["hard_ceiling"]
    gates["G2_drawdown_basket"] = {
        "pass": bool(medium and e["mdd"] >= ceiling),
        "t_real_passes_medium": bool(medium),
        "t_real_passes_aggressive_reported": bool(
            criteria.basket_passes(real_short, indices, "aggressive")
        ),
        "t_real_mdd": stats["T_real"]["mdd"],
        "e_mdd": e["mdd"],
        "hard_ceiling": ceiling,
    }
    fys = choose.complete_fys(real.index)
    fy = pd.DataFrame(
        {
            "T_real": {y: choose.window_returns(real, *choose.fy_bounds(y)) for y in fys},
            **{
                n: {y: choose.window_returns(s, *choose.fy_bounds(y)) for y in fys}
                for n, s in bench.items()
            },
        }
    )
    excess = fy["T_real"] - fy[MOM30]
    gates["G3_no_bad_year"] = {
        "pass": bool(excess.min() >= four.G3_WORST_FY_VS_MOM30),
        "worst_fy": int(excess.idxmin()),
        "worst_fy_excess_pts": float(excess.min() * 100),
        "fy_table": {int(y): {k: float(v) for k, v in row.items()} for y, row in fy.iterrows()},
    }

    neigh = pd.concat(
        [pd.read_json(p, lines=True) for p in sorted(out.glob("neighbours-*.jsonl"))],
        ignore_index=True,
    )
    errored = neigh[neigh["error"].notna()] if "error" in neigh.columns else neigh.iloc[0:0]
    neigh_ok = neigh.drop(errored.index)
    own = {cid: float(four._stats(curves[f"P0_as_ranked|{cid}"])["cagr"]) for cid in ids}
    gates["G4_plateau"] = {**g4_pooled(neigh_ok, own), "errored_neighbours": int(len(errored))}
    ncurves = pd.concat(
        [pd.read_parquet(p) for p in sorted(out.glob("neighbours-*.parquet"))], axis=1
    )
    swapped = []
    p0 = {cid: curves[f"P0_as_ranked|{cid}"] for cid in ids}
    for column in ncurves.columns:
        cid = column.split("|")[0]
        swapped.append(float(choose.cagr(ensemble({**p0, cid: ncurves[column]}))))
    gates["G4_plateau"]["swapped_ensemble_reported"] = {
        "median_cagr": float(np.median(swapped)),
        "p0_cagr": stats["P0_as_ranked"]["cagr"],
        "median_gap_pts": float((np.median(swapped) - stats["P0_as_ranked"]["cagr"]) * 100),
    }

    cash = runner_for(meta["members"][0]["folder"]).common["outer_prices"]["Cash (liquid fund)"]
    factors = choose.factor_regression(real, cash, bench[N50], bench[SMALL], bench[MOM30])
    gates["G5_alpha"] = {
        "pass": bool(
            factors["alpha_pa"] >= four.G5_ALPHA and abs(factors["alpha_t"]) >= four.G5_ABS_T
        ),
        **factors,
    }

    frames = {
        cid: pd.concat(
            [pd.read_parquet(p) for p in sorted(out.glob(f"placebo-{cid}-*.parquet"))], axis=1
        )
        for cid in ids
    }
    placebo = placebo_ensembles(frames)
    p95 = float(np.sort(placebo.to_numpy())[min(len(placebo) - 1, int(0.95 * len(placebo)))])
    base_cagr = stats["P0_as_ranked"]["cagr"]
    per_member_placebo = {}
    for cid, frame in frames.items():
        c = np.sort(choose.cagr(frame).to_numpy())
        per_member_placebo[cid] = {
            "p0_cagr": own[cid],
            "placebo_p95": float(c[min(len(c) - 1, int(0.95 * len(c)))]),
            "margin_pts": float((own[cid] - c[min(len(c) - 1, int(0.95 * len(c)))]) * 100),
        }
    gates["G6_fair_placebo"] = {
        "pass": bool(base_cagr - p95 >= four.G6_MARGIN_OVER_P95),
        "seeds": int(len(placebo)),
        "p0_cagr": base_cagr,
        "placebo_median": float(placebo.median()),
        "placebo_p95": p95,
        "margin_over_p95_pts": (base_cagr - p95) * 100,
        "per_member_reported": per_member_placebo,
    }

    def verdict(g1_pass: bool) -> str:
        return four.verdict_of(
            g1_pass,
            gates["G2_drawdown_basket"]["pass"],
            gates["G3_no_bad_year"]["pass"],
            [gates[k]["pass"] for k in ("G4_plateau", "G5_alpha", "G6_fair_placebo")],
        )

    final_verdict = verdict(gates["G1_minimum_bar"]["pass"])

    # reported, not judged
    per_member = {
        cid: {n: four._stats(curves[f"{ALIASES.get(ranking, {}).get(n, n)}|{cid}"]) for n in names}
        for cid in ids
    }
    spread = {
        cid: [
            four._stats(curves[c]) | {"offset": int(c.rsplit("|", 1)[1])}
            for c in curves.columns
            if c.startswith(f"P0_as_ranked|{cid}|")
        ]
        for cid in ids
    }
    one_friday = {}
    for n in ("P0_as_ranked", "T_real"):
        src = ALIASES.get(ranking, {}).get(n, n)
        picks = {m["id"]: curves[f"{src}|{m['id']}|{m['phase_slot']}"] for m in meta["members"]}
        one_friday[n] = four._stats(ensemble(picks))
    rolling = {}
    for years in (2, 3):
        mine, theirs = phase5._rolling(real, years), phase5._rolling(bench[MOM30], years)
        diff = (mine - theirs).dropna()
        rolling[f"{years}y"] = {
            "worst": float(mine.min()),
            "median": float(mine.median()),
            "best": float(mine.max()),
            "worst_vs_mom30_pts": float(diff.min() * 100),
            "share_above_mom30": float((diff > 0).mean()),
        }
    boot = {f"{b}w": choose.block_bootstrap(real, mean_block=b) for b in (13, 26)}

    pairs = [
        (_search_dir() / f, _search_dir() / "round8_stage3" / "scored" / f"{ranking}__{f}")
        for f in ARMS[ranking]
    ]
    _, stored, _ = method.load_pooled(pairs)
    reproduction = {
        cid: {
            "stored_cagr": float(choose.cagr(stored[cid].dropna())),
            "p0_cagr": own[cid],
            "gap_pts": (own[cid] - float(choose.cagr(stored[cid].dropna()))) * 100,
        }
        for cid in ids
    }
    mom_w = bench[MOM30].pct_change()
    excess_w = (ens["P0_as_ranked"].pct_change() - mom_w).dropna().to_numpy()
    trials = stored.pct_change().sub(mom_w.reindex(stored.index), axis=0)
    trial_sharpes = (trials.mean() / trials.std(ddof=1)).dropna().to_numpy()
    n_trials = trial_count(ranking)
    dsr = final.deflated_sharpe(excess_w, trial_sharpes, n_trials)

    other = "extended" if ranking == "curated" else "curated"
    other_curves = _search_dir() / "round8_stage3" / "finalists" / other / "variant_curves.parquet"
    correlation = None
    if other_curves.exists():
        oc = pd.read_parquet(other_curves)
        other_ids = json.loads((other_curves.parent / "variants.json").read_text())["members"]
        mine_p0 = ens["P0_as_ranked"]
        theirs_p0 = ensemble({m["id"]: oc[f"P0_as_ranked|{m['id']}"] for m in other_ids})
        both = pd.concat([mine_p0, theirs_p0], axis=1).dropna().pct_change().dropna()
        correlation = float(both.corr().iloc[0, 1])

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
    placebo_runs = sum(len(frames[cid].columns) * len(spread[cid]) for cid in ids)
    result = {
        "written": date.today().isoformat(),
        "criteria": ADDENDUM.name,
        "ranking": ranking,
        "members": meta["members"],
        "window": [str(span[0].date()), str(span[-1].date())],
        "weeks": int(len(span)),
        "commit": commit,
        "working_tree_dirty": dirty,
        "data_version": data_version,
        "verdict": final_verdict,
        "verdict_flips_if_monday_change_zero": verdict(g1(0.0)) != final_verdict,
        "gates": gates,
        "ensemble": stats,
        "tax_drag_pts": (stats["P0_as_ranked"]["cagr"] - stats["T0_after_tax"]["cagr"]) * 100,
        "monday_open_change": m_change,
        "monday_open_sleeves": meta["monday_open"],
        "e_expected_case": e,
        "members_by_variant": per_member,
        "turnover_real": meta["turnover_real"],
        "friday_spread_P0": spread,
        "one_friday_ensemble_reported": one_friday,
        "concentration_real": meta["concentration_real"],
        "rolling_windows_T_real": rolling,
        "bootstrap_T_real": boot,
        "deflated_sharpe_P0": {
            **dsr,
            "n_trials": n_trials,
            "trial_sharpes_from": f"{len(trial_sharpes)} Stage 3 blends",
            "prior_trials_named": "round 7: 8,003 (arm A), 4,754 (C1 / C2)",
        },
        "p0_reproduction": reproduction,
        "correlation_with_other_ensemble_P0": correlation,
        "comparators_cagr": {n: float(choose.cagr(s)) for n, s in bench.items()},
        "benchmark_cutoff": str(cutoff.date()),
        "backtests_run": meta["backtests_run"] + int(neigh_ok["every"].sum()) + placebo_runs,
    }
    target.write_text(json.dumps(result, indent=1, default=str) + "\n")
    print(
        json.dumps(
            {
                "ranking": ranking,
                "verdict": final_verdict,
                **{k: v["pass"] for k, v in gates.items()},
            },
            indent=1,
        )
    )


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("stage", choices=["variants", "neighbours", "placebo", "report"])
    parser.add_argument("--ranking", choices=sorted(ARMS), required=True)
    parser.add_argument("--workers", type=int, default=3)
    parser.add_argument("--dest", type=Path, help="Scratch folder instead of the finalists one.")
    parser.add_argument("--only", help="Smoke: keep one member id only.")
    args = parser.parse_args()
    if args.dest:
        DEST["root"] = args.dest
    if args.only:
        ONLY["id"] = args.only
    if args.stage == "variants":
        stage_variants(args.ranking)
    elif args.stage == "neighbours":
        stage_neighbours(args.ranking, args.workers)
    elif args.stage == "placebo":
        stage_placebo(args.ranking, args.workers)
    else:
        stage_report(args.ranking)


if __name__ == "__main__":
    main()
