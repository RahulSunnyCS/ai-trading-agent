"""BL-081 block 3: controls for the state-blind family-preserving swap (the version that wins in every list).

    uv run --with pandas --with numpy --with duckdb python research/bl081/ck_blind.py <explore|confirm> <A|B|C|REF>

For m in {0.25, 0.5}: the real state-blind family swap, then 1,000 runs doing the same number of swaps per day
and hour at random (same type and index, random pending start), and 1,000 runs of the same count of random
FREE swaps. Writes out/ck/blind_<set>_<list>.csv.
"""

from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).parent))
import ck_rule as K  # noqa: E402


def main() -> None:
    st, lst = sys.argv[1], sys.argv[2]
    env = K.Env(st, lst)
    blind = {h: env.fit(None, h) for h in K.HOURS}
    plain, plain_dd = env.plain.sum(), K.mdd(env.plain)
    rows = []
    for m in (0.25, 0.5):
        pnl, info = K.run_rule(env, blind, m, "family", "swap")
        counts = {(k, h): (ns, nd) for k, h, ns, nd in info["log"] if ns or nd}
        res = dict(set=st, list=lst, m=m, plain=plain, gross=pnl.sum(), gain=pnl.sum() - plain, dd=K.mdd(pnl),
                   plain_dd=plain_dd, swaps=info["swaps"], win_pct=100 * (pnl > 0).mean(), plain_win=100 * (env.plain > 0).mean())
        for breadth in ("family", "free"):
            rng = np.random.default_rng(81)
            tot = np.array([K.run_rule(env, blind, m, breadth, "swap", rng=rng, counts=counts)[0].sum() for _ in range(K.N_RUNS)])
            res[f"rand_{breadth}_p50"] = float(np.percentile(tot, 50))
            res[f"rand_{breadth}_p90"] = float(np.percentile(tot, 90))
            res[f"rand_{breadth}_max"] = float(tot.max())
            res[f"beats_rand_{breadth}_pct"] = float(100 * (tot < pnl.sum()).mean())
        # half-year stability: see ck_halves.py (this block had a precedence bug in its H2 mask)
        rows.append(res)
    pd.DataFrame(rows).to_csv(K.OUT / f"blind_{st}_{lst}.csv", index=False)
    print(pd.DataFrame(rows).round(0).to_string(index=False))


if __name__ == "__main__":
    main()
