"""
Regime bucketing (M-5, R2) — buckets a completed backtest's session-level
net P&L by the market regime tag in effect at LAG 1 (the most recent known
regime strictly BEFORE each session's own date) — never a session's own
day, which isn't knowable before the fact; the same point-in-time
discipline every cross-day feature in this codebase follows (see
strategy/schema.py's lag-required rolling features). Regime data comes
from analytics/regime_source.py, itself gated on `DATABASE_URL`; this
module returns None (not an error) whenever regime data isn't available,
matching R2's "omit gracefully otherwise" design — never a fabricated or
default bucket.

Deliberately NOT wired as a strategy DSL `feature`/`Ref` usable inside
entry filters or ladder conditions this milestone: every other DSL feature
(features/registry.py) is computed purely from the offline local Parquet/
DuckDB cache via features/evaluator.py's two-pass, no-network design; a
regime feature needs a live PostgreSQL round-trip mid-evaluation, which is
a structurally different kind of input that deserves its own dedicated
wiring pass through the evaluator/loader/conditions machinery, not a
rushed bolt-on that risks the golden-fixture-verified engine core. Post-hoc
bucketing of an already-computed run's results needs none of that — only
"which regime applied yesterday, for the dates this run already covers."
"""

from __future__ import annotations

from datetime import timedelta

from ..analytics.regime_source import fetch_regimes, regime_data_available
from ..engine.result import SessionResult

# Covers weekends plus a short holiday run so a lag-1 lookback always finds
# the prior trading day's regime tag, even right after a long weekend.
_LOOKBACK_BUFFER_DAYS = 10


def regime_bucket_report(
    sessions: list[SessionResult], underlying: str
) -> dict[str, float] | None:
    """{regime: summed net_inr} across `sessions`, bucketed by each
    session's lag-1 regime tag. Returns None if regime data isn't
    available (DATABASE_URL unset) or no regime row applies to any session
    in this window."""
    if not sessions or not regime_data_available():
        return None

    session_dates = sorted(s.date for s in sessions)
    query_from = session_dates[0] - timedelta(days=_LOOKBACK_BUFFER_DAYS)
    regimes = fetch_regimes(underlying, query_from, session_dates[-1])
    if not regimes:
        return None

    known_dates = sorted(regimes)
    buckets: dict[str, float] = {}
    matched_any = False
    for s in sessions:
        candidates = [d for d in known_dates if d < s.date]
        if not candidates:
            continue
        regime = regimes[max(candidates)]
        buckets[regime] = buckets.get(regime, 0.0) + s.net
        matched_any = True

    return buckets if matched_any else None
