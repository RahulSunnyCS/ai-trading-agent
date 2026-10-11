"""One-off: seed TRADING_DATA_ROOT/rotation from the research results (BL-058).

    uv run --with pandas python scripts/rotation-backfill.py

Copies each variant's per-day results (research/bl054|056|059|060|061|062/results, and BL-080's
Dir ITM1 series, 2024-10-09 onward) into rotation/results/, and writes rotation/days.csv with each
day's weekday, VIX band and days-to-expiry labels as the research used them
(`research/bl056/analyse.py::day_features`), keeping only the days both indices have. Existing
files are not overwritten.
"""

from __future__ import annotations

import shutil
import sys
from pathlib import Path

import pandas as pd

HERE = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(HERE / "research" / "common"))
sys.path.insert(0, str(HERE / "research" / "bl056"))
sys.path.insert(0, str(HERE / "src"))
import analyse as A  # noqa: E402
import varlib  # noqa: E402

from option_backtesting.rotation import store  # noqa: E402
from option_backtesting.rotation.variants import variant_names  # noqa: E402


def main() -> None:
    names = variant_names()
    out = store.results_dir()
    out.mkdir(parents=True, exist_ok=True)
    copied = 0
    for n in names:
        dst = out / f"{n}.csv"
        if dst.exists():
            continue
        if "_ditm1_" in n:  # BL-080's series start in 2022; the journal's history starts 2024-10-09
            src = pd.read_csv(HERE / "research" / "bl080" / "results" / f"{n}.csv")
            src[src.day >= "2024-10-09"].to_csv(dst, index=False)
        else:
            shutil.copyfile(varlib.variant_file(n, "results"), dst)
        copied += 1
    print(f"{copied} result files copied ({len(names)} variants) -> {out}")
    # days both indices have, with the research's labels
    frames = {}
    for u in ("NIFTY", "SENSEX"):
        pfx = u[0] + "_"
        idx = pd.read_csv(out / f"{pfx}wide_0917.csv", parse_dates=["day"]).day
        frames[u] = A.day_features(u, pd.DatetimeIndex(idx))
    common = frames["NIFTY"].index.intersection(frames["SENSEX"].index)
    rows = []
    for d in common:
        n, s = frames["NIFTY"].loc[d], frames["SENSEX"].loc[d]
        rows.append(
            dict(
                day=d.date().isoformat(),
                weekday=n.weekday,
                vix_open=n.vix_open,
                vix_band=n.vix_band,
                dte_n=n.dte_label,
                dte_s=s.dte_label,
            )
        )
    path = store.days_path()
    if path.exists():
        print(f"{path} exists; not overwritten")
        return
    pd.DataFrame(rows, columns=store.DAY_COLUMNS).to_csv(path, index=False)
    print(f"{len(rows)} days -> {path}")


if __name__ == "__main__":
    main()
