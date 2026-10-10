"""BL-081 block 3: apply the registered keep rule to the explore and confirm rule results.

    uv run --with pandas --with numpy python research/bl081/ck_report.py

Keep = in BOTH sets: gross above the plain list, above the state-blind control, above the random-action P90
and above the largest of the 10 label shuffles; max drawdown not more than 10% worse than the plain list;
for versions that drop picks, the dropped picks' P&L negative.
"""

from __future__ import annotations

from pathlib import Path

import pandas as pd

OUT = Path(__file__).parent / "out" / "ck"
KEY = ["list", "var", "m", "breadth", "action"]


def main() -> None:
    pd.set_option("display.width", 250)
    parts = {}
    for st in ("explore", "confirm"):
        fs = sorted(OUT.glob(f"rule_{st}_*.csv"))
        parts[st] = pd.concat([pd.read_csv(f) for f in fs]) if fs else pd.DataFrame()
    e, c = parts["explore"], parts["confirm"]
    e = e[e["var"] != "state_blind"]
    c = c[c["var"] != "state_blind"]
    m = e.merge(c, on=KEY, suffixes=("_e", "_c"), how="left")
    for s in ("e", "c"):
        m[f"gain_{s}"] = m[f"gross_{s}"] - m[f"plain_{s}"]
        m[f"over_blind_{s}"] = m[f"gross_{s}"] - m[f"blind_{s}"]
    print(f"versions: {len(e)} explore rows, {len(c)} confirm rows ({len(m)} joined)")
    print("\n=== how many versions beat the plain list (explore / confirm / both), by variable")
    g = m.assign(ex=m.gain_e > 0, cf=m.gain_c > 0, both=(m.gain_e > 0) & (m.gain_c > 0),
                 beat_blind_both=(m.over_blind_e > 0) & (m.over_blind_c > 0) & (m.gain_e > 0) & (m.gain_c > 0))
    print(g.groupby("var")[["ex", "cf", "both", "beat_blind_both"]].sum().to_string())
    print("\n=== state-blind control (same rule, no state): mean gain over the plain list, by set")
    sb = pd.concat([parts["explore"], parts["confirm"]])
    sb = sb[sb["var"] == "state_blind"].assign(gain=lambda d: d.gross - d.plain)
    print(sb.groupby(["set", "action"]).gain.mean().round(0).to_string())

    def keep(r):
        ok = True
        for s in ("e", "c"):
            ok &= bool(r[f"gain_{s}"] > 0 and r[f"over_blind_{s}"] > 0)
            ok &= bool(pd.notna(r.get(f"rand_p90_{s}")) and r[f"gross_{s}"] > r[f"rand_p90_{s}"])
            ok &= bool(pd.notna(r.get(f"shuf_max_{s}")) and r[f"gross_{s}"] > r[f"shuf_max_{s}"])
            ok &= bool(r[f"dd_{s}"] >= 1.10 * r[f"plain_dd_{s}"])
            if r.action in ("drop", "both") and r[f"drops_{s}"] > 0:
                ok &= bool(r[f"drop_pnl_{s}"] < 0)
        return ok

    m["keep"] = m.apply(keep, axis=1)
    cols = ["list", "var", "m", "breadth", "action", "gain_e", "gain_c", "over_blind_e", "over_blind_c",
            "swaps_e", "drops_e", "swap_gain_e", "drop_pnl_e", "keep"]
    print("\n=== best 15 versions by the smaller of the two gains over the plain list")
    m["min_gain"] = m[["gain_e", "gain_c"]].min(axis=1)
    print(m.sort_values("min_gain", ascending=False)[cols + ["min_gain"]].head(15).round(0).to_string(index=False))
    print(f"\nKEPT under the registered rule: {int(m.keep.sum())} of {len(m)} versions")
    if m.keep.any():
        print(m[m.keep][cols].round(0).to_string(index=False))
    m.to_csv(OUT / "report.csv", index=False)


if __name__ == "__main__":
    main()
