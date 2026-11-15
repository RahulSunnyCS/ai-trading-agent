"""BL-227: the Options overlay page's runs. A saved Broad favourite (or group) is re-run on the
F&O universe (`broad_universe="fno"`, BL-226), its weekly holdings become the call picks and its
after-tax equity the shares book; `options_overlay.run` does the rest. Results are cached by the
request and the F&O lake's newest day.
"""

from __future__ import annotations

import json
import threading
from collections import OrderedDict
from typing import Any

import numpy as np
import pandas as pd

from . import options_overlay as ov

_CACHE: OrderedDict[str, dict] = OrderedDict()
_CACHE_LOCK = threading.Lock()
_CACHE_KEPT = 12


def _favourite(fid: str) -> dict:
    from . import runs_store
    from .db_read import read_catalog

    with read_catalog() as con:
        groups = {g["id"]: g for g in runs_store.list_groups(con)}
        favourites = runs_store.list_favorites(con, include_groups=True)
    for record in favourites:
        if record["id"] == fid:
            return groups.get(fid, record)
    raise LookupError("That saved strategy is not a favourite any more.")


def strategies() -> list[dict[str, Any]]:
    """The Broad favourites and groups the page can re-run on F&O stocks, headline first."""
    from . import runs_store
    from .db_read import read_catalog

    try:
        with read_catalog() as con:
            groups = {g["id"]: g for g in runs_store.list_groups(con)}
            favourites = runs_store.list_favorites(con, include_groups=True)
    except FileNotFoundError:
        return []
    out = []
    for record in favourites:
        if record.get("member_of"):
            continue  # listed through its group
        record = groups.get(record["id"], record)
        members = record.get("members") or [record]
        if any((m.get("config") or {}).get("dataset") != "broad" for m in members):
            continue
        out.append(
            {
                "id": record["id"],
                "name": record.get("name") or record["id"][:8],
                "status": record.get("status"),
                "active": bool(record.get("active")),
                "sleeves": len(members),
                "held_n": [held_n(m["config"]) for m in members],
            }
        )
    return out


def held_n(cfg: dict) -> int:
    if cfg.get("broad_category_mode") == "on":
        return int(cfg.get("broad_category_top_n") or 1) * int(
            cfg.get("broad_picks_per_category", 1)
        )
    return int(cfg.get("broad_off_top_n") or 5)


def strategy_inputs(fid: str, start: str, end: str | None) -> ov.Inputs:
    """The favourite's sleeves re-run on F&O stocks: weekly picks per sleeve, the blended equity."""

    def make() -> ov.Inputs:
        from . import api
        from .tax import TaxRules

        record = _favourite(fid)
        members = record.get("members") or [record]
        configs = [m["config"] for m in members]
        if any(c.get("dataset") != "broad" for c in configs):
            raise ValueError("Only Broad strategies can be re-run on F&O stocks.")
        sessions = ov.LAKE.sessions()
        arr = np.array(sessions, dtype="datetime64[ns]")
        sleeves, equities = [], []
        for cfg in configs:
            body = {**cfg, "broad_universe": "fno", "start": start, "end": end}
            body.pop("dataset_label", None)
            req = api.BacktestRequest(**body)
            ranking = api._broad_ranking(req)
            result = api._run_broad(req, ranking, api.DATA.get(), tax=TaxRules()).result
            picks = {}
            for week, row in result.weights.iterrows():
                d = ov.rebalance_day(pd.Timestamp(week), arr, sessions)
                if d is not None:
                    picks[d] = [c.split("#", 1)[0] for c, v in row.items() if v > 0]
            sleeves.append(ov.Sleeve(picks=picks, n=held_n(cfg)))
            equities.append(result.equity / result.equity.iloc[0])
        blend = pd.concat(equities, axis=1).ffill().mean(axis=1)
        return ov.Inputs(sleeves=sleeves, stock_equity=blend, strategy_name=record.get("name"))

    return ov.LAKE.remember(f"favourite:{fid}:{start}:{end}", make)


SETTING_FIELDS = tuple(ov.Settings.__dataclass_fields__)


def run_request(body: dict[str, Any]) -> dict[str, Any]:
    settings = ov.Settings(**{k: body[k] for k in SETTING_FIELDS if k in body})
    settings.validate()
    fid = body.get("favourite_id")
    if settings.direction in ("calls", "switch", "both") and not fid:
        raise ValueError("Pick a strategy: calls are bought on its holdings.")
    key = json.dumps({**body, "_lake": ov.LAKE.newest}, sort_keys=True, default=str)
    with _CACHE_LOCK:
        if key in _CACHE:
            _CACHE.move_to_end(key)
            return _CACHE[key]
    inputs = strategy_inputs(fid, settings.start, settings.end) if fid else ov.Inputs()
    result = ov.run(settings, inputs)
    result["favourite_id"] = fid
    with _CACHE_LOCK:
        _CACHE[key] = result
        while len(_CACHE) > _CACHE_KEPT:
            _CACHE.popitem(last=False)
    return result
