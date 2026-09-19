"""
Per-session simulation state — reset fresh at the start of every session.
Distinct from `features.FeatureStore`: these are simulation-PATH outcomes
(what actually fired, and when), not declared/computed features.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from .ledger import Fill


class RefResolutionError(ValueError):
    """Raised when a `Ref` anchor cannot be resolved yet — e.g. `last_fill`
    referenced before any fill has occurred in the session. Only reachable
    from `entry.filter` conditions, which are the only ones evaluated before
    the unconditional entry fill exists."""


@dataclass
class EngineState:
    """`running_low`/`running_high` are keyed by FEATURE NAME, not by ladder
    id: every ladder that anchors to the same (feature, anchor) pair shares
    one running value and one reset — this matches the reference's single
    `running_lo` variable for Variant D, where both `t1` and `t2` anchor to
    `atm_straddle`/`running_low` and share its resets."""

    entry_snapshot: dict[str, float] = field(default_factory=dict)
    running_low: dict[str, float] = field(default_factory=dict)
    running_high: dict[str, float] = field(default_factory=dict)
    last_fill: Fill | None = None

    def seed_running_anchors(self, feature_name: str, entry_value: float) -> None:
        """Called once at session start for every feature any ladder anchors
        to via running_low/running_high — matches `running_lo = s_open` in
        the reference. `setdefault` so re-seeding (e.g. two ladders sharing
        the same anchor) is a no-op, not a reset."""
        self.running_low.setdefault(feature_name, entry_value)
        self.running_high.setdefault(feature_name, entry_value)

    def update_running_anchors(self, feature_name: str, value: float) -> None:
        """Called once per bar, BEFORE evaluating that bar's conditions —
        matches `running_lo = min(running_lo, v)` preceding the fire-check
        in the reference. A feature never anchored-to by any ladder is
        simply absent from these dicts and skipped."""
        if feature_name in self.running_low:
            self.running_low[feature_name] = min(self.running_low[feature_name], value)
        if feature_name in self.running_high:
            self.running_high[feature_name] = max(self.running_high[feature_name], value)

    def reset_running_low(self, feature_name: str, value: float) -> None:
        """Called immediately after ANY ladder anchored to
        (feature_name, running_low) fires — a shared reset across every
        ladder using that anchor, not a per-ladder one."""
        self.running_low[feature_name] = value

    def reset_running_high(self, feature_name: str, value: float) -> None:
        self.running_high[feature_name] = value

    def record_fill(self, fill: Fill) -> None:
        self.last_fill = fill
