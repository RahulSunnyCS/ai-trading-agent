"""BL-232: family-band 15% on stop-loss families vs list C, over the T1 pool.

    uv run python research/bl232/run.py check            # parity of V0 with pick.py + family counts (no results read)
    uv run python research/bl232/run.py F                # fit window
    uv run python research/bl232/run.py K                # confirmation window, once (refuses a second read)

Registered in backlog/BL-232-family-band-by-stoploss.md (committed before this ran). Arms: V0 = list C as
it is; V1 = 15% on SL3 (the one adoptable arm); V2 = 15% on type x band; V3 = 5% on SL3; V4 = 15% on
SL3 x band. Picks are one lot each; P&L is the stored net one-lot result.
"""

from __future__ import annotations

import json
import math
import os
import sys
from dataclasses import replace
from datetime import date
from pathlib import Path

import numpy as np
import yaml

from option_backtesting.rotation import pick as pick_mod
from option_backtesting.rotation import store
from option_backtesting.rotation import variants as V
from option_backtesting.rotation.lists import LISTS, LOOKBACKS_NEW, WARMUP, RotationList
from option_backtesting.rotation.pick import History, score_history
from option_backtesting.rotation.score import (
    composite,
    dte_matrix,
    family_index,
    select,
    vix_band,
)
from option_backtesting.rotation.variants import track_names, variant_names

HERE = Path(__file__).parent
ROOT = Path(os.environ.get("TRADING_DATA_ROOT", "/Volumes/TradingData"))
WINDOWS = {
    "F": (date(2025, 1, 10), date(2025, 10, 8)),
    "K": (date(2025, 10, 9), date(2026, 11, 16)),
}
FORWARD_FROM = date(2026, 10, 19)
CAP_FROM = date(2026, 10, 30)  # BL-192: score_history applies the SL150 cap from here
SEED = 20261116
DRAWS = 2000
BLOCK = 5

BASE_C = LISTS["C"].weights  # recent .15 weekday .30 dte .30 vix .20 rfam .05


def arm_list(rfam: float) -> RotationList:
    other = 1.0 - rfam
    k = other / (1.0 - BASE_C["rfam"])
    w = {c: BASE_C[c] * k for c in ("recent", "weekday", "dte", "vix")}
    w["rfam"] = rfam
    assert abs(sum(w.values()) - 1.0) < 1e-9
    return replace(LISTS["C"], name=f"rfam{rfam:g}", weights=w, lookbacks=LOOKBACKS_NEW)


def leg_sl(name: str) -> float:
    track = V.track_of(name)
    path = (V.TRACK_DIRS[track] if track else V.STRATEGIES_DIR) / f"{name}.yaml"
    legs = yaml.safe_load(path.read_text())["strategy"]["legs"]
    sls = [(leg.get("stop_loss") or {}).get("percent") for leg in legs]
    assert all(s is not None for s in sls), f"{name}: a leg without a stop-loss percent"
    return max(float(s) for s in sls)


def sl3_labels(names: list[str]) -> list[str]:
    out = []
    for n in names:
        if V.is_buy(n):
            out.append("buy")
        elif V.is_dir(n):
            out.append("dir")
        elif V.is_wide(n):
            out.append("wide_le100" if leg_sl(n) <= 100 else "wide_gt100")
        else:
            raise AssertionError(f"{n}: neither Buy, Dir nor Widesl")
    return out


def band_of(tag: str) -> str:
    m = int(tag[:2]) * 60 + int(tag[2:])
    return "A" if m <= 602 else "B" if m <= 722 else "C" if m <= 842 else "D"


def codes(keys: list[str]) -> np.ndarray:
    return np.unique(keys, return_inverse=True)[1]


def family_keys(names: list[str], sl3: list[str]) -> dict[str, np.ndarray]:
    bands = [band_of(V.parts(n)[2]) for n in names]
    return {
        "typeband": family_index(names),  # production key
        "sl3": codes(sl3),
        "sl3band": codes([f"{a}_{b}" for a, b in zip(sl3, bands, strict=True)]),
    }


ARMS = {
    "V0": (0.05, "typeband"),
    "V1": (0.15, "sl3"),
    "V2": (0.15, "typeband"),
    "V3": (0.05, "sl3"),
    "V4": (0.15, "sl3band"),
}


def picks_by_arm(m, attrs, names, sl3, days_filter):
    # production ranks on the unslipped stored results (pick.load_history: store.slipped(0.0)),
    # so the matrix handed in here must have been read at 0 % slippage
    assert store.reading_slip() == 0.0, "ranking must read the unslipped results"
    keys = family_keys(names, sl3)
    lists = {a: arm_list(r) for a, (r, _) in ARMS.items()}
    days = m.days
    out = {a: {} for a in ARMS}
    parity = {"days": 0, "bad": []}
    for i, d in enumerate(days):
        if i < WARMUP or not days_filter(d):
            continue
        hist_days = days[:i]
        weekday = np.array([attrs[x]["weekday"] for x in hist_days] + [d.strftime("%a")])
        a = attrs[d]
        vix = float(a["vix_open"]) if a.get("vix_open") not in (None, "") else None
        band = np.array([attrs[x]["vix_band"] for x in hist_days] + [vix_band(vix)])
        dn = np.array([attrs[x]["dte_n"] for x in hist_days] + [a["dte_n"]])
        ds = np.array([attrs[x]["dte_s"] for x in hist_days] + [a["dte_s"]])
        dmat = dte_matrix(dn, ds, names)
        P = np.vstack([m.values[:i], np.zeros((1, len(names)))])
        for arm, (_, key) in ARMS.items():
            comp = composite(P, weekday, band, dmat, names, lists[arm], keys[key])
            p = select(comp, names)
            out[arm][d] = list(p.core) + list(p.buy)
        # parity of V0 with production list C (ranking only; the BL-192 cap only after CAP_FROM)
        hist = History(
            hist_days,
            list(names),
            m.values[:i],
            [attrs[x]["weekday"] for x in hist_days],
            [attrs[x]["vix_band"] for x in hist_days],
            [attrs[x]["dte_n"] for x in hist_days],
            [attrs[x]["dte_s"] for x in hist_days],
            "",
        )
        prod = {
            k: (c, pk)
            for k, c, _, pk in pick_mod._rank(
                hist, d, vix, {"dte_n": a["dte_n"], "dte_s": a["dte_s"]}
            )
        }
        c_core = list(prod["C"][1].core) + list(prod["C"][1].buy)
        ok = c_core == out["V0"][d]
        if d < CAP_FROM:
            sh = score_history(hist, d, vix, {"dte_n": a["dte_n"], "dte_s": a["dte_s"]})["C"]
            ok = ok and (list(sh["core"]) + list(sh.get("buy") or []) == out["V0"][d])
        parity["days"] += 1
        if not ok:
            parity["bad"].append(d.isoformat())
    return out, parity


def daily_pnl(m, picks):
    idx = {n: j for j, n in enumerate(m.names)}
    pos = {d: i for i, d in enumerate(m.days)}
    days = sorted(picks)
    return days, np.array([sum(m.values[pos[d], idx[n]] for n in picks[d]) for d in days])


def max_drawdown(x: np.ndarray) -> float:
    c = np.cumsum(x)
    peak = np.maximum.accumulate(np.concatenate([[0.0], c]))[1:]
    return float((peak - c).max()) if len(c) else 0.0


def block_boot(diff: np.ndarray):
    rng = np.random.default_rng(SEED)
    n = len(diff)
    nb = math.ceil(n / BLOCK)
    means = np.empty(DRAWS)
    for k in range(DRAWS):
        starts = rng.integers(0, n, nb)
        idx = ((starts[:, None] + np.arange(BLOCK)[None, :]) % n).ravel()[:n]
        means[k] = diff[idx].mean()
    return float(np.percentile(means, 5)), float(np.percentile(means, 95))


def summarise(m, arms_picks, lo, hi):
    res = {}
    series = {}
    for a, picks in arms_picks.items():
        sel = {d: p for d, p in picks.items() if lo <= d <= hi}
        days, x = daily_pnl(m, sel)
        series[a] = (days, x)
        res[a] = {
            "days": len(days),
            "mean": float(x.mean()),
            "total": float(x.sum()),
            "max_dd": max_drawdown(x),
        }
    base = series["V0"][1]
    for a in ARMS:
        if a == "V0":
            continue
        d = series[a][1] - base
        lo_ci, hi_ci = block_boot(d)
        res[a].update(
            diff_mean=float(d.mean()), ci90=[lo_ci, hi_ci], share_days_ahead=float((d > 0).mean())
        )
    return res, series


def main(stage: str) -> None:
    names = variant_names() + track_names("t1")
    attrs = store.read_days(ROOT, "weekdays")
    sl3 = sl3_labels(names)  # from the strategy files only; computed before any result is read
    counts = {k: int(sum(1 for x in sl3 if x == k)) for k in sorted(set(sl3))}
    print("SL3 family sizes:", counts)
    assert counts.get("wide_le100") == 75, counts  # registered: 60/40 stop-loss variants only
    if stage == "check":
        with store.slipped(0.0):
            m = store.load_matrix(names, ROOT)
        assert sl3 == sl3_labels(names), "a family label changed once results were read"

        def spot(d: date) -> bool:  # a span before the BL-192 cap and one after it
            return date(2025, 1, 10) <= d <= date(2025, 3, 31) or date(2026, 10, 26) <= d <= date(
                2026, 11, 16
            )

        picks, parity = picks_by_arm(m, attrs, names, sl3, spot)
        print("parity (V0 vs production list C):", parity["days"], "days, bad:", parity["bad"][:5])
        sys.exit(1 if parity["bad"] else 0)

    lo, hi = WINDOWS[stage]
    out_json = HERE / f"result_{stage}_{date.today().isoformat()}.json"
    if stage == "K":
        assert list(HERE.glob("result_F_*.json")), "read F first (registered order)"
        if list(HERE.glob("result_K_*.json")) and "--override" not in sys.argv:
            sys.exit("K was read already: the registration reads it once")
    results = {}
    # Rank once on the unslipped results, as production does (pick.load_history reads under
    # store.slipped(0.0)); the parity assert inside picks_by_arm compares V0 with pick._rank on that
    # same history. The picks are then scored on each slippage copy (as research/bl216/range_fit.py).
    with store.slipped(0.0):
        m0 = store.load_matrix(names, ROOT)
        picks, parity = picks_by_arm(m0, attrs, names, sl3, lambda d: lo <= d <= hi)
    assert not parity["bad"], f"parity failed on {parity['bad'][:5]}"
    assert sl3 == sl3_labels(names), "a family label changed once results were read"
    for slip in (0.0, 0.5):
        if slip == 0.0:
            m = m0
        else:
            with store.slipped(slip):
                m = store.load_matrix(names, ROOT)
            assert m.days == m0.days and list(m.names) == list(m0.names), "slippage copy differs"
        res, _ = summarise(m, picks, lo, hi)
        results[f"slip{slip:g}"] = {"summary": res, "parity_days": parity["days"]}
        if stage == "K":
            fwd, _ = summarise(
                m,
                {a: {d: p for d, p in pk.items() if d >= FORWARD_FROM} for a, pk in picks.items()},
                FORWARD_FROM,
                hi,
            )
            results[f"slip{slip:g}"]["forward_descriptive"] = fwd
    out_json.write_text(
        json.dumps(
            {
                "window": [lo.isoformat(), hi.isoformat()],
                "ranking": "unslipped stored results (production rule); picks scored per slippage copy",
                "results": results,
            },
            indent=1,
        )
        + "\n"
    )
    r = results["slip0"]["summary"]
    print(f"\n== window {stage} {lo}..{hi}, {r['V0']['days']} days, stored 0% slippage ==")
    for a in ARMS:
        v = r[a]
        extra = (
            ""
            if a == "V0"
            else f"  diff {v['diff_mean']:+.0f} [{v['ci90'][0]:+.0f}, {v['ci90'][1]:+.0f}] ahead {v['share_days_ahead']:.0%}"
        )
        print(
            f"{a}: mean {v['mean']:+.0f}/lot-day  total {v['total']:+.0f}  maxDD {v['max_dd']:.0f}{extra}"
        )
    print(f"wrote {out_json}")


if __name__ == "__main__":
    main(sys.argv[1])
