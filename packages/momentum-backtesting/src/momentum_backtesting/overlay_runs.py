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


def _digest(fid: str | None) -> str | None:
    """A hash of a favourite's saved settings (its members' configs), so a cached re-run does not
    outlive an edit of the favourite. None for no favourite or one that is gone."""
    if not fid:
        return None
    import hashlib

    try:
        record = _favourite(fid)
    except (LookupError, FileNotFoundError):
        return None
    configs = [m.get("config") for m in record.get("members") or [record]]
    return hashlib.sha1(json.dumps(configs, sort_keys=True, default=str).encode()).hexdigest()[:12]


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


#: A custom strategy's fixed settings: BL-226's grid (`scripts/bl226_fno_sweep.py` GRID_BASE):
#: the Broad engine on F&O stocks, its tradability filter, itemised costs, 15 bps slippage, the
#: Friday close a week after the signal, circuits respected, a 25 % cap per stock.
CUSTOM_BASE: dict[str, Any] = {
    "dataset": "broad",
    "universe": ["broad_momentum"],
    "portfolio": "buffer",
    "broad_category_mode": "off",
    "broad_universe": "fno",
    "broad_liquidity_filter": True,
    "execution": "fri_close",
    "signal_delay": 1,
    "cost_model": "itemised",
    "slippage_bps": 15.0,
    "capital": 1_000_000.0,
    "broad_respect_circuits": True,
    "max_stock_price": 0.0,
    "weights": None,
    "voladj_skip_recent_month": True,
    "broad_liq_min_turnover_cr": 2.0,
    "broad_liq_floor_ratio": 0.25,
    "broad_liq_min_price": 30.0,
    "max_position": 0.25,
    "broad_pool_top_n": 336,
    "broad_pool_exit_rank": 340,
}
CUSTOM_LOOKBACKS = (1, 4, 13, 26, 52)


def custom_config(custom: dict[str, Any]) -> dict[str, Any]:
    """A custom strategy's Broad request: the base plus the reader's look-backs, N, exit rank,
    rebalance and score."""
    lookbacks = sorted({int(w) for w in custom.get("lookbacks") or []})
    if not lookbacks or any(w not in CUSTOM_LOOKBACKS for w in lookbacks):
        raise ValueError("Pick at least one look-back from 1, 4, 13, 26 and 52 weeks.")
    top_n = int(custom.get("top_n", 10))
    exit_rank = int(custom.get("exit_rank", 2 * top_n))
    if not 1 <= top_n <= 30 or not top_n <= exit_rank <= 100:
        raise ValueError("Hold 1 to 30 stocks, with an exit rank from N to 100.")
    every = custom.get("rebalance", "weekly")
    cadence = {
        "weekly": {"rebalance": "weekly", "rebalance_every": 1},
        "fortnightly": {"rebalance": "weekly", "rebalance_every": 2},
        "monthly": {"rebalance": "monthly"},
    }.get(every)
    if cadence is None:
        raise ValueError("Rebalance weekly, fortnightly or monthly.")
    score = custom.get("score", "ranksum")
    if score not in ("ranksum", "voladj"):
        raise ValueError("Score by rank-sum or volatility-adjusted return.")
    return {**CUSTOM_BASE, **cadence, "lookbacks": lookbacks, "broad_off_top_n": top_n,
            "broad_off_exit_rank": exit_rank, "score": score}  # fmt: skip


def custom_name(custom: dict[str, Any]) -> str:
    weeks = sorted({int(w) for w in custom.get("lookbacks") or []})
    span = f"{max(weeks)}w" if weeks else "?"
    return (f"Custom · top {custom.get('top_n', 10)} · {span} · "
            f"{custom.get('rebalance', 'weekly')}")  # fmt: skip


def strategy_inputs(
    fid: str | None, start: str, end: str | None, custom: dict[str, Any] | None = None
) -> ov.Inputs:
    """The favourite's sleeves (or one custom strategy) re-run on F&O stocks: weekly picks per
    sleeve, the blended equity."""

    def make() -> ov.Inputs:
        from . import api
        from .tax import TaxRules

        if custom is not None:
            record = {"name": custom_name(custom)}
            configs = [custom_config(custom)]
        else:
            record = _favourite(fid or "")
            members = record.get("members") or [record]
            configs = [m["config"] for m in members]
        if any(c.get("dataset") != "broad" for c in configs):
            raise ValueError("Only Broad strategies can be re-run on F&O stocks.")
        sessions = ov.LAKE.sessions()
        arr = np.array(sessions, dtype="datetime64[ns]")
        sleeves, equities = [], []
        for cfg in configs:
            # the option legs are bought at the rebalance day's close, so the holdings must come
            # from the week before (as the custom strategies, the puts and the mirror pool do): a
            # favourite saved with signal_delay 0 would be ranked on the very close it is bought at
            body = {**cfg, "broad_universe": "fno", "start": start, "end": end,
                    "signal_delay": max(int(cfg.get("signal_delay") or 0), 1),
                    "execution": "fri_close"}  # fmt: skip
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

    # a few strategy re-runs kept (each holds weekly weights and equity), newest last
    who = json.dumps(custom, sort_keys=True) if custom is not None else f"{fid}:{_digest(fid)}"
    return ov.LAKE.remember(f"strategy:{who}:{start}:{end}", make, group="favourite", keep=4)


SETTING_FIELDS = tuple(ov.Settings.__dataclass_fields__)


def run_request(body: dict[str, Any]) -> dict[str, Any]:
    settings = ov.Settings(**{k: body[k] for k in SETTING_FIELDS if k in body})
    settings.validate()
    # puts and the mirror pool read no strategy: compared with NIFTY, not some favourite's shares
    uses_strategy = settings.direction in ("calls", "switch", "both")
    custom = body.get("custom") if uses_strategy else None
    fid = body.get("favourite_id") if uses_strategy and custom is None else None
    if uses_strategy and not fid and custom is None:
        raise ValueError("Pick a strategy: calls are bought on its holdings.")
    if custom is not None:
        custom_config(custom)  # refuse a bad custom strategy before any work
    body = {**body, "favourite_id": fid, "custom": custom}
    key = json.dumps({**body, "_lake": ov.LAKE.version, "_favourite": _digest(fid)},
                     sort_keys=True, default=str)  # fmt: skip
    with _CACHE_LOCK:
        if key in _CACHE:
            _CACHE.move_to_end(key)
            return _CACHE[key]
    inputs = (
        strategy_inputs(fid, settings.start, settings.end, custom)
        if fid or custom is not None
        else ov.Inputs()
    )
    result = ov.run(settings, inputs)
    result["favourite_id"] = fid
    with _CACHE_LOCK:
        _CACHE[key] = result
        while len(_CACHE) > _CACHE_KEPT:
            _CACHE.popitem(last=False)
    return result
