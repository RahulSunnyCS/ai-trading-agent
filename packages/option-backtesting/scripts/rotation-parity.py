"""Check the journal's ranking (rotation/score.py) against research/bl057/rotate.py.

    uv run --with pandas --with numpy --with duckdb python scripts/rotation-parity.py

For each list, every selection day of the research run (the main year, history from 2025-09-01) is
re-scored from the rotation store restricted to the same history, and its core / Buy picks are
compared with the `daily_picks_*.csv` rotate.py wrote. Exits 1 on any difference.
"""

from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import pandas as pd

HERE = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(HERE / "src"))
from option_backtesting.rotation import store  # noqa: E402
from option_backtesting.rotation.lists import LISTS  # noqa: E402
from option_backtesting.rotation.score import (  # noqa: E402
    composite,
    dte_matrix,
    family_index,
    select,
)
from option_backtesting.rotation.variants import variant_names  # noqa: E402

B = HERE / "research" / "bl057" / "daily_picks_min3_core6_buy2L2_whole_day"
FILES = {
    "A": f"{B}_w5_34_33_23_0_5_fitlb5x30_21x25_63x25_126x20_fband.csv",
    "B": f"{B}_w0_36_35_24_0_5_fitlb5x30_21x25_63x25_126x20_fband.csv",
    "C": f"{B}_w15_30_30_20_0_5_fitlb5x30_21x25_63x25_126x20_fband.csv",
    "REF": f"{B}.csv",
}
FROM = pd.Timestamp("2025-09-01")


def main() -> None:
    names = variant_names()
    m = store.load_matrix(names)
    attrs = store.read_days()
    keep = [i for i, d in enumerate(m.days) if d in attrs and pd.Timestamp(d) >= FROM]
    days = [m.days[i] for i in keep]
    Pv = m.values[keep]
    wd = np.array([attrs[d]["weekday"] for d in days])
    vb = np.array([attrs[d]["vix_band"] for d in days])
    dmat = dte_matrix(
        np.array([attrs[d]["dte_n"] for d in days]),
        np.array([attrs[d]["dte_s"] for d in days]),
        names,
    )
    cols = names
    fam = family_index(cols)
    index = {d: i for i, d in enumerate(days)}
    bad_total = 0
    for key, file in FILES.items():
        ref = pd.read_csv(file, parse_dates=["day"]).set_index("day")
        bad = 0
        for day, row in ref.iterrows():
            i = index[day.date()]
            comp = composite(
                Pv[: i + 1] * np.r_[np.ones(i), 0][:, None],
                wd[: i + 1],
                vb[: i + 1],
                dmat[: i + 1],
                cols,
                LISTS[key],
                fam,
            )
            p = select(comp, cols)
            want_core = set(row.core_A.split(","))
            want_buy = set(row.buy.split(",")) if isinstance(row.buy, str) else set()
            if set(p.core) != want_core or set(p.buy) != want_buy:
                bad += 1
                if bad <= 3:
                    print(
                        f"  {key} {day.date()}: journal core {sorted(p.core)} buy {p.buy} | "
                        f"rotate core {sorted(want_core)} buy {sorted(want_buy)}"
                    )
        print(
            f"{key}: {len(ref) - bad} of {len(ref)} selection days identical "
            f"({len(ref)} days from {ref.index[0].date()})"
        )
        bad_total += bad
    print("PARITY OK" if bad_total == 0 else f"PARITY FAILED: {bad_total} differing days")
    sys.exit(1 if bad_total else 0)


if __name__ == "__main__":
    main()
