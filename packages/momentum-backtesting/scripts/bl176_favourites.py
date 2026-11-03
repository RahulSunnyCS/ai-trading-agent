"""BL-176 Stage 3: locate the followed strategy and the favourites in the fresh ranking.

Registered in backlog/BL-176-momentum-search-on-f6-ranking.md (Phase 0, Stage 3): the followed
strategy, Five Sectors Rank Sum and the other favourites are ordinary points in the space; the
verdict says where their all-Fridays blend lands: its percentile in the space by the lower-bound
rank, its baskets, and the still-holds lines. Two passes, neither of which runs a backtest:

  1. `prepare` turns each saved favourite group into a search record (heavy + light, as a Stage
     1 run would hold), so the ordinary scorer runs it on round 8's realism, all Fridays:
     `mbt search score <out> --space round8_A_curated.toml --per-sleeve
      --set capital=200000 --set max_stock_price=10000 [--tags extended] --dest <scored>`
  2. `report` places each scored favourite among one tag ranking's Stage 3 blends.

The favourites are read from the Momentum API on this machine (`mbt serve`, loopback) or from a
saved copy of `GET /api/favorite-strategies` (`--from-json`).

    uv run python scripts/bl176_favourites.py prepare --out data/search/round8_favourites
    uv run python scripts/bl176_favourites.py report --favourites <scored> --name curated \\
        --pool data/search/round8_A_curated=<stage3 scored> [--pool ...] --out <report folder>
"""

from __future__ import annotations

import argparse
import json
import math
import urllib.request
from pathlib import Path
from typing import Any

from momentum_backtesting import method, search
from momentum_backtesting.phase6 import REQUEST_FIELDS

API = "http://127.0.0.1:8765/api/favorite-strategies"
#: Request fields that carry no setting the search varies: the dataset's shape (the search runs
#: Broad, category mode, behind the gate), and fields a Broad run with these values never reads.
SHAPE = {
    "dataset": "broad",
    "universe": None,
    "end": None,
    "portfolio": "buffer",
    "rebalance": "weekly",
    "broad_category_mode": "on",
    "broad_category_tags": None,  # the tag ranking is chosen when scoring (--tags)
    "broad_universe": "turnover_rank",
    "broad_liquidity_filter": True,
    "cost_pct": None,  # read only by the flat cost model
    "momentum_sizing_window": None,  # read only with momentum sizing on
    "momentum_sizing_floor": None,
    "split_fridays": False,  # a group's member is one Friday
}
FILL_OF = {(delay, execution): name for name, (delay, execution) in search.FILLS.items()}
#: Round 8 settings a favourite never set (they did not exist), at the values it ran with.
ROUND8_DEFAULTS = {"voladj_lookbacks": False, "voladj_skip": "long", "top_sector_weight": 1.0}


def weight_scheme(lookbacks: list[int], weights: list[float] | None) -> str | None:
    for scheme in ("equal", "recent", "long"):
        made = search.weights_for(scheme, len(lookbacks))
        if (made is None and (weights is None or len(set(weights)) == 1)) or (
            made is not None and weights is not None and list(made) == list(weights)
        ):
            return scheme
    return None


def search_record(config: dict[str, Any], fixed: dict[str, Any]) -> tuple[dict, dict, list[str]]:
    """(heavy, light, notes) for one favourite member's request. Refuses a field the search
    cannot express; a realism value that differs from round 8's is replaced and noted."""
    by_field = {field: key for key, field in REQUEST_FIELDS.items()}
    unknown = sorted(set(config) - set(by_field) - set(SHAPE) - {"execution"})
    if unknown:
        raise ValueError(f"no search setting for {unknown}")
    for field, want in SHAPE.items():
        if want is not None and field in config and config[field] != want:
            raise ValueError(f"{field} is {config[field]!r}; the search runs {want!r}")
    params = {by_field[f]: v for f, v in config.items() if f in by_field}
    fill = FILL_OF.get((params.pop("signal_delay", 1), config.get("execution", "fri_close")))
    if fill is None:
        raise ValueError("its signal delay and fill have no search form")
    if params["min_ranked"] is True:
        params["min_ranked"] = 1
    scheme = weight_scheme(params["lookbacks"], params.pop("weight_scheme"))
    if scheme is None:
        raise ValueError(f"weights {config.get('weights')} are not a search weight scheme")
    params["weight_scheme"] = scheme
    notes = [
        f"{key} {params[key]!r} -> round 8's {fixed[key]!r}"
        for key in sorted(params)
        if key in fixed and params[key] != fixed[key]
    ]
    heavy = {k: v for k, v in params.items() if k in search.HEAVY_KEYS}
    heavy = {**{k: v for k, v in fixed.items() if k in search.HEAVY_KEYS}, **heavy}
    heavy.update({k: v for k, v in ROUND8_DEFAULTS.items() if k in search.HEAVY_KEYS})
    light = {k: v for k, v in params.items() if k not in search.HEAVY_KEYS and k not in fixed}
    light.update({k: v for k, v in ROUND8_DEFAULTS.items() if k not in search.HEAVY_KEYS})
    light["fill"] = fill
    light["rebalance_offset"] = 0  # scored on every Friday; the sampled one is not used
    return heavy, light, notes


def prepare(favourites: list[dict], space: Path, out: Path) -> list[dict]:
    fixed = search.load_space(space).fixed
    out.mkdir(parents=True, exist_ok=True)
    rows, index = [], []
    for fav in favourites:
        if not fav.get("status") or not fav.get("members"):
            continue
        entry = {"name": fav["name"], "status": fav["status"], "group": fav["id"]}
        try:
            heavy, light, notes = search_record(fav["members"][0]["config"], fixed)
        except ValueError as error:
            index.append({**entry, "skipped": str(error)})
            continue
        rid = "fav-" + fav["id"][:12]
        rows.append({"id": rid, "arm": "A", "heavy": heavy, "light": light, "metrics": {}})
        index.append({**entry, "id": rid, "notes": notes})
    (out / "results-favourites.jsonl").write_text("".join(json.dumps(r) + "\n" for r in rows))
    (out / "favourites.json").write_text(json.dumps(index, indent=2) + "\n")
    return index


def place(lb: float, pool: list[float]) -> float:
    """The share of the pool strictly below `lb` (0 = bottom, 1 = top)."""
    return sum(x < lb for x in pool) / len(pool) if pool else math.nan


def report(favourites: Path, index: list[dict], pool: list[tuple[Path, Path]]) -> list[dict]:
    """Each favourite's blend against the pooled Stage 3 blends of one tag ranking."""
    from momentum_backtesting import criteria

    fav_scores, _ = method.load_scores(favourites)
    scores, _, _ = method.load_pooled(pool)
    lbs = {b: [] for b in criteria.load()["baskets"]}
    every = []
    for _, row in scores.iterrows():
        rank = row.get("rank")
        if isinstance(rank, dict):
            every.append(rank["lb_fy_excess"])
            for basket in rank["baskets"]:
                lbs[basket].append(rank["lb_fy_excess"])
    out = []
    for entry in index:
        if "id" not in entry or entry["id"] not in fav_scores.index:
            out.append({**entry, "located": False})
            continue
        row = fav_scores.loc[entry["id"]]
        rank = row.get("rank") if isinstance(row.get("rank"), dict) else None
        if rank is None:
            out.append({**entry, "located": False, "error": row.get("error")})
            continue
        lb = rank["lb_fy_excess"]
        share = place(lb, every)
        out.append(
            {
                **entry,
                "located": True,
                "lb_fy_excess": lb,
                "worst_fy_excess": min(rank["fy_excess"].values()),
                "cagr": float(row["cagr"]),
                "mdd": float(row["mdd"]),
                "baskets": rank["baskets"],
                "percentile_in_space": share,
                "percentile_in_basket": {b: place(lb, lbs[b]) for b in rank["baskets"]},
                "top_half": share >= 0.5,  # the followed strategy's still-holds line, pre-tax part
                "top_decile": share >= 0.9,  # a favourite keeps its place
                "inside_hard_ceiling": float(row["mdd"]) >= -0.40,
            }
        )
    return out


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = parser.add_subparsers(dest="cmd", required=True)
    prep = sub.add_parser("prepare")
    prep.add_argument("--out", type=Path, required=True)
    prep.add_argument("--from-json", type=Path, help="A saved /api/favorite-strategies answer.")
    prep.add_argument(
        "--space",
        type=Path,
        default=Path(__file__).resolve().parent.parent / "search_spaces" / "round8_A_curated.toml",
    )
    rep = sub.add_parser("report")
    rep.add_argument("--favourites", type=Path, required=True, help="The favourites' scoring.")
    rep.add_argument("--index", type=Path, help="favourites.json (default: beside the results).")
    rep.add_argument("--name", required=True, help="The tag ranking: curated or extended.")
    rep.add_argument("--pool", action="append", required=True, help="RESULTS=SCORED, repeatable.")
    rep.add_argument("--out", type=Path, required=True)
    args = parser.parse_args(argv)

    if args.cmd == "prepare":
        if args.from_json:
            favourites = json.loads(args.from_json.read_text())
        else:
            with urllib.request.urlopen(API, timeout=30) as reply:  # noqa: S310 - loopback only
                favourites = json.load(reply)
        for entry in prepare(favourites, args.space, args.out):
            line = entry.get("skipped") or "; ".join(entry["notes"]) or "as saved"
            print(f"{entry['name']}: {line}")
        return 0
    pairs = []
    for item in args.pool:
        results, sep, scored = item.partition("=")
        if not sep:
            parser.error(f"--pool needs RESULTS=SCORED, got {item!r}")
        pairs.append((Path(results), Path(scored)))
    index_path = args.index or args.favourites.parent / "favourites.json"
    rows = report(args.favourites, json.loads(index_path.read_text()), pairs)
    args.out.mkdir(parents=True, exist_ok=True)
    (args.out / f"favourites_{args.name}.json").write_text(json.dumps(rows, indent=2) + "\n")
    for r in rows:
        if r.get("located"):
            print(
                f"{r['name']}: lb {r['lb_fy_excess']:+.1%}, {r['percentile_in_space']:.0%} "
                f"of the space, CAGR {r['cagr']:.1%}, worst fall {r['mdd']:.1%}, "
                f"baskets {r['baskets'] or 'none'}"
            )
        else:
            print(f"{r['name']}: not located ({r.get('skipped') or r.get('error') or 'unscored'})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
