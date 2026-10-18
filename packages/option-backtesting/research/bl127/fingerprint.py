"""Fingerprint of the live data root (read-only). Covers: the rotation store (journal md5, file
counts, total bytes, newest file and its mtime) and the top-level entries of TRADING_DATA_ROOT
(name -> mtime) with the catalog size. It does not walk the Parquet lake (about 110k files).

    uv run python research/bl127/fingerprint.py <out.json>
"""

from __future__ import annotations

import hashlib
import json
import sys
from pathlib import Path

from option_backtesting.fyers.daily import data_dir


def fingerprint() -> dict:
    base = data_dir()
    root = base / "rotation"
    files = [p for p in root.rglob("*") if p.is_file()]
    newest = max(files, key=lambda p: p.stat().st_mtime_ns)
    return {
        "journal_md5": hashlib.md5((root / "journal.jsonl").read_bytes()).hexdigest(),
        "results_files": len(list((root / "results").glob("*.csv"))),
        "all_files": len(files),
        "total_bytes": sum(p.stat().st_size for p in files),
        "newest_file": str(newest.relative_to(root)),
        "newest_mtime_ns": newest.stat().st_mtime_ns,
        "root_entries_mtime_ns": {
            p.name: p.stat().st_mtime_ns
            for p in sorted(base.iterdir())
            if not p.name.startswith(".")
        },
        "catalog_bytes": (base / "catalog.duckdb").stat().st_size,
    }


if __name__ == "__main__":
    out = fingerprint()
    print(json.dumps(out, indent=1))
    if len(sys.argv) > 1:
        Path(sys.argv[1]).write_text(json.dumps(out, indent=1))
