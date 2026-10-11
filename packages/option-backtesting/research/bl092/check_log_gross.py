"""BL-092 Phase 1 check: with no portfolio stop, the replayed book equals the Daily log's gross.

For each reconstructed (research-history) day in the window, every list's picks are replayed with
`book_day(..., stop=None)` and compared with `list_block`'s gross for the same list. Also prints
what a ₹10,000 stop does on those days. Needs the data root mounted; not part of the product.

    uv run python research/bl092/check_log_gross.py --from 2026-09-01 --to 2026-09-30
"""

from __future__ import annotations

import argparse
import sys
from datetime import date

from option_backtesting.fyers.daily import data_dir
from option_backtesting.rotation import daylog
from option_backtesting.rotation.portfolio import PortfolioStopError, book_day


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--from", dest="start", required=True)
    ap.add_argument("--to", dest="end", required=True)
    ap.add_argument("--stop", type=float, default=10000.0)
    args = ap.parse_args()
    root = data_dir()
    log = daylog.build_log(
        root, date.fromisoformat(args.start), date.fromisoformat(args.end), "reconstructed"
    )
    checked = bad = fired = 0
    for row in log["rows"]:
        for key, block in row["lists"].items():
            if not block.get("scored"):
                continue
            picks = [(p["name"], block["lots"] // len(block["picks"])) for p in block["picks"]]
            try:
                off = book_day(root, date.fromisoformat(row["day"]), picks, None)
            except PortfolioStopError as error:
                print(f"{row['day']} {key}: {error}")
                continue
            checked += 1
            same = abs(off.gross_with - block["gross"]) < 0.01
            bad += not same
            on = book_day(root, date.fromisoformat(row["day"]), picks, args.stop)
            fired += on.stop_minute is not None
            flag = "" if same else "  MISMATCH"
            if not same or on.stop_minute is not None:
                print(
                    f"{row['day']} {key:>3}: log {block['gross']:>10,.0f}  replay {off.gross_with:>10,.0f}"
                    f"  with ₹{args.stop:,.0f}: {on.gross_with:>10,.0f} at {on.stop_label} ({on.fired_by}){flag}"
                )
    print(f"{checked} list-days replayed, {bad} differ from the log, the stop fired on {fired}")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
