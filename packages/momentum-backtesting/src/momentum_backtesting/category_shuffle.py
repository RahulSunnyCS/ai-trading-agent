"""Do the categories carry information, or would any grouping of the same stocks do?
(BL-010 Phase 3: the label-shuffle placebo.)

The category tags were written in 2026 from themes that had already done well (finding F2).
One way to see how much of a config's result is the tags themselves: keep everything else, and
deal the stocks out to the categories at random. Each shuffled file has the same categories,
the same number of stocks in each and the same number of tags per stock; only who sits where
changes. A config whose real result is not clearly above what shuffled tags give is not being
helped by the categories.
"""

from __future__ import annotations

import csv
import json
import random
import shutil
import tempfile
import time
from pathlib import Path

from . import bias, search
from .categories.broad import STOCK_GROUPS_FILENAME
from .engine import IDLE


def shuffled_groups(source: Path, target: Path, seed: int) -> None:
    """`source` (stock_groups.csv) with its symbol column dealt out again at random. A symbol
    is never dealt into the same category twice, so every category keeps its size."""
    with source.open(newline="") as handle:
        reader = csv.DictReader(handle)
        fields, rows = reader.fieldnames, list(reader)
    rng = random.Random(seed)
    symbols = [row["symbol"] for row in rows]
    rng.shuffle(symbols)
    key = [(row["parent_group"], row["subgroup"]) for row in rows]
    for _ in range(50):  # swap away the few places a category got the same symbol twice
        seen: set[tuple] = set()
        clashes = []
        for i, symbol in enumerate(symbols):
            if (key[i], symbol) in seen:
                clashes.append(i)
            seen.add((key[i], symbol))
        if not clashes:
            break
        for i in clashes:
            j = rng.randrange(len(symbols))
            symbols[i], symbols[j] = symbols[j], symbols[i]
    with target.open("w", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fields)
        writer.writeheader()
        for row, symbol in zip(rows, symbols, strict=True):
            writer.writerow({**row, "symbol": symbol})


def run(
    space_path: Path,
    results_dir: Path,
    picks: dict[str, str],
    out: Path,
    *,
    shuffles: int = 100,
    echo=print,
) -> None:
    """One line per (config, shuffle) in `out`; seed -1 is the real tag file. Resumable."""
    space = search.load_space(space_path)
    records = bias.load_records(results_dir, set(picks.values()))
    runner = bias.Runner(space)
    real_dir = Path(runner.api.CATEGORIES_CURATED_DIR)
    done = set()
    if out.exists():
        done = {(r["id"], r["seed"]) for r in map(json.loads, out.read_text().splitlines())}
    out.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="mbt-shuffle-") as tmp:
        for label, run_id in picks.items():
            rec = records[run_id]
            base = runner.base(rec["heavy"])
            locks = None
            for seed in range(-1, shuffles):
                if (run_id, seed) in done:
                    continue
                started = time.time()
                folder = real_dir
                if seed >= 0:
                    folder = Path(tmp) / f"seed{seed}"
                    if not folder.exists():
                        shutil.copytree(real_dir, folder)
                        shuffled_groups(
                            real_dir / STOCK_GROUPS_FILENAME, folder / STOCK_GROUPS_FILENAME, seed
                        )
                outcome, ranking = runner.run(
                    base, rec["heavy"], rec["light"], locks=locks, curated_dir=folder
                )
                locks = locks or runner.locks(ranking)
                metrics = search.run_metrics(outcome.result, IDLE)
                row = {"label": label, "id": run_id, "seed": seed, "cagr": metrics["cagr"]}
                row["mdd"] = metrics["mdd"]
                with out.open("a") as sink:
                    sink.write(json.dumps(row) + "\n")
                if seed < 0 or seed % 20 == 19:
                    took = time.time() - started
                    echo(f"{label} seed {seed}: {metrics['cagr']:.4f} ({took:.1f} s)")


def summary(out: Path) -> dict[str, dict]:
    """label -> the real result against the spread of shuffled ones."""
    rows: dict[str, dict] = {}
    for row in map(json.loads, out.read_text().splitlines()):
        entry = rows.setdefault(row["label"], {"real": None, "shuffled": []})
        if row["seed"] < 0:
            entry["real"] = row["cagr"]
        else:
            entry["shuffled"].append(row["cagr"])
    result = {}
    for label, entry in rows.items():
        dealt = sorted(entry["shuffled"])
        if not dealt or entry["real"] is None:
            continue
        p95 = dealt[min(len(dealt) - 1, int(0.95 * len(dealt)))]
        result[label] = {
            "real": entry["real"],
            "shuffles": len(dealt),
            "shuffled_median": dealt[len(dealt) // 2],
            "shuffled_p95": p95,
            "shuffled_max": dealt[-1],
            "beaten_by": sum(v >= entry["real"] for v in dealt),
            "beats_p95": entry["real"] > p95,
        }
    return result
