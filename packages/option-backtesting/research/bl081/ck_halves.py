"""BL-081 block 3: the state-blind family-swap gain by half-year (fixes ck_blind.py's halves column, whose
mask had an operator-precedence bug in the H2 entries; the gains and controls there are unaffected).

    uv run --with pandas --with numpy --with duckdb python research/bl081/ck_halves.py <explore|confirm> <A|B|C|REF>
"""

from __future__ import annotations

import sys
from pathlib import Path

import pandas as pd

sys.path.insert(0, str(Path(__file__).parent))
import ck_rule as K  # noqa: E402


def main() -> None:
    st, lst = sys.argv[1], sys.argv[2]
    env = K.Env(st, lst)
    blind = {h: env.fit(None, h) for h in K.HOURS}
    days = pd.to_datetime([env.days[i] for i in env.sel])
    key = [f"{d.year}H{1 if d.month <= 6 else 2}" for d in days]
    out = {}
    for m in (0.25, 0.5):
        pnl, _ = K.run_rule(env, blind, m, "family", "swap")
        g = pd.Series(pnl - env.plain, index=key).groupby(level=0).sum()
        out[m] = g
    t = pd.DataFrame(out).round(0)
    t.columns = [f"m={c}" for c in t.columns]
    t.insert(0, "list", lst)
    t.insert(0, "set", st)
    n = pd.Series(1, index=key).groupby(level=0).sum()
    t["days"] = n
    print(t.to_string())


if __name__ == "__main__":
    main()
