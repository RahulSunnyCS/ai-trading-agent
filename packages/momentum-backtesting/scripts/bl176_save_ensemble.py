"""BL-176: save a frozen round 8 ensemble as one followed group on the Saved runs page.

Each frozen config becomes one sleeve (its own `rebalance_offset`, the record's ₹2 lakh) and the
four are grouped (`runs_store.create_group`) under one name and status, as an all-Fridays group
is (`all_fridays.follow`): the weekly run journals each sleeve and combines them by value since
the April reset, which is the ensemble's own rule.

Before anything is saved, every sleeve is run twice: through the API's request path
(`api.sleeve_summary`, what the weekly job and the dashboard run) and through the search's runner
(`bias.Runner`, where every BL-176 figure came from). The equity curves must agree; a sleeve that
does not stops the script. Saving needs the API code that knows round 8's settings, so run
`--apply` only once this code is what `mbt serve` runs (merged and restarted).

    uv run python scripts/bl176_save_ensemble.py \\
        --frozen search_spaces/bl176_frozen_extended.json \\
        --name "Four-Strategy Mix, BSE Tags" --status paper [--apply]
"""

from __future__ import annotations

import argparse
import dataclasses
import json
from pathlib import Path

import pandas as pd

from momentum_backtesting import api, bias, db_read, phase6, runs_store, search

PKG = Path(__file__).resolve().parents[1]
#: Equity curves are compared to this relative tolerance (float noise between the two paths).
TOLERANCE = 1e-9


def sleeve_request(config: dict) -> dict:
    """The API request for one frozen config: its space decides the universe and tag set."""
    space = search.load_space(PKG / config["space"])
    tags = space.fixed.get("category_tags") or (
        "extended" if space.arm in search.EXTENDED_TAG_ARMS else "curated"
    )
    return phase6.favourite_request(
        config["fixed_settings"], config, universe=search.universe_of(space), tags=tags
    )


def search_curve(config: dict) -> pd.Series:
    """The same sleeve through the search's runner, on the record's money."""
    space = search.load_space(PKG / config["space"])
    space = dataclasses.replace(space, fixed={**space.fixed, **config["fixed_settings"]})
    runner = bias.Runner(space)
    light = {k: v for k, v in config["light"].items() if k != "rebalance_offset"}
    outcome, _ranking = runner.run(
        runner.base(config["heavy"]),
        config["heavy"],
        light,
        rebalance_offset=config["rebalance_offset"],
    )
    return outcome.result.equity.astype("float64")


def check(config: dict, summary: dict) -> str | None:
    """None when the API's curve is the search's; else what differs."""
    api_curve = pd.Series(summary["strategy"], index=pd.to_datetime(summary["dates"]), dtype=float)
    ours = search_curve(config)
    ours = ours / ours.iloc[0]
    theirs = api_curve / api_curve.iloc[0]
    if len(ours) != len(theirs) or not ours.index.equals(theirs.index):
        return f"weeks differ: search {len(ours)}, API {len(theirs)}"
    gap = float(((ours - theirs).abs() / ours.abs().clip(lower=1e-12)).max())
    return None if gap <= TOLERANCE else f"equity differs by up to {gap:.2e}"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--frozen", type=Path, required=True)
    parser.add_argument("--name", required=True)
    parser.add_argument("--status", default="paper", choices=sorted(runs_store.STATUSES))
    parser.add_argument("--apply", action="store_true", help="Save; without it, check only.")
    args = parser.parse_args()
    frozen = json.loads((PKG / args.frozen).read_text())
    sleeves = []
    for n, config in enumerate(frozen["configs"], 1):
        request = sleeve_request(config)
        summary = api.sleeve_summary("broad", request)
        problem = check(config, summary)
        cagr = summary["kpis"]["cagr"]
        print(
            f"{n}. {config['id']} ({config['arm']}, Friday slot {config['rebalance_offset']}): "
            f"CAGR {cagr:.2%} - {problem or 'API = search'}"
        )
        if problem:
            return 1
        sleeves.append((config, request, summary))
    if not args.apply:
        print("check only: nothing saved (pass --apply)")
        return 0
    with db_read.open_catalog() as con:
        if args.status in runs_store.FOLLOWED:
            runs_store.ensure_followed_slot(con)
        saved = []
        try:
            for n, (config, request, summary) in enumerate(sleeves, 1):
                record = runs_store.save_run(
                    con,
                    "broad",
                    name=f"{args.name} · {n} of {len(sleeves)} ({config['id']})",
                    config=request,
                    kpis=summary["kpis"],
                    dates=summary["dates"],
                    strategy=summary["strategy"],
                    versions=summary.get("versions"),
                )
                saved.append(record["id"])
            group = runs_store.create_group(con, args.name, saved)
            if args.status != "watching":
                group = runs_store.update_run(con, group["id"], status=args.status) or group
        except Exception:
            for run_id in saved:
                runs_store.delete_run(con, run_id)
            raise
    print(f"saved group {group['id']} '{args.name}' ({args.status}), sleeves {saved}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
