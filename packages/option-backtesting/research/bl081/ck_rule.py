"""BL-081 block 3, stage 3: the hourly adjustment rule on one list and set (registered 2026-10-10).

    uv run --with pandas --with numpy python research/bl081/ck_rule.py <explore|confirm> <A|B|C|REF>

At 10:30 / 11:30 / 12:30 / 13:30 the not-yet-started picks (start >= hour + 15 min) are re-scored:
score = (1 - m) * pct(list composite at 09:16) + m * pct(pooled state fit), both percentile-ranked within the
pending universe (core and Buy separately). A pending pick is swapped for the best-scoring unpicked pending
variant when that one scores higher (breadth: free = any pending core variant; family = same strategy type
and index), then dropped when its pool's expected rupees in today's state are < 0 (action: swap / drop /
both). Pooled state fit: mean P&L per strategy-day of the variant's pool (type x start band x index, pending
members only) on past days with the same state, lookbacks 21 / 63 / 126 / 252 (25% each, a window needs >= 5
matching days; windows without them are dropped and the rest re-weighted, the pool's unconditional fit only when none qualifies). Widesl minimum (2 strategies) is never broken.
State variables: vix_open, trend_atr, atr_range, rsi (BL-081 bands), live_wide, live_dir (the 09:16 picks'
MTM at the hour: none / down < -1,000 / flat / up > +1,000 for 2 lots) and vix_open+live_wide.
Controls: state-blind (one label for every day), 1,000 random actions (same counts per day and hour), 10
label shuffles. Output out/ck/rule_<set>_<list>.csv.
"""

from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import pandas as pd

HERE = Path(__file__).parent
OUT = HERE / "out" / "ck"
HOURS = {"1030": 630, "1130": 690, "1230": 750, "1330": 810}
WINDOWS = (21, 63, 126, 252)
MIN_MATCH = 5
LOTS_PER, MIN_WIDE_N, N_RUNS = 2, 2, 1000
VARS = ["vix_open", "trend_atr", "atr_range", "rsi", "live_wide", "live_dir", "vix_open+live_wide"]
CLOSEST = {"p80", "p100", "p250", "p320", "p40", "p60", "p120", "p200"}


def rank_pct(x: np.ndarray) -> np.ndarray:
    _, inv, cnt = np.unique(x, return_inverse=True, return_counts=True)
    r = (np.cumsum(cnt) - (cnt - 1) / 2)[inv]
    return r / max(len(x), 1)


class Env:
    def __init__(self, st: str, lst: str):
        z = np.load(OUT / f"prep_{st}_{lst}.npz")
        self.names = [str(n) for n in z["names"]]
        self.days = [str(d) for d in z["days"]]
        self.Pv, self.sel, self.comp, self.core, self.buy = z["Pv"], z["sel"], z["comp"], z["core"], z["buy"]
        fam = [n.split("_")[1] for n in self.names]
        self.typ = np.array(["dir" if f in ("dir", "ditm1") else "buy" if f == "buy" else "wide" for f in fam])
        self.idx = np.array([n[0] for n in self.names])
        self.start = np.array([int(n.split("_")[2][:2]) * 60 + int(n.split("_")[2][2:]) for n in self.names])
        self.band = np.where(self.start <= 602, "A", np.where(self.start <= 722, "B", np.where(self.start <= 842, "C", "D")))
        self.is_wide = np.array([f == "wide" or f in CLOSEST for f in fam])
        self.is_buy = self.typ == "buy"
        self.st, self.lst = st, lst
        self.plain = np.array([LOTS_PER * (self.Pv[i, c].sum() + (self.Pv[i, b] if b >= 0 else 0.0))
                               for i, c, b in zip(self.sel, self.core, self.buy, strict=True)])
        self._labels()
        self._pools()

    # ---- labels -----------------------------------------------------------------------------------
    def _labels(self):
        sys.path.insert(0, str(HERE))
        import state as S

        raw = pd.read_csv(OUT.parent / "state_raw.csv", dtype={"h": str})
        lab = S.labels(raw).set_index(["index", "h", "day"]).sort_index()
        n = len(self.days)
        self.lab: dict[tuple[str, str], dict[str, np.ndarray]] = {}
        for h in HOURS:
            for var in ("vix_open", "trend_atr", "atr_range", "rsi"):
                d = {}
                for L, und in (("N", "NIFTY"), ("S", "SENSEX")):
                    try:
                        s = lab.loc[(und, h)][var].reindex(self.days).to_numpy(object)
                    except KeyError:
                        s = np.full(n, None, dtype=object)
                    d[L] = np.array([None if (x is None or (isinstance(x, float) and np.isnan(x))) else str(x) for x in s], dtype=object)
                self.lab[(var, h)] = d
        # live clue from the 09:16 picks' MTM at the hour (the pick's own strategy, 2 lots)
        mt = pd.read_csv(OUT / "mtm.csv", dtype={"day": str})
        mt = mt.set_index(["day", "variant"])
        for h in HOURS:
            for kind, tp in (("live_wide", "wide"), ("live_dir", "dir")):
                arr = np.full(n, "none", dtype=object)
                for k, i in enumerate(self.sel):
                    tot, any_ = 0.0, False
                    for v in [*self.core[k], self.buy[k]]:
                        if v < 0 or self.typ[v] != tp or self.start[v] > HOURS[h]:
                            continue
                        try:
                            x = mt.loc[(self.days[i], self.names[v]), f"mtm_{h}"]
                        except KeyError:
                            continue
                        if pd.notna(x):
                            tot += float(x) * LOTS_PER
                            any_ = True
                    if any_:
                        arr[i] = "down" if tot < -1000 else "up" if tot > 1000 else "flat"
                self.lab[(kind, h)] = {"N": arr, "S": arr}
            # a None vix label or a "none" live label means no label for the pair
            both = {L: np.array([None if (a is None or b == "none") else f"{a}|{b}" for a, b in
                                 zip(self.lab[("vix_open", h)][L], self.lab[("live_wide", h)]["N"], strict=True)], dtype=object)
                    for L in ("N", "S")}
            self.lab[("vix_open+live_wide", h)] = both

    # ---- pooled fit ---------------------------------------------------------------------------------
    def _pools(self):
        self.pool_of = {}
        keys = sorted({(t, b, i) for t, b, i in zip(self.typ, self.band, self.idx, strict=True)})
        self.pool_members = {k: np.where((self.typ == k[0]) & (self.band == k[1]) & (self.idx == k[2]))[0] for k in keys}
        self.M = {}
        for h, hm in HOURS.items():
            m = np.full((len(self.days), len(keys)), np.nan)
            for gi, k in enumerate(keys):
                mem = self.pool_members[k]
                mem = mem[self.start[mem] >= hm + 15]
                if len(mem):
                    m[:, gi] = self.Pv[:, mem].mean(axis=1)
            self.M[h] = m
        self.keys = keys

    def fit(self, var: str | None, h: str, perm: np.ndarray | None = None) -> np.ndarray:
        """selection days x variants: the pooled fit (rupees per strategy-day, 1 lot). var None = state-blind."""
        n_sel, V = len(self.sel), len(self.names)
        F = np.full((n_sel, V), np.nan)
        M = self.M[h]
        for gi, (t, b, ix) in enumerate(self.keys):
            col = M[:, gi]
            if np.isnan(col).all():
                continue
            if var is None:
                L = np.full(len(self.days), "x", dtype=object)
            else:
                L = self.lab[(var, h)][ix]
                if perm is not None:
                    L = L[perm]
            mem = self.pool_members[(t, b, ix)]
            for k, i in enumerate(self.sel):
                num = den = 0.0
                for n in WINDOWS:
                    lo = max(0, i - n)
                    if L[i] is None:
                        break
                    m = (L[lo:i] == L[i]) & ~np.isnan(col[lo:i])
                    if m.sum() >= MIN_MATCH:
                        num += col[lo:i][m].mean()
                        den += 1
                if den == 0 and var is not None:  # no matching history: the pool's unconditional fit
                    for n in WINDOWS:
                        lo = max(0, i - n)
                        v = col[lo:i][~np.isnan(col[lo:i])]
                        if len(v) >= MIN_MATCH:
                            num += v.mean()
                            den += 1
                if den:
                    F[k, mem] = num / den
        return F


def run_rule(env: Env, Fs: dict[str, np.ndarray], m: float, breadth: str, action: str, rng=None, counts=None):
    """Return per-day P&L and the action log. rng/counts: random-action control (same counts, random targets)."""
    n_sel = len(env.sel)
    pnl = np.zeros(n_sel)
    swaps = drops = 0
    swap_gain = drop_pnl = 0.0
    log = []
    random_mode = rng is not None
    action_days = {k for k, _h in counts} if random_mode else None
    for k, i in enumerate(env.sel):
        if random_mode and k not in action_days:
            pnl[k] = env.plain[k]
            continue
        slots = [int(v) for v in env.core[k]]
        bslot = int(env.buy[k])
        comp = env.comp[k]
        alive = [True] * len(slots)
        b_alive = bslot >= 0
        for h, hm in HOURS.items():
            F = Fs[h][k]
            pend_mask = env.start >= hm + 15
            core_u = np.where(pend_mask & ~env.is_buy)[0]
            buy_u = np.where(pend_mask & env.is_buy)[0]
            if not len(core_u):
                continue
            def score_for(u, F=F, comp=comp):
                fv = F[u]
                fv = np.where(np.isnan(fv), np.nanmean(fv) if not np.isnan(fv).all() else 0.0, fv)
                return (1 - m) * rank_pct(comp[u]) + m * rank_pct(fv)
            if random_mode:
                sc, scb = {}, {}
            else:
                sc = dict(zip(core_u, score_for(core_u), strict=True))
                scb = dict(zip(buy_u, score_for(buy_u), strict=True)) if len(buy_u) else {}
            pending = [j for j, v in enumerate(slots) if alive[j] and env.start[v] >= hm + 15]
            n_sw = n_dr = 0
            if action in ("swap", "both"):
                for j in sorted(pending, key=lambda j: sc.get(slots[j], -1)):
                    cur = slots[j]
                    cands = [u for u in core_u if u not in slots and
                             (breadth == "free" or (env.typ[u] == env.typ[cur] and env.idx[u] == env.idx[cur]))]
                    if not cands:
                        continue
                    if random_mode:
                        continue
                    best = max(cands, key=lambda u: sc[u])
                    if sc[best] <= sc.get(cur, -1):
                        continue
                    trial = slots.copy()
                    trial[j] = int(best)
                    if sum(env.is_wide[v] for v, a in zip(trial, alive, strict=True) if a) < MIN_WIDE_N:
                        continue
                    swap_gain += LOTS_PER * (env.Pv[i, best] - env.Pv[i, cur])
                    slots[j] = int(best)
                    n_sw += 1
                if b_alive and bslot >= 0 and env.start[bslot] >= hm + 15 and len(buy_u) and not random_mode:
                    cands = [u for u in buy_u if u != bslot and (breadth == "free" or (env.idx[u] == env.idx[bslot]))]
                    if cands:
                        best = max(cands, key=lambda u: scb[u])
                        if scb[best] > scb.get(bslot, -1):
                            swap_gain += LOTS_PER * (env.Pv[i, best] - env.Pv[i, bslot])
                            bslot = int(best)
                            n_sw += 1
            if action in ("drop", "both") and not random_mode:
                for j in pending:
                    if not alive[j] or env.start[slots[j]] < hm + 15:
                        continue
                    f = F[slots[j]]
                    if not np.isnan(f) and f < 0:
                        trial_alive = alive.copy()
                        trial_alive[j] = False
                        if sum(env.is_wide[v] for v, a in zip(slots, trial_alive, strict=True) if a) >= MIN_WIDE_N:
                            drop_pnl += LOTS_PER * env.Pv[i, slots[j]]
                            alive[j] = False
                            n_dr += 1
                if b_alive and bslot >= 0 and env.start[bslot] >= hm + 15:
                    f = F[bslot]
                    if not np.isnan(f) and f < 0:
                        drop_pnl += LOTS_PER * env.Pv[i, bslot]
                        b_alive = False
                        n_dr += 1
            if random_mode:  # same counts at this day and hour, random targets
                c_sw, c_dr = counts.get((k, h), (0, 0))
                for _ in range(c_sw):
                    pj = [j for j in pending if alive[j] and env.start[slots[j]] >= hm + 15]
                    if not pj:
                        break
                    j = pj[rng.integers(len(pj))]
                    cands = [u for u in core_u if u not in slots and
                             (breadth == "free" or (env.typ[u] == env.typ[slots[j]] and env.idx[u] == env.idx[slots[j]]))]
                    if cands:
                        trial = slots.copy()
                        trial[j] = int(cands[rng.integers(len(cands))])
                        if sum(env.is_wide[v] for v, a in zip(trial, alive, strict=True) if a) >= MIN_WIDE_N:
                            slots = trial
                for _ in range(c_dr):
                    pj = [j for j in pending if alive[j] and env.start[slots[j]] >= hm + 15]
                    if not pj:
                        break
                    j = pj[rng.integers(len(pj))]
                    trial_alive = alive.copy()
                    trial_alive[j] = False
                    if sum(env.is_wide[v] for v, a in zip(slots, trial_alive, strict=True) if a) >= MIN_WIDE_N:
                        alive[j] = False
            log.append((k, h, n_sw, n_dr))
            swaps += n_sw
            drops += n_dr
        pnl[k] = LOTS_PER * (sum(env.Pv[i, v] for v, a in zip(slots, alive, strict=True) if a)
                             + (env.Pv[i, bslot] if (b_alive and bslot >= 0) else 0.0))
    return pnl, dict(swaps=swaps, drops=drops, swap_gain=swap_gain, drop_pnl=drop_pnl, log=log)


def mdd(s: np.ndarray) -> float:
    eq = np.cumsum(s)
    return float((eq - np.maximum.accumulate(np.maximum(eq, 0))).min())


def main() -> None:
    import time

    st, lst = sys.argv[1], sys.argv[2]
    env = Env(st, lst)
    plain_total, plain_dd = env.plain.sum(), mdd(env.plain)
    print(f"{st} {lst}: {len(env.sel)} days, plain {plain_total:,.0f}, max DD {plain_dd:,.0f}", flush=True)
    t0 = time.time()
    blind = {h: env.fit(None, h) for h in HOURS}
    print(f"  blind fit {time.time() - t0:.0f}s", flush=True)
    rows = []
    versions = [(m, b, a) for m in (0.25, 0.5) for b in ("free", "family") for a in ("swap", "both")] + \
               [(m, "free", "drop") for m in (0.25, 0.5)]
    for m, b, a in versions:
        pnl, info = run_rule(env, blind, m, b, a)
        rows.append(dict(set=st, list=lst, var="state_blind", m=m, breadth=b, action=a, gross=pnl.sum(), plain=plain_total,
                         dd=mdd(pnl), plain_dd=plain_dd, **{k: info[k] for k in ("swaps", "drops", "swap_gain", "drop_pnl")}))
    blind_gross = {(r["m"], r["breadth"], r["action"]): r["gross"] for r in rows}
    # the confirmation set runs controls only for versions that survived stage A in the explore file
    allowed = None
    ex = OUT / f"rule_explore_{lst}.csv"
    if st == "confirm" and ex.exists():
        e = pd.read_csv(ex)
        e = e[(e["var"] != "state_blind") & (e.gross > e.plain) & (e.gross > e.blind)]
        allowed = {(r["var"], r.m, r.breadth, r.action) for _, r in e.iterrows()}
    shuf_cache: dict = {}
    for var in VARS:
        Fs = {h: env.fit(var, h) for h in HOURS}
        for m, b, a in versions:
            pnl, info = run_rule(env, Fs, m, b, a)
            row = dict(set=st, list=lst, var=var, m=m, breadth=b, action=a, gross=pnl.sum(), plain=plain_total,
                       dd=mdd(pnl), plain_dd=plain_dd, blind=blind_gross[(m, b, a)],
                       **{k: info[k] for k in ("swaps", "drops", "swap_gain", "drop_pnl")})
            ctl = pnl.sum() > plain_total and pnl.sum() > blind_gross[(m, b, a)] and (info["swaps"] + info["drops"]) > 0
            if allowed is not None:
                ctl = ctl and (var, m, b, a) in allowed
            if ctl:
                if var not in shuf_cache:
                    shuf_cache[var] = []
                    for s_ in range(10):
                        perm = np.random.default_rng(s_).permutation(len(env.days))
                        shuf_cache[var].append({h: env.fit(var, h, perm) for h in HOURS})
                shuf = [run_rule(env, Fp, m, b, a)[0].sum() for Fp in shuf_cache[var]]
                row["shuf_max"] = float(max(shuf))
                if pnl.sum() > row["shuf_max"]:
                    counts = {(k, h): (ns, nd) for k, h, ns, nd in info["log"] if ns or nd}
                    rng = np.random.default_rng(81)
                    rnd = np.array([run_rule(env, blind, m, b, a, rng=rng, counts=counts)[0].sum() for _ in range(N_RUNS)])
                    row["rand_p90"] = float(np.percentile(rnd, 90))
            rows.append(row)
        print(f"  {var} done ({time.time() - t0:.0f}s)", flush=True)
        pd.DataFrame(rows).to_csv(OUT / f"rule_{st}_{lst}.csv", index=False)
    print(f"{st} {lst}: wrote {len(rows)} rows ({time.time() - t0:.0f}s)")


if __name__ == "__main__":
    main()
