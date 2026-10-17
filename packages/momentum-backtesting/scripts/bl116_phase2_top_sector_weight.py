"""BL-116 Phase 2: twice the money for picks from the best-placed sector, on 2017-2022.

The rule is `search_spaces/bl116_criteria_addendum_1.json` (committed and pushed before this ran).
Each sleeve of the eleven saved Broad groups is run with data ending 2022-12-30, with
`top_sector_weight` 1.0 (baseline) and 2.0, after tax at Rs 5 lakh per group (and pre-tax, report
only). A group's curve is its sleeves blended at equal capital reset each April. Curves are cached
under `data/search/bl116/phase2/` so a stopped run resumes.

Run from packages/momentum-backtesting:  uv run python scripts/bl116_phase2_top_sector_weight.py
"""

from __future__ import annotations

import json
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
RULE = json.loads((ROOT / "search_spaces" / "bl116_criteria_addendum_1.json").read_text())
END = "2022-12-30"
CAPITAL = 500_000
OUT = ROOT / "data" / "search" / "bl116" / "phase2"


def sleeve_configs() -> dict[str, list[dict]]:
    from momentum_backtesting import runs_store, saved_identity
    from momentum_backtesting.db_read import read_catalog

    with read_catalog() as con:
        strategies = {s["id"]: s for s in runs_store.list_strategies(con)}
    out = {}
    for name, spec in RULE["strategies"].items():
        members = {m["id"]: m for m in strategies[spec["group"]]["members"]}
        rows = []
        for run_id, fingerprint in spec["sleeves"].items():
            config = members[run_id]["config_full"]
            got = saved_identity.fingerprint("broad", config)
            if got != fingerprint:
                raise SystemExit(f"{name} {run_id}: fingerprint {got} != {fingerprint}")
            rows.append({"id": run_id, "config": config})
        out[name] = rows
    return out


def run_sleeve(config: dict, k: int, taxed: bool, weight: float):
    from momentum_backtesting import api
    from momentum_backtesting.tax import TaxRules

    req = api.BacktestRequest.model_validate(
        {
            **config,
            "end": END,
            "split_fridays": False,
            "capital": CAPITAL / k,
        }
    )
    ranking = api._broad_ranking(req)
    tax = TaxRules(slab_rate=0.3) if taxed else None
    return api._run_broad(req, ranking, api.DATA.get(), top_sector_weight=weight, tax=tax).result


def group_curve(name: str, sleeves: list[dict], taxed: bool, weight: float) -> pd.Series:
    from momentum_backtesting import tranches

    stem = name.replace(" ", "_").replace("/", "_")
    path = OUT / f"{stem}__{'tax' if taxed else 'pre'}__w{weight}.parquet"
    if path.exists():
        return pd.read_parquet(path)["equity"]
    results = [run_sleeve(s["config"], len(sleeves), taxed, weight) for s in sleeves]
    curve = tranches.blend_reset(results).equity
    pd.DataFrame({"equity": curve}).to_parquet(path)
    return curve


def stats(curve: pd.Series) -> dict[str, float]:
    from momentum_backtesting import choose, metrics

    c = curve.dropna()
    return {
        "cagr": float(metrics.cagr(c)),
        "max_drawdown": float(metrics.max_drawdown(c)[0]),
        "ulcer": float(choose.ulcer(c.to_frame()).iloc[0]),
    }


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    rows = []
    for name, sleeves in sleeve_configs().items():
        for taxed in (True, False):
            base = stats(group_curve(name, sleeves, taxed, 1.0))
            lever = stats(group_curve(name, sleeves, taxed, 2.0))
            rows.append(
                {
                    "group": name,
                    "money": "after_tax" if taxed else "pre_tax",
                    **{f"base_{k}": v for k, v in base.items()},
                    **{f"lever_{k}": v for k, v in lever.items()},
                }
            )
            print(
                f"{name[:36]:36} {'tax' if taxed else 'pre'} CAGR {base['cagr']:.1%} -> "
                f"{lever['cagr']:.1%}  DD {base['max_drawdown']:.1%} -> "
                f"{lever['max_drawdown']:.1%}",
                flush=True,
            )
    table = pd.DataFrame(rows)
    table["d_cagr"] = table["lever_cagr"] - table["base_cagr"]
    table["d_dd_deeper"] = table["base_max_drawdown"] - table["lever_max_drawdown"]
    table["d_ulcer"] = table["lever_ulcer"] - table["base_ulcer"]
    table.to_csv(OUT / "development.csv", index=False)

    dev = table[table["money"] == "after_tax"]
    a = bool(dev["d_cagr"].median() >= 0.005 and (dev["d_cagr"] >= 0).sum() >= 7)
    b = bool((dev["d_dd_deeper"] <= 0.02).sum() >= 9 and dev["d_ulcer"].median() <= 0.01)
    result = {
        "rule": "search_spaces/bl116_criteria_addendum_1.json",
        "development_after_tax": {
            "median_d_cagr": float(dev["d_cagr"].median()),
            "cagr_not_lower": int((dev["d_cagr"] >= 0).sum()),
            "dd_within_2pts": int((dev["d_dd_deeper"] <= 0.02).sum()),
            "median_d_ulcer": float(dev["d_ulcer"].median()),
            "a_return": a,
            "b_risk": b,
            "passes": a and b,
        },
        "development_pre_tax_report_only": {
            "median_d_cagr": float(table.loc[table["money"] == "pre_tax", "d_cagr"].median()),
            "cagr_not_lower": int((table.loc[table["money"] == "pre_tax", "d_cagr"] >= 0).sum()),
        },
        "per_group": table.round(5).to_dict(orient="records"),
        "confirmation": "not run"
        if not (a and b)
        else "pending: run once on 2023-01-06 to 2026-10-16",
        "verdict": "development passed; confirmation pending" if a and b else "kill",
    }
    (ROOT / "search_spaces" / "bl116_phase2_result.json").write_text(
        json.dumps(result, indent=1) + "\n"
    )
    print(json.dumps(result["development_after_tax"], indent=1), result["verdict"])


if __name__ == "__main__":
    main()
