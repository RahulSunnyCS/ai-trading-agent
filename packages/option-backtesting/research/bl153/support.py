"""BL-153: are BL-152 breakout trades better when Bank Nifty, Nifty IT and Reliance support them?

Registered in backlog/BL-153 Phase 0 (criteria.json), before any BL-152 result was read. For each
judged variant (the four reference variants plus BL-152's advancing ones), every learning-period
trade is marked supported when at least 2 of the 3 instruments close beyond their own level of the
same type at the NIFTY decision minute (the minute before entry); D = mean net supported - mean net
unsupported, tested against 10,000 shuffles of the supported labels, Holm-corrected across the tests.
A variant whose filter passes is tested once on the confirmation period: an existing confirmation
test of that spec is reused, otherwise the period is revealed and run once.

    uv run python research/bl153/support.py
"""

from __future__ import annotations

import json
import os
import sys
from datetime import date
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "bl152"))
from specs import grid, levels  # noqa: E402

from option_backtesting.rotation import triggers as T  # noqa: E402
from option_backtesting.ruletest import expr as E  # noqa: E402

CRITERIA = json.loads((HERE / "criteria.json").read_text())
RULE = CRITERIA["pass_rule"]
BL152_OUT = HERE.parent / "bl152" / "out"
OUT = HERE / "out"
INSTRUMENTS = (("BANKNIFTY", "index"), ("NIFTYIT", "index"), ("RELIANCE", "stock"))


def load_frame(root: Path, symbol: str, asset: str, until: date) -> E.Frame:
    from trading_data import lake

    end = max(d for d in lake.available_days(root, asset, symbol) if d <= until)
    grid_ = T.load_grid(root, symbol, end, sessions=3000, asset=asset)
    if grid_ is None:
        raise SystemExit(f"{symbol}: no bars up to {until}")
    return E.Frame(days=grid_.days, O=grid_.O, H=grid_.H, L=grid_.L, C=grid_.C)


def beyond(frame: E.Frame, level: str) -> tuple[np.ndarray, np.ndarray]:
    """(close beyond its own up level, close beyond its own down level) on every stamp."""
    spec = levels()[level]
    defs = {"lvl_up": E.parse(spec["up"]), "lvl_dn": E.parse(spec["dn"])}
    close = frame.C
    up = close > E.evaluate(defs["lvl_up"], frame)
    dn = close < E.evaluate(defs["lvl_dn"], frame)
    if "extra_up" in spec:
        up &= E.evaluate(E.parse(spec["extra_up"], defs), frame)
        dn &= E.evaluate(E.parse(spec["extra_dn"], defs), frame)
    return up, dn


def mark(rows: list[dict], level: str, frames: dict[str, E.Frame]) -> list[dict]:
    """Each trade with `support` (how many of the three) or `excluded` (an instrument's day missing)."""
    sides = {name: beyond(fr, level) for name, fr in frames.items()}
    index = {name: {d: i for i, d in enumerate(fr.days)} for name, fr in frames.items()}
    out = []
    for r in rows:
        j = E.clock_to_stamp(r["entry"], "entry") - 1
        count, excluded = 0, False
        for name in frames:
            i = index[name].get(r["day"])
            if i is None:
                excluded = True
                break
            up, dn = sides[name]
            count += bool((up if r["side"] == "up" else dn)[i, j])
        out.append({**r, "support": None if excluded else count, "excluded": excluded})
    return out


def compare(marked: list[dict], shuffles: int, seed: int) -> dict:
    kept = [r for r in marked if not r["excluded"]]
    nets = np.array([r["net"] for r in kept], dtype=float)
    supported = np.array([r["support"] >= CRITERIA["supported_min"] for r in kept])
    n_sup, n_uns = int(supported.sum()), int((~supported).sum())
    out = {
        "trades": len(marked),
        "excluded": len(marked) - len(kept),
        "supported": n_sup,
        "unsupported": n_uns,
        "share_supported": n_sup / len(kept) if kept else None,
    }
    if n_sup == 0 or n_uns == 0:
        return {**out, "D": None, "p": None}
    d = nets[supported].mean() - nets[~supported].mean()
    rng = np.random.default_rng(seed)
    hits = 0
    for _ in range(shuffles):
        perm = rng.permutation(supported)
        hits += nets[perm].mean() - nets[~perm].mean() >= d
    return {
        **out,
        "mean_supported": float(nets[supported].mean()),
        "mean_unsupported": float(nets[~supported].mean()),
        "D": float(d),
        "p": hits / shuffles,
    }


def holm(pvalues: dict[str, float | None]) -> dict[str, float | None]:
    known = sorted((p, k) for k, p in pvalues.items() if p is not None)
    m, running, out = len(known), 0.0, {k: None for k in pvalues}
    for rank, (p, k) in enumerate(known):
        running = max(running, min(1.0, (m - rank) * p))
        out[k] = running
    return out


def passes(c: dict, p_holm: float | None) -> tuple[bool, str]:
    if (
        c.get("share_supported") is not None
        and c["share_supported"] > RULE["non_selective_if_supported_share_above"]
    ):
        return False, "non-selective"
    if c["supported"] < RULE["min_supported"] or c["unsupported"] < RULE["min_unsupported"]:
        return False, "too few trades on a side"
    if c["D"] is None or c["D"] <= RULE["D_gt"]:
        return False, "D not above zero"
    if p_holm is None or p_holm > RULE["p_max_holm"]:
        return False, "p above 0.05 after Holm"
    if c["mean_supported"] <= RULE["supported_mean_net_gt"]:
        return False, "supported trades lose"
    return True, "passes"


def confirmation_rows(root: Path, vid: str) -> tuple[list[dict], str]:
    import yaml

    from option_backtesting.ruletest import frame as F
    from option_backtesting.ruletest import store, study
    from option_backtesting.ruletest.spec import from_dict

    rule = dict(grid())[vid]
    compiled = from_dict(rule)
    seen = store.confirmation_tests(store.ledger(root), compiled.spec_hash)
    if seen:  # BL-152 already looked: reuse that test, no second look
        result = store.read_result(root, seen[0])
        return result["periods"]["confirmation"].get("rows", []), f"reused {seen[0]}"
    store.reveal(root, compiled.spec_hash, "BL-153 registered hold-out (research/bl153/support.py)")
    lo, hi = study.PERIODS["confirmation"]
    result = study.run_test(
        root,
        compiled,
        yaml.safe_dump({"rule": rule}, sort_keys=False),
        study.Options(periods=("confirmation",), workers=6),
        frame=F.load_frame(root, "NIFTY", hi),
    )
    return result["periods"]["confirmation"].get("rows", []), f"ran {result['id']}"


def main() -> int:
    root = Path(os.environ["TRADING_DATA_ROOT"])
    judgement = json.loads((BL152_OUT / "judgement.json").read_text())
    variants = (
        list(CRITERIA["variants"]["reference"])
        + [v for v in judgement.get("advancing", []) if v not in CRITERIA["variants"]["reference"]][
            :3
        ]
    )
    until = date.fromisoformat(CRITERIA["learning_period"][1])
    frames = {name: load_frame(root, name, asset, until) for name, asset in INSTRUMENTS}
    shuffles, seed = CRITERIA["control"]["shuffles"], CRITERIA["control"]["seed"]
    results = {}
    for vid in variants:
        level = vid.removeprefix("bl152_").split("_")[0]
        rows = json.loads((BL152_OUT / "nets" / f"{vid}.json").read_text())
        results[vid] = compare(mark(rows, level, frames), shuffles, seed)
    adjusted = holm({v: r["p"] for v, r in results.items()})
    for vid, r in results.items():
        r["p_holm"] = adjusted[vid]
        r["passed"], r["why"] = passes(r, adjusted[vid])
    passing = [v for v, r in results.items() if r["passed"]]
    confirmation = {}
    if passing:
        hi = date.fromisoformat(CRITERIA["confirmation_period"][1])
        cframes = {name: load_frame(root, name, asset, hi) for name, asset in INSTRUMENTS}
        for vid in passing:
            rows, how = confirmation_rows(root, vid)
            level = vid.removeprefix("bl152_").split("_")[0]
            c = compare(mark(rows, level, cframes), shuffles, seed)
            c["how"] = how
            c["passed"] = (
                c["D"] is not None
                and c["D"] > RULE["confirmation"]["D_gt"]
                and c["p"] <= RULE["confirmation"]["p_max"]
            )
            confirmation[vid] = c
    if not results:
        verdict = "no variants"
    elif all(r["why"] == "non-selective" for r in results.values()):
        verdict = "non-selective"
    elif any(c["passed"] for c in confirmation.values()):
        verdict = "passed: " + ", ".join(v for v, c in confirmation.items() if c["passed"])
    else:
        verdict = "killed"
    report = {"judged": date.today().isoformat(), "variants": results, "confirmation": confirmation,
              "verdict": verdict}  # fmt: skip
    OUT.mkdir(exist_ok=True)
    (OUT / "result.json").write_text(json.dumps(report, indent=2, default=float))
    print(f"verdict: {verdict}")
    for vid, r in results.items():
        print(
            f"  {vid:32s} trades {r['trades']:3d} (excl {r['excluded']}), supported "
            f"{r['supported']} / {r['unsupported']} ({(r['share_supported'] or 0):.0%}), "
            f"D {r['D'] if r['D'] is None else round(r['D'])}, p {r['p']}, Holm {r['p_holm']}: {r['why']}"
        )
    for vid, c in confirmation.items():
        print(
            f"  confirmation {vid}: D {c['D']}, p {c['p']} ({c['how']}): {'pass' if c['passed'] else 'fail'}"
        )
    return 0


if __name__ == "__main__":
    sys.exit(main())
