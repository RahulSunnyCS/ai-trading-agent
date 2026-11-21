"""BL-215 Phase 3: score the four policies on every fold's test window and apply the registered pass / kill rule.

Policies, Adaptive (list C, core picks, one lot a strategy, NIFTY only, Buy add-on left out, 0.5% slippage, net):
  (a) re-tune: Core-NIFTY + the settings selected on the fold's own tuning window (`selected.json`);
  (b) frozen: Core-NIFTY + the first fold's settings, kept for every later fold;
  (c) Core-NIFTY alone;
  (d) the fixed base (2 x N_wide_0917 + 1 x N_dir_atm_0924).
Picks are re-derived day by day from earlier rows only (`pick._rank`), with the SL150% cap on a day NIFTY does not
expire (the expiry-only rule is vacuous: no SENSEX variants, as BL-214). The two fold lengths are scored apart.

    TRADING_DATA_ROOT=/Volumes/TradingData/_bl215 uv run python research/bl215/score.py \
        --selected research/bl215/selected.json --json research/bl215/results/score.json
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from bisect import bisect_left
from datetime import date, timedelta
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from build_and_sim import ALL25, patch_loader, settings  # noqa: E402
from folds import ALL_FOLDS, END  # noqa: E402

from option_backtesting.rotation import (  # noqa: E402
    base,
    daylog,
    expiry,
    pick,
    sl150_cap,
    store,
    variants,
)
from option_backtesting.rotation.readout import block_bootstrap_mean, max_drawdown  # noqa: E402
from option_backtesting.rotation.variants import variant_names  # noqa: E402

ROOT = Path(os.environ["TRADING_DATA_ROOT"])
SEED, RESAMPLES, BLOCK = 20261106, 2000, 5
GEN = HERE / "results" / "generated" / "rotation_t1"
SLIP = 0.5


def picks_for(names: list[str], start: date, end: date) -> dict[date, list[str]]:
    daylog._recon_cache.clear()  # noqa: SLF001
    rec = daylog.reconstruction(ROOT, names)
    assert rec.error is None, rec.error
    out = {}
    for d in rec.days_available():
        if d < start or d > end:
            continue
        a = rec.attrs[d]
        dte_s = "unknown"
        i = bisect_left(rec.days, d)
        hist = pick.History(rec.days[:i], rec.cols, rec.values[:i], rec.weekday[:i], rec.band[:i],
                            rec.dte_n[:i], rec.dte_s[:i], "")  # fmt: skip
        vix = daylog._number(a.get("vix_open"))  # noqa: SLF001
        for key, cols, comp, picks in pick._rank(
            hist, d, vix, {"dte_n": a["dte_n"], "dte_s": dte_s}
        ):  # noqa: SLF001
            if key != "C":
                continue
            idx = expiry.expiring_index(a["dte_n"], dte_s)
            if idx:
                picks = expiry.filter_picks(comp, cols, picks, idx)
            elif expiry._known(str(a["dte_n"])) and str(a["dte_n"]) != "0":  # noqa: SLF001
                picks = sl150_cap.cap_picks(comp, cols, picks)
            out[d] = list(picks.core)
    return out


def names_for(sett: dict[str, dict], sigs: set[str]) -> list[str]:
    out = []
    for s in sigs:
        v = sett[s]
        for slot in ALL25:
            n = f"{v['index']}_{v['base']}-t1s{v['id']}_{slot.replace(':', '')}"
            if (GEN / f"{n}.yaml").exists():
                out.append(n)
    return sorted(out)


_cache: dict[tuple[str, float], dict[date, float]] = {}


def net(name: str, slip: float) -> dict[date, float]:
    k = (name, slip)
    if k not in _cache:
        with store.slipped(slip):
            _cache[k] = store.read_net(name, ROOT)
    return _cache[k]


def gross(name: str) -> dict[date, float]:
    k = (name, -1.0)
    if k not in _cache:
        _cache[k] = base.read_column(store.result_path(name, ROOT), "gross")
    return _cache[k]


def book(picks: dict[date, list[str]], days: list[date], fn) -> np.ndarray:
    return np.array([sum(fn(x)[d] for x in picks[d]) / 3.0 for d in days])


def boot(x: np.ndarray) -> dict:
    if len(x) < 10:
        return {
            "mean": float(x.mean()) if len(x) else None,
            "lo90": None,
            "hi90": None,
            "days": int(len(x)),
        }
    m, lo, hi = block_bootstrap_mean(x, RESAMPLES, BLOCK, SEED)
    return {"mean": float(m), "lo90": float(lo), "hi90": float(hi), "days": int(len(x))}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--selected", type=Path, required=True)
    ap.add_argument("--json", type=Path, required=True)
    a = ap.parse_args()
    variants.TRACK_DIRS["t1"] = GEN
    patch_loader()
    selected = json.loads(a.selected.read_text())
    sett = settings(selected)
    core_n = [n for n in variant_names() if n.startswith("N_")]
    last = END - timedelta(days=1)
    first_test = min(date.fromisoformat(v["test"][0]) for v in selected.values())
    # Adaptive needs ~63 earlier sessions of every variant in the root (the root holds them from 2021-11-01)
    pk_core = picks_for(core_n, first_test, last)
    got = base.score_days(
        sorted(pk_core), ROOT, log=lambda _m: None
    )  # the base's Dir leg, any day not stored
    dir_net = base.read_column(store.slip_path(base._path(ROOT), SLIP), "net")  # noqa: SLF001
    report: dict = {"base_skipped": len(got["skipped"]), "lengths": {}}
    for length, all_folds in ALL_FOLDS.items():
        folds = [f for f in all_folds if f"{length}:{f[0]}" in selected]
        if not folds:
            continue
        first_key = f"{length}:{folds[0][0]}"
        frozen_sigs = {
            x
            for x in sett
            if any(
                w
                for w in selected[first_key]["settings"]
                if x
                == __import__("json").dumps(
                    [w["fam"], w["index"], w["params"]], sort_keys=True, default=list
                )
            )
        }
        pk_frozen = picks_for(core_n + names_for(sett, frozen_sigs), first_test, last)
        rows, pooled = [], {k: [] for k in ("a", "b", "c", "d", "a_g", "c_g")}
        prev = set()
        for name, tstart, tend in ((f[0], f[4], f[5]) for f in folds):
            key = f"{length}:{name}"
            sigs = {
                json.dumps([w["fam"], w["index"], w["params"]], sort_keys=True, default=list)
                for w in selected[key]["settings"]
            }
            pk_a = picks_for(core_n + names_for(sett, sigs), tstart, tend - timedelta(days=1))
            days = sorted(
                d
                for d in pk_a
                if tstart <= d < tend
                and d in pk_core
                and d in pk_frozen
                and d in dir_net
                and d in net("N_wide_0917", SLIP)
            )
            if not days:
                continue
            ok = [
                d
                for d in days
                if all(
                    d in net(x, SLIP) and d in gross(x)
                    for p in (pk_a, pk_core, pk_frozen)
                    for x in p[d]
                )
            ]
            s_ = {
                "a": book(pk_a, ok, lambda x: net(x, SLIP)),
                "b": book(pk_frozen, ok, lambda x: net(x, SLIP)),
                "c": book(pk_core, ok, lambda x: net(x, SLIP)),
                "d": np.array([(2 * net("N_wide_0917", SLIP)[d] + dir_net[d]) / 3.0 for d in ok]),
                "a_g": book(pk_a, ok, gross),
                "c_g": book(pk_core, ok, gross),
            }
            for k, v in s_.items():
                pooled[k].append(v)
            rec = {
                "fold": name,
                "test": [str(tstart), str(tend - timedelta(days=1))],
                "days": len(ok),
                "settings": len(sigs),
                "kept_from_previous": (len(sigs & prev) / len(prev)) if prev else None,
            }
            prev = sigs
            for k in ("a", "b", "c", "d", "a_g", "c_g"):
                rec[k] = float(s_[k].mean())
            rec["a_minus_c"] = float((s_["a"] - s_["c"]).mean())
            rec["a_minus_c_gross"] = float((s_["a_g"] - s_["c_g"]).mean())
            rec["a_minus_b"] = float((s_["a"] - s_["b"]).mean())
            rec["a_minus_d"] = float((s_["a"] - s_["d"]).mean())
            rec["maxdd_a"] = float(max_drawdown(s_["a"] * 3.0))
            rec["maxdd_c"] = float(max_drawdown(s_["c"] * 3.0))
            rows.append(rec)
            print(
                f"{key}: {len(ok)}d  a {rec['a']:.0f}  c {rec['c']:.0f}  a-c {rec['a_minus_c']:+.0f}  "
                f"(gross {rec['a_minus_c_gross']:+.0f})  b {rec['b']:.0f}  d {rec['d']:.0f}",
                flush=True,
            )
        cat = {k: np.concatenate(v) for k, v in pooled.items()}
        wins = sum(r["a_minus_c"] > 0 for r in rows)
        pooled_gap = boot(cat["a"] - cat["c"])
        n0 = rows[0]["days"]
        ab = boot(cat["a"][n0:] - cat["b"][n0:])
        verdict = (
            "kill"
            if pooled_gap["mean"] is not None and pooled_gap["mean"] <= 0
            else "pass"
            if pooled_gap["lo90"] is not None
            and pooled_gap["lo90"] > 0
            and wins >= 0.75 * len(rows)
            else "no evidence either way"
        )
        report["lengths"][length] = {
            "folds": rows,
            "pooled_a_minus_c": pooled_gap,
            "pooled_a_minus_c_gross": boot(cat["a_g"] - cat["c_g"]),
            "pooled_a_minus_d": boot(cat["a"] - cat["d"]),
            "pooled_c_minus_d": boot(cat["c"] - cat["d"]),
            "a_minus_b_after_first_fold": ab,
            "folds_won": f"{wins}/{len(rows)}",
            "verdict": verdict,
            "pooled_means": {k: float(v.mean()) for k, v in cat.items()},
            "pooled_maxdd_a": float(max_drawdown(cat["a"] * 3.0)),
            "pooled_maxdd_c": float(max_drawdown(cat["c"] * 3.0)),
        }
        print(
            f"\n{length}: pooled a-c {pooled_gap['mean']:+.0f} 90% [{pooled_gap['lo90']}, {pooled_gap['hi90']}] "
            f"folds won {wins}/{len(rows)} -> {verdict};  a-b (after first fold) {ab['mean'] if ab['mean'] is None else round(ab['mean'])}\n",
            flush=True,
        )
    a.json.parent.mkdir(parents=True, exist_ok=True)
    a.json.write_text(json.dumps(report, indent=1, default=float))


if __name__ == "__main__":
    main()
