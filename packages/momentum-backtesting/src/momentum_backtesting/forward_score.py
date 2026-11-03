"""
BL-024 Phase 2: score the forward journal — what each recorded signal earned the week after it,
next to what the backtest says for the same week.

For a favourite's row of week W (the *scored* row, see `select`), the portfolio it led to is the
signal's `target_weights` (the engine's own post-trade portfolio), checked against the *next*
week's row: every recorded BUY must be held there (`holdings_before`) and every SELL gone. A
mismatch is flagged and the week is not scored. Then:

- **live, ideal fill** — that portfolio bought at W's Friday close and valued at W+1's Friday
  close, after the costs of the trades from the portfolio held before (the engine's own itemised
  rates and slippage, `engine._Sim.buy_cost` / `sell_cost`; pre-tax like the favourites);
- **live, achievable fill** — the same at the Monday opens after W and after W+1 (Decision 2:
  a final is recorded after Friday's close, so Monday's open is the first price it can trade);
- **backtest as recorded** — the change in the journalled `sleeve_value` from W's row to W+1's,
  i.e. the backtests that produced the two signals. Left out when the two rows come from different
  Broad rankings (BL-001 F6 changed it on 2026-10-28) or an April reset lies between them;
- **backtest now** — today's code re-run through W+1 (`backtest_now`), the value just before W's
  trades to the value just before W+1's, so it carries W's costs like the live figure.

Which row is scored: the latest one recorded before the fill (preview: W's 15:30 close; final: the
Monday 09:15 open after W). Rows recorded after it are corrections: listed, never scored in its
place. A favourite with no row before its fill is `late`.

`score` is pure (prices and the backtest come in as callables); `api._forward_score_run` wires it
to the data and `mbt journal score` stores the result in `forward_scores.json` (state dir).
"""

from __future__ import annotations

import json
import subprocess
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

import pandas as pd

from . import engine
from .engine import CASH, IDLE

IST = ZoneInfo("Asia/Kolkata")
SCORE_FILE = "forward_scores.json"
#: The stored file's shape; a file of another shape is ignored (the page waits for the next run)
#: rather than read as this one.
SCHEMA = 1
#: BL-001 F6 (PR #322): Broad ranks over each week's point-in-time members from this merge on.
F6_COMMIT = "778ba02e"
F6_LABEL = "point-in-time ranking (from 28 Oct 2026)"
PRE_F6_LABEL = "ranking before 28 Oct 2026"
BENCHMARK_NAME = "Nifty200 Momentum 30 TRI"
_IDLE = frozenset({IDLE, CASH, "__pool__"})


def fill_cutoff(week: str, run_kind: str) -> datetime:
    """The moment the signal is traded: a preview at W's close, a final at the next Monday's
    open. A row recorded later cannot have been traded on."""
    friday = pd.Timestamp(week).to_pydatetime()
    if run_kind == "preview":
        at = friday.replace(hour=15, minute=30, tzinfo=IST)
    else:
        at = (friday + timedelta(days=3)).replace(hour=9, minute=15, tzinfo=IST)
    return at.astimezone(UTC)


def _recorded(row: dict) -> datetime:
    return datetime.fromisoformat(row["recorded_at"].replace("Z", "+00:00"))


def select(rows: list[dict]) -> dict[tuple[str, str, str], dict]:
    """Per (config_id, run_kind, week): the row scored and the corrections recorded after the
    fill. `rows` are journal rows (`forward_journal.entries`), oldest first."""
    out: dict[tuple[str, str, str], dict] = {}
    for row in rows:
        key = (row["config_id"], row["run_kind"], str(row["week"])[:10])
        slot = out.setdefault(key, {"scored": None, "corrections": [], "rows": []})
        slot["rows"].append(row)
    for (_, run_kind, week), slot in out.items():
        cutoff = fill_cutoff(week, run_kind)
        before = [r for r in slot["rows"] if _recorded(r) < cutoff]
        slot["scored"] = before[-1] if before else None
        slot["corrections"] = [r for r in slot["rows"] if _recorded(r) >= cutoff]
    return out


def _signal(row: dict | None) -> dict:
    if row is None:
        return {}
    value = row.get("signal")
    return json.loads(value) if isinstance(value, str) else (value or {})


def _holdings(row: dict | None) -> dict[str, float]:
    if row is None:
        return {}
    value = row.get("holdings_before")
    parsed = json.loads(value) if isinstance(value, str) else (value or {})
    return {k: float(v) for k, v in parsed.items() if v}


def _is_buy(action: str) -> bool:
    return action == "BUY" or action == "ADD"


def mismatches(signal: dict, next_holdings: dict[str, float]) -> list[str]:
    """Recorded BUYs missing from next week's portfolio and SELLs still in it."""
    held = {k for k, v in next_holdings.items() if v > 1e-9}
    problems = []
    for row in signal.get("rows", []) or []:
        action, asset = str(row.get("action") or ""), row.get("asset")
        if _is_buy(action) and asset not in held:
            problems.append(f"{asset}: recorded {action} but not held the week after")
        elif action == "SELL" and asset in held:
            problems.append(f"{asset}: recorded SELL but still held the week after")
    return problems


#: `api.BacktestRequest`'s own defaults, for settings stored without a field.
REQUEST_DEFAULTS = {"cost_model": "flat", "cost_pct": 0.10, "slippage_bps": 5.0, "capital": 1e6}


def _rates(config: dict) -> engine.Config:
    def get(key: str):
        value = config.get(key)
        return REQUEST_DEFAULTS[key] if value is None else value

    return engine.Config(
        cost_model=get("cost_model"),
        cost_pct=float(get("cost_pct")),
        slippage_bps=float(get("slippage_bps")),
        capital=float(get("capital")),
    )


def trade_cost(config: dict, before: dict[str, float], after: dict[str, float]) -> float:
    """Cost of moving from `before` to `after` (weights of a 1.0 portfolio), at the engine's own
    rates (`engine._Sim.buy_cost` / `sell_cost`, called on a stand-in carrying only the config)."""
    cfg = _rates(config)
    sim = _CostSim(cfg)

    def named(weights: dict[str, float]) -> dict[str, float]:
        return {k: v for k, v in weights.items() if k not in _IDLE}

    a, b = named(before), named(after)
    # Money the move parks in, or takes out of, the liquid fund: the engine's PARK / UNPARK legs
    # (sell proceeds go straight into the buys; only the change in idle money passes the fund).
    a[CASH] = max(0.0, 1.0 - sum(a.values()))
    b[CASH] = max(0.0, 1.0 - sum(b.values()))
    total = 0.0
    for name in set(a) | set(b):
        delta = b.get(name, 0.0) - a.get(name, 0.0)
        if delta > 1e-9:
            total += delta * engine._Sim.buy_cost(sim, delta, name)
        elif delta < -1e-9:
            total += -delta * engine._Sim.sell_cost(sim, -delta, name)
    return total


class _CostSim:
    """Just enough of `engine._Sim` for its cost methods."""

    def __init__(self, config: engine.Config) -> None:
        self.config = config

    def _dp_charge_fraction(self, value_fraction: float) -> float:
        return engine._Sim._dp_charge_fraction(self, value_fraction)


def _growth(prices: pd.DataFrame | None, start: str, end: str, name: str) -> float | None:
    if prices is None:
        return None
    column = CASH if name in _IDLE else name
    start_ts, end_ts = pd.Timestamp(start), pd.Timestamp(end)
    if column not in prices.columns or start_ts not in prices.index or end_ts not in prices.index:
        return None
    a, b = prices.at[start_ts, column], prices.at[end_ts, column]
    if pd.isna(a) or pd.isna(b) or a <= 0:
        return None
    return float(b / a)


def portfolio_return(
    weights: dict[str, float], prices: pd.DataFrame | None, start: str, end: str, cost: float
) -> tuple[float | None, list[str]]:
    """(1 - cost) x the value of `weights` from `start` to `end`, minus 1; the money not in a
    named asset is idle in the liquid fund. Returns the names with no price as the second item."""
    invested = {k: v for k, v in weights.items() if k not in _IDLE and v > 0}
    idle = max(0.0, 1.0 - sum(invested.values()))
    missing, value = [], 0.0
    for name, weight in invested.items():
        growth = _growth(prices, start, end, name)
        if growth is None:
            missing.append(name)
        else:
            value += weight * growth
    if idle > 1e-9:
        growth = _growth(prices, start, end, CASH)
        value += idle * (growth if growth is not None else 1.0)
    if missing:
        return None, missing
    return (1.0 - cost) * value - 1.0, []


def _same_reset_year(week: str, next_week: str) -> bool:
    """No 1 April between the two weeks, so their `sleeve_value`s share a base."""
    a, b = pd.Timestamp(week), pd.Timestamp(next_week)
    april = pd.Timestamp(f"{b.year}-04-01")
    return not (a < april <= b)


def _commit(code_commit: str) -> str:
    return code_commit.removesuffix("+dirty")


def ranking_version(code_commit: str, *, is_ancestor: Callable[[str, str], bool | None]) -> str:
    """Which Broad ranking a row's code used: from the F6 merge on, the point-in-time one."""
    commit = _commit(code_commit)
    if not commit or commit == "unknown":
        return "unknown"
    verdict = is_ancestor(F6_COMMIT, commit)
    if verdict is None:
        return "unknown"
    return F6_LABEL if verdict else PRE_F6_LABEL


def git_is_ancestor(repo: Path) -> Callable[[str, str], bool | None]:
    cache: dict[tuple[str, str], bool | None] = {}

    def check(ancestor: str, commit: str) -> bool | None:
        if (ancestor, commit) not in cache:
            try:
                done = subprocess.run(
                    ["git", "merge-base", "--is-ancestor", ancestor, commit],
                    cwd=repo,
                    capture_output=True,
                    timeout=20,
                    check=False,
                )
                cache[(ancestor, commit)] = {0: True, 1: False}.get(done.returncode)
            except (OSError, subprocess.SubprocessError):
                cache[(ancestor, commit)] = None
        return cache[(ancestor, commit)]

    return check


@dataclass
class PriceTables:
    close: pd.DataFrame  # Friday-labelled weekly closes, adjusted, every column a signal names
    monday: pd.DataFrame | None  # the Monday-open fill each Friday's order gets (same labels)


PricesFor = Callable[[dict], PriceTables | None]
BacktestNow = Callable[[dict, str, str], float | None]


def backtest_week(result: engine.Result, week: str, next_week: str) -> float | None:
    """The backtest's own return over the week: its value just before `week`'s trades to its
    value just before `next_week`'s, so it pays `week`'s costs as the live figure does. (The
    engine's equity is after each week's trades; their cost, PARK / UNPARK legs included, is in
    the trade log.)"""
    equity = result.equity
    start, end = pd.Timestamp(week), pd.Timestamp(next_week)
    if start not in equity.index or end not in equity.index:
        return None
    trades = result.trades
    costs = (
        trades.groupby("week")["cost"].sum()
        if len(trades) and "cost" in trades.columns
        else pd.Series(dtype=float)
    )

    def before_trades(at: pd.Timestamp) -> float:
        paid = costs.get(at, 0.0)
        return float(equity.loc[at]) + (0.0 if pd.isna(paid) else float(paid))

    a = before_trades(start)
    return before_trades(end) / a - 1.0 if a > 0 else None


def _next_week(week: str) -> str:
    return (pd.Timestamp(week) + pd.Timedelta(days=7)).strftime("%Y-%m-%d")


def _benchmark_levels(selected: dict) -> dict[str, float]:
    levels = {}
    for (_config_id, run_kind, week), slot in selected.items():
        row = slot["scored"] or (slot["rows"][-1] if slot["rows"] else None)
        if row is not None and row.get("source") == "benchmark" and run_kind == "final":
            level = _signal(row).get("level")
            if isinstance(level, int | float):
                levels[week] = float(level)
    return levels


def score_item(
    slot: dict,
    next_slot: dict | None,
    *,
    prices: PriceTables | None,
    backtest_now: float | None,
    versions: Callable[[str], str],
    benchmark: float | None,
) -> dict:
    row = slot["scored"]
    first = slot["rows"][0]
    week = str(first["week"])[:10]
    next_week = _next_week(week)
    item: dict[str, Any] = {
        "config_id": first["config_id"],
        "name": first["config_name"],
        "dataset": first["dataset"],
        "run_kind": first["run_kind"],
        "week": week,
        "next_week": next_week,
        "entry_id": row["entry_id"] if row else None,
        "recorded_at": row["recorded_at"] if row else None,
        "corrections": [r["entry_id"] for r in slot["corrections"]],
        "status": "scored",
        "reason": None,
        "mismatches": [],
        "live": {"ideal": None, "achievable": None, "cost": None},
        "backtest": {"recorded": None, "recorded_note": None, "now": backtest_now},
        "gap": gaps({}, {}),
        "benchmark": benchmark,
        "ranking": None,
        "sleeve_value": None,
    }
    if row is None:
        item.update(status="late", reason="every row was recorded after the fill")
        return item
    item["ranking"] = versions(row["code_commit"]) if first["dataset"] == "broad" else None
    signal = _signal(row)
    item["sleeve_value"] = signal.get("sleeve_value")
    next_row = None
    if next_slot is not None:
        next_row = next_slot["scored"] or next_slot["rows"][-1]
    if next_row is None:
        item.update(status="waiting", reason=f"no entry for the week of {next_week} yet")
        return item
    problems = mismatches(signal, _holdings(next_row))
    if problems:
        item.update(status="mismatch", mismatches=problems, reason="next week's portfolio differs")
        return item
    if prices is None:
        item.update(status="not_scored", reason=f"no prices for the {first['dataset']} dataset")
        return item
    target = signal.get("target_weights")
    if not isinstance(target, dict):
        item.update(status="not_scored", reason="the signal carries no target portfolio")
        return item
    target = {k: float(v) for k, v in target.items() if v}
    config = json.loads(row["settings"]) if isinstance(row["settings"], str) else row["settings"]
    # `holdings_before` is the model portfolio at W's close before W's own trades (prices moved
    # it since W-1's trades already), so the trades are exactly the move to `target`.
    cost = trade_cost(config, _holdings(row), target)
    ideal, missing = portfolio_return(target, prices.close, week, next_week, cost)
    if ideal is None:
        item.update(status="not_scored", reason="no price for " + ", ".join(sorted(missing)))
        return item
    achievable = None
    if prices.monday is not None:
        achievable, _ = portfolio_return(target, prices.monday, week, next_week, cost)
    item["live"] = {"ideal": ideal, "achievable": achievable, "cost": cost}

    next_signal = _signal(next_row)
    a, b = signal.get("sleeve_value"), next_signal.get("sleeve_value")
    next_version = (
        versions(next_row["code_commit"]) if first["dataset"] == "broad" else item["ranking"]
    )
    if not isinstance(a, int | float) or not isinstance(b, int | float) or a <= 0:
        item["backtest"]["recorded_note"] = "the rows carry no backtest value"
    elif "unknown" in (next_version, item["ranking"]):
        item["backtest"]["recorded_note"] = (
            "which ranking produced a row cannot be told from this clone's git history"
        )
    elif next_version != item["ranking"]:
        item["backtest"]["recorded_note"] = (
            f"the two rows come from different rankings ({item['ranking']} / {next_version})"
        )
    elif not _same_reset_year(week, next_week):
        item["backtest"]["recorded_note"] = "an April reset lies between the two rows"
    else:
        item["backtest"]["recorded"] = float(b) / float(a) - 1.0
    item["gap"] = gaps(item["live"], item["backtest"])
    return item


def gaps(live: dict, backtest: dict) -> dict:
    """Live minus backtest, in return points: against today's code (`now`) and against the
    backtests that produced the two rows (`recorded`), at each fill."""
    out: dict[str, dict[str, float | None]] = {}
    for basis in ("now", "recorded"):
        reference = backtest.get(basis)
        out[basis] = {
            fill: (live[fill] - reference)
            if reference is not None and live.get(fill) is not None
            else None
            for fill in ("ideal", "achievable")
        }
    return out


def _mix(rows: list[dict], shares: list[float], part: str, key: str) -> float | None:
    values = [r[part][key] for r in rows]
    if any(v is None for v in values):
        return None
    return sum(s * v for s, v in zip(shares, values, strict=True))


def combine_groups(items: list[dict], groups: list[dict]) -> list[dict]:
    """A group's week from its members' scored weeks, each weighted by its value since the
    April reset (the group's own rule, `groups.combine`). Only when every member is scored."""
    by_key = {(i["config_id"], i["week"]): i for i in items if i["run_kind"] == "final"}
    out = []
    for group in groups:
        members = [m["id"] for m in group.get("members", [])]
        weeks = sorted({w for (cid, w) in by_key if cid in members})
        for week in weeks:
            rows = [by_key.get((m, week)) for m in members]
            entry = {
                "group_id": group["id"],
                "name": group["name"],
                "week": week,
                "members": len(members),
                "scored": sum(1 for r in rows if r and r["status"] == "scored"),
                "status": "scored",
                "live": {"ideal": None, "achievable": None},
                "backtest": {"recorded": None, "now": None},
                "gap": gaps({}, {}),
                "benchmark": next((r["benchmark"] for r in rows if r), None),
                "ranking": next((r["ranking"] for r in rows if r), None),
            }
            if any(r is None or r["status"] != "scored" for r in rows):
                entry["status"] = "incomplete"
                out.append(entry)
                continue
            values = [
                r["sleeve_value"] if isinstance(r["sleeve_value"], int | float) else 1.0
                for r in rows
            ]
            total = sum(values)
            shares = [v / total for v in values]

            entry["live"]["ideal"] = _mix(rows, shares, "live", "ideal")
            entry["live"]["achievable"] = _mix(rows, shares, "live", "achievable")
            entry["backtest"]["recorded"] = _mix(rows, shares, "backtest", "recorded")
            entry["backtest"]["now"] = _mix(rows, shares, "backtest", "now")
            entry["gap"] = gaps(entry["live"], entry["backtest"])
            out.append(entry)
    return out


def score(
    rows: list[dict],
    *,
    prices_for: PricesFor,
    backtest_now: BacktestNow | None,
    versions: Callable[[str], str],
    groups: list[dict] | None = None,
    only: set[str] | None = None,
) -> dict:
    """Every favourite's scorable weeks. `prices_for(settings)` returns the price tables for a
    config (None: not supported), `backtest_now(settings, week, next_week)` today's backtest
    over that week, `versions(code_commit)` the ranking label. `only` limits it to config ids."""
    selected = select(rows)
    levels = _benchmark_levels(selected)
    items = []
    for key in sorted(selected, key=lambda k: (k[2], k[1], k[0])):
        config_id, run_kind, week = key
        slot = selected[key]
        if slot["rows"][0].get("source") == "benchmark":
            continue
        if only is not None and config_id not in only:
            continue
        next_slot = selected.get((config_id, "final", _next_week(week)))
        scored = slot["scored"]
        settings = None
        if scored is not None:
            settings = scored["settings"]
            settings = json.loads(settings) if isinstance(settings, str) else settings
        ready = (
            scored is not None
            and next_slot is not None
            and (next_slot["scored"] or next_slot["rows"])
        )
        prices = prices_for(settings) if ready and settings is not None else None
        now = None
        if ready and backtest_now is not None and settings is not None:
            now = backtest_now(settings, week, _next_week(week))
        a, b = levels.get(week), levels.get(_next_week(week))
        items.append(
            score_item(
                slot,
                next_slot,
                prices=prices,
                backtest_now=now,
                versions=versions,
                benchmark=(b / a - 1.0) if a and b else None,
            )
        )
    return {
        "items": items,
        "groups": combine_groups(items, groups or []),
        "weeks": sorted({i["week"] for i in items}),
        "scored_weeks": sorted({i["week"] for i in items if i["status"] == "scored"}),
    }


# ------------------------------------------------------------------------------- storage, text


def save(result: dict, folder: Path) -> Path:
    folder.mkdir(parents=True, exist_ok=True)
    path = folder / SCORE_FILE
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps({**result, "schema": SCHEMA}, indent=1, default=str))
    tmp.replace(path)
    return path


def load(folder: Path) -> dict | None:
    try:
        stored = json.loads((folder / SCORE_FILE).read_text())
    except (OSError, ValueError):
        return None
    return stored if isinstance(stored, dict) and stored.get("schema") == SCHEMA else None


def _pct(value: float | None) -> str:
    return "n/a" if value is None else f"{value * 100:+.1f}%"


def headline_line(result: dict, headline: dict | None) -> str | None:
    """One line for the Friday message: the headline's newest scored week (a group's when the
    headline is a group), live at Friday close and Monday open beside the backtest."""
    if not headline:
        return None
    rows = [g for g in result.get("groups", []) if g["group_id"] == headline.get("id")]
    if not rows:
        rows = [
            i
            for i in result.get("items", [])
            if i["config_id"] == headline.get("id") and i["run_kind"] == "final"
        ]
    scored = [r for r in rows if r["status"] == "scored"]
    if not scored:
        return None
    last = max(scored, key=lambda r: r["week"])
    day = pd.Timestamp(last["week"]).strftime("%d %b")
    parts = []
    if last["backtest"]["recorded"] is not None:
        parts.append(f"{_pct(last['backtest']['recorded'])} as recorded")
    if last["backtest"]["now"] is not None:
        parts.append(f"{_pct(last['backtest']['now'])} on today's code")
    text = (
        f"Forward score, week of {day}: {_pct(last['live']['ideal'])} at Friday close"
        + (
            f", {_pct(last['live']['achievable'])} at Monday open"
            if last["live"]["achievable"] is not None
            else ""
        )
        + (f" vs backtest {' / '.join(parts)}" if parts else "")
    )
    if last.get("benchmark") is not None:
        text += f" · Mom30 TRI {_pct(last['benchmark'])}"
    return text
