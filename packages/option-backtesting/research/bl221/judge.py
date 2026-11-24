"""BL-221: read out/table.json and judge the registered rule (Amendments 1 and 2). Prints the report.

    uv run python research/bl221/judge.py
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from run import CUTOFFS, PRIMARY, RANGE_ENDS, SEED  # noqa: E402

TABLE = json.loads((HERE / "out" / "table.json").read_text())
DAYS = TABLE["days"]
T = TABLE["table"]
N = len(DAYS)
SLIP = "0.5"
DRAWS = 2000


def side_trade(row, rname, side, cut, slip, kind="sell"):
    """The day's trade for a break side, or None (no break, past the cut-off, engine could not run)."""
    t = row["breaks"][rname][side]
    if t is None or t > CUTOFFS[cut]:
        return None
    sims = row["sims"].get(f"{rname}|{side}")
    return sims[kind][slip] if sims else None


def series(rname, kind_trend, cut, slip=SLIP, mode="gate", trade_kind="sell", rng=None, p_up=None):
    """(net per day, traded flags, side taken per day). mode: gate | counter | nogate | placebo."""
    net = np.zeros(N)
    traded = np.zeros(N, bool)
    sides = [None] * N
    for i, d in enumerate(DAYS):
        row = T[d]
        if mode == "nogate":
            tu, td = row["breaks"][rname]["up"], row["breaks"][rname]["down"]
            cands = [(t, s) for s, t in (("up", tu), ("down", td)) if t is not None and t <= CUTOFFS[cut]]
            if not cands:
                continue
            cands.sort()
            if len(cands) == 2 and cands[0][0] == cands[1][0]:
                continue
            side = cands[0][1]
        else:
            tr = row["trend"][kind_trend]
            if tr == 0:
                continue
            side = "up" if tr > 0 else "down"
            if mode == "counter":
                side = "down" if side == "up" else "up"
            if mode == "placebo":
                side = "up" if rng.random() < p_up else "down"
        r = side_trade(row, rname, side, cut, slip, trade_kind)
        if r is None:
            continue
        net[i], traded[i], sides[i] = r["net"], bool(r["traded"]), side
    return net, traded, sides


EXTRA_PATH = HERE / "out" / "table_itm2.json"
LEVEL_PATH = HERE / "out" / "table_level.json"


def extra_series(kind, cut, mode="gate", slip=SLIP, trend_kind="hourly", rname="10:00", path=EXTRA_PATH):
    """ITM2 extras (exploratory, owner override): kind sell|buy over the primary range's breaks."""
    ex = json.loads(path.read_text())
    net = np.zeros(N)
    traded = np.zeros(N, bool)
    for i, d in enumerate(DAYS):
        row = T[d]
        if mode == "nogate":
            tu, td = row["breaks"][rname]["up"], row["breaks"][rname]["down"]
            cands = sorted((t, s) for s, t in (("up", tu), ("down", td)) if t is not None and t <= CUTOFFS[cut])
            if not cands or (len(cands) == 2 and cands[0][0] == cands[1][0]):
                continue
            side = cands[0][1]
        else:
            tr = row["trend"][trend_kind]
            if tr == 0:
                continue
            side = "up" if tr > 0 else "down"
        t = row["breaks"][rname][side]
        if t is None or t > CUTOFFS[cut]:
            continue
        r = ex.get(d, {}).get(f"{rname}|{side}", {}).get(kind, {}).get(slip)
        if r is None:
            continue
        net[i], traded[i] = r["net"], bool(r["traded"])
    return net, traded


def comp(name, slip=SLIP):
    return np.array([(T[d]["comp"][name][slip] or {"net": 0.0})["net"] for d in DAYS])


def stats(net, traded=None):
    cum = np.cumsum(net)
    peak = np.maximum.accumulate(np.concatenate([[0.0], cum]))[1:]
    dd = float(np.max(peak - cum)) if len(net) else 0.0
    n5 = np.convolve(net, np.ones(5), "valid") if N >= 5 else net
    out = {
        "mean_day": float(net.mean()),
        "total": float(net.sum()),
        "max_dd": dd,
        "worst_day": float(net.min()),
        "worst_5d": float(n5.min()),
    }
    if traded is not None:
        k = int(traded.sum())
        out["trades_days"] = k
        out["per_trade"] = float(net[traded].mean()) if k else 0.0
        out["win_rate"] = float((net[traded] > 0).mean()) if k else 0.0
    return out


def boot_lb(diff, seed=SEED, block=5, draws=DRAWS):
    rng = np.random.default_rng(seed)
    n = len(diff)
    k = -(-n // block)
    starts = rng.integers(0, n, size=(draws, k))
    idx = (starts[:, :, None] + np.arange(block)[None, None, :]) % n
    means = diff[idx.reshape(draws, -1)[:, :n]].mean(axis=1)
    return float(np.percentile(means, 5)), float(np.percentile(means, 95))


def blocks(net, base):
    edges = np.linspace(0, N, 5).astype(int)
    return [(float(net[a:b].mean()), float(base[a:b].mean())) for a, b in zip(edges[:-1], edges[1:], strict=True)]


def main():
    base, dir1001 = comp("base"), comp("dir1001")
    missing = [d for d in DAYS if T[d]["comp"]["base"][SLIP] is None]
    print(f"{N} sessions {DAYS[0]} -> {DAYS[-1]}; base Dir unrun on {len(missing)}; "
          f"left out of the fit by the engine: {len(TABLE['skipped'])}")
    cells = [(r, k, c) for r in RANGE_ENDS for k in ("hourly", "daily") for c in CUTOFFS]
    ng_cache = {}
    print(f"\nC1 base Dir (as traded, 0.5%): {stats(base)}")
    print(f"C2 two-leg Dir at 10:01:      {stats(dir1001)}\n")
    hdr = f"{'cell (range/trend/cut)':26}{'₹/day':>8}{'₹/trade':>9}{'days':>6}{'win%':>6}{'maxDD':>9}{'worst':>8} | {'vs C1 [5%,95%]':>24}{'vs C3 [5%,95%]':>24}"
    print(hdr)
    result = {}
    for cell in cells:
        r, k, c = cell
        net, tr, _ = series(r, k, c)
        if (r, c) not in ng_cache:
            ng_cache[(r, c)] = series(r, k, c, mode="nogate")
        ng, ngt, _ = ng_cache[(r, c)]
        st = stats(net, tr)
        d1, d3 = net - base, net - ng
        l1, h1 = boot_lb(d1)
        l3, h3 = boot_lb(d3)
        tag = "*" if cell == PRIMARY else " "
        print(f"{tag}{r}/{k}/{c:<14}{st['mean_day']:>8.0f}{st['per_trade']:>9.0f}{st['trades_days']:>6}"
              f"{st['win_rate'] * 100:>6.0f}{st['max_dd']:>9.0f}{st['worst_day']:>8.0f} | "
              f"{d1.mean():>8.0f} [{l1:>6.0f},{h1:>6.0f}]{d3.mean():>8.0f} [{l3:>6.0f},{h3:>6.0f}]")
        result["|".join(cell)] = {"stats": st, "vs_c1": [float(d1.mean()), l1, h1], "vs_c3": [float(d3.mean()), l3, h3],
                                  "nogate": stats(ng, ngt)}
    # primary cell: the registered rule
    r, k, c = PRIMARY
    net, tr, sides = series(r, k, c)
    ng, ngt, _ = ng_cache[(r, c)]
    st = stats(net, tr)
    print(f"\nPRIMARY {PRIMARY}: {st}")
    print(f"no-gate comparator C3 (same break, either way): {stats(ng, ngt)}")
    # placebo trend
    p_up = float(np.mean([T[d]["trend"][k] > 0 for d in DAYS]))
    rng = np.random.default_rng(SEED)
    pl = np.array([series(r, k, c, mode="placebo", rng=rng, p_up=p_up)[0].mean() for _ in range(DRAWS)])
    pct = float((pl < net.mean()).mean())
    print(f"placebo trend (p_up={p_up:.2f}, {DRAWS} draws): mean ₹/day {pl.mean():.0f}, 5-95% [{np.percentile(pl, 5):.0f}, "
          f"{np.percentile(pl, 95):.0f}]; candidate beats {pct * 100:.1f}% of draws")
    cnet, ctr, _ = series(r, k, c, mode="counter")
    print(f"counter-trend (the other side's break): {stats(cnet, ctr)}")
    # slippage rows
    for s in ("0.0", "1.0"):
        n2, t2, _ = series(r, k, c, slip=s)
        print(f"slippage {s}%: ₹/day {n2.mean():.0f}, total {n2.sum():.0f}; base Dir {comp('base', s).mean():.0f}")
    # buy variant
    bn, bt, _ = series(r, k, c, trade_kind="buy")
    print(f"C5 buy the same-direction ATM (reported only): {stats(bn, bt)}")
    # blocks
    bl = blocks(net, base)
    print("four equal blocks (candidate ₹/day, base ₹/day):", [(round(a), round(b)) for a, b in bl])
    q_ok = sum(1 for a, b in bl if a > 0 and a > b)
    # descriptive splits
    up_days = [i for i in range(N) if sides[i] == "up"]
    dn_days = [i for i in range(N) if sides[i] == "down"]
    print(f"side split: sold PE (up-trend, up-break) {len(up_days)} days mean {net[up_days].mean() if up_days else 0:.0f}; "
          f"sold CE (down-trend, down-break) {len(dn_days)} days mean {net[dn_days].mean() if dn_days else 0:.0f}")
    rp = np.array([T[d]["breaks"][r]["range_pct"] for d in DAYS])
    taken = np.where(tr)[0]
    if len(taken) >= 9:
        cuts = np.percentile(rp[taken], [33.3, 66.7])
        for nm, m in (("narrow", rp[taken] <= cuts[0]), ("middle", (rp[taken] > cuts[0]) & (rp[taken] <= cuts[1])),
                      ("wide", rp[taken] > cuts[1])):
            print(f"range-width tercile {nm}: {m.sum()} trades, mean ₹/trade {net[taken][m].mean():.0f}")
    agree = np.mean([T[d]["trend"]["hourly"] == T[d]["trend"]["daily"] for d in DAYS])
    print(f"hourly and daily trend agree on {agree * 100:.0f}% of days; up-trend share {p_up * 100:.0f}%")
    # the registered rule
    c1, c3 = result["|".join(PRIMARY)]["vs_c1"], result["|".join(PRIMARY)]["vs_c3"]
    rule = {
        "i_beats_C1": c1[1] > 0,
        "i_beats_C3": c3[1] > 0,
        "ii_placebo_95": pct >= 0.95,
        "iii_blocks_3_of_4": q_ok >= 3,
        "iv_drawdown_le_C1": st["max_dd"] <= stats(base)["max_dd"],
    }
    print("\nREGISTERED RULE (primary cell, 0.5% slippage):")
    for kx, v in rule.items():
        print(f"  {kx}: {'PASS' if v else 'FAIL'}")
    print("VERDICT:", "ADVANCE to confirmation" if all(rule.values()) else "KILLED (no candidate)")
    if EXTRA_PATH.exists():
        print("\nEXTRAS (owner override, exploratory; primary range 10:00; 0.5% slippage; never a pass):")
        stats(base)
        for cut in ("12:00", "14:00"):
            rows_ = {
                "sell ATM (registered)": (series(r, k, cut)[0], series(r, k, cut)[1]),
                "buy ATM": series(r, k, cut, trade_kind="buy")[:2],
                "sell ITM2": extra_series("sell", cut),
                "buy ITM2": extra_series("buy", cut),
                **({"sell at range-edge strike": extra_series("sell", cut, path=LEVEL_PATH)} if LEVEL_PATH.exists() else {}),
            }
            nogate = {
                "sell ATM": series(r, k, cut, mode="nogate")[:2],
                "buy ATM": series(r, k, cut, mode="nogate", trade_kind="buy")[:2],
                "sell ITM2": extra_series("sell", cut, "nogate"),
                "buy ITM2": extra_series("buy", cut, "nogate"),
                **({"sell at range-edge strike": extra_series("sell", cut, "nogate", path=LEVEL_PATH)} if LEVEL_PATH.exists() else {}),
            }
            print(f"  cut-off {cut}: trend-aligned | no-gate  (₹/day, ₹/trade, days, win%, maxDD, worst day; "
                  "vs C1 mean [5%,95%])")
            for nm, (nn, tt) in rows_.items():
                g = nogate[nm.replace(" (registered)", "")]
                a, b = stats(nn, tt), stats(g[0], g[1])
                lo, hi = boot_lb(nn - base)
                print(f"    {nm:22} {a['mean_day']:>6.0f} {a['per_trade']:>6.0f} {a['trades_days']:>4} {a['win_rate'] * 100:>3.0f}% "
                      f"{a['max_dd']:>7.0f} {a['worst_day']:>7.0f} vs C1 {np.mean(nn - base):>6.0f} [{lo:>6.0f},{hi:>6.0f}]"
                      f" | no-gate {b['mean_day']:>6.0f} {b['per_trade']:>6.0f} {b['trades_days']:>4} {b['max_dd']:>7.0f}")
        for kind in ("sell", "buy"):
            for sl in ("0.0", "1.0"):
                nn, _ = extra_series(kind, "12:00", slip=sl)
                print(f"  ITM2 {kind} (cut 12:00) slippage {sl}%: ₹/day {nn.mean():.0f}")
        # placebo for the ITM2 buy and sell, same draws as the registered one
        for kind in ("sell", "buy"):
            ex = json.loads(EXTRA_PATH.read_text())
            real = extra_series(kind, "12:00")[0].mean()
            rng2 = np.random.default_rng(SEED)
            vals = []
            for _ in range(DRAWS):
                tot = 0.0
                for d in DAYS:
                    tr = T[d]["trend"][k]
                    if tr == 0:
                        continue
                    side = "up" if rng2.random() < p_up else "down"
                    t = T[d]["breaks"][r][side]
                    if t is None or t > CUTOFFS["12:00"]:
                        continue
                    x = ex.get(d, {}).get(f"{r}|{side}", {}).get(kind, {}).get(SLIP)
                    tot += x["net"] if x else 0.0
                vals.append(tot / N)
            print(f"  ITM2 {kind} placebo trend: candidate beats {(np.array(vals) < real).mean() * 100:.1f}% of draws")
    result["rule"] = rule
    result["placebo_pct"] = pct
    result["blocks"] = bl
    (HERE / "out" / "verdict.json").write_text(json.dumps(result, default=float))


if __name__ == "__main__":
    main()
