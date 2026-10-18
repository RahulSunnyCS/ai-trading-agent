"""Fingerprint of the live rotation store (read-only): journal md5, file counts, newest mtime."""

from __future__ import annotations

import hashlib
import json
import sys
from pathlib import Path

from option_backtesting.fyers.daily import data_dir


def fingerprint() -> dict:
    root = data_dir() / "rotation"
    files = [p for p in root.rglob("*") if p.is_file()]
    newest = max(files, key=lambda p: p.stat().st_mtime_ns)
    return {
        "journal_md5": hashlib.md5((root / "journal.jsonl").read_bytes()).hexdigest(),
        "results_files": len(list((root / "results").glob("*.csv"))),
        "all_files": len(files),
        "total_bytes": sum(p.stat().st_size for p in files),
        "newest_file": str(newest.relative_to(root)),
        "newest_mtime_ns": newest.stat().st_mtime_ns,
    }


if __name__ == "__main__":
    out = fingerprint()
    print(json.dumps(out, indent=1))
    if len(sys.argv) > 1:
        Path(sys.argv[1]).write_text(json.dumps(out, indent=1))
