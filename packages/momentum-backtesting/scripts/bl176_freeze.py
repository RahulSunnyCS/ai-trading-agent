"""BL-176 Stage 3: freeze each tag ranking's ensemble to its own BL-176 record (write-once).

Registered in backlog/BL-176-momentum-search-on-f6-ranking.md (Phase 0, Stage 3: "one pick, one
ensemble, or none per basket per tag set, frozen with commit and data snapshot"). BL-010's
`bl010_phase6_frozen.json` is never written: `mbt search ensemble --freeze` refuses a pick pooled
with `--also`, so the pooled pick is frozen here instead, in the same shape (`configs` with their
`rebalance_offset` slot, `fixed_settings`), plus each config's arm and space, so
`phase6.favourite_request`-style code can rebuild it. Reads stored results only; runs nothing.

    uv run python scripts/bl176_freeze.py --ranking curated --ensemble-commit cc077c67 \\
        --finalists-commit fe9e1e9d --lookahead <round8_logs/lookahead.log>
"""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path

import pandas as pd

from momentum_backtesting import search

PKG = Path(__file__).resolve().parents[1]
SPACES = PKG / "search_spaces"
DATA = Path(__import__("os").environ.get("MOMENTUM_DATA_DIR", PKG / "data")) / "search"
STAGE3 = DATA / "round8_stage3"
ARMS = {
    "curated": ["round8_A_curated", "round8_B", "round8_A_curated_focus"],
    "extended": [
        "round8_A_extended",
        "round8_B",
        "round8_C1",
        "round8_A_extended_focus",
        "round8_C1_focus",
    ],
}
#: Owner override 2026-11-01 (item Log): Stage 3 is scored at Rs 2 lakh a sleeve, Rs 10,000 ceiling.
MONEY = {"capital": 200_000.0, "max_stock_price": 10_000.0}


def arm_of(ranking: str, cid: str) -> str:
    for arm in ARMS[ranking]:
        for path in sorted((DATA / arm).glob("results-*.jsonl")):
            if f'"{cid}"' in path.read_text():
                return arm
    raise ValueError(f"{cid}: not in any {ranking} arm's results")


def digest(folder: Path) -> str:
    h = hashlib.sha256()
    for path in sorted(folder.glob("curves-*.parquet")):
        h.update(path.name.encode())
        h.update(path.read_bytes())
    return h.hexdigest()


def lookahead_lines(log: Path, labels: list[str]) -> dict[str, list[str]]:
    """label -> the audit's verdict lines ("<cut> <label>__to_<cut>: same|differs ...")."""
    found: dict[str, list[str]] = {label: [] for label in labels}
    for line in log.read_text().splitlines():
        for label in labels:
            if f" {label}__to_" in line and (": same" in line or ": differ" in line.lower()):
                found[label].append(line.strip())
    return found


def freeze(ranking: str, ensemble_commit: str, finalists_commit: str, lookahead: Path) -> Path:
    path = SPACES / f"bl176_frozen_{ranking}.json"
    if path.exists():
        raise SystemExit(f"{path.name} exists: a frozen record is written once")
    report = json.loads((STAGE3 / "phase6" / ranking / "ensemble.json").read_text())
    if not report["committed"]["passes"]:
        raise SystemExit(f"{ranking}: the ensemble walk-forward did not pass; report, not freeze")
    finalists = json.loads((SPACES / f"bl176_finalists_{ranking}.json").read_text())
    prefix = "cur" if ranking == "curated" else "ext"
    configs, audit = [], {}
    labels = [f"{prefix}_{cfg['id']}" for cfg in report["pick"]["configs"]]
    lines = lookahead_lines(lookahead, labels)
    for cfg, label in zip(report["pick"]["configs"], labels, strict=True):
        arm = arm_of(ranking, cfg["id"])
        space = search.load_space(SPACES / f"{arm}.toml")
        configs.append(
            {k: cfg[k] for k in ("id", "holdings", "rebalance_every", "heavy", "light")}
            | {
                "rebalance_offset": cfg["phase_slot"],
                "arm": arm,
                "space": f"search_spaces/{arm}.toml",
                "fixed_settings": {**space.fixed, **MONEY},
            }
        )
        found = lines[label]
        audit[cfg["id"]] = {
            "lines": found,
            "identical": len(found) == 3 and all(": same" in x for x in found),
        }
    scored = [STAGE3 / "scored" / f"{ranking}__{arm}" for arm in ARMS[ranking]]
    record = {
        "frozen": pd.Timestamp.now(tz="Asia/Kolkata").isoformat(timespec="seconds"),
        "item": "backlog/BL-176-momentum-search-on-f6-ranking.md",
        "ranking": ranking,
        "rule": "search_spaces/bl010_criteria_addendum_4.json (via bl176_criteria.json)",
        "ensemble_code_commit": ensemble_commit,
        "finalists_code_commit": finalists_commit,
        "data_snapshot": search.data_snapshot(),
        "scored_curves_sha256": {p.name: digest(p) for p in scored},
        "basket": report["basket"],
        "money": "Rs 2 lakh a sleeve, Rs 10,000 price ceiling (owner override 2026-11-01)",
        "capital": "equal per config, reset to equal at the last week before each 1 April",
        "phase_meaning": "rebalance_offset: trade on Fridays whose week number since "
        "engine.CADENCE_EPOCH (2016-01-01) is the offset mod rebalance_every",
        "configs": configs,
        "expected_pre_tax": {
            "ensemble_cagr": report["pick"].get("ensemble_cagr"),
            "ensemble_max_drawdown": report["pick"].get("ensemble_mdd"),
            "walk_forward_cagr_fy2020_fy2026": report["committed"]["ensemble"],
            "group_median_walk_forward": report["committed"]["median"],
            "mom30_walk_forward": report["committed"]["bench"],
        },
        "finalist_verdict": finalists["verdict"],
        "finalist_record": f"search_spaces/bl176_finalists_{ranking}.json",
        "realistic": finalists["ensemble"].get("T_real") or finalists["ensemble"].get("T0_after_tax"),
        "lookahead": {
            "method": "mbt audit lookahead (search runner, database truncated at each cut)",
            "cuts": ["2019-06-28", "2021-06-25", "2024-03-28"],
            "per_config": audit,
            "all_identical": all(a["identical"] for a in audit.values()),
        },
    }
    path.write_text(json.dumps(record, indent=2, default=float) + "\n")
    return path


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--ranking", required=True, choices=sorted(ARMS))
    p.add_argument("--ensemble-commit", required=True)
    p.add_argument("--finalists-commit", required=True)
    p.add_argument("--lookahead", required=True, type=Path)
    a = p.parse_args()
    print(freeze(a.ranking, a.ensemble_commit, a.finalists_commit, a.lookahead))


if __name__ == "__main__":
    main()
