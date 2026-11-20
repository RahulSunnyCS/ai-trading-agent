"""BL-240: judge the registered rule on out/table.json (primary cell M = 5,000)."""

from __future__ import annotations

import json
import os
import sys
from datetime import date
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
PKG = HERE.parents[1]
sys.path.insert(0, str(PKG / "src"))
sys.path.insert(0, str(PKG / "research" / "common"))
from option_backtesting.rotation.readout import block_bootstrap_mean  # noqa: E402

TABLE = json.loads((HERE / "out" / "table.json").read_text())
KEYS, T = TABLE["keys"], TABLE["table"]
N = len(KEYS)
SEED, DRAWS, BLOCK = 20261120, 2000, 5
MS = (3000, 4000, 5000, 6000, 7000)
PRIMARY = 5000


def arm(name: str, mask=None) -> np.ndarray:
    v = np.array([T[k]["arms"][name]["net"] for k in KEYS])
    return v if mask is None else v[mask]


def total(name: str, key: str, mask=None) -> float:
    v = np.array([T[k]["arms"][name][key] for k in KEYS], dtype=float)
    return float(v.sum() if mask is None else v[mask].sum())


def stats(v: np.ndarray) -> dict:
    cum = np.cumsum(v)
    peak = np.maximum.accumulate(np.concatenate([[0.0], cum]))[1:]
    n5 = np.convolve(v, np.ones(5), "valid")
    return {"mean": v.mean(), "max_dd": float((peak - cum).max()), "worst_5d": float(n5.min())}


def ci(diff: np.ndarray) -> tuple[float, float, float]:
    return block_bootstrap_mean(diff, resamples=DRAWS, block=BLOCK, seed=SEED, level=0.90)


def line(label: str, v: np.ndarray, ref: np.ndarray | None, name: str) -> str:
    st = stats(v)
    d = (
        ""
        if ref is None
        else f"{(v - ref).mean():>7.0f} [{ci(v - ref)[1]:>5.0f},{ci(v - ref)[2]:>5.0f}]"
    )
    return (
        f"{label:18}{st['mean']:>7.0f}  {d:>20}{st['max_dd']:>9.0f}{st['worst_5d']:>9.0f}"
        f"{total(name, 'orders'):>8.0f}{total(name, 'stops'):>7.0f}{total(name, 'covers'):>8.0f}"
        f"{total(name, 'covers_resold'):>9.0f}{total(name, 'cover_gross'):>11.0f}"
    )


def main() -> None:
    print(
        f"{N} Dir pick-days; control mismatches vs stored Core results: {len(TABLE['control_mismatch'])}; skipped {len(TABLE['skipped'])}"
    )
    print(
        f"\n{'arm':18}{'₹/day':>7}  {'vs same-M plain [5%,95%]':>20}{'maxDD':>9}{'worst5d':>9}{'orders':>8}{'stops':>7}{'covers':>8}{'resold':>9}{'cover ₹':>11}"
    )
    for m in MS:
        a, h = arm(f"A{m}"), arm(f"H{m}")
        print(line(f"A({m})", a, None, f"A{m}"))
        print(line(f"H({m})", h, a, f"H{m}"))
    print(line(f"W({PRIMARY}) placebo", arm(f"W{PRIMARY}"), arm(f"A{PRIMARY}"), f"W{PRIMARY}"))

    a3, a5, h5, w5 = arm("A3000"), arm(f"A{PRIMARY}"), arm(f"H{PRIMARY}"), arm(f"W{PRIMARY}")
    r1a, r1b, r2 = ci(h5 - a5), ci(h5 - a3), ci(h5 - w5)
    blocks = np.array_split(np.arange(N), 4)
    wins = [float(h5[b].mean() - a5[b].mean()) for b in blocks]
    s_h, s_a3 = stats(h5), stats(a3)
    by_m = [(m, float((arm(f"H{m}") - arm(f"A{m}")).mean())) for m in MS]
    rules = {
        "i  H5-A5 and H5-A3 5th pct > 0": r1a[1] > 0 and r1b[1] > 0,
        "ii H5-W5 5th pct > 0": r2[1] > 0,
        "iii H5 above A5 in >=3 of 4 blocks": sum(w > 0 for w in wins) >= 3,
        "iv H5 maxDD and worst-5d no worse than A3": s_h["max_dd"] <= s_a3["max_dd"]
        and s_h["worst_5d"] >= s_a3["worst_5d"],
        "v  H(M) > A(M) at >=4 of 5 M": sum(d > 0 for _, d in by_m) >= 4,
    }
    print("\nRule (primary M = 5,000):")
    print(
        f"  H5-A5 {r1a[0]:+.0f} [{r1a[1]:+.0f},{r1a[2]:+.0f}]; H5-A3 {r1b[0]:+.0f} [{r1b[1]:+.0f},{r1b[2]:+.0f}]; H5-W5 {r2[0]:+.0f} [{r2[1]:+.0f},{r2[2]:+.0f}]"
    )
    print(
        f"  blocks H5-A5: {[round(w) for w in wins]}; maxDD H5 {s_h['max_dd']:.0f} vs A3 {s_a3['max_dd']:.0f}; worst5d {s_h['worst_5d']:.0f} vs {s_a3['worst_5d']:.0f}"
    )
    print(f"  H(M)-A(M): {[(m, round(d)) for m, d in by_m]}")
    for k, ok in rules.items():
        print(f"  {'PASS' if ok else 'FAIL'}  {k}")
    print(f"  => {'passes all five' if all(rules.values()) else 'KILLED'}")

    print("\nSlippage sensitivity (₹/day, charges kept):")
    for slip in ("0", "1"):
        row = {
            n: arm(f"{n}@{slip}").mean()
            for n in ("A3000", f"A{PRIMARY}", f"H{PRIMARY}", f"W{PRIMARY}")
        }
        print(
            f"  {slip}%: "
            + ", ".join(f"{k} {v:.0f}" for k, v in row.items())
            + f"; H5-A5 {row[f'H{PRIMARY}'] - row[f'A{PRIMARY}']:+.0f}"
        )

    for label, sel in (
        ("NIFTY picks", np.array([T[k]["name"][0] == "N" for k in KEYS])),
        ("SENSEX picks", np.array([T[k]["name"][0] == "S" for k in KEYS])),
    ):
        print(
            f"\n{label} ({int(sel.sum())}): A3 {arm('A3000', sel).mean():.0f}, A5 {arm(f'A{PRIMARY}', sel).mean():.0f}, H5 {arm(f'H{PRIMARY}', sel).mean():.0f}, W5 {arm(f'W{PRIMARY}', sel).mean():.0f}"
        )

    try:

        from trend_state import trend_states

        from option_backtesting.ruletest.frame import load_frame

        root = Path(os.environ.get("TRADING_DATA_ROOT", "/Volumes/TradingData"))
        state = trend_states(load_frame(root, "NIFTY", date(2026, 10, 8), date(2020, 9, 1)))[
            "hourly"
        ]
        up = np.array([state.get(k.split("|")[0], 0) > 0 for k in KEYS])
        for label, sel in (("up-trend days", up), ("down-trend days", ~up)):
            print(
                f"{label} ({int(sel.sum())}): A5 {arm(f'A{PRIMARY}', sel).mean():.0f}, H5 {arm(f'H{PRIMARY}', sel).mean():.0f}, W5 {arm(f'W{PRIMARY}', sel).mean():.0f}"
            )
    except Exception as exc:  # the trend split is descriptive only
        print(f"(trend split skipped: {exc})")


if __name__ == "__main__":
    main()
