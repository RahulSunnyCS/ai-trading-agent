"""What makes two saved runs the same strategy, and why a strategy's result moved (BL-052).

**Identity.** Every finished backtest is saved, so running the same settings again used to add a
row. Two configs are the same strategy when they run identically, so a config is normalised
before it is hashed: the request model's own defaults are filled in (what the engine actually ran
with), the settings the dataset never reads are dropped (`IGNORED_FIELDS`, checked against the
code by tests/test_saved_identity.py), run-only switches (`fresh`) are dropped, `end=""` is
`None`, and `weights` count only for the `ranksum` score (`None` = equal weights there; the
voladj and blend scores never read them). A config the request model refuses (a group's
`{"dataset", "group"}`, an old test payload) keeps the hash of its raw text and is never merged.

**Why it moved.** Every run stores three fingerprints: the settings hash, the data version
(`api.input_version()`, broken into the catalog tables, the stock lake files and the input files)
and the code commit (`forward_journal.code_commit()`). `explain()` labels a changed result from
them, most suspicious last:

- `data_revised`: same clean code, different data. Names what changed and the first week the
  two curves differ.
- `intended`: the code changed, the data did not, and an accepted golden change of the SAME
  dataset lies between the two commits (tests/golden/CHANGELOG.md, read through git). An
  accepted change to another dataset explains nothing.
- `check`: anything else in which the code moved (no same-dataset golden change, code and data
  both changed, uncommitted code on either side, an unknown commit). Possibly a bug.
- `not_reproducible`: same settings, same clean code, same data, different result. A bug.
- `unknown`: a run saved before runs recorded their fingerprints.
"""

from __future__ import annotations

import hashlib
import json
import math
import re
import subprocess
import time
from pathlib import Path
from typing import Any

from pydantic import ValidationError

LABELS = ("data_revised", "intended", "check", "not_reproducible", "unknown")
#: Labels that need a person to look: counted on the Saved runs tab until marked reviewed.
NEEDS_REVIEW = frozenset({"check", "not_reproducible"})

# Request fields each dataset's backtest never reads (its `_<dataset>_parts` in api.py, followed
# through every api.py function it calls; the request never leaves api.py whole).
# tests/test_saved_identity.py recomputes these from the code and fails when they disagree, so a
# field that starts being read stops being ignored here before two different strategies merge.
_BROAD_ONLY = frozenset(
    {
        "broad_category_exit_rank",
        "broad_category_mode",
        "broad_category_tags",
        "broad_category_top_n",
        "broad_coverage_floor",
        "broad_every_week",
        "broad_liq_circuit",
        "broad_liq_circuit_run",
        "broad_liq_floor_ratio",
        "broad_liq_max_circuit_days",
        "broad_liq_min_price",
        "broad_liq_min_turnover_cr",
        "broad_liquidity_filter",
        "broad_off_exit_rank",
        "broad_off_top_n",
        "broad_picks_per_category",
        "broad_pool_exit_rank",
        "broad_pool_top_n",
        "broad_respect_circuits",
        "broad_reversal_screen_pct",
        "broad_reversal_tilt",
        "broad_series_breaks",
        "broad_universe",
        "max_category",
        "max_stock_price",
    }
)
_INNER = frozenset({"commodity_copies", "debt_copies", "inner_exit_rank", "inner_top_n"})
_ETF_LEVERS = frozenset({"exclude_high_vol", "execution", "reversal_screen_pct", "reversal_tilt"})
IGNORED_FIELDS: dict[str, frozenset[str]] = {
    "etf": _BROAD_ONLY | _INNER,
    "stock": _BROAD_ONLY | _INNER | _ETF_LEVERS | {"track"},
    "custom_index": _BROAD_ONLY | _ETF_LEVERS | {"track"},
    "broad": _INNER
    | _ETF_LEVERS
    | {"defensive", "exit_rank", "filter_lookback", "slab_rate", "tax", "top_n", "track"}
    | {"universe"},
}
#: Not settings: never part of a strategy's identity.
RUN_ONLY_FIELDS = frozenset({"fresh"})

_TOLERANCE = 1e-9
#: KPI keys the dashboard adds beside a saved run for display only (BL-036 Phase 1: the extended-
#: tags companion). A run saved before they existed lacks them, so counting them would record every
#: strategy's next re-run as a moved result, which would be false.
_DISPLAY_ONLY_KPIS = frozenset({"extended_cagr", "extended_max_drawdown"})


def _hash(value: Any, size: int = 12) -> str:
    text = value if isinstance(value, str) else json.dumps(value, sort_keys=True, default=str)
    return hashlib.sha256(text.encode()).hexdigest()[:size]


def raw_hash(config: dict[str, Any]) -> str:
    """The pre-BL-052 settings hash (`runs_store.spec_hash`'s): the config's text as saved."""
    return _hash(json.dumps(config, sort_keys=True, default=str))


def normalise(dataset: str, config: dict[str, Any]) -> dict[str, Any] | None:
    """The settings that decide this config's result, in canonical form; None when the request
    model refuses the config (it then keeps its raw hash and is never merged)."""
    from .api import BacktestRequest  # api imports this module's callers; import late

    ignored = IGNORED_FIELDS.get(dataset)
    if ignored is None:
        return None
    body = {**config, "dataset": dataset}
    if "universe" in ignored and not body.get("universe"):
        body["universe"] = ["_"]  # required by the model, never read for this dataset
    try:
        request = BacktestRequest.model_validate(body)
    except ValidationError:
        return None
    settings = request.model_dump(mode="json", exclude=set(ignored | RUN_ONLY_FIELDS))
    settings["end"] = settings.get("end") or None
    # BL-056: "All Fridays" is part of a strategy only where it does something, and a config saved
    # before it existed keeps its fingerprint. With it on, the calendar phase is not a setting.
    if (
        settings.get("split_fridays")
        and settings.get("rebalance") == "weekly"
        and (settings.get("rebalance_every") or 1) > 1
    ):
        settings.pop("rebalance_offset", None)
    else:
        settings.pop("split_fridays", None)
    if "broad_liquidity_filter" in settings:
        # A gated universe runs with the filter on whatever was sent (`api._liquidity_config`), so
        # the stored flag is not a setting there: both spellings are the same strategy.
        settings["broad_liquidity_filter"] = liquidity_filter_on(settings)
    if settings.get("score") != "ranksum":
        settings.pop("weights", None)
    elif not settings.get("weights"):
        settings["weights"] = [1.0] * len(settings["lookbacks"])
    return settings


def liquidity_filter_on(config: dict[str, Any]) -> bool:
    """Whether a Broad run applies the tradability filter: the flag, or a universe that forces it
    on (`api.GATED_BROAD_UNIVERSES`). A config with no `broad_universe` ran on Total Market (the
    request model's default), where the flag alone decides."""
    from .api import GATED_BROAD_UNIVERSES

    return bool(config.get("broad_liquidity_filter", False)) or (
        config.get("broad_universe", "total_market") in GATED_BROAD_UNIVERSES
    )


def identity(dataset: str, config: dict[str, Any]) -> tuple[dict[str, Any] | None, str]:
    """(normalised settings or None, fingerprint), validating the config once."""
    settings = normalise(dataset, config)
    return settings, (_hash(settings) if settings is not None else raw_hash(config))


def complete(dataset: str, config: dict[str, Any]) -> dict[str, Any]:
    """The config with every setting the request model would default spelled out: what the run
    actually used, so a form filled from it (whose own defaults differ for some settings, e.g.
    Broad's tradability filter) runs the same strategy. The config itself when it is refused."""
    from .api import BacktestRequest

    try:
        request = BacktestRequest.model_validate({**config, "dataset": dataset})
    except ValidationError:
        return config
    full = request.model_dump(mode="json", exclude=set(RUN_ONLY_FIELDS))
    if "universe" not in config:
        full.pop("universe", None)
    return full


def fingerprint(dataset: str, config: dict[str, Any]) -> str:
    """The strategy's identity within its dataset: same fingerprint = same strategy."""
    return identity(dataset, config)[1]


# --- run versions -----------------------------------------------------------------------------

_code_memo: tuple[float, str] | None = None


def code_commit() -> str:
    """`forward_journal.code_commit()`, remembered for a minute: it runs git twice, and a run
    asks for it on every dispatch, cache hits included."""
    global _code_memo
    now = time.monotonic()
    if _code_memo is None or now - _code_memo[0] > 60:
        from .forward_journal import code_commit as journal_commit

        _code_memo = (now, journal_commit())
    return _code_memo[1]


def versions_from_input(input_version: tuple, commit: str) -> dict[str, Any]:
    """A run's data and code fingerprints from `api.input_version()`: one overall data hash plus
    the parts it is made of, so a later move can name what changed."""
    data_version, files = input_version
    tables: dict[str, str] = {}
    lake: list = []
    for entry in data_version or ():
        if isinstance(entry, tuple) and len(entry) == 3 and isinstance(entry[0], str):
            if entry[0].startswith("year="):
                lake.append(entry)
            else:
                tables[entry[0]] = _hash(list(entry[1:]), 8)
        else:
            tables[str(entry[0]) if isinstance(entry, tuple) else str(entry)] = _hash(str(entry), 8)
    return {
        "data": _hash(repr(input_version)),
        "tables": tables,
        "lake": _hash(repr(lake), 8),
        "files": _hash(repr(files), 8),
        "code": commit,
    }


def changed_parts(before: dict[str, Any], after: dict[str, Any]) -> list[str]:
    """What differs between two runs' data versions: catalog table names, "stock lake files",
    "input files"."""
    old, new = before.get("tables") or {}, after.get("tables") or {}
    names = sorted(name for name in set(old) | set(new) if old.get(name) != new.get(name))
    if before.get("lake") != after.get("lake"):
        names.append("stock lake files")
    if before.get("files") != after.get("files"):
        names.append("input files")
    return names


# --- results ----------------------------------------------------------------------------------


def _close(a: Any, b: Any) -> bool:
    if a is None or b is None:
        return a is None and b is None
    if isinstance(a, int | float) and isinstance(b, int | float):
        if isinstance(a, float) and isinstance(b, float) and math.isnan(a) and math.isnan(b):
            return True
        return abs(a - b) <= _TOLERANCE * max(1.0, abs(a), abs(b))
    return a == b


def same_result(a: dict[str, Any], b: dict[str, Any]) -> bool:
    """Same curve on the same weeks and the same headline numbers, within float noise."""
    if list(a.get("dates") or []) != list(b.get("dates") or []):
        return False
    curve_a, curve_b = a.get("strategy") or [], b.get("strategy") or []
    if len(curve_a) != len(curve_b) or not all(map(_close, curve_a, curve_b)):
        return False
    kpis_a, kpis_b = a.get("kpis") or {}, b.get("kpis") or {}
    keys = (set(kpis_a) | set(kpis_b)) - _DISPLAY_ONLY_KPIS
    return all(_close(kpis_a.get(k), kpis_b.get(k)) for k in keys)


def first_difference(a: dict[str, Any], b: dict[str, Any]) -> str | None:
    """The first week at which the two curves disagree (or one has a week the other lacks)."""
    left = dict(zip(a.get("dates") or [], a.get("strategy") or [], strict=False))
    right = dict(zip(b.get("dates") or [], b.get("strategy") or [], strict=False))
    for week in sorted(set(left) | set(right)):
        if week not in left or week not in right or not _close(left[week], right[week]):
            return week
    return None


# --- why it moved -----------------------------------------------------------------------------

_PACKAGE = Path(__file__).resolve().parents[2]
_CHANGELOG = "tests/golden/CHANGELOG.md"
_DATASET_PREFIXES = {
    "etf": "etf_",
    "stock": "stock_",
    "custom_index": "custom_index_",
    "broad": "broad_",
}


def _git(*args: str) -> str | None:
    try:
        done = subprocess.run(
            ["git", *args], cwd=_PACKAGE, capture_output=True, text=True, timeout=20, check=False
        )
    except (OSError, subprocess.SubprocessError):
        return None
    return done.stdout if done.returncode == 0 else None


_COMMIT = re.compile(r"^[0-9a-f]{7,40}$")


def accepted_golden_change(before: str, after: str, dataset: str) -> str | None:
    """The reason of an accepted golden change that moved a scenario of `dataset` between two
    commits, read from what the commits added to the changelog; None when there is none (or git
    cannot tell). The commits come from saved runs, which a client sends: anything that is not a
    plain hex commit id is refused before it reaches git's arguments."""
    if not (_COMMIT.match(before or "") and _COMMIT.match(after or "")):
        return None
    diff = _git("diff", "--unified=0", before, after, "--", _CHANGELOG)
    if not diff:
        return None
    prefix = _DATASET_PREFIXES.get(dataset)
    reason: str | None = None
    for line in diff.splitlines():
        if not line.startswith("+") or line.startswith("+++"):
            continue
        text = line[1:].strip()
        if text.startswith("## "):
            reason = None
        elif text.startswith("|"):
            scenario = text.strip("|").split("|")[0].strip()
            if prefix and scenario.startswith(prefix):
                return reason or "an accepted golden change (no reason written)"
        elif text and reason is None:
            reason = text
    return None


def _clean(commit: str | None) -> bool:
    return bool(commit) and commit != "unknown" and not commit.endswith("+dirty")


def explain(dataset: str, before: dict[str, Any], after: dict[str, Any]) -> dict[str, Any]:
    """Why `after`'s result differs from `before`'s, for two runs of the same strategy. Each run
    is `{dates, strategy, kpis, versions}`; returns `{label, ...detail}`."""
    detail: dict[str, Any] = {"first_difference": first_difference(before, after)}
    old, new = before.get("versions"), after.get("versions")
    if not old or not new:
        return {"label": "unknown", **detail}
    same_data = old.get("data") == new.get("data")
    detail["changed"] = [] if same_data else changed_parts(old, new)
    old_code, new_code = old.get("code"), new.get("code")
    if _clean(old_code) and old_code == new_code:
        return {"label": "not_reproducible" if same_data else "data_revised", **detail}
    if same_data and _clean(old_code) and _clean(new_code):
        reason = accepted_golden_change(old_code, new_code, dataset)
        if reason is not None:
            return {"label": "intended", "reason": reason, **detail}
    return {"label": "check", **detail}
