"""BL-126: merge the generated results into the small committed summary (bl126_poc_2026-10-18.json)."""

from __future__ import annotations

import json

from common import HERE, RESULTS


def load(name: str) -> dict:
    return json.loads((RESULTS / name).read_text())


def main() -> None:
    parity = load("parity.json")
    out = {
        "item": "BL-126",
        "status": "exploratory, in-sample, no hold-out (every window was seen in the owner's BL-104 sweep summary)",
        "variants": "N_p10075_<HHMM> (X1: premium 100, SL 75) and N_p12060_<HHMM> (X2: premium 120, SL 60), 25 slots each; Core's N_p100 text with only the two legs' premium and SL percent changed",
        "costs": "same as the live store: net = gross - engine costs; Core's files set no per-order cost, so net equals gross",
        "parity": {
            "variants": list(parity),
            "days_each": {k: v["days"] for k, v in parity.items()},
            "equal_days": {k: v["equal_days"] for k, v in parity.items()},
        },
        "q1": load("q1.json"),
        "q2": load("q2.json"),
        "live_store_unchanged": load("fingerprint_before.json") == load("fingerprint_after.json"),
    }
    (HERE / "bl126_poc_2026-10-18.json").write_text(json.dumps(out, indent=1) + "\n")
    print("written", len(json.dumps(out)), "bytes")


if __name__ == "__main__":
    main()
