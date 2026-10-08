"""BL-025 Phase 2: check the owner's live-money rules (`live_rules.toml`) once a week.

Nothing here trades or moves money. A breached rule produces a Telegram message that names the
rule and quotes the action the owner wrote for it; the owner acts.

What it measures, and what it cannot yet:

- **Drawdown** (cut half, exit) and the **money gate** use the *followed money's* weekly equity.
  While the stage is `paper` that is the frozen ensemble's model portfolio rebased at
  `stage.paper_start` (BL-010 Phase 6 step 3's definition: its holdings carry in, as a paper
  account opened that day would hold them).
- **Trailing** (live return minus the backtest's over the same weeks) needs the *journal-scored*
  live series, which BL-024 Phase 2 has not built. Until a `live` series is supplied the rule
  reports "not measurable" in every weekly message; it never passes silently, and a paper curve
  taken from the same engine as the backtest is never used for it (the gap would be zero by
  construction).
- Stage `live` needs real-fills equity (BL-024 Phase 3, not built): the check refuses to read
  paper numbers as real money and reports itself as blocked.
"""

from __future__ import annotations

import json
import tomllib
from dataclasses import dataclass, field
from pathlib import Path

import pandas as pd

PACKAGE = Path(__file__).resolve().parents[2]
RULES_PATH = Path(__file__).with_name("live_rules.toml")
FROZEN_PATH = PACKAGE / "search_spaces" / "bl010_phase6_frozen.json"
SPACE_PATH = PACKAGE / "search_spaces" / "round7_A.toml"
NOTIFY_TYPE = "momentum.live_rules"  # the optional weekly status; breaches are always sent


def load(path: Path = RULES_PATH) -> dict:
    return tomllib.loads(path.read_text())


@dataclass
class Finding:
    rule: str  # drawdown | trailing | money_gate | stage | data
    level: str  # ok | breach | pending | ready | unmeasurable | blocked
    title: str
    detail: str
    action: str | None = None

    @property
    def needs_you(self) -> bool:
        return self.level in ("breach", "ready", "blocked")


@dataclass
class Report:
    stage: str
    week: str | None  # the latest week the numbers cover
    weeks: int  # weeks tracked since the start
    findings: list[Finding] = field(default_factory=list)
    simulated: str | None = None
    #: The figures behind the findings, for the dashboard's gauges (BL-051): drawdown now and
    #: worst, the cut/exit lines, weeks tracked and needed, return against the benchmark.
    numbers: dict = field(default_factory=dict)

    @property
    def breached(self) -> bool:
        return any(f.needs_you for f in self.findings)


def _pct(x: float) -> str:
    return f"{x * 100:+.1f}%"


def _window_return(curve: pd.Series, weeks: int) -> float:
    return float(curve.iloc[-1] / curve.iloc[-1 - weeks] - 1)


def start_week(index: pd.DatetimeIndex, since: str | pd.Timestamp) -> pd.Timestamp | None:
    """The last week on or before `since`, or None when every week is later."""
    earlier = index[index <= pd.Timestamp(since)]
    return earlier[-1] if len(earlier) else None


def evaluate(
    rules: dict,
    followed: pd.Series | None,
    benchmark: pd.Series | None,
    *,
    live: pd.Series | None = None,
    backtest: pd.Series | None = None,
) -> Report:
    """The weekly check, from weekly equity curves (Friday-indexed).

    `followed` is the followed money's equity; `benchmark` the Nifty200 Momentum 30 TRI level.
    `live` and `backtest` (both, or neither) are the journal-scored live equity and the
    backtest's equity for the same weeks, for the trailing rule."""
    stage = rules["stage"]["current"]
    if stage == "live":
        return Report(
            stage=stage,
            week=None,
            weeks=0,
            findings=[
                Finding(
                    "stage",
                    "blocked",
                    "Stage is live, but there is no real-money equity to check",
                    "BL-024 Phase 3 (recording real fills) is not built, so the rules cannot be "
                    "measured on your real money. These checks are NOT protecting it.",
                    "Watch the account yourself against the drawdown rules until real fills are "
                    "recorded.",
                )
            ],
        )

    since = pd.Timestamp(rules["stage"]["paper_start"])
    if followed.index[-1] < since:  # the data has not reached the first paper week
        return Report(
            stage=stage,
            week=str(followed.index[-1].date()),
            weeks=0,
            findings=[
                Finding(
                    "stage",
                    "pending",
                    "Paper tracking has not started",
                    f"It counts from {rules['stage']['paper_start']}; the data reaches "
                    f"{followed.index[-1].date()}.",
                )
            ],
        )
    start = start_week(followed.index, since)
    assert start is not None  # the data reaches `since`, so some week is on or before it
    e = followed.loc[start:] / followed.loc[start]
    b = benchmark.reindex(e.index).ffill()
    b = b / b.iloc[0]
    weeks = len(e) - 1
    report = Report(stage=stage, week=str(e.index[-1].date()), weeks=weeks)
    dd = e / e.cummax() - 1
    report.numbers = {
        "drawdown": float(dd.iloc[-1]),
        "worst_drawdown": float(dd.min()),
        "peak_week": str(e.idxmax().date()),
        "cut_half_at": float(rules["drawdown"]["cut_half_at"]),
        "exit_at": float(rules["drawdown"]["exit_at"]),
        "weeks": weeks,
        "min_paper_weeks": int(rules["money_gate"]["min_paper_weeks"]),
        "return": float(e.iloc[-1] - 1),
        "benchmark_return": float(b.iloc[-1] - 1),
        "must_beat": rules["money_gate"]["must_beat"],
        "trailing_window_weeks": int(rules["trailing"]["window_weeks"]),
        "review_when_behind_pts": float(rules["trailing"]["review_when_behind_pts"]),
    }
    report.findings.append(_drawdown(rules, e, dd))
    report.findings.append(_trailing(rules, weeks, live, backtest))
    report.findings.append(_gate(rules, e, b, dd, weeks))
    return report


def _drawdown(rules: dict, e: pd.Series, dd: pd.Series) -> Finding:
    cfg = rules["drawdown"]
    now = float(dd.iloc[-1])
    peak = e.cummax().iloc[-1]
    worst = float(dd.min())
    base = f"{_pct(now)} from the peak (worst so far {_pct(worst)})."
    if now <= -cfg["exit_at"]:
        crossed = dd.index[dd <= -cfg["exit_at"]][0].date()
        return Finding(
            "drawdown",
            "breach",
            f"Drawdown rule hit: exit at {cfg['exit_at']:.0%}",
            f"{base} First past the line on {crossed}.",
            cfg["exit_action"],
        )
    if now <= -cfg["cut_half_at"]:
        crossed = dd.index[dd <= -cfg["cut_half_at"]][0].date()
        return Finding(
            "drawdown",
            "breach",
            f"Drawdown rule hit: cut half at {cfg['cut_half_at']:.0%}",
            f"{base} First past the line on {crossed}.",
            cfg["cut_half_action"],
        )
    return Finding(
        "drawdown",
        "ok",
        "Drawdown within limits",
        f"{base} Cut half at -{cfg['cut_half_at']:.0%}, exit at -{cfg['exit_at']:.0%} "
        f"(peak {peak:.3f}x the start).",
    )


def _trailing(
    rules: dict, weeks: int, live: pd.Series | None, backtest: pd.Series | None
) -> Finding:
    cfg = rules["trailing"]
    window, pts = cfg["window_weeks"], cfg["review_when_behind_pts"]
    if live is None or backtest is None:
        return Finding(
            "trailing",
            "unmeasurable",
            "Trailing rule not measurable yet",
            "It compares your live results with the backtest for the same weeks, which needs the "
            "journal scored week by week (BL-024 Phase 2, not built). It is not being checked.",
        )
    if len(live) <= window or len(backtest) <= window:
        return Finding(
            "trailing",
            "pending",
            "Trailing rule: not enough weeks yet",
            f"Needs {window} weeks of scored results; has {min(len(live), len(backtest)) - 1}.",
        )
    gap = _window_return(live, window) - _window_return(backtest, window)
    line = f"Live minus backtest over the last {window} weeks: {gap * 100:+.1f} points."
    if gap <= -pts / 100:
        return Finding(
            "trailing",
            "breach",
            f"Trailing rule hit: {pts:g} points behind",
            line,
            cfg["review_action"],
        )
    return Finding("trailing", "ok", "Trailing within limits", f"{line} Review at -{pts:g}.")


def _gate(rules: dict, e: pd.Series, b: pd.Series, dd: pd.Series, weeks: int) -> Finding:
    cfg = rules["money_gate"]
    need = cfg["min_paper_weeks"]
    ret, bench = float(e.iloc[-1] - 1), float(b.iloc[-1] - 1)
    hit = float(dd.min()) <= -rules["drawdown"]["cut_half_at"]
    worst = _pct(float(dd.min()))
    no_hit = not hit if cfg["no_drawdown_rule_hit"] else True
    checks = [
        (weeks >= need, f"weeks tracked: {weeks} of {need}"),
        (ret > bench, f"return {_pct(ret)} vs {cfg['must_beat']} {_pct(bench)}"),
        (no_hit, f"no drawdown rule hit (worst {worst})"),
    ]
    detail = "; ".join(f"{'yes' if ok else 'not yet'}: {text}" for ok, text in checks)
    if all(ok for ok, _ in checks):
        return Finding(
            "money_gate",
            "ready",
            "Money gate passed: your call",
            detail,
            cfg["confirm_action"],
        )
    return Finding("money_gate", "pending", "Money gate: not yet", detail)


LAST_REPORT = "live_rules_last.json"


def save_last(report: Report, severity: str, title: str, data_dir, now=None, stale=None) -> None:
    """Keep the latest real check for the dashboard (This week's rules strip, BL-051). The file is
    a cache of the check, not a record: the Telegram message is the record."""
    import json
    from datetime import datetime

    from .notify import IST

    payload = {
        "checked_at": (now or datetime.now(IST)).isoformat(timespec="seconds"),
        "severity": severity,
        "title": title,
        "stage": report.stage,
        "week": report.week,
        "weeks": report.weeks,
        "breached": report.breached,
        "stale": stale,
        "numbers": report.numbers,
        "findings": [{**f.__dict__, "needs_you": f.needs_you} for f in report.findings],
    }
    path = data_dir / LAST_REPORT
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(payload, indent=1, default=str))
    tmp.replace(path)


def load_last(data_dir) -> dict | None:
    import json

    path = data_dir / LAST_REPORT
    try:
        return json.loads(path.read_text())
    except (FileNotFoundError, ValueError):
        return None


def summary(report: Report) -> tuple[str, str, str]:
    """(severity, title, body) for Telegram."""
    prefix = f"SIMULATED ({report.simulated}) - " if report.simulated else ""
    needs = [f for f in report.findings if f.needs_you]
    lines = []
    for f in report.findings:
        mark = {"breach": "🔔", "ready": "🔔", "blocked": "❌", "ok": "✅"}.get(f.level, "…")
        lines.append(f"{mark} {f.title}\n   {f.detail}")
        if f.action and f.needs_you:
            lines.append(f"   Your action: {f.action}")
    head = (
        f"Stage {report.stage}, week {report.weeks}"
        + (f", through {report.week}" if report.week else "")
        + "."
    )
    body = head + "\n\n" + "\n".join(lines)
    if report.simulated:
        body += "\n\nThis is a simulation; nothing real was checked."
    if any(f.level == "blocked" for f in needs):
        return "error", f"{prefix}Live rules: checks cannot protect your money", body
    if any(f.rule == "drawdown" and f.level == "breach" for f in needs):
        which = next(f for f in needs if f.rule == "drawdown")
        return "action_required", f"{prefix}{which.title}", body
    if needs:
        return "action_required", f"{prefix}{needs[0].title}", body
    if report.findings and report.findings[0].rule == "stage":
        return "info", f"{prefix}Live rules check: {report.findings[0].title.lower()}", body
    return "info", f"{prefix}Live rules check: no rule breached", body


# --- real inputs ----------------------------------------------------------------------------------


def paper_curves(echo=print) -> tuple[pd.Series, pd.Series]:
    """The frozen ensemble's weekly equity through the latest week, and the Nifty200 Momentum 30
    TRI level (BL-010 Phase 6 step 3's model portfolio, not the journal)."""
    from . import bias, choose, reference_benchmarks, search, tracker
    from .phase5 import MOM30

    frozen = json.loads(FROZEN_PATH.read_text())
    runner = bias.Runner(
        search.load_space(SPACE_PATH), universe_kind="turnover_rank", category_tags="curated"
    )
    curves = {}
    for cfg in frozen["configs"]:
        echo(f"{cfg['id']} ...")
        curves[cfg["id"]] = tracker.run_config(runner, cfg)
    frame = pd.DataFrame(curves).ffill()
    ensemble = choose.ensemble_curve(frame / frame.iloc[0], list(frame.columns))
    return ensemble, reference_benchmarks.load_references()[MOM30].dropna()


def simulated_inputs(
    kind: str, rules: dict
) -> tuple[pd.Series, pd.Series, pd.Series | None, pd.Series | None]:
    """Synthetic curves that trip one rule, so the alert can be seen before it is needed."""
    weeks = 30
    index = pd.date_range(
        pd.Timestamp(rules["stage"]["paper_start"]), periods=weeks + 1, freq="W-FRI"
    )
    up = pd.Series(1.0 + 0.01 * pd.RangeIndex(weeks + 1), index=index)
    bench = pd.Series(1.0 + 0.004 * pd.RangeIndex(weeks + 1), index=index)
    cfg = rules["drawdown"]
    if kind in ("drawdown-cut", "drawdown-exit"):
        depth = cfg["exit_at"] + 0.02 if kind == "drawdown-exit" else cfg["cut_half_at"] + 0.02
        curve = up.copy()
        curve.iloc[-6:] = curve.iloc[-7] * (
            1 - depth * pd.Series(range(1, 7), index=curve.index[-6:]) / 6
        )
        return curve, bench, None, None
    if kind == "trailing":
        live = up.copy()
        live.iloc[-13:] = live.iloc[-14]  # flat for 13 weeks while the backtest keeps rising
        return up, bench, live, up.copy()
    if kind == "gate-ready":
        return up, bench, None, None
    raise ValueError(f"unknown simulation {kind!r}")


SIMULATIONS = ("drawdown-cut", "drawdown-exit", "trailing", "gate-ready")


def run_check(*, simulate: str | None = None, echo=print) -> Report:
    """Build the inputs (real, or a simulation), evaluate, and return the report."""
    rules = load()
    if simulate:
        followed, bench, live, backtest = simulated_inputs(simulate, rules)
        report = evaluate(rules, followed, bench, live=live, backtest=backtest)
        report.simulated = simulate
        return report
    if rules["stage"]["current"] == "live":
        return evaluate(rules, None, None)  # blocked: no real-money equity exists yet
    followed, bench = paper_curves(echo=echo)
    return evaluate(rules, followed, bench)
