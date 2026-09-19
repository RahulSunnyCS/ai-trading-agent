"""
The per-strategy-run container for computed feature values.

Two shapes, matching the two structurally distinct kinds of feature in the
registry:

- **Per-bar** (`leg_sum`, `raw`) — a pre-bar `open` snapshot (the fix-time or
  session-open value, mirroring the reference's `s_open`/`x_open`) plus a
  `closes` array of one value per bar. Every per-bar feature shares the same
  bar grid for a given session (one `universe.timeframe` per strategy run —
  see strategy/schema.py's `Universe.timeframe`).
- **Scalar** (`session_high`, `session_low`, `max_runup`, `greek`, `gap`,
  `days_to_expiry`, `rolling_mean`, `ewma`, `rolling_pctile`) — one number
  per session, constant across all of that session's bars.

A feature name is exclusively one shape or the other (never both) for the
lifetime of a run — `set_per_bar`/`set_scalar` don't check this, callers
(features/evaluator.py) are responsible for dispatching by the declared
`FeatureSpec` type.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date


@dataclass
class FeatureStore:
    opens: dict[str, dict[date, float]] = field(default_factory=dict)
    closes: dict[str, dict[date, list[float]]] = field(default_factory=dict)
    scalars: dict[str, dict[date, float]] = field(default_factory=dict)

    def set_per_bar(self, name: str, d: date, open_: float, bar_closes: list[float]) -> None:
        self.opens.setdefault(name, {})[d] = open_
        self.closes.setdefault(name, {})[d] = bar_closes

    def set_scalar(self, name: str, d: date, value: float) -> None:
        self.scalars.setdefault(name, {})[d] = value

    def is_per_bar(self, name: str) -> bool:
        return name in self.opens

    def is_scalar(self, name: str) -> bool:
        return name in self.scalars

    def open_value(self, name: str, d: date) -> float:
        return self.opens[name][d]

    def bar_series(self, name: str, d: date) -> list[float]:
        return self.closes[name][d]

    def bar_value(self, name: str, d: date, bar: int) -> float:
        return self.closes[name][d][bar]

    def scalar_value(self, name: str, d: date) -> float:
        return self.scalars[name][d]
