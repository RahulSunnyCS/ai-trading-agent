"""Broad Momentum parameter search: a resumable, parallel, low-discrepancy sweep.

One search = one *arm* (a universe + category mode) and a TOML space file. The space has two
kinds of parameter, split by what changing them costs:

  heavy  - decide the global momentum ranking (lookbacks, score, liquidity gate, ...). A distinct
           combination costs a full `compute_universe_base` (9 s on the ~1,200-column
           Total Market universe, ~56 s on the ~8,000-column all-liquid one).
  light  - everything after it (pool cut, category selection, caps, cadence, overlays, ...).
           ~1 s per run on a cached base.

So a run is `heavy_samples` heavy combinations x `light_samples` light points each: one base is
built per heavy combination and reused for all its light points. Light points come from a
randomly-shifted Halton sequence (even coverage of the space, no scipy needed); the heavy
combinations are a random sample of the product of their choices.

Results are appended one JSON line per run to `<out>/results-<pid>.jsonl`, so a crash or a stopped
laptop loses at most the run in flight, and re-running the same command skips what is already
there (a run's id is a hash of its full parameters). Nothing here is tuned or scored beyond the
raw metrics; `analyze` applies the three drawdown profiles to whatever has been collected.
"""

from __future__ import annotations

import hashlib
import inspect
import itertools
import json
import math
import multiprocessing as mp
import os
import time
import tomllib
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd

from . import metrics
from .engine import IDLE

# Space-file parameters that are not arguments of run_broad_backtest, and what they feed.
HEAVY_KEYS = {
    "lookbacks",
    "weight_scheme",
    "score",
    "voladj_skip_recent_month",
    "min_drop_pct",
    "turnover_spike_multiple",
    "series_break_policy",  # "legacy" | "verified" (see api.BacktestRequest.broad_series_breaks)
    "liq_min_turnover_cr",
    "liq_floor_ratio",
    "liq_min_price",
    "liq_circuit",
    "liq_circuit_run",
    "liq_max_circuit_days",
}
DERIVED_KEYS = {
    "pool_band",
    "category_band",
    "off_band",
    "rebalance_offset_raw",
    "respect_circuits",  # lock_masks (UC blocks buys, LC blocks sells) on every run when true
}
ARMS = {
    "A": ("total_market", "on"),
    "B": ("total_market", "off"),
    "C1": ("all_liquid", "on"),
    "C2": ("all_liquid", "off"),
}
#: Arms whose category layer reads the extended tag file (stocks outside the 755-name Total Market
#: are tagged too). Every other arm uses the curated 755-name file, as in Rounds 1-5.
EXTENDED_TAG_ARMS = {"C1"}
ROLLING_WEEKS = 156  # 3 years

_PRIMES = (2, 3, 5, 7, 11, 13, 17, 19, 23, 29, 31, 37, 41, 43, 47, 53, 59, 61, 67, 71)


# --- space file ----------------------------------------------------------------------------


@dataclass(frozen=True)
class Dim:
    name: str
    kind: str  # "choice" | "int" | "float"
    values: tuple

    def pick(self, u: float) -> Any:
        """Map u in [0, 1) onto this dimension."""
        if self.kind == "choice":
            return self.values[min(int(u * len(self.values)), len(self.values) - 1)]
        lo, hi = self.values
        if self.kind == "int":
            return min(int(lo + u * (hi - lo + 1)), hi)
        return round(float(lo + u * (hi - lo)), 4)


@dataclass(frozen=True)
class Space:
    name: str
    arm: str
    fixed: dict[str, Any]
    heavy: tuple[Dim, ...]
    light: tuple[Dim, ...]
    sealed_from: str | None = None


def _none(value: Any) -> Any:
    """TOML has no null: the string "none" stands for None (e.g. no cap)."""
    if isinstance(value, list):
        return [_none(v) for v in value]
    return None if value == "none" else value


def _dim(name: str, spec: Any) -> Dim:
    if not isinstance(spec, dict) or len(spec) != 1:
        raise ValueError(f"{name}: expected one of choice/int/float, got {spec!r}")
    ((kind, values),) = spec.items()
    if kind == "choice":
        if not values:
            raise ValueError(f"{name}: empty choice list")
        values = _none(values)
        return Dim(name, "choice", tuple(tuple(v) if isinstance(v, list) else v for v in values))
    if kind in ("int", "float"):
        if len(values) != 2 or values[0] > values[1]:
            raise ValueError(f"{name}: {kind} needs [low, high]")
        return Dim(name, kind, tuple(values))
    raise ValueError(f"{name}: unknown kind {kind!r}")


def load_space(path: Path) -> Space:
    raw = tomllib.loads(Path(path).read_text())
    arm = raw["arm"]
    if arm not in ARMS:
        raise ValueError(f"arm must be one of {sorted(ARMS)}")
    heavy = tuple(_dim(k, v) for k, v in (raw.get("heavy") or {}).items())
    light = tuple(_dim(k, v) for k, v in (raw.get("light") or {}).items())
    for dim in heavy:
        if dim.name not in HEAVY_KEYS:
            raise ValueError(f"heavy parameter {dim.name!r} is not a ranking parameter")
    from .categories import broad

    allowed = set(inspect.signature(broad.run_broad_backtest).parameters) | DERIVED_KEYS
    for dim in light:
        if dim.name in HEAVY_KEYS or dim.name not in allowed:
            raise ValueError(f"light parameter {dim.name!r} is not a run_broad_backtest argument")
    fixed = {k: _none(v) for k, v in (raw.get("fixed") or {}).items()}
    # A sealed hold-out: a space that declares `sealed_from` may not see data on or after it.
    # Tuning rounds set `end` before that date; the sealed period is opened once, at the end,
    # by a space with no `sealed_from`, for the finalists only.
    sealed_from = raw.get("sealed_from")
    if sealed_from is not None and not (fixed.get("end") and str(fixed["end"]) < str(sealed_from)):
        raise ValueError(
            f"sealed_from = {sealed_from!r}: fixed.end must be set and earlier than that date"
        )
    for key in fixed:
        if key not in allowed and key not in HEAVY_KEYS:
            raise ValueError(f"fixed parameter {key!r} is not recognised")
    return Space(raw.get("name", Path(path).stem), arm, fixed, heavy, light, sealed_from)


# --- sampling -------------------------------------------------------------------------------


def _radical_inverse(index: np.ndarray, base: int) -> np.ndarray:
    result = np.zeros(len(index))
    f = 1.0 / base
    i = index.copy()
    while i.max() > 0:
        result += f * (i % base)
        i //= base
        f /= base
    return result


def halton(n: int, dims: int, rng: np.random.Generator) -> np.ndarray:
    """n x dims points in [0, 1): Halton with a random shift (Cranley-Patterson rotation)."""
    if dims > len(_PRIMES):
        raise ValueError(f"at most {len(_PRIMES)} searched light parameters")
    index = np.arange(1, n + 1) + 20  # skip the first few, which are strongly correlated
    cols = [_radical_inverse(index, _PRIMES[d]) for d in range(dims)]
    points = np.column_stack(cols) if cols else np.zeros((n, 0))
    return (points + rng.random(dims)) % 1.0


def heavy_combinations(space: Space, count: int, seed: int) -> list[dict[str, Any]]:
    """Up to `count` distinct combinations of the heavy dimensions (all of them if fewer)."""
    if not space.heavy:
        return [{}]
    for dim in space.heavy:
        if dim.kind != "choice":
            raise ValueError(f"heavy parameter {dim.name!r} must be a choice list")
    product = list(itertools.product(*(d.values for d in space.heavy)))
    if len(product) > count:
        rng = np.random.default_rng([seed, 1])
        product = [product[i] for i in rng.choice(len(product), size=count, replace=False)]
    return [dict(zip((d.name for d in space.heavy), combo, strict=True)) for combo in product]


def weights_for(scheme: str | None, n: int) -> tuple[float, ...] | None:
    if scheme in (None, "equal"):
        return None
    if scheme == "recent":  # shorter lookbacks count more
        return tuple(float(n - i) for i in range(n))
    if scheme == "long":  # longer lookbacks count more
        return tuple(float(i + 1) for i in range(n))
    raise ValueError(f"unknown weight_scheme {scheme!r}")


def resolve_light(space: Space, point: dict[str, Any]) -> dict[str, Any]:
    """Sampled light values, with the derived ones turned into real arguments."""
    values = {**space.fixed, **point}
    derived: set[str] = set()
    for band, top, exit_ in (
        ("pool_band", "pool_top_n", "pool_exit_rank"),
        ("category_band", "category_top_n", "category_exit_rank"),
        ("off_band", "off_top_n", "off_exit_rank"),
    ):
        if band in values:
            values[exit_] = values.get(top, _DEFAULTS[top]) + values.pop(band)
            derived.add(exit_)
    if "rebalance_offset_raw" in values:
        raw = values.pop("rebalance_offset_raw")
        values["rebalance_offset"] = raw % values.get("rebalance_every", 1)
        derived.add("rebalance_offset")
    # Only what the search chose; the fixed settings are merged back in when a run starts.
    return {k: v for k, v in values.items() if k in point or k in derived}


_DEFAULTS = {"pool_top_n": 200, "category_top_n": 5, "off_top_n": 10}


def feasible(arm: str, v: dict[str, Any]) -> bool:
    """Skip combinations the engine would reject or that hold cash back by construction."""
    on = ARMS[arm][1] == "on"
    pool_top, pool_exit = v.get("pool_top_n", 200), v.get("pool_exit_rank", 250)
    if pool_top > pool_exit:
        return False
    cap = v.get("max_position", 0.35)
    if on:
        top, exit_ = v.get("category_top_n", 5), v.get("category_exit_rank", 10)
        picks = v.get("picks_per_category", 1)
        if top > exit_ or exit_ > 40 or picks * top > pool_top:
            return False
        if cap and cap * top * picks < 1:
            return False
        group_cap = v.get("max_category")
        if group_cap and group_cap * top < 1:
            return False
    else:
        top, exit_ = v.get("off_top_n", 10), v.get("off_exit_rank", 20)
        if top > exit_ or top > pool_top:
            return False
        if cap and cap * top < 1:
            return False
    return True


def run_id(arm: str, heavy: dict, light: dict, fixed: dict, snapshot: dict | None = None) -> str:
    """A hash of everything that decides a run's result. `snapshot` (see `data_snapshot`) ties
    it to the data too, so a search resumed after new data arrives runs again instead of
    mixing results from two different histories (BL-010 F12). Searches written before the
    snapshot existed passed None and keep their ids."""
    content = {"arm": arm, "h": heavy, "l": light, "f": fixed}
    if snapshot is not None:
        content["d"] = snapshot
    blob = json.dumps(content, sort_keys=True, default=list)
    return hashlib.sha1(blob.encode()).hexdigest()[:12]


def data_snapshot(root: Path | None = None, through: str | None = None) -> dict[str, Any] | None:
    """What the data looked like: the last daily stock bar and weekly close, and a digest of
    the confirmed split and bonus factors. With `through` (a run's fixed end date) only data up
    to that date counts, so a new week beyond an end-dated run does not change its snapshot.
    None when there is no catalog."""
    from . import db_read

    if db_read.catalog_mtime(root) is None:
        return None
    with db_read.open_catalog(root, read_only=True) as con:
        cap = through or "9999-12-31"
        last_bar = con.execute(
            "SELECT CAST(max(date) AS DATE) FROM bars_1d_stock WHERE date <= CAST(? AS DATE)",
            [cap],
        ).fetchone()[0]
        last_week = con.execute(
            "SELECT max(date) FROM momentum_prices WHERE kind = 'weekly' "
            "AND date <= CAST(? AS DATE)",
            [cap],
        ).fetchone()[0]
        factors = con.execute(
            "SELECT symbol, ex_date, confirmed_factor FROM stock_action_candidates "
            "WHERE status = 'confirmed' AND ex_date <= CAST(? AS DATE) ORDER BY symbol, ex_date",
            [cap],
        ).fetchall()
    digest = hashlib.sha1(json.dumps(factors, default=str).encode()).hexdigest()[:12]
    return {"last_bar": str(last_bar), "last_week": str(last_week), "factors": digest}


def plan(
    space: Space,
    heavy_count: int,
    light_count: int,
    seed: int,
    snapshot: dict | None = None,
) -> list[dict[str, Any]]:
    """The full list of groups: [{heavy, runs: [{id, light}]}]. Deterministic for a seed and a
    data snapshot."""
    groups = []
    for gi, heavy in enumerate(heavy_combinations(space, heavy_count, seed)):
        rng = np.random.default_rng([seed, 2, gi])
        points = halton(light_count * 3, len(space.light), rng)  # over-draw, then filter
        runs: list[dict[str, Any]] = []
        for row in points:
            sampled = {dim.name: dim.pick(u) for dim, u in zip(space.light, row, strict=True)}
            light = resolve_light(space, sampled)
            if not feasible(space.arm, {**space.fixed, **light}):
                continue
            run = run_id(space.arm, heavy, light, space.fixed, snapshot)
            runs.append({"id": run, "light": light})
            if len(runs) == light_count:
                break
        groups.append({"heavy": heavy, "runs": runs})
    return groups


# --- running one group ----------------------------------------------------------------------


def run_metrics(result, hold_idle: str) -> dict[str, float]:
    eq, bench = result.equity, result.benchmark
    cash = result.cash
    weekly = eq.pct_change().dropna()
    excess = weekly - cash.pct_change().dropna()
    depth, _, _ = metrics.max_drawdown(eq)
    cg = metrics.cagr(eq)
    years = metrics._years(eq)
    trades = result.trades
    buys = trades[trades["action"] == "BUY"] if len(trades) else trades
    half = len(eq) // 2
    out = {
        "cagr": cg,
        "mdd": depth,
        "calmar": cg / abs(depth) if depth < 0 else math.nan,
        "sharpe": excess.mean() / excess.std() * math.sqrt(52) if excess.std() > 0 else math.nan,
        "bench_cagr": metrics.cagr(bench),
        "bench_mdd": metrics.max_drawdown(bench)[0],
        "buys_per_yr": len(buys) / years,
        "turnover_x": metrics.turnover(result),
        "cagr_h1": metrics.cagr(eq.iloc[: half + 1]),
        "cagr_h2": metrics.cagr(eq.iloc[half:]),
        "idle_share": float(result.weights[hold_idle].mean()) if hold_idle in result.weights else 0,
        "weeks": len(eq),
    }
    out.update({f"uw_{k}": v for k, v in metrics.underwater_stats(eq).items()})
    if len(eq) > ROLLING_WEEKS:
        e, b = eq.to_numpy(), bench.to_numpy()
        roll = (e[ROLLING_WEEKS:] / e[:-ROLLING_WEEKS]) ** (52 / ROLLING_WEEKS) - 1
        roll_b = (b[ROLLING_WEEKS:] / b[:-ROLLING_WEEKS]) ** (52 / ROLLING_WEEKS) - 1
        out["roll3y_worst"] = float(np.nanmin(roll))
        out["roll3y_beat"] = float(np.mean(roll > roll_b))
    return {k: (round(float(v), 5) if isinstance(v, float) else v) for k, v in out.items()}


def _split_light(space: Space, light: dict[str, Any]) -> dict[str, Any]:
    """Arguments for run_broad_backtest from a resolved light dict (+ the arm's own settings)."""
    kwargs = {k: v for k, v in light.items() if k not in HEAVY_KEYS}
    kwargs.pop("pool_top_n", None)
    kwargs.pop("pool_exit_rank", None)
    if ARMS[space.arm][1] == "off":  # category-layer arguments are errors in OFF mode
        for key in (
            "max_category",
            "mass_exit_response",
            "mass_exit_threshold",
            "mass_exit_throttle_fraction",
        ):
            kwargs.pop(key, None)
    kwargs["category_mode"] = ARMS[space.arm][1]
    kwargs["category_tags"] = "extended" if space.arm in EXTENDED_TAG_ARMS else "curated"
    return kwargs


def run_group(task: dict[str, Any]) -> dict[str, Any]:
    """Build one base ranking and run every light point on it. Runs inside a worker process."""
    from . import api
    from .categories import broad
    from .categories import circuit_exposure as cx
    from .categories.liquidity import LiquidityConfig

    space: Space = load_space(Path(task["space_path"]))
    heavy = {**{k: v for k, v in space.fixed.items() if k in HEAVY_KEYS}, **task["heavy"]}
    out_path = Path(task["out_dir"]) / f"results-{os.getpid()}.jsonl"
    universe_kind = ARMS[space.arm][0]
    t0 = time.time()

    lookbacks = tuple(heavy.get("lookbacks", (1, 4, 13, 26, 52)))
    weights = weights_for(heavy.get("weight_scheme"), len(lookbacks))
    liquidity = LiquidityConfig(
        min_turnover_cr=heavy.get("liq_min_turnover_cr", 1.0),
        floor_ratio=heavy.get("liq_floor_ratio", 0.25),
        min_price=heavy.get("liq_min_price", 20.0),
        circuit=heavy.get("liq_circuit", True),
        circuit_run=heavy.get("liq_circuit_run", 3),
        max_circuit_days=heavy.get("liq_max_circuit_days"),
    )
    outer = api.DATA.get()
    common = dict(
        outer_prices=outer,
        stocks_data_dir=api.DATA_DIR / "stocks",
        categories_data_dir=api.DATA_DIR / "categories",
    )
    base_kwargs = dict(
        lookbacks=lookbacks,
        weights=weights,
        score=heavy.get("score", "ranksum"),
        voladj_skip_recent_month=heavy.get("voladj_skip_recent_month", True),
        liquidity=liquidity,
        universe_kind=universe_kind,
    )
    for key in ("min_drop_pct", "turnover_spike_multiple"):
        if key in heavy:
            base_kwargs[key] = heavy[key]
    if "series_break_policy" in heavy:
        base_kwargs["series_breaks"] = heavy["series_break_policy"]
    base = broad.compute_universe_base(**common, **base_kwargs)

    locks: tuple[Any, Any] = (None, None)
    pools: dict[tuple[int, int], Any] = {}
    done = errors = 0
    with out_path.open("a", buffering=1) as sink:
        for run in task["runs"]:
            light = run["light"]
            merged = {**space.fixed, **light}
            pool = (merged.get("pool_top_n", 200), merged.get("pool_exit_rank", 250))
            started = time.time()
            row: dict[str, Any] = {
                "id": run["id"],
                "arm": space.arm,
                "heavy": heavy,
                "light": light,
                "data": task.get("snapshot"),
            }
            try:
                if pool not in pools:
                    if len(pools) >= 4:
                        pools.pop(next(iter(pools)))
                    pools[pool] = broad.finish_universe_ranking(
                        base, pool_top_n=pool[0], pool_exit_rank=pool[1]
                    )
                ranking = pools[pool]
                kwargs = _split_light(space, merged)
                if kwargs.pop("respect_circuits", False):
                    if locks[0] is None:
                        locks = cx.lock_masks(ranking.column_to_base_symbol, ranking.prices.index)
                    kwargs["uc_locked"], kwargs["lc_locked"] = locks
                outcome = broad.run_broad_backtest(
                    **common,
                    curated_dir=api.CATEGORIES_CURATED_DIR,
                    lookbacks=lookbacks,
                    weights=weights,
                    score=base_kwargs["score"],
                    voladj_skip_recent_month=base_kwargs["voladj_skip_recent_month"],
                    pool_top_n=pool[0],
                    pool_exit_rank=pool[1],
                    ranking=ranking,
                    **kwargs,
                )
                row["metrics"] = run_metrics(outcome.result, IDLE)
                done += 1
            except Exception as error:  # noqa: BLE001 - recorded, never fatal to the search
                row["error"] = f"{type(error).__name__}: {error}"[:300]
                errors += 1
            row["secs"] = round(time.time() - started, 2)
            sink.write(json.dumps(row, default=list) + "\n")
    return {"done": done, "errors": errors, "secs": round(time.time() - t0, 1)}


# --- driver ---------------------------------------------------------------------------------


def completed_ids(out_dir: Path) -> set[str]:
    ids: set[str] = set()
    for path in out_dir.glob("results-*.jsonl"):
        for line in path.read_text().splitlines():
            try:
                ids.add(json.loads(line)["id"])
            except (json.JSONDecodeError, KeyError):
                continue  # a torn last line from a killed run: just redo that run
    return ids


SNAPSHOT_FILE = "data_snapshot.json"


def _check_same_data(out_dir: Path, snapshot: dict | None) -> None:
    """A results folder holds one history. The first run records its data snapshot; a resume
    on different data stops here instead of adding a second copy of every config (their ids
    differ, so `load_results` would keep both)."""
    path = out_dir / SNAPSHOT_FILE
    if not path.exists():
        if snapshot is not None:
            path.write_text(json.dumps(snapshot, indent=1) + "\n")
        return
    recorded = json.loads(path.read_text())
    if snapshot is not None and recorded != snapshot:
        raise SystemExit(
            f"{out_dir} was searched on data {recorded}; the data is now {snapshot}. "
            "Start a new results folder (--out) rather than mixing two histories in one."
        )


def run_search(
    space_path: Path,
    out_dir: Path,
    *,
    heavy_count: int,
    light_count: int,
    seed: int,
    workers: int,
    limit_groups: int | None = None,
    echo=print,
) -> None:
    space = load_space(space_path)
    out_dir.mkdir(parents=True, exist_ok=True)
    seen = completed_ids(out_dir)
    snapshot = data_snapshot(through=space.fixed.get("end"))
    _check_same_data(out_dir, snapshot)
    tasks = []
    for group in plan(space, heavy_count, light_count, seed, snapshot)[:limit_groups]:
        runs = [r for r in group["runs"] if r["id"] not in seen]
        if runs:
            tasks.append(
                {
                    "space_path": str(Path(space_path).resolve()),
                    "out_dir": str(out_dir),
                    "heavy": group["heavy"],
                    "runs": runs,
                    "snapshot": snapshot,
                }
            )
    total = sum(len(t["runs"]) for t in tasks)
    echo(
        f"{space.name} (arm {space.arm}): {total} runs in {len(tasks)} groups to do, "
        f"{len(seen)} already done, {workers} worker(s)"
    )
    if not tasks:
        return
    started = time.time()
    finished = 0
    ctx = mp.get_context("spawn")  # a worker holds a ~1 GB ranking; keep each one independent
    with ctx.Pool(workers, maxtasksperchild=1) as pool:
        for summary in pool.imap_unordered(run_group, tasks):
            finished += 1
            echo(
                f"  group {finished}/{len(tasks)}: {summary['done']} ok, {summary['errors']} "
                f"errors, {summary['secs']} s   (elapsed {time.time() - started:.0f} s)"
            )


# --- reading results ------------------------------------------------------------------------


def load_results(out_dir: Path) -> pd.DataFrame:
    rows = []
    for path in sorted(out_dir.glob("results-*.jsonl")):
        for line in path.read_text().splitlines():
            try:
                rec = json.loads(line)
            except json.JSONDecodeError:
                continue
            flat = {
                "id": rec["id"],
                "arm": rec["arm"],
                "secs": rec.get("secs"),
                "error": rec.get("error"),
            }
            flat.update(
                {f"h_{k}": (str(v) if isinstance(v, list) else v) for k, v in rec["heavy"].items()}
            )
            flat.update({f"p_{k}": v for k, v in rec["light"].items()})
            flat.update(rec.get("metrics", {}))
            rows.append(flat)
    return pd.DataFrame(rows).drop_duplicates("id") if rows else pd.DataFrame()


PROFILES = {
    # name: (max drawdown as a multiple of the benchmark's, what to maximise)
    "aggressive": (None, "cagr"),
    "balanced": (1.5, "cagr"),
    "defensive": (1.0, "cagr"),
}


def profile_tables(
    df: pd.DataFrame,
    *,
    top: int = 10,
    max_turnover: float | None = None,
    min_buys_per_yr: float = 5.0,
) -> dict[str, pd.DataFrame]:
    """The best runs under each drawdown profile. Drawdown limits are multiples of the
    benchmark's own max drawdown in the same run window (e.g. 1.5 -> at most 1.5x as deep)."""
    ok = df[df["error"].isna() & df["cagr"].notna()] if "error" in df else df
    if max_turnover is not None:
        ok = ok[ok["turnover_x"] <= max_turnover]
    ok = ok[ok["buys_per_yr"] >= min_buys_per_yr]
    tables = {}
    for name, (multiple, key) in PROFILES.items():
        pick = ok if multiple is None else ok[ok["mdd"] >= multiple * ok["bench_mdd"]]
        tables[name] = pick.sort_values(key, ascending=False).head(top)
    return tables


def importance(df: pd.DataFrame, target: str = "cagr") -> pd.Series:
    """Rank correlation of each numeric searched parameter with `target` - a first, crude look
    at which parameters matter; Round 2 does this properly."""
    cols = [c for c in df.columns if c.startswith(("p_", "h_"))]
    numeric = df[cols].apply(pd.to_numeric, errors="coerce")
    numeric = numeric.loc[:, numeric.nunique() > 1]
    # Spearman = Pearson on ranks (pandas' own "spearman" needs scipy, which this package lacks).
    corr = numeric.rank().corrwith(df[target].rank())
    return corr.sort_values(key=abs, ascending=False)
