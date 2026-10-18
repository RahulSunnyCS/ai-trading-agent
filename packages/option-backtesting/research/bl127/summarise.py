"""BL-127: merge the generated results into the small committed summary (bl127_selection_2026-10-18.json)."""

from __future__ import annotations

import json

from common import HERE, RESULTS


def load(name: str) -> dict:
    return json.loads((RESULTS / name).read_text())


def main() -> None:
    parity = load("parity.json")
    a = load("stage_a.json")
    for rows in a["table"].values():
        for r in rows:
            r.pop("per_slot_mean", None)
    before, after = load("fingerprint_before.json"), load("fingerprint_after.json")
    out = {
        "item": "BL-127",
        "status": "selection on 2024-10-09..2025-10-08, test 2025-10-09..2026-10-16; gross (no per-order cost in these files)",
        "variants": "N_p<premium><SL>_<HHMM>: Core N_p100 text with only both legs' closest premium and stop-loss percent changed; 16 cells x 25 slots; the 115 % cells of 80 and 100 are Core's own files",
        "parity": {
            k: {"days": v["days"], "equal_days": v["equal_days"]} for k, v in parity.items()
        },
        "stage_a": a,
        "stage_b": load("stage_b.json"),
        "stage_c": load("stage_c.json"),
        "fingerprint_before_equals_after": before == after,
        "fingerprint_before": before,
        "fingerprint_covers": "rotation/ (journal md5, 298 result files, file count, bytes, newest file and mtime) and the mtimes of the top-level entries of TRADING_DATA_ROOT plus the catalog size; not the Parquet lake contents",
    }
    (HERE / "bl127_selection_2026-10-18.json").write_text(json.dumps(out, indent=1) + "\n")
    print("written", len(json.dumps(out)), "bytes")


if __name__ == "__main__":
    main()
