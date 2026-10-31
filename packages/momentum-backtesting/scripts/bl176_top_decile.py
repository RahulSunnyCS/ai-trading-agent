"""BL-176 Stage 3, step 1: the configs to blend, one id file per results folder.

Registered in backlog/BL-176-momentum-search-on-f6-ranking.md (Phase 0, Stage 3): every config in
the top decile of each drawdown basket, by the rank measure the search recorded per run
(`search.rank_measures`, pre-tax, the run's own sampled Friday), over Stages 1 and 2 pooled across
the arms of one tag ranking, is re-scored on all its Fridays (`mbt search score --ids`) and judged
as the all-Fridays blend. This script only chooses the ids; it runs nothing.

Owner override, 2026-10-31 (BL-176 Log): a config that rebalances every 2 or 4 weeks enters from
the top 20% of its basket, a weekly one from the top 10%. A non-weekly config's Stage 1 figure is
one sampled Friday, so a config good on average but sampled on its worst Friday would otherwise
miss the blend; the ranking itself still reads only the blend.

A tag ranking is a list of results folders (curated: A_curated, B and their Stage 2 folders;
extended: A_extended, B, C1 and theirs). The decile is taken over the ranking's pooled runs per
basket; the chosen ids are then written back per folder, since `mbt search score` scores one
folder against its own space file.

    uv run python scripts/bl176_top_decile.py --name curated --out data/search/round8_stage3 \
        data/search/round8_A_curated data/search/round8_B [data/search/round8_A_curated_focus ...]
"""

from __future__ import annotations

import argparse
import json
import math
from pathlib import Path
from typing import Any

from momentum_backtesting import criteria

#: The decile, read from the committed criteria file rather than restated (the package rule).
_STAGE3 = json.loads((criteria.SPACES / "bl176_criteria.json").read_text())["stage_3"]
TOP_SHARE = _STAGE3["keys"]["top_share"]
#: The override's entry share for configs rebalancing every 2 or 4 weeks (see the docstring).
NON_WEEKLY_SHARE = 0.2


def entry_share(row: dict[str, Any]) -> float:
    """The share of its basket a run must sit in: wider when its figure is one Friday of several."""
    return NON_WEEKLY_SHARE if row["light"].get("rebalance_every", 1) > 1 else TOP_SHARE


def load_rows(folder: Path) -> list[dict[str, Any]]:
    rows = []
    for path in sorted(Path(folder).glob("results-*.jsonl")):
        for line in path.read_text().splitlines():
            try:
                row = json.loads(line)
            except json.JSONDecodeError:
                continue  # a torn last line from a stopped run
            if "metrics" in row and "rank" in row:
                rows.append(row)
    return rows


def choose(folders: dict[str, list[dict]], baskets: list[str]) -> dict[str, set[str]]:
    """folder -> ids inside their entry share of some basket over every folder's runs pooled."""
    pooled = [(folder, row) for folder, rows in folders.items() for row in rows]
    chosen: dict[str, set[str]] = {folder: set() for folder in folders}
    for basket in baskets:
        members = [(f, r) for f, r in pooled if basket in r["rank"]["baskets"]]
        members.sort(key=lambda fr: (-fr[1]["rank"]["lb_fy_excess"], fr[1]["id"]))
        for place, (folder, row) in enumerate(members):
            if place < math.ceil(entry_share(row) * len(members)):
                chosen[folder].add(row["id"])
    return chosen


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("folders", type=Path, nargs="+", help="The ranking's results folders.")
    parser.add_argument("--name", required=True, help="The tag ranking: curated or extended.")
    parser.add_argument("--out", type=Path, required=True, help="Folder for the id files.")
    args = parser.parse_args(argv)

    folders = {str(f): load_rows(f) for f in args.folders}
    empty = [f for f, rows in folders.items() if not rows]
    if empty:
        print(f"no run carries a rank measure in {empty}: not Stage 1 or 2 results")
        return 2
    chosen = choose(folders, list(criteria.load()["baskets"]))
    args.out.mkdir(parents=True, exist_ok=True)
    for folder, ids in chosen.items():
        path = args.out / f"{args.name}__{Path(folder).name}.ids"
        path.write_text("".join(f"{i}\n" for i in sorted(ids)))
        print(f"{path}: {len(ids)} of {len(folders[folder])} runs")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
