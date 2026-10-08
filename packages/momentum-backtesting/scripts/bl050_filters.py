"""BL-050 phases 1-3 on the frozen ensemble (search_spaces/bl050_criteria.json).

    uv run python scripts/bl050_filters.py features   # weekly feature tables -> parquet
    uv run python scripts/bl050_filters.py screen     # Phase 2: per-feature spread t-stats
    uv run python scripts/bl050_filters.py engine     # Phase 3: 11 trials + baseline, dev window
    uv run python scripts/bl050_filters.py holdout    # Phase 3: the one sealed-window read
    uv run python scripts/bl050_filters.py report     # verdicts -> bl050_*_result.json

Outputs under data/search/round7_A/bl050/. The rules are read from the criteria file; the
dev/hold-out dates are taken from it, never restated."""

from __future__ import annotations

import json
import math
import sys
import time
from pathlib import Path

import numpy as np
import pandas as pd

PKG = Path(__file__).resolve().parent.parent
SPACE = PKG / "search_spaces" / "round7_A.toml"
CRITERIA = json.loads((PKG / "search_spaces" / "bl050_criteria.json").read_text())
FROZEN = json.loads((PKG / "search_spaces" / "bl010_phase6_frozen.json").read_text())
OUT = PKG / "data" / "search" / "round7_A" / "bl050"
DEV = CRITERIA["windows"]["development"]
HOLD = CRITERIA["windows"]["holdout"]
TILTS = ("V1", "V2", "M2", "T1")
GATES = ("V3", "R1", "M1")
ROUND_TRIP = 0.003


def runner():
    from momentum_backtesting import bias, search

    space = search.load_space(SPACE)
    return bias.Runner(space, universe_kind="turnover_rank", category_tags="curated")


def sleeves() -> list[dict]:
    return FROZEN["configs"]


# --- Phase 1: features ------------------------------------------------------------------------


def features() -> None:
    from momentum_backtesting import filters
    from momentum_backtesting import reference_benchmarks as rb

    OUT.mkdir(parents=True, exist_ok=True)
    r = runner()
    base = r.base(sleeves()[0]["heavy"])
    stock_cols = list(base.universe.frame.columns)
    prices = base.full_frame[stock_cols]
    weeks = prices.index
    universe = base.global_ranks.reindex(columns=stock_cols).notna()
    n500 = rb.load_references()[rb.NIFTY500_TRI]
    n500.index = pd.to_datetime(n500.index)
    started = time.time()
    daily = filters.daily_turnover(
        {c: c.split("#", 1)[0] for c in stock_cols}, str(weeks[0].date()), str(weeks[-1].date())
    )
    weekly = filters.weekly_turnover(daily, weeks)
    tables = {
        "V1": filters.v1_turnover_expansion(daily, weeks),
        "V2": filters.v2_accumulation(weekly, prices),
        "V3": filters.v3_quiet_or_building_blocked(weekly),
        "R1": filters.r1_relative_strength_blocked(prices, n500),
        "M1": filters.m1_overextended_blocked(prices, universe),
        "M2": filters.m2_residual_sum(prices, n500),
        "T1": filters.t1_trend_quality(prices),
    }
    for name, table in tables.items():
        table.astype("float64").to_parquet(OUT / f"feature-{name}.parquet")
        kind = "blocked share" if name in GATES else "non-null share"
        share = table.astype(float).mean().mean() if name in GATES else table.notna().mean().mean()
        print(f"{name}: {table.shape}, {kind} {share:.3f}", flush=True)
    print(f"features done in {time.time() - started:.0f} s")


def load_feature(name: str) -> pd.DataFrame:
    frame = pd.read_parquet(OUT / f"feature-{name}.parquet")
    frame.index = pd.to_datetime(frame.index)
    return frame.astype(bool) if name in GATES else frame


# --- Phase 2: the cheap screen ------------------------------------------------------------------


def newey_west_t(values: np.ndarray, lag: int) -> float:
    x = values - values.mean()
    n = len(x)
    if n < 10:
        return math.nan
    var = (x @ x) / n
    for k in range(1, lag + 1):
        weight = 1 - k / (lag + 1)
        var += 2 * weight * (x[k:] @ x[:-k]) / n
    return float(values.mean() / math.sqrt(var / n)) if var > 0 else math.nan


def screen() -> dict:
    from momentum_backtesting.engine import cadence_weeks

    r = runner()
    feats = {n: load_feature(n) for n in (*TILTS, *GATES)}
    end = pd.Timestamp(DEV["end"])
    rows = []
    for cfg in sleeves():
        base = r.base(cfg["heavy"])
        stock_cols = list(base.universe.frame.columns)
        prices = base.full_frame[stock_cols]
        ranks = base.global_ranks.reindex(columns=stock_cols)
        fwd = prices.shift(-13) / prices - 1 - ROUND_TRIP
        weeks = [w for w in prices.index if pd.Timestamp(DEV["start"]) <= w]
        # never read past the development end: the 13-week outcome must close by then
        weeks = [
            w
            for i, w in enumerate(prices.index)
            if w in set(weeks) and i + 13 < len(prices.index) and prices.index[i + 13] <= end
        ]
        every = int(cfg["rebalance_every"])
        dates = sorted(cadence_weeks(weeks, every, int(cfg["rebalance_offset"])))
        lag = math.ceil(13 / every)
        for name, feat in feats.items():
            spreads = []
            for w in dates:
                rk = ranks.loc[w].dropna()
                if rk.empty:
                    continue
                top = rk[rk <= max(1, int(0.2 * len(rk)))].index
                out = fwd.loc[w, top]
                f = feat.loc[w].reindex(top) if w in feat.index else pd.Series(dtype=float)
                if name in GATES:
                    blocked = f.fillna(False).astype(bool)
                    good, bad = out[~blocked].dropna(), out[blocked].dropna()
                else:
                    f = f.dropna()
                    if len(f) < 4:
                        continue
                    med = f.median()
                    good, bad = out[f[f > med].index].dropna(), out[f[f <= med].index].dropna()
                if len(good) >= 2 and len(bad) >= 2:
                    spreads.append(good.mean() - bad.mean())
            arr = np.asarray(spreads, dtype=float)
            rows.append(
                {
                    "feature": name,
                    "config": cfg["id"],
                    "dates": len(arr),
                    "mean_spread": float(arr.mean()) if len(arr) else math.nan,
                    "t": newey_west_t(arr, lag),
                }
            )
            print(rows[-1], flush=True)
    table = pd.DataFrame(rows)
    rule = CRITERIA["phase_2_screen"]
    verdict = {}
    for name, part in table.groupby("feature"):
        mean_t = float(part.t.mean())
        right_sign = int((part.t > 0).sum())
        verdict[name] = {
            "per_config_t": dict(zip(part.config, part.t.round(3), strict=True)),
            "mean_t": mean_t,
            "right_sign": right_sign,
            "passes": bool(mean_t >= 2 and right_sign >= 3),
        }
    result = {"rule": rule["pass"], "features": verdict}
    (PKG / "search_spaces" / "bl050_screen_result.json").write_text(json.dumps(result, indent=1))
    table.to_csv(OUT / "screen.csv", index=False)
    print(
        json.dumps(
            {k: (round(v["mean_t"], 2), v["right_sign"], v["passes"]) for k, v in verdict.items()}
        )
    )
    return result


# --- Phase 3: the engine test -------------------------------------------------------------------


def trials() -> list[tuple[str, str | None, float | None]]:
    out = [("baseline", None, None)]
    for name in TILTS:
        for weight in CRITERIA["tilt"]["weights"]:
            out.append((f"{name}@{weight}", name, weight))
    out += [(name, name, None) for name in GATES]
    return out


def run_trials(start: str, end: str, dest: Path, only: list[str] | None = None) -> None:
    from momentum_backtesting import choose

    dest.mkdir(parents=True, exist_ok=True)
    r = runner()
    feats = {n: load_feature(n) for n in (*TILTS, *GATES)}
    bases = {}
    for label, name, weight in trials():
        if only is not None and label not in only:
            continue
        path = dest / f"curve-{label}.parquet"
        if path.exists():
            continue
        started = time.time()
        curves, holdings, idle = {}, [], []
        for cfg in sleeves():
            key = json.dumps(cfg["heavy"], sort_keys=True)
            if key not in bases:
                bases[key] = r.base(cfg["heavy"])
            light = {k: v for k, v in cfg["light"].items() if k != "rebalance_offset"}
            extra = {}
            if name in GATES:
                extra["extra_no_buy"] = feats[name]
            elif name is not None:
                light = {**light, "feature_tilt": (feats[name], weight)}
            outcome, _ = r.run(
                bases[key],
                cfg["heavy"],
                light,
                rebalance_offset=int(cfg["rebalance_offset"]),
                start=start,
                end=end,
                **extra,
            )
            res = outcome.result
            curves[cfg["id"]] = res.equity
            holdings.append(float(res.holdings["count"].mean()))
            idle.append(float(res.holdings["idle_share"].mean()))
        frame = pd.DataFrame(curves)
        ensemble = choose.ensemble_curve(frame, list(frame.columns))
        out = frame.assign(ensemble=ensemble)
        out.to_parquet(path)
        meta = {"avg_holdings": float(np.mean(holdings)), "avg_idle_share": float(np.mean(idle))}
        (dest / f"meta-{label}.json").write_text(json.dumps(meta))
        print(f"{label}: {time.time() - started:.0f} s, {meta}", flush=True)


def engine() -> None:
    run_trials(DEV["start"], DEV["end"], OUT / "dev")


def holdout(survivors: list[str]) -> None:
    # one continuous run from the development start; only the 2024.. slice is read
    run_trials(DEV["start"], HOLD["end"], OUT / "holdout", only=["baseline", *survivors])


# --- verdicts -----------------------------------------------------------------------------------


def _load(dest: Path, label: str) -> pd.Series:
    frame = pd.read_parquet(dest / f"curve-{label}.parquet")
    frame.index = pd.to_datetime(frame.index)
    return frame["ensemble"].dropna()


def rolling(curve: pd.Series, base: pd.Series) -> tuple[float, float]:
    """Median dCAGR and CAGR win share over 3-year windows stepped quarterly (13 weeks)."""
    from momentum_backtesting import choose

    idx = curve.index.intersection(base.index)
    curve, base = curve[idx], base[idx]
    diffs = []
    for i in range(0, len(idx) - 156, 13):
        a, b = curve.iloc[i : i + 157], base.iloc[i : i + 157]
        diffs.append(choose.cagr(a) - choose.cagr(b))
    arr = np.asarray(diffs)
    return float(np.median(arr)), float((arr > 0).mean())


def report() -> None:
    from momentum_backtesting import choose, method

    screen_result = json.loads((PKG / "search_spaces" / "bl050_screen_result.json").read_text())
    passed = {k for k, v in screen_result["features"].items() if v["passes"]}
    dev = OUT / "dev"
    curves = {label: _load(dev, label) for label, *_ in trials()}
    frame = pd.DataFrame(curves).dropna()
    logret = np.log(frame / frame.shift(1)).dropna().to_numpy()
    pbo = method.pbo(logret, blocks=16)
    base = curves["baseline"]

    def mdd(s: pd.Series) -> float:
        return float((s / s.cummax() - 1).min())

    rows = {}
    survivors = []
    for label, name, _w in trials():
        if label == "baseline":
            continue
        med, win = rolling(curves[label], base)
        meta = json.loads((dev / f"meta-{label}.json").read_text())
        row = {
            "screen_pass": name in passed,
            "cagr": float(choose.cagr(curves[label])),
            "baseline_cagr": float(choose.cagr(base)),
            "median_rolling_dcagr": med,
            "rolling_win_share": win,
            "mdd": mdd(curves[label]),
            "baseline_mdd": mdd(base),
            **meta,
        }
        row["passes"] = bool(
            row["screen_pass"]
            and med >= 0.02
            and win >= 0.70
            and row["mdd"] >= row["baseline_mdd"] - 0.03
            and pbo["pbo"] < 0.5
        )
        rows[label] = row
        if row["passes"]:
            survivors.append(label)
    base_meta = json.loads((dev / "meta-baseline.json").read_text())
    dev_result = {
        "pbo": pbo,
        "baseline": {"cagr": float(choose.cagr(base)), "mdd": mdd(base), **base_meta},
        "trials": rows,
        "survivors": survivors,
    }
    (PKG / "search_spaces" / "bl050_dev_result.json").write_text(json.dumps(dev_result, indent=1))
    print(json.dumps({"pbo": round(pbo["pbo"], 3), "survivors": survivors}))
    print(pd.DataFrame(rows).T.round(4).to_string())
    if survivors:
        holdout(survivors)
        hold = OUT / "holdout"
        start = pd.Timestamp(HOLD["start"]) - pd.Timedelta(days=7)
        b = _load(hold, "baseline")
        b = b[b.index >= start]
        out = {}
        for label in survivors:
            c = _load(hold, label)
            c = c[c.index >= start]
            out[label] = {
                "cagr": float(choose.cagr(c)),
                "baseline_cagr": float(choose.cagr(b)),
                "mdd": mdd(c),
                "baseline_mdd": mdd(b),
            }
            out[label]["passes"] = bool(
                out[label]["cagr"] >= out[label]["baseline_cagr"]
                and out[label]["mdd"] >= out[label]["baseline_mdd"] - 0.03
            )
        (PKG / "search_spaces" / "bl050_holdout_result.json").write_text(json.dumps(out, indent=1))
        print("HOLDOUT", json.dumps(out))
    else:
        print("no survivors: the sealed 2024-26 window stays unread")


if __name__ == "__main__":
    {"features": features, "screen": screen, "engine": engine, "report": report}[sys.argv[1]]()
