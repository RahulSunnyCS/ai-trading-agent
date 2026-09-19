"""
Dhan adapter — candidate secondary/replacement provider (M-6, gated behind
the parity harness in `base.py`). Not wired up in M-1; kept as a skeleton so
the decision rule in `base.py` has a second provider to compare against once
Dhan credentials exist.

Depth is the only reason to migrate: ~5y history vs AlgoTest's 3-month
window, 1-minute bars, IV/OI/spot inline. See `base.GATES` and the decision
rule at the bottom of `base.py`.
"""

from __future__ import annotations

from datetime import date

from .base import Bar, InstrumentKey, ProviderCaps


class DhanProvider:
    """Expired-options endpoint: strike-relative (ATM, ATM±n), 1-minute,
    ~5y depth, 31 days per call, returns IV/OI/spot inline.

    Depth is the reason to evaluate it. Inline IV+spot is the reason to want
    it: it removes a second call from the feature layer's Greeks path.
    """

    def caps(self) -> ProviderCaps:
        return ProviderCaps(
            name="dhan",
            max_lookback_days=365 * 5,
            timeframes=frozenset({"1m", "5m", "15m", "30m", "1d"}),
            has_greeks=True,  # IV only, not full greeks — derive the rest
            has_expired_options=True,
            has_oi=True,
            max_days_per_call=31,
        )

    def fetch_bars(
        self,
        instrument: InstrumentKey,
        start: date,
        end: date,
        timeframe: str,
    ) -> list[Bar]:
        raise NotImplementedError("wire to Dhan REST once credentials exist")
