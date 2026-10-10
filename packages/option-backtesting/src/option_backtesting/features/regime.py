"""
Regime bucketing (M-5, R2) — buckets a completed backtest's session-level
net P&L by the market regime tag in effect at LAG 1 (the most recent known
regime strictly BEFORE each session's own date) — never a session's own
day, which isn't knowable before the fact; the same point-in-time
discipline every cross-day feature in this codebase follows (see
strategy/schema.py's lag-required rolling features). Regime data comes
from analytics/regime_source.py, itself gated on `DATABASE_URL`; this
module returns None (not an error) whenever regime data isn't available
(including a configured database that is down or lacks the table),
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

from dataclasses import dataclass
from datetime import timedelta

from ..analytics.regime_source import (
    RegimeSourceUnavailable,
    fetch_regimes,
    regime_data_available,
)
from ..engine.result import SessionResult

# Covers weekends plus a short holiday run so a lag-1 lookback always finds
# the prior trading day's regime tag, even right after a long weekend.
_LOOKBACK_BUFFER_DAYS = 10


@dataclass(frozen=True)
class RegimeBuckets:
    """The regime section of a run, with why it is absent when it is.
    `status`: `ok` (buckets present), `unavailable` (no DATABASE_URL in this
    process, or nothing to bucket), `empty` (queried, no tag applies to this
    window), `connect_failed` (DATABASE_URL set, cannot connect) or
    `missing_table` (reachable, no `daily_regime_tags`)."""

    buckets: dict[str, float] | None
    status: str
    message: str | None = None


def regime_bucket_status(sessions: list[SessionResult], underlying: str) -> RegimeBuckets:
    """`regime_bucket_report`, plus the reason when there are no buckets. A
    genuine query error against a database that has the table still raises."""
    if not sessions or not regime_data_available():
        return RegimeBuckets(None, "unavailable")

    session_dates = sorted(s.date for s in sessions)
    query_from = session_dates[0] - timedelta(days=_LOOKBACK_BUFFER_DAYS)
    try:
        regimes = fetch_regimes(underlying, query_from, session_dates[-1])
    except RegimeSourceUnavailable as error:
        return RegimeBuckets(None, error.status, str(error))
    if not regimes:
        return RegimeBuckets(None, "empty")

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

    return RegimeBuckets(buckets, "ok") if matched_any else RegimeBuckets(None, "empty")


def regime_bucket_report(sessions: list[SessionResult], underlying: str) -> dict[str, float] | None:
    """{regime: summed net_inr} across `sessions`, bucketed by each
    session's lag-1 regime tag. Returns None if regime data isn't
    available (DATABASE_URL unset, database not connectable or without the
    table) or no regime row applies to any session in this window — see
    `regime_bucket_status` for which."""
    return regime_bucket_status(sessions, underlying).buckets
